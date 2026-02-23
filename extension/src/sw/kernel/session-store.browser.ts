import { nowIso, type SessionEntry, type SessionHeader, type SessionMeta } from "./types";

export const SESSION_INDEX_KEY = "session:index";
const SESSION_META_KEY_RE = /^session:([^:]+):meta$/;
const SESSION_ENTRIES_CHUNK_KEY_RE = /^session:([^:]+):entries:(\d+)$/;
const TRACE_CHUNK_KEY_RE = /^trace:([^:]+):(\d+)$/;

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
  chunkSize?: number;
  leafId?: string | null;
}

export interface AppendSessionEntryOptions {
  chunkSize?: number;
}

function storage(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

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

function sanitizeChunkSize(chunkSize: number): number {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error(`chunkSize 必须是 >= 1 的整数，收到: ${String(chunkSize)}`);
  return chunkSize;
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
  return (await storage().get(keys)) as Record<string, unknown>;
}

async function storageSet(items: Record<string, unknown>): Promise<void> {
  await storage().set(items);
}

async function storageRemove(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await storage().remove(keys);
}

export function buildSessionMetaKey(sessionId: string): string {
  return `session:${sanitizeId(sessionId, "session")}:meta`;
}

export function buildSessionEntriesChunkKey(sessionId: string, chunk: number): string {
  return `session:${sanitizeId(sessionId, "session")}:entries:${sanitizeChunk(chunk)}`;
}

export function buildTraceChunkKey(traceId: string, chunk: number): string {
  return `trace:${sanitizeId(traceId, "trace")}:${sanitizeChunk(chunk)}`;
}

export function parseSessionMetaKey(key: string): { sessionId: string } | null {
  const matched = SESSION_META_KEY_RE.exec(key);
  if (!matched) return null;
  return { sessionId: matched[1] };
}

export function parseSessionEntriesChunkKey(key: string): { sessionId: string; chunk: number } | null {
  const matched = SESSION_ENTRIES_CHUNK_KEY_RE.exec(key);
  if (!matched) return null;
  return { sessionId: matched[1], chunk: Number(matched[2]) };
}

export function parseTraceChunkKey(key: string): { traceId: string; chunk: number } | null {
  const matched = TRACE_CHUNK_KEY_RE.exec(key);
  if (!matched) return null;
  return { traceId: matched[1], chunk: Number(matched[2]) };
}

export function isSessionStoreKey(key: string): boolean {
  return key === SESSION_INDEX_KEY || SESSION_META_KEY_RE.test(key) || SESSION_ENTRIES_CHUNK_KEY_RE.test(key) || TRACE_CHUNK_KEY_RE.test(key);
}

export async function initSessionIndex(): Promise<SessionIndex> {
  const bag = await storageGet(SESSION_INDEX_KEY);
  const normalized = normalizeSessionIndex(bag[SESSION_INDEX_KEY]);
  await storageSet({ [SESSION_INDEX_KEY]: normalized });
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
  const chunkSize = sanitizeChunkSize(options.chunkSize ?? 64);
  const meta: SessionMeta = {
    header,
    leafId: options.leafId ?? null,
    entryCount: 0,
    chunkCount: 0,
    chunkSize,
    updatedAt: nowIso()
  };
  await writeSessionMeta(header.id, meta);
  await upsertSessionIndexEntry(header.id, meta.updatedAt);
  return meta;
}

export async function readSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  const key = buildSessionMetaKey(sessionId);
  const bag = await storageGet(key);
  return normalizeSessionMeta(bag[key]);
}

export async function writeSessionMeta(sessionId: string, meta: SessionMeta): Promise<void> {
  const key = buildSessionMetaKey(sessionId);
  const next: SessionMeta = {
    ...meta,
    updatedAt: nowIso()
  };
  await storageSet({ [key]: next });
  await upsertSessionIndexEntry(sessionId, next.updatedAt);
}

export async function removeSessionMeta(sessionId: string): Promise<void> {
  await storageRemove([buildSessionMetaKey(sessionId)]);
}

export async function readSessionEntriesChunk<TEntry = unknown>(sessionId: string, chunk: number): Promise<TEntry[]> {
  const key = buildSessionEntriesChunkKey(sessionId, chunk);
  const bag = await storageGet(key);
  const value = bag[key];
  return Array.isArray(value) ? (value as TEntry[]) : [];
}

export async function writeSessionEntriesChunk<TEntry = unknown>(
  sessionId: string,
  chunk: number,
  entries: TEntry[]
): Promise<void> {
  const key = buildSessionEntriesChunkKey(sessionId, chunk);
  await storageSet({ [key]: entries });
}

