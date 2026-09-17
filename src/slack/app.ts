import { App, HTTPReceiver } from '@slack/bolt';
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
  const token = process.env.SLACK_BOT_TOKEN || 'xoxb-placeholder-token';
  const signingSecret =
    process.env.SLACK_SIGNING_SECRET || 'placeholder-signing-secret';
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!process.env.SLACK_BOT_TOKEN) {
    console.warn(
      '⚠️ SLACK_BOT_TOKEN is not configured in environment variables. Running in placeholder mode.'
    );
  }

  const sheetsService = new SheetsService();
  const reminderService = new ReminderService(sheetsService);
  const geminiService = new GeminiService();
  const weeklyService = new WeeklyCheckService(geminiService);

  let app: App;

  if (isSocketMode) {
    if (!appToken) {
      console.warn('SLACK_APP_TOKEN is required when SLACK_SOCKET_MODE=true.');
    }
    app = new App({
      token,
      socketMode: true,
      appToken,
    });
  } else {
    // HTTP Mode for Cloud Run
    // Use Bolt's HTTPReceiver with custom routes for Cloud Scheduler and health checks
    const receiver = new HTTPReceiver({
      signingSecret: signingSecret || 'placeholder-signing-secret',
      port: Number(process.env.PORT) || 8080,
      customRoutes: [],
    });

    app = new App({
      token,
      receiver,
      tokenVerificationEnabled: false,
    });

    // Register routes with app reference
    const routes = createCustomRoutes(app, reminderService, weeklyService);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const buildRoutes = require('@slack/bolt/dist/receivers/custom-routes').buildReceiverRoutes;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (receiver as any).routes = buildRoutes(routes);
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
