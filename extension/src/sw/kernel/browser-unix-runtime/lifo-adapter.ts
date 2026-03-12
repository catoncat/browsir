import { Sandbox } from "@lifo-sh/core";
import { kvGet, kvKeys, kvRemove, kvSet } from "../idb-storage";

type JsonRecord = Record<string, unknown>;
type NamespaceScope = "ephemeral" | "global" | "session";

interface VirtualNamespaceDescriptor {
  key: string;
  scope: NamespaceScope;
  unixRoot: string;
}

const MAX_READ_BYTES = 512 * 1024;
const SESSION_ROOT = "/sessions";
const GLOBAL_ROOT = "/globals";
const DEFAULT_SESSION_ID = "default";
export const VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX = "virtualfs:namespace:";
export const SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX =
  `${VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX}session:`;
const GLOBAL_SKILLS_NAMESPACE_KEY =
  `${VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX}global:skills`;
const GLOBAL_PLUGINS_NAMESPACE_KEY =
  `${VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX}global:plugins`;

const namespaceFiles = new Map<string, Map<string, Uint8Array>>();
let adapterQueue: Promise<void> = Promise.resolve();

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeSessionSegment(raw: unknown): string {
  const text = String(raw || "").trim();
  const source = text || "default";
  return source.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toNamespaceStorageKey(input: unknown): string {
  return String(input || "").trim();
}

function parseVirtualUri(
  input: unknown,
  defaultScheme: "mem" = "mem"
): { uri: string; scheme: "mem"; path: string } {
  let text = String(input || "").trim();
  if (!text || text === "." || text === "/") {
    text = `${defaultScheme}://`;
  }

  if (/^vfs:\/\//i.test(text)) {
    throw new Error("browser unix sandbox 仅支持 mem:// 路径");
  }

  const direct = /^mem:\/\/(.*)$/i.exec(text);
  let rest = "";
  if (direct) {
    rest = String(direct[1] || "");
  } else {
    rest = text;
  }

  rest = rest.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (rest.length > 1) rest = rest.replace(/\/+$/, "");
  return {
    uri: `mem://${rest}`,
    scheme: "mem",
    path: rest
  };
}

function normalizeRelativePath(path: string): string {
  const segments = String(path || "")
    .split("/")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) {
        throw new Error("virtual path 越界：不允许访问 session 根目录之外");
      }
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/");
}

function buildSessionNamespaceStorageKey(sessionId: string): string {
  return `${SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX}${normalizeSessionSegment(
    sessionId || DEFAULT_SESSION_ID
  )}`;
}

function sessionUnixRoot(sessionId: string): string {
  return `${SESSION_ROOT}/${normalizeSessionSegment(sessionId)}/mem`;
}

function systemUnixRoot(sessionId: string): string {
  return `${SESSION_ROOT}/${normalizeSessionSegment(sessionId)}/__bbl`;
}

function createSessionNamespace(sessionId: string): VirtualNamespaceDescriptor {
  return {
    key: buildSessionNamespaceStorageKey(sessionId),
    scope: "session",
    unixRoot: sessionUnixRoot(sessionId)
  };
}

function createSkillsNamespace(): VirtualNamespaceDescriptor {
  return {
    key: GLOBAL_SKILLS_NAMESPACE_KEY,
    scope: "global",
    unixRoot: `${GLOBAL_ROOT}/skills/mem`
  };
}

function createPluginsNamespace(): VirtualNamespaceDescriptor {
  return {
    key: GLOBAL_PLUGINS_NAMESPACE_KEY,
    scope: "global",
    unixRoot: `${GLOBAL_ROOT}/plugins/mem`
  };
}

function createSystemNamespace(sessionId: string): VirtualNamespaceDescriptor {
  return {
    key: `ephemeral:${normalizeSessionSegment(sessionId)}:__bbl`,
    scope: "ephemeral",
    unixRoot: systemUnixRoot(sessionId)
  };
}

function listNamespaceDescriptors(sessionId: string): VirtualNamespaceDescriptor[] {
  return [
    createSessionNamespace(sessionId),
    createSkillsNamespace(),
    createPluginsNamespace(),
    createSystemNamespace(sessionId)
  ];
}

function resolveVirtualPath(input: unknown, sessionId: string): {
  uri: string;
  scheme: "mem";
  path: string;
  unixPath: string;
  relativePath: string;
  namespace: VirtualNamespaceDescriptor;
} {
  const parsed = parseVirtualUri(input);
  const rawSegments = String(parsed.path || "")
    .split("/")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const firstSegment = rawSegments[0] || "";
  let namespace = createSessionNamespace(sessionId);
  let relativeSource = parsed.path;
  let normalizedPath = normalizeRelativePath(parsed.path);
  if (firstSegment === "skills") {
    namespace = createSkillsNamespace();
    relativeSource = rawSegments.slice(1).join("/");
    normalizedPath = [firstSegment, normalizeRelativePath(relativeSource)]
      .filter(Boolean)
      .join("/");
  } else if (firstSegment === "plugins") {
    namespace = createPluginsNamespace();
    relativeSource = rawSegments.slice(1).join("/");
    normalizedPath = [firstSegment, normalizeRelativePath(relativeSource)]
      .filter(Boolean)
      .join("/");
  } else if (firstSegment === "__bbl") {
    namespace = createSystemNamespace(sessionId);
    relativeSource = rawSegments.slice(1).join("/");
    normalizedPath = [firstSegment, normalizeRelativePath(relativeSource)]
      .filter(Boolean)
      .join("/");
  }
  const relativePath = normalizeRelativePath(relativeSource);
  const unixPath = relativePath
    ? `${namespace.unixRoot}/${relativePath}`
    : namespace.unixRoot;
  return {
    ...parsed,
    uri: `mem://${normalizedPath}`,
    path: normalizedPath,
    unixPath,
    relativePath,
    namespace
  };
}

