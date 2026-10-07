import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { GridColumn, GridRow, CollaboratorPresence } from './grid-models';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

if (typeof window !== 'undefined') {
  testFirestoreConnection();
}

const SAFE_ID_REGEX = /[^a-zA-Z0-9_-]/g;

export function sanitizeId(rawId: string): string {
  const cleaned = rawId.replace(SAFE_ID_REGEX, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'default_id';
}

export async function signInWithGooglePopup(): Promise<User | null> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

export { onAuthStateChanged, type User };

// Promise lock to prevent concurrent race conditions when initializing/updating the parent workspace document
let workspaceSyncPromise: Promise<void> = Promise.resolve();
const confirmedWorkspaces = new Set<string>();
const persistedRowIds = new Set<string>();
const persistedColumnIds = new Set<string>();

/**
 * Ensures the authenticated user's personal/shared cloud workspace document exists in Firestore
 * and adheres strictly to the Workspace entity in firebase-blueprint.json.
 */
export function syncWorkspaceDocToFirestore(
  workspaceId: string,
  workspaceName: string,
  rowCount: number
): Promise<void> {
  workspaceSyncPromise = workspaceSyncPromise
    .catch(() => undefined)
    .then(async () => {
      const user = auth.currentUser;
      if (!user || !user.emailVerified) return;

      const safeWsId = sanitizeId(`${workspaceId}_${user.uid.slice(0, 12)}`);
      const wsPath = `workspaces/${safeWsId}`;
      const wsRef = doc(db, 'workspaces', safeWsId);
      const boundedName = (workspaceName || 'GridPulse Workspace').slice(0, 120);
      const boundedCount = Math.max(0, Math.min(100000, Math.floor(rowCount)));

      try {
        if (confirmedWorkspaces.has(safeWsId)) {
          await updateDoc(wsRef, {
            name: boundedName,
            rowCount: boundedCount,
            updatedAt: serverTimestamp(),
          });
          return;
        }

        const snap = await getDoc(wsRef);
        if (!snap.exists()) {
          await setDoc(wsRef, {
            name: boundedName,
            ownerId: user.uid,
            rowCount: boundedCount,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          await updateDoc(wsRef, {
            name: boundedName,
            rowCount: boundedCount,
            updatedAt: serverTimestamp(),
          });
        }
        confirmedWorkspaces.add(safeWsId);
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, wsPath);
      }
    });

  return workspaceSyncPromise;
}

export async function syncColumnToFirestore(
  workspaceId: string,
  col: GridColumn
): Promise<void> {
  await workspaceSyncPromise.catch(() => undefined);
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const safeWsId = sanitizeId(`${workspaceId}_${user.uid.slice(0, 12)}`);
  const safeColId = sanitizeId(col.id);
  const colPath = `workspaces/${safeWsId}/columns/${safeColId}`;
  const colRef = doc(db, 'workspaces', safeWsId, 'columns', safeColId);

  try {
    const snap = await getDoc(colRef);
    const payload = {
      name: (col.name || 'Column').slice(0, 80),
      colType: col.colType,
      orderIndex: Math.max(0, Math.min(10000, col.orderIndex)),
      width: Math.max(60, Math.min(1200, col.width || 160)),
      required: Boolean(col.required),
      formula: (col.formula || '').slice(0, 300),
      optionsCsv: (col.optionsCsv || '').slice(0, 500),
      updatedAt: serverTimestamp(),
    };

    if (!snap.exists()) {
      await setDoc(colRef, {
        ...payload,
        workspaceId: safeWsId,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
      });
    } else {
      await updateDoc(colRef, payload);
    }
    persistedColumnIds.add(safeColId);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, colPath);
  }
}

export async function deleteColumnFromFirestore(
  workspaceId: string,
  columnId: string
): Promise<void> {
  await workspaceSyncPromise.catch(() => undefined);
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const safeWsId = sanitizeId(`${workspaceId}_${user.uid.slice(0, 12)}`);
  const safeColId = sanitizeId(columnId);
  if (!persistedColumnIds.has(safeColId)) return;

  const colPath = `workspaces/${safeWsId}/columns/${safeColId}`;
  try {
    await deleteDoc(doc(db, 'workspaces', safeWsId, 'columns', safeColId));
    persistedColumnIds.delete(safeColId);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, colPath);
  }
}

export async function syncRowToFirestore(
  workspaceId: string,
  row: GridRow
): Promise<void> {
  await workspaceSyncPromise.catch(() => undefined);
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const safeWsId = sanitizeId(`${workspaceId}_${user.uid.slice(0, 12)}`);
  const safeRowId = sanitizeId(row.id);
  const rowPath = `workspaces/${safeWsId}/rows/${safeRowId}`;
  const rowRef = doc(db, 'workspaces', safeWsId, 'rows', safeRowId);

  const sanitizedCells: Record<string, string | number | boolean> = {};
  const entries = Object.entries(row.cells || {}).slice(0, 60);
  for (const [k, v] of entries) {
    sanitizedCells[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  }

  try {
    const snap = await getDoc(rowRef);
    const updatePayload = {
      orderIndex: Math.max(-1000000, Math.min(10000000, row.orderIndex)),
      cells: sanitizedCells,
      updatedBy: (row.updatedBy || user.displayName || 'Collaborator').slice(0, 80),
      updatedAt: serverTimestamp(),
    };

    if (!snap.exists()) {
      await setDoc(rowRef, {
        ...updatePayload,
        workspaceId: safeWsId,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
      });
    } else {
      await updateDoc(rowRef, updatePayload);
    }
    persistedRowIds.add(safeRowId);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, rowPath);
  }
}

