import {
  WeeklyCheckService,
  parseWeeklyReportTopHtml,
  parseGSessionMan050Html,
  extractSubmittedStaffRecords,
  parseGSessionSchmainHtml,
  formatGSessionScheduleMessage,
} from '../src/weekly/service';
import {
  WeeklyCheckSummary,
  WeeklyReportContent,
  GSessionScheduleDay,
} from '../src/types';
import { GeminiService } from '../src/ai/gemini';

describe('WeeklyCheckService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MANAGER_SLACK_USER_ID: 'U_MGR_000',
      TEAM_MEMBERS_CONFIG: JSON.stringify([
        { name: '山田 太郎', slackId: 'U_YAMADA_001', role: 'member' },
        { name: '佐藤 花子', slackId: 'U_SATO_002', role: 'member' },
        { name: '鈴木 一郎', slackId: 'U_SUZUKI_003', role: 'member' },
      ]),
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('formats Slack mentions correctly using mapping', () => {
    const service = new WeeklyCheckService();
    expect(service.getManagerMention()).toBe('<@U_MGR_000>');
    expect(service.getSlackMention('山田 太郎')).toBe('<@U_YAMADA_001>');
    expect(service.getSlackMention('佐藤　花子')).toBe('<@U_SATO_002>');
    expect(service.getSlackMention('鈴木 一郎')).toBe('<@U_SUZUKI_003>');
    expect(service.getSlackMention('外部 ゲスト')).toBe('外部 ゲストさん');
  });

  it('mentions manager and flagged members when either condition matches', () => {
    const service = new WeeklyCheckService();

    const summary: WeeklyCheckSummary = {
      checkedAt: new Date(2026, 8, 15),
      weeklyReport: {
        weekLabel: '先週分',
        submitted: ['山田 太郎'],
        unsubmitted: ['佐藤 花子'],
        totalMembers: 2,
      },
      gSession: {
        inactiveMembers: [
          {
            name: '鈴木 一郎',
            daysSinceLastLogin: 8,
            lastLoginDate: '9/7',
            isInactive: true,
          },
        ],
        activeMembers: [
          {
            name: '山田 太郎',
            daysSinceLastLogin: 1,
            isInactive: false,
          },
        ],
      },
    };

    const message = service.generateSummaryMessage(summary);

    // Check that alert header mentions both the manager and both flagged members
    expect(message).toContain('【要確認】');
    expect(message).toContain('<@U_MGR_000>');
    expect(message).toContain('<@U_SATO_002>');
    expect(message).toContain('<@U_SUZUKI_003>');

    // Check sections
    expect(message).toContain('1. 週報提出状況');
    expect(message).toContain('2. GroupSession ログイン状況');
  });

  it('shows completion message without alert when no members are flagged', () => {
    const service = new WeeklyCheckService();

    const summary: WeeklyCheckSummary = {
      checkedAt: new Date(2026, 8, 15),
      weeklyReport: {
        weekLabel: '先週分',
        submitted: ['山田 太郎', '佐藤 花子'],
        unsubmitted: [],
        totalMembers: 2,
      },
      gSession: {
        inactiveMembers: [],
        activeMembers: [
          { name: '山田 太郎', daysSinceLastLogin: 1, isInactive: false },
          { name: '佐藤 花子', daysSinceLastLogin: 2, isInactive: false },
        ],
      },
    };

    const message = service.generateSummaryMessage(summary);

    expect(message).toContain('【定期チェック完了】チーム全員が週報提出済み＆GSログイン確認済みです！');
    expect(message).not.toContain('【要確認】');
  });

  it('accurately parses real WeeklyReport top page HTML with filingData and unsubmittedCount', () => {
    const mockTopHtml = `
      <html>
      <head>
        <script>
        09/15 23:59:00 </label><label for="reportingDate">締切りの週報</label>
        <div><label>(対象期間：</label><label>09/06</label><label> ～</label><label>09/12</label></div>
        var filingData = [
          { staffId: 101, staffName: '山田　太郎', staffNum: '000101', filingDatetime: '2026-09-15 20:47:01', unsubmittedCount: [] },
          { staffId: 102, staffName: '佐藤　花子', staffNum: '000102', filingDatetime: '', unsubmittedCount: [[102, 2]] },
          { staffId: 103, staffName: '鈴木　一郎', staffNum: '000103', filingDatetime: null, unsubmittedCount: [] }
        ];
        </script>
      </head>
      </html>
    `;

    const result = parseWeeklyReportTopHtml(mockTopHtml);

    expect(result.weekLabel).toContain('09/15 23:59:00 締切');
    expect(result.submitted).toContain('山田 太郎');
    expect(result.unsubmitted).toContain('佐藤 花子');
    expect(result.unsubmitted).toContain('鈴木 一郎');
  });

  it('accurately parses GroupSession man050.do HTML and identifies inactive members (>= 7 days)', () => {
    const mockMan050Html = `
      <table class="tl0 lastlogintd2" width="100%" border="0" cellspacing="0" cellpadding="3">
        <tbody>
          <tr><th>社員/職員番号</th><th>氏名</th><th>役職</th><th>最終ログイン時間</th></tr>
          <tr class="lastlogin_tdBgColor6">
            <td align="left" nowrap>000102</td>
            <td align="left" nowrap><a href="#">佐藤　花子</a></td>
            <td align="left" nowrap></td>
            <td align="center" nowrap>2026/09/09 21:12:26</td>
          </tr>
          <tr class="lastlogin_tdBgColor6">
            <td align="left" nowrap>000103</td>
            <td align="left" nowrap><a href="#">鈴木　一郎</a></td>
            <td align="left" nowrap></td>
            <td align="center" nowrap>2026/09/11 21:06:22</td>
          </tr>
          <tr class="lastlogin_tdBgColor1">
            <td align="left" nowrap>000101</td>
            <td align="left" nowrap><a href="#">山田　太郎</a></td>
            <td align="left" nowrap></td>
            <td align="center" nowrap>2026/09/17 08:52:21</td>
          </tr>
        </tbody>
      </table>
    `;

    const fixedNow = new Date('2026-09-17T21:25:00');
    const result = parseGSessionMan050Html(mockMan050Html, fixedNow, 7);

    // 佐藤 is 8 days ago (2026/09/09) -> inactive >= 7 days
    const sato = result.inactiveMembers.find((m) => m.name.includes('佐藤'));
    expect(sato).toBeDefined();
    expect(sato?.isInactive).toBe(true);
    expect(sato?.daysSinceLastLogin).toBe(8);

    // 鈴木 is 6 days ago (2026/09/11) -> active (< 7 days)
    const suzuki = result.activeMembers.find((m) => m.name.includes('鈴木'));
    expect(suzuki).toBeDefined();
    expect(suzuki?.isInactive).toBe(false);

    // 山田 is today (2026/09/17) -> active
    const yamada = result.activeMembers.find((m) => m.name.includes('山田'));
    expect(yamada).toBeDefined();
    expect(yamada?.isInactive).toBe(false);
  });

  it('extracts submitted staff records with staffId and targetDateId from filingData', () => {
    const mockTopHtml = `
      var filingData = [
        { staffId: 101, staffName: '山田　太郎', filingDatetime: '2026-09-15 20:47:01', newestWrTargetDateId: 734 },
        { staffId: 102, staffName: '佐藤　花子', filingDatetime: '2026-09-15 18:20:51', latestWrTargetDateId: 735 },
        { staffId: 103, staffName: '鈴木　一郎', filingDatetime: null, newestWrTargetDateId: 734 }
      ];
    `;

    const records = extractSubmittedStaffRecords(mockTopHtml);
    expect(records.length).toBe(2);

    const yamada = records.find((r) => r.staffName === '山田 太郎');
    expect(yamada).toBeDefined();
    expect(yamada?.staffId).toBe(101);
    expect(yamada?.wrTargetDateId).toBe(734);

    const sato = records.find((r) => r.staffName === '佐藤 花子');
    expect(sato).toBeDefined();
    expect(sato?.staffId).toBe(102);
    expect(sato?.wrTargetDateId).toBe(735);
  });

  it('sends private manager summary strictly to manager Slack ID (DM)', async () => {
    const mockPostMessage = jest.fn().mockResolvedValue({ ok: true });
    const mockClient = {
      chat: {
        postMessage: mockPostMessage,
      },
    };

    const mockGemini = new GeminiService('test-api-key');
    jest.spyOn(mockGemini, 'generateWeeklyReportsSummary').mockResolvedValue(
      '🔒 *【マネージャー専用・非公開】週報AI要約レポート*\nテスト要約内容'
    );

    const service = new WeeklyCheckService(mockGemini);
    const mockReports: WeeklyReportContent[] = [
      {
        staffId: 101,
        staffName: '山田　太郎',
        impression: '順調に進捗しています。',
        weekUptime: 40,
        projects: [
          { properName: 'テスト案件', endUser: 'テスト顧客', prjDetail: '開発業務' },
        ],
      },
    ];

    const result = await service.sendManagerPrivateSummary(
      mockClient,
      '先週分',
      mockReports
    );

    expect(result.success).toBe(true);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    // Crucial check: channel must be the manager's Slack ID ('U_MGR_000'), NOT a public channel!
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'U_MGR_000',
      text: expect.stringContaining('【マネージャー専用・非公開】週報AI要約レポート'),
    });
  });

  it('accurately parses GroupSession schmain.do HTML extracting 7-day schedule, holidays, and events', () => {
    const mockSchmainHtml = `
      <table>
        <tr>
          <th><a onclick="moveDailyScheduleFromMain('day', 20260918)"><span class="tooltips">18日(金)</span>18日(金)</a></th>
          <th><a onclick="moveDailyScheduleFromMain('day', 20260919)"><span class="tooltips">19日(土)</span>19日(土)</a></th>
          <th><a onclick="moveDailyScheduleFromMain('day', 20260920)"><span class="tooltips">20日(日)</span>20日(日)</a></th>
          <th><a onclick="moveDailyScheduleFromMain('day', 20260921)"><span class="tooltips">21日(月)</span>21日(月)</a></th>
          <th><a onclick="moveDailyScheduleFromMain('day', 20260922)"><span class="tooltips">22日(火)</span>22日(火)</a></th>
          <th><a onclick="moveDailyScheduleFromMain('day', 20260923)"><span class="tooltips">23日(水)</span>23日(水)</a></th>
          <th><a onclick="moveDailyScheduleFromMain('day', 20260924)"><span class="tooltips">24日(木)</span>24日(木)</a></th>
        </tr>
        <tr>
          <td></td><td></td><td></td>
          <td><font color="#ff0000">敬老の日</font></td>
          <td><font color="#ff0000">国民の休日</font></td>
          <td><font color="#ff0000">秋分の日</font></td>
          <td></td>
        </tr>
        <tr>
          <td>
            <a onclick="editSchedule('schw_edit', 20260918, 501, 48, 0);">
              <span class="tooltips">プロジェクト定例</span>プロジェクト定例
            </a>
          </td>
          <td></td><td></td><td></td><td></td><td></td>
          <td>
            <a onclick="editSchedule('schw_edit', 20260924, 502, 48, 0);">
              <span class="tooltips">夏休み</span>夏休み
            </a>
          </td>
        </tr>
      </table>
    `;

    const days = parseGSessionSchmainHtml(mockSchmainHtml);
    expect(days).toHaveLength(7);

    // Day 1: 09/18(金)
    expect(days[0].formattedDate).toBe('09/18(金)');
    expect(days[0].events).toHaveLength(1);
    expect(days[0].events[0].title).toBe('プロジェクト定例');

    // Day 4: 09/21(月)
    expect(days[3].formattedDate).toBe('09/21(月)');
    expect(days[3].holiday).toBe('敬老の日');
    expect(days[3].events).toHaveLength(0);

    // Day 7: 09/24(木)
    expect(days[6].formattedDate).toBe('09/24(木)');
    expect(days[6].events).toHaveLength(1);
    expect(days[6].events[0].title).toBe('夏休み');
  });

  it('formats GroupSession schedule into clean Slack text with emojis', () => {
    const mockDays: GSessionScheduleDay[] = [
      {
        dateStr: '20260918',
        formattedDate: '09/18(金)',
        events: [{ id: '1', title: 'チーム定例' }],
      },
      {
        dateStr: '20260921',
        formattedDate: '09/21(月)',
        holiday: '敬老の日',
        events: [],
      },
      {
        dateStr: '20260924',
        formattedDate: '09/24(木)',
        events: [{ id: '2', title: '夏休み' }],
      },
    ];

    const message = formatGSessionScheduleMessage(mockDays);

    expect(message).toContain('🗓️ *【GroupSession】1週間のスケジュール* (09/18(金)〜09/24(木))');
    expect(message).toContain('📌 *チーム定例*');
    expect(message).toContain('🇯🇵 _敬老の日_ (予定なし)');
    expect(message).toContain('🏖️ *夏休み*');
    expect(message).toContain('🔗 <https://po-tal.poweredge.co.jp/gsession/schedule/sch010.do|GroupSessionスケジュールを開く>');
  });

  it('handles empty schedule gracefully in formatGSessionScheduleMessage', () => {
    const emptyMsg = formatGSessionScheduleMessage([]);
    expect(emptyMsg).toContain('スケジュール情報を取得できませんでした');
  });

  it('delivers 1-week schedule to manager DM during runWeeklyCheck', async () => {
    const mockPostMessage = jest.fn().mockResolvedValue({ ok: true });
    const mockClient = {
      chat: {
        postMessage: mockPostMessage,
      },
    };

    const service = new WeeklyCheckService();
    // Spy on internal methods to avoid external network calls
    jest.spyOn(service, 'checkWeeklyReports').mockResolvedValue({
      weekLabel: '先週分',
      submitted: ['メンバーA'],
      unsubmitted: [],
      totalMembers: 1,
    });
    jest.spyOn(service, 'checkGSessionLogins').mockResolvedValue({
      inactiveMembers: [],
      activeMembers: [{ name: 'メンバーA', daysSinceLastLogin: 1, isInactive: false }],
    });
    jest.spyOn(service, 'fetchWeeklyReportTop').mockResolvedValue(null);
    jest.spyOn(service, 'fetchGSessionMySchedule').mockResolvedValue([
      {
        dateStr: '20260918',
        formattedDate: '09/18(金)',
        events: [{ id: '10', title: 'リリース作業' }],
      },
    ]);

    const result = await service.runWeeklyCheck(mockClient, 'C_PUBLIC_CHANNEL');
    expect(result.success).toBe(true);

    // Check that public message was posted to channel
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_PUBLIC_CHANNEL',
      })
    );

    // Check that schedule was posted strictly to manager DM ('U_MGR_000')
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'U_MGR_000',
        text: expect.stringContaining('【GroupSession】1週間のスケジュール'),
      })
    );
  });
});
