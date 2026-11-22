import crypto from 'crypto';
import { WeeklyReportContent } from '../../../types';
import {
  ExternalAuthError,
  ExternalNetworkError,
  ExternalParseError,
  FollowUpAlertItem,
  MemberHighlightItem,
  StructuredWeeklyAiSummary,
} from '../types';

/**
 * Computes deterministic SHA-256 contentHash for a single member's weekly report.
 */
export function computeSingleReportHash(report: WeeklyReportContent): string {
  const canonical = JSON.stringify({
    staffId: report.staffId,
    staffName: report.staffName.trim(),
    weekUptime: report.weekUptime ?? null,
    impression: (report.impression || '').trim(),
    projects: (report.projects || []).map((p) => ({
      properName: (p.properName || '').trim(),
      endUser: (p.endUser || '').trim(),
      prjDetail: (p.prjDetail || '').trim(),
    })),
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Computes deterministic SHA-256 sourceContentHash across all submitted reports for a week.
 * Used to skip redundant Gemini API calls and Firestore writes when report contents have not changed.
 */
export function computeReportsContentHash(
  reports: WeeklyReportContent[]
): string {
  const sorted = [...reports].sort((a, b) => a.staffId - b.staffId);
  const hashes = sorted.map(
    (r) => `${r.staffId}:${computeSingleReportHash(r)}`
  );
  return crypto
    .createHash('sha256')
    .update(hashes.join('|'), 'utf8')
    .digest('hex');
}

/**
 * Channel-agnostic Weekly Report AI Summarizer for WebApp Dashboard & Agent.
 * - Uses `x-goog-api-key` header (never leaks API key in URL query parameters)
 * - Outputs structured JSON (`overallSummary`, `followUpAlerts`, `memberHighlights`, `rawMarkdown`)
 * - Strictly Fail-Closed (never falls back to dummy KIRIN reports)
 */
export class WeeklyAiSummarizer {
  private apiKey: string;
  private model: string;
  private redactPii: boolean;

  constructor(options?: {
    apiKey?: string;
    model?: string;
    redactPii?: boolean;
  }) {
    this.apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.model =
      options?.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
    this.redactPii =
      options?.redactPii ??
      process.env.GEMINI_REDACT_PII_BEFORE_SUMMARY === 'true';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async generateStructuredSummary(
    weekId: string,
    weekLabel: string,
    reports: WeeklyReportContent[]
  ): Promise<StructuredWeeklyAiSummary> {
    if (!this.apiKey) {
      throw new ExternalAuthError(
        'gemini',
        'GEMINI_API_KEY is not configured.'
      );
    }

    const nowIso = new Date().toISOString();
    const sourceContentHash = computeReportsContentHash(reports);

    if (reports.length === 0) {
      return {
        weekId,
        weekLabel,
        sourceContentHash,
        model: this.model,
        overallSummary: '提出済みの週報データがありません。',
        followUpAlerts: [],
        memberHighlights: [],
        rawMarkdown: '提出済みの週報データがありません。',
        generatedAt: nowIso,
        updatedAt: nowIso,
      };
    }

    const systemInstruction =
      'あなたはエンジニアチームマネージャーの専属AI参謀です。' +
      '提出されたチームメンバーの週報内容を分析し、以下のJSONスキーマのみを純粋なJSON文字列（コードブロック不要）で出力してください：\n' +
      '{\n' +
      '  "overallSummary": "チーム全体の概況（2〜3文）",\n' +
      '  "followUpAlerts": [\n' +
      '    { "staffName": "氏名", "severity": "high|medium|low", "reason": "懸念点や課題", "recommendedAction": "推奨フォローアクション" }\n' +
      '  ],\n' +
      '  "memberHighlights": [\n' +
      '    { "staffName": "氏名", "uptime": 40, "summary": "業務内容と所感の要約（1〜2文）" }\n' +
      '  ]\n' +
      '}';

    const formattedReports = reports
      .map((r, i) => {
        const displayName = this.redactPii
          ? `Member_${r.staffId}`
          : r.staffName;
        const prjStr =
          r.projects.length > 0
            ? r.projects
                .map((p) => {
                  const endUser = this.redactPii
                    ? '[REDACTED_CLIENT]'
                    : p.endUser;
                  return `[案件: ${p.properName} / 顧客: ${endUser}]\n業務内容: ${p.prjDetail || '（記載なし）'}`;
                })
                .join('\n')
            : '（案件情報なし）';

        return (
          `--- メンバー ${i + 1}: ${displayName} ---\n` +
          `稼働時間: ${r.weekUptime ?? '未定'} 時間\n` +
          `${prjStr}\n` +
          `所感・課題:\n${r.impression || '（記載なし）'}\n`
        );
      })
      .join('\n');

    const prompt =
      `対象週: ${weekLabel} (weekId: ${weekId})\n` +
      `提出人数: ${reports.length}名\n\n` +
      `${formattedReports}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
        }),
      });
    } catch (err) {
      throw new ExternalNetworkError(
        'gemini',
        err instanceof Error ? err.message : String(err)
      );
    }

    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new ExternalAuthError(
          'gemini',
          `Gemini API HTTP ${res.status}: ${errBody}`
        );
      }
      throw new ExternalNetworkError(
        'gemini',
        `Gemini API HTTP ${res.status}: ${errBody}`
      );
    }

    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText.trim()) {
      throw new ExternalParseError(
        'gemini',
        'Gemini API returned an empty text candidate.'
      );
    }

    const cleanedJson = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    let parsedObj: {
      overallSummary?: string;
      followUpAlerts?: FollowUpAlertItem[];
      memberHighlights?: MemberHighlightItem[];
    };

    try {
      parsedObj = JSON.parse(cleanedJson);
    } catch {
      // If Gemini returned plain text/markdown instead of JSON, wrap it safely without failing
      parsedObj = {
        overallSummary: rawText.trim(),
        followUpAlerts: [],
        memberHighlights: reports.map((r) => ({
          staffName: r.staffName,
          uptime:
            typeof r.weekUptime === 'number'
              ? r.weekUptime
              : Number(r.weekUptime) || null,
          summary: (r.impression || '').slice(0, 120),
        })),
      };
    }

    const overallSummary =
      typeof parsedObj.overallSummary === 'string' &&
      parsedObj.overallSummary.trim()
        ? parsedObj.overallSummary.trim()
        : '要約が生成されました。';

    const followUpAlerts: FollowUpAlertItem[] = Array.isArray(
      parsedObj.followUpAlerts
    )
      ? parsedObj.followUpAlerts.map((a) => ({
          staffName: String(a.staffName || ''),
          severity:
            a.severity === 'high' ||
            a.severity === 'medium' ||
            a.severity === 'low'
              ? a.severity
              : 'medium',
          reason: String(a.reason || ''),
          recommendedAction: String(a.recommendedAction || ''),
        }))
      : [];

    const memberHighlights: MemberHighlightItem[] = Array.isArray(
      parsedObj.memberHighlights
    )
      ? parsedObj.memberHighlights.map((m) => ({
          staffName: String(m.staffName || ''),
          uptime: typeof m.uptime === 'number' ? m.uptime : null,
          summary: String(m.summary || ''),
        }))
      : [];

    const rawMarkdown = [
      `### 1. 全体概況\n${overallSummary}`,
      followUpAlerts.length > 0
        ? `### 2. 要フォロー・アラート\n` +
          followUpAlerts
            .map(
              (a) =>
                `- **${a.staffName}** [${a.severity.toUpperCase()}]: ${a.reason} (推奨: ${a.recommendedAction})`
            )
            .join('\n')
        : '### 2. 要フォロー・アラート\n特になし',
      memberHighlights.length > 0
        ? `### 3. メンバー別ハイライト\n` +
          memberHighlights
            .map(
              (m) =>
                `- **${m.staffName}** (稼働: ${m.uptime ?? '-'}h): ${m.summary}`
            )
            .join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      weekId,
      weekLabel,
      sourceContentHash,
      model: this.model,
      overallSummary,
      followUpAlerts,
      memberHighlights,
      rawMarkdown,
      generatedAt: nowIso,
      updatedAt: nowIso,
    };
  }
}
