---
name: gcp-slackbot-knowhow
description: Best practices, troubleshooting runbooks, and architectural patterns for building Slack bots on Google Cloud Run (free tier). Covers Workload Identity Federation (bypassing service account key restrictions), Slack mrkdwn bold formatting with Japanese text, GAS Web App webhook integration, and zero-hardcoding member configuration. Use whenever developing Slack bots, integrating Gmail/Sheets, or deploying to Cloud Run.
---

# GCP Cloud Run & Slack Bot 開発・運用ノウハウ＆トラブルシューティング集

このナレッジは、Google Cloud Platform (Cloud Run) と Slack Bot を組み合わせたシステム開発において蓄積された実践的な設計パターンとトラブルシューティングのノウハウ集です。他プロジェクトでもそのまま活用できます。

---

## 1. Google Cloud 認証・デプロイ

### ① 組織ポリシーでサービスアカウントキーの作成が禁止されている場合
* **発生事象**:
  `gcloud iam service-accounts keys create` を実行すると以下のエラーが発生する:
  ```text
  ERROR: FAILED_PRECONDITION: Key creation is not allowed on this service account.
  type: constraints/iam.disableServiceAccountKeyCreation
  ```
* **原因**:
  エンタープライズや社内組織のGCPプロジェクトでは、セキュリティポリシーによりサービスアカウントの秘密鍵JSON発行が禁止されている。
* **解決策: Workload Identity Federation (WIF) による OIDC 連携**:
  秘密鍵JSONを使わず、GitHub Actions の一時的な OIDC トークンで安全に認証する。
  ```bash
  # 1. プールとプロバイダの作成
  gcloud iam workload-identity-pools create "github-actions-pool" --location="global"
  gcloud iam workload-identity-pools providers create-oidc "github-actions-provider" \
    --location="global" \
    --workload-identity-pool="github-actions-pool" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == 'OWNER/REPO'" \
    --issuer-uri="https://token.actions.githubusercontent.com"

  # 2. 借用権限の付与 (principalSet)
  gcloud iam service-accounts add-iam-policy-binding "SA_EMAIL" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-pool/attribute.repository/OWNER/REPO"
  ```
* **GitHub Actions 側ワークフロー (`deploy.yml`)**:
  ```yaml
  permissions:
    contents: read
    id-token: write  # OIDCトークン発行に必須

  steps:
    - uses: actions/checkout@v4
    - uses: google-github-actions/auth@v2
      with:
        workload_identity_provider: 'projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions-pool/providers/github-actions-provider'
        service_account: 'SA_EMAIL'
    - uses: google-github-actions/setup-gcloud@v2
    - run: |
        gcloud run deploy SERVICE_NAME --source . --region asia-northeast1 --quiet
  ```

### ② Cloud Run 完全無料枠の設計
* **コンテナ起動設定**:
  `--min-instances 0` を指定することで、リクエストがない時間帯はインスタンス数が0になり、課金を完全にゼロ（無料枠内）に抑えられる。
* **ポート設定**:
  Cloud Run は環境変数 `PORT`（通常 `8080`）でリッスンする必要がある。Dockerfile およびコード内で `process.env.PORT || 8080` を受けるようにする。
* **Slack Bolt のハイブリッド構成**:
  - ローカル開発時: `SLACK_SOCKET_MODE=true`（トンネルツール不要で即座にテスト）
  - Cloud Run 本番時: `SLACK_SOCKET_MODE=false`（HTTP Webhook 受信で軽量稼働）

---

## 2. Slack `mrkdwn` フォーマットの罠と回避策

Slack のテキストパーサーは **ASCII 文字中心** で設計されており、日本語（全角文字）との組み合わせで書式が壊れやすい特性があります。

### ① 全角中黒 `・` 直後の太字が無効化される問題
* **NG例**: `・*太字*`
  * Slackは全角中黒 `・` を単語の一部と認識するため、`*` が単語の途中の記号と判定されて太字が効かない。
* **OK例**: `・ *太字*`
  * `・` と `*` の間に **半角スペースを1つ挟む** ことで確実に太字になる。

### ② 閉じアスタリスク直後の全角コロン `：` で太字が無効化される問題
* **NG例**: `*見出し*：本文`
  * Slackの太字閉じルールは「直後が空白、改行、または ASCII 記号」。全角コロン `：` はASCII記号ではないため、単語の途中のアスタリスクとみなされ記号のまま表示される。
