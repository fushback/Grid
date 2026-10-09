import { computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  patchState,
  signalStore,
  withComputed,
  withHooks,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  EMPTY,
  catchError,
  debounceTime,
  distinctUntilChanged,
  exhaustMap,
  filter,
  of,
  pipe,
  tap,
} from 'rxjs';
import { GridRealtimeSyncService } from './grid-realtime-sync';

export type MutationOperationType = 'create' | 'update' | 'delete';

export interface GridEntityItem {
  id: string;
  orderIndex: number;
  cells: Record<string, string | number | boolean | null>;
  updatedBy: string;
  updatedAtUtc: string;
  updatedAtMs: number;
  revision: number;
}

export interface DirtyEntityMutation {
  entityId: string;
  operation: MutationOperationType;
  /** Only the changed fields for 'update', full entity for 'create', empty for 'delete' */
  changedCells: Record<string, string | number | boolean | null>;
  fullItem?: GridEntityItem;
  baseRevision: number;
  clientTimestampMs: number;
}

export interface BatchSyncRequestPayload {
  batchId: string;
  databaseName: string;
  tableName: string;
  callerConnectionId: string | null;
  userId: string;
  userName: string;
  mutations: DirtyEntityMutation[];
}

export interface RemoteEntityBroadcast {
  batchId: string;
  databaseName: string;
  tableName: string;
  originConnectionId: string;
  mutations: {
    entityId: string;
    operation: MutationOperationType;
    changedCells?: Record<string, string | number | boolean | null>;
    fullItem?: GridEntityItem;
    authoritativeTimestampMs: number;
    authoritativeRevision: number;
    updatedBy: string;
  }[];
}

export interface BatchSyncResponsePayload {
  ok: boolean;
  batchId: string;
  persistedCount: number;
  serverTimestampMs: number;
  appliedRevisions: Record<string, { revision: number; updatedAtMs: number }>;
  conflicts?: {
    entityId: string;
    winningItem: GridEntityItem;
  }[];
}

export interface GridSignalStoreState {
  databaseName: string;
  tableName: string;
  signalRConnectionId: string | null;
  currentUserId: string;
  currentUserName: string;
  /** Normalized entity dictionary keyed by entity ID */
  entitiesById: Record<string, GridEntityItem>;
  /** Ordered entity IDs for deterministic table rendering */
  entityIds: string[];
  /** Explicit dirty flag: true ONLY when real local CUD mutations are pending */
  isDirty: boolean;
  /** Map of uncommitted local mutations keyed by entity ID */
  dirtyMutationsById: Record<string, DirtyEntityMutation>;
  /** Pre-mutation snapshots keyed by entity ID for Optimistic UI Rollback on API failure */
  rollbackSnapshotsById: Record<string, GridEntityItem | null>;
  /** Sync lifecycle state */
  isSyncing: boolean;
  lastSyncedAtUtc: string | null;
  syncError: string | null;
}

const initialState: GridSignalStoreState = {
  databaseName: 'GridPulse_DB',
  tableName: 'Initiatives',
  signalRConnectionId: null,
  currentUserId: 'usr_local',
  currentUserName: 'Collaborator',
  entitiesById: {},
  entityIds: [],
  isDirty: false,
  dirtyMutationsById: {},
  rollbackSnapshotsById: {},
  isSyncing: false,
  lastSyncedAtUtc: null,
  syncError: null,
};

/**
 * Shallow cell-map comparison to guarantee no-op edits never mark the store as dirty.
 */
function extractActualCellDiff(
  existingCells: Record<string, string | number | boolean | null>,
  incomingChanges: Record<string, string | number | boolean | null>
): Record<string, string | number | boolean | null> {
  const diff: Record<string, string | number | boolean | null> = {};
  for (const [key, nextVal] of Object.entries(incomingChanges)) {
    const prevVal = existingCells[key] ?? null;
    const normalizedNext = nextVal ?? null;
    if (prevVal !== normalizedNext) {
      diff[key] = normalizedNext;
    }
  }
  return diff;
}

