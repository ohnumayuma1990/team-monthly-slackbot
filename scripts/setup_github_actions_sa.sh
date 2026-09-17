#!/bin/bash
set -e

echo "=== GitHub Actions 用 サービスアカウント設定スクリプト ==="

PROJECT_ID=$(gcloud config get-value project)
if [ -z "$PROJECT_ID" ]; then
  echo "Error: GCP プロジェクトが選択されていません。'gcloud config set project <PROJECT_ID>' を実行してください。"
  exit 1
fi

SA_NAME="github-actions-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "1. サービスアカウントを作成中: ${SA_EMAIL}..."
gcloud iam service-accounts create ${SA_NAME} \
  --display-name="GitHub Actions Deployer" || true

echo "2. 権限（Cloud Run管理者、Cloud Build編集者、Artifact Registry等）を付与中..."
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.admin" --quiet

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" --quiet

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/cloudbuild.builds.editor" --quiet

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.admin" --quiet

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/artifactregistry.admin" --quiet

echo "3. サービスアカウントキーを生成中..."
KEY_FILE="github-actions-sa-key.json"
gcloud iam service-accounts keys create ${KEY_FILE} \
  --iam-account=${SA_EMAIL} --quiet

echo ""
echo "===================================================================="
echo "🎉 サービスアカウントの設定が完了しました！"
echo ""
echo "【次のステップ】"
echo "1. GitHub リポジトリの Secrets 設定ページを開きます:"
echo "   https://github.com/ohnumayuma1990/team-monthly-slackbot/settings/secrets/actions"
echo ""
echo "2. 「New repository secret」をクリックします:"
echo "   - Name: GCP_SA_KEY"
echo "   - Secret: 以下の JSON 内容をすべてコピーして貼り付けます"
echo "===================================================================="
echo ""
cat ${KEY_FILE}
echo ""
echo "===================================================================="
