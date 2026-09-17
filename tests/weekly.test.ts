import {
  WeeklyCheckService,
  parseWeeklyReportTopHtml,
  parseGSessionMan050Html,
} from '../src/weekly/service';
import { WeeklyCheckSummary } from '../src/types';

describe('WeeklyCheckService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MANAGER_SLACK_USER_ID: 'U_ONUMA_123',
      MEMBER_SLACK_MAPPING: JSON.stringify({
        '川上 慶太': 'U_KAWAKAMI_456',
        '長谷川 明莉': 'U_HASEGAWA_789',
      }),
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('formats Slack mentions correctly using mapping', () => {
    const service = new WeeklyCheckService();
    expect(service.getManagerMention()).toBe('<@U_ONUMA_123>');
    expect(service.getSlackMention('川上 慶太')).toBe('<@U_KAWAKAMI_456>');
    expect(service.getSlackMention('長谷川　明莉')).toBe('<@U_HASEGAWA_789>');
    expect(service.getSlackMention('小川 智矢')).toBe('<@U0AQRJZK004>');
    expect(service.getSlackMention('外部 ゲスト')).toBe('外部 ゲストさん');
  });

  it('mentions manager and flagged members when either condition matches', () => {
    const service = new WeeklyCheckService();

    const summary: WeeklyCheckSummary = {
      checkedAt: new Date(2026, 8, 15),
      weeklyReport: {
        weekLabel: '先週分',
        submitted: ['小川 智矢'],
        unsubmitted: ['川上 慶太'],
        totalMembers: 2,
      },
      gSession: {
        inactiveMembers: [
          {
            name: '長谷川 明莉',
            daysSinceLastLogin: 8,
            lastLoginDate: '9/7',
            isInactive: true,
          },
        ],
        activeMembers: [
          {
            name: '小川 智矢',
            daysSinceLastLogin: 1,
            isInactive: false,
          },
        ],
      },
    };

    const message = service.generateSummaryMessage(summary);

    // Check that alert header mentions both the manager and both flagged members
    expect(message).toContain('【要確認】');
    expect(message).toContain('<@U_ONUMA_123>');
    expect(message).toContain('<@U_KAWAKAMI_456>');
    expect(message).toContain('<@U_HASEGAWA_789>');

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
        submitted: ['小川 智矢', '川上 慶太'],
        unsubmitted: [],
        totalMembers: 2,
      },
      gSession: {
        inactiveMembers: [],
        activeMembers: [
          { name: '小川 智矢', daysSinceLastLogin: 1, isInactive: false },
          { name: '川上 慶太', daysSinceLastLogin: 2, isInactive: false },
        ],
      },
    };

    const message = service.generateSummaryMessage(summary);

    expect(message).toContain('【定期チェック完了】大沼チーム全員が週報提出済み＆GSログイン確認済みです！');
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
          { staffId: 100, staffName: '大沼　佑麻', staffNum: '000100', filingDatetime: '2026-09-15 19:37:24', unsubmittedCount: [] },
          { staffId: 156, staffName: '小川　智矢', staffNum: '000156', filingDatetime: '2026-09-15 20:47:01', unsubmittedCount: [[156, 2]] },
          { staffId: 320, staffName: '朝岡　拓人', staffNum: '000320', filingDatetime: null, unsubmittedCount: [] },
          { staffId: 526, staffName: '川上　慶太', staffNum: '000526', filingDatetime: '', unsubmittedCount: [[526, 2]] }
        ];
        </script>
      </head>
      </html>
    `;

    const result = parseWeeklyReportTopHtml(mockTopHtml);

    expect(result.weekLabel).toContain('09/15 23:59:00 締切');
    expect(result.submitted).toContain('小川　智矢');
    expect(result.unsubmitted).toContain('朝岡　拓人');
    expect(result.unsubmitted).toContain('川上　慶太');
  });

  it('accurately parses GroupSession man050.do HTML and identifies inactive members (>= 7 days)', () => {
    const mockMan050Html = `
      <table class="tl0 lastlogintd2" width="100%" border="0" cellspacing="0" cellpadding="3">
        <tbody>
          <tr><th>社員/職員番号</th><th>氏名</th><th>役職</th><th>最終ログイン時間</th></tr>
          <tr class="lastlogin_tdBgColor6">
            <td align="left" nowrap>000526</td>
            <td align="left" nowrap><a href="#">川上　慶太</a></td>
            <td align="left" nowrap></td>
            <td align="center" nowrap>2026/09/09 21:12:26</td>
          </tr>
          <tr class="lastlogin_tdBgColor6">
            <td align="left" nowrap>000548</td>
            <td align="left" nowrap><a href="#">石割　朝比</a></td>
            <td align="left" nowrap></td>
            <td align="center" nowrap>2026/09/11 21:06:22</td>
          </tr>
          <tr class="lastlogin_tdBgColor1">
            <td align="left" nowrap>000156</td>
            <td align="left" nowrap><a href="#">小川　智矢</a></td>
            <td align="left" nowrap></td>
            <td align="center" nowrap>2026/09/17 08:52:21</td>
          </tr>
        </tbody>
      </table>
    `;

    const fixedNow = new Date('2026-09-17T21:25:00');
    const result = parseGSessionMan050Html(mockMan050Html, fixedNow, 7);

    // 川上 is 8 days ago (2026/09/09) -> inactive >= 7 days
    const kawakami = result.inactiveMembers.find((m) => m.name.includes('川上'));
    expect(kawakami).toBeDefined();
    expect(kawakami?.isInactive).toBe(true);
    expect(kawakami?.daysSinceLastLogin).toBe(8);

    // 石割 is 6 days ago (2026/09/11) -> active (< 7 days)
    const ishiwari = result.activeMembers.find((m) => m.name.includes('石割'));
    expect(ishiwari).toBeDefined();
    expect(ishiwari?.isInactive).toBe(false);

    // 小川 is today (2026/09/17) -> active
    const ogawa = result.activeMembers.find((m) => m.name.includes('小川'));
    expect(ogawa).toBeDefined();
    expect(ogawa?.isInactive).toBe(false);
  });
});
