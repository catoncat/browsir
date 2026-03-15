import { Sandbox } from "@lifo-sh/core";
import { kvGet, kvKeys, kvRemove, kvSet } from "../idb-storage";
import { sandboxBash, type SandboxBashResult, type VfsFile } from "../eval-bridge";
import { SessionRuntimeManager } from "./session-runtime-manager";
import {
  type VirtualNamespaceDescriptor,
  VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX,
  SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX,
  normalizeRelativePath,
  toNamespaceStorageKey,
  buildSessionNamespaceStorageKey,
  buildSystemNamespaceStorageKey,
  sessionUnixRoot,
  listNamespaceDescriptors,
  resolveVirtualPath,
  rewriteCommandVirtualUris,
  unixPathToVirtualUri,
  dirname,
} from "./virtual-path-resolver";

export { VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX, SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX } from "./virtual-path-resolver";

// Test hook: when set, bypasses sandboxBash and uses direct execution.
type BashExecutor = (sandbox: Sandbox, command: string, cwd: string | undefined, timeoutMs?: number) => Promise<SandboxBashResult>;
let _testBashExecutor: BashExecutor | null = null;

export function _setTestBashExecutor(executor: BashExecutor | null): void {
  _testBashExecutor = executor;
}

type JsonRecord = Record<string, unknown>;

interface LiveSessionSandbox {
  sandbox: Sandbox;
  descriptors: VirtualNamespaceDescriptor[];
  appliedNamespaceVersions: Map<string, number>;
}

interface NamespaceCaptureStats {
  namespaceCount: number;
  persistedNamespaceCount: number;
  fileCount: number;
  bytes: number;
}

interface SandboxTelemetryEvent {
  ts: string;
  type: "flush.finished" | "flush.skipped" | "command.finished";
  reason?: string;
  durationMs?: number;
  bytes?: number;
  fileCount?: number;
  namespaceCount?: number;
  persistedNamespaceCount?: number;
  forced?: boolean;
  dirty?: boolean;
  command?: string;
  exitCode?: number;
  timeoutHit?: boolean;
}

interface SandboxTelemetrySummary {
  flushCount: number;
  flushSkippedCount: number;
  forcedFlushCount: number;
  flushTotalMs: number;
  flushMaxMs: number;
  flushTotalBytes: number;
  flushTotalFiles: number;
  flushTotalNamespaces: number;
  commandCount: number;
  commandTimeoutCount: number;
  commandNonZeroExitCount: number;
  commandTotalMs: number;
  commandMaxMs: number;
  lastFlushAt: string;
  lastFlushReason: string;
  lastFlushDurationMs: number;
  lastFlushBytes: number;
  lastFlushFiles: number;
  lastCommandAt: string;
  lastCommand: string;
  lastCommandDurationMs: number;
  lastCommandExitCode: number | null;
  lastCommandTimeoutHit: boolean;
}

const MAX_READ_BYTES = 512 * 1024;
const DIRTY_FLUSH_MIN_INTERVAL_MS = 750;
const SANDBOX_TELEMETRY_TAIL_LIMIT = 32;

const namespaceFiles = new Map<string, Map<string, Uint8Array>>();
const namespaceVersions = new Map<string, number>();
const sandboxTelemetrySummaryBySession = new Map<string, SandboxTelemetrySummary>();
const sandboxTelemetryTailBySession = new Map<string, SandboxTelemetryEvent[]>();
let adapterQueue: Promise<void> = Promise.resolve();

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /ENOENT|no such file or directory/i.test(String(error.message || ""));
}

function applyFindReplace(input: string, edit: JsonRecord): { content: string; replacements: number } {
  const find = String(edit.find ?? edit.old ?? "");
  const replace = String(edit.new ?? edit.replace ?? "");
  if (!find) throw new Error("edit.find/edit.old 不能为空");

  if (edit.all === true) {
    const parts = input.split(find);
    const replacements = parts.length - 1;
    if (replacements <= 0) throw new Error(`find_replace failed: target not found: ${find}`);
    return {
      content: parts.join(replace),
      replacements
    };
  }

  const idx = input.indexOf(find);
  if (idx < 0) throw new Error(`find_replace failed: target not found: ${find}`);
  return {
    content: `${input.slice(0, idx)}${replace}${input.slice(idx + find.length)}`,
    replacements: 1
  };
}

function cloneBytes(input: Uint8Array): Uint8Array {
  return input.slice();
}

