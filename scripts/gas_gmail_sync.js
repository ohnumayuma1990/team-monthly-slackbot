/**
 * ==============================================================================
 * Google Apps Script (GAS): 大沼チーム勤怠・重要メール自動連携スクリプト
 * ==============================================================================
 * 
 * 【概要】
 * 大沼さんのGmail受信トレイから、以下のメールを自動検知してCloud RunのSlackBotへ送信します。
 * 1. メンバーの勤怠申請:
 *    件名に "applies" と チームメンバー名が含まれるメール
 *    （例: [applies:40797][全休]2026-09-18 当日申請 小川　智矢）
 *    → Gemini AIが勤怠種別・理由を抽出し、大沼さんのSlack DMにサマリー通知
 * 
 * 2. 全社周知・重要メール:
 *    件名に "allpe" または "t-ohnuma" が含まれるメール、
 *    または 古川さん (furukawa@poweredge.co.jp) からのメール
 *    → Gemini AIが要約し、Slack全体チャンネル (# general) に自動周知
 * 
 * 【設定手順（3分で完了）】
 * 1. ブラウザで Google Apps Script ( https://script.google.com/home ) を開きます。
 * 2. 「新しいプロジェクト」をクリックします。
 * 3. エディタにこのファイルの内容をすべてコピー＆ペーストします。
 * 4. 必要に応じて下記の CONFIG 設定（WEBHOOK_URL など）を確認します。
 * 5. 上部の実行関数で「syncGmailToSlack」を選択し、「実行」をクリックします。
 *    ※ 初回のみ「権限を確認」ポップアップが出るので、大沼さんのGoogleアカウントで許可してください。
 * 6. 左メニューの「トリガー（時計アイコン）」をクリック ＞「トリガーを追加」
 *    - 実行する関数: syncGmailToSlack
 *    - イベントの送信元: 時間手動型
 *    - 時間の間隔: 「時間ベースのタイマー（10分〜30分おき）」または「日付ベースのタイマー（午前8時〜9時）」
 *    ※ 毎朝確実に勤怠を把握したい場合は「毎朝8時〜9時」または「30分おき」がおすすめです。
 * ==============================================================================
 */

const CONFIG = {
  // Cloud RunのWebhookエンドポイント
  WEBHOOK_URL: 'https://team-monthly-slackbot-819933730656.asia-northeast1.run.app/api/daily/gmail',
  
  // REMINDER_SECRET_TOKENを設定している場合はここに入力（未設定なら空文字でOK）
  SECRET_TOKEN: '',
  
  // 処理済みメールに付けるGmailラベル名（重複送信を確実に防止）
  PROCESSED_LABEL: 'SlackBot-Processed',
  
  // Gmail検索クエリ（過去2日以内の対象メールで、未処理ラベルのもの）
  SEARCH_QUERY: '(subject:applies OR subject:allpe OR subject:"t-ohnuma" OR from:furukawa@poweredge.co.jp OR from:furkawa@poweredge.co.jp) -label:SlackBot-Processed newer_than:2d',
  
  // 1回で処理する最大スレッド数
  MAX_THREADS: 20
};

/**
 * メイン関数: Gmailから対象メールを検索し、SlackBotへ送信
 */
function syncGmailToSlack() {
  console.log('--- Gmail同期処理を開始します ---');
  
  // 処理済みラベルの取得または作成
  let processedLabel = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!processedLabel) {
    processedLabel = GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
    console.log('ラベルを作成しました: ' + CONFIG.PROCESSED_LABEL);
  }

  // 検索の実行
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_THREADS);
  console.log('検知された対象スレッド数: ' + threads.length);

  if (threads.length === 0) {
    console.log('新着の対象メールはありません。処理を終了します。');
    return;
  }

  const messagesToSend = [];
  const processedThreads = [];

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const messages = thread.getMessages();

    for (let j = 0; j < messages.length; j++) {
      const msg = messages[j];
      const subject = msg.getSubject() || '';
      const from = msg.getFrom() || '';

      // 条件に合致するか再確認
      const isApplies = /applies/i.test(subject);
      const isAllpe = /allpe/i.test(subject) || /t-ohnuma/i.test(subject);
      const isFurukawa = /furukawa@poweredge\.co\.jp/i.test(from) || /furkawa@poweredge\.co\.jp/i.test(from);

      if (isApplies || isAllpe || isFurukawa) {
        messagesToSend.push({
          id: msg.getId(),
          threadId: thread.getId(),
          date: msg.getDate().toISOString(),
          from: from,
          to: msg.getTo() || '',
          subject: subject,
          body: msg.getPlainBody() || '',
          snippet: msg.getSnippet() || ''
        });
      }
    }
    processedThreads.push(thread);
  }

  if (messagesToSend.length === 0) {
    console.log('送信対象のメッセージがありませんでした。');
    return;
  }

  console.log('SlackBotへ送信するメッセージ件数: ' + messagesToSend.length);

  // Cloud Run WebhookへPOST送信
  const payload = {
    messages: messagesToSend
  };

  const headers = {
    'Content-Type': 'application/json'
  };
  if (CONFIG.SECRET_TOKEN) {
    headers['Authorization'] = 'Bearer ' + CONFIG.SECRET_TOKEN;
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(CONFIG.WEBHOOK_URL, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    console.log('SlackBot応答ステータス: ' + responseCode);
    console.log('SlackBot応答ボディ: ' + responseText);

    if (responseCode >= 200 && responseCode < 300) {
      // 成功した場合のみ、全スレッドに処理済みラベルを付与して次回重複を防ぐ
      for (let k = 0; k < processedThreads.length; k++) {
        processedThreads[k].addLabel(processedLabel);
      }
      console.log('全スレッドに「' + CONFIG.PROCESSED_LABEL + '」ラベルを付与しました。完了！');
    } else {
      console.error('SlackBotへの送信でエラーコードが返されました: ' + responseCode);
    }
  } catch (e) {
    console.error('UrlFetchAppの実行中に例外が発生しました: ' + e.message);
  }
}

/**
 * 接続テスト用関数: Webhookの疎通確認を行います
 */
function testConnection() {
  console.log('--- SlackBotとの接続テスト ---');
  const dummyPayload = {
    messages: [
      {
        id: 'test-' + new Date().getTime(),
        date: new Date().toISOString(),
        from: 'tomoya.ogawa@poweredge.co.jp',
        subject: '[applies:99999][全休]2026-09-18 当日申請 小川　智矢',
        body: '大沼さん、体調不良のため本日全休をいただきます。',
        snippet: '本日全休をいただきます'
      }
    ]
  };

  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.SECRET_TOKEN) headers['Authorization'] = 'Bearer ' + CONFIG.SECRET_TOKEN;

  const res = UrlFetchApp.fetch(CONFIG.WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(dummyPayload),
    muteHttpExceptions: true
  });

  console.log('テスト結果コード: ' + res.getResponseCode());
  console.log('テスト結果ボディ: ' + res.getContentText());
}
