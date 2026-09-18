import { WebClient } from '@slack/web-api';
import {
  WeeklyCheckSummary,
  WeeklyReportCheckResult,
  GSessionLoginStatus,
  WeeklyReportContent,
  ProjectReportDetail,
  GSessionScheduleDay,
} from '../types';
import { isNameMatch, normalizeName } from '../sheets/parser';
import { GeminiService } from '../ai/gemini';
import {
  getTeamMembers,
  getSlackMention as configGetSlackMention,
  getManagerSlackId as configGetManagerSlackId,
  getManagerConfig,
  findMemberByName,
  getAllMembers,
} from '../config/members';

export const ONUMA_TEAM_MEMBERS: string[] = [];

export const DEFAULT_MEMBER_SLACK_MAPPING: Record<string, string> = {};

export class WeeklyCheckService {
  private weeklyUser: string;
  private weeklyPass: string;
  private gsessionUser: string;
  private gsessionPass: string;
  private memberSlackMap: Map<string, string>;
  private managerSlackId?: string;
  private geminiService: GeminiService;

  constructor(geminiService?: GeminiService) {
    this.geminiService = geminiService || new GeminiService();
    this.weeklyUser =
      process.env.WEEKLY_REPORT_USERNAME ||
      process.env.WEEKLY_REPORT_USER ||
      '';
    this.weeklyPass =
      process.env.WEEKLY_REPORT_PASSWORD ||
      process.env.WEEKLY_REPORT_PASS ||
      '';
    this.gsessionUser =
      process.env.GSESSION_USERNAME || process.env.GSESSION_USER || '';
    this.gsessionPass =
      process.env.GSESSION_PASSWORD || process.env.GSESSION_PASS || '';
    this.managerSlackId =
      process.env.MANAGER_SLACK_USER_ID ||
      configGetManagerSlackId();

    this.memberSlackMap = new Map();
    this.loadMemberMappings();
  }

  /**
   * Loads member Slack mappings from defaults and optional MEMBER_SLACK_MAPPING env.
   */
  private loadMemberMappings() {
    // 1. Initialize from configured members
    const all = getAllMembers();
    for (const m of all) {
      if (m.slackId) {
        this.memberSlackMap.set(normalizeName(m.name), m.slackId);
      }
    }

    // 2. Override with custom environment variable if provided
    const mappingJson = process.env.MEMBER_SLACK_MAPPING;
    if (mappingJson) {
      try {
        const parsed = JSON.parse(mappingJson);
        for (const [name, slackId] of Object.entries(parsed)) {
          this.memberSlackMap.set(normalizeName(name), slackId as string);
        }
      } catch (e) {
        console.warn(
          'Failed to parse MEMBER_SLACK_MAPPING in WeeklyCheckService:',
          e
        );
      }
    }
  }

  /**
   * Returns a Slack mention string (<@U12345> or fallback name).
   */
  getSlackMention(name: string): string {
    const member = findMemberByName(name);
    if (member?.slackId) {
      return `<@${member.slackId}>`;
    }
    for (const [mappedName, slackId] of this.memberSlackMap.entries()) {
      if (isNameMatch(mappedName, name)) {
        return `<@${slackId}>`;
      }
    }
    return `${name}さん`;
  }

  /**
   * Returns Slack mention for the manager.
   */
  getManagerMention(): string {
    const id = this.getManagerSlackId();
    if (id) {
      return `<@${id}>`;
    }
    const manager = getManagerConfig();
    return manager.name ? `${manager.name}さん` : 'マネージャーさん';
  }

  /**
   * Returns Slack user ID for the manager.
   */
  getManagerSlackId(): string {
    return (
      this.managerSlackId ||
      process.env.MANAGER_SLACK_USER_ID ||
      configGetManagerSlackId() ||
      ''
    );
  }

  /**
   * Logs into weekly report portal and returns the top page HTML and cookie string.
   */
  async fetchWeeklyReportTop(): Promise<{
    pageHtml: string;
    cookieStr: string;
  } | null> {
    if (!this.weeklyUser || !this.weeklyPass) {
      return null;
    }

    try {
      const loginUrl = 'https://auth.poweredge.co.jp/weekly_report/login';
      const cookies = new Map<string, string>();

      let currentRes = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://auth.poweredge.co.jp',
          Referer: 'https://auth.poweredge.co.jp/weekly_report/login',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: new URLSearchParams({
          username: this.weeklyUser,
          password: this.weeklyPass,
        }).toString(),
        redirect: 'manual',
      });

