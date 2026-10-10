/**
 * Legacy compatibility module for deployments that retain `src/app/firebase-client.ts`.
 * All persistence and authentication are now handled by the PostgreSQL backend (`/api/*`).
 */

export interface LegacyDocSnapshot {
  id: string;
  data: () => Record<string, unknown>;
}

export interface LegacyQuerySnapshot {
  docs: LegacyDocSnapshot[];
}

export function subscribeToWorkspaceSnapshots(
  onSnapshotCallback?: (snapshot: LegacyQuerySnapshot) => void,
  onErrorCallback?: (error: Error) => void,
): () => void {
  const emptySnapshot: LegacyQuerySnapshot = { docs: [] };
  if (onSnapshotCallback) {
    emptySnapshot.docs.forEach((d: LegacyDocSnapshot) => {
      void d.id;
    });
    onSnapshotCallback(emptySnapshot);
  }
  void onErrorCallback;
  return () => {
    // No-op unsubscribe
  };
}
