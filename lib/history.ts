import type { AnalysisResult, SavedSession } from "./types";

const DB_NAME = "shadowcut-db";
const DB_VERSION = 1;
const STORE = "sessions";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "videoId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function getSession(videoId: string): Promise<SavedSession | null> {
  const value = await transact<SavedSession | undefined>("readonly", (store) => store.get(videoId));
  return value ?? null;
}

export async function listSessions(): Promise<SavedSession[]> {
  const values = await transact<SavedSession[]>("readonly", (store) => store.getAll());
  return values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveNewSession(analysis: AnalysisResult): Promise<SavedSession> {
  const now = new Date().toISOString();
  const previous = await getSession(analysis.videoId);

  const session: SavedSession = {
    videoId: analysis.videoId,
    analysis,
    studiedClipIds: previous?.studiedClipIds ?? [],
    lastClipIndex: previous?.lastClipIndex ?? 0,
    sentenceAdjustments: previous?.sentenceAdjustments ?? {},
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };

  await transact<IDBValidKey>("readwrite", (store) => store.put(session));
  return session;
}

export async function saveSession(session: SavedSession): Promise<void> {
  await transact<IDBValidKey>("readwrite", (store) =>
    store.put({ ...session, updatedAt: new Date().toISOString() })
  );
}

export async function deleteSession(videoId: string): Promise<void> {
  await transact<undefined>("readwrite", (store) => store.delete(videoId));
}

export async function exportSessions(): Promise<string> {
  const sessions = await listSessions();
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions
    },
    null,
    2
  );
}

export async function importSessions(json: string): Promise<number> {
  const parsed = JSON.parse(json);
  const sessions: SavedSession[] = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  if (!sessions.length) throw new Error("Backup sem sessões válidas.");

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);

      for (const session of sessions) {
        if (!session?.videoId || !session?.analysis?.clips) continue;
        store.put(session);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }

  return sessions.length;
}
