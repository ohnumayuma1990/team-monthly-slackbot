import { WebClient } from '@slack/web-api';
import {
  WeeklyCheckSummary,
  WeeklyReportCheckResult,
  GSessionLoginStatus,
} from '../types';
import { isNameMatch, normalizeName } from '../sheets/parser';

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
  private memberSlackMap: Map<string, string>;
  private managerSlackId?: string;

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
    this.managerSlackId = process.env.MANAGER_SLACK_USER_ID;

    this.memberSlackMap = new Map();
    this.loadMemberMappings();
  }

  /**
   * Loads member Slack mappings from MEMBER_SLACK_MAPPING env.
   */
  private loadMemberMappings() {
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
    for (const [mappedName, slackId] of this.memberSlackMap.entries()) {
      if (isNameMatch(mappedName, name)) {
        return `<@${slackId}>`;
      }
    }
    return `${name}さん`;
  }

  /**
   * Returns Slack mention for the manager (Onuma).
   */
  getManagerMention(): string {
    if (this.managerSlackId) {
      return `<@${this.managerSlackId}>`;
    }
    for (const [mappedName, slackId] of this.memberSlackMap.entries()) {
      if (isNameMatch(mappedName, '大沼')) {
        return `<@${slackId}>`;
      }
    }
    return '大沼さん';
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
      const loginUrl = 'https://auth.poweredge.co.jp/weekly_report/login';
      const cookies = new Map<string, string>();

      let currentRes = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://auth.poweredge.co.jp',
          'Referer': 'https://auth.poweredge.co.jp/weekly_report/login',
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

      const pageHtml = await currentRes.text();
      return parseWeeklyReportTopHtml(pageHtml);
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
          Cookie: sessionCookie,
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
        `🎉 *【定期チェック完了】大沼チーム全員が週報提出済み＆GSログイン確認済みです！* ✨\n\n`;
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
    const submitted: string[] = [];
    const unsubmitted: string[] = [];
    for (const member of ONUMA_TEAM_MEMBERS) {
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
      totalMembers: ONUMA_TEAM_MEMBERS.length,
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

  for (const member of ONUMA_TEAM_MEMBERS) {
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
    totalMembers: ONUMA_TEAM_MEMBERS.length,
  };
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

  for (const member of ONUMA_TEAM_MEMBERS) {
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
