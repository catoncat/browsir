import type { BrainOrchestrator } from "../orchestrator.browser";
import {
  syncConfiguredMcpServers,
} from "../mcp-tool-materializer";
import type { RuntimeInfraHandler } from "../runtime-infra.browser";

type RuntimeOk<T = unknown> = { ok: true; data: T };
type RuntimeErr = { ok: false; error: string };
type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

function ok<T>(data: T): RuntimeOk<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeErr {
  return { ok: false, error };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export async function handleBrainMcp(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action !== "brain.mcp.sync-config") {
    return fail(`unsupported mcp action: ${action}`);
  }

  const configResult = await infra.handleMessage({ type: "config.get" });
  if (!configResult || configResult.ok !== true) {
    return fail("config.get failed");
  }

  try {
    const synced = await syncConfiguredMcpServers({
      orchestrator,
      infra,
      servers: toRecord(configResult.data).mcpServers,
      refresh: payload.refresh === true,
    });
    if (synced.failures.length > 0) {
      const first = synced.failures[0];
      return fail(
        `MCP 同步失败：${first.serverId}${
          first.message ? ` · ${first.message}` : ""
        }`,
      );
    }
    return ok(synced);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
