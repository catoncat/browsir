import { BridgeError } from "./errors";
import type { BridgeConfig } from "./config";
import type { FsGuard } from "./fs-guard";
import type { InvokeRequest } from "./types";
import { runRead } from "./tools/read";
import { runWrite } from "./tools/write";
import { runEdit } from "./tools/edit";
import { runBash } from "./tools/bash";

export interface DispatchContext {
  config: BridgeConfig;
  fsGuard: FsGuard;
}

export async function dispatchInvoke(
  req: InvokeRequest,
  ctx: DispatchContext,
  onBashChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<Record<string, unknown>> {
  switch (req.tool) {
    case "read":
      return (await runRead(req.args, ctx.fsGuard, ctx.config.maxReadBytes)) as unknown as Record<string, unknown>;
    case "write":
      return (await runWrite(req.args, ctx.fsGuard)) as unknown as Record<string, unknown>;
    case "edit":
      return (await runEdit(req.args, ctx.fsGuard)) as unknown as Record<string, unknown>;
    case "bash":
      return (await runBash(
        req.args,
        ctx.fsGuard,
        ctx.config.mode === "strict",
        ctx.config.enableBashExec,
        ctx.config.defaultTimeoutMs,
        ctx.config.maxTimeoutMs,
        ctx.config.maxOutputBytes,
        onBashChunk,
      )) as unknown as Record<string, unknown>;
    default:
      throw new BridgeError("E_TOOL", "Unknown tool", { tool: req.tool });
  }
}
