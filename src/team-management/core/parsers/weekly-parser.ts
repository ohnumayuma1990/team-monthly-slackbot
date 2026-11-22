import { TeamMemberConfig } from '../../../types';
import { extractNewestWrTargetDateId } from '../../../weekly/service';
import {
  getTeamMembers,
  matchConfiguredMember,
  normalizeName,
} from '../members';
import {
  ExternalAuthError,
  ExternalParseError,
  ParsedWeeklyTopResult,
  WeeklyMemberStatusRecord,
} from '../types';

export interface RawFilingRecord {
  staffId?: number;
  staffName?: string;
  staffNum?: string;
  filingDatetime?: string | null;
  newestWrTargetDateId?: number;
  latestWrTargetDateId?: number;
}

/**
 * Safely converts a JavaScript array/object literal string (such as `var filingData = [...]`)
 * into strict JSON and parses it via JSON.parse WITHOUT using `new Function` or `eval`.
 */
export function safeParseFilingDataArray(
  rawLiteral: string
): RawFilingRecord[] {
  const trimmed = rawLiteral.trim().replace(/;\s*$/, '');
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new ExternalParseError(
      'weekly_report',
      'filingData literal is not a valid array structure.'
    );
  }

  // First try direct JSON.parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return validateFilingRecords(parsed);
    }
  } catch {
    // Fall through to safe token normalization for unquoted keys / single-quoted strings
  }

  // Reject executable constructs before normalization
  if (
    /\b(?:function|eval|Function|constructor|__proto__|prototype|window|global|process|require)\b/.test(
      trimmed
    )
  ) {
    throw new ExternalParseError(
      'weekly_report',
      'Unsafe token detected in filingData payload.'
    );
  }

  // Tokenize string literals vs structural characters to safely normalize to strict JSON
  let out = '';
  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    const ch = trimmed[i];

    // Handle single-quoted or double-quoted string literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let strContent = '';
      i++;
      let closed = false;
      while (i < len) {
        const c = trimmed[i];
        if (c === '\\' && i + 1 < len) {
          const next = trimmed[i + 1];
          if (next === "'") {
            strContent += "'";
          } else if (next === '"') {
            strContent += '\\"';
          } else {
            strContent += '\\' + next;
          }
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        if (c === '"') {
          strContent += '\\"';
        } else if (c === '\n') {
          strContent += '\\n';
        } else if (c === '\r') {
          strContent += '\\r';
        } else if (c === '\t') {
          strContent += '\\t';
        } else {
          strContent += c;
        }
        i++;
      }
      if (!closed) {
        throw new ExternalParseError(
          'weekly_report',
          'Unterminated string literal in filingData.'
        );
      }
      out += `"${strContent}"`;
      continue;
    }

    // Reject parentheses (no function calls allowed)
    if (ch === '(' || ch === ')') {
      throw new ExternalParseError(
        'weekly_report',
        'Unexpected parentheses in filingData literal.'
      );
    }

    out += ch;
    i++;
  }

  // Quote unquoted object keys: `{ staffId:` or `, staffName:` -> `{"staffId":`
  const jsonNormalized = out
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');

  try {
    const parsed = JSON.parse(jsonNormalized);
    if (!Array.isArray(parsed)) {
      throw new ExternalParseError(
        'weekly_report',
        'Parsed filingData is not an array.'
      );
    }
    return validateFilingRecords(parsed);
  } catch (err) {
    if (err instanceof ExternalParseError) throw err;
    throw new ExternalParseError(
      'weekly_report',
      `Failed to parse filingData JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function validateFilingRecords(items: unknown[]): RawFilingRecord[] {
  const results: RawFilingRecord[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    results.push({
      staffId:
        typeof rec.staffId === 'number'
          ? rec.staffId
          : typeof rec.staffId === 'string' && /^\d+$/.test(rec.staffId)
            ? Number(rec.staffId)
            : undefined,
      staffName:
        typeof rec.staffName === 'string' ? rec.staffName.trim() : undefined,
      staffNum:
        typeof rec.staffNum === 'string' ? rec.staffNum.trim() : undefined,
      filingDatetime:
        typeof rec.filingDatetime === 'string' ? rec.filingDatetime : null,
      newestWrTargetDateId:
        typeof rec.newestWrTargetDateId === 'number'
          ? rec.newestWrTargetDateId
          : undefined,
      latestWrTargetDateId:
        typeof rec.latestWrTargetDateId === 'number'
          ? rec.latestWrTargetDateId
          : undefined,
    });
  }
  return results;
}

/**
 * Checks whether the HTML returned from Weekly Report portal is actually a login or auth error page.
 */
export function assertValidWeeklyTopHtml(
  html: string,
  finalUrl?: string
): void {
  if (!html || html.trim().length === 0) {
    throw new ExternalParseError(
      'weekly_report',
      'Weekly report top page HTML is empty.'
    );
  }

  if (
    (finalUrl && finalUrl.includes('/login')) ||
    html.includes('ユーザー名またはパスワードが違います') ||
    html.includes('id="loginForm"') ||
    html.includes('name="password"')
  ) {
    throw new ExternalAuthError(
      'weekly_report',
      'Weekly report portal returned the login page or invalid credentials error.'
    );
  }
}

/**
 * Extracts and parses `var filingData = [...];` from Weekly Report top page HTML.
 * Throws ExternalAuthError or ExternalParseError on failure (never falls back to dummy or substring search).
 */
export function extractFilingDataFromHtml(
  html: string,
  finalUrl?: string
): RawFilingRecord[] {
  assertValidWeeklyTopHtml(html, finalUrl);

  const marker = 'var filingData = ';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) {
    throw new ExternalParseError(
      'weekly_report',
      'Could not locate "var filingData = " in Weekly Report top page HTML.'
    );
  }

  const contentStart = startIdx + marker.length;
  const endSemiNewline = html.indexOf(';\n', contentStart);
  const endSemiCrLf = html.indexOf(';\r\n', contentStart);
  const endScript = html.indexOf('</script>', contentStart);

  const candidates = [endSemiNewline, endSemiCrLf, endScript].filter(
    (idx) => idx !== -1
  );
  const endIdx = candidates.length > 0 ? Math.min(...candidates) : html.length;

  const rawJsonLiteral = html.substring(contentStart, endIdx).trim();
  return safeParseFilingDataArray(rawJsonLiteral);
}

/**
 * Parses Weekly Report top page HTML strictly (Fail-Closed).
 * Never falls back to dummy "all unsubmitted" or naive HTML string matching.
 */
export function parseStrictWeeklyTopHtml(
  html: string,
  options?: {
    finalUrl?: string;
    configuredMembers?: TeamMemberConfig[];
    overrideWrTargetDateId?: number;
  }
): ParsedWeeklyTopResult {
  const filingData = extractFilingDataFromHtml(html, options?.finalUrl);

  let weekLabel = '最新週';
  const deadlineMatch = html.match(
    /([\d/]+\s*[\d:]+)\s*<\/label>\s*<label[^>]*>締切りの週報<\/label>[\s\S]*?対象期間[：:]\s*<\/label>\s*<label>\s*([\d/]+)\s*<\/label>\s*<label>\s*[～~]\s*<\/label>\s*<label>\s*([\d/]+)/i
  );
  if (deadlineMatch) {
    weekLabel = `${deadlineMatch[1].trim()} 締切 (${deadlineMatch[2].trim()}〜${deadlineMatch[3].trim()})`;
  }

  const detectedNewestId =
    options?.overrideWrTargetDateId ||
    extractNewestWrTargetDateId(html) ||
    filingData.find((f) => f.newestWrTargetDateId || f.latestWrTargetDateId)
      ?.newestWrTargetDateId ||
    filingData.find((f) => f.latestWrTargetDateId)?.latestWrTargetDateId;

  if (!detectedNewestId) {
    throw new ExternalParseError(
      'weekly_report',
      'Could not determine wrTargetDateId from Weekly Report top page HTML.'
    );
  }

  const configured = options?.configuredMembers ?? getTeamMembers();
  const targetMembers: TeamMemberConfig[] =
    configured.length > 0
      ? configured
      : filingData
          .filter((f) => Boolean(f.staffName))
          .map((f) => ({
            name: String(f.staffName),
            staffNum: f.staffNum,
            role: 'member' as const,
          }));

  const members: WeeklyMemberStatusRecord[] = [];
  let submittedCount = 0;
  let unsubmittedCount = 0;

  for (const member of targetMembers) {
    const matchedRecord = filingData.find((f) => {
      const m = matchConfiguredMember(
        { staffNum: f.staffNum, name: f.staffName },
        [member]
      );
      return Boolean(m);
    });

    if (!matchedRecord) {
      unsubmittedCount++;
      members.push({
        staffId: null,
        staffNum: member.staffNum || null,
        staffName: member.name,
        normalizedName: normalizeName(member.name),
        status: 'UNKNOWN',
        filingDatetime: null,
        wrTargetDateId: detectedNewestId,
        hasDetailFetched: false,
      });
      continue;
    }

    const filingDt =
      matchedRecord.filingDatetime &&
      String(matchedRecord.filingDatetime).trim() !== ''
        ? String(matchedRecord.filingDatetime).trim()
        : null;

    const recordDateId =
      options?.overrideWrTargetDateId ||
      matchedRecord.newestWrTargetDateId ||
      matchedRecord.latestWrTargetDateId ||
      detectedNewestId;

    if (filingDt) {
      submittedCount++;
      members.push({
        staffId: matchedRecord.staffId ?? null,
        staffNum: matchedRecord.staffNum || member.staffNum || null,
        staffName: member.name,
        normalizedName: normalizeName(member.name),
        status: 'SUBMITTED',
        filingDatetime: filingDt,
        wrTargetDateId: recordDateId,
        hasDetailFetched: false,
      });
    } else {
      unsubmittedCount++;
      members.push({
        staffId: matchedRecord.staffId ?? null,
        staffNum: matchedRecord.staffNum || member.staffNum || null,
        staffName: member.name,
        normalizedName: normalizeName(member.name),
        status: 'UNSUBMITTED',
        filingDatetime: null,
        wrTargetDateId: recordDateId,
        hasDetailFetched: false,
      });
    }
  }

  return {
    weekId: String(detectedNewestId),
    wrTargetDateId: detectedNewestId,
    weekLabel,
    submittedCount,
    unsubmittedCount,
    totalMembers: targetMembers.length,
    members,
  };
}
