import {
  SESSION_INDEX_KEY,
  type SessionIndex,
  initSessionIndex
} from "./session-store.browser";
import { clearSessionScopedVirtualFiles } from "./browser-unix-runtime/lifo-adapter";
import { getDB } from "./idb-storage";

export interface ResetSessionStoreOptions {
  includeTrace?: boolean;
}

export interface ResetSessionStoreResult {
  removedKeys: string[];
  removedCount: number;
  index: SessionIndex;
}

export async function resetSessionStore(options: ResetSessionStoreOptions = {}): Promise<ResetSessionStoreResult> {
  const includeTrace = options.includeTrace ?? true;
  const db = await getDB();
  const removedKeys: string[] = [];
  let removedCount = 0;
  const storeNames = includeTrace
    ? (["sessions", "entries", "traces", "kv"] as const)
    : (["sessions", "entries", "kv"] as const);
  const tx = db.transaction(storeNames, "readwrite");

  const sessionKeys = (await tx.objectStore("sessions").getAllKeys()).map((key) => String(key));
  for (const key of sessionKeys) {
    await tx.objectStore("sessions").delete(key);
    removedKeys.push(`session:${key}:meta`);
    removedCount += 1;
  }

  const entryKeys = (await tx.objectStore("entries").getAllKeys()).map((key) => String(key));
  for (const key of entryKeys) {
    await tx.objectStore("entries").delete(key);
    removedKeys.push(`entry:${key}`);
    removedCount += 1;
  }

  if (includeTrace) {
    const traceKeys = (await tx.objectStore("traces").getAllKeys()).map((key) => String(key));
    for (const key of traceKeys) {
      await tx.objectStore("traces").delete(key);
      removedKeys.push(`trace-record:${key}`);
      removedCount += 1;
    }
  }

  const kvKeys = (await tx.objectStore("kv").getAllKeys()).map((key) => String(key));
  for (const key of kvKeys) {
    if (key !== SESSION_INDEX_KEY) continue;
    await tx.objectStore("kv").delete(key);
    removedKeys.push(key);
    removedCount += 1;
  }

  await tx.done;
  const virtualKeys = await clearSessionScopedVirtualFiles();
  removedKeys.push(...virtualKeys);
  removedCount += virtualKeys.length;
  const index = await initSessionIndex();

  return {
    removedKeys: Array.from(new Set(removedKeys)),
    removedCount,
    index
  };
}

export { initSessionIndex };
