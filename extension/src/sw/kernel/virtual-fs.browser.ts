import { getDB, kvGet, kvSet } from "./idb-storage";

type JsonRecord = Record<string, unknown>;

const VFS_KEY_PREFIX = "vfs:file:";
const MAX_VFS_READ_BYTES = 512 * 1024;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeRuntimeHint(value: unknown): "browser" | "local" | undefined {
  const text = String(value || "").trim().toLowerCase();
  if (text === "browser") return "browser";
  if (text === "local") return "local";
  return undefined;
}

function parseVirtualUri(input: unknown, defaultScheme: "mem" | "vfs" = "mem"): {
  uri: string;
  scheme: "mem" | "vfs";
  path: string;
} {
  let text = String(input || "").trim();
  if (!text || text === "." || text === "/") {
    text = `${defaultScheme}://`;
  }

  const direct = /^(mem|vfs):\/\/(.*)$/i.exec(text);
  let scheme: "mem" | "vfs" = defaultScheme;
  let rest = "";
  if (direct) {
    scheme = String(direct[1] || "").toLowerCase() === "vfs" ? "vfs" : "mem";
    rest = String(direct[2] || "");
  } else {
    rest = text;
  }

  rest = rest.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (rest.length > 1) {
    rest = rest.replace(/\/+$/, "");
  }
  const uri = `${scheme}://${rest}`;
  return {
    uri,
    scheme,
    path: rest
  };
}

export function isVirtualUri(input: unknown): boolean {
  return /^(mem|vfs):\/\//i.test(String(input || "").trim());
}

function uriToKey(uri: string): string {
  return `${VFS_KEY_PREFIX}${uri}`;
}

async function listVirtualUrisByScheme(scheme: "mem" | "vfs"): Promise<string[]> {
  const db = await getDB();
  const keys = await db.getAllKeys("kv");
  const prefix = `${VFS_KEY_PREFIX}${scheme}://`;
  const out: string[] = [];
  for (const key of keys) {
    const text = String(key || "");
    if (!text.startsWith(prefix)) continue;
    out.push(text.slice(VFS_KEY_PREFIX.length));
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function readVirtualFile(uriInput: unknown, options: { offset?: unknown; limit?: unknown } = {}): Promise<JsonRecord> {
  const parsed = parseVirtualUri(uriInput);
  const value = await kvGet(uriToKey(parsed.uri));
  if (typeof value !== "string") {
    throw new Error(`virtual file not found: ${parsed.uri}`);
  }

  const offset = Math.max(0, toInt(options.offset, 0));
  const limit = Math.max(1, Math.min(MAX_VFS_READ_BYTES, toInt(options.limit, MAX_VFS_READ_BYTES)));
  const size = new TextEncoder().encode(value).length;
  if (offset >= size) {
    return {
      path: parsed.uri,
      offset,
      limit,
      size,
      truncated: false,
      content: ""
    };
  }

  const sliced = value.slice(offset, offset + limit);
  const bytesRead = new TextEncoder().encode(sliced).length;
  return {
    path: parsed.uri,
    offset,
    limit,
    size,
    truncated: offset + bytesRead < size,
    content: sliced
  };
}

async function writeVirtualFile(args: JsonRecord): Promise<JsonRecord> {
  const parsed = parseVirtualUri(args.path);
  const content = String(args.content || "");
  const modeRaw = String(args.mode || "overwrite").trim();
  const mode = modeRaw === "append" || modeRaw === "create" ? modeRaw : "overwrite";
  const key = uriToKey(parsed.uri);
  const current = await kvGet(key);
  const existed = typeof current === "string";
  if (mode === "create" && existed) {
    throw new Error(`virtual file already exists: ${parsed.uri}`);
  }
  const nextContent = mode === "append" ? `${existed ? String(current) : ""}${content}` : content;
  await kvSet(key, nextContent);
  return {
    path: parsed.uri,
    mode,
    bytesWritten: new TextEncoder().encode(content).length
  };
}

function applyFindReplace(input: string, edit: JsonRecord): { content: string; replacements: number } {
  const find = String(edit.find || "");
  const replace = String(edit.new ?? edit.replace ?? "");
  if (!find) {
    throw new Error("edit.find 不能为空");
  }
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

async function editVirtualFile(args: JsonRecord): Promise<JsonRecord> {
  const parsed = parseVirtualUri(args.path);
  const key = uriToKey(parsed.uri);
  const original = await kvGet(key);
  if (typeof original !== "string") {
    throw new Error(`virtual file not found: ${parsed.uri}`);
  }

  const editsRaw = Array.isArray(args.edits) ? args.edits : [args.edits];
  let next = original;
  let replacements = 0;
  let hunks = 0;
  for (const row of editsRaw) {
    const edit = toRecord(row);
    if (typeof edit.patch === "string" || String(edit.kind || "") === "unified_patch") {
      throw new Error("virtual fs 暂不支持 unified_patch");
    }
    const applied = applyFindReplace(next, edit);
    next = applied.content;
    replacements += applied.replacements;
    hunks += 1;
  }
  if (next === original) {
    throw new Error("No changes produced by edits");
  }
  await kvSet(key, next);
  return {
    path: parsed.uri,
    applied: true,
    hunks,
    replacements
  };
}

function toWildcardRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

async function runVirtualBash(args: JsonRecord): Promise<JsonRecord> {
  const cmdId = String(args.cmdId || "").trim();
  if (cmdId !== "bash.exec") {
    throw new Error(`virtual bash 仅支持 cmdId=bash.exec，收到: ${cmdId || "<empty>"}`);
  }
  const argv = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
  const command = String(argv[0] || "").trim();
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) || [];
  const name = String(tokens[0] || "");
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    if (!name || name === "true") {
      stdout = "";
    } else if (name === "pwd") {
      const cwd = parseVirtualUri(args.cwd || "mem://").uri;
      stdout = `${cwd}\n`;
    } else if (name === "echo") {
      stdout = `${tokens.slice(1).join(" ")}\n`;
    } else if (name === "cat") {
      const targets = tokens.slice(1);
      if (!targets.length) throw new Error("cat 需要路径参数");
      const chunks: string[] = [];
      for (const target of targets) {
        const read = await readVirtualFile(target);
        chunks.push(String(read.content || ""));
      }
      stdout = chunks.join("\n");
      if (stdout && !stdout.endsWith("\n")) stdout += "\n";
    } else if (name === "ls") {
      const root = parseVirtualUri(tokens[1] || "mem://");
      const files = await listVirtualUrisByScheme(root.scheme);
      const prefix = root.path ? `${root.scheme}://${root.path}/` : `${root.scheme}://`;
      const names = new Set<string>();
      for (const file of files) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (!rest) continue;
        const head = rest.split("/")[0] || "";
        if (!head) continue;
        names.add(head);
      }
      stdout = `${Array.from(names).sort((a, b) => a.localeCompare(b)).join("\n")}${names.size ? "\n" : ""}`;
    } else if (name === "find") {
      const root = parseVirtualUri(tokens[1] || "mem://");
      const files = await listVirtualUrisByScheme(root.scheme);
      const basePrefix = root.path ? `${root.scheme}://${root.path}/` : `${root.scheme}://`;
      const nameArgIdx = tokens.findIndex((item) => item === "-name");
      const pattern = nameArgIdx >= 0 ? String(tokens[nameArgIdx + 1] || "*") : "*";
      const regex = toWildcardRegex(pattern);
      const filtered = files.filter((file) => file.startsWith(basePrefix) && regex.test(file.split("/").pop() || ""));
      stdout = `${filtered.join("\n")}${filtered.length ? "\n" : ""}`;
    } else {
      throw new Error(`virtual bash 不支持命令: ${name}`);
    }
  } catch (error) {
    exitCode = 1;
    stderr = `${error instanceof Error ? error.message : String(error)}\n`;
  }

  const stdoutBytes = new TextEncoder().encode(stdout).length;
  const stderrBytes = new TextEncoder().encode(stderr).length;
  return {
    cmdId: "bash.exec",
    argv: ["bash", "-lc", command],
    risk: "high",
    cwd: parseVirtualUri(args.cwd || "mem://").uri,
    exitCode,
    stdout,
    stderr,
    stdoutBytes,
    stderrBytes,
    bytesOut: stdoutBytes + stderrBytes,
    durationMs: Date.now() - startedAt,
    truncated: false,
    timeoutHit: false
  };
}

