import { deleteDB, openDB, type IDBPDatabase } from "idb";

const DB_NAME = "browser-brain-loop";
const DB_VERSION = 3;

export interface IDBStorageSchema {
  sessions: {
    key: string;
    value: any;
  };
  entries: {
    key: string;
    value: any;
    indexes: { "by-session": string };
  };
  traces: {
    key: string;
    value: any;
    indexes: { "by-trace": string };
  };
  kv: {
    key: string;
    value: any;
  };
  channelBindings: {
    key: string;
    value: any;
    indexes: {
      "by-session": string;
      "by-channel-conversation": string;
    };
  };
  channelTurns: {
    key: string;
    value: any;
    indexes: {
      "by-session": string;
      "by-binding": string;
      "by-lifecycle-status": string;
      "by-remote-message": string;
    };
  };
  channelEvents: {
    key: string;
    value: any;
    indexes: {
      "by-turn": string;
      "by-session": string;
      "by-created-at": string;
    };
  };
  channelOutbox: {
    key: string;
    value: any;
    indexes: {
      "by-turn": string;
      "by-session": string;
      "by-delivery-status": string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<IDBStorageSchema>> | null = null;

export const IDB_STORE_NAMES = [
  "sessions",
  "entries",
  "traces",
  "kv",
  "channelBindings",
  "channelTurns",
  "channelEvents",
  "channelOutbox",
] as const;

export type IDBStoreName = (typeof IDB_STORE_NAMES)[number];

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<IDBStorageSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Sessions store
        if (oldVersion < 2 && db.objectStoreNames.contains("sessions")) {
          db.deleteObjectStore("sessions");
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "header.id" });
        }
        
        // Entries store with session index
        if (!db.objectStoreNames.contains("entries")) {
          const entryStore = db.createObjectStore("entries", { keyPath: "id" });
          entryStore.createIndex("by-session", "sessionId");
        }
        
        // Traces store with trace index
        if (!db.objectStoreNames.contains("traces")) {
          const traceStore = db.createObjectStore("traces", { keyPath: "id" });
          traceStore.createIndex("by-trace", "traceId");
        }
        
        // General Key-Value store
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv");
        }

        // Channel bindings
        if (!db.objectStoreNames.contains("channelBindings")) {
          const store = db.createObjectStore("channelBindings", {
            keyPath: "bindingKey",
          });
          store.createIndex("by-session", "sessionId");
          store.createIndex(
            "by-channel-conversation",
            "channelConversationKey",
            { unique: true },
          );
        }

        // Channel turns
        if (!db.objectStoreNames.contains("channelTurns")) {
          const store = db.createObjectStore("channelTurns", {
            keyPath: "channelTurnId",
          });
          store.createIndex("by-session", "sessionId");
          store.createIndex("by-binding", "bindingKey");
          store.createIndex("by-lifecycle-status", "lifecycleStatus");
          store.createIndex(
            "by-remote-message",
            "remoteMessageKey",
            { unique: true },
          );
        }

        // Channel events
        if (!db.objectStoreNames.contains("channelEvents")) {
          const store = db.createObjectStore("channelEvents", {
            keyPath: "eventId",
          });
          store.createIndex("by-turn", "channelTurnId");
          store.createIndex("by-session", "sessionId");
          store.createIndex("by-created-at", "createdAt");
        }

        // Channel outbox
        if (!db.objectStoreNames.contains("channelOutbox")) {
          const store = db.createObjectStore("channelOutbox", {
            keyPath: "deliveryId",
          });
          store.createIndex("by-turn", "channelTurnId");
          store.createIndex("by-session", "sessionId");
          store.createIndex("by-delivery-status", "deliveryStatus");
        }
      },
    });
  }
  return dbPromise;
}

export async function kvGet(key: string): Promise<any> {
  const db = await getDB();
  return db.get("kv", key);
}

export async function kvSet(key: string, value: any): Promise<void> {
  const db = await getDB();
  await db.put("kv", value, key);
}

export async function kvRemove(key: string): Promise<void> {
  const db = await getDB();
  await db.delete("kv", key);
}

export async function kvKeys(): Promise<string[]> {
  const db = await getDB();
  const keys = await db.getAllKeys("kv");
  return keys.map((key) => String(key));
}

export async function clearIdbStores(
  storeNames: readonly IDBStoreName[] = IDB_STORE_NAMES,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction([...storeNames], "readwrite");
  for (const storeName of storeNames) {
    await tx.objectStore(storeName).clear();
  }
  await tx.done;
}

// Test-only helper for migration and clean-state tests.
export async function __resetIdbStorageForTest(): Promise<void> {
  const db = dbPromise ? await dbPromise : null;
  db?.close();
  dbPromise = null;
  await deleteDB(DB_NAME);
}
