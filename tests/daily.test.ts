import {
  getTeamMembers,
  getAllMembers,
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

  afterEach(() => {
    process.env.TEAM_MEMBERS_CONFIG = originalEnv;
  });

  test('returns 10 default team members when env is unset', () => {
    delete process.env.TEAM_MEMBERS_CONFIG;
    const members = getTeamMembers();
    expect(members).toHaveLength(10);
    expect(members.map((m) => m.name)).toContain('小川　智矢');
    expect(members.map((m) => m.name)).toContain('朝岡　拓人');
  });

  test('parses TEAM_MEMBERS_CONFIG JSON when provided', () => {
    const customConfig = [
      { name: '山田 太郎', slackId: 'U99999999', email: 'yamada@example.com' },
      { name: '佐藤 花子', slackId: 'U88888888', role: 'member' },
      { name: '大沼 佑麻', slackId: 'U0AQGV96Q4S', role: 'manager' },
    ];
    process.env.TEAM_MEMBERS_CONFIG = JSON.stringify(customConfig);

    const members = getTeamMembers();
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.name)).toContain('山田 太郎');
    expect(members.map((m) => m.name)).toContain('佐藤 花子');
    // Manager is excluded from regular member list
    expect(members.map((m) => m.name)).not.toContain('大沼 佑麻');

    const all = getAllMembers();
    expect(all).toHaveLength(3);
  });

  test('findMemberByName handles various spacing', () => {
    delete process.env.TEAM_MEMBERS_CONFIG;
    expect(findMemberByName('小川 智矢')?.slackId).toBe('U0AQRJZK004');
    expect(findMemberByName('小川　智矢')?.slackId).toBe('U0AQRJZK004');
    expect(findMemberByName('小川智矢')?.slackId).toBe('U0AQRJZK004');
    expect(findMemberByName('存在しない人')).toBeUndefined();
  });

  test('findMemberByEmail matches case-insensitively', () => {
    delete process.env.TEAM_MEMBERS_CONFIG;
    const found = findMemberByEmail('TOMOYA.OGAWA@poweredge.co.jp');
    expect(found?.name).toBe('小川　智矢');
  });

  test('getSlackMention formats mention tags properly', () => {
    delete process.env.TEAM_MEMBERS_CONFIG;
    expect(getSlackMention('小川 智矢')).toBe('<@U0AQRJZK004>');
    expect(getSlackMention('未知のメンバー')).toBe('未知のメンバーさん');
  });

  test('getManagerSlackId returns Onuma ID', () => {
    delete process.env.TEAM_MEMBERS_CONFIG;
    expect(getManagerSlackId()).toBe('U0AQGV96Q4S');
  });
});