function clipTelemetryText(input: unknown, max = 180): string {
  const text = String(input || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function createEmptyTelemetrySummary(): SandboxTelemetrySummary {
  return {
    flushCount: 0,
    flushSkippedCount: 0,
    forcedFlushCount: 0,
    flushTotalMs: 0,
    flushMaxMs: 0,
    flushTotalBytes: 0,
    flushTotalFiles: 0,
    flushTotalNamespaces: 0,
    commandCount: 0,
    commandTimeoutCount: 0,
    commandNonZeroExitCount: 0,
    commandTotalMs: 0,
    commandMaxMs: 0,
    lastFlushAt: "",
    lastFlushReason: "",
    lastFlushDurationMs: 0,
    lastFlushBytes: 0,
    lastFlushFiles: 0,
    lastCommandAt: "",
    lastCommand: "",
    lastCommandDurationMs: 0,
    lastCommandExitCode: null,
    lastCommandTimeoutHit: false
  };
}

function getTelemetrySummary(sessionId: string): SandboxTelemetrySummary {
  let summary = sandboxTelemetrySummaryBySession.get(sessionId);
  if (!summary) {
    summary = createEmptyTelemetrySummary();
    sandboxTelemetrySummaryBySession.set(sessionId, summary);
  }
  return summary;
}

function pushTelemetryEvent(sessionId: string, event: SandboxTelemetryEvent): void {
  const tail = sandboxTelemetryTailBySession.get(sessionId) ?? [];
  tail.push(event);
  if (tail.length > SANDBOX_TELEMETRY_TAIL_LIMIT) {
    tail.splice(0, tail.length - SANDBOX_TELEMETRY_TAIL_LIMIT);
  }
  sandboxTelemetryTailBySession.set(sessionId, tail);
}

function isForcedFlushReason(reason: string): boolean {
  const normalized = String(reason || "").trim().toLowerCase();
  return (
    normalized.includes("ttl") ||
    normalized.includes("lru") ||
    normalized.includes("dispose")
  );
}

function recordFlushFinished(
  sessionId: string,
  reason: string,
  durationMs: number,
  stats: NamespaceCaptureStats,
  dirty: boolean
): void {
  const summary = getTelemetrySummary(sessionId);
  summary.flushCount += 1;
  summary.flushTotalMs += durationMs;
  summary.flushMaxMs = Math.max(summary.flushMaxMs, durationMs);
  summary.flushTotalBytes += stats.bytes;
  summary.flushTotalFiles += stats.fileCount;
  summary.flushTotalNamespaces += stats.namespaceCount;
  summary.lastFlushAt = new Date().toISOString();
  summary.lastFlushReason = reason;
  summary.lastFlushDurationMs = durationMs;
  summary.lastFlushBytes = stats.bytes;
  summary.lastFlushFiles = stats.fileCount;
  if (isForcedFlushReason(reason)) {
    summary.forcedFlushCount += 1;
  }
  pushTelemetryEvent(sessionId, {
    ts: summary.lastFlushAt,
    type: "flush.finished",
    reason,
    durationMs,
    bytes: stats.bytes,
    fileCount: stats.fileCount,
    namespaceCount: stats.namespaceCount,
    persistedNamespaceCount: stats.persistedNamespaceCount,
    forced: isForcedFlushReason(reason),
    dirty
  });
}

function recordFlushSkipped(sessionId: string, reason: string, dirty: boolean): void {
  const summary = getTelemetrySummary(sessionId);
  summary.flushSkippedCount += 1;
  pushTelemetryEvent(sessionId, {
    ts: new Date().toISOString(),
    type: "flush.skipped",
    reason,
    dirty
  });
}

function recordCommandFinished(
  sessionId: string,
  command: string,
  durationMs: number,
  exitCode: number,
  timeoutHit: boolean
): void {
  const summary = getTelemetrySummary(sessionId);
  summary.commandCount += 1;
  summary.commandTotalMs += durationMs;
  summary.commandMaxMs = Math.max(summary.commandMaxMs, durationMs);
  if (timeoutHit) summary.commandTimeoutCount += 1;
  if (exitCode !== 0) summary.commandNonZeroExitCount += 1;
  summary.lastCommandAt = new Date().toISOString();
  summary.lastCommand = clipTelemetryText(command, 160);
  summary.lastCommandDurationMs = durationMs;
  summary.lastCommandExitCode = exitCode;
  summary.lastCommandTimeoutHit = timeoutHit;
  pushTelemetryEvent(sessionId, {
    ts: summary.lastCommandAt,
    type: "command.finished",
    command: summary.lastCommand,
    durationMs,
    exitCode,
    timeoutHit
  });
}

function clearSandboxTelemetry(sessionId?: string): void {
  if (sessionId) {
    sandboxTelemetrySummaryBySession.delete(sessionId);
    sandboxTelemetryTailBySession.delete(sessionId);
    return;
  }
  sandboxTelemetrySummaryBySession.clear();
  sandboxTelemetryTailBySession.clear();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function namespaceFileMapsEqual(
  a: Map<string, Uint8Array>,
  b: Map<string, Uint8Array>
): boolean {
  if (a.size !== b.size) return false;
  for (const [path, bytes] of a.entries()) {
    const other = b.get(path);
    if (!other || !bytesEqual(bytes, other)) return false;
  }
  return true;
}

function getNamespaceVersion(storageKey: string): number {
  return namespaceVersions.get(storageKey) ?? 0;
}

function markNamespaceChanged(storageKey: string): void {
  namespaceVersions.set(storageKey, getNamespaceVersion(storageKey) + 1);
}

function normalizeBytes(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) return cloneBytes(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  if (Array.isArray(input) && input.every((item) => Number.isInteger(item))) {
    return new Uint8Array(input.map((item) => Number(item)));
  }
  return null;
}

async function readPersistedNamespaceFiles(
  storageKey: string
): Promise<Map<string, Uint8Array>> {
  const normalizedKey = toNamespaceStorageKey(storageKey);
  if (!normalizedKey || normalizedKey.startsWith("ephemeral:")) {
    return new Map<string, Uint8Array>();
  }
  const raw = await kvGet(normalizedKey);
  const row = toRecord(raw);
  const filesRaw = Array.isArray(row.files) ? row.files : [];
  const next = new Map<string, Uint8Array>();
  for (const item of filesRaw) {
    const entry = toRecord(item);
    const path = normalizeRelativePath(String(entry.path || ""));
    const bytes = normalizeBytes(entry.bytes);
    if (!path || !bytes) continue;
    next.set(path, bytes);
  }
  return next;
}

async function persistNamespaceFiles(
  storageKey: string,
  files: Map<string, Uint8Array>
): Promise<void> {
  const normalizedKey = toNamespaceStorageKey(storageKey);
  if (!normalizedKey || normalizedKey.startsWith("ephemeral:")) return;
  if (files.size <= 0) {
    await kvRemove(normalizedKey);
    return;
  }
  const payload = {
    version: 1,
    files: [...files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, bytes]) => ({
        path,
        bytes: cloneBytes(bytes)
      }))
  };
  await kvSet(normalizedKey, payload);
}

async function loadNamespaceFiles(
  storageKey: string
): Promise<Map<string, Uint8Array>> {
  const normalizedKey = toNamespaceStorageKey(storageKey);
  const cached = namespaceFiles.get(normalizedKey);
  if (cached) return cached;
  const loaded = await readPersistedNamespaceFiles(normalizedKey);
  namespaceFiles.set(normalizedKey, loaded);
  return loaded;
}

async function clearPersistedNamespace(
  storageKey: string
): Promise<void> {
  const normalizedKey = toNamespaceStorageKey(storageKey);
  namespaceFiles.delete(normalizedKey);
  if (!normalizedKey || normalizedKey.startsWith("ephemeral:")) return;
  await kvRemove(normalizedKey);
}

async function resetSandboxNamespaceRoot(
  descriptor: VirtualNamespaceDescriptor,
  sandbox: Sandbox
): Promise<void> {
  const root = descriptor.unixRoot;
  if (await sandbox.fs.exists(root)) {
    try {
      await sandbox.fs.rm(root, { recursive: true });
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  await sandbox.fs.mkdir(root, { recursive: true });
}

async function enqueueAdapterTask<T>(task: () => Promise<T>): Promise<T> {
  const previous = adapterQueue;
  const running = previous.then(task, task);
  const done = running.then(() => undefined, () => undefined);
  adapterQueue = done;
  return await running;
}

async function ensureNamespaceRoots(
  sessionId: string,
  sandbox: Sandbox
): Promise<VirtualNamespaceDescriptor[]> {
  const descriptors = listNamespaceDescriptors(sessionId);
  for (const descriptor of descriptors) {
    await sandbox.fs.mkdir(descriptor.unixRoot, { recursive: true });
  }
  return descriptors;
}

async function restoreNamespaceFiles(
  descriptors: VirtualNamespaceDescriptor[],
  sandbox: Sandbox
): Promise<void> {
  for (const descriptor of descriptors) {
    const files = await loadNamespaceFiles(descriptor.key);
    if (files.size <= 0) continue;
    const entries = [...files.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [relativePath, bytes] of entries) {
      if (!relativePath) continue;
      const unixPath = `${descriptor.unixRoot}/${relativePath}`;
      await sandbox.fs.mkdir(dirname(unixPath), { recursive: true });
      await sandbox.fs.writeFile(unixPath, cloneBytes(bytes));
    }
  }
}

async function syncNamespaceFiles(
  descriptor: VirtualNamespaceDescriptor,
  sandbox: Sandbox
): Promise<void> {
  await resetSandboxNamespaceRoot(descriptor, sandbox);
  const files = await loadNamespaceFiles(descriptor.key);
  if (files.size <= 0) return;
  const entries = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [relativePath, bytes] of entries) {
    if (!relativePath) continue;
    const unixPath = `${descriptor.unixRoot}/${relativePath}`;
    await sandbox.fs.mkdir(dirname(unixPath), { recursive: true });
    await sandbox.fs.writeFile(unixPath, cloneBytes(bytes));
  }
}

async function captureNamespaceFiles(
  descriptors: VirtualNamespaceDescriptor[],
  sandbox: Sandbox
): Promise<NamespaceCaptureStats> {
  const stats: NamespaceCaptureStats = {
    namespaceCount: descriptors.length,
    persistedNamespaceCount: descriptors.filter((item) => item.scope !== "ephemeral").length,
    fileCount: 0,
    bytes: 0
  };
  for (const descriptor of descriptors) {
    const next = new Map<string, Uint8Array>();
    const root = descriptor.unixRoot;
    const rootPrefix = `${root}/`;

    const walk = async (currentDir: string): Promise<void> => {
      let entries: Array<{ name: string; type: "file" | "directory" }> = [];
      try {
        entries = await sandbox.fs.readdir(currentDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const name = String(entry.name || "").trim();
        if (!name) continue;
        const child =
          currentDir === "/" ? `/${name}` : `${currentDir}/${name}`;
        if (entry.type === "directory") {
          await walk(child);
          continue;
        }
        if (entry.type !== "file") continue;
        if (!child.startsWith(rootPrefix)) continue;
        const relativePath = child.slice(rootPrefix.length);
        if (!relativePath) continue;
        const bytes = (await sandbox.fs.readFile(
          child,
          null as null
        )) as Uint8Array;
        next.set(relativePath, cloneBytes(bytes));
        stats.fileCount += 1;
        stats.bytes += bytes.byteLength;
      }
    };

    await walk(root);
    const previous = namespaceFiles.get(descriptor.key) ?? new Map<string, Uint8Array>();
    namespaceFiles.set(descriptor.key, next);
    if (!namespaceFileMapsEqual(previous, next)) {
      markNamespaceChanged(descriptor.key);
    }
    await persistNamespaceFiles(descriptor.key, next);
  }
  return stats;
}

async function createLiveSessionSandbox(
  sessionId: string
): Promise<LiveSessionSandbox> {
  const sandbox = await Sandbox.create({
    persist: false
  });
  const descriptors = await ensureNamespaceRoots(sessionId, sandbox);
  await restoreNamespaceFiles(descriptors, sandbox);
  sandbox.cwd = sessionUnixRoot(sessionId);
  const appliedNamespaceVersions = new Map<string, number>();
  for (const descriptor of descriptors) {
    appliedNamespaceVersions.set(
      descriptor.key,
      getNamespaceVersion(descriptor.key)
    );
  }
  return {
    sandbox,
    descriptors,
    appliedNamespaceVersions
  };
}

async function syncSharedNamespaces(
  entry: LiveSessionSandbox
): Promise<void> {
  for (const descriptor of entry.descriptors) {
    if (descriptor.scope !== "global") continue;
    const nextVersion = getNamespaceVersion(descriptor.key);
    const currentVersion = entry.appliedNamespaceVersions.get(descriptor.key);
    if (currentVersion === nextVersion) continue;
    await syncNamespaceFiles(descriptor, entry.sandbox);
    entry.appliedNamespaceVersions.set(descriptor.key, nextVersion);
  }
}

async function flushLiveSessionSandbox(
  sessionId: string,
  entry: LiveSessionSandbox,
  reason: string
): Promise<void> {
  const startedAt = Date.now();
  const dirty = sandboxManager.getRuntimeInfo(sessionId)?.dirty === true;
  const stats = await captureNamespaceFiles(entry.descriptors, entry.sandbox);
  for (const descriptor of entry.descriptors) {
    entry.appliedNamespaceVersions.set(
      descriptor.key,
      getNamespaceVersion(descriptor.key)
    );
  }
  recordFlushFinished(sessionId, reason, Date.now() - startedAt, stats, dirty);
}

const sandboxManager = new SessionRuntimeManager<LiveSessionSandbox>(
  {
    create: createLiveSessionSandbox,
    flush: flushLiveSessionSandbox,
    async destroy(_sessionId, entry): Promise<void> {
      entry.sandbox.destroy();
    }
  },
  {
    idleTtlMs: 5 * 60_000,
    maxLiveSessions: 8
  }
);

async function checkpointSessionSandbox(
  sessionId: string,
  reason: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const info = sandboxManager.getRuntimeInfo(sessionId);
  if (!info || info.dirty !== true) return;
  if (options.force === true) {
    await sandboxManager.flush(sessionId, reason);
    return;
  }
  // Flush first dirty checkpoint immediately. After that, coalesce bursty
  // write/edit/bash sequences into a single snapshot every short interval.
  if (info.lastFlushedAt == null) {
    await sandboxManager.flush(sessionId, reason);
    return;
  }
  const flushed = await sandboxManager.flushIfDue(
    sessionId,
    DIRTY_FLUSH_MIN_INTERVAL_MS,
    reason
  );
  if (!flushed) {
    recordFlushSkipped(sessionId, reason, true);
  }
}

async function withSessionSandbox<T>(
  sessionId: string,
  task: (sandbox: Sandbox) => Promise<T>
): Promise<T> {
  return await enqueueAdapterTask(async () => {
    const entry = await sandboxManager.acquire(sessionId);
    await syncSharedNamespaces(entry);
    const result = await task(entry.sandbox);
    sandboxManager.touch(sessionId);
    return result;
  });
}

async function runSandboxCommandWithTimeout(
  sandbox: Sandbox,
  command: string,
  options: { cwd?: string },
  timeoutMs?: number
): Promise<{
  result: { stdout: string; stderr: string; exitCode: number };
  timeoutHit: boolean;
}> {
  const processRegistry = sandbox.shell.getProcessRegistry();
  const baselinePids = new Set(processRegistry.getAllPIDs());
  let timeoutHit = false;

  // @lifo-sh/core's timeout/signal path is currently ineffective for foreground
  // commands in our browser runtime, so enforce deadlines via process registry.
  const pending = sandbox.commands.run(command, options);
  const timer =
    timeoutMs == null
      ? null
      : setTimeout(() => {
          timeoutHit = true;
          for (const row of processRegistry.getAll()) {
            if (baselinePids.has(row.pid)) continue;
            processRegistry.kill(row.pid, "SIGTERM");
          }
        }, timeoutMs);

  try {
    const result = await pending;
    if (!timeoutHit) {
      return { result, timeoutHit: false };
    }

    const timeoutMessage = `Command timed out after ${timeoutMs}ms`;
    const stderr = String(result.stderr || "").trim();
    return {
      result: {
        stdout: String(result.stdout || ""),
        stderr: stderr ? `${stderr}\n${timeoutMessage}` : timeoutMessage,
        exitCode: 124
      },
      timeoutHit: true
    };
  } finally {
    if (timer != null) {
      clearTimeout(timer);
    }
  }
}

async function readFrame(args: JsonRecord, sessionId: string): Promise<JsonRecord> {
  return await withSessionSandbox(sessionId, async (sandbox) => {
    const resolved = resolveVirtualPath(args.path, sessionId);

    let fullBytes: Uint8Array;
    try {
      fullBytes = (await sandbox.fs.readFile(
        resolved.unixPath,
        null as null
      )) as Uint8Array;
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(`virtual file not found: ${resolved.uri}`);
      }
      throw error;
    }
    const offset = Math.max(0, toInt(args.offset, 0));
    const limit = Math.max(1, Math.min(MAX_READ_BYTES, toInt(args.limit, MAX_READ_BYTES)));
    const start = Math.min(offset, fullBytes.byteLength);
    const end = Math.min(fullBytes.byteLength, start + limit);
    const chunk = fullBytes.slice(start, end);

    return {
      path: resolved.uri,
      offset,
      limit,
      size: fullBytes.byteLength,
      truncated: end < fullBytes.byteLength,
      content: decodeUtf8(chunk)
    };
  });
}

async function writeFrame(args: JsonRecord, sessionId: string): Promise<JsonRecord> {
  return await withSessionSandbox(sessionId, async (sandbox) => {
    const resolved = resolveVirtualPath(args.path, sessionId);
    const content = String(args.content || "");
    const modeRaw = String(args.mode || "overwrite").trim();
    const mode = modeRaw === "append" || modeRaw === "create" ? modeRaw : "overwrite";

    const existed = await sandbox.fs.exists(resolved.unixPath);
    if (mode === "create" && existed) {
      throw new Error(`virtual file already exists: ${resolved.uri}`);
    }

    let nextContent = content;
    if (mode === "append") {
      const previous = existed ? String(await sandbox.fs.readFile(resolved.unixPath)) : "";
      nextContent = `${previous}${content}`;
    }

    await sandbox.fs.mkdir(dirname(resolved.unixPath), { recursive: true });
    await sandbox.fs.writeFile(resolved.unixPath, nextContent);
    sandboxManager.markDirty(sessionId);
    // MV3 service worker can be reclaimed between turns, so writes checkpoint immediately.
    await checkpointSessionSandbox(sessionId, "write", {
      force: resolved.namespace.scope === "global"
    });
    return {
      path: resolved.uri,
      mode,
      bytesWritten: encodeUtf8(content).byteLength
    };
  });
}

async function editFrame(args: JsonRecord, sessionId: string): Promise<JsonRecord> {
  return await withSessionSandbox(sessionId, async (sandbox) => {
    const resolved = resolveVirtualPath(args.path, sessionId);
    const exists = await sandbox.fs.exists(resolved.unixPath);
    if (!exists) throw new Error(`virtual file not found: ${resolved.uri}`);

    const original = String(await sandbox.fs.readFile(resolved.unixPath));
    const editsRaw = Array.isArray(args.edits) ? args.edits : [args.edits];
    let next = original;
    let replacements = 0;
    let hunks = 0;

    for (const row of editsRaw) {
      const edit = toRecord(row);
      if (typeof edit.patch === "string" || String(edit.kind || "") === "unified_patch") {
        throw new Error("browser unix sandbox 暂不支持 unified_patch");
      }
      const applied = applyFindReplace(next, edit);
      next = applied.content;
      replacements += applied.replacements;
      hunks += 1;
    }

    if (next === original) throw new Error("No changes produced by edits");
    await sandbox.fs.writeFile(resolved.unixPath, next);
    sandboxManager.markDirty(sessionId);
    await checkpointSessionSandbox(sessionId, "edit", {
      force: resolved.namespace.scope === "global"
    });
    return {
      path: resolved.uri,
      applied: true,
      hunks,
      replacements
    };
  });
}

async function bashFrame(args: JsonRecord, sessionId: string): Promise<JsonRecord> {
  return await withSessionSandbox(sessionId, async (sandbox) => {
    const cmdId = String(args.cmdId || "").trim();
    if (cmdId !== "bash.exec") {
      throw new Error(`browser unix sandbox 仅支持 cmdId=bash.exec，收到: ${cmdId || "<empty>"}`);
    }

    const argv = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
    const rawCommand = String(argv[0] || "").trim();
    const command = rewriteCommandVirtualUris(rawCommand, sessionId);
    const hasExplicitCwd =
      args.cwd != null && String(args.cwd || "").trim() !== "";
    const cwdResolved = hasExplicitCwd
      ? resolveVirtualPath(args.cwd, sessionId)
      : null;
    const timeoutMs = args.timeoutMs == null ? undefined : Math.max(1000, toInt(args.timeoutMs, 120_000));
    const startedAt = Date.now();

    const cwd = cwdResolved?.unixPath ?? sandbox.cwd;
    let result: SandboxBashResult;
    if (_testBashExecutor) {
      result = await _testBashExecutor(sandbox, command, cwdResolved?.unixPath, timeoutMs);
    } else if (!commandRequiresEval(command)) {
      // SW 直执行：命令不需要 eval，直接在 SW 侧 LIFO 实例执行，
      // 跳过 eval-bridge 的全量 VFS 同步 / 消息往返 / diff 开销。
      const execResult = await runSandboxCommandWithTimeout(
        sandbox, command, { cwd }, timeoutMs
      );
      result = {
        ok: execResult.result.exitCode === 0,
        stdout: execResult.result.stdout,
        stderr: execResult.result.stderr,
        exitCode: execResult.result.exitCode,
        vfsDiff: [],
      };
      if (execResult.timeoutHit) {
        result.stderr = result.stderr
          ? `${result.stderr}\nCommand timed out after ${timeoutMs}ms`
          : `Command timed out after ${timeoutMs}ms`;
      }
    } else {
      // eval-bridge 路径：命令包含 node/npm 等需要 new Function() 的程序
      const files = await collectVfsFilesForBridge(sandbox);
      result = await sandboxBash({ command, files, cwd, timeoutMs });
      // Apply VFS diff back to the SW sandbox
      for (const diff of result.vfsDiff) {
        if (diff.op === "delete") {
          try { await sandbox.fs.rm(diff.path); } catch { /* ignore */ }
        } else if (diff.content != null) {
          const dir = diff.path.replace(/\/[^/]+$/, "");
          if (dir && dir !== "/") {
            await sandbox.fs.mkdir(dir, { recursive: true });
          }
          await sandbox.fs.writeFile(diff.path, diff.content);
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    const exitCode = result.exitCode;
    const timeoutHit = result.stderr.includes("timed out");
    recordCommandFinished(sessionId, rawCommand, durationMs, exitCode, timeoutHit);
    sandboxManager.markDirty(sessionId);
    await checkpointSessionSandbox(sessionId, "bash", { force: true });

    const stdout = result.stdout;
    const stderr = result.stderr;
    const stdoutBytes = encodeUtf8(stdout).byteLength;
    const stderrBytes = encodeUtf8(stderr).byteLength;

    return {
      cmdId: "bash.exec",
      argv: ["bash", "-lc", rawCommand],
      risk: "high",
      cwd: unixPathToVirtualUri(cwdResolved?.unixPath ?? sandbox.cwd, sessionId),
      exitCode,
      stdout,
      stderr,
      stdoutBytes,
      stderrBytes,
      bytesOut: stdoutBytes + stderrBytes,
      durationMs,
      truncated: false,
      timeoutHit
    };
  });
}

// Shell builtins that LIFO handles via its shell parser directly, without
// triggering lazy-loaded import() calls.  These can safely run in the
// SW-side LIFO instance.  All other commands (ls, grep, whoami, …) are
// lazily loaded via import() chunks, which Chrome SW blocks.
const SW_DIRECT_BUILTINS = new Set([
  "cd", "pwd", "echo", "clear", "export", "exit",
  "true", "false", "jobs", "fg", "bg", "history",
  "source", ".", "alias", "unalias", "test", "[",
]);

/**
 * Determines whether a shell command must be dispatched through the
 * eval-bridge iframe rather than the SW-side LIFO instance.
 *
 * In Chrome Service Workers, `import()` is disallowed.  LIFO lazy-loads
 * every external command (ls, grep, sed, whoami, …) via `import()` chunks,
 * so they all fail when executed directly in the SW.  Only shell builtins
 * (cd, pwd, echo, …) are handled by the shell parser without triggering
 * `import()`.
 *
 * Strategy: route everything through the eval-bridge **by default**.
 * Only pure-builtin command lines (no pipes / chains to external commands)
 * may skip the bridge for zero-overhead execution.
 */
function commandRequiresEval(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const firstWord = trimmed.split(/[\s;|&(]/)[0];

  // A pure builtin invocation with no pipes / chains / subshells that
  // might invoke an external (lazy-loaded) command → safe for direct SW exec.
  if (SW_DIRECT_BUILTINS.has(firstWord) && !/[|;&`]|\$\(/.test(trimmed.slice(firstWord.length))) {
    return false;
  }

  // Everything else goes through eval-bridge where import() works.
  return true;
}

// FNV-1a hash for fast string content dedup during eval-bridge sync.
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0; // unsigned 32-bit
}

async function collectVfsFilesForBridge(sandbox: Sandbox): Promise<VfsFile[]> {
  const files: VfsFile[] = [];
  // LIFO special mounts that are auto-created and read-only; skip them.
  const skipDirs = new Set(["/proc", "/dev"]);
  const walk = async (dir: string): Promise<void> => {
    if (skipDirs.has(dir)) return;
    let entries: Array<{ name: string; type: "file" | "directory" }> = [];
    try {
      entries = await sandbox.fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = String(entry.name || "").trim();
      if (!name) continue;
      const child = dir === "/" ? `/${name}` : `${dir}/${name}`;
      if (entry.type === "directory") {
        await walk(child);
      } else if (entry.type === "file") {
        try {
          const content = String(await sandbox.fs.readFile(child));
          files.push({ path: child, content, hash: fnv1aHash(content) });
        } catch { /* skip unreadable */ }
      }
    }
  };
  await walk("/");
  return files;
}

async function statFrame(args: JsonRecord, sessionId: string): Promise<JsonRecord> {
  return await withSessionSandbox(sessionId, async (sandbox) => {
    const resolved = resolveVirtualPath(args.path, sessionId);
    const exists = await sandbox.fs.exists(resolved.unixPath);
    if (!exists) {
      return {
        path: resolved.uri,
        exists: false,
        type: "missing",
        size: null,
        mtimeMs: null,
      };
    }
    const row = await sandbox.fs.stat(resolved.unixPath);
    const statRow = toRecord(row);
    const type = String(statRow.type || "").trim().toLowerCase();
    const size = Number(statRow.size);
    const mtimeMs = Number(statRow.mtimeMs);
    return {
      path: resolved.uri,
      exists: true,
      type: type === "directory" ? "directory" : type === "file" ? "file" : "other",
      size: Number.isFinite(size) ? size : null,
      mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
    };
  });
}

async function listFrame(args: JsonRecord, sessionId: string): Promise<JsonRecord> {
  return await withSessionSandbox(sessionId, async (sandbox) => {
    const resolved = resolveVirtualPath(args.path, sessionId);
    const exists = await sandbox.fs.exists(resolved.unixPath);
    if (!exists) {
      return {
        path: resolved.uri,
        exists: false,
        type: "missing",
        entries: [],
      };
    }
    const rootStat = toRecord(await sandbox.fs.stat(resolved.unixPath));
    if (String(rootStat.type || "").trim().toLowerCase() !== "directory") {
      return {
        path: resolved.uri,
        exists: true,
        type: "other",
        entries: [],
      };
    }
    const entries = await sandbox.fs.readdir(resolved.unixPath);
    const results = await Promise.all(
      entries.map(async (entry) => {
        const name = String(entry.name || "").trim();
        const childPath = resolved.path ? `${resolved.path}/${name}` : name;
        const childUnixPath =
          resolved.unixPath === "/" ? `/${name}` : `${resolved.unixPath}/${name}`;
        const childStat = toRecord(await sandbox.fs.stat(childUnixPath).catch(() => ({})));
        const size = Number(childStat.size);
        const mtimeMs = Number(childStat.mtimeMs);
        return {
          name,
          path: `mem://${childPath}`,
          type:
            entry.type === "directory"
              ? "directory"
              : entry.type === "file"
                ? "file"
                : "other",
          size: Number.isFinite(size) ? size : null,
          mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
        };
      }),
    );
    results.sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === "directory") return -1;
        if (b.type === "directory") return 1;
      }
      return a.name.localeCompare(b.name);
    });
    return {
      path: resolved.uri,
      exists: true,
      type: "directory",
      entries: results,
    };
  });
}

