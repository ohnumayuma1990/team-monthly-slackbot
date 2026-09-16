import { App } from '@slack/bolt';
import { SheetsService } from '../sheets/service';
import { normalizeName } from '../sheets/parser';
import { UnsubmittedMember } from '../types';

export class ReminderService {
  private sheetsService: SheetsService;
  private memberSlackMap: Map<string, string>; // Normalized name -> Slack User ID

  constructor(sheetsService?: SheetsService) {
    this.sheetsService = sheetsService || new SheetsService();
    this.memberSlackMap = new Map();
    this.loadMemberMappings();
  }

  /**
   * Loads member Slack mappings from MEMBER_SLACK_MAPPING env (e.g. JSON string {"大沼佑磨": "U12345678"}).
   */
  private loadMemberMappings() {
    const mappingJson = process.env.MEMBER_SLACK_MAPPING;
    if (mappingJson) {
      try {
        const parsed = JSON.parse(mappingJson);
        for (const [name, slackId] of Object.entries(parsed)) {
          this.memberSlackMap.set(normalizeName(name), slackId as string);
        }
      } catch (e) {
        console.warn(
          'Failed to parse MEMBER_SLACK_MAPPING environment variable:',
          e
        );
      }
    }
  }

  /**
   * Finds unsubmitted members for the specified month and attaches Slack User IDs if mapped.
   */
  async getUnsubmittedList(sheetName: string): Promise<UnsubmittedMember[]> {
    const unsubmitted =
      await this.sheetsService.getUnsubmittedMembers(sheetName);

    return unsubmitted.map((m) => {
      const slackId = this.memberSlackMap.get(normalizeName(m.name));
      return {
        ...m,
        slackUserId: slackId,
      };
    });
  }

  /**
   * Sends a reminder broadcast to a designated Slack channel.
   */
  async sendChannelReminder(
    app: App,
    channelId: string,
    sheetName: string
  ): Promise<{ sent: boolean; unsubmittedCount: number; message: string }> {
    const unsubmitted = await this.getUnsubmittedList(sheetName);

    if (unsubmitted.length === 0) {
      const allDoneMessage = `🎉 【月次定例リマインド】\nシート「*${sheetName}*」の全員の入力が完了しています！ご協力ありがとうございます。`;
      await app.client.chat.postMessage({
        channel: channelId,
        text: allDoneMessage,
      });
      return { sent: true, unsubmittedCount: 0, message: allDoneMessage };
    }

    const mentions = unsubmitted.map((m) => {
      const mentionStr = m.slackUserId
        ? `<@${m.slackUserId}>`
        : `*${m.name}* さん`;
      const missingList: string[] = [];
      if (m.missingIndividual) missingList.push('個人近況');
      if (m.missingGroupwork) missingList.push('GW振り返り');
      return `• ${mentionStr} （未入力: ${missingList.join(', ')}）`;
    });

    const reminderText =
      `📢 *【月次定例 共有事項のご記入のお願い】*\n\n` +
      `シート「*${sheetName}*」の定例前入力の締め切りが近づいています。\n` +
      `Slackで \`/gw\` コマンドを実行するか、スプレッドシートよりご記入をお願いします！\n\n` +
      `*現在の未入力メンバー:*\n` +
      mentions.join('\n') +
      `\n\n入力完了のご協力よろしくお願いいたします！🙇`;

    await app.client.chat.postMessage({
      channel: channelId,
      text: reminderText,
    });

    return {
      sent: true,
      unsubmittedCount: unsubmitted.length,
      message: reminderText,
    };
  }

  /**
   * Optionally sends direct messages (DM) to each unsubmitted member.
   */
  async sendDirectReminders(
    app: App,
    sheetName: string
  ): Promise<{ notifiedCount: number }> {
    const unsubmitted = await this.getUnsubmittedList(sheetName);
    let notifiedCount = 0;

    for (const member of unsubmitted) {
      if (member.slackUserId) {
        try {
          const missingList: string[] = [];
          if (member.missingIndividual) missingList.push('個人近況');
          if (member.missingGroupwork) missingList.push('GW振り返り');

          await app.client.chat.postMessage({
            channel: member.slackUserId,
            text:
              `お疲れ様です！月次定例ボットです。\n` +
              `「*${sheetName}*」の共有事項（未入力: ${missingList.join(', ')}）の記入をお願いします。\n` +
              `Slack上で \`/gw\` コマンドを入力すると、簡単にモーダルから送信できます！`,
          });
          notifiedCount++;
        } catch (e) {
          console.error(
            `Failed to send DM reminder to ${member.name} (${member.slackUserId}):`,
            e
          );
        }
      }
    }

    return { notifiedCount };
  }
}
