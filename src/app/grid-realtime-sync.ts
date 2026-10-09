import { Injectable, OnDestroy, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Observable, Subject, firstValueFrom } from 'rxjs';

export type RealtimeConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'buffering_offline';

export interface CellDeltaPayload {
  mutationId: string;
  databaseName: string;
  tableName: string;
  rowId: string;
  columnId: string;
  rawValue: string | null;
  userId: string;
  userName: string;
  userColor: string;
  clientTimestampMs: number;
}

export interface CellAckPayload {
  mutationId: string;
  accepted: boolean;
  databaseName: string;
  tableName: string;
  rowId: string;
  columnId: string;
  authoritativeValue: string | null;
  authoritativeTimestampMs: number;
  updatedBy: string;
}

export interface WriteBehindBufferStatus {
  dirtyRowCount: number;
  pendingDdlCount?: number;
  totalCoalescedEdits: number;
  totalPostgresBulkFlushes: number;
  oldestDirtyTimestampMs: number | null;
  lastFlushedAt: string | null;
  flushIntervalSeconds: number;
  bufferThresholdRows: number;
}

export type RealtimeCrudAction =
  | 'get_workspace'
  | 'get_tree'
  | 'query_rows'
  | 'create_database'
  | 'delete_database'
  | 'rename_database'
  | 'create_table'
  | 'delete_table'
  | 'rename_or_edit_table'
  | 'workspace_sync'
  | 'restore_version'
  | 'presence';

interface HubWireFrame {
  type:
    | 'JoinTableGroup'
    | 'LeaveTableGroup'
    | 'StreamCellDelta'
    | 'StreamCellDeltaBatch'
    | 'ExecuteCrudCommand'
    | 'CrudCommandAck'
    | 'ReceiveCellDelta'
    | 'ReceiveCellDeltaBatch'
    | 'ReceiveCellReconciliation'
    | 'ReceiveWorkspaceSync'
    | 'CellAck'
    | 'CellBatchAck'
    | 'WriteBehindStatus';
  invocationId?: string;
  databaseName?: string;
  tableName?: string;
  crudAction?: RealtimeCrudAction;
  payload?: Record<string, unknown>;
  result?: unknown;
  delta?: CellDeltaPayload;
  deltas?: CellDeltaPayload[];
  ack?: CellAckPayload;
  acks?: CellAckPayload[];
  status?: WriteBehindBufferStatus;
}

