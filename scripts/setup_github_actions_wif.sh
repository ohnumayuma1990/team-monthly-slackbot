#!/bin/bash
set -e

echo "=== GitHub Actions 用 サービスアカウント設定スクリプト ==="

PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "")
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID="project-af21d0bc-5f83-49ad-b24"
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

REPO="ohnumayuma1990/team-monthly-slackbot"
POOL_NAME="github-actions-pool"
PROVIDER_NAME="github-actions-provider"

echo "3. Workload Identity プールを作成中..."
gcloud iam workload-identity-pools create "${POOL_NAME}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="GitHub Actions Pool" || true

echo "4. GitHub OIDC プロバイダを作成中..."
gcloud iam workload-identity-pools providers create-oidc "${PROVIDER_NAME}" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="${POOL_NAME}" \
  --display-name="GitHub Actions Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository == '${REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com" || true

echo "5. サービスアカウントの借用権限をリポジトリ ${REPO} に付与中..."
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")

gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}/attribute.repository/${REPO}" --quiet

echo ""
echo "===================================================================="
echo "🎉 Workload Identity 連携の設定が完了しました！"
echo ""
echo "【設定情報】"
echo "・プロバイダ名:"
echo "  projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_NAME}/providers/${PROVIDER_NAME}"
echo "・サービスアカウント:"
echo "  ${SA_EMAIL}"
echo "===================================================================="
echo "※秘密鍵（JSONキー）の作成は不要です。GitHub Actionsから直接安全に認証されます。"