export async function deleteRowFromFirestore(
  workspaceId: string,
  rowId: string
): Promise<void> {
  await workspaceSyncPromise.catch(() => undefined);
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const safeWsId = sanitizeId(`${workspaceId}_${user.uid.slice(0, 12)}`);
  const safeRowId = sanitizeId(rowId);
  if (!persistedRowIds.has(safeRowId)) return;

  const rowPath = `workspaces/${safeWsId}/rows/${safeRowId}`;
  try {
    await deleteDoc(doc(db, 'workspaces', safeWsId, 'rows', safeRowId));
    persistedRowIds.delete(safeRowId);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, rowPath);
  }
}

export async function syncPresenceToFirestore(
  workspaceId: string,
  presence: CollaboratorPresence
): Promise<void> {
  await workspaceSyncPromise.catch(() => undefined);
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const safeWsId = sanitizeId(`${workspaceId}_${user.uid.slice(0, 12)}`);
  const presenceId = sanitizeId(user.uid);
  const presPath = `workspaces/${safeWsId}/presence/${presenceId}`;
  const presRef = doc(db, 'workspaces', safeWsId, 'presence', presenceId);

  try {
    const snap = await getDoc(presRef);
    const payload = {
      displayName: (presence.displayName || user.displayName || 'Collaborator').slice(0, 80),
      color: (presence.color || '#2563eb').slice(0, 16),
      activeRowId: (presence.activeRowId || '').slice(0, 128),
      activeColId: (presence.activeColId || '').slice(0, 128),
      updatedAt: serverTimestamp(),
    };

    if (!snap.exists()) {
      await setDoc(presRef, {
        ...payload,
        workspaceId: safeWsId,
        ownerId: user.uid,
      });
    } else {
      await updateDoc(presRef, payload);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, presPath);
  }
}

let bulkSyncGeneration = 0;
let activeFirestoreWriteCount = 0;

export function cancelPendingBulkFirestoreSync(): void {
  bulkSyncGeneration++;
}

export async function syncBulkRowsAndColumnsToFirestore(
  workspaceId: string,
  rows: GridRow[],
  columns: GridColumn[] = []
): Promise<void> {
  const myGen = ++bulkSyncGeneration;
  await workspaceSyncPromise.catch(() => undefined);
  if (myGen !== bulkSyncGeneration) return;

  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  activeFirestoreWriteCount++;
  try {
    for (const col of columns) {
      if (myGen !== bulkSyncGeneration) return;
      await syncColumnToFirestore(workspaceId, col);
    }

    // Sync rows in bounded concurrent chunks; abort immediately if a newer sync (e.g. Undo) started
    const chunkSize = 15;
    for (let i = 0; i < rows.length; i += chunkSize) {
      if (myGen !== bulkSyncGeneration) return;
      const slice = rows.slice(i, i + chunkSize);
      await Promise.all(slice.map((row) => syncRowToFirestore(workspaceId, row)));
    }
  } finally {
    activeFirestoreWriteCount = Math.max(0, activeFirestoreWriteCount - 1);
  }
}

export function listenToUserFirestoreRows(
  workspaceId: string,
  onRowsSnapshot: (count: number, savedRows: GridRow[]) => void
): Unsubscribe | null {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return null;

  const safeWsId = sanitizeId(`${workspaceId}_${user.uid.slice(0, 12)}`);
  const rowsPath = `workspaces/${safeWsId}/rows`;
  const q = query(
    collection(db, 'workspaces', safeWsId, 'rows'),
    where('ownerId', '==', user.uid)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      persistedRowIds.clear();
      snapshot.docs.forEach((d) => {
        persistedRowIds.add(d.id);
      });
      if (activeFirestoreWriteCount > 0) {
        return;
      }
      const loadedRows: GridRow[] = [];
      snapshot.docs.forEach((d) => {
        const data = d.data();
        if (data && typeof data['cells'] === 'object') {
          loadedRows.push({
            id: d.id,
            orderIndex: typeof data['orderIndex'] === 'number' ? data['orderIndex'] : 10,
            cells: data['cells'] as Record<string, string | number | boolean>,
            updatedBy: typeof data['updatedBy'] === 'string' ? data['updatedBy'] : 'Collaborator',
            updatedAt: new Date().toISOString(),
          });
        }
      });
      onRowsSnapshot(snapshot.size, loadedRows);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, rowsPath);
    }
  );
}

