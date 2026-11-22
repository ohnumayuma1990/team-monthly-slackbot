import crypto from 'crypto';
import {
  WeeklyAiSummarizer,
  computeReportsContentHash,
  computeSingleReportHash,
} from '../core/ai/weekly-summarizer';
import { GSessionPortalFetcher } from '../core/fetchers/gsession-fetcher';
import {
  FetchSubmittedDetailsTarget,
  WeeklyPortalFetcher,
} from '../core/fetchers/weekly-fetcher';
import { assertNoPublicSecretEnvVars } from '../core/members';
import {
  ConfirmationRequiredError,
  DataFreshness,
  StructuredWeeklyAiSummary,
  SyncMode,
  SyncStatus,
  SyncTriggerType,
  TeamManagementError,
  WeeklyReportContent,
  WeeklyReportDetailDocument,
} from '../core/types';
import {
  TmCurrentStateDocument,
  TmGSessionSnapshotDocument,
  TmSyncJobDocument,
  TmWeeklySnapshotDocument,
  computeDataFreshness,
} from '../storage/firestore-schema';
import {
  TeamManagementRepository,
  getDefaultTeamManagementRepository,
} from '../storage/repository';
import { SyncLeaseLockManager } from './sync-lock';

export interface RunSyncOptions {
  mode?: SyncMode;
  confirmExternalRead?: boolean;
  triggerType: SyncTriggerType;
  triggeredBy: string;
  overrideWrTargetDateId?: number;
  now?: Date;
}

export interface RunSyncResult {
  job: TmSyncJobDocument;
  weeklySnapshot: TmWeeklySnapshotDocument | null;
  gSessionSnapshot: TmGSessionSnapshotDocument | null;
  aiSummary: StructuredWeeklyAiSummary | null;
  freshness: DataFreshness;
}

export interface TeamManagementOverviewResult {
  freshness: DataFreshness;
  currentState: TmCurrentStateDocument | null;
  weeklySnapshot: TmWeeklySnapshotDocument | null;
  gSessionSnapshot: TmGSessionSnapshotDocument | null;
  latestAiSummary: StructuredWeeklyAiSummary | null;
}

function formatJstDateString(date: Date): string {
  const jstTime = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jstTime.toISOString().slice(0, 10);
}

/**
 * Core Synchronization & Domain Service (`TeamManagementSyncService`).
 * Used directly by scheduled Cron jobs and Common APIs.
 */
export class TeamManagementSyncService {
  private repository: TeamManagementRepository;
  private lockManager: SyncLeaseLockManager;
  private weeklyFetcher: WeeklyPortalFetcher;
  private gSessionFetcher: GSessionPortalFetcher;
  private aiSummarizer: WeeklyAiSummarizer;

  constructor(options?: {
    repository?: TeamManagementRepository;
    lockManager?: SyncLeaseLockManager;
    weeklyFetcher?: WeeklyPortalFetcher;
    gSessionFetcher?: GSessionPortalFetcher;
    aiSummarizer?: WeeklyAiSummarizer;
  }) {
    this.repository =
      options?.repository ?? getDefaultTeamManagementRepository();
    this.lockManager =
      options?.lockManager ?? new SyncLeaseLockManager(this.repository);
    this.weeklyFetcher = options?.weeklyFetcher ?? new WeeklyPortalFetcher();
    this.gSessionFetcher =
      options?.gSessionFetcher ?? new GSessionPortalFetcher();
    this.aiSummarizer = options?.aiSummarizer ?? new WeeklyAiSummarizer();
  }

