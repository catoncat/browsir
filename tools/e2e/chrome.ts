import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { BRIDGE_HOST } from "./constants";
import { fetchJson, sleep } from "./utils";
import type { JsonTarget } from "./types";

// ── Chrome Binary Discovery ──────────────────────────────────

export function resolveChromeBinary(): string {
  const envBin = process.env.CHROME_BIN?.trim();
  const home = os.homedir();
  const cft1208 = path.join(
    home,
    "Library",
    "Caches",
    "ms-playwright",
    "chromium-1208",
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing"
  );
  const cft1200 = path.join(
    home,
    "Library",
    "Caches",
    "ms-playwright",
    "chromium-1200",
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing"
  );
  const candidates = [
    envBin,
    cft1208,
    cft1200,
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  ].filter(Boolean) as string[];

  for (const file of candidates) {
    if (existsSync(file)) return file;
  }

  const byName = Bun.which("google-chrome") || Bun.which("chromium") || Bun.which("chrome");
  if (byName) return byName;

  throw new Error("找不到 Chrome 可执行文件。可设置 CHROME_BIN=/path/to/chrome");
}

// ── Shared Browser WebSocket State ───────────────────────────

let _browserWs: WebSocket | null = null;
let _browserWsTargetIds: string[] = [];

export function getBrowserWs(): WebSocket | null {
  return _browserWs;
}

export function setBrowserWs(ws: WebSocket | null): void {
  _browserWs = ws;
}

export function getBrowserWsTargetIds(): string[] {
  return _browserWsTargetIds;
}

export function resetBrowserWsTargetIds(): void {
  _browserWsTargetIds = [];
}

export function browserWsSend(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!_browserWs || _browserWs.readyState !== WebSocket.OPEN) {
      return reject(new Error("browser WS not connected"));
    }
    const id = Math.floor(Math.random() * 1_000_000_000);
    const timer = setTimeout(() => reject(new Error(`browserWsSend timeout: ${method}`)), 15_000);
    const handler = (e: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.id !== id) return;
      _browserWs!.removeEventListener("message", handler);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    _browserWs!.addEventListener("message", handler);
    _browserWs!.send(JSON.stringify({ id, method, params }));
  });
}

// ── Target Management ────────────────────────────────────────

export async function listTargets(chromePort: number): Promise<JsonTarget[]> {
  return fetchJson<JsonTarget[]>(`http://${BRIDGE_HOST}:${chromePort}/json/list`);
}

export async function createTarget(chromePort: number, url: string): Promise<JsonTarget> {
  if (_browserWs) {
    const result = await browserWsSend("Target.createTarget", { url });
    const targetId = result.targetId as string;
    _browserWsTargetIds.push(targetId);
    return {
      id: targetId,
      type: "page",
      title: "",
      url,
      webSocketDebuggerUrl: `ws://127.0.0.1:${chromePort}/devtools/page/${targetId}`,
      devtoolsFrontendUrl: ""
    } as JsonTarget;
  }
  const endpoint = `http://${BRIDGE_HOST}:${chromePort}/json/new?${encodeURIComponent(url)}`;
  return fetchJson<JsonTarget>(endpoint, { method: "PUT" });
}

export async function closeTarget(chromePort: number, targetId: string): Promise<void> {
  if (_browserWs) {
    await browserWsSend("Target.closeTarget", { targetId }).catch(() => {});
    return;
  }
  const endpoint = `http://${BRIDGE_HOST}:${chromePort}/json/close/${encodeURIComponent(targetId)}`;
  await fetch(endpoint).catch(() => null);
}

export async function activateTarget(chromePort: number, targetId: string): Promise<void> {
  if (_browserWs) {
    await browserWsSend("Target.activateTarget", { targetId }).catch(() => {});
    return;
  }
  const endpoint = `http://${BRIDGE_HOST}:${chromePort}/json/activate/${encodeURIComponent(targetId)}`;
  await fetch(endpoint).catch(() => null);
}

export async function killProcess(proc: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!proc || proc.killed) return;
  proc.kill("SIGTERM");
  await sleep(300);
  if (!proc.killed) proc.kill("SIGKILL");
}
