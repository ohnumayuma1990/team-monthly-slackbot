import { App } from '@slack/bolt';
import { buildSubmissionModal } from '../modals/submissionModal';

/**
 * Registers slash command handlers (/gw and /monthly).
 */
export function registerCommandHandlers(app: App) {
  // Command handler for /gw
  app.command('/gw', async ({ command, ack, client }) => {
    console.log(`[Command] Received /gw from user ${command.user_id} in channel ${command.channel_id}`);
    await ack();

    try {
      // Attempt to retrieve user's real name or display name to pre-fill
      let defaultName = '';
      try {
        const userInfo = await client.users.info({ user: command.user_id });
        defaultName =
          userInfo.user?.profile?.real_name || userInfo.user?.name || '';
      } catch (e) {
        console.warn('Failed to fetch user info for pre-filling name:', e);
      }

      const modalView = buildSubmissionModal(defaultName);
      // Store channel_id in private_metadata so we can notify both DM and source channel
      modalView.private_metadata = command.channel_id || '';

      await client.views.open({
        trigger_id: command.trigger_id,
        view: modalView,
      });
      console.log(`[Command] Successfully opened modal for trigger_id: ${command.trigger_id}`);
    } catch (error) {
      console.error('Error opening submission modal:', error);
    }
  });

  // Alias command /monthly
  app.command('/monthly', async ({ command, ack, client }) => {
    await ack();

    try {
      let defaultName = '';
      try {
        const userInfo = await client.users.info({ user: command.user_id });
        defaultName =
          userInfo.user?.profile?.real_name || userInfo.user?.name || '';
      } catch (e) {
        console.warn('Failed to fetch user info for pre-filling name:', e);
      }

      const modalView = buildSubmissionModal(defaultName);
      await client.views.open({
        trigger_id: command.trigger_id,
        view: modalView,
      });
    } catch (error) {
      console.error('Error opening submission modal:', error);
    }
  });
}
