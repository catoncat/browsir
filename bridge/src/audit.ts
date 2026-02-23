import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditRecord {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  sessionId?: string;
  parentSessionId?: string;
  agentId?: string;
  id?: string;
  data?: Record<string, unknown>;
}

function summarizeObject(input: unknown, maxText = 600): unknown {
  if (typeof input === "string") {
    if (input.length <= maxText) return input;
    return `${input.slice(0, maxText)}…<truncated:${input.length}>`;
  }

  if (Array.isArray(input)) {
    return input.slice(0, 20).map((x) => summarizeObject(x, maxText));
  }

  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>).slice(0, 30)) {
      out[key] = summarizeObject(value, maxText);
    }
    return out;
  }

  return input;
}

export class AuditLogger {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async log(record: AuditRecord): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const line = JSON.stringify({
      ...record,
      data: summarizeObject(record.data),
    });

    await appendFile(this.filePath, `${line}\n`, "utf8");
  }
}
