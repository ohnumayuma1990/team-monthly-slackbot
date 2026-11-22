import { TeamManagementOverviewResult } from '../sync/sync-service';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the Administrator Team Management Dashboard HTML.
 * - Directly invokes the Common API (`/api/team-management/*`) without going through LLM/Agent
 * - Zero auto-polling (`onSnapshot` / `setInterval` prohibited) to protect Firestore free tier
 * - Clearly separates Stage 1 (`STATUS_ONLY` sync) and Stage 2 (`WITH_DETAILS` sync with external read confirmation dialog)
 */
export function renderTeamManagementDashboardHtml(
  overview: TeamManagementOverviewResult
): string {
  const { freshness, weeklySnapshot, gSessionSnapshot, latestAiSummary } =
    overview;

  const isStale = freshness.isStale;
  const bannerClass = isStale ? 'banner-stale' : 'banner-fresh';
  const bannerTitle = isStale
    ? '⚠️ データ鮮度警告: 未同期または直近の同期に失敗しています（前回の正常スナップショットを表示中）'
    : '✅ 最新データ同期済み';

  const fetchedAtLabel = freshness.fetchedAt
    ? escapeHtml(freshness.fetchedAt)
    : '未取得';
  const errorBannerHtml = freshness.lastSyncError
    ? `<div class="err-detail">直近エラー [${escapeHtml(freshness.lastSyncError.code)}]: ${escapeHtml(freshness.lastSyncError.message)} (${escapeHtml(freshness.lastSyncError.occurredAt)})</div>`
    : '';

  const submittedMembers =
    weeklySnapshot?.members.filter((m) => m.status === 'SUBMITTED') ?? [];
  const unsubmittedMembers =
    weeklySnapshot?.members.filter((m) => m.status !== 'SUBMITTED') ?? [];

  const inactiveGsMembers =
    gSessionSnapshot?.loginStatuses.filter((m) => m.status === 'INACTIVE') ??
    [];

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Team Management 管理ダッシュボード (Admin Only)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 16px; }
    .container { max-width: 840px; margin: 0 auto; }
    .banner { padding: 14px; border-radius: 10px; margin-bottom: 16px; }
    .banner-fresh { background: rgba(16, 185, 129, 0.14); border: 1px solid #10b981; }
    .banner-stale { background: rgba(245, 158, 11, 0.16); border: 1px solid #f59e0b; }
    .err-detail { margin-top: 6px; font-size: 0.85rem; color: #fca5a5; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .btn-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
    .btn { padding: 8px 14px; border-radius: 8px; border: 1px solid #38bdf8; background: #0284c7; color: #fff; font-weight: 700; cursor: pointer; }
    .btn-warn { background: #b45309; border-color: #f59e0b; }
    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.72); align-items: center; justify-content: center; padding: 16px; }
    .modal-backdrop.open { display: flex; }
    .modal-card { background: #1e293b; border: 1px solid #f59e0b; border-radius: 12px; max-width: 480px; padding: 18px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 Team Management 管理ダッシュボード</h1>
    <div id="sync-status-banner" class="banner ${bannerClass}" data-is-stale="${String(isStale)}">
      <div><strong>${bannerTitle}</strong></div>
      <div>取得元: ${escapeHtml(freshness.source)} / 最終取得日時: ${fetchedAtLabel}</div>
      ${errorBannerHtml}
      <div class="btn-row">
        <button id="btn-sync-status-only" class="btn" type="button" onclick="triggerStatusOnlySync()">
          🔄 提出状況のみ同期 (既読副作用なし)
        </button>
        <button id="btn-open-detail-modal" class="btn btn-warn" type="button" onclick="openExternalReadModal()">
          📝 本文詳細＆AI要約取得 (既読確認あり)
        </button>
      </div>
    </div>

    <div class="card" id="weekly-report-panel">
      <h2>1. 週報提出状況 (${escapeHtml(weeklySnapshot?.weekLabel || '未同期')})</h2>
      <p>提出済み: <strong>${submittedMembers.length}</strong> / ${weeklySnapshot?.totalMembers ?? 0} 名</p>
      <p>未提出: ${unsubmittedMembers.map((m) => escapeHtml(m.staffName)).join('、') || 'なし'}</p>
    </div>

    <div class="card" id="weekly-ai-summary-panel">
      <h2>2. 週報AI要約レポート</h2>
      <p>${escapeHtml(latestAiSummary?.overallSummary || 'AI要約は未生成です。')}</p>
    </div>

    <div class="card" id="gsession-status-panel">
      <h2>3. GroupSession 未ログイン警告 (7日以上)</h2>
      <p>警告対象 (${inactiveGsMembers.length}名): ${inactiveGsMembers.map((m) => `${escapeHtml(m.name)} (${m.daysSinceLastLogin ?? '?'}日前)`).join('、') || 'なし'}</p>
    </div>
  </div>

  <!-- Stage 2 External Read Confirmation Modal -->
  <div id="external-read-modal" class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal-card">
      <h3>⚠️ 外部週報システムへの「既読」登録確認</h3>
      <p>
        週報の本文詳細（<code>/weekly_report/getReportInfo</code>）を取得すると、外部の週報システム（<code>tWrBrowseData</code>）上でマネージャーの「閲覧（既読）」が登録されます。実行してよろしいですか？
      </p>
      <div class="btn-row">
        <button class="btn" type="button" onclick="closeExternalReadModal()">キャンセル</button>
        <button id="btn-confirm-detail-sync" class="btn btn-warn" type="button" onclick="triggerWithDetailsSync()">
          既読登録を了承して実行 (confirmExternalRead: true)
        </button>
      </div>
    </div>
  </div>

  <script>
    function openExternalReadModal() {
      document.getElementById('external-read-modal').classList.add('open');
    }
    function closeExternalReadModal() {
      document.getElementById('external-read-modal').classList.remove('open');
    }
    async function triggerStatusOnlySync() {
      await fetch('/api/team-management/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'STATUS_ONLY', confirmExternalRead: false })
      });
    }
    async function triggerWithDetailsSync() {
      closeExternalReadModal();
      await fetch('/api/team-management/weekly/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmExternalRead: true })
      });
    }
  </script>
</body>
</html>`;
}
