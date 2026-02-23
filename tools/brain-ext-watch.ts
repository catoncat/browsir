#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";

const extensionDir = path.resolve(process.cwd(), "extension");
const bridgeBase = (process.env.BRIDGE_BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const bridgeToken = process.env.BRIDGE_TOKEN ?? "dev-token-change-me";
const bumpUrl = `${bridgeBase}/dev/bump?token=${encodeURIComponent(bridgeToken)}`;

const ignorePatterns = [/^\./, /(^|\/)\./, /\.swp$/, /\.tmp$/, /~$/];

function normalizeRelPath(filename: string): string {
  return String(filename || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .trim();
}

function shouldIgnore(filename: string): boolean {
  const rel = normalizeRelPath(filename);
  if (!rel) return true;
  if (rel.startsWith("dist/")) return true;
  if (rel.startsWith("node_modules/")) return true;
  return ignorePatterns.some((re) => re.test(rel));
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let queuedReason = "";

async function bump(reason: string): Promise<void> {
  try {
    const resp = await fetch(bumpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ reason, ts: new Date().toISOString() })
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`[ext-watch] bump failed: status=${resp.status} body=${body.slice(0, 240)}`);
      return;
    }

    const data = await resp.json().catch(() => ({}));
    console.log(`[ext-watch] bump ok: version=${data?.version ?? "unknown"} reason=${reason}`);
  } catch (err) {
    console.error(`[ext-watch] bump error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runBuild(reason: string): Promise<boolean> {
  console.log(`[ext-watch] build start: ${reason}`);
  const startedAt = Date.now();

  const code = await new Promise<number>((resolve) => {
    const child = spawn("bun", ["run", "build"], {
      cwd: extensionDir,
      stdio: "inherit"
    });

    child.on("error", (error) => {
      console.error(`[ext-watch] build spawn error: ${error.message}`);
      resolve(1);
    });

    child.on("close", (exitCode) => {
      resolve(exitCode ?? 1);
    });
  });

  const elapsed = Date.now() - startedAt;
  if (code !== 0) {
    console.error(`[ext-watch] build failed: code=${code} elapsedMs=${elapsed}`);
    return false;
  }

  console.log(`[ext-watch] build ok: elapsedMs=${elapsed}`);
  return true;
}

async function flushQueue(): Promise<void> {
  if (running) return;
  running = true;

  try {
    while (queuedReason) {
      const reason = queuedReason;
      queuedReason = "";

      const ok = await runBuild(reason);
      if (!ok) continue;
      await bump(reason);
    }
  } finally {
    running = false;
  }
}

function scheduleReload(reason: string): void {
  queuedReason = reason;
  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    void flushQueue();
  }, 220);
}

console.log(`[ext-watch] watching: ${extensionDir}`);
console.log(`[ext-watch] bump endpoint: ${bridgeBase}/dev/bump`);
console.log("[ext-watch] mode: build -> bump -> chrome.runtime.reload()");
console.log("[ext-watch] ignore: dist/**, node_modules/**, dotfiles");

const watcher = watch(extensionDir, { recursive: true }, (eventType, filename) => {
  const name = normalizeRelPath(filename || "");
  if (!name || shouldIgnore(name)) return;
  scheduleReload(`${eventType}:${name}`);
});

scheduleReload("watcher-start");

process.on("SIGINT", () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  watcher.close();
  console.log("\\n[ext-watch] stopped");
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  watcher.close();
  console.log("\\n[ext-watch] stopped");
  process.exit(0);
});
