import { IncomingMessage, ServerResponse } from 'http';
import { App, CustomRoute } from '@slack/bolt';
import { ReminderService } from './service';
import { formatDefaultMonth } from '../sheets/parser';
import { WeeklyCheckService } from '../weekly/service';

/**
 * Creates custom routes for Cloud Scheduler reminder trigger and health checks.
 */
export function createCustomRoutes(
  app: App,
  reminderService: ReminderService,
  weeklyService?: WeeklyCheckService
): CustomRoute[] {
  return [
    {
      path: '/health',
      method: ['GET'],
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
          })
        );
      },
    },
    {
      path: '/api/weekly/check',
      method: ['POST', 'GET'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const authHeader = req.headers.authorization || '';
        const expectedSecret = process.env.REMINDER_SECRET_TOKEN;

        if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const channelId = process.env.SLACK_NOTIFICATION_CHANNEL_ID;
        if (!channelId) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'SLACK_NOTIFICATION_CHANNEL_ID is not configured',
            })
          );
          return;
        }

        try {
          const ws = weeklyService || new WeeklyCheckService();
          const result = await ws.runWeeklyCheck(app.client, channelId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error('Weekly check trigger error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errMsg }));
        }
      },
    },
    {
      path: '/api/reminder',
      method: ['POST', 'GET'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        // Simple Bearer token check for security
        const authHeader = req.headers.authorization || '';
        const expectedSecret = process.env.REMINDER_SECRET_TOKEN;

        if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const channelId = process.env.SLACK_NOTIFICATION_CHANNEL_ID;
        if (!channelId) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'SLACK_NOTIFICATION_CHANNEL_ID is not configured',
            })
          );
          return;
        }

        const targetMonth = formatDefaultMonth(new Date());

        try {
          const result = await reminderService.sendChannelReminder(
            app,
            channelId,
            targetMonth
          );

          // If configured to also send direct DMs
          if (process.env.ENABLE_DM_REMINDERS === 'true') {
            await reminderService.sendDirectReminders(app, targetMonth);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              targetMonth,
              unsubmittedCount: result.unsubmittedCount,
            })
          );
        } catch (error: unknown) {
          const errMsg =
            error instanceof Error
              ? error.message
              : 'Failed to trigger reminder';
          console.error('Reminder trigger error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errMsg }));
        }
      },
    },
  ];
}
