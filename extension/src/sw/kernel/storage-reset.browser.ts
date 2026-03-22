import {
  SESSION_INDEX_KEY,
  type SessionIndex,
  initSessionIndex
} from "./session-store.browser";
import { clearSessionScopedVirtualFiles } from "./browser-unix-runtime/lifo-adapter";
import { getDB } from "./idb-storage";

export interface ResetSessionStoreOptions {
  includeTrace?: boolean;
  includeChannel?: boolean;
}

export interface ResetSessionStoreResult {
  removedKeys: string[];
  removedCount: number;
  index: SessionIndex;
}

export async function resetSessionStore(options: ResetSessionStoreOptions = {}): Promise<ResetSessionStoreResult> {
  const includeTrace = options.includeTrace ?? true;
  const includeChannel = options.includeChannel ?? true;
  const db = await getDB();
  const removedKeys: string[] = [];
  let removedCount = 0;
  const storeNames = [
    "sessions",
    "entries",
    ...(includeTrace ? (["traces"] as const) : []),
    "kv",
    ...(includeChannel
      ? (["channelBindings", "channelTurns", "channelEvents", "channelOutbox"] as const)
      : []),
  ] as const;
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

  if (includeChannel) {
    const bindingKeys = (await tx.objectStore("channelBindings").getAllKeys()).map((key) => String(key));
    for (const key of bindingKeys) {
      await tx.objectStore("channelBindings").delete(key);
      removedKeys.push(`channel-binding:${key}`);
      removedCount += 1;
    }

    const turnKeys = (await tx.objectStore("channelTurns").getAllKeys()).map((key) => String(key));
    for (const key of turnKeys) {
      await tx.objectStore("channelTurns").delete(key);
      removedKeys.push(`channel-turn:${key}`);
      removedCount += 1;
    }

    const eventKeys = (await tx.objectStore("channelEvents").getAllKeys()).map((key) => String(key));
    for (const key of eventKeys) {
      await tx.objectStore("channelEvents").delete(key);
      removedKeys.push(`channel-event:${key}`);
      removedCount += 1;
    }

    const outboxKeys = (await tx.objectStore("channelOutbox").getAllKeys()).map((key) => String(key));
    for (const key of outboxKeys) {
      await tx.objectStore("channelOutbox").delete(key);
      removedKeys.push(`channel-outbox:${key}`);
      removedCount += 1;
    }
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
