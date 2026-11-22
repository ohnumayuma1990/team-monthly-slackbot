import { SyncConflictError, SyncTriggerType } from '../core/types';
import { TmSyncLockDocument } from '../storage/firestore-schema';
import { TeamManagementRepository } from '../storage/repository';

export const DEFAULT_SYNC_LOCK_TTL_MS = 180 * 1000; // 180 seconds

/**
 * Manages distributed lease locks on `tm_meta/sync_lock` to prevent concurrent
 * scheduled and manual sync jobs from colliding.
 */
export class SyncLeaseLockManager {
  private repository: TeamManagementRepository;
  private ttlMs: number;

  constructor(
    repository: TeamManagementRepository,
    ttlMs: number = DEFAULT_SYNC_LOCK_TTL_MS
  ) {
    this.repository = repository;
    this.ttlMs = ttlMs;
  }

  /**
   * Acquires the sync lock transactionally.
   * Throws SyncConflictError (HTTP 409) if currently locked and lease has not expired.
   * Reclaims the lock automatically if a previous job crashed and its lease expired.
   */
  async acquireLock(
    jobId: string,
    triggerType: SyncTriggerType,
    now: Date = new Date()
  ): Promise<TmSyncLockDocument> {
    return this.repository.runLockTransaction(async (currentLock) => {
      const nowMs = now.getTime();
      if (currentLock && currentLock.isLocked && currentLock.expiresAt) {
        const expiresMs = Date.parse(currentLock.expiresAt);
        if (!Number.isNaN(expiresMs) && expiresMs > nowMs) {
          throw new SyncConflictError(
            currentLock.lockOwnerJobId || 'unknown',
            currentLock.expiresAt
          );
        }
      }

      const nextLock: TmSyncLockDocument = {
        isLocked: true,
        lockOwnerJobId: jobId,
        triggerType,
        lockedAt: now.toISOString(),
        expiresAt: new Date(nowMs + this.ttlMs).toISOString(),
      };

      return { nextLock, result: nextLock };
    });
  }

  /**
   * Releases the sync lock if still owned by `jobId`.
   */
  async releaseLock(jobId: string): Promise<void> {
    await this.repository.runLockTransaction(async (currentLock) => {
      if (currentLock && currentLock.lockOwnerJobId !== jobId) {
        return { nextLock: currentLock, result: undefined };
      }
      const unlocked: TmSyncLockDocument = {
        isLocked: false,
        lockOwnerJobId: null,
        triggerType: null,
        lockedAt: null,
        expiresAt: null,
      };
      return { nextLock: unlocked, result: undefined };
    });
  }
}
