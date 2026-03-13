import crypto from "node:crypto";

export function summarizeInvokeMetrics(tool: string, result: Record<string, unknown> | null, durationMs: number) {
  const base: Record<string, unknown> = {
    tool,
    durationMs,
  };

  if (!result) return base;

  if (tool === "bash") {
    base.exitCode = result.exitCode;
    base.bytesOut = result.bytesOut;
    base.stdoutBytes = result.stdoutBytes;
    base.stderrBytes = result.stderrBytes;
    base.truncated = result.truncated;
    base.timeoutHit = result.timeoutHit;
    base.cmdId = result.cmdId;
    base.risk = result.risk;
    return base;
  }

  if (tool === "read") {
    base.size = result.size;
    base.limit = result.limit;
    base.truncated = result.truncated;
    return base;
  }

  if (tool === "write") {
    base.mode = result.mode;
    base.bytesWritten = result.bytesWritten;
    return base;
  }

  if (tool === "edit") {
    base.hunks = result.hunks;
    base.replacements = result.replacements;
    return base;
  }

  if (tool === "stat") {
    base.exists = result.exists;
    base.type = result.type;
    base.size = result.size;
    return base;
  }

  if (tool === "list") {
    base.exists = result.exists;
    base.type = result.type;
    base.entryCount = Array.isArray(result.entries) ? result.entries.length : 0;
    return base;
  }

  return base;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function buildInvokeFingerprint(canonicalTool: string, args: Record<string, unknown>): string {
  const payload = `${canonicalTool}:${stableStringify(args)}`;
  return crypto.createHash("sha1").update(payload).digest("hex");
}

export function estimatePayloadBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}
