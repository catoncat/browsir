import {
  SESSION_INDEX_KEY,
  type SessionIndex,
  initSessionIndex,
  isSessionStoreKey,
  listStorageKeys
} from "./session-store.browser";

export interface ResetSessionStoreOptions {
  includeTrace?: boolean;
}

export interface ResetSessionStoreResult {
  removedKeys: string[];
  removedCount: number;
  index: SessionIndex;
}

function storage(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

async function removeStorageKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await storage().remove(keys);
}

export async function resetSessionStore(options: ResetSessionStoreOptions = {}): Promise<ResetSessionStoreResult> {
  const includeTrace = options.includeTrace ?? true;
  const keys = await listStorageKeys();
  const removable: string[] = [];

  for (const key of keys) {
    if (key === SESSION_INDEX_KEY) {
      removable.push(key);
      continue;
    }
    if (!isSessionStoreKey(key)) continue;
    if (!includeTrace && key.startsWith("trace:")) continue;
    removable.push(key);
  }

  const uniqueRemovable = Array.from(new Set(removable));
  await removeStorageKeys(uniqueRemovable);
  const index = await initSessionIndex();

  return {
    removedKeys: uniqueRemovable,
    removedCount: uniqueRemovable.length,
    index
  };
}

export { initSessionIndex };
