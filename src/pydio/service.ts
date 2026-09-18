import {
  AttendanceCheckResult,
  AttendanceSubmissionStatus,
  PydioAttendanceFile,
  TeamMemberConfig,
} from '../types';
import { getTeamMembers } from '../config/members';

export const DEFAULT_PYDIO_BASE_URL = 'https://auth.poweredge.co.jp/pydio6';
export const DEFAULT_PYDIO_REPO_ID = 'fe9d638155115c4c19a1c94723bbab19'; // 共通フォルダ (ws-n-a)

/**
 * Calculates Japanese fiscal year (4月〜翌年3月).
 * e.g., 2026-04 -> 2026, 2026-12 -> 2026, 2027-01 -> 2026, 2027-03 -> 2026
 */
export function getFiscalYear(year: number, month: number): number {
  return month >= 4 ? year : year - 1;
}

/**
 * Gets all business days (Monday-Friday, excluding basic holidays) for a specific year and month.
 */
export function getBusinessDaysOfMonth(year: number, month: number): number[] {
  const businessDays: number[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();

  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    const dayOfWeek = dt.getDay(); // 0 = Sunday, 6 = Saturday
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // Basic check: skip Jan 1-3 (Japanese New Year)
      if (month === 1 && d <= 3) {
        continue;
      }
      businessDays.push(d);
    }
  }
  return businessDays;
}

export interface TargetFolderInfo {
  targetMonth: string; // '202608'
  fiscalYear: string; // '2026年度'
  folderPath: string; // '/20.attendance/2026年度/202608'
  isFirstTwoBusinessDays: boolean;
  isMonthEndBusinessDays: boolean;
}

/**
 * Determines the target attendance folder based on current date or explicit override.
 * - 月初2営業日: 前月フォルダ
 * - 月末最終2営業日: 当月フォルダ
 */
export function determineAttendanceTarget(
  date: Date = new Date(),
  overrideYearMonth?: string
): TargetFolderInfo {
  if (overrideYearMonth) {
    const cleaned = overrideYearMonth.replace(/[^0-9]/g, '');
    if (cleaned.length === 6) {
      const y = parseInt(cleaned.slice(0, 4), 10);
      const m = parseInt(cleaned.slice(4, 6), 10);
      const fy = getFiscalYear(y, m);
      return {
        targetMonth: cleaned,
        fiscalYear: `${fy}年度`,
        folderPath: `/20.attendance/${fy}年度/${cleaned}`,
        isFirstTwoBusinessDays: false,
        isMonthEndBusinessDays: false,
      };
    }
  }

  const currentYear = date.getFullYear();
  const currentMonth = date.getMonth() + 1; // 1-12
  const currentDay = date.getDate();

  const bDays = getBusinessDaysOfMonth(currentYear, currentMonth);
  const first2BDays = bDays.slice(0, 2);
  const last2BDays = bDays.slice(-2);

  const isFirstTwoBusinessDays = first2BDays.includes(currentDay);
  const isMonthEndBusinessDays = last2BDays.includes(currentDay);

  let targetYear = currentYear;
  let targetMonthNum = currentMonth;

  if (isFirstTwoBusinessDays) {
    // 月初2営業日: 前月フォルダを対象にする
    targetMonthNum = currentMonth - 1;
    if (targetMonthNum < 1) {
      targetMonthNum = 12;
      targetYear -= 1;
    }
  } else if (isMonthEndBusinessDays || currentDay > 20) {
    // 月末または20日以降: 当月フォルダ
    targetYear = currentYear;
    targetMonthNum = currentMonth;
  } else {
    // 月中（20日以前かつ月初2営業日以外）: 通常は前月の確定状況を確認
    targetMonthNum = currentMonth - 1;
    if (targetMonthNum < 1) {
      targetMonthNum = 12;
      targetYear -= 1;
    }
  }

  const ymStr = `${targetYear}${String(targetMonthNum).padStart(2, '0')}`;
  const fy = getFiscalYear(targetYear, targetMonthNum);

  return {
    targetMonth: ymStr,
    fiscalYear: `${fy}年度`,
    folderPath: `/20.attendance/${fy}年度/${ymStr}`,
    isFirstTwoBusinessDays,
    isMonthEndBusinessDays,
  };
}

export class PydioAttendanceService {
  private baseUrl: string;
  private repoId: string;
  private username: string;
  private password: string;