@Injectable({
  providedIn: 'root',
})
export class GridRealtimeSyncService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  private ws: WebSocket | null = null;
  private reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private isDestroyed = false;
  private activeGroup: { databaseName: string; tableName: string } | null = null;

  // Coalesces rapid keystrokes per cell ("db|table|rowId|colId") within a 50ms micro-window
  private readonly microCoalesceMap = new Map<string, CellDeltaPayload>();
  private coalesceTimerId: ReturnType<typeof setTimeout> | null = null;
  private readonly coalesceWindowMs = 50;

  // Stores coalesced cell mutations and structural CRUD commands while reconnecting
  private readonly offlineDeltaMap = new Map<string, CellDeltaPayload>();
  private readonly offlineCrudQueue: {
    crudAction: RealtimeCrudAction;
    payload: Record<string, unknown>;
  }[] = [];
  private readonly maxOfflineBufferSize = 5000;

  // Pending WebSocket RPC invocation callbacks keyed by invocationId
  private readonly pendingInvocations = new Map<
    string,
    {
      resolve: (val: CellAckPayload[]) => void;
      reject: (err: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly pendingCrudInvocations = new Map<
    string,
    {
      resolve: (val: unknown) => void;
      reject: (err: unknown) => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >();

  // Reactive Signals for UI Connection & Write-Behind Buffer Indicators
  public readonly connectionStatus = signal<RealtimeConnectionStatus>('disconnected');
  public readonly transportMode = signal<'websocket' | 'stream'>('websocket');
  public readonly pendingOfflineCount = signal<number>(0);
  public readonly lastAckTimestampMs = signal<number | null>(null);
  public readonly writeBehindStatus = signal<WriteBehindBufferStatus>({
    dirtyRowCount: 0,
    totalCoalescedEdits: 0,
    totalPostgresBulkFlushes: 0,
    oldestDirtyTimestampMs: null,
    lastFlushedAt: null,
    flushIntervalSeconds: 120,
    bufferThresholdRows: 100,
  });

  public readonly statusBadgeText = computed(() => {
    const status = this.connectionStatus();
    const queued = this.pendingOfflineCount();
    const wb = this.writeBehindStatus();
    switch (status) {
      case 'connected':
        return wb.dirtyRowCount > 0
          ? `SignalR/WS · Redis Buffer (${wb.dirtyRowCount} dirty)`
          : 'SignalR/WS · Live';
      case 'connecting':
        return 'Connecting SignalR/WS...';
      case 'reconnecting':
      case 'buffering_offline':
        return queued > 0 ? `Reconnecting (${queued} buffered)` : 'Reconnecting...';
      default:
        return queued > 0 ? `Offline (${queued} buffered)` : 'Disconnected';
    }
  });

  private readonly remoteDeltaSubject = new Subject<CellDeltaPayload>();
  private readonly remoteBatchSubject = new Subject<CellDeltaPayload[]>();
  private readonly reconciliationSubject = new Subject<CellAckPayload>();
  private readonly remoteWorkspaceSyncSubject = new Subject<Record<string, unknown>>();

  public readonly remoteDelta$: Observable<CellDeltaPayload> =
    this.remoteDeltaSubject.asObservable();
  public readonly remoteBatch$: Observable<CellDeltaPayload[]> =
    this.remoteBatchSubject.asObservable();
  public readonly reconciliation$: Observable<CellAckPayload> =
    this.reconciliationSubject.asObservable();
  public readonly remoteWorkspaceSync$: Observable<Record<string, unknown>> =
    this.remoteWorkspaceSyncSubject.asObservable();

  public initializeConnection(databaseName?: string, tableName?: string): void {
    if (!this.isBrowser || this.isDestroyed) return;
    if (databaseName && tableName) {
      this.activeGroup = { databaseName, tableName };
    }
    this.connectWebSocket();
  }

  public switchTableGroup(databaseName: string, tableName: string): void {
    if (!databaseName || !tableName) return;
    const prev = this.activeGroup;
    this.activeGroup = { databaseName, tableName };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (
        prev &&
        (prev.databaseName !== databaseName || prev.tableName !== tableName)
      ) {
        this.sendWsFrame({
          type: 'LeaveTableGroup',
          databaseName: prev.databaseName,
          tableName: prev.tableName,
        });
      }
      this.sendWsFrame({
        type: 'JoinTableGroup',
        databaseName,
        tableName,
      });
    }
  }

  /**
   * Streams a micro cell-level delta instead of a full HTTP table payload.
   * Coalesces keystrokes over a 50ms window and sends via WebSocket (with automatic
   * fallback to the multiplexed `/api/realtime/delta` endpoint if Vite dev proxy intercepts WS).
   */
  public queueCellMutation(params: {
    databaseName: string;
    tableName: string;
    rowId: string;
    columnId: string;
    rawValue: string | number | boolean | null;
    userId: string;
    userName: string;
    userColor: string;
  }): void {
    const cellKey = `${params.databaseName}|${params.tableName}|${params.rowId}|${params.columnId}`;
    const payload: CellDeltaPayload = {
      mutationId: `mut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      databaseName: params.databaseName,
      tableName: params.tableName,
      rowId: params.rowId,
      columnId: params.columnId,
      rawValue:
        params.rawValue === null || params.rawValue === undefined
          ? ''
          : String(params.rawValue),
      userId: params.userId,
      userName: params.userName,
      userColor: params.userColor,
      clientTimestampMs: Date.now(),
    };

    this.microCoalesceMap.set(cellKey, payload);

    if (!this.coalesceTimerId) {
      this.coalesceTimerId = setTimeout(() => {
        this.coalesceTimerId = null;
        void this.flushMicroCoalesceBuffer();
      }, this.coalesceWindowMs);
    }
  }

  /**
   * Queues multiple cell mutations at once (e.g. from a multi-cell edit or row update).
   */
  public queueCellMutationBatch(deltas: CellDeltaPayload[]): void {
    for (const delta of deltas) {
      const cellKey = `${delta.databaseName}|${delta.tableName}|${delta.rowId}|${delta.columnId}`;
      this.microCoalesceMap.set(cellKey, delta);
    }
    if (!this.coalesceTimerId) {
      this.coalesceTimerId = setTimeout(() => {
        this.coalesceTimerId = null;
        void this.flushMicroCoalesceBuffer();
      }, this.coalesceWindowMs);
    }
  }

  /**
   * Primary Real-Time CRUD Method for the entire project (Sidebar Tree Databases, Tables, Fields + Grid Rows, Columns, Queries).
   * Dispatches over persistent WebSocket if open, with seamless fallback to the multiplexed `/api/realtime/crud` endpoint
   * and automatic offline write-behind queueing.
   */
  public executeCrud<T = Record<string, unknown>>(
    crudAction: RealtimeCrudAction,
    payload: Record<string, unknown> = {}
  ): Observable<T> {
    return new Observable<T>((subscriber) => {
      this.dispatchCrudToServer<T>(crudAction, payload)
        .then((res) => {
          subscriber.next(res);
          subscriber.complete();
        })
        .catch((err) => {
          subscriber.error(err);
        });
    });
  }

  private async dispatchCrudToServer<T>(
    crudAction: RealtimeCrudAction,
    payload: Record<string, unknown>
  ): Promise<T> {
    // 1. Prefer persistent WebSocket RPC if socket is open
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const invocationId = `crud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        const wsRes = await new Promise<T>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            this.pendingCrudInvocations.delete(invocationId);
            reject(new Error('WebSocket CRUD invocation timeout'));
          }, 4500);

          this.pendingCrudInvocations.set(invocationId, {
            resolve: (val) => resolve(val as T),
            reject,
            timeoutId,
          });

          this.sendWsFrame({
            type: 'ExecuteCrudCommand',
            invocationId,
            crudAction,
            payload,
          });
        });
        this.connectionStatus.set('connected');
        return wsRes;
      } catch {
        // Fall through to multiplexed HTTP CRUD stream if WS frame timed out
      }
    }

    // 2. Multiplexed real-time CRUD endpoint (operates against the server's in-memory Redis cache + write-behind buffer)
    try {
      const response = await firstValueFrom(
        this.http.post<{
          ok: boolean;
          result?: T;
          status?: WriteBehindBufferStatus;
        }>('/api/realtime/crud', {
          crudAction,
          payload,
        })
      );
      this.connectionStatus.set('connected');
      if (response?.status) {
        this.writeBehindStatus.set(response.status);
      }
      if (response && response.result !== undefined) {
        return response.result;
      }
      return (response as unknown) as T;
    } catch (err) {
      const isMutating =
        crudAction !== 'get_workspace' &&
        crudAction !== 'get_tree' &&
        crudAction !== 'query_rows' &&
        crudAction !== 'presence';
      if (isMutating && this.offlineCrudQueue.length < this.maxOfflineBufferSize) {
        this.offlineCrudQueue.push({ crudAction, payload });
        this.pendingOfflineCount.set(
          this.offlineDeltaMap.size + this.offlineCrudQueue.length
        );
        this.connectionStatus.set('buffering_offline');
        this.scheduleReconnect();
      }
      throw err;
    }
  }

  /**
   * Allows external SSE listener in App to feed server-pushed delta frames when running in hybrid stream mode.
   */
  public handleServerStreamEvent(
    eventType:
      | 'cell_delta'
      | 'cell_delta_batch'
      | 'cell_reconciliation'
      | 'write_behind_status'
      | 'workspace_sync',
    data: unknown
  ): void {
    if (!data || typeof data !== 'object') return;
    if (eventType === 'cell_delta') {
      this.remoteDeltaSubject.next(data as CellDeltaPayload);
    } else if (eventType === 'cell_delta_batch') {
      const batch = (data as { deltas?: CellDeltaPayload[] }).deltas;
      if (Array.isArray(batch) && batch.length > 0) {
        this.remoteBatchSubject.next(batch);
      }
    } else if (eventType === 'cell_reconciliation') {
      this.reconciliationSubject.next(data as CellAckPayload);
    } else if (eventType === 'write_behind_status') {
      this.writeBehindStatus.set(data as WriteBehindBufferStatus);
    } else if (eventType === 'workspace_sync') {
      this.remoteWorkspaceSyncSubject.next(data as Record<string, unknown>);
    }
  }

  public async triggerManualPostgresFlush(): Promise<WriteBehindBufferStatus | null> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ ok: boolean; status?: WriteBehindBufferStatus }>(
          '/api/realtime/flush',
          {}
        )
      );
      if (res?.status) {
        this.writeBehindStatus.set(res.status);
        return res.status;
      }
    } catch {
      // Ignore transient error
    }
    return null;
  }

  private async flushMicroCoalesceBuffer(): Promise<void> {
    if (this.microCoalesceMap.size === 0) return;

    const deltas = Array.from(this.microCoalesceMap.values());
    this.microCoalesceMap.clear();

    try {
      const acks = await this.dispatchDeltasToServer(deltas);
      this.connectionStatus.set('connected');
      for (const ack of acks) {
        this.handleServerAck(ack);
      }
    } catch {
      for (const delta of deltas) {
        this.bufferDeltaOffline(delta);
      }
      this.scheduleReconnect();
    }
  }

  private async dispatchDeltasToServer(deltas: CellDeltaPayload[]): Promise<CellAckPayload[]> {
    // 1. Prefer persistent WebSocket frame if socket is open
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const invocationId = `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      return new Promise<CellAckPayload[]>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.pendingInvocations.delete(invocationId);
          reject(new Error('WebSocket invocation timeout'));
        }, 4000);

        this.pendingInvocations.set(invocationId, { resolve, reject, timeoutId });

        if (deltas.length === 1) {
          this.sendWsFrame({
            type: 'StreamCellDelta',
            invocationId,
            delta: deltas[0],
          });
        } else {
          this.sendWsFrame({
            type: 'StreamCellDeltaBatch',
            invocationId,
            deltas,
          });
        }
      });
    }

    // 2. Multiplexed delta stream transport (works even behind proxies that intercept raw WS upgrades)
    const response = await firstValueFrom(
      this.http.post<{
        ok: boolean;
        acks?: CellAckPayload[];
        status?: WriteBehindBufferStatus;
      }>('/api/realtime/delta', { deltas })
    );

    if (!response?.ok) {
      throw new Error('Delta stream rejected');
    }
    if (response.status) {
      this.writeBehindStatus.set(response.status);
    }
    return response.acks || [];
  }

  private bufferDeltaOffline(delta: CellDeltaPayload): void {
    const key = `${delta.databaseName}|${delta.tableName}|${delta.rowId}|${delta.columnId}`;
    const existing = this.offlineDeltaMap.get(key);

    if (!existing || delta.clientTimestampMs >= existing.clientTimestampMs) {
      if (
        !this.offlineDeltaMap.has(key) &&
        this.offlineDeltaMap.size >= this.maxOfflineBufferSize
      ) {
        const oldestKey = this.offlineDeltaMap.keys().next().value;
        if (oldestKey) {
          this.offlineDeltaMap.delete(oldestKey);
        }
      }
      this.offlineDeltaMap.set(key, delta);
      this.pendingOfflineCount.set(this.offlineDeltaMap.size);
    }

    this.connectionStatus.set('buffering_offline');
  }

  private async flushOfflineBufferOnReconnect(): Promise<void> {
    if (this.offlineCrudQueue.length > 0) {
      const queuedCruds = this.offlineCrudQueue.splice(0, this.offlineCrudQueue.length);
      for (const item of queuedCruds) {
        try {
          await this.dispatchCrudToServer(item.crudAction, item.payload);
        } catch {
          this.offlineCrudQueue.unshift(item);
          break;
        }
      }
      this.pendingOfflineCount.set(this.offlineDeltaMap.size + this.offlineCrudQueue.length);
    }

    if (this.offlineDeltaMap.size === 0) return;

    const bufferedDeltas = Array.from(this.offlineDeltaMap.values()).sort(
      (a, b) => a.clientTimestampMs - b.clientTimestampMs
    );
    this.offlineDeltaMap.clear();
    this.pendingOfflineCount.set(this.offlineCrudQueue.length);

    const chunkSize = 200;
    for (let i = 0; i < bufferedDeltas.length; i += chunkSize) {
      const chunk = bufferedDeltas.slice(i, i + chunkSize);
      try {
        const acks = await this.dispatchDeltasToServer(chunk);
        for (const ack of acks) {
          this.handleServerAck(ack);
        }
      } catch {
        for (const d of chunk) {
          this.bufferDeltaOffline(d);
        }
        return;
      }
    }
  }

  private handleServerAck(ack: CellAckPayload): void {
    if (!ack) return;
    this.lastAckTimestampMs.set(ack.authoritativeTimestampMs);
    if (!ack.accepted) {
      this.reconciliationSubject.next(ack);
    }
  }

  private connectWebSocket(): void {
    if (!this.isBrowser || this.isDestroyed) return;

    try {
      this.connectionStatus.set(
        this.offlineDeltaMap.size > 0 ? 'buffering_offline' : 'connecting'
      );
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/api/realtime-ws`;
      const socket = new WebSocket(wsUrl);
      this.ws = socket;

      socket.onopen = () => {
        this.reconnectAttempt = 0;
        this.transportMode.set('websocket');
        this.connectionStatus.set('connected');
        if (this.activeGroup) {
          this.sendWsFrame({
            type: 'JoinTableGroup',
            databaseName: this.activeGroup.databaseName,
            tableName: this.activeGroup.tableName,
          });
        }
        void this.flushOfflineBufferOnReconnect();
      };

      socket.onmessage = (event: MessageEvent) => {
        try {
          const frame = JSON.parse(String(event.data)) as HubWireFrame;
          this.handleIncomingWsFrame(frame);
        } catch {
          // Ignore malformed frame
        }
      };

      socket.onerror = () => {
        // If Vite dev server intercepts raw WS upgrade, seamlessly operate over multiplexed stream mode
        this.transportMode.set('stream');
        this.connectionStatus.set('connected');
        void this.flushOfflineBufferOnReconnect();
      };

      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = null;
        }
        if (this.transportMode() === 'stream') {
          this.connectionStatus.set(
            this.offlineDeltaMap.size > 0 ? 'buffering_offline' : 'connected'
          );
          return;
        }
        this.scheduleReconnect();
      };
    } catch {
      this.transportMode.set('stream');
      this.connectionStatus.set('connected');
    }
  }

  private handleIncomingWsFrame(frame: HubWireFrame): void {
    if (frame.status) {
      this.writeBehindStatus.set(frame.status);
    }

    if (
      frame.type === 'CrudCommandAck' &&
      frame.invocationId &&
      this.pendingCrudInvocations.has(frame.invocationId)
    ) {
      const pending = this.pendingCrudInvocations.get(frame.invocationId)!;
      clearTimeout(pending.timeoutId);
      this.pendingCrudInvocations.delete(frame.invocationId);
      pending.resolve(frame.result);
      return;
    }

    if (
      (frame.type === 'CellAck' || frame.type === 'CellBatchAck') &&
      frame.invocationId &&
      this.pendingInvocations.has(frame.invocationId)
    ) {
      const pending = this.pendingInvocations.get(frame.invocationId)!;
      clearTimeout(pending.timeoutId);
      this.pendingInvocations.delete(frame.invocationId);
      const acks = frame.acks || (frame.ack ? [frame.ack] : []);
      pending.resolve(acks);
      return;
    }

    if (frame.type === 'ReceiveCellDelta' && frame.delta) {
      this.remoteDeltaSubject.next(frame.delta);
    } else if (frame.type === 'ReceiveCellDeltaBatch' && Array.isArray(frame.deltas)) {
      this.remoteBatchSubject.next(frame.deltas);
    } else if (frame.type === 'ReceiveCellReconciliation' && frame.ack) {
      this.reconciliationSubject.next(frame.ack);
    } else if (frame.type === 'ReceiveWorkspaceSync' && frame.payload) {
      this.remoteWorkspaceSyncSubject.next(frame.payload);
    }
  }

  private sendWsFrame(frame: HubWireFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimerId) return;
    this.reconnectAttempt++;
    const baseDelay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempt, 4)), 15000);
    const jitter = Math.floor(Math.random() * 350);
    this.reconnectTimerId = setTimeout(() => {
      this.reconnectTimerId = null;
      this.connectWebSocket();
    }, baseDelay + jitter);
  }

  public ngOnDestroy(): void {
    this.isDestroyed = true;
    if (this.coalesceTimerId) {
      clearTimeout(this.coalesceTimerId);
      this.coalesceTimerId = null;
    }
    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
    for (const pending of this.pendingInvocations.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingInvocations.clear();
    for (const pending of this.pendingCrudInvocations.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingCrudInvocations.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.remoteDeltaSubject.complete();
    this.remoteBatchSubject.complete();
    this.reconciliationSubject.complete();
    this.remoteWorkspaceSyncSubject.complete();
  }
}
