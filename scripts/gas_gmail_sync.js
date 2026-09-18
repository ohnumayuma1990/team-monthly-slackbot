/**
 * ==============================================================================
 * Google Apps Script (GAS): 勤怠・重要メール自動連携スクリプト
 * ==============================================================================
 * 
 * 【概要】
 * Gmail受信トレイから、以下のメールを自動検知してCloud RunのSlackBotへ送信します。
 * 1. メンバーの勤怠申請:
 *    件名に "applies" と チームメンバー名が含まれるメール
 *    （例: [applies:40797][全休]2026-09-18 当日申請 メンバー名）
 *    → Gemini AIが勤怠種別・理由を抽出し、マネージャーのSlack DMにサマリー通知
 * 
 * 2. 全社周知・重要メール:
 *    件名に "allpe" 等が含まれるメール、または指定の送信者からのメール
 *    → Gemini AIが要約し、Slack全体チャンネル (# general) またはマネージャーDMに自動通知
 * 
 * 【設定手順（3分で完了）】
 * 1. ブラウザで Google Apps Script ( https://script.google.com/home ) を開きます。
 * 2. 「新しいプロジェクト」をクリックします。
 * 3. エディタにこのファイルの内容をすべてコピー＆ペーストします。
 * 4. 必要に応じて下記の CONFIG 設定（WEBHOOK_URL, FROM_EMAILS など）を確認します。
 * 5. 上部の実行関数で「syncGmailToSlack」を選択し、「実行」をクリックします。
 *    ※ 初回のみ「権限を確認」ポップアップが出るので、Googleアカウントで許可してください。
 * 6. 左メニューの「トリガー（時計アイコン）」をクリック ＞「トリガーを追加」
 *    - 実行する関数: syncGmailToSlack
 *    - イベントの送信元: 時間手動型
 *    - 時間の間隔: 「時間ベースのタイマー（10分〜30分おき）」または「日付ベースのタイマー（午前8時〜9時）」
 * 7. 【Slackコマンド（/gmail-check）から即時実行したい場合】
 *    - 右上の青い「デプロイ」ボタン ＞「新しいデプロイ」をクリック
 *    - 種類の選択（歯車アイコン）:「ウェブアプリ」を選択
 *    - 説明:「Gmail Sync Webhook」など
 *    - 次のユーザーとして実行:「自分」
 *    - アクセスできるユーザー:「全員」
 *    - 「デプロイ」をクリックし、発行された「ウェブアプリのURL」をコピー
 *    - Cloud Run の環境変数 `GAS_GMAIL_SYNC_URL` に設定します。
 * ==============================================================================
 */

const CONFIG = {
  // Cloud RunのWebhookエンドポイント
  WEBHOOK_URL: 'https://team-monthly-slackbot-819933730656.asia-northeast1.run.app/api/daily/gmail',
  
  // REMINDER_SECRET_TOKENを設定している場合はここに入力（未設定なら空文字でOK）
  SECRET_TOKEN: '',
  
  // 処理済みメールに付けるGmailラベル名（重複送信を確実に防止）
  PROCESSED_LABEL: 'SlackBot-Processed',
  
  // 検索対象の件名キーワード（カンマ区切りで複数指定。マネージャー報告用キーワード等も必要に応じて追加可能）
  KEYWORDS: 'applies, allpe',

  // 検索対象の送信者メールアドレス（カンマ区切りで複数指定。空文字なら件名キーワードのみで検索。例: 'boss@example.com'）
  FROM_EMAILS: '',

  // 検索開始時刻（昨日のこの時刻以降のメールを網羅的に検索。デフォルト: 12:00）
  SEARCH_START_HOUR: 12,

  // 1回で処理する最大スレッド数
  MAX_THREADS: 30
};

/**
 * 検索開始日時（昨日の12:00:00）を計算
 */
function getSearchSinceDate() {
  var now = new Date();
  var startHour = CONFIG.SEARCH_START_HOUR !== undefined ? CONFIG.SEARCH_START_HOUR : 12;
  var yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, startHour, 0, 0);
  return yesterdayNoon;
}

/**
 * キーワードとメールアドレスからGmail検索クエリを動的に生成
 * 昨日の12:00以降の未処理メールを網羅的に検索
 */
