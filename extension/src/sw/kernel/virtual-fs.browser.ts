import { invokeLifoFrame, isBrowserUnixRuntimeHint } from "./browser-unix-runtime/lifo-adapter";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function normalizeRuntimeHint(value: unknown): "browser" | "local" | "sandbox" | undefined {
  const text = String(value || "").trim().toLowerCase();
  if (text === "browser") return "browser";
  if (text === "host") return "local";
  if (text === "local") return "local";
  if (isBrowserUnixRuntimeHint(text)) return "sandbox";
  return undefined;
}

function normalizeMemUri(input: unknown): { uri: string; path: string } {
  let text = String(input || "").trim();
  if (!text || text === "." || text === "/") {
    text = "mem://";
  }

  if (/^vfs:\/\//i.test(text)) {
    throw new Error("virtual fs 仅支持 mem:// 路径");
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

  return {
    uri: `mem://${rest}`,
    path: rest
  };
}

function normalizeFrameArgsForLifo(frame: JsonRecord): JsonRecord {
  const args = toRecord(frame.args);
  const nextArgs: JsonRecord = {
    ...args,
    runtime: "sandbox"
  };

  const tool = String(frame.tool || "").trim().toLowerCase();
  if (
    tool === "read" ||
    tool === "write" ||
    tool === "edit" ||
    tool === "stat" ||
    tool === "list"
  ) {
    nextArgs.path = normalizeMemUri(args.path).uri;
    return nextArgs;
  }

  if (tool === "bash") {
    const argv = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
    const command = String(argv[0] || "").trim();
    if (/vfs:\/\//i.test(command)) {
      throw new Error("virtual fs 仅支持 mem:// 路径");
    }
    return nextArgs;
  }

  return nextArgs;
}

function frameToolName(frame: JsonRecord): string {
  return String(frame.tool || "").trim().toLowerCase();
}

function frameArgs(frame: JsonRecord): JsonRecord {
  return toRecord(frame.args);
}

export function isVirtualUri(input: unknown): boolean {
  return /^mem:\/\//i.test(String(input || "").trim());
}

function isVirtualMountPath(input: unknown): boolean {
  return /^\/mem(?:\/|$)/i.test(String(input || "").trim());
}

export function shouldRouteFrameToBrowserVfs(frame: JsonRecord): boolean {
  const tool = frameToolName(frame);
  const args = frameArgs(frame);
  const runtime = normalizeRuntimeHint(args.runtime);

  if (runtime === "sandbox") return true;
  if (runtime === "browser") return true;
  if (runtime === "local") return false;

  if (
    tool === "read" ||
    tool === "write" ||
    tool === "edit" ||
    tool === "stat" ||
    tool === "list"
  ) {
    return isVirtualUri(args.path) || isVirtualMountPath(args.path);
  }

  if (tool === "bash") {
    const cmdId = String(args.cmdId || "").trim();
    const argv = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
    const command = String(argv[0] || "").trim();
    if (cmdId !== "bash.exec") return false;
    return (
      /mem:\/\//i.test(command) ||
      /(^|[\s"'`(|;&])\/mem(?:\/|$)/i.test(command)
    );
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
  if (!tool) {
    throw new Error("virtual frame 缺少 tool");
  }

  const runtime = normalizeRuntimeHint(toRecord(frame.args).runtime);
  if (runtime === "local") {
    throw new Error("virtual frame runtime=local 不应路由到 browser virtual runtime");
  }

  if (
    tool !== "read" &&
    tool !== "write" &&
    tool !== "edit" &&
    tool !== "bash" &&
    tool !== "stat" &&
    tool !== "list"
  ) {
    throw new Error(`virtual frame 不支持 tool: ${tool}`);
  }

  return await invokeLifoFrame({
    ...frame,
    args: normalizeFrameArgsForLifo(frame)
  });
}