  constructor(options?: {
    baseUrl?: string;
    repoId?: string;
    username?: string;
    password?: string;
  }) {
    this.baseUrl = options?.baseUrl || process.env.PYDIO_BASE_URL || DEFAULT_PYDIO_BASE_URL;
    this.repoId = options?.repoId || process.env.PYDIO_REPO_ID || DEFAULT_PYDIO_REPO_ID;
    this.username = options?.username || process.env.WEEKLY_REPORT_USERNAME || '';
    this.password = options?.password || process.env.WEEKLY_REPORT_PASSWORD || '';
  }

  /**
   * Logs into Pydio 6 and retrieves session cookie and secure token.
   */
  async login(): Promise<{ sessionCookie: string; secureToken: string }> {
    if (!this.password) {
      throw new Error('WEEKLY_REPORT_PASSWORD is not set for Pydio login');
    }

    // Step 1: Get seed
    const seedRes = await fetch(`${this.baseUrl}/index.php?get_action=get_seed`);
    const rawSetCookie = seedRes.headers.get('set-cookie') || '';
    const cookiePart = rawSetCookie.split(';')[0];

    // Step 2: Login POST
    const loginBody = new URLSearchParams({
      get_action: 'login',
      userid: this.username,
      password: this.password,
      login_seed: '-1',
    });

    const loginRes = await fetch(`${this.baseUrl}/index.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookiePart,
        'User-Agent': 'Mozilla/5.0 (compatible; TeamMonthlySlackBot/1.0)',
      },
      body: loginBody.toString(),
    });

    const loginXml = await loginRes.text();
    const tokenMatch = loginXml.match(/secure_token="([^"]+)"/);
    if (!tokenMatch || !tokenMatch[1]) {
      throw new Error(`Pydio login failed. Response: ${loginXml.slice(0, 300)}`);
    }

    const secureToken = tokenMatch[1];
    const newSetCookie = loginRes.headers.get('set-cookie');
    const sessionCookie = newSetCookie ? newSetCookie.split(';')[0] : cookiePart;

    return { sessionCookie, secureToken };
  }

  /**
   * Switches repository to 共通フォルダ.
   */
  async switchRepository(sessionCookie: string, secureToken: string): Promise<void> {
    const switchUrl = `${this.baseUrl}/index.php?get_action=switch_repository&repository_id=${this.repoId}&secure_token=${secureToken}`;
    const res = await fetch(switchUrl, {
      headers: {
        Cookie: sessionCookie,
        'User-Agent': 'Mozilla/5.0 (compatible; TeamMonthlySlackBot/1.0)',
      },
    });
    if (!res.ok) {
      console.warn(`Pydio repository switch returned status ${res.status}`);
    }
  }

  /**
   * Lists directory contents via Pydio 'ls' action.
   */
  async listDirectory(
    dirPath: string,
    sessionCookie: string,
    secureToken: string
  ): Promise<PydioAttendanceFile[]> {
    const lsUrl = `${this.baseUrl}/index.php?get_action=ls&options=al&dir=${encodeURIComponent(
      dirPath
    )}&secure_token=${secureToken}`;

    const res = await fetch(lsUrl, {
      headers: {
        Cookie: sessionCookie,
        'User-Agent': 'Mozilla/5.0 (compatible; TeamMonthlySlackBot/1.0)',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to list Pydio directory ${dirPath}: HTTP ${res.status}`);
    }

