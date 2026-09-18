import {
  getTeamMembers,
  getAllMembers,
  getManagerConfig,
  findMemberByName,
  findMemberByEmail,
  getSlackMention,
  getManagerSlackId,
  DEFAULT_TEAM_MEMBERS,
} from '../src/config/members';
import {
  EmailProcessingService,
  parseCommaSeparatedList,
} from '../src/email/service';
import {
  extractNewestWrTargetDateId,
  extractSubmittedStaffRecords,
} from '../src/weekly/service';
import { GmailIncomingMessage } from '../src/types';

describe('Team Member Configuration (members.ts)', () => {
  const originalEnv = process.env.TEAM_MEMBERS_CONFIG;
  const originalManagerId = process.env.MANAGER_SLACK_USER_ID;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TEAM_MEMBERS_CONFIG = originalEnv;
    } else {
      delete process.env.TEAM_MEMBERS_CONFIG;
    }
    if (originalManagerId !== undefined) {
      process.env.MANAGER_SLACK_USER_ID = originalManagerId;
    } else {
      delete process.env.MANAGER_SLACK_USER_ID;
    }
  });

  test('returns default empty team members when env is unset', () => {
    delete process.env.TEAM_MEMBERS_CONFIG;
    const members = getTeamMembers();
    expect(members).toEqual(DEFAULT_TEAM_MEMBERS);
    expect(members).toHaveLength(0);
  });

  test('parses TEAM_MEMBERS_CONFIG JSON when provided', () => {
    const customConfig = [
      {
        name: '山田 太郎',
        slackId: 'U99999999',
        email: 'yamada@example.com',
        staffNum: '000101',
        role: 'member',
      },
      {
        name: '佐藤 花子',
        slackId: 'U88888888',
        email: 'sato@example.com',
        staffNum: '000102',
        role: 'member',
      },
      {
        name: '田中 統括',
        slackId: 'U77777777',
        email: 'tanaka@example.com',
        staffNum: '990001',
        role: 'manager',
      },
    ];
    process.env.TEAM_MEMBERS_CONFIG = JSON.stringify(customConfig);

    const members = getTeamMembers();
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.name)).toContain('山田 太郎');
    expect(members.map((m) => m.name)).toContain('佐藤 花子');
    // Manager is excluded from regular member list
    expect(members.map((m) => m.name)).not.toContain('田中 統括');

    const all = getAllMembers();
    expect(all).toHaveLength(3);

    const manager = getManagerConfig();
    expect(manager.name).toBe('田中 統括');
    expect(manager.slackId).toBe('U77777777');
  });

  test('findMemberByName handles various spacing', () => {
    const customConfig = [
      { name: '山田 太郎', slackId: 'U99999999', role: 'member' },
    ];
    process.env.TEAM_MEMBERS_CONFIG = JSON.stringify(customConfig);

    expect(findMemberByName('山田 太郎')?.slackId).toBe('U99999999');
    expect(findMemberByName('山田　太郎')?.slackId).toBe('U99999999');
    expect(findMemberByName('山田太郎')?.slackId).toBe('U99999999');
    expect(findMemberByName('存在しない人')).toBeUndefined();
  });

  test('findMemberByEmail matches case-insensitively', () => {
    const customConfig = [
      {
        name: '山田 太郎',
        slackId: 'U99999999',
        email: 'yamada@example.com',
        role: 'member',
      },
    ];
    process.env.TEAM_MEMBERS_CONFIG = JSON.stringify(customConfig);

    const found = findMemberByEmail('YAMADA@EXAMPLE.COM');
    expect(found?.name).toBe('山田 太郎');
  });

  test('getSlackMention formats mention tags properly', () => {
    const customConfig = [
      { name: '山田 太郎', slackId: 'U99999999', role: 'member' },
    ];
    process.env.TEAM_MEMBERS_CONFIG = JSON.stringify(customConfig);

    expect(getSlackMention('山田 太郎')).toBe('<@U99999999>');
    expect(getSlackMention('未知のメンバー')).toBe('未知のメンバーさん');
  });

  test('getManagerSlackId returns manager ID from JSON or env', () => {
    delete process.env.TEAM_MEMBERS_CONFIG;
    process.env.MANAGER_SLACK_USER_ID = 'U_MGR_TEST';
    expect(getManagerSlackId()).toBe('U_MGR_TEST');
  });
});

