import {
  AccessDeniedError,
  AuthUserContext,
  ConfirmationRequiredError,
  ExternalAgentClientContext,
  SyncTriggerType,
} from '../core/types';
import { TeamManagementSyncService } from '../sync/sync-service';

export type TeamManagementToolName =
  | 'get_team_management_overview'
  | 'get_weekly_report_submissions'
  | 'get_weekly_report_details_and_summary'
  | 'get_gsession_login_status'
  | 'get_manager_gsession_schedule'
  | 'trigger_team_management_sync';

export interface AgentToolDefinition {
  name: TeamManagementToolName;
  description: string;
  requiresAdmin: true;
  requiredExternalScope: 'team:read' | 'team:sync';
  hasExternalWriteSideEffect: boolean;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TEAM_MANAGEMENT_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: 'get_team_management_overview',
    description:
      '最新の週報提出状況サマリー、GroupSession未ログイン警告対象者、週間スケジュール、およびデータの最終同期日時・鮮度（isStale）を一括取得します（外部サイトへの既読副作用なし）。',
    requiresAdmin: true,
    requiredExternalScope: 'team:read',
    hasExternalWriteSideEffect: false,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_weekly_report_submissions',
    description:
      '指定週（または最新週）の週報提出済み・未提出メンバー一覧と提出日時を取得します（外部サイトへの既読副作用なし）。',
    requiresAdmin: true,
    requiredExternalScope: 'team:read',
    hasExternalWriteSideEffect: false,
    parameters: {
      type: 'object',
      properties: {
        weekId: {
          type: 'string',
          description: '週報ID（wrTargetDateId）。省略時は最新週を参照します。',
        },
      },
    },
  },
  {
    name: 'get_weekly_report_details_and_summary',
    description:
      '提出済みメンバーの週報本文詳細（所感・案件・稼働時間）とAI要約を取得します。Firestoreに未取得で外部サイトアクセスが必要な場合は既読（tWrBrowseData）登録の確認を求めます。',
    requiresAdmin: true,
    requiredExternalScope: 'team:read',
    hasExternalWriteSideEffect: true,
    parameters: {
      type: 'object',
      properties: {
        weekId: {
          type: 'string',
          description: '週報ID（wrTargetDateId）。省略時は最新週。',
        },
        confirmExternalRead: {
          type: 'boolean',
          description:
            '外部週報システムにマネージャーの既読（tWrBrowseData）が登録されることをユーザーが了承済みの場合のみ true。',
        },
      },
    },
  },
  {
    name: 'get_gsession_login_status',
    description:
      'GroupSessionの最終ログイン日時一覧と、閾値（デフォルト7日）以上未ログインのメンバーを取得します。',
    requiresAdmin: true,
    requiredExternalScope: 'team:read',
    hasExternalWriteSideEffect: false,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_manager_gsession_schedule',
    description:
      'GroupSessionから取得済みのマネージャー1週間スケジュールを返します。',
    requiresAdmin: true,
    requiredExternalScope: 'team:read',
    hasExternalWriteSideEffect: false,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'trigger_team_management_sync',
    description:
      '外部の週報システム・GroupSessionへアクセスして最新データを同期します。includeWeeklyDetails: true の場合は外部週報システムに既読が付くため confirmExternalRead: true の事前確認が必須です。',
    requiresAdmin: true,
    requiredExternalScope: 'team:sync',
    hasExternalWriteSideEffect: true,
    parameters: {
      type: 'object',
      properties: {
        includeWeeklyDetails: {
          type: 'boolean',
          description:
            'true の場合、提出状況だけでなく週報本文詳細も取得します（外部システムに既読が登録されます）。デフォルトは false（STATUS_ONLY）。',
        },
        confirmExternalRead: {
          type: 'boolean',
          description:
            'includeWeeklyDetails: true 時にユーザーが外部システムでの既読登録を明示承認した場合のみ true。',
        },
      },
    },
  },
];

export type AgentCallerIdentity =
  | { type: 'copilot_user'; user: AuthUserContext }
  | { type: 'external_app'; client: ExternalAgentClientContext };

export interface AgentToolExecutionResult {
  status: 'SUCCESS' | 'CONFIRMATION_REQUIRED';
  toolName: TeamManagementToolName;
  requiresConfirmation: boolean;
  confirmationMessage?: string;
  pendingArgs?: Record<string, unknown>;
  data?: unknown;
}

/**
 * Team Management Agent
 * - Integrates into existing Copilot mode WITHOUT creating a new Copilot mode
 * - Binds tools strictly to Admin/Manager sessions (returns 0 tools for general users)
 * - Enforces double RBAC verification and Human-in-the-Loop confirmation for external read side-effects
 */
export class TeamManagementAgent {
  private syncService: TeamManagementSyncService;

  constructor(syncService: TeamManagementSyncService) {
    this.syncService = syncService;
  }

  /**
   * Returns Team Management tools for an existing Copilot session.
   * Confirmed Requirement: Do NOT create a new Copilot mode; bind tools only when caller is an administrator.
   */
  getToolsForCopilotSession(
    user:
      AuthUserContext | { role?: string; isAdmin?: boolean } | null | undefined
  ): AgentToolDefinition[] {
    if (!user) return [];
    const isAdmin =
      user.isAdmin === true || user.role === 'admin' || user.role === 'manager';
    if (!isAdmin) {
      return [];
    }
    return [...TEAM_MANAGEMENT_AGENT_TOOLS];
  }

