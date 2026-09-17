import { App, AppOptions } from '@slack/bolt';
import { registerCommandHandlers } from './handlers/commands';
import { registerMessageHandlers } from './handlers/messages';
import { registerSubmissionHandlers } from './handlers/submissions';
import { ReminderService } from '../reminder/service';
import { createCustomRoutes } from '../reminder/handler';
import { SheetsService } from '../sheets/service';
import { GeminiService } from '../ai/gemini';
import { WeeklyCheckService } from '../weekly/service';

export interface CreateAppResult {
  app: App;
  sheetsService: SheetsService;
  reminderService: ReminderService;
  geminiService: GeminiService;
  weeklyService: WeeklyCheckService;
}

/**
 * Initializes and configures the Slack Bolt application.
 * Automatically switches between Socket Mode (for local development)
 * and HTTP receiver mode (for Google Cloud Run deployment).
 */
export function createSlackApp(): CreateAppResult {
  const isSocketMode = process.env.SLACK_SOCKET_MODE === 'true';
  const token = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const appToken = process.env.SLACK_APP_TOKEN;

  const sheetsService = new SheetsService();
  const reminderService = new ReminderService(sheetsService);
  const geminiService = new GeminiService();
  const weeklyService = new WeeklyCheckService();

  let appOptions: AppOptions = {
    token,
  };

  if (isSocketMode) {
    if (!appToken) {
      console.warn('SLACK_APP_TOKEN is required when SLACK_SOCKET_MODE=true.');
    }
    appOptions = {
      ...appOptions,
      socketMode: true,
      appToken,
    };
  } else {
    // HTTP Mode for Cloud Run
    appOptions = {
      ...appOptions,
      signingSecret,
      port: Number(process.env.PORT) || 3000,
    };
  }

  const app = new App(appOptions);

  // In HTTP mode, register custom routes with the receiver
  if (!isSocketMode) {
    const routes = createCustomRoutes(app, reminderService, weeklyService);
    // Bolt's default HTTPReceiver supports router custom routes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiver = (app as any).receiver;
    if (receiver && receiver.router) {
      for (const route of routes) {
        const methods = Array.isArray(route.method)
          ? route.method
          : [route.method];
        for (const method of methods) {
          const lowerMethod = method.toLowerCase();
          if (typeof receiver.router[lowerMethod] === 'function') {
            receiver.router[lowerMethod](route.path, route.handler);
          }
        }
      }
    }
  }

  // Register command handlers (/gw, /monthly, /gw-status, /weekly-check)
  registerCommandHandlers(app, sheetsService, weeklyService);

  // Register Slack interaction handlers
  registerMessageHandlers(app, weeklyService);

  // Register view submission handlers
  registerSubmissionHandlers(app, sheetsService, geminiService);

  return {
    app,
    sheetsService,
    reminderService,
    geminiService,
    weeklyService,
  };
}
