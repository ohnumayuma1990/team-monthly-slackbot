import {
  getFiscalYear,
  getBusinessDaysOfMonth,
  determineAttendanceTarget,
  PydioAttendanceService,
} from '../src/pydio/service';
import { getTeamMembers } from '../src/config/members';
import { AttendanceCheckResult } from '../src/types';

describe('Pydio Attendance Check Service', () => {
  describe('Fiscal Year Calculation (getFiscalYear)', () => {
    test('April to December belong to current year', () => {
      expect(getFiscalYear(2026, 4)).toBe(2026);
      expect(getFiscalYear(2026, 8)).toBe(2026);
      expect(getFiscalYear(2026, 12)).toBe(2026);
    });

    test('January to March belong to previous year', () => {
      expect(getFiscalYear(2027, 1)).toBe(2026);
      expect(getFiscalYear(2027, 2)).toBe(2026);
      expect(getFiscalYear(2027, 3)).toBe(2026);
      expect(getFiscalYear(2026, 1)).toBe(2025);
    });
  });

  describe('Business Days Calculation (getBusinessDaysOfMonth)', () => {
    test('excludes Saturday and Sunday', () => {
      // September 2026: 30 days, starts on Tuesday
      const bDays = getBusinessDaysOfMonth(2026, 9);
      expect(bDays).toContain(1); // Tuesday
      expect(bDays).toContain(2); // Wednesday
      expect(bDays).not.toContain(5); // Saturday
      expect(bDays).not.toContain(6); // Sunday
      expect(bDays.length).toBe(22);
    });

    test('January excludes Jan 1-3', () => {
      const bDays = getBusinessDaysOfMonth(2026, 1);
      expect(bDays).not.toContain(1);
      expect(bDays).not.toContain(2);
      expect(bDays).not.toContain(3);
    });
  });

  describe('Attendance Target Folder Determination (determineAttendanceTarget)', () => {
    test('supports explicit override YYYYMM', () => {
      const target1 = determineAttendanceTarget(new Date(), '202608');
      expect(target1.targetMonth).toBe('202608');
      expect(target1.fiscalYear).toBe('2026年度');
      expect(target1.folderPath).toBe('/20.attendance/2026年度/202608');

      // Test Jan in fiscal year
      const target2 = determineAttendanceTarget(new Date(), '202701');
      expect(target2.targetMonth).toBe('202701');
      expect(target2.fiscalYear).toBe('2026年度');
      expect(target2.folderPath).toBe('/20.attendance/2026年度/202701');
    });

    test('月初2営業日 targets previous month', () => {
      // 2026-09-01 is Tuesday (first business day of September)
      const sep1 = new Date(2026, 8, 1);
      const target = determineAttendanceTarget(sep1);
      expect(target.isFirstTwoBusinessDays).toBe(true);
      expect(target.targetMonth).toBe('202608');
      expect(target.fiscalYear).toBe('2026年度');
      expect(target.folderPath).toBe('/20.attendance/2026年度/202608');
    });

    test('月末最終2営業日 targets current month', () => {
      // 2026-08-31 is Monday (last business day of August)
      const aug31 = new Date(2026, 7, 31);
      const target = determineAttendanceTarget(aug31);
      expect(target.isMonthEndBusinessDays).toBe(true);
      expect(target.targetMonth).toBe('202608');
      expect(target.fiscalYear).toBe('2026年度');
      expect(target.folderPath).toBe('/20.attendance/2026年度/202608');
    });

    test('mid-month before 20th targets previous month', () => {
      // 2026-09-10 is Thursday (after first 2 business days and before 20th)
      const sep10 = new Date(2026, 8, 10);
      const target = determineAttendanceTarget(sep10);
      expect(target.isFirstTwoBusinessDays).toBe(false);
      expect(target.isMonthEndBusinessDays).toBe(false);
      expect(target.targetMonth).toBe('202608');
    });

    test('late month after 20th targets current month', () => {
      // 2026-09-22
      const sep22 = new Date(2026, 8, 22);
      const target = determineAttendanceTarget(sep22);
      expect(target.targetMonth).toBe('202609');
    });
  });

  const MOCK_MEMBERS: Array<{
    name: string;
    staffNum: string;
    slackId: string;
    role: 'member' | 'manager';
  }> = [
    {
      name: '山田 太郎',
      staffNum: '000101',
      slackId: 'U000101',
      role: 'member',
    },
    {
      name: '佐藤 花子',
      staffNum: '000102',
      slackId: 'U000102',
      role: 'member',
    },
    {
      name: '鈴木 一郎',
      staffNum: '000103',
      slackId: 'U000103',
      role: 'member',
    },
  ];

  describe('Team Member Staff Numbers', () => {
    const originalEnv = process.env.TEAM_MEMBERS_CONFIG;

    beforeEach(() => {
      process.env.TEAM_MEMBERS_CONFIG = JSON.stringify(MOCK_MEMBERS);
    });

    afterEach(() => {
      process.env.TEAM_MEMBERS_CONFIG = originalEnv;
    });

    test('configured members have 6-digit staff numbers', () => {
      const members = getTeamMembers();
      expect(members).toHaveLength(3);
      for (const member of members) {
        expect(member.staffNum).toBeDefined();
        expect(member.staffNum).toMatch(/^\d{6}$/);
      }
    });
  });

  describe('Pydio XML Parsing (parsePydioXml)', () => {
    const service = new PydioAttendanceService();

    test('extracts file entries with attributes', () => {
      const mockXml = `
        <tree>
          <tree is_file="true" text="出勤簿000101_山田太郎.xls" filename="出勤簿000101_山田太郎.xls" bytesize="45056" ajxp_modiftime="1725164800"/>
          <tree is_file="true" text="出勤簿000102_佐藤花子.xlsm" filename="出勤簿000102_佐藤花子.xlsm" bytesize="78234" ajxp_modiftime="1725165800"/>
          <tree is_file="false" text="subfolder" filename="subfolder"/>
        </tree>
      `;

      const files = service.parsePydioXml(mockXml);
      expect(files).toHaveLength(3);
      expect(files[0].filename).toBe('出勤簿000101_山田太郎.xls');
      expect(files[0].bytesize).toBe('45056');
      expect(files[0].modifTime).toBe('1725164800');
      expect(files[1].filename).toBe('出勤簿000102_佐藤花子.xlsm');
    });
  });

  describe('Slack Message Formatting (formatSlackMessage)', () => {
    const service = new PydioAttendanceService();
    const members = MOCK_MEMBERS;

    test('formats all-submitted congratulatory message', () => {
      const mockResult: AttendanceCheckResult = {
        targetFolder: '/20.attendance/2026年度/202608',
        targetMonth: '202608',
        fiscalYear: '2026年度',
        isFirstTwoBusinessDays: false,
        isMonthEndBusinessDays: false,
        submitted: members.map((m) => ({
          member: m,
          submitted: true,
          filename: `出勤簿${m.staffNum}_${m.name.replace(/\s+/g, '')}.xls`,
        })),
        unsubmitted: [],
        totalMembers: members.length,
      };

      const msg = service.formatSlackMessage(mockResult, true);
      expect(msg).toContain('2026年08月度 勤怠出勤簿 提出状況');
      expect(msg).toContain('チームメンバー全員提出完了しています！');
      expect(msg).toContain(`提出済み (${members.length}/${members.length}名)`);
      expect(msg).not.toContain('未提出');
    });

    test('formats unsubmitted alert with Slack mentions and call to action', () => {
      const submittedMembers = members.slice(0, 1);
      const unsubmittedMembers = members.slice(1); // last 2 members

      const mockResult: AttendanceCheckResult = {
        targetFolder: '/20.attendance/2026年度/202609',
        targetMonth: '202609',
        fiscalYear: '2026年度',
        isFirstTwoBusinessDays: false,
        isMonthEndBusinessDays: false,
        submitted: submittedMembers.map((m) => ({
          member: m,
          submitted: true,
          filename: `出勤簿${m.staffNum}_${m.name.replace(/\s+/g, '')}.xls`,
        })),
        unsubmitted: unsubmittedMembers.map((m) => ({
          member: m,
          submitted: false,
        })),
        totalMembers: members.length,
      };

      const msg = service.formatSlackMessage(mockResult, true);
      expect(msg).toContain('2026年09月度 勤怠出勤簿 提出状況');
      expect(msg).toContain(`未提出 (2 / ${members.length}名)`);
      expect(msg).toContain(`<@${unsubmittedMembers[0].slackId}>`);
      expect(msg).toContain(`<@${unsubmittedMembers[1].slackId}>`);
      expect(msg).toContain('提出のお願い');
      expect(msg).toContain('Pydio共通フォルダ（上記パス）へ出勤簿Excel');
      expect(msg).toContain(`提出済み (1/${members.length}名)`);
    });
  });

  describe('End-to-End Attendance Check Flow (mocked fetch)', () => {
    const originalFetch = global.fetch;
    const originalEnv = process.env.TEAM_MEMBERS_CONFIG;

    beforeEach(() => {
      process.env.TEAM_MEMBERS_CONFIG = JSON.stringify(MOCK_MEMBERS);
    });

    afterEach(() => {
      global.fetch = originalFetch;
      process.env.TEAM_MEMBERS_CONFIG = originalEnv;
    });

    test('matches submitted files by staffNum and normalized name', async () => {
      const service = new PydioAttendanceService({
        baseUrl: 'https://test-pydio.example.com',
        username: 'test-user',
        password: 'test-password',
      });

      // Mock fetch responses
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      global.fetch = jest.fn(async (url: any, options: any) => {
        const urlStr = String(url);
        if (urlStr.includes('get_action=get_seed')) {
          return {
            headers: {
              get: (h: string) =>
                h === 'set-cookie' ? 'AjaXplorer=sess123; path=/' : null,
            },
          } as any;
        }
        if (urlStr.includes('index.php') && options?.method === 'POST') {
          return {
            text: async () =>
              '<logging_result value="1" secure_token="test_token_456"/>',
            headers: {
              get: (h: string) =>
                h === 'set-cookie' ? 'AjaXplorer=sess123_auth; path=/' : null,
            },
          } as any;
        }
        if (urlStr.includes('get_action=switch_repository')) {
          return { ok: true } as any;
        }
        if (urlStr.includes('get_action=ls')) {
          // Return XML with files for 2 out of 3 members (1 missing: 鈴木 一郎)
          const xmlFiles = [
            '<tree is_file="true" text="出勤簿000101_山田太郎.xls" bytesize="1000"/>',
            '<tree is_file="true" text="出勤簿000102_佐藤花子.xlsm" bytesize="1000"/>',
          ].join('\n');

          return {
            ok: true,
            text: async () => `<tree>${xmlFiles}</tree>`,
          } as any;
        }
        return { ok: false, status: 404 } as any;
      });

      const result = await service.checkAttendance('202608');
      expect(result.submitted).toHaveLength(2);
      expect(result.unsubmitted).toHaveLength(1);
      expect(result.unsubmitted[0].member.name).toBe('鈴木 一郎');

      // Test runAttendanceNotification
      const mockPostMessage = jest.fn().mockResolvedValue({ ok: true });
      const mockSlackClient = {
        chat: {
          postMessage: mockPostMessage,
        },
      };

      const notifyRes = await service.runAttendanceNotification(
        mockSlackClient,
        'C_TEST_CHANNEL',
        '202608'
      );
      expect(notifyRes.messageSent).toBe(true);
      expect(mockPostMessage).toHaveBeenCalledTimes(1);
      const postArg = mockPostMessage.mock.calls[0][0];
      expect(postArg.channel).toBe('C_TEST_CHANNEL');
      expect(postArg.text).toContain('未提出 (1 / 3名)');
      expect(postArg.text).toContain('鈴木 一郎');
    });
  });
});
