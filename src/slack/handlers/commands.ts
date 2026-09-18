import { App } from '@slack/bolt';
import { buildSubmissionModal } from '../modals/submissionModal';
import { SheetsService } from '../../sheets/service';
import { formatDefaultMonth } from '../../sheets/parser';
import {
  WeeklyCheckService,
  formatGSessionScheduleMessage,
} from '../../weekly/service';
import { PydioAttendanceService } from '../../pydio/service';
import { getManagerSlackId } from '../../config/members';

/**
 * Registers slash command handlers (/gw, /monthly, /gw-status, /weekly-check, /attendance-check).
 */
export function registerCommandHandlers(
  app: App,
  sheetsService: SheetsService = new SheetsService(),
  weeklyService: WeeklyCheckService = new WeeklyCheckService(),
  attendanceService: PydioAttendanceService = new PydioAttendanceService()
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
  app.command('/weekly-check', async ({ command, ack, respond, client }) => {
    await ack();

    try {
      const isPublic = command.text.trim().toLowerCase() === 'post';
      let sessionCookie: string | undefined;
      try {
        const loginRes = await weeklyService.loginGSession();
        sessionCookie = loginRes?.sessionCookie;
      } catch (e) {
        console.warn('GroupSession login failed in /weekly-check:', e);
      }

      const [weeklyReport, gSession] = await Promise.all([
        weeklyService.checkWeeklyReports(),
        weeklyService.checkGSessionLogins(7, sessionCookie),
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

        // If posted publicly, deliver manager schedule strictly to manager DM
        try {
          const scheduleDays =
            await weeklyService.fetchGSessionMySchedule(sessionCookie);
          if (scheduleDays.length > 0) {
            const scheduleMsg = formatGSessionScheduleMessage(scheduleDays);
            const managerId = weeklyService.getManagerSlackId();
            if (managerId && client) {
              await client.chat.postMessage({
                channel: managerId,
                text: scheduleMsg,
              });
            }
          }
        } catch (schErr) {
          console.error(
            'Failed to send manager schedule in public /weekly-check:',
            schErr
          );
        }
      } else {
        // Ephemeral response to caller
        try {
          const scheduleDays =
            await weeklyService.fetchGSessionMySchedule(sessionCookie);
          if (scheduleDays.length > 0) {
            statusMessage +=
              '\n\n' + formatGSessionScheduleMessage(scheduleDays);
          }
        } catch (schErr) {
          console.warn(
            'Failed to append schedule to ephemeral weekly-check:',
            schErr
          );
        }

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

    const arg = (command.text || '').trim();

    if (arg === 'help') {
      await respond({
        response_type: 'ephemeral',
        text:
          `💡 */weekly-summary の使い方*\n` +
          `・\`/weekly-summary\`: 最新週の週報要約と週間スケジュールを取得（マネージャーDMへ送信）\n` +
          `・\`/weekly-summary 1\`: 1週間前（先々週）の週報要約を取得\n` +
          `・\`/weekly-summary 2\`: 2週間前の週報要約を取得\n` +
          `・\`/weekly-summary 2026-09-08\`: 指定した日付が含まれる週の週報要約を取得\n` +
          `・\`/weekly-summary help\`: このヘルプを表示`,
      });
      return;
    }

    let options: { offsetWeeks?: number; targetDate?: string } | undefined;
    let targetDesc = '最新の提出済み週報';

    if (/^\d+$/.test(arg)) {
      const offsetWeeks = parseInt(arg, 10);
      options = { offsetWeeks };
      targetDesc = `${offsetWeeks}週前の週報`;
    } else if (/\d{4}[-/]\d{2}[-/]\d{2}/.test(arg)) {
      options = { targetDate: arg };
      targetDesc = `${arg}頃の過去週報`;
    }

    await respond({
      response_type: 'ephemeral',
      text: `⏳ ${targetDesc}とGroupSessionスケジュールを取得しています... 少々お待ちください。`,
    });

    try {
      const result = await weeklyService.runWeeklySummary(
        client,
        command.user_id,
        options
      );
      let reply = `✅ 週報AI要約を作成し、DMへ非公開送信しました！\n\n${result.summaryText}`;
      if (result.scheduleText) {
        reply += `\n\n${result.scheduleText}`;
      }
      await respond({
        response_type: 'ephemeral',
        text: reply,
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

  // Command handler for /my-schedule & /gs-schedule
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleScheduleCommand = async ({
    command,
    ack,
    respond,
    client,
  }: any) => {
    await ack();

    await respond({
      response_type: 'ephemeral',
      text: '⏳ GroupSessionから今週のスケジュールを取得しています...',
    });

    try {
      const scheduleDays = await weeklyService.fetchGSessionMySchedule();
      const scheduleText = formatGSessionScheduleMessage(scheduleDays);

      if (client && command.user_id) {
        try {
          await client.chat.postMessage({
            channel: command.user_id,
            text: scheduleText,
          });
        } catch (dmErr) {
          console.warn('Failed to send DM in schedule command:', dmErr);
        }
      }

      await respond({
        response_type: 'ephemeral',
        text: scheduleText,
      });
    } catch (err: unknown) {
      console.error('Error in schedule command:', err);
      const msg = err instanceof Error ? err.message : String(err);
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ スケジュール取得中にエラーが発生しました:\n${msg}`,
      });
    }
  };

  app.command('/my-schedule', handleScheduleCommand);
  app.command('/gs-schedule', handleScheduleCommand);

  // Command handler for /attendance-check (/pydio-check, /kintai-check)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleAttendanceCommand = async ({ command, ack, respond }: any) => {
    await ack();

    const rawText = (command.text || '').trim();
    const tokens = rawText.split(/\s+/).filter((t: string) => t.length > 0);

    if (tokens.some((t: string) => t.toLowerCase() === 'help')) {
      await respond({
        response_type: 'ephemeral',
        text:
          `💡 */attendance-check（勤怠出勤簿 提出確認）の使い方*\n` +
          `・\`/attendance-check\`: 月初2営業日は前月、月末は当月の提出状況を確認\n` +
          `・\`/attendance-check 202608\`: 指定年月（2026年8月度）の状況を確認\n` +
          `・\`/attendance-check post\`: チャンネル全体に投稿（未提出者へメンション催促）\n` +
          `・\`/attendance-check preview\`: マネージャー実行時でも全体投稿せず非公開プレビュー\n` +
          `※ マネージャー実行時、または \`post\` 指定時はチャンネル全体に周知・催促されます。\n` +
          `※ エイリアス: \`/pydio-check\`, \`/kintai-check\` も利用可能です。`,
      });
      return;
    }

    // Determine target month from arguments if provided (e.g. 202608 or 2026-08)
    const monthToken = tokens.find((t: string) => /^\d{4}[-/]?\d{2}$/.test(t) || /^\d{6}$/.test(t));
    const overrideYearMonth = monthToken ? monthToken.replace(/[^0-9]/g, '') : undefined;

    const isManager = command.user_id === getManagerSlackId();
    const hasPost = tokens.some(
      (t: string) => t.toLowerCase() === 'post' || t.toLowerCase() === 'public'
    );
    const hasPreview = tokens.some(
      (t: string) => t.toLowerCase() === 'preview' || t.toLowerCase() === 'test'
    );

    // Manager execution defaults to public broadcast unless preview is explicitly requested
    const isPublic = (isManager && !hasPreview) || hasPost;

    await respond({
      response_type: 'ephemeral',
      text: `⏳ Pydio 6から勤怠出勤簿の提出状況を確認しています... 少々お待ちください。`,
    });

    try {
      const result = await attendanceService.checkAttendance(overrideYearMonth);
      const message = attendanceService.formatSlackMessage(result, isPublic);

      if (isPublic) {
        await respond({
          response_type: 'in_channel',
          text: message,
        });
      } else {
        const hint =
          '\n\n_(💡 このメッセージはあなただけに表示されています。チャンネル全体へ通知・催促する場合は `/attendance-check post` と入力してください)_';
        await respond({
          response_type: 'ephemeral',
          text: message + hint,
        });
      }
    } catch (err: unknown) {
      console.error('Error in /attendance-check command:', err);
      const msg = err instanceof Error ? err.message : String(err);
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ 勤怠出勤簿の確認中にエラーが発生しました:\n${msg}`,
      });
    }
  };

  app.command('/attendance-check', handleAttendanceCommand);
  app.command('/pydio-check', handleAttendanceCommand);
  app.command('/kintai-check', handleAttendanceCommand);
}


