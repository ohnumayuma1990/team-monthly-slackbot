# GitHub Actions ワークフロー仕様書

このドキュメントでは、本リポジトリで利用している GitHub Actions の各ワークフローの仕様、目的、および他のリポジトリに導入する際の手順と注意点をまとめます。

---

## 1. CI Pipeline (`ci.yml`)

### 目的
コードの変更（Push または Pull Request）に対して、自動的に静的解析（Lint）、ビルド（Build）、単体テスト（Test）、ハードコード監査、Slack構文チェック、本番ヘルスチェック等を含む6層QA検証 (`npm run verify`) を実行し、コードの品質を担保します。

### トリガー
- `push`: `main`, `master`, および `jules-*` ブランチへのプッシュ時。
- `pull_request`: `main`, `master` ブランチに対する Pull Request 作成・更新時。

### 権限と制御 (Permissions & Concurrency)
- `permissions`: 最小権限原則に基づき `contents: read` のみを付与。
- `concurrency`: 同一ブランチ／PRでの重複実行をキャンセル (`cancel-in-progress: true`)。

### ワークフローのステップ
1. **Checkout repository**: リポジトリのコードをチェックアウトします (`actions/checkout@v4`)。
2. **Setup Node.js**: Node.js 22.x 環境をセットアップし、npm キャッシュを有効化します (`actions/setup-node@v4`)。
3. **Install dependencies**: `npm ci` を実行し、`package-lock.json` に基づいて依存関係をクリーンインストールします。
4. **Run 6-Layer QA Verification**: `npm run verify` を実行し、ESLint、TypeScriptビルド、Jestテスト、ハードコード機密スキャン、Slack mrkdwn構文監査、本番ヘルスチェックの全6層検査を実施します。

### 他リポジトリへの導入時の注意点
- `node-version`: プロジェクトで使用している Node.js のバージョンに合わせて変更してください。
- `package.json` に `verify` スクリプトが定義されているか確認してください。

---

## 2. Deploy to Cloud Run (`deploy.yml`)

### 目的
`main` ブランチへのプッシュ時に、アプリケーションを Google Cloud Run に自動デプロイします。Workload Identity Federation (WIF) を利用することで、サービスアカウントの秘密鍵（JSON）を GitHub に保存することなく、安全に GCP リソースへアクセスします。また、デプロイ後のヘルスチェック疎通確認と、Artifact Registry の古いコンテナイメージの自動クリーンアップ（0.5GB 無料枠保護）を行います。

### トリガー
- `push`: `main` ブランチへのプッシュ時。
- `workflow_dispatch`: GitHub の Web UI からの手動実行。

### 権限と制御 (Permissions & Concurrency)
- `permissions`:
  - `contents: read`: リポジトリの読み取り権限。
  - `id-token: write`: OIDC トークン発行に必須（WIF 認証用）。
- `concurrency`: 本番デプロイの競合を防ぐため直列化 (`cancel-in-progress: false`)。

### ワークフローのステップ
1. **Checkout code**, **Setup Node.js**, **Install dependencies**: 環境構築と依存関係のインストールを行います。
2. **Run 6-Layer QA Verification**: `npm run verify` を実行し、デプロイ前に6層QA検証をクリアしていることを保証します。
3. **Authenticate to Google Cloud**: `google-github-actions/auth@v2` を使用して GCP に認証します（WIF）。
4. **Set up Cloud SDK**: `google-github-actions/setup-gcloud@v2` を使用して gcloud コマンドを利用可能にします。
5. **Deploy to Cloud Run**: `gcloud run deploy` コマンドを実行し、ソースコードからコンテナをビルド・デプロイします（`--min-instances 0` でコスト完全0円運用）。
6. **Verify Deployed Cloud Run Health (/health)**: デプロイされたサービスの `/health` エンドポイントに対し、指数バックオフ（2秒→4秒→8秒）付きの最大3回リトライで `curl` を実行し、`"status":"healthy"` が含まれることを検証します。
7. **Cleanup Old Artifact Registry Images (Free Tier 0.5GB Protection)**: Artifact Registry のイメージタグ一覧を作成日時降順で取得し、最新2世代を除いた古いイメージダイジェストを `--delete-tags` 指定で自動削除し、無料枠（0.5GB）の超過を防止します。

### 他リポジトリへの導入時の注意点
- `workload_identity_provider` と `service_account` を対象 GCP プロジェクトのものに変更してください。
- `gcloud run deploy` およびヘルスチェック・クリーンアップステップのサービス名、リージョン、プロジェクトID、イメージパスを対象環境に合わせて適宜調整してください。

---

## 3. Bulk Create Issues (`create-issues.yml`)

### 目的
テキスト入力から複数の GitHub Issue を一括で作成するためのワークフローです。`gh issue create` コマンドのリストを含むテキストをパースし、指定されたタイトルと本文で Issue を生成します。

### トリガー
- `workflow_dispatch`: 手動実行。入力パラメータ `issues_text` に `gh issue create` コマンド群のテキストを受け取ります。

### 権限 (Permissions)
- `issues: write`: Issue の作成に必須。
- `contents: read`: リポジトリの読み取り。

### ワークフローのステップ
1. **Create issues from text**: 入力されたテキスト (`INPUT_TEXT`) を Python スクリプトでパースします。
   - 正規表現を用いて `--title` と `--body` の内容を抽出します。
   - 抽出された各要素に対して `subprocess.run` を使って `gh issue create` コマンドを実行し、Issue を作成します。
   - `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` を使用して GitHub CLI を認証します。

### 他リポジトリへの導入時の注意点
- 特に追加のシークレット設定は不要です（GitHub Actions が自動提供する `GITHUB_TOKEN` を使用）。
- Issue 作成権限 (`permissions.issues: write`) が Workflow に設定されていることを確認してください。
- 入力されるテキストは指定の形式 (`gh issue create --title "..." --body "..."`) に準拠している必要があります。
