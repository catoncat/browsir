import { BridgeError } from "./errors";
import type { InvokeRequest, ToolName } from "./types";
import { resolveToolName } from "./tool-registry";

export function parseInvokeFrame(raw: string | Buffer): InvokeRequest {
  let value: unknown;
  try {
    value = JSON.parse(String(raw));
  } catch {
    throw new BridgeError("E_ARGS", "Invalid JSON frame");
  }

  if (!value || typeof value !== "object") {
    throw new BridgeError("E_ARGS", "Frame must be an object");
  }

  const frame = value as Record<string, unknown>;

  if (frame.type !== "invoke") {
    throw new BridgeError("E_ARGS", "Only invoke frame is supported");
  }

  if (typeof frame.id !== "string" || frame.id.length === 0) {
    throw new BridgeError("E_ARGS", "id must be a non-empty string");
  }

  if (typeof frame.tool !== "string") {
    throw new BridgeError("E_TOOL", "Unknown tool", { tool: frame.tool });
  }
  const requestedTool = frame.tool.trim();
  const canonicalTool = resolveToolName(requestedTool);
  if (!canonicalTool) {
    throw new BridgeError("E_TOOL", "Unknown tool", { tool: frame.tool });
  }

  if (!frame.args || typeof frame.args !== "object") {
    throw new BridgeError("E_ARGS", "args must be an object");
  }

  const out: InvokeRequest = {
    id: frame.id,
    type: "invoke",
    tool: requestedTool as ToolName,
    canonicalTool,
    args: frame.args as Record<string, unknown>,
  };

  if (typeof frame.sessionId === "string") out.sessionId = frame.sessionId;
  if (typeof frame.parentSessionId === "string") out.parentSessionId = frame.parentSessionId;
  if (typeof frame.agentId === "string") out.agentId = frame.agentId;

  return out;
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeError("E_ARGS", `${field} must be a non-empty string`);
  }
  return value;
}

export function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new BridgeError("E_ARGS", `${field} must be a string`);
  }
  return value;
}

export function asOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BridgeError("E_ARGS", `${field} must be a number`);
  }
  return value;
}

export function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new BridgeError("E_ARGS", `${field} must be an array of strings`);
  }

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new BridgeError("E_ARGS", `${field} must be an array of strings`);
    }
    out.push(item);
  }

  return out;
}
