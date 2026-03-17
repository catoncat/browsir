import net from "node:net";
import path from "node:path";
import { BRIDGE_HOST, ROOT_DIR, LIVE_EVIDENCE_PATH, DEFAULT_EVIDENCE_PATH } from "./constants";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function pushLog(buffer: string[], chunk: Buffer | string, maxLines = 220): void {
  const text = String(chunk || "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  buffer.push(...lines);
  if (buffer.length > maxLines) {
    buffer.splice(0, buffer.length - maxLines);
  }
}

export function resolveEvidencePath(useLiveSuite: boolean): string {
  const customPath = String(process.env.BRAIN_E2E_EVIDENCE_PATH || "").trim();
  if (customPath) {
    return path.isAbsolute(customPath) ? customPath : path.join(ROOT_DIR, customPath);
  }
  return useLiveSuite ? LIVE_EVIDENCE_PATH : DEFAULT_EVIDENCE_PATH;
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${url}: ${body.slice(0, 260)}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
  intervalMs = 220
): Promise<T> {
  const started = Date.now();
  let lastError: string | null = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value !== null && value !== undefined && value !== false) {
        return value as T;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(intervalMs);
  }

  throw new Error(`wait timeout: ${label}${lastError ? `; last=${lastError}` : ""}`);
}

export async function canListen(port: number, host = BRIDGE_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 800; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) return port;
  }
  throw new Error(`找不到空闲端口，起始端口=${start}`);
}
