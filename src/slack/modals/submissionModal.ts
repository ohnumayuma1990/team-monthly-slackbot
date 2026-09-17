import { formatDefaultMonth } from '../../sheets/parser';

export const SUBMISSION_MODAL_CALLBACK_ID = 'team_monthly_submission_modal';

/**
 * Generates options for target month select menu (previous month, current month, next month).
 */
export function generateMonthOptions(): {
  text: { type: 'plain_text'; text: string };
  value: string;
}[] {
  const now = new Date();
  const options = [];

  for (let offset = -1; offset <= 1; offset++) {
    const targetDate = new Date(
      now.getFullYear(),
      now.getMonth() + offset,
      now.getDate()
    );
    const monthStr = formatDefaultMonth(targetDate);
    let label = `${monthStr}`;
    if (offset === 0) label += ' (当月)';

    options.push({
      text: { type: 'plain_text' as const, text: label },
      value: monthStr,
    });
  }

  return options;
}

/**
 * Builds the Slack Block Kit Modal for team monthly submissions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildSubmissionModal(defaultName: string = ''): any {
  const defaultMonth = formatDefaultMonth(new Date());
  const monthOptions = generateMonthOptions();

  return {
    type: 'modal',
    callback_id: SUBMISSION_MODAL_CALLBACK_ID,
    title: {
      type: 'plain_text',
      text: '月次共有事項の入力',
    },
    submit: {
      type: 'plain_text',
      text: 'スプレッドシートへ送信',
    },
    close: {
      type: 'plain_text',
      text: 'キャンセル',
    },
    blocks: [
      {
        type: 'input',
        block_id: 'submission_type_block',
        label: {
          type: 'plain_text',
          text: '1. 入力種別を選択',
        },
        element: {
          type: 'radio_buttons',
          action_id: 'submission_type_action',
          initial_option: {
            text: {
              type: 'plain_text',
              text: '個人セクション（近況・稼働・面談）',
            },
            value: 'individual',
          },
          options: [
            {
              text: {
                type: 'plain_text',
                text: '個人セクション（近況・稼働・面談）',
              },
              value: 'individual',
            },
            {
              text: {
                type: 'plain_text',
                text: 'グループワーク（教える側/教わる側コメント）',
              },
              value: 'groupwork',
            },
            {
              text: {
                type: 'plain_text',
                text: '本日のまとめ・総評（オブザーバー）',
              },
              value: 'observer',
            },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'target_month_block',
        label: {
          type: 'plain_text',
          text: '2. 対象月',
        },
        element: {
          type: 'static_select',
          action_id: 'target_month_action',
          initial_option: {
            text: {
              type: 'plain_text',
              text: `${defaultMonth} (当月)`,
            },
            value: defaultMonth,
          },
          options: monthOptions,
        },
      },
      {
        type: 'input',
        block_id: 'member_name_block',
        label: {
          type: 'plain_text',
          text: '3. 氏名（シートの表記と合わせてください）',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'member_name_action',
          initial_value: defaultName,
          placeholder: {
            type: 'plain_text',
            text: '例: 大沼 佑磨',
          },
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*【個人セクション項目】* （種別で個人を選んだ場合に入力）',
        },
      },
      {
        type: 'input',
        block_id: 'recent_status_block',
        optional: true,
        label: {
          type: 'plain_text',
          text: '近況・困りごと',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'recent_status_action',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: '近況：東芝案件の開発を行っています。\n困っていること：最近寝落ちしてしまう\n分解：寝不足、暑さで疲れている\n組み合わせ：布団に入らず軽くストレッチする',
          },
        },
      },
      {
        type: 'input',
        block_id: 'workload_block',
        optional: true,
        label: {
          type: 'plain_text',
          text: '稼働着地見込み',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'workload_action',
          placeholder: {
            type: 'plain_text',
            text: '例: 140h、150h、残業多め など',
          },
        },
      },
      {
        type: 'input',
        block_id: 'interview_preference_block',
        optional: true,
        label: {
          type: 'plain_text',
          text: '面談希望（対面 / WEB / 不要）',
        },
        element: {
          type: 'static_select',
          action_id: 'interview_preference_action',
          placeholder: {
            type: 'plain_text',
            text: '面談希望を選択',
          },
          initial_option: {
            text: {
              type: 'plain_text',
              text: '不要',
            },
            value: '不要',
          },
          options: [
            {
              text: {
                type: 'plain_text',
                text: '不要',
              },
              value: '不要',
            },
            {
              text: {
                type: 'plain_text',
                text: 'WEB',
              },
              value: 'WEB',
            },
            {
              text: {
                type: 'plain_text',
                text: '対面',
              },
              value: '対面',
            },
          ],
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*【グループワーク項目】* （種別でGWを選んだ場合に入力）',
        },
      },
      {
        type: 'input',
        block_id: 'gw_comment_block',
        optional: true,
        label: {
          type: 'plain_text',
          text: 'GW振り返りコメント（教える側/教わる側）',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'gw_comment_action',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: '教える側の感じたポイント：\n教わる側の感じたポイント：',
          },
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*【総評項目】* （種別でオブザーバーを選んだ場合に入力）',
        },
      },
      {
        type: 'input',
        block_id: 'observer_review_block',
        optional: true,
        label: {
          type: 'plain_text',
          text: '本日のまとめ・総評',
        },
        element: {
          type: 'plain_text_input',
          action_id: 'observer_review_action',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: '定例全体の振り返りや総評コメントをご記入ください。',
          },
        },
      },
    ],
  };
}