describe('EmailProcessingService', () => {
  let emailService: EmailProcessingService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    const customConfig = [
      {
        name: '山田 太郎',
        slackId: 'U11111111',
        email: 'yamada@example.com',
        role: 'member',
      },
      {
        name: '佐藤 花子',
        slackId: 'U22222222',
        email: 'sato@example.com',
        role: 'member',
      },
      {
        name: '田中 統括',
        slackId: 'U33333333',
        email: 'tanaka@example.com',
        role: 'manager',
      },
    ];
    process.env.TEAM_MEMBERS_CONFIG = JSON.stringify(customConfig);
    emailService = new EmailProcessingService();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('isAttendanceEmail identifies applies emails for team members', () => {
    const validEmail: GmailIncomingMessage = {
      id: 'msg-1',
      date: '2026-09-18T08:30:00Z',
      from: 'yamada@example.com',
      subject: '[applies:40797][全休]2026-09-18 当日申請 山田 太郎',
      body: '体調不良のため終日全休をいただきます。',
    };
    const check1 = emailService.isAttendanceEmail(validEmail);
    expect(check1.isAttendance).toBe(true);
    expect(check1.matchedMemberName).toBe('山田 太郎');

    // Non-member attendance email should not match
    const nonMemberEmail: GmailIncomingMessage = {
      id: 'msg-2',
      date: '2026-09-18T08:30:00Z',
      from: 'other@example.com',
      subject: '[applies:40798][全休]2026-09-18 当日申請 鈴木 一郎',
      body: 'お休みします',
    };
    const check2 = emailService.isAttendanceEmail(nonMemberEmail);
    expect(check2.isAttendance).toBe(false);

    // Non-applies email with member name
    const normalEmail: GmailIncomingMessage = {
      id: 'msg-3',
      date: '2026-09-18T08:30:00Z',
      from: 'yamada@example.com',
      subject: 'Re: 定例ミーティングについて (山田 太郎)',
      body: 'よろしくお願いします',
    };
    const check3 = emailService.isAttendanceEmail(normalEmail);
    expect(check3.isAttendance).toBe(false);
  });

  test('isAnnouncementEmail identifies allpe and custom announcement emails', () => {
    // Subject contains allpe
    expect(
      emailService.isAnnouncementEmail({
        id: '1',
        date: '',
        from: 'info@example.com',
        subject: '[allpe] 10月度セキュリティ講習の実施について',
        body: '',
      })
    ).toBe(true);

    // Normal email
    expect(
      emailService.isAnnouncementEmail({
        id: '2',
        date: '',
        from: 'client@example.com',
        subject: '打ち合わせ日程のご相談',
        body: '',
      })
    ).toBe(false);
  });

  test('manager direct routing and announcement whitelist', () => {
    process.env.MANAGER_REPORT_FROM_EMAILS =
      'boss@example.com, director@example.com';
    process.env.ANNOUNCEMENT_TO_EMAILS =
      'allpe@example.com, all-staff@example.com';
    process.env.MANAGER_REPORT_KEYWORDS = 'boss-tag, mgr-direct';
    const customService = new EmailProcessingService();

    // 1. Email from boss@example.com is manager direct email
    const fromBoss: GmailIncomingMessage = {
      id: 'boss-1',
      date: '',
      from: 'boss@example.com',
      subject: '来期の戦略について',
      body: '来期の体制変更について共有します。',
    };
    expect(customService.isManagerDirectEmail(fromBoss)).toBe(true);
    // Should NOT be treated as general announcement
    expect(customService.isAnnouncementEmail(fromBoss)).toBe(false);

    // 2. Email where TO matches ANNOUNCEMENT_TO_EMAILS is identified as announcement
    const toAll: GmailIncomingMessage = {
      id: 'all-1',
      date: '',
      from: 'someone@example.com',
      to: 'allpe@example.com',
      subject: '全社連絡事項',
      body: 'テスト',
    };
    expect(customService.isAnnouncementEmail(toAll)).toBe(true);

    // 3. Subject containing configured manager keyword is manager direct email
    const subjectManager: GmailIncomingMessage = {
      id: 'mgr-1',
      date: '',
      from: 'hr@example.com',
      subject: '【連絡】[boss-tag] 業務引き継ぎの件',
      body: '',
    };
    expect(customService.isManagerDirectEmail(subjectManager)).toBe(true);
  });

  test('supports custom comma-separated keywords and email addresses from environment variables', () => {
    // 1. Test parseCommaSeparatedList
    expect(parseCommaSeparatedList('a, b , c  ')).toEqual(['a', 'b', 'c']);
    expect(parseCommaSeparatedList('', ['default'])).toEqual(['default']);

    // 2. Test ATTENDANCE_KEYWORDS env var
    process.env.ATTENDANCE_KEYWORDS = '勤怠申請, 休暇連絡, applies';
    const customEmailService = new EmailProcessingService();

    expect(
      customEmailService.isAttendanceEmail({
        id: 'c-1',
        date: '',
        from: 'yamada@example.com',
        subject: '【勤怠申請】09/18 山田 太郎',
        body: '',
      }).isAttendance
    ).toBe(true);

    expect(
      customEmailService.isAttendanceEmail({
        id: 'c-2',
        date: '',
        from: 'yamada@example.com',
        subject: '【休暇連絡】09/18 山田 太郎',
        body: '',
      }).isAttendance
    ).toBe(true);

    // 3. Test ANNOUNCEMENT_KEYWORDS and ANNOUNCEMENT_FROM_EMAILS env vars
    process.env.ANNOUNCEMENT_KEYWORDS = 'allpe, urgent_alert, 重要周知';
    process.env.ANNOUNCEMENT_FROM_EMAILS = 'ceo@example.com, hr@example.com';

    expect(
      customEmailService.isAnnouncementEmail({
        id: 'c-3',
        date: '',
        from: 'anyone@example.com',
        subject: '【重要周知】社内規定の改定について',
        body: '',
      })
    ).toBe(true);
  });

  test('parseAttendanceRecord extracts leave type, date, same-day flag, and reason', async () => {
    const msg: GmailIncomingMessage = {
      id: 'p-1',
      date: '2026-09-18T08:00:00Z',
      from: 'yamada@example.com',
      subject: '[applies:40797][午前休]2026-09-19 事前申請 山田 太郎',
      body: '事由: 市役所手続きのため午前休をいただきます。\nよろしくお願いいたします。',
    };

    const record = await emailService.parseAttendanceRecord(msg, '山田 太郎');
    expect(record.memberName).toBe('山田 太郎');
    expect(record.leaveType).toBe('午前休');
    expect(record.date).toBe('2026-09-19');
    expect(record.isSameDay).toBe(false);
    expect(record.reason).toContain('市役所手続き');
  });

  test('formatAttendanceSummaryMessage generates clear Slack message', () => {
    const records = [
      {
        memberName: '山田 太郎',
        slackUserId: 'U11111111',
        date: '2026-09-18',
        leaveType: '全休',
        isSameDay: true,
        reason: '体調不良のため終日お休み',
        rawSubject: '...',
      },
      {
        memberName: '佐藤 花子',
        slackUserId: 'U22222222',
        date: '2026-09-18',
        leaveType: '在宅',
        isSameDay: false,
        rawSubject: '...',
      },
    ];

    const message = emailService.formatAttendanceSummaryMessage(
      records,
      '2026-09-18'
    );
    expect(message).toContain('チーム勤怠連絡');
    expect(message).toContain(
      '・ *山田 太郎*: [全休] [09/18] [当日申請] (体調不良のため終日お休み)'
    );
    expect(message).toContain('・ *佐藤 花子*: [在宅] [09/18]');
    expect(message).toContain('その他メンバー: 申請なし（通常勤務）');
  });

  test('processIncomingEmails routes messages to manager DM and general channel', async () => {
    process.env.MANAGER_REPORT_FROM_EMAILS = 'boss@example.com';
    process.env.ANNOUNCEMENT_TO_EMAILS = 'allpe@example.com';
    const testService = new EmailProcessingService();

    const mockPostMessage = jest.fn().mockResolvedValue({ ok: true });
    const mockClient = {
      chat: {
        postMessage: mockPostMessage,
      },
    } as any;

    const messages: GmailIncomingMessage[] = [
      {
        id: 'msg-att',
        date: '2026-09-18T08:00:00Z',
        from: 'yamada@example.com',
        subject: '[applies:40797][全休]2026-09-18 当日申請 山田 太郎',
        body: '事由: 体調不良',
      },
      {
        id: 'msg-direct',
        date: '2026-09-18T08:30:00Z',
        from: 'boss@example.com',
        subject: '役員会議の共有事項',
        body: 'マネージャー向けに来期の重要方針を共有します。',
      },
      {
        id: 'msg-ann',
        date: '2026-09-18T09:00:00Z',
        from: 'info@example.com',
        subject: '[allpe] 社内イベント開催について',
        body: '来月社内イベントを開催します。詳細は追って連絡します。',
      },
      {
        id: 'msg-excluded',
        date: '2026-09-18T09:10:00Z',
        from: 'info@example.com',
        to: 'exclude@example.com',
        subject: '[allpe] 除外対象メール',
        body: 'このメールは除外されるべきです',
      },
      {
        id: 'msg-unrelated',
        date: '2026-09-18T09:30:00Z',
        from: 'spam@example.com',
        subject: 'お得な情報です',
        body: 'セール中！',
      },
    ];

    const result = await testService.processIncomingEmails(
      messages,
      mockClient,
      {
        managerId: 'U_MANAGER',
        channelId: 'C_GENERAL',
      }
    );

    expect(result.attendanceRecords).toHaveLength(1);
    expect(result.managerDirectEmails).toHaveLength(1);
    expect(result.announcements).toHaveLength(1);
    expect(result.ignoredCount).toBe(2); // msg-excluded and msg-unrelated

    // DM to manager for attendance
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'U_MANAGER',
        text: expect.stringContaining('山田 太郎'),
      })
    );

    // DM to manager for direct email
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'U_MANAGER',
        text: expect.stringContaining('役員会議の共有事項'),
      })
    );

    // Post to general channel for allpe announcement
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_GENERAL',
        text: expect.stringContaining('社内イベント開催について'),
      })
    );
  });
});