      let currentUrl = loginUrl;
      let redirectCount = 0;

      while (
        currentRes.status >= 300 &&
        currentRes.status < 400 &&
        redirectCount < 5
      ) {
        const rawSetCookie = currentRes.headers.get('set-cookie') || '';
        for (const c of rawSetCookie.split(',')) {
          const part = c.split(';')[0].trim();
          const [k, v] = part.split('=');
          if (k && v) cookies.set(k.trim(), v.trim());
        }

        const location = currentRes.headers.get('location');
        if (!location) break;

        currentUrl = new URL(location, currentUrl).href;
        const cookieStr = Array.from(cookies.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

        currentRes = await fetch(currentUrl, {
          headers: {
            Cookie: cookieStr,
            Referer: currentUrl,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          redirect: 'manual',
        });
        redirectCount++;
      }

      const rawSetCookie = currentRes.headers.get('set-cookie') || '';
      for (const c of rawSetCookie.split(',')) {
        const part = c.split(';')[0].trim();
        const [k, v] = part.split('=');
        if (k && v) cookies.set(k.trim(), v.trim());
      }

      const cookieStr = Array.from(cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      const pageHtml = await currentRes.text();
      return { pageHtml, cookieStr };
    } catch (err) {
      console.error('Failed to authenticate with weekly report portal:', err);
      return null;
    }
  }

  /**
   * Checks weekly report submission status for Onuma team.
   */
  async checkWeeklyReports(): Promise<WeeklyReportCheckResult> {
    try {
      const session = await this.fetchWeeklyReportTop();
      if (session) {
        return parseWeeklyReportTopHtml(session.pageHtml);
      }
    } catch (err) {
      console.error('Failed to fetch weekly report status:', err);
    }

    const currentMembers = getTeamMembers().map((m) => m.name);
    return {
      weekLabel: '先週分',
      submitted: [],
      unsubmitted: currentMembers,
      totalMembers: currentMembers.length,
    };
  }

  /**
   * Fetches report details (impression, projects, uptime) for submitted staff members.
   */
  async fetchSubmittedReportDetails(
    cookieStr: string,
    submittedStaffList: Array<{
      staffId: number;
      staffName: string;
      wrTargetDateId: number;
    }>
  ): Promise<WeeklyReportContent[]> {
    const reports: WeeklyReportContent[] = [];

    for (const staff of submittedStaffList) {
      try {
        const viewUrl = `https://auth.poweredge.co.jp/weekly_report/view?staffId=${staff.staffId}&wrTargetDateId=${staff.wrTargetDateId}`;

        // 1. Visit the individual member view page
        await fetch(viewUrl, {
          headers: {
            Cookie: cookieStr,
            Referer: 'https://auth.poweredge.co.jp/weekly_report/top',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        }).catch((e) => console.warn(`Failed to access view page for ${staff.staffName}:`, e));

        // 2. Fetch report details (this registers the manager's browse / 既読 into tWrBrowseData)
        const apiUrl = 'https://auth.poweredge.co.jp/weekly_report/getReportInfo';
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookieStr,
            Referer: viewUrl,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          body: new URLSearchParams({
            staffId: String(staff.staffId),
            wrTargetDateId: String(staff.wrTargetDateId),
            switchState: '0',
          }).toString(),
        });

        if (!res.ok) {
          console.warn(
            `Failed to fetch report info for ${staff.staffName} (status ${res.status})`
          );
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await res.json()) as any;
        const projects: ProjectReportDetail[] = [];
        if (Array.isArray(data.vProjectGeneralInformation)) {
          for (const p of data.vProjectGeneralInformation) {
            projects.push({
              properName: p.properName || '未確定',
              endUser: p.endUser || '未確定',
              prjDetail: p.prjDetail || '',
            });
          }
        }

        reports.push({
          staffId: staff.staffId,
          staffName: staff.staffName,
          impression: data.impression || '',
          weekUptime: data.weekUptime,
          projects,
        });
      } catch (err) {
        console.warn(`Error fetching report info for ${staff.staffName}:`, err);
      }
    }

    return reports;
  }

  /**
   * Logs into GroupSession and returns the session cookie string.
   */
  async loginGSession(): Promise<{ sessionCookie: string } | null> {
    if (!this.gsessionUser || !this.gsessionPass) {
      return null;
    }

    try {
      const loginUrl = 'https://po-tal.poweredge.co.jp/gsession/common/cmn001.do';
      const initRes = await fetch(loginUrl);
      const initHtml = await initRes.text();
      const tokenMatch = initHtml.match(
        /name="org\.apache\.struts\.taglib\.html\.TOKEN"\s+value="([^"]+)"/i
      );
      const token = tokenMatch ? tokenMatch[1] : '';
      const setCookie = initRes.headers.get('set-cookie') || '';