describe('EmailProcessingService', () => {
  let emailService: EmailProcessingService;

  beforeEach(() => {
    delete process.env.TEAM_MEMBERS_CONFIG;
    emailService = new EmailProcessingService();
  });

  test('isAttendanceEmail identifies applies emails for team members', () => {
    const validEmail: GmailIncomingMessage = {
      id: 'msg-1',
      date: '2026-09-18T08:30:00Z',
      from: 'tomoya.ogawa@poweredge.co.jp',
      subject: '[applies:40797][全休]2026-09-18 当日申請 小川　智矢',
      body: '体調不良のため終日全休をいただきます。',
    };
    const check1 = emailService.isAttendanceEmail(validEmail);
    expect(check1.isAttendance).toBe(true);
    expect(check1.matchedMemberName).toBe('小川　智矢');

    // Non-member attendance email should not match
    const nonMemberEmail: GmailIncomingMessage = {
      id: 'msg-2',
      date: '2026-09-18T08:30:00Z',
      from: 'tanaka@poweredge.co.jp',
      subject: '[applies:40798][全休]2026-09-18 当日申請 田中 太郎',
      body: 'お休みします',
    };
    const check2 = emailService.isAttendanceEmail(nonMemberEmail);
    expect(check2.isAttendance).toBe(false);

    // Non-applies email with member name
    const normalEmail: GmailIncomingMessage = {
      id: 'msg-3',
      date: '2026-09-18T08:30:00Z',
      from: 'tomoya.ogawa@poweredge.co.jp',
      subject: 'Re: 定例ミーティングについて (小川 智矢)',
      body: 'よろしくお願いします',
    };
    const check3 = emailService.isAttendanceEmail(normalEmail);
    expect(check3.isAttendance).toBe(false);
  });

  test('isAnnouncementEmail identifies allpe, t-ohnuma, and furukawa emails', () => {
    // Subject contains allpe
    expect(
      emailService.isAnnouncementEmail({
        id: '1',
        date: '',
        from: 'kanri@poweredge.co.jp',
        subject: '[allpe] 10月度セキュリティ講習の実施について',
        body: '',
      })
    ).toBe(true);

    // Subject contains t-ohnuma
    expect(
      emailService.isAnnouncementEmail({
        id: '2',
        date: '',
        from: 'somu@poweredge.co.jp',
        subject: '【連絡】[t-ohnuma] 業務引き継ぎの件',
        body: '',
      })
    ).toBe(true);

    // Sender is furukawa
    expect(
      emailService.isAnnouncementEmail({
        id: '3',
        date: '',
        from: 'furukawa@poweredge.co.jp',
        subject: '全社方針について',
        body: '',
      })
    ).toBe(true);

    expect(
      emailService.isAnnouncementEmail({
        id: '4',
        date: '',
        from: 'furkawa@poweredge.co.jp',
        subject: '人事異動のお知らせ',
        body: '',
      })
    ).toBe(true);

    // Normal email
    expect(
      emailService.isAnnouncementEmail({
        id: '5',
        date: '',
        from: 'client@example.com',
        subject: '打ち合わせ日程のご相談',
        body: '',
      })
    ).toBe(false);
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
        from: 'tomoya.ogawa@poweredge.co.jp',
        subject: '【勤怠申請】09/18 小川　智矢',
        body: '',
      }).isAttendance
    ).toBe(true);

    expect(
      customEmailService.isAttendanceEmail({
        id: 'c-2',
        date: '',
        from: 'tomoya.ogawa@poweredge.co.jp',
        subject: '【休暇連絡】09/18 小川　智矢',
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

    expect(
      customEmailService.isAnnouncementEmail({
        id: 'c-4',
        date: '',
        from: 'hr@example.com',
        subject: '定期健康診断のご案内',
        body: '',
      })
    ).toBe(true);

    // Cleanup
    delete process.env.ATTENDANCE_KEYWORDS;
    delete process.env.ANNOUNCEMENT_KEYWORDS;
    delete process.env.ANNOUNCEMENT_FROM_EMAILS;
  });

  test('parseAttendanceRecord extracts fields cleanly', async () => {
    const msg: GmailIncomingMessage = {
      id: 'msg-100',
      date: '2026-09-18T08:15:00Z',
      from: 'tomoya.ogawa@poweredge.co.jp',
      subject: '[applies:40797][全休]2026-09-18 当日申請 小川　智矢',
      body: 'お疲れ様です。小川です。\n事由: 発熱のため終日お休みをいただきます。',
    };

    const record = await emailService.parseAttendanceRecord(msg, '小川 智矢');
    expect(record.memberName).toBe('小川 智矢');
    expect(record.slackUserId).toBe('U0AQRJZK004');
    expect(record.leaveType).toBe('全休');
    expect(record.date).toBe('2026-09-18');
    expect(record.isSameDay).toBe(true);
    expect(record.reason).toContain('発熱のため');
  });

  test('formatAttendanceSummaryMessage generates Slack formatted text', () => {
    const records = [
      {
        memberName: '小川 智矢',
        slackUserId: 'U0AQRJZK004',
        date: '2026-09-18',
        leaveType: '全休',
        isSameDay: true,
        reason: '体調不良のため終日お休み',
        rawSubject: '...',
      },
      {
        memberName: '朝岡 拓人',
        slackUserId: 'U0AQ6QH94AK',
        date: '2026-09-18',
        leaveType: '在宅',
        isSameDay: false,
        rawSubject: '...',
      },
    ];

    const message = emailService.formatAttendanceSummaryMessage(records, '2026-09-18');
    expect(message).toContain('【本日（09/18）のチーム勤怠連絡】');
    expect(message).toContain('・*小川 智矢*: [全休] [当日申請] (体調不良のため終日お休み)');
    expect(message).toContain('・*朝岡 拓人*: [在宅]');
    expect(message).toContain('その他メンバー: 申請なし（通常勤務）');
  });

  test('processIncomingEmails routes messages to manager DM and general channel', async () => {
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
        from: 'tomoya.ogawa@poweredge.co.jp',
        subject: '[applies:40797][全休]2026-09-18 当日申請 小川　智矢',
        body: '事由: 体調不良',
      },
      {
        id: 'msg-ann',
        date: '2026-09-18T09:00:00Z',
        from: 'furukawa@poweredge.co.jp',
        subject: '【全社連絡】社内イベント開催について',
        body: '来月社内イベントを開催します。詳細は追って連絡します。',
      },
      {
        id: 'msg-unrelated',
        date: '2026-09-18T09:30:00Z',
        from: 'spam@example.com',
        subject: 'お得な情報です',
        body: 'セール中！',
      },
    ];

    const result = await emailService.processIncomingEmails(
      messages,
      mockClient,
      {
        managerId: 'U0AQGV96Q4S',
        channelId: 'C0AQETFBF8W',
      }
    );

    expect(result.attendanceRecords).toHaveLength(1);
    expect(result.announcements).toHaveLength(1);
    expect(result.ignoredCount).toBe(1);

    // DM to manager
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'U0AQGV96Q4S',
        text: expect.stringContaining('小川'),
      })
    );

    // Post to general channel
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C0AQETFBF8W',
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
            { staffId: 101, staffName: "小川　智矢", newestWrTargetDateId: 735, filingDatetime: "2026-09-15 11:30:00" },
            { staffId: 102, staffName: "朝岡　拓人", newestWrTargetDateId: 735, filingDatetime: "2026-09-15 12:00:00" },
            { staffId: 103, staffName: "川上　慶太", newestWrTargetDateId: 735, filingDatetime: "" }
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
    expect(records.map((r) => r.staffName)).toContain('小川　智矢');
    expect(records.map((r) => r.staffName)).toContain('朝岡　拓人');
    expect(records.map((r) => r.staffName)).not.toContain('川上　慶太');
    expect(records[0].wrTargetDateId).toBe(735);
  });

  test('extractSubmittedStaffRecords uses targetWrDateId for historical inquiries', () => {
    const targetHistoricalId = 734; // 1 week ago
    const records = extractSubmittedStaffRecords(sampleTopHtml, targetHistoricalId);
    // All members with staffId in filingData are candidates for historical inquiry
    expect(records.length).toBeGreaterThanOrEqual(3);
    records.forEach((r) => {
      expect(r.wrTargetDateId).toBe(734);
    });
  });
});
