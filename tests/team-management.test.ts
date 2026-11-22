import { IncomingMessage, ServerResponse } from 'http';
import {
  AccessDeniedError,
  ConfirmationRequiredError,
  ExternalAuthError,
  ExternalParseError,
  GSessionPortalFetcher,
  InMemoryTeamManagementRepository,
  SyncConflictError,
  SyncLeaseLockManager,
  TeamManagementAgent,
  TeamManagementSyncService,
  WeeklyAiSummarizer,
  WeeklyPortalFetcher,
  assertNoPublicSecretEnvVars,
  computeReportsContentHash,
  createTeamManagementRoutes,
  parseStrictGSessionMan050Html,
  parseStrictWeeklyTopHtml,
  renderTeamManagementDashboardHtml,
  requireAdminUser,
  requireCronAuth,
  requireExternalAgentAuth,
  resetExternalAgentRateLimits,
  safeParseFilingDataArray,
} from '../src/team-management';

describe('Team Management Integration (Phases 1-5)', () => {
  const originalEnv = process.env;

  const SAMPLE_MEMBERS = [
    {
      name: '山田 太郎',
      staffNum: '000101',
      slackId: 'U_YAMADA',
      email: 'yamada@example.com',
      role: 'member' as const,
    },
    {
      name: '佐藤 花子',
      staffNum: '000102',
      slackId: 'U_SATO',
      email: 'sato@example.com',
      role: 'member' as const,
    },
    {
      name: '鈴木 一郎',
      staffNum: '000103',
      slackId: 'U_SUZUKI',
      email: 'suzuki@example.com',
      role: 'member' as const,
    },
    {
      name: '大沼 マネージャー',
      staffNum: '000100',
      slackId: 'U_MGR',
      email: 'manager@example.com',
      role: 'manager' as const,
    },
  ];

  const VALID_WEEKLY_TOP_HTML = `
    <html>
      <head>
        <script>
          09/15 23:59:00 </label><label for="reportingDate">締切りの週報</label>
          <div><label>(対象期間：</label><label>09/06</label><label> ～</label><label>09/12</label></div>
          var wrTargetDateId = 735;
          var filingData = [
            { staffId: 101, staffName: '山田　太郎', staffNum: '000101', filingDatetime: '2026-09-15 20:47:01', newestWrTargetDateId: 735 },
            { staffId: 102, staffName: '佐藤　花子', staffNum: '000102', filingDatetime: '', newestWrTargetDateId: 735 },
            { staffId: 103, staffName: '鈴木　一郎', staffNum: '000103', filingDatetime: '2026-09-15 18:10:00', newestWrTargetDateId: 735 }
          ];
        </script>
      </head>
    </html>
  `;

  const VALID_GS_MAN050_HTML = `
    <table class="tl0 lastlogintd2">
      <tbody>
        <tr><th>社員/職員番号</th><th>氏名</th><th>役職</th><th>最終ログイン時間</th></tr>
        <tr>
          <td>000101</td>
          <td><a href="#">山田　太郎</a></td>
          <td></td>
          <td>2026/09/17 08:52:21</td>
        </tr>
        <tr>
          <td>000102</td>
          <td><a href="#">佐藤　花子</a></td>
          <td></td>
          <td>2026/09/09 21:12:26</td>
        </tr>
      </tbody>
    </table>
  `;

  const VALID_GS_SCHMAIN_HTML = `
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
        <td>
          <a onclick="editSchedule('schw_edit', 20260918, 501, 48, 0);">
            <span class="tooltips">チーム定例</span>チーム定例
          </a>
        </td>
        <td></td><td></td><td></td><td></td><td></td><td></td>
      </tr>
    </table>
  `;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TEAM_MEMBERS_CONFIG: JSON.stringify(SAMPLE_MEMBERS),
      TEAM_MANAGEMENT_ADMIN_TOKEN: 'secret-admin-token-123',
      ADMIN_EMAILS: 'manager@example.com,admin@example.com',
      TEAM_MANAGEMENT_CRON_SECRET: 'secret-cron-token-456',
      EXTERNAL_AGENT_CLIENTS_CONFIG: JSON.stringify([
        {
          clientId: 'custom-app-readonly',
          apiKey: 'ext-key-read-111',
          scopes: ['team:read'],
          rateLimitPerMinute: 2,
        },
        {
          clientId: 'custom-app-full',
          apiKey: 'ext-key-full-222',
          scopes: ['team:read', 'team:sync'],
          rateLimitPerMinute: 10,
        },
      ]),
    };
    resetExternalAgentRateLimits();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // =========================================================================
  // Phase 1: Pure Core Parsers, Fetchers & Security Invariants
  // =========================================================================
  describe('Phase 1: Core Parsers & Security Invariants', () => {
    it('parses filingData literal safely via JSON.parse without new Function or eval', () => {
      const literal = `[
        { staffId: 101, staffName: '山田　太郎', staffNum: '000101', filingDatetime: '2026-09-15 20:47:01' },
        { staffId: 102, staffName: "佐藤 花子", filingDatetime: null }
      ];`;
      const records = safeParseFilingDataArray(literal);
      expect(records).toHaveLength(2);
      expect(records[0].staffId).toBe(101);
      expect(records[0].staffName).toBe('山田　太郎');
      expect(records[1].filingDatetime).toBeNull();
    });

    it('rejects malicious executable payloads in filingData with ExternalParseError', () => {
      const malicious = `[{ staffId: (function(){ return 1; })() }]`;
      expect(() => safeParseFilingDataArray(malicious)).toThrow(
        ExternalParseError
      );
    });

    it('throws ExternalAuthError when weekly top HTML is a login page (no silent fallback)', () => {
      const loginHtml = `<html><body><form id="loginForm"><input name="password"/></form></body></html>`;
      expect(() => parseStrictWeeklyTopHtml(loginHtml)).toThrow(
        ExternalAuthError
      );
    });

    it('throws ExternalParseError when filingData is missing instead of falling back to string search', () => {
      const brokenHtml = `<html><body>山田 太郎</body></html>`;
      expect(() => parseStrictWeeklyTopHtml(brokenHtml)).toThrow(
        ExternalParseError
      );
    });

    it('parses GroupSession man050.do in explicit JST (+09:00) and marks missing members as NOT_FOUND_IN_GS', () => {
      // 2026-09-17T09:00:00+09:00 == 2026-09-17T00:00:00Z
      const fixedNow = new Date('2026-09-17T09:00:00+09:00');
      const parsed = parseStrictGSessionMan050Html(VALID_GS_MAN050_HTML, {
        now: fixedNow,
        thresholdDays: 7,
      });

      // 山田 logged in 2026/09/17 08:52:21 JST -> 0 days ago -> ACTIVE
      const yamada = parsed.allMembers.find((m) => m.name === '山田 太郎');
      expect(yamada?.status).toBe('ACTIVE');
      expect(yamada?.lastLoginAt).toBe('2026-09-17T08:52:21+09:00');
      expect(yamada?.daysSinceLastLogin).toBe(0);

      // 佐藤 logged in 2026/09/09 21:12:26 JST -> 7 days ago -> INACTIVE
      const sato = parsed.allMembers.find((m) => m.name === '佐藤 花子');
      expect(sato?.status).toBe('INACTIVE');
      expect(sato?.daysSinceLastLogin).toBe(7);

      // 鈴木 is not in man050 HTML -> NOT_FOUND_IN_GS (NOT falsely ACTIVE!)
      const suzuki = parsed.allMembers.find((m) => m.name === '鈴木 一郎');
      expect(suzuki?.status).toBe('NOT_FOUND_IN_GS');
      expect(suzuki?.daysSinceLastLogin).toBeNull();
    });

    it('detects public environment variable secret leaks', () => {
      expect(() =>
        assertNoPublicSecretEnvVars({
          NEXT_PUBLIC_GEMINI_API_KEY: 'secret',
        } as unknown as NodeJS.ProcessEnv)
      ).toThrow(/PUBLIC_ENV_SECRET_LEAK_DETECTED|Security violation/);
    });
  });

  // =========================================================================
  // Phase 2: Firestore Repository, Lease Lock & TeamManagementSyncService
  // =========================================================================
  describe('Phase 2: Lease Lock & Fail-Closed SyncService', () => {
    it('prevents concurrent sync execution via 180s TTL lease lock and reclaims expired locks', async () => {
      const repo = new InMemoryTeamManagementRepository();
      const lockMgr = new SyncLeaseLockManager(repo, 180000);
      const t0 = new Date('2026-11-22T00:00:00Z');

      await lockMgr.acquireLock('job-1', 'SCHEDULED_CRON', t0);

      // Second concurrent job 10 seconds later must fail with SyncConflictError (409)
      const t1 = new Date('2026-11-22T00:00:10Z');
      await expect(
        lockMgr.acquireLock('job-2', 'MANUAL_DASHBOARD', t1)
      ).rejects.toThrow(SyncConflictError);

      // After 181 seconds (TTL expired), lock is automatically reclaimed
      const tExpired = new Date('2026-11-22T00:03:01Z');
      const reclaimed = await lockMgr.acquireLock(
        'job-3',
        'MANUAL_DASHBOARD',
        tExpired
      );
      expect(reclaimed.lockOwnerJobId).toBe('job-3');
    });

    it('separates Stage 1 (STATUS_ONLY: 0 external read side-effect) from Stage 2 (WITH_DETAILS) and preserves snapshots on failure', async () => {
      const repo = new InMemoryTeamManagementRepository();
      const mockFetchTop = jest.fn().mockResolvedValue({
        session: {
          pageHtml: VALID_WEEKLY_TOP_HTML,
          cookieStr: 'SID=1',
          finalUrl: 'https://auth.poweredge.co.jp/weekly_report/top',
        },
        parsed: parseStrictWeeklyTopHtml(VALID_WEEKLY_TOP_HTML),
      });
      const mockFetchDetails = jest.fn().mockResolvedValue({
        reports: [
          {
            report: {
              staffId: 101,
              staffName: '山田 太郎',
              impression: '順調です',
              weekUptime: 40,
              projects: [
                {
                  properName: '社内基盤刷新',
                  endUser: '自社',
                  prjDetail: 'API設計',
                },
              ],
            },
            filingDatetime: '2026-09-15 20:47:01',
            wrTargetDateId: 735,
            externalReadRegistered: true,
          },
          {
            report: {
              staffId: 103,
              staffName: '鈴木 一郎',
              impression: 'テスト完了',
              weekUptime: 38,
              projects: [],
            },
            filingDatetime: '2026-09-15 18:10:00',
            wrTargetDateId: 735,
            externalReadRegistered: true,
          },
        ],
        failedStaffIds: [],
      });

      const weeklyFetcher = {
        fetchTopStatus: mockFetchTop,
        fetchSubmittedDetails: mockFetchDetails,
      } as unknown as WeeklyPortalFetcher;

      const gSessionFetcher = {
        fetchLoginStatuses: jest.fn().mockResolvedValue({
          sessionCookie: 'GSID=1',
          result: parseStrictGSessionMan050Html(VALID_GS_MAN050_HTML, {
            now: new Date('2026-09-17T09:00:00+09:00'),
          }),
        }),
        fetchManagerSchedule: jest.fn().mockResolvedValue([
          {
            dateStr: '20260918',
            formattedDate: '09/18(金)',
            events: [{ id: '501', title: 'チーム定例' }],
          },
        ]),
      } as unknown as GSessionPortalFetcher;

      const mockGenerateSummary = jest
        .fn()
        .mockImplementation(
          async (weekId: string, weekLabel: string, reports: any[]) => ({
            weekId,
            weekLabel,
            sourceContentHash: computeReportsContentHash(reports),
            model: 'gemini-2.5-flash',
            overallSummary: '全員順調に稼働しています。',
            followUpAlerts: [],
            memberHighlights: [],
            rawMarkdown: '### 1. 全体概況\n全員順調に稼働しています。',
            generatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
        );

      const aiSummarizer = {
        isConfigured: () => true,
        generateStructuredSummary: mockGenerateSummary,
      } as unknown as WeeklyAiSummarizer;

      const syncService = new TeamManagementSyncService({
        repository: repo,
        weeklyFetcher,
        gSessionFetcher,
        aiSummarizer,
      });

      // 1. Stage 1 (STATUS_ONLY): does NOT call fetchSubmittedDetails (0 external read side effect)
      const res1 = await syncService.runSync({
        mode: 'STATUS_ONLY',
        triggerType: 'SCHEDULED_CRON',
        triggeredBy: 'scheduler',
      });
      expect(res1.job.status).toBe('SUCCESS');
      expect(res1.weeklySnapshot?.submittedCount).toBe(2);
      expect(res1.weeklySnapshot?.unsubmittedCount).toBe(1);
      expect(mockFetchDetails).not.toHaveBeenCalled();

      // 2. Stage 2 (WITH_DETAILS) without confirmExternalRead throws ConfirmationRequiredError
      await expect(
        syncService.runSync({
          mode: 'WITH_DETAILS',
          confirmExternalRead: false,
          triggerType: 'MANUAL_DASHBOARD',
          triggeredBy: 'manager@example.com',
        })
      ).rejects.toThrow(ConfirmationRequiredError);

      // 3. Stage 2 (WITH_DETAILS) with confirmExternalRead: true fetches details and generates AI summary
      const res2 = await syncService.runSync({
        mode: 'WITH_DETAILS',
        confirmExternalRead: true,
        triggerType: 'MANUAL_DASHBOARD',
        triggeredBy: 'manager@example.com',
      });
      expect(res2.job.status).toBe('SUCCESS');
      expect(mockFetchDetails).toHaveBeenCalledTimes(1);
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1);
      expect(res2.aiSummary?.overallSummary).toContain('全員順調');

      // 4. Re-running Stage 2 when filingDatetime and contentHash are unchanged skips BOTH external getReportInfo AND Gemini API!
      const res3 = await syncService.runSync({
        mode: 'WITH_DETAILS',
        confirmExternalRead: true,
        triggerType: 'MANUAL_DASHBOARD',
        triggeredBy: 'manager@example.com',
      });
      expect(res3.job.status).toBe('SUCCESS');
      expect(mockFetchDetails).toHaveBeenCalledTimes(1); // still 1!
      expect(mockGenerateSummary).toHaveBeenCalledTimes(1); // still 1!

      // 5. Simulate external portal auth outage: existing valid snapshot (submittedCount=2) is NOT overwritten!
      mockFetchTop.mockRejectedValueOnce(
        new ExternalAuthError('weekly_report', 'Portal down')
      );
      (gSessionFetcher.fetchLoginStatuses as jest.Mock).mockRejectedValueOnce(
        new ExternalAuthError('gsession', 'GS down')
      );

      const resFailed = await syncService.runSync({
        mode: 'STATUS_ONLY',
        triggerType: 'SCHEDULED_CRON',
        triggeredBy: 'scheduler',
      });
      expect(resFailed.job.status).toBe('FAILED');
      expect(resFailed.freshness.isStale).toBe(true);
      expect(resFailed.freshness.lastSyncError?.code).toBe(
        'EXTERNAL_AUTH_ERROR_WEEKLY_REPORT'
      );
      // Crucial: previous valid snapshot is still preserved!
      expect(resFailed.weeklySnapshot?.submittedCount).toBe(2);
    });

    it('marks syncStatus as PARTIAL_ERROR and prevents incomplete AI summary cache when 1 member detail fails', async () => {
      const repo = new InMemoryTeamManagementRepository();
      const weeklyFetcher = {
        fetchTopStatus: jest.fn().mockResolvedValue({
          session: {
            pageHtml: VALID_WEEKLY_TOP_HTML,
            cookieStr: 'SID=1',
            finalUrl: 'https://auth.poweredge.co.jp/weekly_report/top',
          },
          parsed: parseStrictWeeklyTopHtml(VALID_WEEKLY_TOP_HTML),
        }),
        fetchSubmittedDetails: jest.fn().mockResolvedValue({
          reports: [
            {
              report: {
                staffId: 101,
                staffName: '山田 太郎',
                impression: '順調',
                projects: [],
              },
              filingDatetime: '2026-09-15 20:47:01',
              wrTargetDateId: 735,
              externalReadRegistered: true,
            },
          ],
          // 鈴木 (staffId: 103) failed!
          failedStaffIds: [
            { staffId: 103, staffName: '鈴木 一郎', reason: 'HTTP 503' },
          ],
        }),
      } as unknown as WeeklyPortalFetcher;

      const gSessionFetcher = {
        fetchLoginStatuses: jest.fn().mockResolvedValue({
          sessionCookie: 'GSID=1',
          result: parseStrictGSessionMan050Html(VALID_GS_MAN050_HTML),
        }),
        fetchManagerSchedule: jest
          .fn()
          .mockResolvedValue(
            parseStrictGSessionMan050Html(VALID_GS_MAN050_HTML)
              ? []
              : VALID_GS_SCHMAIN_HTML
          ),
      } as unknown as GSessionPortalFetcher;

      const mockGenerateSummary = jest.fn();
      const aiSummarizer = {
        isConfigured: () => true,
        generateStructuredSummary: mockGenerateSummary,
      } as unknown as WeeklyAiSummarizer;

      const syncService = new TeamManagementSyncService({
        repository: repo,
        weeklyFetcher,
        gSessionFetcher,
        aiSummarizer,
      });

      const res = await syncService.runSync({
        mode: 'WITH_DETAILS',
        confirmExternalRead: true,
        triggerType: 'MANUAL_DASHBOARD',
        triggeredBy: 'manager@example.com',
      });

      expect(res.job.status).toBe('PARTIAL_ERROR');
      expect(res.weeklySnapshot?.failedDetailStaffIds).toEqual([103]);
      // AI summary must NOT be generated/cached from partial member reports
      expect(mockGenerateSummary).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Phase 3: Fail-Closed RBAC Guards & Common API Endpoints
  // =========================================================================
  describe('Phase 3: Fail-Closed RBAC, Cron & External Agent Guards', () => {
    it('blocks general users with 403, unauthenticated with 401, and missing config with 500', () => {
      // Unauthenticated -> 401
      expect(() => requireAdminUser({})).toThrow(AccessDeniedError);
      try {
        requireAdminUser({});
      } catch (e) {
        expect((e as AccessDeniedError).httpStatus).toBe(401);
      }

      // General member -> 403
      try {
        requireAdminUser({
          authorization: 'Bearer secret-admin-token-123',
          'x-user-role': 'member',
          'x-user-email': 'yamada@example.com',
        });
        fail('Should have thrown 403');
      } catch (e) {
        expect((e as AccessDeniedError).httpStatus).toBe(403);
      }

      // Authorized manager -> succeeds
      const adminCtx = requireAdminUser({
        authorization: 'Bearer secret-admin-token-123',
        'x-user-role': 'manager',
        'x-user-email': 'manager@example.com',
      });
      expect(adminCtx.isAdmin).toBe(true);
      expect(adminCtx.role).toBe('manager');

      // Missing admin config -> Fail-Closed 500
      delete process.env.TEAM_MANAGEMENT_ADMIN_TOKEN;
      delete process.env.ADMIN_EMAILS;
      process.env.TEAM_MEMBERS_CONFIG = '[]';
      try {
        requireAdminUser({ authorization: 'Bearer anything' });
        fail('Should have thrown 500');
      } catch (e) {
        expect((e as AccessDeniedError).httpStatus).toBe(500);
      }
    });

    it('enforces Fail-Closed Cron auth when secret env var is unset', () => {
      delete process.env.TEAM_MANAGEMENT_CRON_SECRET;
      delete process.env.REMINDER_SECRET_TOKEN;

      try {
        requireCronAuth({});
        fail('Should have failed closed with 500');
      } catch (e) {
        expect((e as AccessDeniedError).httpStatus).toBe(500);
      }
    });

    it('enforces scope and rate limit on external agent clients', () => {
      const readHeaders = {
        'x-agent-client-id': 'custom-app-readonly',
        authorization: 'Bearer ext-key-read-111',
      };

      // Allowed team:read (request 1 of 2)
      const c1 = requireExternalAgentAuth(readHeaders, 'team:read', 1000);
      expect(c1.clientId).toBe('custom-app-readonly');

      // Denied team:sync -> 403
      try {
        requireExternalAgentAuth(readHeaders, 'team:sync', 1500);
        fail('Should have denied team:sync scope');
      } catch (e) {
        expect((e as AccessDeniedError).httpStatus).toBe(403);
      }

      // Allowed team:read (request 2 of 2)
      requireExternalAgentAuth(readHeaders, 'team:read', 2000);

      // Request 3 within same minute exceeds rateLimitPerMinute=2 -> 429
      try {
        requireExternalAgentAuth(readHeaders, 'team:read', 3000);
        fail('Should have rate-limited with 429');
      } catch (e) {
        expect((e as AccessDeniedError).httpStatus).toBe(429);
      }
    });
  });

  // =========================================================================
  // Phase 4 & 5: Dashboard UI, Copilot Agent & Route Handlers
  // =========================================================================
  describe('Phase 4 & 5: Admin Dashboard UI & Team Management Agent', () => {
    it('renders Admin Dashboard HTML with Freshness banner, confirmation modal, and zero polling', async () => {
      const repo = new InMemoryTeamManagementRepository();
      const syncService = new TeamManagementSyncService({ repository: repo });
      const overview = await syncService.getOverview();
      const html = renderTeamManagementDashboardHtml(overview);

      expect(html).toContain('Team Management 管理ダッシュボード');
      expect(html).toContain('data-is-stale="true"');
      expect(html).toContain('提出状況のみ同期 (既読副作用なし)');
      expect(html).toContain('外部週報システムへの「既読」登録確認');
      expect(html).not.toContain('setInterval');
      expect(html).not.toContain('onSnapshot');
    });

    it('binds Team Management Agent tools ONLY to admin/manager Copilot sessions and enforces Human-in-the-Loop confirmation', async () => {
      const repo = new InMemoryTeamManagementRepository();
      const syncService = new TeamManagementSyncService({ repository: repo });
      const agent = new TeamManagementAgent(syncService);

      // 1. General user gets 0 tools in existing Copilot mode
      expect(
        agent.getToolsForCopilotSession({ role: 'member', isAdmin: false })
      ).toHaveLength(0);
      expect(agent.getToolsForCopilotSession(null)).toHaveLength(0);

      // 2. Admin user gets all 6 tools in existing Copilot mode
      const adminTools = agent.getToolsForCopilotSession({
        role: 'manager',
        isAdmin: true,
      });
      expect(adminTools).toHaveLength(6);

      // 3. Double defense: if a general user attempts to invoke executeTool directly via prompt injection -> 403
      await expect(
        agent.executeTool(
          'get_team_management_overview',
          {},
          {
            type: 'copilot_user',
            user: {
              userId: 'u-member',
              role: 'member',
              isAdmin: false,
            },
          }
        )
      ).rejects.toThrow(AccessDeniedError);

      // 4. Admin calling trigger_team_management_sync with includeWeeklyDetails: true without confirmation receives CONFIRMATION_REQUIRED
      const unconfirmed = await agent.executeTool(
        'trigger_team_management_sync',
        { includeWeeklyDetails: true },
        {
          type: 'copilot_user',
          user: {
            userId: 'u-admin',
            email: 'manager@example.com',
            role: 'manager',
            isAdmin: true,
          },
        }
      );
      expect(unconfirmed.status).toBe('CONFIRMATION_REQUIRED');
      expect(unconfirmed.requiresConfirmation).toBe(true);
      expect(unconfirmed.pendingArgs?.confirmExternalRead).toBe(true);
    });

    it('serves Common APIoverview route to Admin and rejects General User via HTTP handler', async () => {
      const repo = new InMemoryTeamManagementRepository();
      const syncService = new TeamManagementSyncService({ repository: repo });
      const routes = createTeamManagementRoutes({ syncService });
      const overviewRoute = routes.find(
        (r) => r.path === '/api/team-management/overview'
      );
      expect(overviewRoute).toBeDefined();

      // Test 403 for general member
      let statusCode = 0;
      let responseBody = '';
      const mockRes403 = {
        writeHead: (code: number) => {
          statusCode = code;
        },
        end: (body: string) => {
          responseBody = body;
        },
      } as unknown as ServerResponse;

      await overviewRoute!.handler(
        {
          headers: {
            authorization: 'Bearer secret-admin-token-123',
            'x-user-role': 'member',
          },
        } as unknown as IncomingMessage,
        mockRes403
      );
      expect(statusCode).toBe(403);
      expect(JSON.parse(responseBody).error.code).toBe('FORBIDDEN_ADMIN_ONLY');

      // Test 200 for manager
      const mockRes200 = {
        writeHead: (code: number) => {
          statusCode = code;
        },
        end: (body: string) => {
          responseBody = body;
        },
      } as unknown as ServerResponse;

      await overviewRoute!.handler(
        {
          headers: {
            authorization: 'Bearer secret-admin-token-123',
            'x-user-role': 'manager',
            'x-user-email': 'manager@example.com',
          },
        } as unknown as IncomingMessage,
        mockRes200
      );
      expect(statusCode).toBe(200);
      const parsed200 = JSON.parse(responseBody);
      expect(parsed200.success).toBe(true);
      expect(parsed200.freshness).toBeDefined();
    });
  });
});