function frameToolName(frame: JsonRecord): string {
  return String(frame.tool || "").trim().toLowerCase();
}

function frameArgs(frame: JsonRecord): JsonRecord {
  return toRecord(frame.args);
}

export function shouldRouteFrameToBrowserVfs(frame: JsonRecord): boolean {
  const tool = frameToolName(frame);
  const args = frameArgs(frame);
  const runtime = normalizeRuntimeHint(args.runtime);

  if (runtime === "browser") return true;
  if (runtime === "local") return false;

  if (tool === "read" || tool === "write" || tool === "edit") {
    return isVirtualUri(args.path);
  }

  if (tool === "bash") {
    const cmdId = String(args.cmdId || "").trim();
    const argv = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
    const command = String(argv[0] || "").trim();
    if (cmdId !== "bash.exec") return false;
    return /(?:mem|vfs):\/\//i.test(command);
  }

  return false;
}

export function frameMatchesVirtualCapability(frame: JsonRecord, capability: string): boolean {
  const tool = frameToolName(frame);
  if (capability === "fs.read") return tool === "read";
  if (capability === "fs.write") return tool === "write";
  if (capability === "fs.edit") return tool === "edit";
  if (capability === "process.exec") return tool === "bash";
  return false;
}

export async function invokeVirtualFrame(frameRaw: JsonRecord): Promise<JsonRecord> {
  const frame = toRecord(frameRaw);
  const tool = frameToolName(frame);
  const args = frameArgs(frame);
  if (!tool) {
    throw new Error("virtual frame 缺少 tool");
  }

  if (tool === "read") {
    return await readVirtualFile(args.path, { offset: args.offset, limit: args.limit });
  }
  if (tool === "write") {
    return await writeVirtualFile(args);
  }
  if (tool === "edit") {
    return await editVirtualFile(args);
  }
  if (tool === "bash") {
    return await runVirtualBash(args);
  }
  throw new Error(`virtual frame 不支持 tool: ${tool}`);
}

