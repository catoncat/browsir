import path from "node:path";

export type BridgeMode = "god" | "strict";

export interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  mode: BridgeMode;
  enableBashExec: boolean;
  roots: string[];
  allowOrigins: string[];
  maxOutputBytes: number;
  maxReadBytes: number;
  maxConcurrency: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  auditPath: string;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function parseCsvEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function loadConfig(): BridgeConfig {
  const mode = process.env.BRIDGE_MODE === "strict" ? "strict" : "god";
  const roots = parseCsvEnv("BRIDGE_ROOTS").map((x) => path.resolve(x));
  const now = new Date().toISOString().slice(0, 10);

  return {
    host: process.env.BRIDGE_HOST ?? "127.0.0.1",
    port: parseIntEnv("BRIDGE_PORT", 8787),
    token: process.env.BRIDGE_TOKEN ?? "dev-token-change-me",
    mode,
    enableBashExec: process.env.BRIDGE_ENABLE_BASH_EXEC !== "false",
    roots,
    allowOrigins: parseCsvEnv("BRIDGE_ALLOW_ORIGINS"),
    maxOutputBytes: parseIntEnv("BRIDGE_MAX_OUTPUT_BYTES", 256 * 1024),
    maxReadBytes: parseIntEnv("BRIDGE_MAX_READ_BYTES", 1024 * 1024),
    maxConcurrency: parseIntEnv("BRIDGE_MAX_CONCURRENCY", 6),
    defaultTimeoutMs: parseIntEnv("BRIDGE_DEFAULT_TIMEOUT_MS", 120_000),
    maxTimeoutMs: parseIntEnv("BRIDGE_MAX_TIMEOUT_MS", 300_000),
    auditPath:
      process.env.BRIDGE_AUDIT_PATH ?? path.resolve(process.cwd(), `tmp/browser-bridge/audit-${now}.jsonl`),
  };
}

export function originAllowed(origin: string | undefined, allowOrigins: string[]): boolean {
  if (!origin) return allowOrigins.length === 0;
  if (allowOrigins.length === 0) {
    return origin.startsWith("chrome-extension://") || origin === "http://localhost";
  }

  return allowOrigins.some((pattern) => {
    if (pattern.endsWith("*")) {
      return origin.startsWith(pattern.slice(0, -1));
    }
    return origin === pattern;
  });
}
