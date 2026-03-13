import { randomId } from "../types";
import { invokeVirtualFrame } from "../virtual-fs.browser";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function normalizeSessionId(sessionId: unknown): string {
  return String(sessionId || "").trim() || "default";
}

function normalizeVirtualPath(input: unknown): string {
  let text = String(input || "").trim();
  if (!text || text === "." || text === "/") {
    text = "mem://";
  }
  const direct = /^mem:\/\/(.*)$/i.exec(text);
  const mounted = /^\/mem(?:\/(.*))?$/i.exec(text);
  let rest = "";
  if (direct) {
    rest = String(direct[1] || "");
  } else if (mounted) {
    rest = String(mounted[1] || "");
  } else {
    rest = text;
  }
  rest = rest.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (rest.length > 1) {
    rest = rest.replace(/\/+$/g, "");
  }
  return `mem://${rest}`;
}

function quoteShellArg(input: string): string {
  return `'${String(input || "").replace(/'/g, `'\"'\"'`)}'`;
}

function dirname(path: string): string {
  const normalized = normalizeVirtualPath(path);
  const rest = normalized.slice("mem://".length);
  if (!rest) return "mem://";
  const idx = rest.lastIndexOf("/");
  if (idx < 0) return "mem://";
  const parent = rest.slice(0, idx);
  return parent ? `mem://${parent}` : "mem://";
}

async function runVirtualBash(
  command: string,
  sessionId: string,
): Promise<void> {
  const result = await invokeVirtualFrame({
    sessionId,
    tool: "bash",
    args: {
      cmdId: "bash.exec",
      runtime: "sandbox",
      args: [command],
    },
  });
  const row = toRecord(result);
  const exitCode = Number(row.exitCode);
  if (Number.isFinite(exitCode) && exitCode === 0) return;
  throw new Error(
    String(row.stderr || row.stdout || `virtual bash failed: ${command}`).trim(),
  );
}

export async function statVirtualPath(
  path: string,
  sessionId: string,
): Promise<{ exists: boolean; type: string }> {
  const result = await invokeVirtualFrame({
    sessionId: normalizeSessionId(sessionId),
    tool: "stat",
    args: {
      path: normalizeVirtualPath(path),
      runtime: "sandbox",
    },
  });
  const row = toRecord(result);
  return {
    exists: row.exists === true,
    type: String(row.type || "missing"),
  };
}

export async function removeVirtualPathRecursively(
  path: string,
  sessionId: string,
): Promise<void> {
  await runVirtualBash(
    `rm -rf ${quoteShellArg(normalizeVirtualPath(path))}`,
    normalizeSessionId(sessionId),
  );
}

export async function moveVirtualPath(
  fromPath: string,
  toPath: string,
  sessionId: string,
): Promise<void> {
  const source = normalizeVirtualPath(fromPath);
  const target = normalizeVirtualPath(toPath);
  const parent = dirname(target);
  await runVirtualBash(
    `mkdir -p ${quoteShellArg(parent)} && rm -rf ${quoteShellArg(target)} && mv ${quoteShellArg(source)} ${quoteShellArg(target)}`,
    normalizeSessionId(sessionId),
  );
}

export function createVirtualStagingPath(
  root: string,
  prefix: string,
): string {
  const normalizedRoot = normalizeVirtualPath(root);
  const rest = normalizedRoot.slice("mem://".length);
  const stagingRoot = rest ? `mem://${rest}/.__staging__` : "mem://.__staging__";
  return `${stagingRoot}/${randomId(prefix)}`;
}
