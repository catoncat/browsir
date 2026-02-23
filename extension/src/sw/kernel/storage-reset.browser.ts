import {
  SESSION_INDEX_KEY,
  type SessionIndex,
  initSessionIndex,
  isSessionStoreKey,
  listStorageKeys
} from "./session-store.browser";

const DEFAULT_ARCHIVE_PREFIX = "archive:legacy";
const ARCHIVE_INDEX_KEY = "archive:legacy:index";

const DEFAULT_LEGACY_MATCHERS: Array<string | RegExp> = [
  "chatState",
  "chatState.v1",
  "chatState.v2",
  /^session:meta:/,
  /^session:entries:/,
  /^trace:[^:]+$/,
  /^trace:[^:]+:events$/,
  /^loop:/,
  /^planner:/,
  /^runtime:/,
  /^memory:/,
  /^brain-loop:/
];

export interface ArchiveLegacyOptions {
  archivePrefix?: string;
  legacyMatchers?: Array<string | RegExp>;
  excludeKeys?: string[];
}

export interface ArchiveLegacyResult {
  archiveKey: string | null;
  archivedKeys: string[];
  archivedCount: number;
  archiveIndexSize: number;
}

export interface ResetSessionStoreOptions {
  includeTrace?: boolean;
  preserveArchive?: boolean;
  archiveLegacyBeforeReset?: boolean;
  archiveLegacyOptions?: ArchiveLegacyOptions;
}

export interface ResetSessionStoreResult {
  removedKeys: string[];
  removedCount: number;
  archived?: ArchiveLegacyResult;
  index: SessionIndex;
}

function storage(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

function nowIso(): string {
  return new Date().toISOString();
}

function keyMatches(key: string, matcher: string | RegExp): boolean {
  if (typeof matcher === "string") return key === matcher || key.startsWith(`${matcher}:`);
  return matcher.test(key);
}

function shouldArchiveKey(
  key: string,
  archivePrefix: string,
  matchers: Array<string | RegExp>,
  excluded: Set<string>
): boolean {
  if (excluded.has(key)) return false;
  if (isSessionStoreKey(key)) return false;
  if (key === ARCHIVE_INDEX_KEY) return false;
  if (key.startsWith(`${archivePrefix}:`)) return false;
  return matchers.some((matcher) => keyMatches(key, matcher));
}

async function getAllStorage(): Promise<Record<string, unknown>> {
  return (await storage().get(null)) as Record<string, unknown>;
}

async function removeStorageKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await storage().remove(keys);
}

function normalizeArchiveIndex(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    next.push(item);
  }
  return next;
}

export async function archiveLegacyState(options: ArchiveLegacyOptions = {}): Promise<ArchiveLegacyResult> {
  const archivePrefix = options.archivePrefix ?? DEFAULT_ARCHIVE_PREFIX;
  const matchers = options.legacyMatchers ?? DEFAULT_LEGACY_MATCHERS;
  const excluded = new Set(options.excludeKeys ?? []);
  const all = await getAllStorage();

  const keys = Object.keys(all).filter((key) => shouldArchiveKey(key, archivePrefix, matchers, excluded));
  if (keys.length === 0) {
    return {
      archiveKey: null,
      archivedKeys: [],
      archivedCount: 0,
      archiveIndexSize: normalizeArchiveIndex(all[ARCHIVE_INDEX_KEY]).length
    };
  }

  const id = `${Date.now()}`;
  const archiveKey = `${archivePrefix}:${id}`;
  const archivedData: Record<string, unknown> = {};
  for (const key of keys) {
    archivedData[key] = all[key];
  }

  const archiveIndex = normalizeArchiveIndex(all[ARCHIVE_INDEX_KEY]);
  const nextArchiveIndex = archiveIndex.concat(archiveKey);

  await storage().set({
    [archiveKey]: {
      archivedAt: nowIso(),
      source: "pr-5-legacy-reset",
      keys,
      data: archivedData
    },
    [ARCHIVE_INDEX_KEY]: nextArchiveIndex
  });
  await removeStorageKeys(keys);

  return {
    archiveKey,
    archivedKeys: keys,
    archivedCount: keys.length,
    archiveIndexSize: nextArchiveIndex.length
  };
}

export async function resetSessionStore(options: ResetSessionStoreOptions = {}): Promise<ResetSessionStoreResult> {
  const includeTrace = options.includeTrace ?? true;
  const preserveArchive = options.preserveArchive ?? true;
  const archived = options.archiveLegacyBeforeReset
    ? await archiveLegacyState(options.archiveLegacyOptions)
    : undefined;

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

  if (!preserveArchive) {
    for (const key of keys) {
      if (key === ARCHIVE_INDEX_KEY || key.startsWith(`${DEFAULT_ARCHIVE_PREFIX}:`)) {
        removable.push(key);
      }
    }
  }

  const uniqueRemovable = Array.from(new Set(removable));
  await removeStorageKeys(uniqueRemovable);
  const index = await initSessionIndex();

  return {
    removedKeys: uniqueRemovable,
    removedCount: uniqueRemovable.length,
    archived,
    index
  };
}

export { initSessionIndex };