  /**
   * Executes a synchronization job with transactional lease lock, Fail-Closed snapshot protection,
   * Stage 1 / Stage 2 separation, and SHA-256 contentHash caching.
   */
  async runSync(options: RunSyncOptions): Promise<RunSyncResult> {
    assertNoPublicSecretEnvVars();

    const mode: SyncMode = options.mode ?? 'STATUS_ONLY';
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    // Enforce confirmation gate before Stage 2 (which registers manager read in tWrBrowseData)
    if (mode === 'WITH_DETAILS') {
      const isAllowedAutoCron =
        options.triggerType === 'SCHEDULED_CRON' &&
        process.env.AUTO_FETCH_WEEKLY_DETAILS_ON_TUESDAY === 'true';

      if (!options.confirmExternalRead && !isAllowedAutoCron) {
        throw new ConfirmationRequiredError(
          'Fetching weekly report body details registers manager read status (tWrBrowseData) in the external portal. Pass confirmExternalRead: true after user confirmation.'
        );
      }
    }

    const jobId = `sync_${now.getTime()}_${crypto.randomBytes(4).toString('hex')}`;
    await this.lockManager.acquireLock(jobId, options.triggerType, now);

    const jobDoc: TmSyncJobDocument = {
      jobId,
      triggerType: options.triggerType,
      triggeredBy: options.triggeredBy,
      mode,
      status: 'RUNNING',
      startedAt: nowIso,
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      itemsUpdated: 0,
    };
    await this.repository.saveSyncJob(jobDoc);

    const prevState = await this.repository.getCurrentState();
    let itemsUpdated = 0;
    const errors: Array<{ code: string; message: string }> = [];

    let savedWeeklySnapshot: TmWeeklySnapshotDocument | null = null;
    let savedGSessionSnapshot: TmGSessionSnapshotDocument | null = null;
    let savedAiSummary: StructuredWeeklyAiSummary | null = null;

    let weeklyStatusSuccessAt = prevState?.weeklyStatusLastSuccessAt ?? null;
    let weeklyDetailsSuccessAt = prevState?.weeklyDetailsLastSuccessAt ?? null;
    let gSessionSuccessAt = prevState?.gSessionLastSuccessAt ?? null;
    let latestWeekId = prevState?.latestWeekId ?? null;
    let latestGsDate = prevState?.latestGSessionSnapshotDate ?? null;

    try {
      // 1. Weekly Report Sync (Stage 1 + optional Stage 2)
      try {
        const { session, parsed } = await this.weeklyFetcher.fetchTopStatus({
          overrideWrTargetDateId: options.overrideWrTargetDateId,
        });

        const existingSnapshot = await this.repository.getWeeklySnapshot(
          parsed.weekId
        );
        const existingDetails = await this.repository.listWeeklyReportDetails(
          parsed.weekId
        );
        const cachedByStaffId = new Map<number, WeeklyReportDetailDocument>();
        for (const d of existingDetails) {
          cachedByStaffId.set(d.staffId, d);
        }

        const failedDetailStaffIds: number[] = [];

        if (mode === 'WITH_DETAILS') {
          const targetsToFetch: FetchSubmittedDetailsTarget[] = [];

          for (const m of parsed.members) {
            if (
              m.status === 'SUBMITTED' &&
              m.staffId !== null &&
              m.filingDatetime !== null
            ) {
              const cached = cachedByStaffId.get(m.staffId);
              // Idempotent cache check: skip external getReportInfo if same filingDatetime is already stored
              if (cached && cached.filingDatetime === m.filingDatetime) {
                m.hasDetailFetched = true;
                continue;
              }
              targetsToFetch.push({
                staffId: m.staffId,
                staffName: m.staffName,
                wrTargetDateId: m.wrTargetDateId ?? parsed.wrTargetDateId,
                filingDatetime: m.filingDatetime,
              });
            }
          }

          if (targetsToFetch.length > 0) {
            const detailRes = await this.weeklyFetcher.fetchSubmittedDetails(
              session.cookieStr,
              targetsToFetch
            );

            for (const item of detailRes.reports) {
              const contentHash = computeSingleReportHash(item.report);
              const detailDoc: WeeklyReportDetailDocument = {
                weekId: parsed.weekId,
                wrTargetDateId: item.wrTargetDateId,
                staffId: item.report.staffId,
                staffName: item.report.staffName,
                filingDatetime: item.filingDatetime,
                weekUptime:
                  typeof item.report.weekUptime === 'number'
                    ? item.report.weekUptime
                    : item.report.weekUptime !== undefined
                      ? Number(item.report.weekUptime) || null
                      : null,
                impression: item.report.impression,
                projects: item.report.projects,
                externalReadRegistered: item.externalReadRegistered,
                source: 'poweredge_weekly_report_detail',
                contentHash,
                fetchedAt: nowIso,
                updatedAt: nowIso,
              };

              const prevDoc = cachedByStaffId.get(detailDoc.staffId);
              if (!prevDoc || prevDoc.contentHash !== detailDoc.contentHash) {
                await this.repository.saveWeeklyReportDetail(detailDoc);
                itemsUpdated++;
              }
              cachedByStaffId.set(detailDoc.staffId, detailDoc);
            }

            for (const failed of detailRes.failedStaffIds) {
              failedDetailStaffIds.push(failed.staffId);
              errors.push({
                code: 'WEEKLY_DETAIL_PARTIAL_FAILURE',
                message: `Failed to fetch report detail for ${failed.staffName} (${failed.staffId}): ${failed.reason}`,
              });
            }
          }

          for (const m of parsed.members) {
            if (m.staffId !== null && cachedByStaffId.has(m.staffId)) {
              m.hasDetailFetched = true;
            }
          }

          if (failedDetailStaffIds.length === 0) {
            weeklyDetailsSuccessAt = nowIso;
            // Generate or retrieve cached AI summary only when all submitted details succeeded
            if (this.aiSummarizer.isConfigured()) {
              savedAiSummary = await this.getOrGenerateWeeklySummaryInternal(
                parsed.weekId,
                parsed.weekLabel,
                Array.from(cachedByStaffId.values())
              );
            }
          }
        } else {
          // Carry over hasDetailFetched flags from existing snapshot/details
          for (const m of parsed.members) {
            if (m.staffId !== null && cachedByStaffId.has(m.staffId)) {
              m.hasDetailFetched = true;
            }
          }
        }

        const weeklySyncStatus: SyncStatus =
          failedDetailStaffIds.length > 0 ? 'PARTIAL_ERROR' : 'SUCCESS';

        savedWeeklySnapshot = {
          weekId: parsed.weekId,
          wrTargetDateId: parsed.wrTargetDateId,
          weekLabel: parsed.weekLabel,
          source: 'poweredge_weekly_report',
          syncStatus: weeklySyncStatus,
          detailFetchMode:
            mode === 'WITH_DETAILS'
              ? 'WITH_DETAILS'
              : (existingSnapshot?.detailFetchMode ?? 'STATUS_ONLY'),
          submittedCount: parsed.submittedCount,
          unsubmittedCount: parsed.unsubmittedCount,
          totalMembers: parsed.totalMembers,
          members: parsed.members,
          failedDetailStaffIds,
          fetchedAt: nowIso,
          updatedAt: nowIso,
          schemaVersion: 1,
        };

        await this.repository.saveWeeklySnapshot(savedWeeklySnapshot);
        itemsUpdated++;
        weeklyStatusSuccessAt = nowIso;
        latestWeekId = parsed.weekId;
      } catch (weeklyErr) {
        const code =
          weeklyErr instanceof TeamManagementError
            ? weeklyErr.code
            : 'WEEKLY_SYNC_ERROR';
        const message =
          weeklyErr instanceof Error ? weeklyErr.message : String(weeklyErr);
        errors.push({ code, message });
      }

      // 2. GroupSession Sync (Login History + Manager 1-Week Schedule reusing session cookie)
      try {
        const { sessionCookie, result: loginRes } =
          await this.gSessionFetcher.fetchLoginStatuses({ now });
        const scheduleDays = await this.gSessionFetcher.fetchManagerSchedule({
          sessionCookie,
        });

        const snapshotDate = formatJstDateString(now);
        savedGSessionSnapshot = {
          snapshotDate,
          groupSid: loginRes.groupSid,
          inactiveThresholdDays: loginRes.inactiveThresholdDays,
          source: 'poweredge_gsession',
          syncStatus: 'SUCCESS',
          loginStatuses: loginRes.allMembers,
          managerScheduleDays: scheduleDays,
          fetchedAt: nowIso,
          updatedAt: nowIso,
          schemaVersion: 1,
        };

        await this.repository.saveGSessionSnapshot(savedGSessionSnapshot);
        itemsUpdated++;
        gSessionSuccessAt = nowIso;
        latestGsDate = snapshotDate;
      } catch (gsErr) {
        const code =
          gsErr instanceof TeamManagementError
            ? gsErr.code
            : 'GSESSION_SYNC_ERROR';
        const message = gsErr instanceof Error ? gsErr.message : String(gsErr);
        errors.push({ code, message });
      }

      // 3. Determine overall sync status (Fail-Closed: never overwrite valid pointers on failure)
      let finalStatus: SyncStatus = 'SUCCESS';
      if (errors.length > 0) {
        finalStatus =
          savedWeeklySnapshot !== null || savedGSessionSnapshot !== null
            ? 'PARTIAL_ERROR'
            : 'FAILED';
      }

      const lastErrorObj =
        errors.length > 0
          ? {
              code: errors[0].code,
              message: errors.map((e) => `[${e.code}] ${e.message}`).join('; '),
              occurredAt: nowIso,
            }
          : null;

      const nextState: TmCurrentStateDocument = {
        latestWeekId,
        latestGSessionSnapshotDate: latestGsDate,
        weeklyStatusLastSuccessAt: weeklyStatusSuccessAt,
        weeklyDetailsLastSuccessAt: weeklyDetailsSuccessAt,
        gSessionLastSuccessAt: gSessionSuccessAt,
        lastSyncStatus: finalStatus,
        lastSyncError: lastErrorObj,
        updatedAt: nowIso,
      };
      await this.repository.saveCurrentState(nextState);

      const finishedAt = new Date().toISOString();
      const completedJob: TmSyncJobDocument = {
        ...jobDoc,
        status: finalStatus,
        finishedAt,
        durationMs: Math.max(0, Date.now() - now.getTime()),
        errorCode: lastErrorObj?.code ?? null,
        errorMessage: lastErrorObj?.message ?? null,
        itemsUpdated,
      };
      await this.repository.saveSyncJob(completedJob);

      // If previous snapshots exist and this run failed, return previous snapshots with stale freshness
      const effectiveWeekly =
        savedWeeklySnapshot ??
        (latestWeekId
          ? await this.repository.getWeeklySnapshot(latestWeekId)
          : null);
      const effectiveGs =
        savedGSessionSnapshot ??
        (latestGsDate
          ? await this.repository.getGSessionSnapshot(latestGsDate)
          : null);

      return {
        job: completedJob,
        weeklySnapshot: effectiveWeekly,
        gSessionSnapshot: effectiveGs,
        aiSummary:
          savedAiSummary ??
          (latestWeekId
            ? await this.repository.getWeeklyAiSummary(latestWeekId)
            : null),
        freshness: computeDataFreshness(
          nextState,
          'firestore_team_management',
          now
        ),
      };
    } finally {
      await this.lockManager.releaseLock(jobId);
    }
  }

