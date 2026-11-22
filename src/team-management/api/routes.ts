import { IncomingMessage, ServerResponse } from 'http';
import { CustomRoute } from '@slack/bolt';
import {
  TeamManagementAgent,
  TeamManagementToolName,
} from '../agent/team-management-agent';
import {
  requireAdminUser,
  requireCronAuth,
  requireExternalAgentAuth,
} from '../auth/guard';
import {
  ExternalAgentScope,
  SyncMode,
  TeamManagementError,
} from '../core/types';
import { TeamManagementSyncService } from '../sync/sync-service';
import { renderTeamManagementDashboardHtml } from '../ui/dashboard';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', (err) => reject(err));
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function handleError(res: ServerResponse, err: unknown): void {
  if (err instanceof TeamManagementError) {
    sendJson(res, err.httpStatus, {
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  const msg = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: msg,
    },
  });
}

function parseQueryParam(urlStr: string | undefined, key: string): string {
  if (!urlStr) return '';
  const qIdx = urlStr.indexOf('?');
  if (qIdx === -1) return '';
  const params = new URLSearchParams(urlStr.slice(qIdx + 1));
  return (params.get(key) || '').trim();
}

/**
 * Creates Common API routes, Admin Dashboard route, Cron sync route, and External Agent route.
 * Follows the 4 confirmed pathways:
 * 1. Management Dashboard -> Common API directly
 * 2. Existing Copilot Mode -> Team Management Agent -> Common API
 * 3. Future Custom App -> External Agent Endpoint -> Common API
 * 4. Scheduled Sync Job -> TeamManagementSyncService directly
 */
export function createTeamManagementRoutes(options?: {
  syncService?: TeamManagementSyncService;
  agent?: TeamManagementAgent;
}): CustomRoute[] {
  const syncService = options?.syncService ?? new TeamManagementSyncService();
  const agent = options?.agent ?? new TeamManagementAgent(syncService);

  return [
    // Pathway 1 (Common API): Aggregated Overview (2-3 Firestore Reads)
    {
      path: '/api/team-management/overview',
      method: ['GET'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          requireAdminUser(req.headers);
          const overview = await syncService.getOverview();
          sendJson(res, 200, {
            success: true,
            ...overview,
          });
        } catch (err) {
          handleError(res, err);
        }
      },
    },

    // Pathway 1 (Common API): Weekly Snapshot, Details & AI Summary
    {
      path: '/api/team-management/weekly',
      method: ['GET'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          requireAdminUser(req.headers);
          const weekId = parseQueryParam(req.url, 'weekId') || undefined;
          const weekly = await syncService.getWeeklyData(weekId);
          sendJson(res, 200, {
            success: true,
            ...weekly,
          });
        } catch (err) {
          handleError(res, err);
        }
      },
    },

    // Pathway 1 (Common API): Weekly Details & AI Summary Generation (requires confirmExternalRead: true if not cached)
    {
      path: '/api/team-management/weekly/summarize',
      method: ['POST'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const admin = requireAdminUser(req.headers);
          const bodyStr = await readBody(req);
          const parsedBody = bodyStr ? JSON.parse(bodyStr) : {};
          const weekId =
            typeof parsedBody.weekId === 'string' && parsedBody.weekId.trim()
              ? parsedBody.weekId.trim()
              : parseQueryParam(req.url, 'weekId') || undefined;
          const confirmExternalRead = parsedBody.confirmExternalRead === true;

          const result = await syncService.summarizeWeek({
            weekId,
            confirmExternalRead,
            triggeredBy: admin.email || admin.userId,
            triggerType: 'MANUAL_DASHBOARD',
          });

          sendJson(res, 200, {
            success: true,
            ...result,
          });
        } catch (err) {
          handleError(res, err);
        }
      },
    },

    // Pathway 1 (Common API): Manual Sync Trigger (defaults to STATUS_ONLY)
    {
      path: '/api/team-management/sync',
      method: ['POST'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const admin = requireAdminUser(req.headers);
          const bodyStr = await readBody(req);
          const parsedBody = bodyStr ? JSON.parse(bodyStr) : {};
          const mode: SyncMode =
            parsedBody.mode === 'WITH_DETAILS' ? 'WITH_DETAILS' : 'STATUS_ONLY';
          const confirmExternalRead = parsedBody.confirmExternalRead === true;

          const syncResult = await syncService.runSync({
            mode,
            confirmExternalRead,
            triggerType: 'MANUAL_DASHBOARD',
            triggeredBy: admin.email || admin.userId,
          });

          sendJson(res, 200, {
            success: true,
            ...syncResult,
          });
        } catch (err) {
          handleError(res, err);
        }
      },
    },

    // Pathway 4 (Scheduled Cron Job -> Common Business Logic directly)
    {
      path: '/api/internal/team-management/cron/sync',
      method: ['POST'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          requireCronAuth(req.headers);
          const bodyStr = await readBody(req);
          const parsedBody = bodyStr ? JSON.parse(bodyStr) : {};
          const mode: SyncMode =
            parsedBody.mode === 'WITH_DETAILS' ? 'WITH_DETAILS' : 'STATUS_ONLY';
          const confirmExternalRead = parsedBody.confirmExternalRead === true;

          const syncResult = await syncService.runSync({
            mode,
            confirmExternalRead,
            triggerType: 'SCHEDULED_CRON',
            triggeredBy: 'cloud_scheduler',
          });

          sendJson(res, 200, {
            success: true,
            ...syncResult,
          });
        } catch (err) {
          handleError(res, err);
        }
      },
    },

    // Pathway 3 (Future Custom App -> Dedicated Auth Guard -> Team Management Agent -> Common API)
    {
      path: '/api/external/agent/team-management',
      method: ['POST'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const bodyStr = await readBody(req);
          const parsedBody = bodyStr ? JSON.parse(bodyStr) : {};
          const toolName = parsedBody.tool as TeamManagementToolName;
          const args =
            parsedBody.arguments && typeof parsedBody.arguments === 'object'
              ? (parsedBody.arguments as Record<string, unknown>)
              : {};

          const requiredScope: ExternalAgentScope =
            toolName === 'trigger_team_management_sync'
              ? 'team:sync'
              : 'team:read';

          const clientCtx = requireExternalAgentAuth(
            req.headers,
            requiredScope
          );

          const result = await agent.executeTool(toolName, args, {
            type: 'external_app',
            client: clientCtx,
          });

          sendJson(res, 200, {
            success: true,
            clientId: clientCtx.clientId,
            result,
          });
        } catch (err) {
          handleError(res, err);
        }
      },
    },

    // Pathway 1 UI: Administrator Management Dashboard
    {
      path: '/admin/team-management',
      method: ['GET'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          requireAdminUser(req.headers);
          const overview = await syncService.getOverview();
          const html = renderTeamManagementDashboardHtml(overview);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          handleError(res, err);
        }
      },
    },
  ];
}
