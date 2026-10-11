import { Injectable, OnDestroy, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { GridRealtimeSyncService } from './grid-realtime-sync';

/**
 * Unified service managing the lifecycle of cell status highlights:
 * 1. Yellow (.cell-redis-pending): Cell data changed and pushed to Redis write-behind buffer, not yet saved in PostgreSQL.
 * 2. Green (.cell-db-saved): Cell data flushed from Redis and saved in PostgreSQL; highlighted green for 3 seconds, then automatically cleared.
 */
@Injectable({
  providedIn: 'root',
})
export class CellHighlightState implements OnDestroy {
  private readonly realtimeSync = inject(GridRealtimeSyncService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  /** Duration (in ms) that a cell remains highlighted green after being saved to PostgreSQL. */
  public readonly greenHighlightDurationMs = 3000;

  /** Map of `${rowId}:${colId}` -> timestamp when marked pending in Redis (Yellow highlight). */
  public readonly redisPendingCells = signal<Record<string, number>>({});

  /** Map of `${rowId}:${colId}` -> timestamp when saved in PostgreSQL (Green highlight for 3s). */
  public readonly dbSavedGreenCells = signal<Record<string, number>>({});

  /** Per-cell 3-second cleanup timers keyed by `${rowId}:${colId}`. */
  private readonly greenHighlightTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Central timer that verifies/flushes the Redis write-behind buffer into PostgreSQL. */
  private flushVerificationTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Returns true if the given cell is currently staged in Redis and waiting to be saved to PostgreSQL (Yellow).
   */
  public isCellRedisPending(rowId: string, colId: string): boolean {
    return Boolean(this.redisPendingCells()[`${rowId}:${colId}`]);
  }

  /**
   * Returns true if the given cell was recently saved to PostgreSQL and is within its 3-second Green highlight window.
   */
  public isCellDbSaved(rowId: string, colId: string): boolean {
    return Boolean(this.dbSavedGreenCells()[`${rowId}:${colId}`]);
  }

  /**
   * Marks one or more cells (`${rowId}:${colId}`) as pending in Redis (Yellow highlight),
   * clears any prior Green highlight/timer on those cells, and schedules write-behind flush verification.
   */
  public markCellsPendingInRedis(
    cellKeys: string[],
    invalidCellErrors: Record<string, string> = {}
  ): void {
    if (!cellKeys || cellKeys.length === 0) return;

    const validKeys = cellKeys.filter((k) => Boolean(k) && !invalidCellErrors[k]);
    if (validKeys.length === 0) return;

    const now = Date.now();

    this.redisPendingCells.update((prev) => {
      const next = { ...prev };
      for (const key of validKeys) {
        next[key] = now;
      }
      return next;
    });

    this.dbSavedGreenCells.update((prev) => {
      const next = { ...prev };
      for (const key of validKeys) {
        delete next[key];
        this.cancelGreenTimer(key);
      }
      return next;
    });

    this.scheduleFlushVerification(invalidCellErrors);
  }

  /**
   * Transitions cells from Yellow (Redis pending) to Green (Database saved) for 3 seconds,
   * then automatically removes the Green highlight and cleans up timers.
   */
  public transitionPendingToSavedGreen(
    specificKeys?: string[],
    invalidCellErrors: Record<string, string> = {}
  ): void {
    const pendingMap = this.redisPendingCells();
    const keysToTransition =
      specificKeys && specificKeys.length > 0
        ? specificKeys.filter((k) => Boolean(pendingMap[k]))
        : Object.keys(pendingMap);

    if (keysToTransition.length === 0) return;

    this.redisPendingCells.update((prev) => {
      const next = { ...prev };
      for (const key of keysToTransition) {
        delete next[key];
      }
      return next;
    });

    const validTransitionKeys = keysToTransition.filter((key) => !invalidCellErrors[key]);
    if (validTransitionKeys.length === 0) return;

    const now = Date.now();
    this.dbSavedGreenCells.update((prev) => {
      const next = { ...prev };
      for (const key of validTransitionKeys) {
        next[key] = now;
      }
      return next;
    });

    if (this.isBrowser) {
      for (const key of validTransitionKeys) {
        this.scheduleGreenTimer(key);
      }
    }
  }

  /**
   * Immediately removes a single cell from both Yellow (Redis pending) and Green (DB saved) states
   * and cancels its 3-second timer (e.g., when a cell fails validation).
   */
  public clearCellHighlight(cellKey: string): void {
    if (!cellKey) return;

    if (this.redisPendingCells()[cellKey]) {
      this.redisPendingCells.update((prev) => {
        const next = { ...prev };
        delete next[cellKey];
        return next;
      });
    }

    if (this.dbSavedGreenCells()[cellKey]) {
      this.dbSavedGreenCells.update((prev) => {
        const next = { ...prev };
        delete next[cellKey];
        return next;
      });
    }

    this.cancelGreenTimer(cellKey);
  }

  /**
   * Centrally clears all Yellow and Green cell highlights and cancels all active timers.
   */
  public clearAllHighlights(): void {
    if (this.flushVerificationTimer) {
      clearTimeout(this.flushVerificationTimer);
      this.flushVerificationTimer = null;
    }
    for (const timer of this.greenHighlightTimers.values()) {
      clearTimeout(timer);
    }
    this.greenHighlightTimers.clear();
    this.redisPendingCells.set({});
    this.dbSavedGreenCells.set({});
  }

  private scheduleGreenTimer(cellKey: string): void {
    this.cancelGreenTimer(cellKey);
    const timer = setTimeout(() => {
      this.greenHighlightTimers.delete(cellKey);
      this.dbSavedGreenCells.update((prev) => {
        if (!prev[cellKey]) return prev;
        const next = { ...prev };
        delete next[cellKey];
        return next;
      });
    }, this.greenHighlightDurationMs);
    this.greenHighlightTimers.set(cellKey, timer);
  }

  private cancelGreenTimer(cellKey: string): void {
    const existing = this.greenHighlightTimers.get(cellKey);
    if (existing) {
      clearTimeout(existing);
      this.greenHighlightTimers.delete(cellKey);
    }
  }

  private scheduleFlushVerification(invalidCellErrors: Record<string, string> = {}): void {
    if (!this.isBrowser) return;
    if (this.flushVerificationTimer) {
      clearTimeout(this.flushVerificationTimer);
    }
    this.flushVerificationTimer = setTimeout(async () => {
      this.flushVerificationTimer = null;
      if (Object.keys(this.redisPendingCells()).length === 0) {
        return;
      }
      const status = await this.realtimeSync.triggerManualPostgresFlush();
      if (!status || status.dirtyRowCount === 0) {
        this.transitionPendingToSavedGreen(undefined, invalidCellErrors);
      } else {
        this.scheduleFlushVerification(invalidCellErrors);
      }
    }, 1300);
  }

  ngOnDestroy(): void {
    this.clearAllHighlights();
  }
}