* **OK例**: `*見出し*: 本文`（半角コロン＋半角スペース）
  * ASCII コロン `:` は正規の区切り記号と認識されるため、`*見出し*` が太字になり後ろにコロンが付く。

### ③ プログラム側での自動サニタイズ関数
AI (Gemini) が生成した Markdown テキストを Slack 送信前に必ず以下のサニタイザーを通すことで、記号表示バグを根絶できる。

```typescript
export function formatMarkdownForSlack(text: string): string {
  if (!text) return '';
  return text
    // 1. #見出し を *太字* に変換
    .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
    // 2. 水平線 (---) を装飾罫線に変換
    .replace(/^(?:---|___|\*\*\*)\s*$/gm, '━━━━━━━━━━━━━━━━━━━━━━')
    // 3. **太字** を *太字* に変換
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    // 4. [text](url) を <url|text> に変換
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // 5. リスト記号 (*, -) を「・」に変換
    .replace(/^(\s*)[*-]\s+/gm, '$1・')
    // 6. 「・*」の間に半角スペースを挿入
    .replace(/・\*/g, '・ *')
    // 7. 「*見出し*：」を「*見出し*: 」（半角コロン＋スペース）に変換
    .replace(/\*([^\s*](?:[\s\S]*?[^\s*])?)\*：/g, '*$1*: ')
    // 8. 閉じ*の直後に日本語文字が続く場合にスペースを補正
    .replace(/\*([^\s*](?:[\s\S]*?[^\s*])?)\*([^\s\x20-\x7e])/g, '*$1* $2')
    // 9. 開始*の直前に日本語文字がある場合にスペースを補正
    .replace(/([^\s\x20-\x7e])\*([^\s*](?:[\s\S]*?[^\s*])?)\*/g, '$1 *$2*')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

### ④ チャンネルとDMへの二重投稿の防止
* マネージャー専用レポート（週報AI要約など機微な情報）は、コマンド実行チャンネルに長文を出さず **DMに集約** する。
* チャンネル側には `✅ レポートを作成し、DMへ送信しました！` という1行のエフェメラル（自分にのみ表示）通知を返す。
* これにより、画面の散らかり防止、誤爆防止、およびリロードで消えない永続化を実現する。

---

## 3. Google Apps Script (GAS) と Cloud Run の安全な連携

ユーザー個人の Gmail 受信トレイや Google Drive を Bot から扱いたい場合、Cloud Run にユーザーのパスワードや OAuth リフレッシュトークンを持たせるのはセキュリティ上好ましくありません。

### 構成パターン: GAS Web App による安全な中継
1. **ユーザーアカウント上の GAS**:
   - `GmailApp` や `DriveApp` を使ってユーザーのメールやファイルを検索・抽出する。
   - `syncGmailToSlack()` で Cloud Run の Webhook (`/api/daily/gmail`) へ POST。
2. **オンデマンド実行 (Web App)**:
   - GAS に `doGet(e)` / `doPost(e)` を追加し、「ウェブアプリ」としてデプロイ。
   - Slack コマンド（`/gmail-check`）から Cloud Run が GAS Web App URL を叩く。
   - 処理結果（検知件数等）を JSON で返却。
3. **メリット**:
   - Google Workspace 管理者権限（ドメイン委任）が一切不要。
   - サーバー側に個人の Google 認証情報を保持しないためセキュア。
   - 定期実行（GASトリガー）と即時実行（Slackコマンド）の両方に対応可能。

---

## 4. メンバー管理のゼロ・ハードコーディング設計

### 単一環境変数（JSON）による一元管理
* **`TEAM_MEMBERS_CONFIG`**:
  ```json
  [
    { "name": "山田 太郎", "slackId": "U012345", "email": "yamada@example.com", "staffNum": "000101", "role": "member" },
    { "name": "管理者 花子", "slackId": "U098765", "email": "hanako@example.com", "staffNum": "000102", "role": "manager" }
  ]
  ```
* **名寄せロジック**:
  - 全角・半角スペースを除去した `normalizeName(name)` で比較。
  - 「大沼 祐真」「大沼　祐真」「大沼祐真」などの表記揺れを完全吸収。
  - 名字のみの一致（`startsWith`）もフォールバックとしてサポート。
* **メール振り分けのホワイトリスト化**:
  - 除外リスト（ブラックリスト）は運用保守が破綻しやすいため、「全社周知アドレス（`ANNOUNCEMENT_TO_EMAILS`）」と「個別報告アドレス（`MANAGER_REPORT_FROM_EMAILS`）」のホワイトリストで明示的に制御する。
