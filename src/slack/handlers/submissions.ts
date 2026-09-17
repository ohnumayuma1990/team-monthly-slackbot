import { App } from '@slack/bolt';
import { SUBMISSION_MODAL_CALLBACK_ID } from '../modals/submissionModal';
import { SheetsService } from '../../sheets/service';
import { MonthlySubmission, SubmissionType } from '../../types';
import { GeminiService } from '../../ai/gemini';

export function registerSubmissionHandlers(
  app: App,
  sheetsService: SheetsService = new SheetsService(),
  geminiService: GeminiService = new GeminiService()
) {
  app.view(
    SUBMISSION_MODAL_CALLBACK_ID,
    async ({ ack, view, body, client }) => {
      console.log(
        `[ViewSubmission] Received modal submission from user ${body.user.id}, callback_id: ${view.callback_id}`
      );
      const values = view.state.values;

      // 1. Extract values
      const submissionType = values.submission_type_block
        ?.submission_type_action?.selected_option?.value as SubmissionType;
      const targetMonth =
        values.target_month_block?.target_month_action?.selected_option
          ?.value || '';
      const memberName =
        values.member_name_block?.member_name_action?.value?.trim() || '';

      console.log(
        `[ViewSubmission] Parsed type=${submissionType}, month=${targetMonth}, name=${memberName}`
      );

      // Validate name
      if (!memberName) {
        console.log('[ViewSubmission] Validation failed: memberName is empty');
        await ack({
          response_action: 'errors',
          errors: {
            member_name_block: '氏名を入力してください。',
          },
        });
        return;
      }

      // Acknowledge submission immediately
      await ack();
      console.log('[ViewSubmission] Acknowledged view_submission');

      // 2. Build submission payload
      const submission: MonthlySubmission = {
        targetMonth,
        type: submissionType || 'individual',
      };

      let statusTextForGemini = '';

      if (submissionType === 'individual') {
        const recentStatus =
          values.recent_status_block?.recent_status_action?.value || '';
        const workloadLanding =
          values.workload_block?.workload_action?.value || '';
        const interviewPreference =
          values.interview_preference_block?.interview_preference_action
            ?.selected_option?.value || '希望なし';

        statusTextForGemini = recentStatus;
        submission.individual = {
          name: memberName,
          recentStatus,
          workloadLanding,
          interviewPreference,
        };
      } else if (submissionType === 'groupwork') {
        const gwComment =
          values.gw_comment_block?.gw_comment_action?.value || '';
        submission.groupwork = {
          name: memberName,
          gwComment,
        };
      } else if (submissionType === 'observer') {
        const generalReview =
          values.observer_review_block?.observer_review_action?.value || '';
        submission.observer = {
          name: memberName,
          generalReview,
        };
      }

      // 3. Save to Google Sheets
      const userId = body.user.id;
      try {
        const result = await sheetsService.submitData(submission);

        if (result.success) {
          let confirmationText = `✅ ${result.message}`;

          // Optional: Generate friendly Gemini AI feedback if member provided status
          if (
            submissionType === 'individual' &&
            statusTextForGemini &&
            geminiService.isConfigured()
          ) {
            const aiHint = await geminiService.generateConcernHint(
              memberName,
              statusTextForGemini
            );
            if (aiHint) {
              confirmationText += `\n\n💡 *AIからのワンポイントコメント:*\n${aiHint}`;
            }
          }

          // Send response to user via conversations.open (guarantees DM delivery)
          const sourceChannel = view.private_metadata || '';
          console.log(
            `[ViewSubmission] Sending confirmation for user ${userId}, sourceChannel: ${sourceChannel}`
          );

          // 1. Always send to the user's direct message with MonthlyBot
          try {
            const conversation = await client.conversations.open({
              users: userId,
            });
            const dmChannelId = conversation.channel?.id;
            if (dmChannelId) {
              await client.chat.postMessage({
                channel: dmChannelId,
                text: confirmationText,
              });
              console.log(
                `[ViewSubmission] Sent confirmation to user DM channel: ${dmChannelId}`
              );
            }
          } catch (dmErr) {
            console.error(
              '[ViewSubmission] Failed to open/send DM with user:',
              dmErr
            );
          }

          // 2. If executed from a public/private team channel (starts with 'C'), also post ephemeral
          if (sourceChannel && sourceChannel.startsWith('C')) {
            try {
              await client.chat.postEphemeral({
                channel: sourceChannel,
                user: userId,
                text: confirmationText,
              });
              console.log(
                `[ViewSubmission] Sent ephemeral message to channel ${sourceChannel}`
              );
            } catch (chErr) {
              console.warn(
                '[ViewSubmission] Could not send ephemeral to channel:',
                chErr
              );
            }
          }
        } else {
          try {
            const conversation = await client.conversations.open({
              users: userId,
            });
            if (conversation.channel?.id) {
              await client.chat.postMessage({
                channel: conversation.channel.id,
                text: `⚠️ スプレッドシートへの保存で確認事項があります:\n${result.message}\n(スプレッドシートの表記名やタブ名をご確認ください)`,
              });
            }
          } catch (e) {
            console.error('Error sending fallback error notification:', e);
          }
        }
      } catch (error: unknown) {
        console.error('Error submitting data to Google Sheets:', error);
        const errMsg =
          error instanceof Error
            ? error.message
            : 'スプレッドシートへの更新に失敗しました。';
        await client.chat.postMessage({
          channel: userId,
          text: `❌ エラーが発生しました: ${errMsg}`,
        });
      }
    }
  );
}