export function isBrowserUnixRuntimeHint(value: unknown): boolean {
  const text = String(value || "").trim().toLowerCase();
  return text === "sandbox" || text === "browser_unix" || text === "lifo";
}

export async function invokeLifoFrame(frameRaw: JsonRecord): Promise<JsonRecord> {
  const frame = toRecord(frameRaw);
  const tool = String(frame.tool || "").trim().toLowerCase();
  const args = toRecord(frame.args);
  const sessionId = String(frame.sessionId || "default");
  if (!tool) throw new Error("browser unix frame 缺少 tool");

  if (tool === "read") return await readFrame(args, sessionId);
  if (tool === "write") return await writeFrame(args, sessionId);
  if (tool === "edit") return await editFrame(args, sessionId);
  if (tool === "bash") return await bashFrame(args, sessionId);
  if (tool === "stat") return await statFrame(args, sessionId);
  if (tool === "list") return await listFrame(args, sessionId);
  throw new Error(`browser unix frame 不支持 tool: ${tool}`);
}

export async function initLifoAdapter(): Promise<void> {
  await withSessionSandbox("default", async () => undefined);
}

export async function clearVirtualFilesForSession(
  sessionId: string
): Promise<string[]> {
  const storageKeys = [
    buildSessionNamespaceStorageKey(sessionId),
    buildSystemNamespaceStorageKey(sessionId)
  ];
  await enqueueAdapterTask(async () => {
    await sandboxManager.dispose(sessionId, {
      flushDirty: false,
      reason: "session.delete"
    });
    for (const storageKey of storageKeys) {
      await clearPersistedNamespace(storageKey);
    }
    clearSandboxTelemetry(sessionId);
  });
  return storageKeys;
}