      const postBody = new URLSearchParams();
      if (token) postBody.append('org.apache.struts.taglib.html.TOKEN', token);
      postBody.append('CMD', 'login');
      postBody.append('cmn001loginType', '1');
      postBody.append('cmn001Userid', this.gsessionUser);
      postBody.append('cmn001Passwd', this.gsessionPass);

      const loginRes = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: setCookie,
        },
        body: postBody.toString(),
        redirect: 'manual',
      });

      const sessionCookie = loginRes.headers.get('set-cookie') || setCookie;
      return { sessionCookie };
    } catch (err) {
      console.error('Failed to log into GroupSession:', err);
      return null;
    }
  }

  /**
   * Fetches the 1-week schedule for the logged-in user (Onuma) from the GroupSession main dashboard widget.
   */
  async fetchGSessionMySchedule(
    sessionCookie?: string
  ): Promise<GSessionScheduleDay[]> {
    let cookie = sessionCookie;
    if (!cookie) {
      const session = await this.loginGSession();
      if (!session) {
        return [];
      }
      cookie = session.sessionCookie;
    }

    try {
      const schmainUrl =
        'https://po-tal.poweredge.co.jp/gsession/schedule/schmain.do';
      const res = await fetch(schmainUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: '',
      });

      const html = await res.text();
      return parseGSessionSchmainHtml(html);
    } catch (err) {
      console.error('Failed to fetch GroupSession my schedule:', err);
      return [];
    }
  }

  /**
   * Checks GroupSession login status for Onuma team (flagging inactive >= threshold days).
   */
  async checkGSessionLogins(
    inactiveThresholdDays = 7,
    sessionCookie?: string
  ): Promise<{
    inactiveMembers: GSessionLoginStatus[];
    activeMembers: GSessionLoginStatus[];
  }> {
    if (!this.gsessionUser || !this.gsessionPass) {
      return {
        inactiveMembers: [],
        activeMembers: getTeamMembers().map((m) => ({
          name: m.name,
          daysSinceLastLogin: 0,
          lastLoginDate: '未設定',
          isInactive: false,
        })),
      };
    }

    try {
      let cookie = sessionCookie;
      if (!cookie) {
        const login = await this.loginGSession();
        if (!login) {
          throw new Error('Failed to login to GroupSession');
        }
        cookie = login.sessionCookie;
      }

      // Fetch login history for Team Onuma (man050.do with grpSid=157)
      const listUrl = 'https://po-tal.poweredge.co.jp/gsession/main/man050.do';
      const man050Body = new URLSearchParams({
        CMD: '',
        cmd: '',
        man050SortKey: '4',
        man050OrderKey: '0',
        man050Backurl: '1',
        man050SelectedUsrSid: '0',
        man050cmdMode: '0',
        man050SearchFlg: '0',
        sch010SelectUsrSid: '',
        sch010SelectUsrKbn: '',
        helpPrm: '2',
        man050grpSid: '157',
      });

      const listRes = await fetch(listUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: man050Body.toString(),
      });
      const listHtml = await listRes.text();

      return parseGSessionMan050Html(
        listHtml,
        new Date(),
        inactiveThresholdDays
      );
    } catch (err) {
      console.error('Failed to fetch GroupSession login status:', err);
      return {
        inactiveMembers: [],
        activeMembers: getTeamMembers().map((m) => ({
          name: m.name,
          isInactive: false,
        })),
      };
    }
  }

  /**
   * Generates formatted Slack message combining weekly reports & GroupSession inactive warnings.
   */
  generateSummaryMessage(summary: WeeklyCheckSummary): string {
    const d = summary.checkedAt;
    const dateStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

    const rep = summary.weeklyReport;

    // 週報未提出、または1週間以上GS未ログインのどちらかに当てはまるメンバーを抽出
    const flaggedMembers = new Set<string>();
    for (const m of rep.unsubmitted) {
      flaggedMembers.add(m);
    }
    for (const im of summary.gSession.inactiveMembers) {
      flaggedMembers.add(im.name);
    }

    let alertHeader = '';
    if (flaggedMembers.size > 0) {
      const managerMention = this.getManagerMention();
      const targetMentions = Array.from(flaggedMembers)
        .map((m) => this.getSlackMention(m))
        .join(' ');

      alertHeader =
        `🚨 *【要確認】週報未提出、またはGroupSessionに1週間以上未ログインのメンバーがいます*\n` +
        `宛先: ${managerMention} / ${targetMentions}\n\n`;
    } else {
      alertHeader =
        `🎉 *【定期チェック完了】チーム全員が週報提出済み＆GSログイン確認済みです！* ✨\n\n`;
    }

    const repSubNames = rep.submitted.join('、') || '（なし）';
    const repUnsubNames =
      rep.unsubmitted.map((m) => this.getSlackMention(m)).join('、') ||
      '（なし・全員提出完了！🎉）';

    let gsText = '';
    if (summary.gSession.inactiveMembers.length > 0) {
      const inactiveList = summary.gSession.inactiveMembers
        .map(
          (m) =>
            `  ・${this.getSlackMention(m.name)} (最終ログイン: ${m.lastLoginDate || `${m.daysSinceLastLogin}日前`})`
        )
        .join('\n');
      gsText =
        `⚠️ *1週間以上未ログイン (${summary.gSession.inactiveMembers.length}名):*\n${inactiveList}\n` +
        `  _※他 ${summary.gSession.activeMembers.length} 名は直近1週間以内にログイン確認済みです。_`;
    } else {
      gsText = `✅ *全員が直近1週間以内にログインしています！* (${summary.gSession.activeMembers.length}名)`;
    }

    return (
      `${alertHeader}` +
      `📊 *【毎週火曜定期チェック】チーム状況レポート* (${dateStr})\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📝 *1. 週報提出状況 (${rep.weekLabel})*\n` +
      `  ✅ *提出済み (${rep.submitted.length}/${rep.totalMembers}名):* ${repSubNames}\n` +
      `  ⏳ *未提出 (${rep.unsubmitted.length}名):* ${repUnsubNames}\n` +
      `  🔗 <https://auth.poweredge.co.jp/weekly_report/|週報システムを開く>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔑 *2. GroupSession ログイン状況 (1週間以上未ログイン判定)*\n` +
      `  ${gsText}\n` +
      `  🔗 <https://po-tal.poweredge.co.jp/gsession/common/cmn001.do|GroupSessionを開く>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `_※毎週火曜日に自動チェック＆配信しています。_`
    );
  }

  /**
   * Sends AI-generated weekly report summary privately to manager via Slack DM.
   */
  async sendManagerPrivateSummary(
    client: any,
    weekLabel: string,
    reports: WeeklyReportContent[]
  ): Promise<{ success: boolean; summaryText: string }> {
    const managerId = this.getManagerSlackId();
    if (!managerId) {
      console.warn('Manager Slack ID is not configured for private summary.');
      return { success: false, summaryText: '' };
    }

    const summaryText =
      await this.geminiService.generateWeeklyReportsSummary(
        reports,
        weekLabel
      );

    await client.chat.postMessage({
      channel: managerId,
      text: summaryText,
    });

    return { success: true, summaryText };
  }

  /**
   * Executes full check, posts message to public channel, and delivers private AI summary and schedule to manager DM.
   */
  async runWeeklyCheck(
    client: any,
    channelId: string
  ): Promise<{ success: boolean; message: string }> {
    let gSessionCookie: string | undefined;
    try {
      const gLogin = await this.loginGSession();
      gSessionCookie = gLogin?.sessionCookie;
    } catch (e) {
      console.warn('GroupSession pre-login failed:', e);
    }

    const [weeklyReport, gSession] = await Promise.all([
      this.checkWeeklyReports(),
      this.checkGSessionLogins(7, gSessionCookie),
    ]);

    const summary: WeeklyCheckSummary = {
      checkedAt: new Date(),
      weeklyReport,
      gSession,
    };

    const text = this.generateSummaryMessage(summary);

    // 1. Post weekly submission status & GS warning to public channel (without report bodies)
    await client.chat.postMessage({
      channel: channelId,
      text,
    });

    const managerId = this.getManagerSlackId();

    // 2. Safely generate and send private AI weekly summary to manager's 1:1 DM
    try {
      const session = await this.fetchWeeklyReportTop();
      if (session) {
        const submittedStaff = extractSubmittedStaffRecords(session.pageHtml);
        const reportDetails = await this.fetchSubmittedReportDetails(
          session.cookieStr,
          submittedStaff
        );
        await this.sendManagerPrivateSummary(
          client,
          weeklyReport.weekLabel,
          reportDetails
        );
      }
    } catch (summaryErr) {
      console.error(
        'Failed to generate or send manager private weekly summary:',
        summaryErr
      );
    }

    // 3. Fetch and deliver Onuma's 1-week GroupSession schedule to manager's 1:1 DM
    try {
      if (managerId) {
        const scheduleDays = await this.fetchGSessionMySchedule(gSessionCookie);
        if (scheduleDays && scheduleDays.length > 0) {
          const scheduleMsg = formatGSessionScheduleMessage(scheduleDays);
          await client.chat.postMessage({
            channel: managerId,
            text: scheduleMsg,
          });
        }
      }
    } catch (schErr) {
      console.error(
        'Failed to fetch or send manager GroupSession schedule:',
        schErr
      );
    }

    return { success: true, message: '毎週火曜チェック通知を送信しました。' };
  }

  /**
   * Generates weekly reports summary on-demand for manager and delivers along with 1-week schedule.
   */
  async runWeeklySummary(
    client: any,
    requestingUserId?: string,
    options?: {
      offsetWeeks?: number;
      targetDate?: string;
      targetWrDateId?: number;
    }
  ): Promise<{
    success: boolean;
    message: string;
    summaryText: string;
    scheduleText?: string;
  }> {
    const targetUser = requestingUserId || this.getManagerSlackId();

    let summaryText = '';
    const session = await this.fetchWeeklyReportTop();
    if (!session) {
      // Mock / fallback if credentials missing
      const fallbackReports: WeeklyReportContent[] = [
        {
          staffId: 48,
          staffName: getManagerConfig().name || 'マネージャー',
          impression:
            '【業務内容】新規参画メンバーフォロー、Ph4対応\n【所感】順調に進捗しています。',
          weekUptime: 40,
          projects: [
            {
              properName: 'AI駆動開発支援',
              endUser: 'KIRIN',
              prjDetail: 'AIエージェント開発・社内ツール作成の高速化',
            },
          ],
        },
      ];
      summaryText = await this.geminiService.generateWeeklyReportsSummary(
        fallbackReports,
        '先週分'
      );

      if (client && targetUser) {
        await client.chat.postMessage({
          channel: targetUser,
          text: summaryText,
        });
      }
    } else {
      const checkResult = parseWeeklyReportTopHtml(session.pageHtml);
      const newestId = extractNewestWrTargetDateId(session.pageHtml) || 735;

      let targetWrDateId: number | undefined = options?.targetWrDateId;
      let label = checkResult.weekLabel;

      if (options?.offsetWeeks && options.offsetWeeks > 0) {
        targetWrDateId = newestId - options.offsetWeeks;
        label = `${options.offsetWeeks}週前（週報ID: ${targetWrDateId}）`;
      } else if (options?.targetDate) {
        const parsedTime = new Date(options.targetDate).getTime();
        if (!isNaN(parsedTime)) {
          const diffDays = Math.round(
            (Date.now() - parsedTime) / (1000 * 60 * 60 * 24)
          );
          const offsetWeeks = Math.max(0, Math.round(diffDays / 7));
          targetWrDateId = newestId - offsetWeeks;
          label = `${options.targetDate}頃（${offsetWeeks}週前 / 週報ID: ${targetWrDateId}）`;
        }
      }

      const submittedStaff = extractSubmittedStaffRecords(
        session.pageHtml,
        targetWrDateId
      );
      const reportDetails = await this.fetchSubmittedReportDetails(
        session.cookieStr,
        submittedStaff
      );

      // Filter reports with actual content for past weeks
      const filteredReports =
        targetWrDateId !== undefined
          ? reportDetails.filter(
              (r) => r.impression.trim() !== '' || r.projects.length > 0
            )
          : reportDetails;

      summaryText = await this.geminiService.generateWeeklyReportsSummary(
        filteredReports,
        label
      );

      if (client && targetUser) {
        await client.chat.postMessage({
          channel: targetUser,
          text: summaryText,
        });
      }
    }

    // Also fetch GroupSession schedule and deliver to targetUser DM
    let scheduleText: string | undefined;
    try {
      const scheduleDays = await this.fetchGSessionMySchedule();
      if (scheduleDays && scheduleDays.length > 0) {
        scheduleText = formatGSessionScheduleMessage(scheduleDays);
        if (client && targetUser) {
          await client.chat.postMessage({
            channel: targetUser,
            text: scheduleText,
          });
        }
      }
    } catch (e) {
      console.warn('Failed to fetch schedule in runWeeklySummary:', e);
    }

    return {
      success: true,
      message: '週報要約および週間スケジュールをマネージャーのDMに送信しました。',
      summaryText,
      scheduleText,
    };
  }

  /**
   * Fetches and sends 1-week GroupSession schedule on demand.
   */
  async runMySchedule(
    client?: any,
    requestingUserId?: string
  ): Promise<{ success: boolean; message: string; scheduleText: string }> {
    const targetUser = requestingUserId || this.getManagerSlackId();
    const scheduleDays = await this.fetchGSessionMySchedule();
    const scheduleText = formatGSessionScheduleMessage(scheduleDays);

    if (client && targetUser) {
      await client.chat.postMessage({
        channel: targetUser,
        text: scheduleText,
      });
    }

    return {
      success: true,
      message: '週間スケジュールを取得しました。',
      scheduleText,
    };
  }
}

function isNameMatchInHtml(name: string, html: string): boolean {
  return html.includes(name) || html.includes(name.replace(/\s+/g, ''));
}

/**
 * Parses WeeklyReport top page HTML and computes submission status for Onuma team.
 */
export function parseWeeklyReportTopHtml(
  html: string
): WeeklyReportCheckResult {
  let weekLabel = '先週分';
  const deadlineMatch = html.match(
    /([\d\/]+\s*[\d:]+)\s*<\/label>\s*<label[^>]*>締切りの週報<\/label>[\s\S]*?対象期間[：:]\s*<\/label>\s*<label>\s*([\d\/]+)\s*<\/label>\s*<label>\s*[～~]\s*<\/label>\s*<label>\s*([\d\/]+)/i
  );
  if (deadlineMatch) {
    weekLabel = `${deadlineMatch[1].trim()} 締切 (${deadlineMatch[2].trim()}〜${deadlineMatch[3].trim()})`;
  }

  const startIdx = html.indexOf('var filingData = ');
  if (startIdx === -1) {
    const currentMembers = getTeamMembers().map((m) => m.name);
    const submitted: string[] = [];
    const unsubmitted: string[] = [];
    for (const member of currentMembers) {
      if (isNameMatchInHtml(member, html)) {
        submitted.push(member);
      } else {
        unsubmitted.push(member);
      }
    }
    return {
      weekLabel,
      submitted,
      unsubmitted,
      totalMembers: currentMembers.length,
    };
  }

  const endIdx = html.indexOf(';\n', startIdx);
  const jsonStr = html
    .substring(
      startIdx + 'var filingData = '.length,
      endIdx !== -1 ? endIdx : undefined
    )
    .trim()
    .replace(/;\s*$/, '');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let filingData: any[] = [];
  try {
    const fn = new Function('return ' + jsonStr);
    filingData = fn();
  } catch (e) {
    console.warn('Failed to parse filingData from HTML:', e);
  }

  const submitted: string[] = [];
  const unsubmitted: string[] = [];
  const configuredMembers = getTeamMembers().map((m) => m.name);
  const currentMembers =
    configuredMembers.length > 0
      ? configuredMembers
      : filingData
          .filter((f: any) => f.staffName)
          .map((f: any) => String(f.staffName));

  for (const member of currentMembers) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = filingData.find(
      (f: any) => f.staffName && isNameMatch(f.staffName, member)
    );

    if (!record) {
      unsubmitted.push(member);
      continue;
    }

    let unsubCount = 0;
    if (Array.isArray(record.unsubmittedCount)) {
      for (const item of record.unsubmittedCount) {
        if (item[0] === record.staffId) {
          unsubCount = item[1];
          break;
        }
      }
    }

    // 一覧画面において「提出日時」が無い（nullまたは空文字）ユーザーが今週の未提出者
    if (!record.filingDatetime || String(record.filingDatetime).trim() === '') {
      unsubmitted.push(member);
    } else {
      submitted.push(member);
    }
  }

  return {
    weekLabel,
    submitted,
    unsubmitted,
    totalMembers: currentMembers.length,
  };
}

/**
 * Extracts the newest wrTargetDateId from top page HTML.
 */
export function extractNewestWrTargetDateId(html: string): number | null {
  const match =
    html.match(/"newestId"\s*:\s*(\d+)/i) ||
    html.match(/newestWrTargetDateId\s*:\s*(\d+)/i) ||
    html.match(/"newestWrTargetDateId"\s*:\s*(\d+)/i) ||
    html.match(/wrTargetDateId\s*=\s*(\d+)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Extracts submitted staff records (staffId, staffName, wrTargetDateId) from WeeklyReport top page HTML.
 * If targetWrDateId is specified, fetches for that historical week ID.
 */
export function extractSubmittedStaffRecords(
  html: string,
  targetWrDateId?: number
): Array<{ staffId: number; staffName: string; wrTargetDateId: number }> {
  const startIdx = html.indexOf('var filingData = ');
  if (startIdx === -1) return [];

  const endIdx = html.indexOf(';\n', startIdx);
  const jsonStr = html
    .substring(
      startIdx + 'var filingData = '.length,
      endIdx !== -1 ? endIdx : undefined
    )
    .trim()
    .replace(/;\s*$/, '');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let filingData: any[] = [];
  try {
    const fn = new Function('return ' + jsonStr);
    filingData = fn();
  } catch (e) {
    console.warn('Failed to parse filingData for submitted staff records:', e);
    return [];
  }

  const results: Array<{
    staffId: number;
    staffName: string;
    wrTargetDateId: number;
  }> = [];

  const configuredMembers = getTeamMembers().map((m) => m.name);
  const members =
    configuredMembers.length > 0
      ? configuredMembers
      : filingData
          .filter((f: any) => f.staffName)
          .map((f: any) => String(f.staffName));

  for (const member of members) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = filingData.find(
      (f: any) => f.staffName && isNameMatch(f.staffName, member)
    );

    if (!record || !record.staffId) continue;

    if (targetWrDateId !== undefined) {
      results.push({
        staffId: Number(record.staffId),
        staffName: member,
        wrTargetDateId: Number(targetWrDateId),
      });
    } else if (
      record.filingDatetime &&
      String(record.filingDatetime).trim() !== ''
    ) {
      const targetDateId =
        record.newestWrTargetDateId || record.latestWrTargetDateId;
      if (targetDateId) {
        results.push({
          staffId: Number(record.staffId),
          staffName: member,
          wrTargetDateId: Number(targetDateId),
        });
      }
    }
  }

  return results;
}

/**
 * Parses GroupSession man050.do HTML and computes active/inactive status for Onuma team.
 */
export function parseGSessionMan050Html(
  html: string,
  now: Date = new Date(),
  thresholdDays: number = 7
): {
  inactiveMembers: GSessionLoginStatus[];
  activeMembers: GSessionLoginStatus[];
} {
  const inactiveMembers: GSessionLoginStatus[] = [];
  const activeMembers: GSessionLoginStatus[] = [];

  const rowRegex =
    /<tr[^>]*>[\s\S]*?<td[^>]*>\s*(\d{4,8})\s*<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s*<\/td>[\s\S]*?<\/tr>/gi;

  const foundMembers = new Map<
    string,
    { lastLoginDate: string; daysSince: number }
  >();

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const rawName = match[2].replace(/<[^>]+>/g, '').trim();
    const loginDateStr = match[4].trim();

    const [datePart, timePart] = loginDateStr.split(/\s+/);
    if (datePart && timePart) {
      const [y, m, d] = datePart.split('/').map(Number);
      const [hh, mm, ss] = timePart.split(':').map(Number);
      const loginDate = new Date(y, m - 1, d, hh, mm, ss);

      const diffMs = now.getTime() - loginDate.getTime();
      const daysSince = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

      foundMembers.set(rawName, {
        lastLoginDate: loginDateStr,
        daysSince,
      });
    }
  }

  const configuredMembers = getTeamMembers().map((m) => m.name);
  const currentMembers =
    configuredMembers.length > 0
      ? configuredMembers
      : Array.from(foundMembers.keys());

  for (const member of currentMembers) {
    let matched: { lastLoginDate: string; daysSince: number } | undefined;
    for (const [foundName, data] of foundMembers.entries()) {
      if (isNameMatch(foundName, member)) {
        matched = data;
        break;
      }
    }

    if (matched) {
      const isInactive = matched.daysSince >= thresholdDays;
      const status: GSessionLoginStatus = {
        name: member,
        lastLoginDate: matched.lastLoginDate,
        daysSinceLastLogin: matched.daysSince,
        isInactive,
      };
      if (isInactive) {
        inactiveMembers.push(status);
      } else {
        activeMembers.push(status);
      }
    } else {
      activeMembers.push({
        name: member,
        isInactive: false,
        daysSinceLastLogin: 1,
      });
    }
  }

  return { inactiveMembers, activeMembers };
}

/**
 * Parses GroupSession schmain.do dashboard HTML to extract 1-week schedule for logged-in user.
 */
export function parseGSessionSchmainHtml(html: string): GSessionScheduleDay[] {
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[] = [];
  let m;
  while ((m = trRegex.exec(html)) !== null) {
    rows.push(m[1]);
  }

  // Find date header row (row with 7 <th>)
  const headerRow = rows.find((r) => (r.match(/<th\b/gi) || []).length === 7);
  if (!headerRow) {
    return [];
  }

  const thCells = [...headerRow.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(
    (x) => x[1]
  );
  const days: GSessionScheduleDay[] = [];

  thCells.forEach((c) => {
    const dateMatch = c.match(/moveDailyScheduleFromMain\('day',\s*(\d{8})\)/);
    const dateStr = dateMatch ? dateMatch[1] : '';
    const tooltipMatch = c.match(/<span class="tooltips">([^<]+)<\/span>/i);
    const rawLabel = tooltipMatch ? tooltipMatch[1].trim() : '';

    let formattedDate = rawLabel;
    if (dateStr && dateStr.length === 8) {
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      const weekdayMatch = rawLabel.match(/\(([^)]+)\)/);
      const weekday = weekdayMatch ? `(${weekdayMatch[1]})` : '';
      formattedDate = `${month}/${day}${weekday}`;
    }

    days.push({
      dateStr,
      formattedDate,
      holiday: undefined,
      events: [],
    });
  });

  // Extract all rows after headerRow
  const headerIdx = rows.indexOf(headerRow);
  const dataRows = rows.slice(headerIdx + 1);

  dataRows.forEach((row) => {
    // 1. Check for holidays in <td> cells (e.g. <font color="#ff0000">敬老の日</font>)
    const tdCells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (x) => x[1]
    );
    if (tdCells.length === 7) {
      tdCells.forEach((cell, colIdx) => {
        const holMatch = cell.match(
          /<font[^>]*color="#ff0000">([^<]+)<\/font>/i
        );
        if (holMatch && days[colIdx]) {
          days[colIdx].holiday = holMatch[1].trim();
        }
      });
    }

    // 2. Check for schedule events: editSchedule('schw_edit', date, id, usrSid, ...)
    const eventRegex =
      /editSchedule\('schw_edit',\s*(\d{8}),\s*(\d+),\s*(\d+),\s*\d+\);([\s\S]*?)<\/a>/gi;
    let em;
    while ((em = eventRegex.exec(row)) !== null) {
      const dateStr = em[1];
      const schId = em[2];
      const innerHtml = em[4];

      const tooltipMatch = innerHtml.match(
        /<span class="tooltips">([\s\S]*?)<\/span>/i
      );
      const title = (tooltipMatch ? tooltipMatch[1] : innerHtml)
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const targetDay = days.find((d) => d.dateStr === dateStr);
      if (targetDay && title) {
        if (!targetDay.events.some((e) => e.id === schId)) {
          targetDay.events.push({ id: schId, title });
        }
      }
    }
  });

  return days;
}

/**
 * Formats GSessionScheduleDay array into a clean Slack notification text.
 */
export function formatGSessionScheduleMessage(
  days: GSessionScheduleDay[]
): string {
  if (!days || days.length === 0) {
    return '🗓️ *【GroupSession】1週間のスケジュール*\nスケジュール情報を取得できませんでした。';
  }

  const startDay = days[0].formattedDate;
  const endDay = days[days.length - 1].formattedDate;

  const list = days
    .map((d) => {
      let content = '';
      if (d.events.length > 0) {
        const eventTitles = d.events
          .map((e) => {
            if (
              e.title.includes('夏休み') ||
              e.title.includes('休暇') ||
              e.title.includes('有給')
            ) {
              return `🏖️ *${e.title}*`;
            }
            return `📌 *${e.title}*`;
          })
          .join('、');

        if (d.holiday) {
          content = `🇯🇵 _${d.holiday}_ / ${eventTitles}`;
        } else {
          content = eventTitles;
        }
      } else if (d.holiday) {
        content = `🇯🇵 _${d.holiday}_ (予定なし)`;
      } else {
        content = '_予定なし_';
      }

      return `  ・*${d.formattedDate}*: ${content}`;
    })
    .join('\n');

  return (
    `🗓️ *【GroupSession】1週間のスケジュール* (${startDay}〜${endDay})\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${list}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🔗 <https://po-tal.poweredge.co.jp/gsession/schedule/sch010.do|GroupSessionスケジュールを開く>`
  );
}

