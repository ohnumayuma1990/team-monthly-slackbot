# GitHub Actions ワークフロー仕様書

このドキュメントでは、本リポジトリで利用している GitHub Actions の各ワークフローの仕様、目的、および他のリポジトリに導入する際の手順と注意点をまとめます。

---

## 1. CI Pipeline (`ci.yml`)

### 目的
コードの変更（Push または Pull Request）に対して、自動的に静的解析（Lint）、ビルド（Build）、および単体テスト（Test）を実行し、コードの品質を担保します。

### トリガー
- `push`: `main`, `master`, および `jules-*` ブランチへのプッシュ時。
- `pull_request`: `main`, `master` ブランチに対する Pull Request 作成・更新時。

### ワークフローのステップ
1. **Checkout repository**: リポジトリのコードをチェックアウトします (`actions/checkout@v4`)。
2. **Setup Node.js**: Node.js 22.x 環境をセットアップし、npm キャッシュを有効化します (`actions/setup-node@v4`)。
3. **Install dependencies**: `npm ci` を実行し、`package-lock.json` に基づいて依存関係をクリーンインストールします。
4. **Run Linter**: `npm run lint` を実行し、ESLint 等によるコードチェックを行います。
5. **Build TypeScript**: `npm run build` を実行し、TypeScript コードをコンパイルします。
6. **Run Tests**: `npm test` を実行し、Jest 等によるテストを実行します。

### 他リポジトリへの導入時の注意点
- `node-version`: プロジェクトで使用している Node.js のバージョンに合わせて変更してください。
- npm スクリプト (`lint`, `build`, `test`) が `package.json` に正しく定義されているか確認してください。
- パッケージマネージャーが `yarn` や `pnpm` の場合は、コマンドとキャッシュ設定 (`cache: 'yarn'` 等) を変更してください。

---

## 2. Deploy to Cloud Run (`deploy.yml`)

### 目的
`main` ブランチへのプッシュ時に、アプリケーションを Google Cloud Run に自動デプロイします。Workload Identity Federation (WIF) を利用することで、サービスアカウントの秘密鍵（JSON）を GitHub に保存することなく、安全に GCP リソースへアクセスします。

### トリガー
- `push`: `main` ブランチへのプッシュ時。
- `workflow_dispatch`: GitHub の Web UI からの手動実行。

### 権限 (Permissions)
- `contents: read`: リポジトリの読み取り権限。
- `id-token: write`: OIDC トークン発行に必須（WIF 認証用）。

### ワークフローのステップ
1. **Checkout code**, **Setup Node.js**, **Install dependencies**, **Run Tests**: CI ワークフローと同様に環境構築とテストを実行します。
2. **Authenticate to Google Cloud**: `google-github-actions/auth@v2` を使用して GCP に認証します。
   - `workload_identity_provider`: WIF のプロバイダ名を指定します。
   - `service_account`: WIF で権限を付与したサービスアカウントを指定します。
3. **Set up Cloud SDK**: `google-github-actions/setup-gcloud@v2` を使用して gcloud コマンドを利用可能にします。
4. **Deploy to Cloud Run**: `gcloud run deploy` コマンドを実行し、ソースコードからコンテナをビルド・デプロイします。

### 他リポジトリへの導入時の注意点
- `workload_identity_provider` と `service_account` を対象 GCP プロジェクトのものに変更してください。
- `gcloud run deploy` コマンドのパラメータを変更してください：
  - `SERVICE_NAME`: デプロイするサービス名 (例: `team-monthly-slackbot`)。
  - `--region`: GCP のリージョン (例: `asia-northeast1`)。
  - `--project`: GCP プロジェクト ID。
  - `--min-instances` / `--max-instances`: 必要に応じてインスタンス数を調整してください。無料枠を活用する場合は `--min-instances 0` に設定します。

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