export async function clearSessionScopedVirtualFiles(): Promise<string[]> {
  const persistedKeys = (await kvKeys()).filter((key) =>
    String(key || "").startsWith(SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX)
  );
  const liveKeys = sandboxManager.listSessionIds().flatMap((sessionId) => [
    buildSessionNamespaceStorageKey(sessionId),
    buildSystemNamespaceStorageKey(sessionId)
  ]);
  const runtimeKeys = [...namespaceFiles.keys()].filter(
    (key) =>
      String(key || "").startsWith(SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX) ||
      String(key || "").startsWith("ephemeral:")
  );
  const keys = Array.from(new Set([...persistedKeys, ...runtimeKeys, ...liveKeys]));
  await enqueueAdapterTask(async () => {
    await sandboxManager.disposeAll({
      flushDirty: false,
      reason: "storage.reset"
    });
    for (const key of keys) {
      await clearPersistedNamespace(key);
    }
    clearSandboxTelemetry();
  });
  return keys;
}

export async function clearPersistedSessionVirtualFiles(): Promise<string[]> {
  return await clearSessionScopedVirtualFiles();
}

export async function clearAllPersistedVirtualFiles(): Promise<string[]> {
  const keys = (await kvKeys()).filter((key) =>
    String(key || "").startsWith(VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX)
  );
  await enqueueAdapterTask(async () => {
    await sandboxManager.disposeAll({
      flushDirty: false,
      reason: "clear.all"
    });
    for (const key of keys) {
      await clearPersistedNamespace(key);
    }
    namespaceFiles.clear();
    namespaceVersions.clear();
    clearSandboxTelemetry();
  });
  return keys;
}