export async function appendSessionEntriesChunk<TEntry = unknown>(
  sessionId: string,
  chunk: number,
  entries: TEntry[]
): Promise<TEntry[]> {
  const current = await readSessionEntriesChunk<TEntry>(sessionId, chunk);
  const merged = current.concat(entries);
  await writeSessionEntriesChunk(sessionId, chunk, merged);
  return merged;
}

export async function appendSessionEntry(
  sessionId: string,
  entry: SessionEntry,
  options: AppendSessionEntryOptions = {}
): Promise<SessionMeta> {
  const meta = await readSessionMeta(sessionId);
  if (!meta) throw new Error(`session meta 不存在: ${sessionId}`);

  const chunkSize = sanitizeChunkSize(options.chunkSize ?? meta.chunkSize);
  const chunk = Math.floor(meta.entryCount / chunkSize);
  await appendSessionEntriesChunk<SessionEntry>(sessionId, chunk, [entry]);

  const nextMeta: SessionMeta = {
    ...meta,
    leafId: entry.id,
    entryCount: meta.entryCount + 1,
    chunkCount: Math.max(meta.chunkCount, chunk + 1),
    chunkSize,
    updatedAt: nowIso()
  };
  await writeSessionMeta(sessionId, nextMeta);
  return nextMeta;
}

export async function readAllSessionEntries(sessionId: string): Promise<SessionEntry[]> {
  const meta = await readSessionMeta(sessionId);
  if (!meta || meta.chunkCount <= 0) return [];
  const entries: SessionEntry[] = [];

  for (let chunk = 0; chunk < meta.chunkCount; chunk += 1) {
    const items = await readSessionEntriesChunk<SessionEntry>(sessionId, chunk);
    entries.push(...items);
  }

  if (entries.length > meta.entryCount) {
    return entries.slice(0, meta.entryCount);
  }
  return entries;
}

export async function removeSessionEntriesChunk(sessionId: string, chunk: number): Promise<void> {
  await storageRemove([buildSessionEntriesChunkKey(sessionId, chunk)]);
}

export async function readTraceChunk<TTrace = unknown>(traceId: string, chunk: number): Promise<TTrace[]> {
  const key = buildTraceChunkKey(traceId, chunk);
  const bag = await storageGet(key);
  const value = bag[key];
  return Array.isArray(value) ? (value as TTrace[]) : [];
}

export async function writeTraceChunk<TTrace = unknown>(traceId: string, chunk: number, records: TTrace[]): Promise<void> {
  const key = buildTraceChunkKey(traceId, chunk);
  await storageSet({ [key]: records });
}

export async function appendTraceChunk<TTrace = unknown>(
  traceId: string,
  chunk: number,
  records: TTrace[]
): Promise<TTrace[]> {
  const current = await readTraceChunk<TTrace>(traceId, chunk);
  const merged = current.concat(records);
  await writeTraceChunk(traceId, chunk, merged);
  return merged;
}

export async function listStorageKeys(): Promise<string[]> {
  const bag = await storageGet(null);
  return Object.keys(bag);
}

export async function listSessionStoreKeys(): Promise<string[]> {
  const keys = await listStorageKeys();
  return keys.filter((key) => isSessionStoreKey(key));
}

function sortChunkKeys<K extends { key: string; chunk: number }>(items: K[]): K[] {
  return items.sort((a, b) => a.chunk - b.chunk);
}

export async function listSessionEntryChunkKeys(sessionId: string): Promise<string[]> {
  const id = sanitizeId(sessionId, "session");
  const keys = await listStorageKeys();
  const prefixed = keys
    .map((key) => {
      const parsed = parseSessionEntriesChunkKey(key);
      if (!parsed || parsed.sessionId !== id) return null;
      return { key, chunk: parsed.chunk };
    })
    .filter((item): item is { key: string; chunk: number } => item !== null);
  return sortChunkKeys(prefixed).map((item) => item.key);
}

export async function listTraceChunkKeys(traceId: string): Promise<string[]> {
  const id = sanitizeId(traceId, "trace");
  const keys = await listStorageKeys();
  const prefixed = keys
    .map((key) => {
      const parsed = parseTraceChunkKey(key);
      if (!parsed || parsed.traceId !== id) return null;
      return { key, chunk: parsed.chunk };
    })
    .filter((item): item is { key: string; chunk: number } => item !== null);
  return sortChunkKeys(prefixed).map((item) => item.key);
}

export async function removeStorageKeys(keys: string[]): Promise<void> {
  if (!isStringArray(keys)) throw new Error("keys 必须是字符串数组");
  await storageRemove(keys);
}
