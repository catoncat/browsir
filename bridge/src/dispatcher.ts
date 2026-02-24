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

type InvokeToolHandler = (
  req: InvokeRequest,
  ctx: DispatchContext,
  onBashChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
) => Promise<Record<string, unknown>>;

const TOOL_HANDLERS: Record<string, InvokeToolHandler> = {
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

export async function dispatchInvoke(
  req: InvokeRequest,
  ctx: DispatchContext,
  onBashChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<Record<string, unknown>> {
  const canonicalTool = String(req.canonicalTool || resolveToolName(req.tool) || "").trim();
  const handler = TOOL_HANDLERS[canonicalTool];
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