    const xml = await res.text();
    return this.parsePydioXml(xml);
  }

  /**
   * Parses Pydio XML directory response to extract file entries.
   */
  parsePydioXml(xml: string): PydioAttendanceFile[] {
    const files: PydioAttendanceFile[] = [];
    const treeRegex = /<tree\b([^>]+)\/>/gi;
    let match: RegExpExecArray | null;

    while ((match = treeRegex.exec(xml)) !== null) {
      const attrs = match[1];
      const textMatch = attrs.match(/text="([^"]+)"/);
      if (!textMatch) continue;

      const filename = textMatch[1];
      const bytesizeMatch = attrs.match(/bytesize="([^"]+)"/);
      const modifTimeMatch = attrs.match(/ajxp_modiftime="([^"]+)"/);

      files.push({
        filename,
        bytesize: bytesizeMatch ? bytesizeMatch[1] : undefined,
        modifTime: modifTimeMatch ? modifTimeMatch[1] : undefined,
      });
    }

    return files;
  }

  /**
   * Checks attendance submission for team members against target folder.
   */
  async checkAttendance(overrideYearMonth?: string): Promise<AttendanceCheckResult> {
    const target = determineAttendanceTarget(new Date(), overrideYearMonth);
    const { sessionCookie, secureToken } = await this.login();
    await this.switchRepository(sessionCookie, secureToken);

    let files: PydioAttendanceFile[] = [];
    try {
      files = await this.listDirectory(target.folderPath, sessionCookie, secureToken);
    } catch (e) {
      console.warn(`Could not list directory ${target.folderPath}:`, e);
    }

    const members = getTeamMembers();
    const submitted: AttendanceSubmissionStatus[] = [];
    const unsubmitted: AttendanceSubmissionStatus[] = [];

    for (const member of members) {
      const cleanMemberName = member.name.replace(/[\s\u3000]+/g, '');
      const matchedFile = files.find((f) => {
        const cleanFileName = f.filename.replace(/[\s\u3000]+/g, '');
        // Match either by 6-digit staff number or normalized member name
        const matchStaff =
          member.staffNum && member.staffNum.length > 0 && f.filename.includes(member.staffNum);
        const matchName = cleanMemberName.length > 0 && cleanFileName.includes(cleanMemberName);
        return matchStaff || matchName;
      });

      if (matchedFile) {
        submitted.push({
          member,
          submitted: true,
          filename: matchedFile.filename,
          bytesize: matchedFile.bytesize,
          modifTime: matchedFile.modifTime,
        });
      } else {
        unsubmitted.push({
          member,
          submitted: false,
        });
      }
    }

    return {
      targetFolder: target.folderPath,
      targetMonth: target.targetMonth,
      fiscalYear: target.fiscalYear,
      isFirstTwoBusinessDays: target.isFirstTwoBusinessDays,
      isMonthEndBusinessDays: target.isMonthEndBusinessDays,
      submitted,
      unsubmitted,
      totalMembers: members.length,
    };
  }

  /**
   * Formats Slack notification message.
   * Mentions unsubmitted members when broadcast to channel.
   */
  formatSlackMessage(result: AttendanceCheckResult, isBroadcast: boolean = true): string {
    const yearStr = result.targetMonth.slice(0, 4);
    const monthStr = result.targetMonth.slice(4, 6);

    let msg = `📊 *【${yearStr}年${monthStr}月度 勤怠出勤簿 提出状況】*\n`;
    msg += `📁 対象フォルダ: \`${result.targetFolder}\`\n\n`;

    if (result.unsubmitted.length === 0) {
      msg += `🎉 *チームメンバー全員提出完了しています！*\n`;
      msg += `迅速なご提出ありがとうございました！✨\n\n`;
      msg += `*提出済み (${result.submitted.length}/${result.totalMembers}名):*\n`;
      result.submitted.forEach((s) => {
        msg += `  ✅ ${s.member.name} (\`${s.filename}\`)\n`;
      });
      return msg;
    }

    // Unsubmitted members exist
    msg += `⏳ *未提出 (${result.unsubmitted.length} / ${result.totalMembers}名)*:\n`;
    result.unsubmitted.forEach((u) => {
      const mention = u.member.slackId
        ? `<@${u.member.slackId}> (${u.member.name})`
        : `${u.member.name}さん`;
      const staffInfo = u.member.staffNum ? ` [社員番号: ${u.member.staffNum}]` : '';
      msg += `  ・${mention}${staffInfo}\n`;
    });

    msg += `\n⚠️ *提出のお願い*\n`;
    msg += `Pydio共通フォルダ（上記パス）へ出勤簿Excel（\`.xls\` / \`.xlsm\`）のご提出をお願いいたします🙇\n\n`;

    msg += `*提出済み (${result.submitted.length}/${result.totalMembers}名):*\n`;
    result.submitted.forEach((s) => {
      msg += `  ✅ ${s.member.name} (\`${s.filename}\`)\n`;
    });

    return msg;
  }

  /**
   * Executes check and sends message to Slack channel.
   */
  async runAttendanceNotification(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    slackClient: any,
    targetChannelId?: string,
    overrideYearMonth?: string
  ): Promise<{ result: AttendanceCheckResult; messageSent: boolean }> {
    const channelId =
      targetChannelId || process.env.SLACK_NOTIFICATION_CHANNEL_ID || 'C0AQETFBF8W';

    const result = await this.checkAttendance(overrideYearMonth);
    const message = this.formatSlackMessage(result, true);

    let messageSent = false;
    if (slackClient && channelId) {
      try {
        await slackClient.chat.postMessage({
          channel: channelId,
          text: message,
        });
        messageSent = true;
      } catch (err) {
        console.error('Failed to post attendance check message to Slack:', err);
      }
    }

    return { result, messageSent };
  }
}