export async function disposeLifoAdapter(): Promise<void> {
  await enqueueAdapterTask(async () => {
    await sandboxManager.disposeAll({
      flushDirty: true,
      reason: "adapter.dispose"
    });
    namespaceFiles.clear();
    namespaceVersions.clear();
  });
  await adapterQueue.catch(() => undefined);
  adapterQueue = Promise.resolve();
}

export function getLifoDiagnostics(sessionId?: string): JsonRecord {
  const sessionIds = sessionId
    ? [sessionId]
    : Array.from(
        new Set([
          ...sandboxManager.listSessionIds(),
          ...sandboxTelemetrySummaryBySession.keys(),
          ...sandboxTelemetryTailBySession.keys()
        ])
      ).sort((a, b) => a.localeCompare(b));

  const sessions = sessionIds.map((id) => ({
    sessionId: id,
    runtime: sandboxManager.getRuntimeInfo(id),
    summary: {
      ...getTelemetrySummary(id)
    },
    recent: [...(sandboxTelemetryTailBySession.get(id) ?? [])]
  }));

  const totals = sessions.reduce(
    (acc, row) => {
      const summary = row.summary;
      acc.liveSessionCount += row.runtime ? 1 : 0;
      acc.flushCount += Number(summary.flushCount || 0);
      acc.flushSkippedCount += Number(summary.flushSkippedCount || 0);
      acc.forcedFlushCount += Number(summary.forcedFlushCount || 0);
      acc.commandCount += Number(summary.commandCount || 0);
      acc.commandTimeoutCount += Number(summary.commandTimeoutCount || 0);
      return acc;
    },
    {
      trackedSessionCount: sessions.length,
      liveSessionCount: 0,
      flushCount: 0,
      flushSkippedCount: 0,
      forcedFlushCount: 0,
      commandCount: 0,
      commandTimeoutCount: 0
    }
  );

  return {
    schemaVersion: "bbl.sandbox-runtime.v1",
    session: sessionId ? sessions[0] ?? null : null,
    sessions: sessionId ? undefined : sessions,
    totals
  };
}

export async function resetLifoAdapterForTest(): Promise<void> {
  await disposeLifoAdapter();
  await clearAllPersistedVirtualFiles();
}
