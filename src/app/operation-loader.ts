import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpInterceptorFn } from '@angular/common/http';
import { finalize } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class OperationLoader {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  readonly isLoading = signal<boolean>(false);
  readonly progressPercent = signal<number>(0);
  readonly label = signal<string>('Loading data...');

  private activeCount = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;

  public start(operationLabel = 'Loading data...'): void {
    if (!this.isBrowser) return;

    this.label.set(operationLabel);
    this.activeCount++;

    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }

    if (!this.isLoading()) {
      this.startedAt = Date.now();
      this.isLoading.set(true);
      this.progressPercent.set(12);
    } else if (this.progressPercent() >= 95 || this.progressPercent() < 12) {
      this.progressPercent.set(18);
    }

    if (!this.progressTimer) {
      this.progressTimer = setInterval(() => {
        const current = this.progressPercent();
        if (current < 45) {
          this.progressPercent.set(Math.min(45, current + 9));
        } else if (current < 72) {
          this.progressPercent.set(Math.min(72, current + 5));
        } else if (current < 88) {
          this.progressPercent.set(Math.min(88, current + 2));
        } else if (current < 95) {
          this.progressPercent.set(Math.min(95, current + 1));
        }
      }, 40);
    }
  }

  public finish(): void {
    if (!this.isBrowser) return;

    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.activeCount > 0) {
      return;
    }

    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }

    const current = this.progressPercent();
    const elapsed = Date.now() - this.startedAt;

    if (current < 70 && elapsed < 140) {
      // Smoothly step through intermediate percentage so fast operations still show visible % progression
      this.progressPercent.set(68);
      this.stepTimer = setTimeout(() => {
        this.progressPercent.set(100);
        this.hideTimer = setTimeout(() => {
          if (this.activeCount === 0) {
            this.isLoading.set(false);
            this.progressPercent.set(0);
          }
        }, 200);
      }, 90);
    } else {
      this.progressPercent.set(100);
      this.hideTimer = setTimeout(() => {
        if (this.activeCount === 0) {
          this.isLoading.set(false);
          this.progressPercent.set(0);
        }
      }, 220);
    }
  }

  public pulseQuickOperation(operationLabel: string): void {
    if (!this.isBrowser) return;
    this.start(operationLabel);
    setTimeout(() => {
      this.finish();
    }, 120);
  }
}

function resolveHttpOperationLabel(url: string, body: unknown): string {
  const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  if (url.includes('/api/workspace/databases/delete')) {
    const db = typeof payload['databaseName'] === 'string' ? payload['databaseName'] : '';
    return db ? `Dropping database "${db}"...` : 'Dropping database...';
  }
  if (url.includes('/api/workspace/databases')) {
    const db = typeof payload['databaseName'] === 'string' ? payload['databaseName'] : '';
    return db ? `Creating database "${db}"...` : 'Creating database...';
  }
  if (url.includes('/api/workspace/tables/delete')) {
    const tbl = typeof payload['tableName'] === 'string' ? payload['tableName'] : '';
    return tbl ? `Dropping table "${tbl}"...` : 'Dropping table...';
  }
  if (url.includes('/api/workspace/tables')) {
    const tbl = typeof payload['tableName'] === 'string' ? payload['tableName'] : '';
    return tbl ? `Creating table "${tbl}"...` : 'Creating table...';
  }
  if (url.includes('/api/workspace/query')) {
    if (payload['selectAll'] === true) {
      const tbl = typeof payload['tableName'] === 'string' ? payload['tableName'] : 'table';
      return `Selecting all rows from "${tbl}"...`;
    }
    const offset = typeof payload['offset'] === 'number' ? payload['offset'] : 0;
    if (offset > 0) {
      return `Loading more rows (offset ${offset})...`;
    }
    return 'Loading table data from database...';
  }
  if (url.includes('/api/workspace/sync')) {
    const actionType = typeof payload['actionType'] === 'string' ? payload['actionType'] : '';
    if (actionType) {
      return `Syncing ${actionType} to database...`;
    }
    return 'Saving changes to database...';
  }
  if (url.includes('/api/workspace/generate-rows')) {
    return 'Generating rows in database...';
  }
  if (url.includes('/api/workspace/versions/restore')) {
    return 'Restoring database version snapshot...';
  }
  if (url.includes('/api/workspace/versions')) {
    return 'Committing database snapshot...';
  }
  if (url.includes('/api/auth/')) {
    return 'Authenticating user account...';
  }
  if (url.includes('/api/workspace')) {
    return 'Loading workspace data...';
  }
  return 'Loading data...';
}

export const operationLoaderInterceptor: HttpInterceptorFn = (req, next) => {
  // Skip background cursor presence heartbeats so collaborator cursor polling does not trigger the loader
  if (req.url.includes('/api/workspace/presence')) {
    return next(req);
  }

  // Skip table scroll lazy loading (offset > 0) so scrolling the table does not trigger the full-screen loader
  if (req.url.includes('/api/workspace/query')) {
    const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const offset = typeof payload['offset'] === 'number' ? payload['offset'] : 0;
    if (offset > 0) {
      return next(req);
    }
  }

  const loader = inject(OperationLoader);
  const label = resolveHttpOperationLabel(req.url, req.body);
  loader.start(label);

  return next(req).pipe(
    finalize(() => {
      loader.finish();
    })
  );
};