  private assertCallerAuthorized(
    caller: AgentCallerIdentity,
    tool: AgentToolDefinition
  ): { triggeredBy: string; triggerType: SyncTriggerType } {
    if (caller.type === 'copilot_user') {
      const u = caller.user;
      if (!u || (!u.isAdmin && u.role !== 'admin' && u.role !== 'manager')) {
        throw new AccessDeniedError(
          'Prompt injection / unauthorized tool call blocked: caller is not an administrator.',
          403
        );
      }
      return {
        triggeredBy: u.email || u.userId || 'copilot_admin',
        triggerType: 'MANUAL_AGENT',
      };
    }

    if (caller.type === 'external_app') {
      const c = caller.client;
      if (!c || !c.scopes.includes(tool.requiredExternalScope)) {
        throw new AccessDeniedError(
          `External app "${c?.clientId || 'unknown'}" lacks scope "${tool.requiredExternalScope}" for tool "${tool.name}".`,
          403
        );
      }
      return {
        triggeredBy: `ext:${c.clientId}`,
        triggerType: 'EXTERNAL_APP_AGENT',
      };
    }

    throw new AccessDeniedError('Invalid agent caller identity.', 401);
  }

  /**
   * Executes a Team Management Agent tool by calling the Common API / SyncService layer.
   */
  async executeTool(
    toolName: TeamManagementToolName,
    args: Record<string, unknown> = {},
    caller: AgentCallerIdentity
  ): Promise<AgentToolExecutionResult> {
    const tool = TEAM_MANAGEMENT_AGENT_TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      throw new AccessDeniedError(`Unknown tool "${toolName}".`, 403);
    }

    const { triggeredBy, triggerType } = this.assertCallerAuthorized(
      caller,
      tool
    );

    switch (toolName) {
      case 'get_team_management_overview': {
        const overview = await this.syncService.getOverview();
        return {
          status: 'SUCCESS',
          toolName,
          requiresConfirmation: false,
          data: overview,
        };
      }

      case 'get_weekly_report_submissions': {
        const weekId =
          typeof args.weekId === 'string' && args.weekId.trim()
            ? args.weekId.trim()
            : undefined;
        const weekly = await this.syncService.getWeeklyData(weekId);
        return {
          status: 'SUCCESS',
          toolName,
          requiresConfirmation: false,
          data: {
            freshness: weekly.freshness,
            snapshot: weekly.snapshot,
          },
        };
      }

      case 'get_gsession_login_status': {
        const overview = await this.syncService.getOverview();
        return {
          status: 'SUCCESS',
          toolName,
          requiresConfirmation: false,
          data: {
            freshness: overview.freshness,
            snapshotDate: overview.gSessionSnapshot?.snapshotDate ?? null,
            groupSid: overview.gSessionSnapshot?.groupSid ?? null,
            inactiveThresholdDays:
              overview.gSessionSnapshot?.inactiveThresholdDays ?? 7,
            loginStatuses: overview.gSessionSnapshot?.loginStatuses ?? [],
          },
        };
      }

      case 'get_manager_gsession_schedule': {
        const overview = await this.syncService.getOverview();
        return {
          status: 'SUCCESS',
          toolName,
          requiresConfirmation: false,
          data: {
            freshness: overview.freshness,
            snapshotDate: overview.gSessionSnapshot?.snapshotDate ?? null,
            scheduleDays: overview.gSessionSnapshot?.managerScheduleDays ?? [],
          },
        };
      }

      case 'get_weekly_report_details_and_summary': {
        const weekId =
          typeof args.weekId === 'string' && args.weekId.trim()
            ? args.weekId.trim()
            : undefined;
        const confirmExternalRead = args.confirmExternalRead === true;

        try {
          const result = await this.syncService.summarizeWeek({
            weekId,
            confirmExternalRead,
            triggeredBy,
            triggerType,
          });
          return {
            status: 'SUCCESS',
            toolName,
            requiresConfirmation: false,
            data: result,
          };
        } catch (err) {
          if (err instanceof ConfirmationRequiredError) {
            return {
              status: 'CONFIRMATION_REQUIRED',
              toolName,
              requiresConfirmation: true,
              confirmationMessage:
                '週報の本文詳細がまだFirestoreにキャッシュされていないため、外部の週報システム（getReportInfo）から取得する必要があります。実行すると週報システム上でマネージャーの「既読（tWrBrowseData）」が登録されますが、実行してよろしいですか？',
              pendingArgs: {
                ...args,
                confirmExternalRead: true,
              },
            };
          }
          throw err;
        }
      }

      case 'trigger_team_management_sync': {
        const includeWeeklyDetails = args.includeWeeklyDetails === true;
        const confirmExternalRead = args.confirmExternalRead === true;

        if (includeWeeklyDetails && !confirmExternalRead) {
          return {
            status: 'CONFIRMATION_REQUIRED',
            toolName,
            requiresConfirmation: true,
            confirmationMessage:
              '週報本文詳細を含む同期（WITH_DETAILS）を実行すると、外部の週報システム上で提出済みメンバーの週報にマネージャーの「既読（tWrBrowseData）」が登録されます。実行してよろしいですか？',
            pendingArgs: {
              ...args,
              includeWeeklyDetails: true,
              confirmExternalRead: true,
            },
          };
        }

        const syncRes = await this.syncService.runSync({
          mode: includeWeeklyDetails ? 'WITH_DETAILS' : 'STATUS_ONLY',
          confirmExternalRead,
          triggerType,
          triggeredBy,
        });

        return {
          status: 'SUCCESS',
          toolName,
          requiresConfirmation: false,
          data: syncRes,
        };
      }
    }
  }
}
