import { GSessionScheduleDay, TeamMemberConfig } from '../../../types';
import { parseGSessionSchmainHtml } from '../../../weekly/service';
import {
  getTeamMembers,
  matchConfiguredMember,
  normalizeName,
} from '../members';
import {
  ExternalAuthError,
  ExternalParseError,
  ParsedGSessionLoginsResult,
  StrictGSessionMemberLoginRecord,
} from '../types';

/**
 * Validates that GroupSession HTML is not a login form or auth error screen.
 */
export function assertValidGSessionHtml(
  html: string,
  context: 'login' | 'man050' | 'schmain'
): void {
  if (!html || html.trim().length === 0) {
    throw new ExternalParseError(
      'gsession',
      `GroupSession ${context} HTML is empty.`
    );
  }

  if (
    html.includes('cmn001Userid') ||
    html.includes('cmn001Passwd') ||
    html.includes('ユーザーIDまたはパスワードが違います')
  ) {
    throw new ExternalAuthError(
      'gsession',
      `GroupSession returned login form during ${context} request.`
    );
  }
}

/**
 * Converts GroupSession JST timestamp string ("YYYY/MM/DD HH:mm:ss") into an explicit JST ISO-8601 string
 * and UTC epoch milliseconds so Cloud Run (UTC) never suffers a 9-hour timezone drift.
 */
export function parseGSessionJstTimestamp(loginDateStr: string): {
  isoJst: string;
  epochMs: number;
} | null {
  const trimmed = loginDateStr.trim();
  const match = trimmed.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/
  );
  if (!match) return null;

  const [, y, m, d, hh, mm, ss] = match;
  const isoJst = `${y}-${m}-${d}T${hh}:${mm}:${ss}+09:00`;
  const epochMs = Date.parse(isoJst);
  if (Number.isNaN(epochMs)) return null;

  return { isoJst, epochMs };
}

/**
 * Strictly parses GroupSession man050.do HTML:
 * - Throws ExternalAuthError if redirected to login screen
 * - Throws ExternalParseError if table structure is missing
 * - Evaluates login times in explicit JST (+09:00)
 * - Marks configured members absent from the table as 'NOT_FOUND_IN_GS' (never falsely 'ACTIVE')
 */
export function parseStrictGSessionMan050Html(
  html: string,
  options?: {
    now?: Date;
    thresholdDays?: number;
    groupSid?: string;
    configuredMembers?: TeamMemberConfig[];
  }
): ParsedGSessionLoginsResult {
  assertValidGSessionHtml(html, 'man050');

  const now = options?.now ?? new Date();
  const thresholdDays = options?.thresholdDays ?? 7;
  const groupSid = options?.groupSid || process.env.GSESSION_GROUP_SID || '157';

  const rowRegex =
    /<tr[^>]*>[\s\S]*?<td[^>]*>\s*(\d{4,8})\s*<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s*<\/td>[\s\S]*?<\/tr>/gi;

  interface ExtractedGsRow {
    staffNum: string;
    rawName: string;
    rawLastLoginDate: string;
    isoJst: string;
    daysSince: number;
  }

  const extractedRows: ExtractedGsRow[] = [];
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(html)) !== null) {
    const staffNum = match[1].trim();
    const rawName = match[2].replace(/<[^>]+>/g, '').trim();
    const rawLastLoginDate = match[4].trim();

    const parsedTime = parseGSessionJstTimestamp(rawLastLoginDate);
    if (!parsedTime) continue;

    const diffMs = now.getTime() - parsedTime.epochMs;
    const daysSince = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

    extractedRows.push({
      staffNum,
      rawName,
      rawLastLoginDate,
      isoJst: parsedTime.isoJst,
      daysSince,
    });
  }

  if (extractedRows.length === 0) {
    throw new ExternalParseError(
      'gsession',
      'No valid login history rows found in GroupSession man050.do HTML.'
    );
  }

  const configured = options?.configuredMembers ?? getTeamMembers();
  const targetMembers: TeamMemberConfig[] =
    configured.length > 0
      ? configured
      : extractedRows.map((r) => ({
          name: r.rawName,
          staffNum: r.staffNum,
          role: 'member' as const,
        }));

  const inactiveMembers: StrictGSessionMemberLoginRecord[] = [];
  const activeMembers: StrictGSessionMemberLoginRecord[] = [];
  const notFoundMembers: StrictGSessionMemberLoginRecord[] = [];
  const allMembers: StrictGSessionMemberLoginRecord[] = [];

  for (const member of targetMembers) {
    const matchedRow = extractedRows.find((r) =>
      Boolean(
        matchConfiguredMember({ staffNum: r.staffNum, name: r.rawName }, [
          member,
        ])
      )
    );

    if (!matchedRow) {
      const notFoundRecord: StrictGSessionMemberLoginRecord = {
        staffNum: member.staffNum || null,
        name: member.name,
        normalizedName: normalizeName(member.name),
        lastLoginAt: null,
        rawLastLoginDate: null,
        daysSinceLastLogin: null,
        status: 'NOT_FOUND_IN_GS',
      };
      notFoundMembers.push(notFoundRecord);
      allMembers.push(notFoundRecord);
      continue;
    }

    const isInactive = matchedRow.daysSince >= thresholdDays;
    const record: StrictGSessionMemberLoginRecord = {
      staffNum: matchedRow.staffNum || member.staffNum || null,
      name: member.name,
      normalizedName: normalizeName(member.name),
      lastLoginAt: matchedRow.isoJst,
      rawLastLoginDate: matchedRow.rawLastLoginDate,
      daysSinceLastLogin: matchedRow.daysSince,
      status: isInactive ? 'INACTIVE' : 'ACTIVE',
    };

    if (isInactive) {
      inactiveMembers.push(record);
    } else {
      activeMembers.push(record);
    }
    allMembers.push(record);
  }

  return {
    groupSid,
    inactiveThresholdDays: thresholdDays,
    evaluatedAt: now.toISOString(),
    inactiveMembers,
    activeMembers,
    notFoundMembers,
    allMembers,
  };
}

/**
 * Strictly parses GroupSession schmain.do 1-week schedule HTML.
 * Distinguishes login redirects / malformed HTML from a valid schedule with 0 events.
 */
export function parseStrictGSessionScheduleHtml(
  html: string
): GSessionScheduleDay[] {
  assertValidGSessionHtml(html, 'schmain');

  const days = parseGSessionSchmainHtml(html);
  if (days.length === 0) {
    throw new ExternalParseError(
      'gsession',
      'GroupSession schmain.do HTML did not contain a 7-day schedule header row.'
    );
  }

  return days;
}
