# team-monthly-slackbot 🤖

エンジニアチームの月次共有事項（近況・困りごと、グループワーク振り返り、稼働着地、面談希望、総評）をSlackのモーダルUIからスプレッドシートへ自動入力し、未入力者への自動リマインド、さらに **Googleプラットフォーム（Cloud Run + Google AI Studio）の完全無料枠** で運用可能なSlack Botです。

---

## 🌟 主な機能

1. **Slack モーダル入力 (`/gw` または `/monthly`)**
   - Slack上で `/gw` を実行すると入力モーダルが起動。
   - 「個人セクション」「グループワーク」「総評」を切り替えて入力可能。
   - スプレッドシートの指定月タブ（例: `26_9月`）の該当メンバー行へ自動書き込み。
   - 姓名のスペース（全角・半角）揺れを吸収する名寄せ機能搭載。

2. **未入力者の自動検知 ＆ リマインダー**
   - シート内の未入力者（近況・GW未記入メンバー）を自動抽出。
   - 指定Slackチャンネルへの一括メンション、または個別DM通知。
   - Google Cloud Scheduler と連携し、毎月第3木曜日などの定期自動実行が可能。

3. **Gemini AI 連携（Google AI Studio 無料枠）**
   - 入力された近況や困りごとに対し、AIメンターからの共感やヒントを自動返信。
   - メンバー全員の振り返りを要約した「総評ドラフト」の作成支援。
   - 最新モデル（`gemini-2.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.8-flash` 等）に対応。

4. **ハイブリッド運用（ローカル ＆ Cloud Run）**
   - **開発・テスト時**: Socket Mode（`SLACK_SOCKET_MODE=true`）により、ngrokなどのトンネルツール不要で即座に動作確認可能。
   - **本番運用**: Google Cloud Run（常時無料枠内）のコンテナとして完全無料運用可能。

---

## 🚀 無料枠アーキテクチャ

* **実行環境**: **Google Cloud Run**（毎月200万リクエスト、360,000 vCPU-秒まで無料）
* **定期トリガー**: **Google Cloud Scheduler**（月3ジョブまで無料）
* **AIモデル**: **Google AI Studio (Gemini API)**（Flash系モデルが完全無料枠で利用可能）
* **データ保存**: **Google スプレッドシート**（Google Sheets API無料）

---

## 🛠️ 事前準備・セットアップ手順