function buildSearchQuery() {
  const parts = [];
  const keywords = CONFIG.KEYWORDS.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  const emails = CONFIG.FROM_EMAILS.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

  for (var i = 0; i < keywords.length; i++) {
    var kw = keywords[i];
    if (kw.indexOf('-') !== -1 || kw.indexOf(' ') !== -1) {
      parts.push('subject:"' + kw + '"');
    } else {
      parts.push('subject:' + kw);
    }
  }

  for (var j = 0; j < emails.length; j++) {
    parts.push('from:' + emails[j]);
  }

  var baseFilter = parts.length > 0 ? '(' + parts.join(' OR ') + ')' : '';
  var sinceDate = getSearchSinceDate();
  var epochSeconds = Math.floor(sinceDate.getTime() / 1000);

  // after:秒単位タイムスタンプで「昨日の12:00以降」を正確に指定
  return baseFilter + ' -label:' + CONFIG.PROCESSED_LABEL + ' after:' + epochSeconds;
}

/**
 * メイン関数: Gmailから対象メールを検索し、SlackBotへ送信
 */
function syncGmailToSlack() {
  console.log('--- Gmail同期処理を開始します ---');
  
  // 処理済みラベルの取得または作成
  var processedLabel = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL);
  if (!processedLabel) {
    processedLabel = GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
    console.log('ラベルを作成しました: ' + CONFIG.PROCESSED_LABEL);
  }

  var query = buildSearchQuery();
  var sinceDate = getSearchSinceDate();
  console.log('検索開始起点（昨日の12:00）: ' + sinceDate.toLocaleString('ja-JP'));
  console.log('実行検索クエリ: ' + query);

  // 検索の実行
  var threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  console.log('検知された対象スレッド数: ' + threads.length);

  if (threads.length === 0) {
    console.log('新着の対象メールはありません。処理を終了します。');
    return;
  }

  var keywords = CONFIG.KEYWORDS.toLowerCase().split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  var emails = CONFIG.FROM_EMAILS.toLowerCase().split(',').map(function(s) { return s.trim(); }).filter(Boolean);

  var messagesToSend = [];
  var processedThreads = [];

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();

    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      // 昨日の12:00より前の古いメールは確実に除外
      if (msg.getDate().getTime() < sinceDate.getTime()) {
        continue;
      }
      var subject = msg.getSubject() || '';
      var from = msg.getFrom() || '';
      var subLower = subject.toLowerCase();
      var fromLower = from.toLowerCase();

      // 条件に合致するか再確認
      var isKeywordMatch = keywords.some(function(kw) { return subLower.indexOf(kw) !== -1; });
      var isEmailMatch = emails.some(function(em) { return fromLower.indexOf(em) !== -1; });

      if (isKeywordMatch || isEmailMatch) {
        var plainText = msg.getPlainBody() || '';
        messagesToSend.push({
          id: msg.getId(),
          threadId: thread.getId(),
          date: msg.getDate().toISOString(),
          from: from,
          to: msg.getTo() || '',
          subject: subject,
          body: plainText,
          snippet: plainText.slice(0, 150).replace(/[\r\n\s]+/g, ' ')
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
      return {
        success: true,
        threadsFound: threads.length,
        messagesSent: messagesToSend.length
      };
    } else {
      console.error('SlackBotへの送信でエラーコードが返されました: ' + responseCode);
      return {
        success: false,
        threadsFound: threads.length,
        messagesSent: 0,
        error: 'Cloud Run returned status ' + responseCode
      };
    }
  } catch (e) {
    console.error('UrlFetchAppの実行中に例外が発生しました: ' + e.message);
    return {
      success: false,
      threadsFound: threads.length,
      messagesSent: 0,
      error: e.message
    };
  }
}

/**
 * Web App エンドポイント (GET/POST)
 * SlackBot の /gmail-check コマンドから呼び出された際に即時実行されます
 */
function doGet(e) {
  return handleWebRequest(e);
}

function doPost(e) {
  return handleWebRequest(e);
}

function handleWebRequest(e) {
  // トークン検証（CONFIG.SECRET_TOKENが設定されている場合）
  if (CONFIG.SECRET_TOKEN) {
    var token = (e && e.parameter && e.parameter.token) || '';
    if (token !== CONFIG.SECRET_TOKEN) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  try {
    var result = syncGmailToSlack();
    return ContentService.createTextOutput(JSON.stringify({
      success: result ? result.success : true,
      result: result
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.message
    })).setMimeType(ContentService.MimeType.JSON);
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
        from: 'member@example.com',
        subject: '[applies:99999][全休]2026-09-18 当日申請 メンバーA',
        body: '体調不良のため本日全休をいただきます。',
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