export const GridDatasetStore = signalStore(
  { providedIn: 'root' },
  withState<GridSignalStoreState>(initialState),

  withComputed((store) => ({
    /** Ordered array of entities for the Angular template */
    items: computed(() => {
      const map = store.entitiesById();
      return store
        .entityIds()
        .map((id) => map[id])
        .filter((item): item is GridEntityItem => Boolean(item));
    }),

    /** Count of entities currently holding uncommitted local CUD changes */
    dirtyCount: computed(() => Object.keys(store.dirtyMutationsById()).length),

    /** List of dirty mutation envelopes ready for batch persistence */
    pendingMutations: computed(() => Object.values(store.dirtyMutationsById())),

    /** Deterministic signature of the dirty buffer for distinctUntilChanged */
    dirtyBufferSignature: computed(() => {
      const mutations = Object.values(store.dirtyMutationsById());
      if (mutations.length === 0) return 'clean';
      return mutations
        .map((m) => `${m.entityId}:${m.operation}:${m.clientTimestampMs}`)
        .join('|');
    }),
  })),

  withMethods((store, http = inject(HttpClient), realtimeSync = inject(GridRealtimeSyncService)) => {
    /**
     * Reactive debounced synchronization pipeline using `rxMethod`.
     * - Buffers rapid UI edits for 350ms (`debounceTime`).
     * - Strictly guards against idle/clean states (`filter(() => store.isDirty())`).
     * - Deduplicates identical dirty buffer signatures (`distinctUntilChanged`).
     * - Uses `exhaustMap` (with a trailing re-trigger check) so in-flight requests complete
     *   cleanly while any mutations made during the HTTP call remain queued for the next cycle.
     */
    const syncDirtyChanges = rxMethod<string>(
      pipe(
        debounceTime(350),
        filter(() => store.isDirty() && Object.keys(store.dirtyMutationsById()).length > 0),
        distinctUntilChanged(),
        exhaustMap(() => {
          const claimedMutationsMap = { ...store.dirtyMutationsById() };
          const claimedSnapshotsMap = { ...store.rollbackSnapshotsById() };
          const mutationsList = Object.values(claimedMutationsMap);

          if (mutationsList.length === 0) {
            patchState(store, { isDirty: false });
            return EMPTY;
          }

          const batchPayload: BatchSyncRequestPayload = {
            batchId: `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
            databaseName: store.databaseName(),
            tableName: store.tableName(),
            callerConnectionId: store.signalRConnectionId(),
            userId: store.currentUserId(),
            userName: store.currentUserName(),
            mutations: mutationsList,
          };

          // Optimistically clear the claimed mutations from the dirty buffer so new edits
          // occurring while the HTTP request is in flight are tracked separately.
          patchState(store, {
            isSyncing: true,
            syncError: null,
            dirtyMutationsById: {},
            rollbackSnapshotsById: {},
            isDirty: false,
          });

          return http
            .post<BatchSyncResponsePayload>('/api/grid/mutations', batchPayload)
            .pipe(
              tap((response) => {
                const updatedEntities = { ...store.entitiesById() };

                // Apply server-assigned authoritative revisions & timestamps
                if (response?.appliedRevisions) {
                  for (const [entityId, meta] of Object.entries(response.appliedRevisions)) {
                    const current = updatedEntities[entityId];
                    if (current) {
                      updatedEntities[entityId] = {
                        ...current,
                        revision: meta.revision,
                        updatedAtMs: meta.updatedAtMs,
                        updatedAtUtc: new Date(meta.updatedAtMs).toISOString(),
                      };
                    }
                  }
                }

                // Reconcile any LWW server conflicts where a newer remote write won
                if (Array.isArray(response?.conflicts)) {
                  for (const conflict of response.conflicts) {
                    if (conflict.winningItem) {
                      updatedEntities[conflict.entityId] = conflict.winningItem;
                    }
                  }
                }

                const hasNewDirtyEditsDuringFlight =
                  Object.keys(store.dirtyMutationsById()).length > 0;

                patchState(store, {
                  entitiesById: updatedEntities,
                  isSyncing: false,
                  lastSyncedAtUtc: new Date().toISOString(),
                  isDirty: hasNewDirtyEditsDuringFlight,
                });
              }),
              catchError((err: unknown) => {
                // OPTIMISTIC UI ROLLBACK:
                // Restore entities to their pre-mutation snapshots if they haven't been
                // edited again while the failed request was in flight.
                const currentEntities = { ...store.entitiesById() };
                let currentIds = [...store.entityIds()];
                const stillDirty = store.dirtyMutationsById();

                for (const [entityId, snapshot] of Object.entries(claimedSnapshotsMap)) {
                  if (stillDirty[entityId]) {
                    // User made a newer edit while in-flight; keep the newer edit queued
                    continue;
                  }
                  if (snapshot === null) {
                    // Rollback an optimistic 'create' by removing the entity
                    delete currentEntities[entityId];
                    currentIds = currentIds.filter((id) => id !== entityId);
                  } else {
                    // Rollback an optimistic 'update' or 'delete' by restoring snapshot
                    currentEntities[entityId] = snapshot;
                    if (!currentIds.includes(entityId)) {
                      currentIds.push(entityId);
                    }
                  }
                }

                patchState(store, {
                  entitiesById: currentEntities,
                  entityIds: currentIds,
                  isSyncing: false,
                  isDirty: Object.keys(stillDirty).length > 0,
                  syncError:
                    err instanceof Error
                      ? err.message
                      : 'Failed to synchronize changes; local state rolled back.',
                });

                return of(null);
              })
            );
        })
      )
    );

    return {
      /**
       * Hydrates the store from initial Redis/API read without marking state as dirty.
       */
      hydrateFromReadCache(
        databaseName: string,
        tableName: string,
        items: GridEntityItem[],
        signalRConnectionId: string | null = null
      ): void {
        const entitiesById: Record<string, GridEntityItem> = {};
        const entityIds: string[] = [];

        for (const item of items) {
          entitiesById[item.id] = item;
          entityIds.push(item.id);
        }

        patchState(store, {
          databaseName,
          tableName,
          signalRConnectionId: signalRConnectionId ?? store.signalRConnectionId(),
          entitiesById,
          entityIds,
          isDirty: false,
          dirtyMutationsById: {},
          rollbackSnapshotsById: {},
          syncError: null,
        });
      },

      /**
       * Optimistically creates a new item, records a 'create' mutation in the dirty map,
       * and schedules the debounced sync pipeline.
       */
      createItem(item: GridEntityItem): void {
        const nowMs = Date.now();
        const newEntity: GridEntityItem = {
          ...item,
          updatedBy: store.currentUserName(),
          updatedAtMs: nowMs,
          updatedAtUtc: new Date(nowMs).toISOString(),
          revision: item.revision || 1,
        };

        const snapshots = { ...store.rollbackSnapshotsById() };
        if (!(newEntity.id in snapshots)) {
          // `null` snapshot indicates the item did not exist prior to this dirty batch
          snapshots[newEntity.id] = null;
        }

        const dirtyMap = {
          ...store.dirtyMutationsById(),
          [newEntity.id]: {
            entityId: newEntity.id,
            operation: 'create' as const,
            changedCells: { ...newEntity.cells },
            fullItem: newEntity,
            baseRevision: 0,
            clientTimestampMs: nowMs,
          },
        };

        patchState(store, {
          entitiesById: {
            ...store.entitiesById(),
            [newEntity.id]: newEntity,
          },
          entityIds: [...store.entityIds(), newEntity.id],
          rollbackSnapshotsById: snapshots,
          dirtyMutationsById: dirtyMap,
          isDirty: true,
        });

        syncDirtyChanges(store.dirtyBufferSignature());
      },

      /**
       * Optimistically updates an existing item ONLY if at least one cell value actually changed.
       * Coalesces rapid field edits on the same entity into a single dirty mutation entry.
       */
      updateItem(
        id: string,
        changes: Record<string, string | number | boolean | null>
      ): void {
        const existing = store.entitiesById()[id];
        if (!existing) return;

        // Dirty-check guard: ignore no-op updates where values are identical
        const actualDiff = extractActualCellDiff(existing.cells, changes);
        if (Object.keys(actualDiff).length === 0) {
          return;
        }

        const nowMs = Date.now();
        const snapshots = { ...store.rollbackSnapshotsById() };
        if (!(id in snapshots)) {
          snapshots[id] = {
            ...existing,
            cells: { ...existing.cells },
          };
        }

        const updatedEntity: GridEntityItem = {
          ...existing,
          cells: {
            ...existing.cells,
            ...actualDiff,
          },
          updatedBy: store.currentUserName(),
          updatedAtMs: nowMs,
          updatedAtUtc: new Date(nowMs).toISOString(),
        };

        const prevDirty = store.dirtyMutationsById()[id];
        const mergedOperation: MutationOperationType =
          prevDirty?.operation === 'create' ? 'create' : 'update';
        const mergedCells = {
          ...(prevDirty?.changedCells ?? {}),
          ...actualDiff,
        };

        const dirtyMap = {
          ...store.dirtyMutationsById(),
          [id]: {
            entityId: id,
            operation: mergedOperation,
            changedCells: mergedCells,
            fullItem: mergedOperation === 'create' ? updatedEntity : undefined,
            baseRevision: prevDirty?.baseRevision ?? existing.revision,
            clientTimestampMs: nowMs,
          },
        };

        patchState(store, {
          entitiesById: {
            ...store.entitiesById(),
            [id]: updatedEntity,
          },
          rollbackSnapshotsById: snapshots,
          dirtyMutationsById: dirtyMap,
          isDirty: true,
        });

        // Also feed the low-latency cell delta stream in our existing app service
        for (const [columnId, rawValue] of Object.entries(actualDiff)) {
          realtimeSync.queueCellMutation({
            databaseName: store.databaseName(),
            tableName: store.tableName(),
            rowId: id,
            columnId,
            rawValue,
            userId: store.currentUserId(),
            userName: store.currentUserName(),
            userColor: '#059669',
          });
        }

        syncDirtyChanges(store.dirtyBufferSignature());
      },

      /**
       * Optimistically deletes an item.
       * If the item was created locally and hasn't been synced yet, it simply removes it
       * from the dirty buffer without making a redundant API call.
       */
      deleteItem(id: string): void {
        const existing = store.entitiesById()[id];
        if (!existing) return;

        const nextEntities = { ...store.entitiesById() };
        delete nextEntities[id];
        const nextIds = store.entityIds().filter((itemId) => itemId !== id);

        const prevDirty = store.dirtyMutationsById()[id];
        const dirtyMap = { ...store.dirtyMutationsById() };
        const snapshots = { ...store.rollbackSnapshotsById() };

        if (prevDirty?.operation === 'create') {
          // Item was created locally and never persisted — cancel out the create mutation
          delete dirtyMap[id];
          delete snapshots[id];
          const stillDirty = Object.keys(dirtyMap).length > 0;

          patchState(store, {
            entitiesById: nextEntities,
            entityIds: nextIds,
            dirtyMutationsById: dirtyMap,
            rollbackSnapshotsById: snapshots,
            isDirty: stillDirty,
          });
          return;
        }

        if (!(id in snapshots)) {
          snapshots[id] = {
            ...existing,
            cells: { ...existing.cells },
          };
        }

        dirtyMap[id] = {
          entityId: id,
          operation: 'delete',
          changedCells: {},
          baseRevision: existing.revision,
          clientTimestampMs: Date.now(),
        };

        patchState(store, {
          entitiesById: nextEntities,
          entityIds: nextIds,
          rollbackSnapshotsById: snapshots,
          dirtyMutationsById: dirtyMap,
          isDirty: true,
        });

        syncDirtyChanges(store.dirtyBufferSignature());
      },

      /**
       * Applies incoming SignalR broadcasts from other collaborators using Last-Write-Wins (LWW).
       * CRITICAL ECHO-LOOP PREVENTION:
       * - Does NOT set `isDirty: true`.
       * - Does NOT add entries to `dirtyMutationsById`.
       * - Does NOT invoke `syncDirtyChanges()`.
       */
      applyRemoteUpdate(broadcast: RemoteEntityBroadcast): void {
        if (!broadcast || !Array.isArray(broadcast.mutations)) return;

        // Secondary client-side guard: ignore broadcasts originating from our own SignalR connection
        if (
          broadcast.originConnectionId &&
          store.signalRConnectionId() &&
          broadcast.originConnectionId === store.signalRConnectionId()
        ) {
          return;
        }

        const nextEntities = { ...store.entitiesById() };
        let nextIds = [...store.entityIds()];
        const nextDirtyMap = { ...store.dirtyMutationsById() };
        let mutated = false;

        for (const remote of broadcast.mutations) {
          const localEntity = nextEntities[remote.entityId];

          if (remote.operation === 'delete') {
            if (localEntity) {
              delete nextEntities[remote.entityId];
              nextIds = nextIds.filter((id) => id !== remote.entityId);
              delete nextDirtyMap[remote.entityId];
              mutated = true;
            }
            continue;
          }

          if (remote.operation === 'create' && remote.fullItem) {
            if (
              !localEntity ||
              remote.authoritativeTimestampMs >= localEntity.updatedAtMs
            ) {
              nextEntities[remote.entityId] = {
                ...remote.fullItem,
                updatedAtMs: remote.authoritativeTimestampMs,
                updatedAtUtc: new Date(remote.authoritativeTimestampMs).toISOString(),
                revision: remote.authoritativeRevision,
                updatedBy: remote.updatedBy,
              };
              if (!nextIds.includes(remote.entityId)) {
                nextIds.push(remote.entityId);
              }
              mutated = true;
            }
            continue;
          }

          if (remote.operation === 'update' && localEntity && remote.changedCells) {
            // Last-Write-Wins (LWW) check: apply remote update only if its authoritative
            // timestamp is newer than or equal to the local entity's timestamp
            if (remote.authoritativeTimestampMs >= localEntity.updatedAtMs) {
              nextEntities[remote.entityId] = {
                ...localEntity,
                cells: {
                  ...localEntity.cells,
                  ...remote.changedCells,
                },
                updatedAtMs: remote.authoritativeTimestampMs,
                updatedAtUtc: new Date(remote.authoritativeTimestampMs).toISOString(),
                revision: remote.authoritativeRevision,
                updatedBy: remote.updatedBy,
              };

              // If the user had a pending dirty edit on the exact same cell that is older
              // than the remote authoritative write, prune that superseded cell from dirtyMap
              const pendingLocal = nextDirtyMap[remote.entityId];
              if (
                pendingLocal &&
                pendingLocal.clientTimestampMs <= remote.authoritativeTimestampMs
              ) {
                const remainingDirtyCells = { ...pendingLocal.changedCells };
                for (const colKey of Object.keys(remote.changedCells)) {
                  delete remainingDirtyCells[colKey];
                }
                if (Object.keys(remainingDirtyCells).length === 0) {
                  delete nextDirtyMap[remote.entityId];
                } else {
                  nextDirtyMap[remote.entityId] = {
                    ...pendingLocal,
                    changedCells: remainingDirtyCells,
                  };
                }
              }

              mutated = true;
            }
          }
        }

        if (mutated) {
          patchState(store, {
            entitiesById: nextEntities,
            entityIds: nextIds,
            dirtyMutationsById: nextDirtyMap,
            isDirty: Object.keys(nextDirtyMap).length > 0,
          });
        }
      },
    };
  }),

  withHooks({
    onInit(store) {
      const realtimeSync = inject(GridRealtimeSyncService);
      // Automatically bridge incoming WebSocket/SignalR remote cell deltas into `applyRemoteUpdate`
      realtimeSync.remoteDelta$.subscribe((delta) => {
        store.applyRemoteUpdate({
          batchId: delta.mutationId,
          databaseName: delta.databaseName,
          tableName: delta.tableName,
          originConnectionId: '',
          mutations: [
            {
              entityId: delta.rowId,
              operation: 'update',
              changedCells: { [delta.columnId]: delta.rawValue },
              authoritativeTimestampMs: delta.clientTimestampMs,
              authoritativeRevision: 1,
              updatedBy: delta.userName,
            },
          ],
        });
      });
    },
  })
);
