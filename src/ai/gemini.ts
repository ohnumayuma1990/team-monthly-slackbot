import { WeeklyReportContent } from '../types';

/**
 * Converts standard Markdown syntax to Slack-compatible mrkdwn.
 * - Converts #, ##, ### headers to *bold header*
 * - Converts **bold** to *bold*
 * - Converts --- or *** horizontal rules to decorative separator line
 * - Converts * item or - item bullets to ・item
 * - Converts [text](url) to <url|text>
 */
export function formatMarkdownForSlack(text: string): string {
  if (!text) return '';

  return (
    text
      // 1. Convert markdown headers (# Header, ## Header, ### Header) to *Header*
      .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
      // 2. Convert horizontal rules (---, ___, ***) to clean Slack separator line
      .replace(/^(?:---|___|\*\*\*)\s*$/gm, '━━━━━━━━━━━━━━━━━━━━━━')
      // 3. Convert **bold** to *bold* (Slack bold)
      .replace(/\*\*(.*?)\*\*/g, '*$1*')
      // 4. Convert markdown links [text](url) to Slack links <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
      // 5. Convert list bullets (* item or - item) to clean bullet (・item)
      .replace(/^(\s*)[*-]\s+/gm, '$1・')
      // 6. Ensure space between bullet ・ and bold * for Slack mrkdwn parser: ・* -> ・ *
      .replace(/・\*/g, '・ *')
      // 7. Fix Slack mrkdwn bold boundary issues with Japanese text:
      //    Slack requires closing * to be followed by whitespace or ASCII punctuation.
      //    Convert *bold*： to *bold*: (half-width colon + space for valid delimiter)
      .replace(/\*([^\s*](?:[\s\S]*?[^\s*])?)\*：/g, '*$1*: ')
      //    If closing * is followed by non-ASCII character (except whitespace), insert space
      .replace(/\*([^\s*](?:[\s\S]*?[^\s*])?)\*([^\s\x20-\x7e])/g, '*$1* $2')
      //    If opening * is preceded by non-ASCII character (except whitespace), insert space
      .replace(/([^\s\x20-\x7e])\*([^\s*](?:[\s\S]*?[^\s*])?)\*/g, '$1 *$2*')
      // 8. Clean up 3 or more consecutive newlines into 2
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Gemini API client for Google AI Studio (Free Tier)
 * Uses native fetch (Node.js 18+) for maximum stability and zero additional dependencies.
 */
export class GeminiService {
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || '';
    // Default to gemini-flash-latest which points to the latest stable flash model
    this.model = model || process.env.GEMINI_MODEL || 'gemini-flash-latest';
  }

  /**
   * Checks whether Gemini API is configured.
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Generates content from text prompt with automatic fallback model support.
   */
  async generateText(
    prompt: string,
    systemInstruction?: string
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in environment.');
    }

    const candidateModels = [this.model];
    if (!candidateModels.includes('gemini-3.5-flash')) {
      candidateModels.push('gemini-3.5-flash');
    }
    if (!candidateModels.includes('gemini-flash-latest')) {
      candidateModels.push('gemini-flash-latest');
    }

    let lastError: Error | null = null;

    for (const targetModel of candidateModels) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${this.apiKey}`;

      const requestBody: Record<string, unknown> = {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      };

      if (systemInstruction) {
        requestBody.systemInstruction = {
          parts: [{ text: systemInstruction }],
        };
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Gemini API error for ${targetModel} (${response.status}): ${errorText}`
          );
        }

        const data = (await response.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const candidate = data.candidates?.[0];
        const textPart = candidate?.content?.parts?.[0]?.text;

        return textPart || '';
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        console.warn(
          `Gemini generation attempt with ${targetModel} failed:`,
          errObj.message
        );
        lastError = errObj;
      }
    }

    throw lastError || new Error('All Gemini model candidates failed.');
  }

  /**
   * Optional helper: Generates quick feedback or hints for a member's reported concern.
   */
  async generateConcernHint(
    memberName: string,
    statusText: string
  ): Promise<string> {
    if (!this.isConfigured() || !statusText) return '';

    const systemInstruction =
      'あなたはエンジニアチームの温かいメンターです。メンバーの困りごとや近況に対し、50〜100文字程度で前向きな共感と実践的なアドバイスを1つ返答してください。絵文字を自然に使ってください。';
    const prompt = `メンバー名: ${memberName}\n近況・困りごと: ${statusText}`;

    try {
      const raw = await this.generateText(prompt, systemInstruction);
      return formatMarkdownForSlack(raw);
    } catch (e) {
      console.warn('Gemini hint generation failed:', e);
      return '';
    }
  }

  /**
   * Optional helper: Generates draft of overall meeting review from all members' inputs.
   */
  async generateSummaryDraft(inputsSummary: string): Promise<string> {
    if (!this.isConfigured()) return '';

    const systemInstruction =
      'あなたはチームリーダーのサポートAIです。チームメンバー全員の月次近況やGW振り返りをまとめ、月次定例の総評ドラフト（トピック、好事例、課題、来月の注力ポイント）を箇条書きで分かりやすく整理してください。' +
      'Slackで表示するため、見出し記号（#、##、###）は使わず「*トピック名*」のように太字にし、箇条書き記号は「・」を使用してください。';

    try {
      const raw = await this.generateText(inputsSummary, systemInstruction);
      return formatMarkdownForSlack(raw);
    } catch (e) {
      console.warn('Gemini summary generation failed:', e);
      return '';
    }
  }

  /**
   * Generates structured weekly report summary for manager Onuma.
   */
  async generateWeeklyReportsSummary(
    reports: WeeklyReportContent[],
    weekLabel: string
  ): Promise<string> {
    if (reports.length === 0) {
      return (
        `📊 *【週報AI要約】チーム状況サマリー* (${weekLabel})\n\n` +
        `提出済みの週報データがありませんでした。`
      );
    }

    if (!this.isConfigured()) {
      // Fallback if GEMINI_API_KEY is not configured
      const memberList = reports
        .map((r) => `・${r.staffName}（所感あり）`)
        .join('\n');
      return (
        `📊 *【週報要約（簡易版）】チーム状況サマリー* (${weekLabel})\n\n` +
        `_※GEMINI_API_KEYが未設定のため、AI要約をスキップし提出者一覧を表示しています。_\n\n` +
        `提出者 (${reports.length}名):\n${memberList}`
      );
    }

    const systemInstruction =
      'あなたはエンジニアチームマネージャーの専属AI参謀です。' +
      '提出されたチームメンバーの週報内容を分析し、マネージャーが1分で状況を正確に把握し、必要なアクション（フォロー、声掛け、課題解決）に繋げられる高品質な要約レポートを作成してください。\n\n' +
      '【重要：Slack書式ルール（厳守）】\n' +
      '・見出し記号（#、##、###）は絶対に使用しないでください（Slackで記号のまま表示されてしまいます）。見出しは「*1. 💡 全体概況・トピック*」のように「*」1つで囲んで太字にしてください。\n' +
      '・太字は「**」ではなく「*」（アスタリスク1つ）を使用してください。\n' +
      '・太字の直後に全角コロン（：）を使うとSlackで太字が無効化されるため、見出しの後ろは「*項目名*: 詳細」のように半角コロンと半角スペースを使ってください。\n' +
      '・区切り線に「---」は使わず、空行で段落を分けてください。\n' +
      '・箇条書きには「*」や「-」ではなく「・」を使用してください。\n\n' +
      '【レポート構成】\n' +
      '1. *💡 全体概況・トピック*（2〜3行）\n' +
      '2. *⚠️ 要フォロー・課題・アラート*（マネージャー確認推奨。メンタル、残業、人間関係、スケジュール遅延など）\n' +
      '3. *👤 メンバー別ハイライト*（メンバー名は「・ *氏名*」のように太字にし、1人2〜3行で業務要約と所感）';

    const formattedReports = reports
      .map((r, i) => {
        const prjStr =
          r.projects.length > 0
            ? r.projects
                .map(
                  (p) =>
                    `[案件: ${p.properName} / 顧客: ${p.endUser}]\n業務内容: ${p.prjDetail || '（記載なし）'}`
                )
                .join('\n')
            : '（案件情報なし）';

        return (
          `--------------------------------------------------\n` +
          `【メンバー ${i + 1}】 ${r.staffName}\n` +
          `稼働時間: ${r.weekUptime ?? '未定'} 時間\n` +
          `${prjStr}\n` +
          `所感・課題:\n${r.impression || '（所感記載なし）'}\n`
        );
      })
      .join('\n');

    const prompt =
      `対象週: ${weekLabel}\n` +
      `提出人数: ${reports.length}名\n\n` +
      `以下が提出された各メンバーの週報内容です：\n\n` +
      `${formattedReports}\n\n` +
      `上記をもとに、マネージャー向けの週報サマリーを作成してください。`;

    try {
      const rawSummary = await this.generateText(prompt, systemInstruction);
      const summary = formatMarkdownForSlack(rawSummary);
      return (
        `🔒 *【マネージャー専用・非公開】週報AI要約レポート*\n` +
        `対象: ${weekLabel} (提出完了: ${reports.length}名)\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `${summary.trim()}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `_※このメッセージはマネージャーのDMにのみ送信されています（他メンバー非公開）_`
      );
    } catch (e) {
      console.error('Failed to generate weekly reports summary via Gemini:', e);
      const memberList = reports.map((r) => `・${r.staffName}`).join('\n');
      return (
        `⚠️ *週報AI要約の生成中にエラーが発生しました*\n` +
        `対象: ${weekLabel} (提出完了: ${reports.length}名)\n\n` +
        `提出者一覧:\n${memberList}\n\n` +
        `_※Gemini APIの呼び出しに失敗しました。時間をおいて再試行してください。_`
      );
    }
  }
}
