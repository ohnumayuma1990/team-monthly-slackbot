import { App } from '@slack/bolt';
import { buildSubmissionModal } from '../modals/submissionModal';
import { SheetsService } from '../../sheets/service';
import { formatDefaultMonth } from '../../sheets/parser';
import { WeeklyCheckService } from '../../weekly/service';

/**
 * Registers slash command handlers (/gw, /monthly, /gw-status, /weekly-check).
 */
export function registerCommandHandlers(
  app: App,
  sheetsService: SheetsService = new SheetsService(),
  weeklyService: WeeklyCheckService = new WeeklyCheckService()
) {
  // Command handler for /gw
  app.command('/gw', async ({ command, ack, client }) => {
    console.log(
      `[Command] Received /gw from user ${command.user_id} in channel ${command.channel_id}`
    );
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
      modalView.private_metadata = command.channel_id || '';

      await client.views.open({
        trigger_id: command.trigger_id,
        view: modalView,
      });
      console.log(
        `[Command] Successfully opened modal for trigger_id: ${command.trigger_id}`
      );
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

  // Status check command: /gw-status
  app.command('/gw-status', async ({ command, ack, respond }) => {
    await ack();

    const targetMonth = command.text.trim() || formatDefaultMonth();
    try {
      const parsed = await sheetsService.getParsedSheet(targetMonth);

      const submittedIndiv = parsed.individualRows.filter(
        (r) => r.recentStatus && r.recentStatus.trim().length > 0
      );
      const unsubmittedIndiv = parsed.individualRows.filter(
        (r) => !r.recentStatus || r.recentStatus.trim().length === 0
      );

      const submittedGw = parsed.groupworkRows.filter(
        (r) => r.comment && r.comment.trim().length > 0
      );
      const unsubmittedGw = parsed.groupworkRows.filter(
        (r) => !r.comment || r.comment.trim().length === 0
      );

      const submittedIndivNames =
        submittedIndiv.map((r) => r.name).join('、') || '（なし）';
      const unsubmittedIndivNames =
        unsubmittedIndiv.map((r) => r.name).join('、') ||
        '（なし・全員提出済み🎉）';

      const submittedGwNames =
        submittedGw.map((r) => r.name).join('、') || '（なし）';
      const unsubmittedGwNames =
        unsubmittedGw.map((r) => r.name).join('、') ||
        '（なし・全員提出済み🎉）';

      const statusMessage =
        `📊 *【${targetMonth}】共有事項・提出進捗状況*\n\n` +
        `*1. 個人セクション（近況・稼働）*\n` +
        `  ✅ *提出済み (${submittedIndiv.length}名):* ${submittedIndivNames}\n` +
        `  ⏳ *未提出 (${unsubmittedIndiv.length}名):* ${unsubmittedIndivNames}\n\n` +
        `*2. グループワークコメント*\n` +
        `  ✅ *提出済み (${submittedGw.length}名):* ${submittedGwNames}\n` +
        `  ⏳ *未提出 (${unsubmittedGw.length}名):* ${unsubmittedGwNames}`;

      await respond({
        response_type: 'ephemeral',
        text: statusMessage,
      });
    } catch (err: unknown) {
      console.error('Error in /gw-status command:', err);
      const msg = err instanceof Error ? err.message : String(err);
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ シート「${targetMonth}」の状況取得に失敗しました:\n${msg}\n（※シートタブの存在やGoogleサービスアカウント権限をご確認ください）`,
      });
    }
  });

  // Command handler for /weekly-check (Weekly report & GroupSession login check)
  app.command('/weekly-check', async ({ command, ack, respond }) => {
    await ack();

    try {
      const isPublic = command.text.trim().toLowerCase() === 'post';
      const [weeklyReport, gSession] = await Promise.all([
        weeklyService.checkWeeklyReports(),
        weeklyService.checkGSessionLogins(7),
      ]);

      const summary = {
        checkedAt: new Date(),
        weeklyReport,
        gSession,
      };

      let statusMessage = weeklyService.generateSummaryMessage(summary);

      if (isPublic) {
        await respond({
          response_type: 'in_channel',
          text: statusMessage,
        });
      } else {
        statusMessage +=
          '\n\n_(💡 このメッセージはあなただけに表示されています。チャンネル全体に投稿する場合は `/weekly-check post` と入力してください)_';
        await respond({
          response_type: 'ephemeral',
          text: statusMessage,
        });
      }
    } catch (err: unknown) {
      console.error('Error in /weekly-check command:', err);
      const msg = err instanceof Error ? err.message : String(err);
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ 週報・GroupSessionチェックの実行中にエラーが発生しました:\n${msg}`,
      });
    }
  });

  // Command handler for /weekly-summary (AI Weekly Report Summary - Private for Manager)
  app.command('/weekly-summary', async ({ command, ack, respond, client }) => {
    await ack();

    await respond({
      response_type: 'ephemeral',
      text: '⏳ 最新の提出済み週報を取得し、Gemini AIで要約を作成しています... 少々お待ちください。',
    });

    try {
      const result = await weeklyService.runWeeklySummary(client, command.user_id);
      await respond({
        response_type: 'ephemeral',
        text: `✅ 週報AI要約を作成し、DMへ非公開送信しました！\n\n${result.summaryText}`,
      });
    } catch (err: unknown) {
      console.error('Error in /weekly-summary command:', err);
      const msg = err instanceof Error ? err.message : String(err);
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ 週報AI要約の作成中にエラーが発生しました:\n${msg}`,
      });
    }
  });
}


