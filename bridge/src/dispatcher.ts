import { BridgeError } from "./errors";
import type { BridgeConfig } from "./config";
import type { FsGuard } from "./fs-guard";
import type { InvokeRequest } from "./types";
import { resolveToolName } from "./tool-registry";
import { runRead } from "./tools/read";
import { runWrite } from "./tools/write";
import { runEdit } from "./tools/edit";
import { runBash } from "./tools/bash";

export interface DispatchContext {
  config: BridgeConfig;
  fsGuard: FsGuard;
}

export type InvokeToolHandler = (
  req: InvokeRequest,
  ctx: DispatchContext,
  onBashChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
) => Promise<Record<string, unknown>>;

export interface RegisterInvokeToolHandlerOptions {
  replace?: boolean;
}

const BUILTIN_TOOL_HANDLERS: Record<string, InvokeToolHandler> = {
  read: async (req, ctx) => (await runRead(req.args, ctx.fsGuard, ctx.config.maxReadBytes)) as unknown as Record<string, unknown>,
  write: async (req, ctx) => (await runWrite(req.args, ctx.fsGuard)) as unknown as Record<string, unknown>,
  edit: async (req, ctx) => (await runEdit(req.args, ctx.fsGuard)) as unknown as Record<string, unknown>,
  bash: async (req, ctx, onBashChunk) =>
    (await runBash(
      req.args,
      ctx.fsGuard,
      ctx.config.mode === "strict",
      ctx.config.enableBashExec,
      ctx.config.defaultTimeoutMs,
      ctx.config.maxTimeoutMs,
      ctx.config.maxOutputBytes,
      onBashChunk,
    )) as unknown as Record<string, unknown>,
};
const overrideToolHandlers = new Map<string, InvokeToolHandler>();

export function registerInvokeToolHandler(
  canonicalTool: string,
  handler: InvokeToolHandler,
  options: RegisterInvokeToolHandlerOptions = {},
): void {
  const name = String(canonicalTool || "").trim();
  if (!name) throw new Error("canonicalTool 不能为空");
  const exists = overrideToolHandlers.has(name) || Boolean(BUILTIN_TOOL_HANDLERS[name]);
  if (exists && !options.replace) {
    throw new Error(`invoke handler already registered: ${name}`);
  }
  overrideToolHandlers.set(name, handler);
}

export function unregisterInvokeToolHandler(canonicalTool: string): boolean {
  const name = String(canonicalTool || "").trim();
  if (!name) return false;
  return overrideToolHandlers.delete(name);
}

export function listInvokeToolHandlers(): Array<{ canonicalTool: string; source: "builtin" | "override" }> {
  const out: Array<{ canonicalTool: string; source: "builtin" | "override" }> = [];
  const names = new Set<string>([...Object.keys(BUILTIN_TOOL_HANDLERS), ...Array.from(overrideToolHandlers.keys())]);
  for (const name of names) {
    out.push({
      canonicalTool: name,
      source: overrideToolHandlers.has(name) ? "override" : "builtin"
    });
  }
  return out;
}

export async function dispatchInvoke(
  req: InvokeRequest,
  ctx: DispatchContext,
  onBashChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<Record<string, unknown>> {
  const canonicalTool = String(req.canonicalTool || resolveToolName(req.tool) || "").trim();
  const handler = overrideToolHandlers.get(canonicalTool) || BUILTIN_TOOL_HANDLERS[canonicalTool];
  if (!handler) {
    throw new BridgeError("E_TOOL", "Unknown tool", { tool: req.tool, canonicalTool });
  }
  return await handler(
    {
      ...req,
      canonicalTool,
    },
    ctx,
    onBashChunk,
  );
}
