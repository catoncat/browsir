import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "browser-brain-loop";
const DB_VERSION = 2;

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
}

let dbPromise: Promise<IDBPDatabase<IDBStorageSchema>> | null = null;

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
