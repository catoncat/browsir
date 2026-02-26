import { nowIso, type SessionEntry, type SessionHeader, type SessionMeta } from "./types";
import { getDB, kvGet, kvSet, kvRemove } from "./idb-storage";

export const SESSION_INDEX_KEY = "session:index";

export interface SessionIndexEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionIndex {
  version: 1;
  sessions: SessionIndexEntry[];
  updatedAt: string;
}

export interface InitSessionOptions {
  leafId?: string | null;
  chunkSize?: number;
}

export interface AppendSessionEntryOptions {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizeIso(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return fallback;
  return new Date(ts).toISOString();
}

function sanitizeId(id: string, kind: "session" | "trace"): string {
  const value = id.trim();
  if (!value) throw new Error(`${kind} id 不能为空`);
  if (value.includes(":")) throw new Error(`${kind} id 不能包含冒号`);
  return value;
}

function sanitizeChunk(chunk: number): number {
  if (!Number.isInteger(chunk) || chunk < 0) throw new Error(`chunk 必须是 >= 0 的整数，收到: ${String(chunk)}`);
  return chunk;
}

function emptySessionIndex(at = nowIso()): SessionIndex {
  return {
    version: 1,
    sessions: [],
    updatedAt: at
  };
}

function normalizeSessionIndex(raw: unknown): SessionIndex {
  if (!isRecord(raw)) return emptySessionIndex();
  const at = nowIso();
  const rawSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const seen = new Set<string>();
  const sessions: SessionIndexEntry[] = [];

  for (const item of rawSessions) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (!id || id.includes(":") || seen.has(id)) continue;
    seen.add(id);
    const createdAt = normalizeIso(item.createdAt, at);
    const updatedAt = normalizeIso(item.updatedAt, createdAt);
    sessions.push({ id, createdAt, updatedAt });
  }

  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    version: 1,
    sessions,
    updatedAt: normalizeIso(raw.updatedAt, at)
  };
}

function normalizeSessionMeta(raw: unknown, fallbackHeader?: SessionHeader): SessionMeta | null {
  if (!isRecord(raw)) {
    if (!fallbackHeader) return null;
    return {
      header: fallbackHeader,
      leafId: null,
      entryCount: 0,
      chunkCount: 0,
      chunkSize: 64,
      updatedAt: nowIso()
    };
  }

  const headerRaw = isRecord(raw.header) ? raw.header : fallbackHeader;
  if (!headerRaw || headerRaw.type !== "session") return null;

  const header = headerRaw as SessionHeader;
  return {
    header,
    leafId: typeof raw.leafId === "string" ? raw.leafId : null,
    entryCount: Number.isInteger(raw.entryCount) && Number(raw.entryCount) >= 0 ? Number(raw.entryCount) : 0,
    chunkCount: Number.isInteger(raw.chunkCount) && Number(raw.chunkCount) >= 0 ? Number(raw.chunkCount) : 0,
    chunkSize: Number.isInteger(raw.chunkSize) && Number(raw.chunkSize) > 0 ? Number(raw.chunkSize) : 64,
    updatedAt: normalizeIso(raw.updatedAt, nowIso())
  };
}

async function storageGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
  if (keys === null) {
    const bag = await (await storage()).get(null);
    return bag as Record<string, unknown>;
  }
  
  const keyList = Array.isArray(keys) ? keys : [keys];
  const result: Record<string, unknown> = {};
  for (const key of keyList) {
    result[key] = await kvGet(key);
  }
  return result;
}

async function storageSet(items: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(items)) {
    await kvSet(key, value);
  }
}

async function storageRemove(keys: string[]): Promise<void> {
  for (const key of keys) {
    await kvRemove(key);
  }
}

function storage(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

export function buildSessionMetaKey(sessionId: string): string {
  return `session:${sanitizeId(sessionId, "session")}:meta`;
}

export function isSessionStoreKey(key: string): boolean {
  return key === SESSION_INDEX_KEY || key.startsWith("session:") || key.startsWith("trace:");
}

export async function initSessionIndex(): Promise<SessionIndex> {
  const raw = await kvGet(SESSION_INDEX_KEY);
  const normalized = normalizeSessionIndex(raw);
  await kvSet(SESSION_INDEX_KEY, normalized);
  return normalized;
}

export async function readSessionIndex(): Promise<SessionIndex> {
  return initSessionIndex();
}

export async function upsertSessionIndexEntry(sessionId: string, at = nowIso()): Promise<SessionIndex> {
  const id = sanitizeId(sessionId, "session");
  const index = await readSessionIndex();
  const nextSessions = index.sessions.slice();
  const idx = nextSessions.findIndex((entry) => entry.id === id);

  if (idx >= 0) {
    const prev = nextSessions[idx];
    nextSessions[idx] = { ...prev, updatedAt: at };
  } else {
    nextSessions.push({ id, createdAt: at, updatedAt: at });
  }

  nextSessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const next: SessionIndex = { version: 1, sessions: nextSessions, updatedAt: at };
  await storageSet({ [SESSION_INDEX_KEY]: next });
  return next;
}

export async function removeSessionIndexEntry(sessionId: string, at = nowIso()): Promise<SessionIndex> {
  const id = sanitizeId(sessionId, "session");
  const index = await readSessionIndex();
  const nextSessions = index.sessions.filter((entry) => entry.id !== id);
  const next: SessionIndex = { version: 1, sessions: nextSessions, updatedAt: at };
  await storageSet({ [SESSION_INDEX_KEY]: next });
  return next;
}

export async function initSessionStorage(header: SessionHeader, options: InitSessionOptions = {}): Promise<SessionMeta> {
  const meta: SessionMeta = {
    header,
    leafId: options.leafId ?? null,
    entryCount: 0,
    chunkCount: 1,
    chunkSize: 999999, // In IDB we don't really need chunks
    updatedAt: nowIso()
  };
  await writeSessionMeta(header.id, meta);
  await upsertSessionIndexEntry(header.id, meta.updatedAt);
  return meta;
}

export async function readSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  const db = await getDB();
  const raw = await db.get("sessions", sessionId);
  return normalizeSessionMeta(raw);
}