### 1. Slack App の作成 (api.slack.com)
1. [Slack API Apps](https://api.slack.com/apps) で「Create New App」→「From scratch」を選択。
2. **OAuth & Permissions** で以下の **Bot Token Scopes** を追加:
   - `commands` (スラッシュコマンドの受付)
   - `chat:write` (チャンネルへのメッセージ投稿)
   - `users:read` (ユーザー情報の取得・氏名自動補完)
   - `im:write` (個別DMへの通知)
3. **Slash Commands** で以下を追加:
   - `/gw` (別名 `/monthly`): 月次共有事項の入力モーダルを表示
   - `/gw-status`: スプレッドシートの提出進捗状況を確認
   - `/weekly-check`: 週報提出状況とGroupSessionログイン状況の確認
   - `/weekly-summary`: 週報AI要約・スケジュール取得（マネージャーDM宛）
   - `/my-schedule`: 今週のGroupSessionスケジュール確認
   - `/attendance-check` (別名 `/pydio-check`, `/kintai-check`): Pydio 6の勤怠出勤簿（Excel）提出確認（未提出者はSlackメンション付きで全体通知）
4. **Socket Mode** (ローカル開発を行う場合):
   - 「Settings」→「Socket Mode」を Enable にし、App-Level Token（`xapp-...`）を発行。
5. 「Install to Workspace」をクリックし、**Bot User OAuth Token (`xoxb-...`)** と **Signing Secret** を取得。

### 2. Google Cloud / Google Sheets API の準備
1. [Google Cloud Console](https://console.cloud.google.com/) で新規プロジェクトを作成（または既存プロジェクトを選択）。
2. **Google Sheets API** を有効化。
3. **サービスアカウント** を作成し、JSON認証キーを発行。
   - キーファイル内の `client_email` と `private_key` を控える。
4. 対象のスプレッドシート（共有事項シート）を開き、右上の「共有」から上記サービスアカウントのメールアドレスを **「編集者」** として追加。
5. スプレッドシートのURLから `SPREADSHEET_ID` を取得:
   `https://docs.google.com/spreadsheets/d/{ここがSPREADSHEET_ID}/edit`

### 3. Google AI Studio (Gemini API) の準備（無料）
1. [Google AI Studio](https://aistudio.google.com/) にアクセス。
2. 「Get API key」から無料のAPIキーを発行。

---

## 💻 ローカル開発・テスト方法

1. **環境変数の設定**:
   `.env.example` をコピーして `.env` を作成し、各値を入力します。
   ```bash
   cp .env.example .env
   ```
   ※ローカルでテストする場合は `SLACK_SOCKET_MODE=true` に設定してください。

2. **依存関係インストール & ビルド**:
   ```bash
   npm install
   npm run build
   ```

3. **テストの実行**:
   ```bash
   npm test
   ```

4. **ローカルサーバー起動**:
   ```bash
   npm start
   # または開発モード (TypeScript直接実行)
   npm run dev
   ```

---

## ☁️ Google Cloud Run 本番デプロイ手順（完全無料枠）

1. **`.env` の Socket Mode をオフにする**:
   本番では HTTP Webhook 受信を行うため `SLACK_SOCKET_MODE=false` にします。

2. **Cloud Run へデプロイ**:
   Google Cloud SDK (`gcloud`) を使用してデプロイします。
   ```bash
   gcloud run deploy team-monthly-slackbot \
     --source . \
     --region asia-northeast1 \
     --allow-unauthenticated \
     --min-instances 0 \
     --max-instances 1 \
     --set-env-vars "SLACK_BOT_TOKEN=xoxb-...,SLACK_SIGNING_SECRET=...,GOOGLE_SERVICE_ACCOUNT_EMAIL=...,SPREADSHEET_ID=...,GEMINI_API_KEY=...,SLACK_NOTIFICATION_CHANNEL_ID=C0123456789,REMINDER_SECRET_TOKEN=my-secret-token"
   ```
   ※`--min-instances 0` にすることで、アクセスがない時間帯の費用を完全に0円に抑えられます。

3. **Slack App の URL 設定**:
   Cloud Run の発行URL（例: `https://team-monthly-slackbot-xxx-an.a.run.app`）を Slack App に登録します:
   - **Interactivity & Shortcuts**: Request URL に `https://your-cloud-run-url/slack/events` を入力。
   - **Slash Commands**: `/gw` の Request URL に `https://your-cloud-run-url/slack/events` を入力。

---

## ⏰ 自動リマインダーの設定（Cloud Scheduler）

Google Cloud Scheduler を使って、毎月第3木曜日の10:00に自動リマインドを実行します。

```bash
gcloud scheduler jobs create http team-monthly-reminder \
  --schedule "0 10 * * 4#3" \
  --time-zone "Asia/Tokyo" \
  --uri "https://your-cloud-run-url/api/reminder" \
  --http-method POST \
  --headers "Authorization=Bearer my-secret-token"
```
（※月3ジョブまで無料枠です）

---

## 📁 ディレクトリ構成

```text
team-monthly-slackbot/
├── src/
│   ├── ai/
│   │   └── gemini.ts            # Gemini Flash連携 (無料枠)
│   ├── config/
│   │   └── members.ts           # メンバー設定 (社員番号/名前/Slack ID/Email)
│   ├── email/
│   │   └── service.ts           # Gmail勤怠申請・全体アナウンス受信
│   ├── pydio/
│   │   └── service.ts           # Pydio 6 勤怠出勤簿(Excel)提出確認サービス
│   ├── reminder/
│   │   ├── handler.ts           # HTTPエンドポイント (/api/daily/run, /api/attendance/check)
│   │   └── service.ts           # 未入力者検知 & Slack通知ロジック
│   ├── sheets/
│   │   ├── client.ts            # Google Sheets API サービスアカウント認証
│   │   ├── parser.ts            # シート構造解析 & 氏名名寄せ
│   │   └── service.ts           # スプレッドシート読み書きモジュール
│   ├── slack/
│   │   ├── handlers/
│   │   │   ├── commands.ts      # スラッシュコマンド (/attendance-check 等)
│   │   │   └── submissions.ts   # モーダル送信ハンドラ
│   │   ├── modals/
│   │   │   └── submissionModal.ts # Block Kit 入力モーダル
│   │   └── app.ts               # Slack Bolt アプリケーション初期化
│   ├── types/
│   │   └── index.ts             # 型定義
│   ├── weekly/
│   │   └── service.ts           # 週報・GroupSession確認
│   └── index.ts                 # サーバーエントリーポイント
├── tests/
│   ├── daily.test.ts
│   ├── gemini.test.ts
│   ├── modal.test.ts
│   ├── pydio.test.ts            # Pydio勤怠確認テスト
│   ├── reminder.test.ts
│   ├── sheets.test.ts
│   └── weekly.test.ts
├── Dockerfile                   # Cloud Run デプロイ用 Dockerfile
├── .env.example                 # 環境変数サンプル
└── package.json
```