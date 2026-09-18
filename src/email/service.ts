export interface SlackClientInterface {
  chat: {
    postMessage: (args: any) => Promise<any>;
  };
}
import {
  GmailIncomingMessage,
  AttendanceRecord,
  AllHandsAnnouncement,
} from '../types';
import {
  getTeamMembers,
  findMemberByName,
  getManagerSlackId,
} from '../config/members';
import { normalizeName } from '../sheets/parser';
import { GeminiService, formatMarkdownForSlack } from '../ai/gemini';

export const DEFAULT_ATTENDANCE_KEYWORDS = ['applies'];
export const DEFAULT_ANNOUNCEMENT_KEYWORDS = ['allpe'];
export const DEFAULT_ANNOUNCEMENT_TO_EMAILS: string[] = [];
export const DEFAULT_ANNOUNCEMENT_FROM_EMAILS: string[] = [];
export const DEFAULT_MANAGER_REPORT_KEYWORDS: string[] = [];
export const DEFAULT_MANAGER_REPORT_FROM_EMAILS: string[] = [];

/**
 * Parses a comma-separated string from environment variables into a trimmed array.
 */
export function parseCommaSeparatedList(
  value?: string,
  defaultValue: string[] = []
): string[] {
  if (!value || value.trim() === '') {
    return [...defaultValue];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export interface EmailProcessingResult {
  attendanceRecords: AttendanceRecord[];
  announcements: AllHandsAnnouncement[];
  managerDirectEmails: AllHandsAnnouncement[];
  ignoredCount: number;
}

export class EmailProcessingService {
  private geminiService: GeminiService;

  constructor(geminiService?: GeminiService) {
    this.geminiService = geminiService || new GeminiService();
  }

  /**
   * Returns the list of attendance keywords (from env ATTENDANCE_KEYWORDS or default).
   */
  getAttendanceKeywords(): string[] {
    return parseCommaSeparatedList(
      process.env.ATTENDANCE_KEYWORDS,
      DEFAULT_ATTENDANCE_KEYWORDS
    );
  }

  /**
   * Returns the list of announcement keywords (from env ANNOUNCEMENT_KEYWORDS or default).
   */
  getAnnouncementKeywords(): string[] {
    return parseCommaSeparatedList(
      process.env.ANNOUNCEMENT_KEYWORDS,
      DEFAULT_ANNOUNCEMENT_KEYWORDS
    );
  }

  /**
   * Returns the list of announcement sender emails (from env ANNOUNCEMENT_FROM_EMAILS or default).
   */
  getAnnouncementFromEmails(): string[] {
    return parseCommaSeparatedList(
      process.env.ANNOUNCEMENT_FROM_EMAILS,
      DEFAULT_ANNOUNCEMENT_FROM_EMAILS
    );
  }

  /**
   * Returns the list of sender emails to report directly to manager DM (from env MANAGER_REPORT_FROM_EMAILS).
   */
  getManagerReportFromEmails(): string[] {
    return parseCommaSeparatedList(
      process.env.MANAGER_REPORT_FROM_EMAILS,
      DEFAULT_MANAGER_REPORT_FROM_EMAILS
    );
  }

  /**
   * Returns the list of recipient emails for all-hands announcements (from env ANNOUNCEMENT_TO_EMAILS).
   */
  getAnnouncementToEmails(): string[] {
    return parseCommaSeparatedList(
      process.env.ANNOUNCEMENT_TO_EMAILS,
      DEFAULT_ANNOUNCEMENT_TO_EMAILS
    );
  }

  /**
   * Returns the list of manager keywords in subject (from env MANAGER_REPORT_KEYWORDS or default).
   */
  getManagerReportKeywords(): string[] {
    return parseCommaSeparatedList(
      process.env.MANAGER_REPORT_KEYWORDS,
      DEFAULT_MANAGER_REPORT_KEYWORDS
    );
  }

  /**
   * Checks if an email is a manager direct report email.
   * Rule: From matches MANAGER_REPORT_FROM_EMAILS or Subject matches MANAGER_REPORT_KEYWORDS.
   */
  isManagerDirectEmail(msg: GmailIncomingMessage): boolean {
    const from = (msg.from || '').toLowerCase();
    const reportFromEmails = this.getManagerReportFromEmails();
    if (reportFromEmails.some((email) => from.includes(email.toLowerCase()))) {
      return true;
    }

    const subject = (msg.subject || '').toLowerCase();
    const managerKeywords = this.getManagerReportKeywords();
    if (managerKeywords.some((kw) => subject.includes(kw.toLowerCase()))) {
      return true;
    }

    return false;
  }

  /**
   * Checks if an email is an attendance notification for a team member.
   * Rule: Subject contains any attendance keyword AND a registered team member's name.
   */
  isAttendanceEmail(msg: GmailIncomingMessage): {
    isAttendance: boolean;
    matchedMemberName?: string;
  } {
    const subject = msg.subject || '';
    const keywords = this.getAttendanceKeywords();
    const hasKeyword = keywords.some((kw) =>
      subject.toLowerCase().includes(kw.toLowerCase())
    );
    if (!hasKeyword) {
      return { isAttendance: false };
    }

    const normSubject = normalizeName(subject);
    const teamMembers = getTeamMembers();
    for (const member of teamMembers) {
      const normMember = normalizeName(member.name);
      if (normMember && normSubject.includes(normMember)) {
        return { isAttendance: true, matchedMemberName: member.name };
      }
    }

    return { isAttendance: false };
  }

  /**
   * Checks if an email is an all-hands or important announcement.
   * Rule:
   * 1. Senders in MANAGER_REPORT_FROM_EMAILS are excluded (they route to manager direct DM).
   * 2. Recipient (To) matches ANNOUNCEMENT_TO_EMAILS (e.g. allpe@...)
   * 3. Sender (From) matches ANNOUNCEMENT_FROM_EMAILS
   * 4. Subject contains announcement keyword (e.g. allpe)
   */
  isAnnouncementEmail(msg: GmailIncomingMessage): boolean {
    const from = (msg.from || '').toLowerCase();
    const reportFromEmails = this.getManagerReportFromEmails();
    if (reportFromEmails.some((email) => from.includes(email.toLowerCase()))) {
      return false;
    }

    const toEmails = this.getAnnouncementToEmails();
    const fromEmails = this.getAnnouncementFromEmails();
    const subject = (msg.subject || '').toLowerCase();
    const keywords = this.getAnnouncementKeywords();

    // 1. If recipient (To) is provided and announcement TO emails are configured:
    // If sent to another specific address, it is not an all-hands announcement.
    if (toEmails.length > 0 && msg.to) {
      const to = msg.to.toLowerCase();
      if (!toEmails.some((email) => to.includes(email.toLowerCase()))) {
        return false;
      }
      return true;
    }

    // 2. Sender (From) email match
    if (fromEmails.length > 0) {
      if (fromEmails.some((email) => from.includes(email.toLowerCase()))) {
        return true;
      }
    }

    // 3. Subject keyword match
    if (keywords.some((kw) => subject.includes(kw.toLowerCase()))) {
      return true;
    }

    return false;
  }

  /**
   * Parses an attendance email to extract structured details.
   */
  async parseAttendanceRecord(
    msg: GmailIncomingMessage,
    memberName: string
  ): Promise<AttendanceRecord> {
    const subject = msg.subject || '';
    const body = msg.body || '';

    // 1. Check leave type from subject or body: [全休], [遅刻], [午前休], [午後休], [在宅], etc.
    let leaveType = '申請';
    const typeMatch = subject.match(
      /\[(全休|午前休|午後休|半休|遅刻|早退|在宅|有給|振休|特別休暇)\]/i
    );
    if (typeMatch) {
      leaveType = typeMatch[1];
    } else {
      const bodyTypeMatch = body.match(
        /区分[：:]\s*(全休|午前休|午後休|半休|遅刻|早退|在宅|有給|振休|特別休暇)/i
      );
      if (bodyTypeMatch) {
        leaveType = bodyTypeMatch[1];
      }
    }

    // 2. Check date: 2026-09-18 or 2026/09/18
    let dateStr = '';
    const dateMatch = subject.match(/\b(\d{4}[-/]\d{2}[-/]\d{2})\b/);
    if (dateMatch) {
      dateStr = dateMatch[1].replace(/\//g, '-');
    } else {
      const bodyDateMatch = body.match(/\b(\d{4}[-/]\d{2}[-/]\d{2})\b/);
      if (bodyDateMatch) {
        dateStr = bodyDateMatch[1].replace(/\//g, '-');
      } else {
        dateStr = new Date().toISOString().split('T')[0];
      }
    }

    // 3. Is same-day application?
    const isSameDay = subject.includes('当日申請') || body.includes('当日申請');

    // 4. Extract reason (if present)
    let reason = '';
    const reasonMatch = body.match(/事由[：:]\s*([^\r\n]+)/i);
    if (reasonMatch) {
      reason = reasonMatch[1].trim();
    } else {
      // Look for common keywords in body
      const lines = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      for (const line of lines) {
        if (
          (line.includes('体調') ||
            line.includes('通院') ||
            line.includes('私用') ||
            line.includes('理由') ||
            line.includes('都合')) &&
          !line.includes('http')
        ) {
          reason = line.replace(/^(理由|事由|備考)[：:]\s*/, '').trim();
          break;
        }
      }
    }

    const member = findMemberByName(memberName);

    return {
      memberName,
      slackUserId: member?.slackId,
      date: dateStr,
      leaveType,
      isSameDay,
      reason: reason || undefined,
      rawSubject: subject,
    };
  }

  /**
   * Summarizes an announcement email with Gemini AI.
   */
  async summarizeAnnouncement(
    msg: GmailIncomingMessage
  ): Promise<AllHandsAnnouncement> {
    const subject = msg.subject || '（件名なし）';
    const from = msg.from || '（差出人不明）';
    const date = msg.date || new Date().toISOString();
    const body = msg.body || msg.snippet || '';

    let summary = '';
    const keyPoints: string[] = [];
    let deadline: string | undefined;

    if (this.geminiService.isConfigured() && body.trim().length > 0) {
      const systemInstruction =
        'あなたは企業の要約アシスタントです。全社向け・重要メールの内容を分析し、メンバーがパッと見て要点を把握できるよう簡潔に要約してください。\n' +
        '以下の形式のJSONのみを出力してください（Markdownの```jsonなどのコードブロックも不要、純粋なJSON文字列のみ）：\n' +
        '{\n' +
        '  "summary": "1〜2行の全体の概要",\n' +
        '  "keyPoints": ["要点1", "要点2", "要点3"],\n' +
        '  "deadline": "対応期日（明記されている場合のみ。無ければ空文字）"\n' +
        '}';

      const prompt = `件名: ${subject}\n送信者: ${from}\n本文:\n${body.substring(0, 2000)}`;

      try {
        const aiOutput = await this.geminiService.generateText(
          prompt,
          systemInstruction
        );
        const cleaned = aiOutput
          .replace(/```json/gi, '')
          .replace(/```/g, '')
          .trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.summary) {
          summary = formatMarkdownForSlack(parsed.summary);
        }
        if (Array.isArray(parsed.keyPoints)) {
          keyPoints.push(
            ...parsed.keyPoints
              .filter((k: unknown) => typeof k === 'string')
              .map((k: string) => formatMarkdownForSlack(k))
          );
        }
        if (parsed.deadline && parsed.deadline.trim() !== '') {
          deadline = parsed.deadline.trim();
        }
      } catch (err) {
        console.warn(
          'Gemini announcement summary parsing failed, using fallback:',
          err
        );
      }
    }

    // Fallback if AI not configured or failed
    if (!summary) {
      const snippet = body.replace(/\s+/g, ' ').substring(0, 160);
      summary = snippet
        ? `${snippet}...`
        : '（本文詳細はメールをご確認ください）';
    }

    return {
      subject,
      from,
      date,
      summary,
      keyPoints,
      deadline,
      rawBody: body,
    };
  }

  /**
   * Formats attendance summary message for Manager DM.
   */
  formatAttendanceSummaryMessage(
    records: AttendanceRecord[],
    targetDateStr?: string
  ): string {
    const today = targetDateStr || new Date().toISOString().split('T')[0];
    const [, month, day] = today.split('-');
    const formattedDate = `${month}/${day}`;

    if (records.length === 0) {
      return (
        `☀️ *【チーム勤怠連絡（${formattedDate}・昨日12:00以降の申請）】*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ *全メンバー通常勤務*（休暇・遅刻・在宅等の申請はありません）\n` +
        `━━━━━━━━━━━━━━━━━━━━━━`
      );
    }

    const items = records
      .map((r) => {
        const sameDayTag = r.isSameDay ? ' [当日申請]' : '';
        const reasonTag = r.reason ? ` (${r.reason})` : '';
        const dateTag = r.date
          ? ` [${r.date.substring(5).replace('-', '/')}]`
          : '';
        return `・*${r.memberName}*: [${r.leaveType}]${dateTag}${sameDayTag}${reasonTag}`;
      })
      .join('\n');

    return (
      `☀️ *【チーム勤怠連絡（${formattedDate}・昨日12:00以降の申請）】*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${items}\n` +
      `・_その他メンバー: 申請なし（通常勤務）_\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `_※マネージャーのDMにのみ配信されています。_`
    );
  }

  /**
   * Formats manager direct report email message for manager DM.
   */
  formatManagerDirectMessage(announcement: AllHandsAnnouncement): string {
    let keyPointsText = '';
    if (announcement.keyPoints && announcement.keyPoints.length > 0) {
      keyPointsText =
        `\n💡 *要点まとめ:*\n` +
        announcement.keyPoints.map((p) => `・${p}`).join('\n');
    }

    const deadlineText = announcement.deadline
      ? `\n⏰ *対応期日:* *${announcement.deadline}*`
      : '';

    return (
      `📩 *【マネージャー宛 重要メール報告（AI要約）】*\n` +
      `*件名:* ${announcement.subject}\n` +
      `*送信者:* ${announcement.from}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📝 *概要:*\n${announcement.summary}${keyPointsText}${deadlineText}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `_※マネージャーのDMにのみ配信されています。詳細はGmailをご確認ください。_`
    );
  }

  /**
   * Formats all-hands announcement message for general channel.
   */
  formatAnnouncementMessage(announcement: AllHandsAnnouncement): string {
    let keyPointsText = '';
    if (announcement.keyPoints && announcement.keyPoints.length > 0) {
      keyPointsText =
        `\n💡 *要点まとめ:*\n` +
        announcement.keyPoints.map((p) => `・${p}`).join('\n');
    }

    const deadlineText = announcement.deadline
      ? `\n⏰ *対応期日:* *${announcement.deadline}*`
      : '';

    return (
      `📢 *【全体周知・重要連絡（AI要約）】*\n` +
      `*件名:* ${announcement.subject}\n` +
      `*送信者:* ${announcement.from}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📝 *概要:*\n${announcement.summary}${keyPointsText}${deadlineText}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `_※詳細は各自のGmailをご確認ください。_`
    );
  }

  /**
   * Processes a batch of incoming Gmail messages from GAS webhook.
   */
  async processIncomingEmails(
    messages: GmailIncomingMessage[],
    client: SlackClientInterface,
    options?: {
      managerId?: string;
      channelId?: string;
    }
  ): Promise<EmailProcessingResult> {
    const attendanceRecords: AttendanceRecord[] = [];
    const announcements: AllHandsAnnouncement[] = [];
    const managerDirectEmails: AllHandsAnnouncement[] = [];
    let ignoredCount = 0;

    const managerSlackId = options?.managerId || getManagerSlackId();
    const generalChannelId =
      options?.channelId ||
      process.env.SLACK_NOTIFICATION_CHANNEL_ID ||
      'C0AQETFBF8W';

    for (const msg of messages) {
      // 1. Check attendance
      const attCheck = this.isAttendanceEmail(msg);
      if (attCheck.isAttendance && attCheck.matchedMemberName) {
        const record = await this.parseAttendanceRecord(
          msg,
          attCheck.matchedMemberName
        );
        attendanceRecords.push(record);
        continue;
      }

      // 2. Check manager direct report email (e.g. from configured managers/executives)
      if (this.isManagerDirectEmail(msg)) {
        const directEmail = await this.summarizeAnnouncement(msg);
        managerDirectEmails.push(directEmail);
        continue;
      }

      // 3. Check announcement (e.g. allpe)
      if (this.isAnnouncementEmail(msg)) {
        const announcement = await this.summarizeAnnouncement(msg);
        announcements.push(announcement);
        continue;
      }

      ignoredCount++;
    }

    // 1. Send attendance records to Manager DM
    if (attendanceRecords.length > 0 && managerSlackId) {
      const text = this.formatAttendanceSummaryMessage(attendanceRecords);
      try {
        await client.chat.postMessage({
          channel: managerSlackId,
          text,
        });
      } catch (err) {
        console.error('Failed to send attendance summary to manager DM:', err);
      }
    }

    // 2. Send manager direct emails to Manager DM
    if (managerDirectEmails.length > 0 && managerSlackId) {
      for (const directEmail of managerDirectEmails) {
        const text = this.formatManagerDirectMessage(directEmail);
        try {
          await client.chat.postMessage({
            channel: managerSlackId,
            text,
          });
        } catch (err) {
          console.error(
            'Failed to send manager direct email to manager DM:',
            err
          );
        }
      }
    }

    // 3. Send each announcement to General Channel
    if (announcements.length > 0 && generalChannelId) {
      for (const ann of announcements) {
        const text = this.formatAnnouncementMessage(ann);
        try {
          await client.chat.postMessage({
            channel: generalChannelId,
            text,
          });
        } catch (err) {
          console.error('Failed to post announcement to general channel:', err);
        }
      }
    }

    return {
      attendanceRecords,
      announcements,
      managerDirectEmails,
      ignoredCount,
    };
  }
}
