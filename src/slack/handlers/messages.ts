import { App, BlockAction } from '@slack/bolt';
import { buildSubmissionModal } from '../modals/submissionModal';

export const OPEN_MODAL_BUTTON_ACTION_ID = 'open_monthly_modal_button';

/**
 * Registers message listeners (for DMs) and interactive button clicks.
 */
export function registerMessageHandlers(app: App) {
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
            text: `お疲れ様です！${greeting}月次共有事項の入力ですね。\n以下のボタンを押すと入力モーダルが開きます👇`,
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
  app.action<BlockAction>(OPEN_MODAL_BUTTON_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    console.log(`[Action] User ${body.user.id} clicked open_monthly_modal_button`);

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
  });
}
