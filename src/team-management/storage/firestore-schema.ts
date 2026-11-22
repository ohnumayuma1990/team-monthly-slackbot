import {
  DataFreshness,
  GSessionScheduleDay,
  StrictGSessionMemberLoginRecord,
  StructuredWeeklyAiSummary,
  SyncMode,
  SyncStatus,
  SyncTriggerType,
  WeeklyMemberStatusRecord,
  WeeklyReportDetailDocument,
} from '../core/types';

export const TM_COLLECTIONS = {
  META: 'tm_meta',
  WEEKLY_SNAPSHOTS: 'tm_weekly_snapshots',
  WEEKLY_REPORTS: 'tm_weekly_reports',
  WEEKLY_AI_SUMMARIES: 'tm_weekly_ai_summaries',
  GSESSION_SNAPSHOTS: 'tm_gsession_snapshots',
  SYNC_JOBS: 'tm_sync_jobs',
} as const;

export const TM_META_DOCS = {
  CURRENT_STATE: 'current_state',
  SYNC_LOCK: 'sync_lock',
} as const;

export interface TmCurrentStateDocument {
  latestWeekId: string | null;
  latestGSessionSnapshotDate: string | null;
  weeklyStatusLastSuccessAt: string | null;
  weeklyDetailsLastSuccessAt: string | null;
  gSessionLastSuccessAt: string | null;
  lastSyncStatus: SyncStatus | 'NEVER_SYNCED';
  lastSyncError: {
    code: string;
    message: string;
    occurredAt: string;
  } | null;
  updatedAt: string;
}

export interface TmSyncLockDocument {
  isLocked: boolean;
  lockOwnerJobId: string | null;
  triggerType: SyncTriggerType | null;
  lockedAt: string | null;
  expiresAt: string | null;
}

export interface TmWeeklySnapshotDocument {
  weekId: string;
  wrTargetDateId: number;
  weekLabel: string;
  source: 'poweredge_weekly_report';
  syncStatus: SyncStatus;
  detailFetchMode: SyncMode;
  submittedCount: number;
  unsubmittedCount: number;
  totalMembers: number;
  members: WeeklyMemberStatusRecord[];
  failedDetailStaffIds: number[];
  fetchedAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface TmGSessionSnapshotDocument {
  snapshotDate: string; // YYYY-MM-DD in JST
  groupSid: string;
  inactiveThresholdDays: number;
  source: 'poweredge_gsession';
  syncStatus: SyncStatus;
  loginStatuses: StrictGSessionMemberLoginRecord[];
  managerScheduleDays: GSessionScheduleDay[];
  fetchedAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface TmSyncJobDocument {
  jobId: string;
  triggerType: SyncTriggerType;
  triggeredBy: string;
  mode: SyncMode;
  status: 'RUNNING' | SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  itemsUpdated: number;
}

/**
 * Computes DataFreshness metadata from TmCurrentStateDocument.
 * Marks data as stale (`isStale: true`) if never synced, if lastSyncStatus !== 'SUCCESS',
 * or if age exceeds maxFreshMinutes (default 24 hours = 1440 mins).
 */
export function computeDataFreshness(
  currentState: TmCurrentStateDocument | null,
  source = 'firestore_team_management',
  now: Date = new Date(),
  maxFreshMinutes = 1440
): DataFreshness {
  if (!currentState || !currentState.weeklyStatusLastSuccessAt) {
    return {
      source,
      fetchedAt: null,
      updatedAt: currentState?.updatedAt ?? null,
      ageMinutes: null,
      isStale: true,
      lastSyncStatus: currentState?.lastSyncStatus ?? 'NEVER_SYNCED',
      lastSyncError: currentState?.lastSyncError ?? null,
    };
  }

  const fetchedEpoch = Date.parse(currentState.weeklyStatusLastSuccessAt);
  const ageMinutes = Number.isNaN(fetchedEpoch)
    ? null
    : Math.max(0, Math.round((now.getTime() - fetchedEpoch) / 60000));

  const isStale =
    currentState.lastSyncStatus !== 'SUCCESS' ||
    ageMinutes === null ||
    ageMinutes > maxFreshMinutes;

  return {
    source,
    fetchedAt: currentState.weeklyStatusLastSuccessAt,
    updatedAt: currentState.updatedAt,
    ageMinutes,
    isStale,
    lastSyncStatus: currentState.lastSyncStatus,
    lastSyncError: currentState.lastSyncError,
  };
}

export { StructuredWeeklyAiSummary, WeeklyReportDetailDocument };
