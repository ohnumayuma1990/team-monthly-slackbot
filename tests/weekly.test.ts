import { WeeklyCheckService, parseWeeklyReportTopHtml } from '../src/weekly/service';
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
    expect(service.getSlackMention('小川 智矢')).toBe('小川 智矢さん');
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
});