export async function writeSessionMeta(sessionId: string, meta: SessionMeta): Promise<void> {
  const db = await getDB();
  const next: SessionMeta = {
    ...meta,
    updatedAt: nowIso()
  };
  await db.put("sessions", next);
  await upsertSessionIndexEntry(sessionId, next.updatedAt);
}

export async function removeSessionMeta(sessionId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["sessions", "entries"], "readwrite");
  await tx.objectStore("sessions").delete(sessionId);
  
  // Delete all entries for this session using the index
  const index = tx.objectStore("entries").index("by-session");
  let cursor = await index.openKeyCursor(IDBKeyRange.only(sessionId));
  while (cursor) {
    await tx.objectStore("entries").delete(cursor.primaryKey);
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function readAllSessionEntries(sessionId: string): Promise<SessionEntry[]> {
  const db = await getDB();
  return db.getAllFromIndex("entries", "by-session", sessionId);
}

export async function appendSessionEntry(
  sessionId: string,
  entry: SessionEntry,
  _options: AppendSessionEntryOptions = {}
): Promise<SessionMeta> {
  const db = await getDB();
  const tx = db.transaction(["sessions", "entries"], "readwrite");
  const metaStore = tx.objectStore("sessions");
  const entryStore = tx.objectStore("entries");

  const rawMeta = await metaStore.get(sessionId);
  const meta = normalizeSessionMeta(rawMeta);
  if (!meta) throw new Error(`session meta 不存在: ${sessionId}`);

  // Add the entry with sessionId for the index
  await entryStore.put({
    ...entry,
    sessionId
  });

  const nextMeta: SessionMeta = {
    ...meta,
    leafId: entry.id,
    entryCount: meta.entryCount + 1,
    chunkCount: 1,
    updatedAt: nowIso()
  };
  
  await metaStore.put(nextMeta);
  await tx.done;
  
  await upsertSessionIndexEntry(sessionId, nextMeta.updatedAt);
  return nextMeta;
}

function readTraceTimestamp(record: unknown): number {
  const value = isRecord(record) ? record.timestamp : undefined;
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function readTraceId(record: unknown): string {
  if (!isRecord(record)) return "";
  return typeof record.id === "string" ? record.id : "";
}

function sortTraceRecords<TTrace>(records: TTrace[]): TTrace[] {
  return records.slice().sort((a, b) => {
    const tsA = readTraceTimestamp(a);
    const tsB = readTraceTimestamp(b);
    if (tsA !== tsB) return tsA - tsB;
    return readTraceId(a).localeCompare(readTraceId(b));
  });
}

export async function readTraceChunk<TTrace = unknown>(traceId: string, _chunk: number): Promise<TTrace[]> {
  const db = await getDB();
  const chunk = sanitizeChunk(_chunk);
  const all = (await db.getAllFromIndex("traces", "by-trace", traceId)) as Array<TTrace & { chunk?: unknown }>;
  if (all.length === 0) return [];

  const picked: TTrace[] = [];
  for (const item of all) {
    const rawChunk = Number((item as { chunk?: unknown }).chunk);
    if (!Number.isInteger(rawChunk) || rawChunk < 0) continue;
    if (rawChunk !== chunk) continue;
    picked.push(item as TTrace);
  }
  return sortTraceRecords(picked);
}

export async function writeTraceChunk<TTrace = unknown>(traceId: string, _chunk: number, records: TTrace[]): Promise<void> {
  const db = await getDB();
  const chunk = sanitizeChunk(_chunk);
  const tx = db.transaction("traces", "readwrite");
  for (const record of records) {
    await tx.store.put({
      ...(record as any),
      traceId,
      chunk
    });
  }
  await tx.done;
}

export async function appendTraceChunk<TTrace = unknown>(
  traceId: string,
  chunk: number,
  records: TTrace[]
): Promise<TTrace[]> {
  await writeTraceChunk(traceId, chunk, records);
  return readTraceChunk<TTrace>(traceId, chunk);
}

export async function listStorageKeys(): Promise<string[]> {
  const bag = await storageGet(null);
  return Object.keys(bag);
}

export async function removeStorageKeys(keys: string[]): Promise<void> {
  if (!isStringArray(keys)) throw new Error("keys 必须是字符串数组");
  await storageRemove(keys);
}