  private async getOrGenerateWeeklySummaryInternal(
    weekId: string,
    weekLabel: string,
    details: WeeklyReportDetailDocument[]
  ): Promise<StructuredWeeklyAiSummary> {
    const reports: WeeklyReportContent[] = details.map((d) => ({
      staffId: d.staffId,
      staffName: d.staffName,
      impression: d.impression,
      weekUptime: d.weekUptime ?? undefined,
      projects: d.projects,
    }));

    const currentHash = computeReportsContentHash(reports);
    const existingSummary = await this.repository.getWeeklyAiSummary(weekId);

    // Content-hash hit: skip Gemini API call and Firestore write!
    if (existingSummary && existingSummary.sourceContentHash === currentHash) {
      return existingSummary;
    }

    const generated = await this.aiSummarizer.generateStructuredSummary(
      weekId,
      weekLabel,
      reports
    );
    await this.repository.saveWeeklyAiSummary(generated);
    return generated;
  }

  /**
   * Fetches aggregated Team Management overview in 2-3 document reads (zero N+1 scans).
   */
  async getOverview(
    now: Date = new Date()
  ): Promise<TeamManagementOverviewResult> {
    const currentState = await this.repository.getCurrentState();
    const freshness = computeDataFreshness(
      currentState,
      'firestore_team_management',
      now
    );

    const [weeklySnapshot, gSessionSnapshot, latestAiSummary] =
      await Promise.all([
        currentState?.latestWeekId
          ? this.repository.getWeeklySnapshot(currentState.latestWeekId)
          : Promise.resolve(null),
        currentState?.latestGSessionSnapshotDate
          ? this.repository.getGSessionSnapshot(
              currentState.latestGSessionSnapshotDate
            )
          : Promise.resolve(null),
        currentState?.latestWeekId
          ? this.repository.getWeeklyAiSummary(currentState.latestWeekId)
          : Promise.resolve(null),
      ]);

    return {
      freshness,
      currentState,
      weeklySnapshot,
      gSessionSnapshot,
      latestAiSummary,
    };
  }

