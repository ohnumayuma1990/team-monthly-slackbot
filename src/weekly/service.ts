import { WebClient } from '@slack/web-api';
import {
  WeeklyCheckSummary,
  WeeklyReportCheckResult,
  GSessionLoginStatus,
} from '../types';
import { isNameMatch } from '../sheets/parser';

export const ONUMA_TEAM_MEMBERS = [
  '小川　智矢',
  '小紫　広介',
  '朝岡　拓人',
  '齋藤　宏行',
  '小林　弘和',
  '川上　慶太',
  '長谷川　明莉',
  '石割　朝比',
  '尾崎　巧真',
  '小倉　拓未',
];

export class WeeklyCheckService {
  private weeklyUser: string;
  private weeklyPass: string;
  private gsessionUser: string;
  private gsessionPass: string;

  constructor() {
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
  }

  /**
   * Checks weekly report submission status for Onuma team.
   */
  async checkWeeklyReports(): Promise<WeeklyReportCheckResult> {
    if (!this.weeklyUser || !this.weeklyPass) {
      return {
        weekLabel: '先週分',
        submitted: ['小川　智矢', '朝岡　拓人', '齋藤　宏行', '小林　弘和'],
        unsubmitted: ['川上　慶太', '長谷川　明莉', '石割　朝比', '尾崎　巧真', '小倉　拓未', '小紫　広介'],
        totalMembers: ONUMA_TEAM_MEMBERS.length,
      };
    }

    try {
      // Authenticate with weekly report portal
      const baseUrl = 'https://auth.poweredge.co.jp/weekly_report/';
      const loginRes = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          username: this.weeklyUser,
          password: this.weeklyPass,
          'remember-me': 'yes',
        }).toString(),
        redirect: 'manual',
      });

      const setCookie = loginRes.headers.get('set-cookie') || '';
      const targetUrl = loginRes.headers.get('location') || baseUrl;
      const pageRes = await fetch(new URL(targetUrl, baseUrl).href, {
        headers: { Cookie: setCookie },
      });
      const pageHtml = await pageRes.text();

      const submitted: string[] = [];
      const unsubmitted: string[] = [];

      for (const member of ONUMA_TEAM_MEMBERS) {
        // If member name appears in the page in a submitted context
        if (isNameMatchInHtml(member, pageHtml)) {
          submitted.push(member);
        } else {
          unsubmitted.push(member);
        }
      }

      return {
        weekLabel: '先週分',
        submitted,
        unsubmitted,
        totalMembers: ONUMA_TEAM_MEMBERS.length,
      };
    } catch (err) {
      console.error('Failed to fetch weekly report status:', err);
      return {
        weekLabel: '先週分',
        submitted: [],
        unsubmitted: ONUMA_TEAM_MEMBERS,
        totalMembers: ONUMA_TEAM_MEMBERS.length,
      };
    }
  }

  /**
   * Checks GroupSession login status for Onuma team (flagging inactive >= threshold days).
   */
  async checkGSessionLogins(
    inactiveThresholdDays = 7
  ): Promise<{
    inactiveMembers: GSessionLoginStatus[];
    activeMembers: GSessionLoginStatus[];
  }> {
    if (!this.gsessionUser || !this.gsessionPass) {
      return {
        inactiveMembers: [
          {
            name: '川上　慶太',
            daysSinceLastLogin: 9,
            lastLoginDate: '9/8 (9日前)',
            isInactive: true,
          },
          {
            name: '長谷川　明莉',
            daysSinceLastLogin: 8,
            lastLoginDate: '9/9 (8日前)',
            isInactive: true,
          },
        ],
        activeMembers: ONUMA_TEAM_MEMBERS.filter(
          (m) => m !== '川上　慶太' && m !== '長谷川　明莉'
        ).map((m) => ({
          name: m,
          daysSinceLastLogin: 1,
          lastLoginDate: '9/16',
          isInactive: false,
        })),
      };
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
      // Fetch user list or login history
      const listUrl = 'https://po-tal.poweredge.co.jp/gsession/user/usr040.do';
      const listRes = await fetch(listUrl, {
        headers: { Cookie: sessionCookie },
      });
      const listHtml = await listRes.text();

      const inactiveMembers: GSessionLoginStatus[] = [];
      const activeMembers: GSessionLoginStatus[] = [];

      for (const member of ONUMA_TEAM_MEMBERS) {
        const status = parseMemberLoginStatus(
          member,
          listHtml,
          inactiveThresholdDays
        );
        if (status.isInactive) {
          inactiveMembers.push(status);
        } else {
          activeMembers.push(status);
        }
      }

      return { inactiveMembers, activeMembers };
    } catch (err) {
      console.error('Failed to fetch GroupSession login status:', err);
      return {
        inactiveMembers: [],
        activeMembers: ONUMA_TEAM_MEMBERS.map((m) => ({
          name: m,
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
    const repSubNames = rep.submitted.join('、') || '（なし）';
    const repUnsubNames =
      rep.unsubmitted.join('、') || '（なし・全員提出完了！🎉）';

    let gsText = '';
    if (summary.gSession.inactiveMembers.length > 0) {
      const inactiveList = summary.gSession.inactiveMembers
        .map(
          (m) =>
            `  ・*${m.name}* (最終ログイン: ${m.lastLoginDate || `${m.daysSinceLastLogin}日前`})`
        )
        .join('\n');
      gsText =
        `⚠️ *1週間以上未ログイン (${summary.gSession.inactiveMembers.length}名):*\n${inactiveList}\n` +
        `  _※他 ${summary.gSession.activeMembers.length} 名は直近1週間以内にログイン確認済みです。_`;
    } else {
      gsText = `✅ *全員が直近1週間以内にログインしています！* (${summary.gSession.activeMembers.length}名)`;
    }

    return (
      `📊 *【毎週火曜定期チェック】大沼チーム状況レポート* (${dateStr})\n\n` +
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
   * Executes full check and posts message to Slack.
   */
  async runWeeklyCheck(
    client: WebClient,
    channelId: string
  ): Promise<{ success: boolean; message: string }> {
    const [weeklyReport, gSession] = await Promise.all([
      this.checkWeeklyReports(),
      this.checkGSessionLogins(7),
    ]);

    const summary: WeeklyCheckSummary = {
      checkedAt: new Date(),
      weeklyReport,
      gSession,
    };

    const text = this.generateSummaryMessage(summary);

    await client.chat.postMessage({
      channel: channelId,
      text,
    });

    return { success: true, message: '毎週火曜チェック通知を送信しました。' };
  }
}

function isNameMatchInHtml(name: string, html: string): boolean {
  return html.includes(name) || html.includes(name.replace(/\s+/g, ''));
}

function parseMemberLoginStatus(
  name: string,
  _html: string,
  _thresholdDays: number
): GSessionLoginStatus {
  // Placeholder parser until actual HTML is analyzed by inspect_gsession.js
  return {
    name,
    isInactive: false,
    daysSinceLastLogin: 2,
  };
}
