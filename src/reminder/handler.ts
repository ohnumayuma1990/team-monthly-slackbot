import { IncomingMessage, ServerResponse } from 'http';
import { App, CustomRoute } from '@slack/bolt';
import { ReminderService } from './service';
import { formatDefaultMonth } from '../sheets/parser';
import { WeeklyCheckService } from '../weekly/service';
import { EmailProcessingService } from '../email/service';
import {
  PydioAttendanceService,
  determineAttendanceTarget,
} from '../pydio/service';

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Creates custom routes for Cloud Scheduler reminder trigger and health checks.
 */
export function createCustomRoutes(
  app: App,
  reminderService: ReminderService,
  weeklyService?: WeeklyCheckService,
  emailService?: EmailProcessingService,
  attendanceService?: PydioAttendanceService
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
    {
      path: '/api/daily/gmail',
      method: ['POST'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const authHeader = req.headers.authorization || '';
        const expectedSecret = process.env.REMINDER_SECRET_TOKEN;

        if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        try {
          const bodyText = await readRequestBody(req);
          let parsed: any = {};
          if (bodyText) {
            parsed = JSON.parse(bodyText);
          }

          const rawMessages = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed.messages)
            ? parsed.messages
            : [];

          const es = emailService || new EmailProcessingService();
          const result = await es.processIncomingEmails(rawMessages, app.client);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              totalReceived: rawMessages.length,
              attendanceCount: result.attendanceRecords.length,
              announcementCount: result.announcements.length,
              managerDirectCount: result.managerDirectEmails?.length || 0,
              ignoredCount: result.ignoredCount,
            })
          );
        } catch (error: unknown) {
          const errMsg =
            error instanceof Error ? error.message : String(error);
          console.error('Daily Gmail webhook error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errMsg }));
        }
      },
    },
    {
      path: '/api/attendance/check',
      method: ['POST', 'GET'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const authHeader = req.headers.authorization || '';
        const expectedSecret = process.env.REMINDER_SECRET_TOKEN;

        if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const channelId =
          process.env.SLACK_NOTIFICATION_CHANNEL_ID || 'C0AQETFBF8W';

        const urlStr = req.url || '';
        const monthMatch = urlStr.match(/targetMonth=([^&]+)/);
        const targetMonth = monthMatch ? decodeURIComponent(monthMatch[1]) : undefined;

        try {
          const as = attendanceService || new PydioAttendanceService();
          const result = await as.runAttendanceNotification(
            app.client,
            channelId,
            targetMonth
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              channelId,
              targetMonth: result.result.targetMonth,
              targetFolder: result.result.targetFolder,
              submittedCount: result.result.submitted.length,
              unsubmittedCount: result.result.unsubmitted.length,
              messageSent: result.messageSent,
            })
          );
        } catch (error: unknown) {
          const errMsg =
            error instanceof Error ? error.message : String(error);
          console.error('Attendance check trigger error:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errMsg }));
        }
      },
    },
    {
      path: '/api/daily/run',
      method: ['POST', 'GET'],
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const authHeader = req.headers.authorization || '';
        const expectedSecret = process.env.REMINDER_SECRET_TOKEN;

        if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        // Check JST time: UTC + 9 hours
        const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const dayOfWeek = jstNow.getUTCDay(); // 2 = Tuesday
        const hour = jstNow.getUTCHours(); // JST hour
        const urlStr = req.url || '';
        const isForceWeekly = urlStr.includes('forceWeekly=true');
        const isForceAttendance = urlStr.includes('forceAttendance=true');

        // Tuesday 11:00-13:00 JST, or forced
        const shouldRunWeekly =
          isForceWeekly || (dayOfWeek === 2 && hour >= 11 && hour <= 13);

        // Attendance target folder & schedule calculation
        const attendanceTarget = determineAttendanceTarget(jstNow);
        // Automatically run attendance check on first 2 business days or month-end business days
        const shouldRunAttendance =
          isForceAttendance ||
          attendanceTarget.isFirstTwoBusinessDays ||
          attendanceTarget.isMonthEndBusinessDays;

        const channelId =
          process.env.SLACK_NOTIFICATION_CHANNEL_ID || 'C0AQETFBF8W';

        let weeklyResult = null;
        if (shouldRunWeekly && channelId) {
          try {
            const ws = weeklyService || new WeeklyCheckService();
            weeklyResult = await ws.runWeeklyCheck(app.client, channelId);
          } catch (wErr) {
            console.error('Automated weekly check in daily run failed:', wErr);
          }
        }

        let attendanceResult = null;
        if (shouldRunAttendance && channelId) {
          try {
            const as = attendanceService || new PydioAttendanceService();
            attendanceResult = await as.runAttendanceNotification(
              app.client,
              channelId,
              attendanceTarget.targetMonth
            );
          } catch (aErr) {
            console.error('Automated attendance check in daily run failed:', aErr);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            jstTime: jstNow.toISOString(),
            dayOfWeek,
            hour,
            triggeredWeekly: shouldRunWeekly,
            weeklyResult,
            triggeredAttendance: shouldRunAttendance,
            attendanceTarget,
            attendanceResult: attendanceResult
              ? {
                  targetMonth: attendanceResult.result.targetMonth,
                  submittedCount: attendanceResult.result.submitted.length,
                  unsubmittedCount: attendanceResult.result.unsubmitted.length,
                  messageSent: attendanceResult.messageSent,
                }
              : null,
          })
        );
      },
    },
  ];
}
