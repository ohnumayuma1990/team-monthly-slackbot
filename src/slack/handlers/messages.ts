import { App, BlockAction } from '@slack/bolt';
import { buildSubmissionModal } from '../modals/submissionModal';
import { WeeklyCheckService } from '../../weekly/service';

export const OPEN_MODAL_BUTTON_ACTION_ID = 'open_monthly_modal_button';

/**
 * Registers message listeners (for DMs, mentions) and interactive button clicks.
 */
export function registerMessageHandlers(
  app: App,
  weeklyService: WeeklyCheckService = new WeeklyCheckService()
) {
  // Listen to any text message sent to the bot (e.g. in DM)
  app.message(async ({ message, say, client }) => {
    // Ignore subtype messages (joins, bot messages, edits, etc.)
    if ('subtype' in message && message.subtype) {
      return;
    }

    // Only process standard user messages
    if (!('user' in message) || !message.user) {
      return;
    }

    const rawText = ('text' in message && message.text) || '';

    // Check if the user is asking for weekly check
    if (
      rawText.includes('週報') ||
      rawText.toLowerCase().includes('weekly') ||
      rawText.toLowerCase().includes('check') ||
      rawText.includes('ログイン') ||
      rawText.toLowerCase().includes('gs')
    ) {
      await say('🔍 週報およびGroupSessionの状況を確認中...');
      try {
        const [weeklyReport, gSession] = await Promise.all([
          weeklyService.checkWeeklyReports(),
          weeklyService.checkGSessionLogins(7),
        ]);
        const summary = {
          checkedAt: new Date(),
          weeklyReport,
          gSession,
        };
        const text = weeklyService.generateSummaryMessage(summary);
        await say(text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await say(`⚠️ 確認中にエラーが発生しました: ${msg}`);
      }
      return;
    }

    const userId = message.user;
    console.log(`[Message] Received direct message from user: ${userId}`);

    let defaultName = '';
    try {
      if (userId) {
        const userInfo = await client.users.info({ user: userId });
        defaultName =
          userInfo.user?.profile?.real_name || userInfo.user?.name || '';
      }
    } catch (e) {
      console.warn('Failed to retrieve user info on message:', e);
    }

    const greeting = defaultName ? `${defaultName}さん、` : '';

    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `お疲れ様です！${greeting}月次共有事項の入力ですね。\n「週報」と送信すると週報＆GSの状況を確認できます。\n以下のボタンを押すと入力モーダルが開きます👇`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '📝 月次共有事項を入力する',
                emoji: true,
              },
              action_id: OPEN_MODAL_BUTTON_ACTION_ID,
              style: 'primary',
            },
          ],
        },
      ],
    });
  });

  // Listen to bot mentions (@Bot 週報 など)
  app.event('app_mention', async ({ event, say }) => {
    const rawText = event.text || '';
    if (
      rawText.includes('週報') ||
      rawText.toLowerCase().includes('weekly') ||
      rawText.toLowerCase().includes('check') ||
      rawText.includes('ログイン') ||
      rawText.toLowerCase().includes('gs')
    ) {
      await say('🔍 週報およびGroupSessionの状況を確認中...');
      try {
        const [weeklyReport, gSession] = await Promise.all([
          weeklyService.checkWeeklyReports(),
          weeklyService.checkGSessionLogins(7),
        ]);
        const summary = {
          checkedAt: new Date(),
          weeklyReport,
          gSession,
        };
        const text = weeklyService.generateSummaryMessage(summary);
        await say(text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await say(`⚠️ 確認中にエラーが発生しました: ${msg}`);
      }
      return;
    }

    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `お疲れ様です！\n「週報」と送ると週報＆GroupSessionの状況をチェックします。\n「月次」または以下のボタンで共有事項を入力できます👇`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '📝 月次共有事項を入力する',
                emoji: true,
              },
              action_id: OPEN_MODAL_BUTTON_ACTION_ID,
              style: 'primary',
            },
          ],
        },
      ],
    });
  });

  // Handle button click action to open the submission modal
  app.action<BlockAction>(
    OPEN_MODAL_BUTTON_ACTION_ID,
    async ({ ack, body, client }) => {
      await ack();
      console.log(
        `[Action] User ${body.user.id} clicked open_monthly_modal_button`
      );

      try {
        let defaultName = '';
        try {
          const userInfo = await client.users.info({ user: body.user.id });
          defaultName =
            userInfo.user?.profile?.real_name || userInfo.user?.name || '';
        } catch (e) {
          console.warn('Failed to retrieve user info on button click:', e);
        }

        const modalView = buildSubmissionModal(defaultName);
        modalView.private_metadata = body.channel?.id || body.user.id;

        await client.views.open({
          trigger_id: body.trigger_id,
          view: modalView,
        });
        console.log('[Action] Successfully opened modal from button click');
      } catch (error) {
        console.error('Error opening modal from button click:', error);
      }
    }
  );
}