  /**
   * Retrieves weekly snapshot, stored report details, and AI summary for a specific weekId.
   */
  async getWeeklyData(
    weekId?: string,
    now: Date = new Date()
  ): Promise<{
    freshness: DataFreshness;
    snapshot: TmWeeklySnapshotDocument | null;
    details: WeeklyReportDetailDocument[];
    aiSummary: StructuredWeeklyAiSummary | null;
  }> {
    const currentState = await this.repository.getCurrentState();
    const targetWeekId = weekId || currentState?.latestWeekId || null;
    const freshness = computeDataFreshness(
      currentState,
      'firestore_team_management',
      now
    );

    if (!targetWeekId) {
      return {
        freshness,
        snapshot: null,
        details: [],
        aiSummary: null,
      };
    }

    const [snapshot, details, aiSummary] = await Promise.all([
      this.repository.getWeeklySnapshot(targetWeekId),
      this.repository.listWeeklyReportDetails(targetWeekId),
      this.repository.getWeeklyAiSummary(targetWeekId),
    ]);

    return {
      freshness,
      snapshot,
      details,
      aiSummary,
    };
  }

  /**
   * Generates or returns cached AI summary for a week.
   * If report details have not been fetched yet, requires confirmExternalRead: true to run Stage 2 sync.
   */
  async summarizeWeek(options: {
    weekId?: string;
    confirmExternalRead?: boolean;
    triggeredBy: string;
    triggerType?: SyncTriggerType;
  }): Promise<{
    freshness: DataFreshness;
    snapshot: TmWeeklySnapshotDocument | null;
    details: WeeklyReportDetailDocument[];
    aiSummary: StructuredWeeklyAiSummary | null;
  }> {
    const currentState = await this.repository.getCurrentState();
    const targetWeekId = options.weekId || currentState?.latestWeekId;

    if (targetWeekId) {
      const snapshot = await this.repository.getWeeklySnapshot(targetWeekId);
      const details =
        await this.repository.listWeeklyReportDetails(targetWeekId);

      // If all submitted members already have details stored in Firestore, no external read side-effect is needed!
      if (
        snapshot &&
        snapshot.failedDetailStaffIds.length === 0 &&
        details.length >= snapshot.submittedCount &&
        snapshot.submittedCount > 0
      ) {
        const aiSummary = await this.getOrGenerateWeeklySummaryInternal(
          snapshot.weekId,
          snapshot.weekLabel,
          details
        );
        return {
          freshness: computeDataFreshness(currentState),
          snapshot,
          details,
          aiSummary,
        };
      }
    }

    // Otherwise, Stage 2 external fetch is required -> enforces confirmExternalRead === true
    const syncRes = await this.runSync({
      mode: 'WITH_DETAILS',
      confirmExternalRead: options.confirmExternalRead,
      triggerType: options.triggerType ?? 'MANUAL_DASHBOARD',
      triggeredBy: options.triggeredBy,
      overrideWrTargetDateId: targetWeekId ? Number(targetWeekId) : undefined,
    });

    const resolvedWeekId = syncRes.weeklySnapshot?.weekId || targetWeekId || '';
    const details = resolvedWeekId
      ? await this.repository.listWeeklyReportDetails(resolvedWeekId)
      : [];

    return {
      freshness: syncRes.freshness,
      snapshot: syncRes.weeklySnapshot,
      details,
      aiSummary: syncRes.aiSummary,
    };
  }
}
