import {
  StructuredWeeklyAiSummary,
  TmCurrentStateDocument,
  TmGSessionSnapshotDocument,
  TmSyncJobDocument,
  TmSyncLockDocument,
  TmWeeklySnapshotDocument,
  WeeklyReportDetailDocument,
} from './firestore-schema';

/**
 * Abstract repository interface for Team Management persistence (Firestore / In-Memory).
 * Designed for low Read/Write count (aggregated weekly & daily documents).
 */
export interface TeamManagementRepository {
  getCurrentState(): Promise<TmCurrentStateDocument | null>;
  saveCurrentState(state: TmCurrentStateDocument): Promise<void>;

  runLockTransaction<T>(
    updateFn: (
      currentLock: TmSyncLockDocument | null
    ) => Promise<{ nextLock: TmSyncLockDocument; result: T }>
  ): Promise<T>;

  getWeeklySnapshot(weekId: string): Promise<TmWeeklySnapshotDocument | null>;
  saveWeeklySnapshot(snapshot: TmWeeklySnapshotDocument): Promise<void>;

  getWeeklyReportDetail(
    weekId: string,
    staffId: number
  ): Promise<WeeklyReportDetailDocument | null>;
  listWeeklyReportDetails(
    weekId: string
  ): Promise<WeeklyReportDetailDocument[]>;
  saveWeeklyReportDetail(detail: WeeklyReportDetailDocument): Promise<void>;

  getWeeklyAiSummary(weekId: string): Promise<StructuredWeeklyAiSummary | null>;
  saveWeeklyAiSummary(summary: StructuredWeeklyAiSummary): Promise<void>;

  getGSessionSnapshot(
    snapshotDate: string
  ): Promise<TmGSessionSnapshotDocument | null>;
  saveGSessionSnapshot(snapshot: TmGSessionSnapshotDocument): Promise<void>;

  saveSyncJob(job: TmSyncJobDocument): Promise<void>;
  getSyncJob(jobId: string): Promise<TmSyncJobDocument | null>;
  listRecentSyncJobs(limit?: number): Promise<TmSyncJobDocument[]>;
}

/**
 * Transactional in-memory repository implementation supporting unit/integration tests
 * and zero-config local execution while strictly mirroring Firestore document semantics.
 */
export class InMemoryTeamManagementRepository implements TeamManagementRepository {
  private currentState: TmCurrentStateDocument | null = null;
  private syncLock: TmSyncLockDocument | null = null;
  private weeklySnapshots = new Map<string, TmWeeklySnapshotDocument>();
  private weeklyReportDetails = new Map<string, WeeklyReportDetailDocument>();
  private weeklyAiSummaries = new Map<string, StructuredWeeklyAiSummary>();
  private gSessionSnapshots = new Map<string, TmGSessionSnapshotDocument>();
  private syncJobs = new Map<string, TmSyncJobDocument>();

  public readCount = 0;
  public writeCount = 0;

  resetCounters(): void {
    this.readCount = 0;
    this.writeCount = 0;
  }

  async getCurrentState(): Promise<TmCurrentStateDocument | null> {
    this.readCount++;
    return this.currentState ? structuredClone(this.currentState) : null;
  }

  async saveCurrentState(state: TmCurrentStateDocument): Promise<void> {
    this.writeCount++;
    this.currentState = structuredClone(state);
  }

  async runLockTransaction<T>(
    updateFn: (
      currentLock: TmSyncLockDocument | null
    ) => Promise<{ nextLock: TmSyncLockDocument; result: T }>
  ): Promise<T> {
    this.readCount++;
    const currentClone = this.syncLock ? structuredClone(this.syncLock) : null;
    const { nextLock, result } = await updateFn(currentClone);
    this.writeCount++;
    this.syncLock = structuredClone(nextLock);
    return result;
  }

  async getWeeklySnapshot(
    weekId: string
  ): Promise<TmWeeklySnapshotDocument | null> {
    this.readCount++;
    const doc = this.weeklySnapshots.get(weekId);
    return doc ? structuredClone(doc) : null;
  }

  async saveWeeklySnapshot(snapshot: TmWeeklySnapshotDocument): Promise<void> {
    this.writeCount++;
    this.weeklySnapshots.set(snapshot.weekId, structuredClone(snapshot));
  }

  async getWeeklyReportDetail(
    weekId: string,
    staffId: number
  ): Promise<WeeklyReportDetailDocument | null> {
    this.readCount++;
    const key = `${weekId}_${staffId}`;
    const doc = this.weeklyReportDetails.get(key);
    return doc ? structuredClone(doc) : null;
  }

  async listWeeklyReportDetails(
    weekId: string
  ): Promise<WeeklyReportDetailDocument[]> {
    this.readCount++;
    const prefix = `${weekId}_`;
    const list: WeeklyReportDetailDocument[] = [];
    for (const [key, doc] of this.weeklyReportDetails.entries()) {
      if (key.startsWith(prefix)) {
        list.push(structuredClone(doc));
      }
    }
    return list.sort((a, b) => a.staffId - b.staffId);
  }

  async saveWeeklyReportDetail(
    detail: WeeklyReportDetailDocument
  ): Promise<void> {
    this.writeCount++;
    const key = `${detail.weekId}_${detail.staffId}`;
    this.weeklyReportDetails.set(key, structuredClone(detail));
  }

  async getWeeklyAiSummary(
    weekId: string
  ): Promise<StructuredWeeklyAiSummary | null> {
    this.readCount++;
    const doc = this.weeklyAiSummaries.get(weekId);
    return doc ? structuredClone(doc) : null;
  }

  async saveWeeklyAiSummary(summary: StructuredWeeklyAiSummary): Promise<void> {
    this.writeCount++;
    this.weeklyAiSummaries.set(summary.weekId, structuredClone(summary));
  }

  async getGSessionSnapshot(
    snapshotDate: string
  ): Promise<TmGSessionSnapshotDocument | null> {
    this.readCount++;
    const doc = this.gSessionSnapshots.get(snapshotDate);
    return doc ? structuredClone(doc) : null;
  }

  async saveGSessionSnapshot(
    snapshot: TmGSessionSnapshotDocument
  ): Promise<void> {
    this.writeCount++;
    this.gSessionSnapshots.set(
      snapshot.snapshotDate,
      structuredClone(snapshot)
    );
  }

  async saveSyncJob(job: TmSyncJobDocument): Promise<void> {
    this.writeCount++;
    this.syncJobs.set(job.jobId, structuredClone(job));
  }

  async getSyncJob(jobId: string): Promise<TmSyncJobDocument | null> {
    this.readCount++;
    const doc = this.syncJobs.get(jobId);
    return doc ? structuredClone(doc) : null;
  }

  async listRecentSyncJobs(limit = 10): Promise<TmSyncJobDocument[]> {
    this.readCount++;
    return Array.from(this.syncJobs.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }
}

let defaultRepositoryInstance: TeamManagementRepository | null = null;

export function getDefaultTeamManagementRepository(): TeamManagementRepository {
  if (!defaultRepositoryInstance) {
    defaultRepositoryInstance = new InMemoryTeamManagementRepository();
  }
  return defaultRepositoryInstance;
}

export function setDefaultTeamManagementRepository(
  repo: TeamManagementRepository | null
): void {
  defaultRepositoryInstance = repo;
}