function dirname(path: string): string {
  const normalized = String(path || "").replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
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
    if (descriptor.scope === "ephemeral") continue;
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

async function captureNamespaceFiles(
  descriptors: VirtualNamespaceDescriptor[],
  sandbox: Sandbox
): Promise<void> {
  for (const descriptor of descriptors) {
    if (descriptor.scope === "ephemeral") continue;
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
      }
    };

    await walk(root);
    namespaceFiles.set(descriptor.key, next);
    await persistNamespaceFiles(descriptor.key, next);
  }
}

async function withSessionSandbox<T>(sessionId: string, task: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  return await enqueueAdapterTask(async () => {
    const sandbox = await Sandbox.create({
      // Non-persistent sandbox per invocation: mirrors host_bash one-command-one-shell behavior.
      persist: false
    });
    try {
      const descriptors = await ensureNamespaceRoots(sessionId, sandbox);
      await restoreNamespaceFiles(descriptors, sandbox);
      const result = await task(sandbox);
      await captureNamespaceFiles(descriptors, sandbox);
      return result;
    } finally {
      sandbox.destroy();
    }
  });
}

function rewriteCommandVirtualUris(command: string, sessionId: string): string {
  return command.replace(/\bmem:\/\/[^\s'"`|;&]*/gi, (raw) => {
    return resolveVirtualPath(raw, sessionId).unixPath;
  });
}

async function readFrame(args: JsonRecord, sessionId: string): Promise<JsonRecord> {
  return await withSessionSandbox(sessionId, async (sandbox) => {
    const resolved = resolveVirtualPath(args.path, sessionId);

    const fullBytes = (await sandbox.fs.readFile(resolved.unixPath, null as null)) as Uint8Array;
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
    const cwdResolved = resolveVirtualPath(args.cwd || "mem://", sessionId);
    const timeoutMs = args.timeoutMs == null ? undefined : Math.max(1000, toInt(args.timeoutMs, 120_000));
    const startedAt = Date.now();

    const result = await sandbox.commands.run(command, {
      cwd: cwdResolved.unixPath,
      timeout: timeoutMs
    });

    const stdout = String(result.stdout || "");
    const stderr = String(result.stderr || "");
    const stdoutBytes = encodeUtf8(stdout).byteLength;
    const stderrBytes = encodeUtf8(stderr).byteLength;

    return {
      cmdId: "bash.exec",
      argv: ["bash", "-lc", rawCommand],
      risk: "high",
      cwd: cwdResolved.uri,
      exitCode: Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : 1,
      stdout,
      stderr,
      stdoutBytes,
      stderrBytes,
      bytesOut: stdoutBytes + stderrBytes,
      durationMs: Date.now() - startedAt,
      truncated: false,
      timeoutHit: false
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
  throw new Error(`browser unix frame 不支持 tool: ${tool}`);
}

export async function initLifoAdapter(): Promise<void> {
  await withSessionSandbox(DEFAULT_SESSION_ID, async () => undefined);
}

export async function clearVirtualFilesForSession(
  sessionId: string
): Promise<string[]> {
  const storageKey = buildSessionNamespaceStorageKey(sessionId);
  await enqueueAdapterTask(async () => {
    await clearPersistedNamespace(storageKey);
  });
  return [storageKey];
}

export async function clearPersistedSessionVirtualFiles(): Promise<string[]> {
  const keys = (await kvKeys()).filter((key) =>
    String(key || "").startsWith(SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX)
  );
  await enqueueAdapterTask(async () => {
    for (const key of keys) {
      await clearPersistedNamespace(key);
    }
  });
  return keys;
}

export async function clearAllPersistedVirtualFiles(): Promise<string[]> {
  const keys = (await kvKeys()).filter((key) =>
    String(key || "").startsWith(VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX)
  );
  await enqueueAdapterTask(async () => {
    for (const key of keys) {
      await clearPersistedNamespace(key);
    }
  });
  return keys;
}

export async function disposeLifoAdapter(): Promise<void> {
  namespaceFiles.clear();
  await adapterQueue.catch(() => undefined);
  adapterQueue = Promise.resolve();
}

export async function resetLifoAdapterForTest(): Promise<void> {
  await disposeLifoAdapter();
  await clearAllPersistedVirtualFiles();
}