describe('Historical Weekly Report Logic (weekly/service.ts)', () => {
  const sampleTopHtml = `
    <html>
      <head><title>週報システム</title></head>
      <body>
        <script>
          var wrTargetDateId = 735;
          var bothEndsId = { oldestId: 36, newestId: 735 };
          var filingData = [
            { staffId: 101, staffName: "メンバーA", newestWrTargetDateId: 735, filingDatetime: "2026-09-15 11:30:00" },
            { staffId: 102, staffName: "メンバーB", newestWrTargetDateId: 735, filingDatetime: "2026-09-15 12:00:00" },
            { staffId: 103, staffName: "メンバーC", newestWrTargetDateId: 735, filingDatetime: "" }
          ];
        </script>
      </body>
    </html>
  `;

  test('extractNewestWrTargetDateId finds newest week ID', () => {
    const id = extractNewestWrTargetDateId(sampleTopHtml);
    expect(id).toBe(735);
  });

  test('extractSubmittedStaffRecords returns submitted members for current week', () => {
    const records = extractSubmittedStaffRecords(sampleTopHtml);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.staffName)).toContain('メンバーA');
    expect(records.map((r) => r.staffName)).toContain('メンバーB');
    expect(records.map((r) => r.staffName)).not.toContain('メンバーC');
    expect(records[0].wrTargetDateId).toBe(735);
  });

  test('extractSubmittedStaffRecords uses targetWrDateId for historical inquiries', () => {
    const targetHistoricalId = 734; // 1 week ago
    const records = extractSubmittedStaffRecords(
      sampleTopHtml,
      targetHistoricalId
    );
    expect(records.length).toBeGreaterThanOrEqual(3);
    records.forEach((r) => {
      expect(r.wrTargetDateId).toBe(734);
    });
  });
});
