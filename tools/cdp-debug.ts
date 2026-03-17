#!/usr/bin/env bun
/**
 * CDP 直连调试工具 — AI Agent 可直接通过本脚本与 Chrome 扩展交互
 *
 * 使用方式：
 *   bun tools/cdp-debug.ts <command> [options]
 *
 * 命令：
 *   targets                列出所有 Chrome 目标（tabs, SW, extension pages）
 *   screenshot [--target]  截图指定目标（默认 SidePanel）
 *   eval <expr>            在 SidePanel 中执行 JS 表达式
 *   dom                    获取 SidePanel DOM 概览
 *   chat <message>         在 SidePanel 中发送消息并等待回复
 *   sw-eval <expr>         在 Service Worker 中执行 JS 表达式
 *   serve                  启动持久 HTTP 服务（只需授权一次 Chrome 弹窗）
 *
 * 持久服务模式：
 *   先启动: bun tools/cdp-debug.ts serve &
 *   后使用: curl http://127.0.0.1:9333/targets
 *           curl -X POST http://127.0.0.1:9333/eval -d '{"expr":"document.title"}'
 *           curl http://127.0.0.1:9333/screenshot > /tmp/ss.png
 *   只需 Chrome 授权一次，后续命令不再弹窗。
 *
 * 环境变量：
 *   CHROME_CHANNEL        Chrome 渠道 ("beta" | "stable"，默认 beta)
 *   CHROME_PORT           自定义调试端口（默认从 DevToolsActivePort 读取）
 *   BBL_EXT_ID            扩展 ID（默认 jhfgfgnkpceegbkojajfadeijojekgod）
 *   CDP_SERVE_PORT        serve 模式端口（默认 9333）
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import os from "os";

// --- Config ---
const EXT_ID = process.env.BBL_EXT_ID || "jhfgfgnkpceegbkojajfadeijojekgod";
const CHANNEL = process.env.CHROME_CHANNEL || "beta";

// --- CDP Client (simplified from brain-e2e.ts) ---
class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer }
  >();

  constructor(
    private readonly name: string,
    private readonly wsUrl: string,
  ) {}

  async connect(timeoutMs = 12_000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(`${this.name}: ${msg}`));
      };
      const timer = setTimeout(
        () => fail(`连接超时 ${this.wsUrl}`),
        timeoutMs,
      );
      const ws = new WebSocket(this.wsUrl);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        this.ws = ws;
        resolve();
      });
      ws.addEventListener("message", (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (typeof msg?.id !== "number") return;
        const rec = this.pending.get(msg.id);
        if (!rec) return;
        this.pending.delete(msg.id);
        clearTimeout(rec.timer);
        if (msg.error)
          rec.reject(new Error(`${this.name}: ${msg.error.message || "CDP error"}`));
        else rec.resolve(msg.result ?? null);
      });
      ws.addEventListener("close", () => {
        this.closed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`${this.name}: websocket 已关闭`));
        }
        this.pending.clear();
      });
      ws.addEventListener("error", () => fail("连接失败"));
    });
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
    sessionId?: string,
  ): Promise<any> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN)
      throw new Error(`${this.name}: websocket 未连接`);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: CDP 调用超时 ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg: Record<string, unknown> = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws!.send(JSON.stringify(msg));
    });
  }

  isConnected(): boolean {
    return !this.closed && this.ws != null && this.ws.readyState === WebSocket.OPEN;
  }

  async evaluate(expression: string, opts?: { awaitPromise?: boolean; timeoutMs?: number }): Promise<any> {
    const out = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: opts?.awaitPromise ?? true, returnByValue: true },
      opts?.timeoutMs ?? 20_000,
    );
    if (out?.exceptionDetails) {
      throw new Error(
        `${this.name}: ${out?.result?.description || out?.exceptionDetails?.text || "evaluate exception"}`,
      );
    }
    return out?.result?.value;
  }
}

// --- Chrome discovery ---
interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function discoverChrome(): { port: number; wsPath: string } {
  const customPort = process.env.CHROME_PORT;
  if (customPort) {
    return { port: parseInt(customPort, 10), wsPath: "" };
  }

  const profileDirs: Record<string, string> = {
    beta: path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome Beta"),
    stable: path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
    canary: path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome Canary"),
  };
  const profileDir = profileDirs[CHANNEL];
  if (!profileDir) throw new Error(`未知 Chrome channel: ${CHANNEL}`);

  const portFile = path.join(profileDir, "DevToolsActivePort");
  if (!existsSync(portFile)) {
    throw new Error(
      `未找到 DevToolsActivePort: ${portFile}\n` +
      `请确保 Chrome ${CHANNEL} 已启用远程调试（chrome://inspect/#remote-debugging）`,
    );
  }

  const content = readFileSync(portFile, "utf-8").trim();
  const lines = content.split("\n");
  const port = parseInt(lines[0], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DevToolsActivePort 中端口号无效: ${lines[0]}`);
  }
  const wsPath = lines[1] || "";
  return { port, wsPath };
}

async function getBrowserWsUrl(): Promise<string> {
  const { port, wsPath } = discoverChrome();
  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  // Fallback: try /json/version
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const data = (await res.json()) as { webSocketDebuggerUrl: string };
  return data.webSocketDebuggerUrl;
}

async function getTargets(port: number): Promise<TargetInfo[]> {
  // M144+ 远程调试端口不一定有 /json/list，使用 browser-level CDP
  const { wsPath } = discoverChrome();
  const browserWs = `ws://127.0.0.1:${port}${wsPath}`;
  const client = new CdpClient("browser", browserWs);
  await client.connect();
  const result = await client.send("Target.getTargets");
  await client.close();
  return result.targetInfos || [];
}

function findTarget(targets: TargetInfo[], filter: string): TargetInfo | undefined {
  // Filter patterns: "sidepanel", "sw", "sandbox", or URL/title substring
  const f = filter.toLowerCase().trim();
  const extensionTargets = targets.filter((t) => t.url.includes(EXT_ID));
  const findIn = (items: TargetInfo[]) =>
    items.find(
      (t) => t.url.toLowerCase().includes(f) || t.title.toLowerCase().includes(f),
    );
  const findExactOrSuffixIn = (items: TargetInfo[]) =>
    items.find((t) => {
      const url = t.url.toLowerCase();
      return url === f || url.endsWith(f);
    });

  if (f === "sidepanel" || f === "panel" || f === "sidepanel.html") {
    return (
      extensionTargets.find((t) => t.url.toLowerCase().includes("sidepanel.html")) ||
      extensionTargets.find((t) => t.url.toLowerCase().endsWith("/index.html")) ||
      findIn(extensionTargets)
    );
  }
  if (f === "sw" || f === "service-worker") {
    return targets.find(
      (t) => t.type === "service_worker" && t.url.includes(EXT_ID),
    );
  }
  if (f === "sandbox") {
    return (
      extensionTargets.find((t) => t.url.toLowerCase().includes("eval-sandbox")) ||
      findIn(extensionTargets)
    );
  }

  return (
    findExactOrSuffixIn(extensionTargets) ||
    findIn(extensionTargets) ||
    findExactOrSuffixIn(targets) ||
    findIn(targets)
  );
}

// --- Flatten session helper (for browser-level target access) ---
class BrowserSession {
  private client: CdpClient;
  private sessionId: string | null = null;

  constructor(
    private readonly browserWsUrl: string,
    private readonly targetId: string,
  ) {
    this.client = new CdpClient("browser-session", browserWsUrl);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    const result = await this.client.send("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = result.sessionId;
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.client.send(method, params, 20_000, this.sessionId ?? undefined);
  }

  async evaluate(expr: string): Promise<any> {
    const out = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out?.exceptionDetails) {
      throw new Error(out?.result?.description || out?.exceptionDetails?.text || "evaluate error");
    }
    return out?.result?.value;
  }

  async screenshot(filePath: string): Promise<number> {
    await this.send("Page.enable");
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(data, "base64");
    writeFileSync(filePath, buf);
    return buf.length;
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.client.send("Target.detachFromTarget", {
          sessionId: this.sessionId,
        });
      } catch { /* ignore */ }
    }
    await this.client.close();
  }
}

// --- Persistent HTTP Server mode ---
const SERVE_PORT = parseInt(process.env.CDP_SERVE_PORT || "9333", 10);

class PersistentCdpPool {
  private browserClient: CdpClient | null = null;
  private browserWsUrl: string = "";
  private sessions = new Map<string, BrowserSession>();
  private lastUsedAt = new Map<string, number>();
  private pendingConnects = new Map<string, Promise<BrowserSession>>();
  private static SESSION_TTL_MS = 5 * 60_000; // 5 minutes

  async ensureBrowser(): Promise<CdpClient> {
    if (this.browserClient) return this.browserClient;
    this.browserWsUrl = await getBrowserWsUrl();
    this.browserClient = new CdpClient("pool-browser", this.browserWsUrl);
    await this.browserClient.connect(30_000); // 30s — 用户需要时间点击 Chrome 授权弹窗
    console.log(`🔗 CDP 连接已建立: ${this.browserWsUrl}`);
    return this.browserClient;
  }

  async getTargets(): Promise<TargetInfo[]> {
    const client = await this.ensureBrowser();
    const result = await client.send("Target.getTargets");
    return result.targetInfos || [];
  }

  async getSession(targetFilter: string): Promise<BrowserSession> {
    this.evictStaleSessions();

    const targets = await this.getTargets();
    const target = findTarget(targets, targetFilter);
    if (!target) throw new Error(`未找到目标: ${targetFilter}`);

    const cached = this.sessions.get(target.targetId);
    if (cached) {
      this.lastUsedAt.set(target.targetId, Date.now());
      return cached;
    }

    // Dedup concurrent connects for the same target
    const pending = this.pendingConnects.get(target.targetId);
    if (pending) return pending;

    const connectPromise = (async () => {
      const session = new BrowserSession(this.browserWsUrl, target.targetId);
      await session.connect();
      this.sessions.set(target.targetId, session);
      this.lastUsedAt.set(target.targetId, Date.now());
      return session;
    })();

    this.pendingConnects.set(target.targetId, connectPromise);
    try {
      return await connectPromise;
    } finally {
      this.pendingConnects.delete(target.targetId);
    }
  }

  private evictStaleSessions(): void {
    const now = Date.now();
    for (const [id, ts] of this.lastUsedAt) {
      if (now - ts > PersistentCdpPool.SESSION_TTL_MS) {
        const session = this.sessions.get(id);
        if (session) session.close().catch(() => {});
        this.sessions.delete(id);
        this.lastUsedAt.delete(id);
      }
    }
  }

  async cleanup(): Promise<void> {
    for (const [, session] of this.sessions) {
      await session.close().catch(() => {});
    }
    this.sessions.clear();
    this.lastUsedAt.clear();
    this.pendingConnects.clear();
    await this.browserClient?.close();
    this.browserClient = null;
  }
}

async function cmdServe() {
  const pool = new PersistentCdpPool();
  const serveToken = process.env.CDP_SERVE_TOKEN || "";
  console.log("⏳ 正在连接 Chrome... 请在 Chrome 弹窗中点击「允许」（只需这一次）");
  if (!serveToken) {
    console.warn("⚠️  未设置 CDP_SERVE_TOKEN — /eval、/sw-eval、/chat 端点无鉴权保护");
  }
  await pool.ensureBrowser(); // 建立连接 → 只触发一次 Chrome 授权弹窗

  function requireAuth(req: Request): Response | null {
    if (!serveToken) return null;
    const auth = req.headers.get("authorization") || "";
    const tokenParam = new URL(req.url).searchParams.get("token") || "";
    if (auth === `Bearer ${serveToken}` || tokenParam === serveToken) return null;
    return Response.json({ ok: false, error: "未授权" }, { status: 401 });
  }

  const PROTECTED_PATHS = new Set(["/eval", "/sw-eval", "/chat"]);

  const server = Bun.serve({
    port: SERVE_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      try {
        // 鉴权：保护敏感端点
        if (PROTECTED_PATHS.has(pathname)) {
          const denied = requireAuth(req);
          if (denied) return denied;
        }

        // GET /targets
        if (pathname === "/targets") {
          const targets = await pool.getTargets();
          return Response.json({ ok: true, targets });
        }

        // GET /screenshot?target=sidepanel
        if (pathname === "/screenshot") {
          const targetFilter = url.searchParams.get("target") || "sidepanel";
          const session = await pool.getSession(targetFilter);
          await session.send("Page.enable").catch(() => {});
          const { data } = await session.send("Page.captureScreenshot", { format: "png" });
          const buf = Buffer.from(data, "base64");
          return new Response(buf, {
            headers: { "Content-Type": "image/png", "X-Target": targetFilter },
          });
        }

        // POST /eval { expr, target? }
        if (pathname === "/eval" && req.method === "POST") {
          const body = (await req.json()) as { expr: string; target?: string };
          const session = await pool.getSession(body.target || "sidepanel");
          const result = await session.evaluate(body.expr);
          return Response.json({ ok: true, result });
        }

        // GET /dom?target=sidepanel
        if (pathname === "/dom") {
          const targetFilter = url.searchParams.get("target") || "sidepanel";
          const session = await pool.getSession(targetFilter);
          const dom = await session.evaluate(`JSON.stringify({
            title: document.title,
            url: location.href,
            bodyChildCount: document.body?.children?.length || 0,
            inputFields: document.querySelectorAll('input, textarea').length,
            buttons: document.querySelectorAll('button').length,
            chatMessages: document.querySelectorAll('[class*=message], [data-role]').length,
            bodyText: document.body?.innerText?.slice(0, 500) || ''
          })`);
          return Response.json({ ok: true, dom: JSON.parse(dom) });
        }

        // POST /sw-eval { expr }
        if (pathname === "/sw-eval" && req.method === "POST") {
          const body = (await req.json()) as { expr: string };
          const session = await pool.getSession("sw");
          await session.send("Runtime.enable").catch(() => {});
          const result = await session.evaluate(body.expr);
          return Response.json({ ok: true, result });
        }

        // POST /chat { message, waitMs? }
        if (pathname === "/chat" && req.method === "POST") {
          const body = (await req.json()) as { message: string; waitMs?: number };
          const session = await pool.getSession("sidepanel");
          await session.send("Runtime.enable").catch(() => {});

          const beforeText = await session.evaluate("document.body?.innerText || ''");
          const escaped = JSON.stringify(body.message);
          await session.evaluate(`(() => {
            const ta = document.querySelector('textarea') || document.querySelector('input[type="text"]');
            if (!ta) throw new Error('未找到输入框');
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value'
            )?.set || Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set;
            if (setter) setter.call(ta, ${escaped});
            else ta.value = ${escaped};
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
          })()`);

          await session.evaluate(`(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const sendBtn = btns.find(b => {
              const label = b.getAttribute('aria-label') || '';
              return label.includes('发送');
            }) || btns[btns.length - 1];
            if (sendBtn) sendBtn.click();
            return sendBtn ? 'clicked' : 'no-button';
          })()`);

          const waitMs = Math.max(1000, Math.min(60_000, body.waitMs || 10_000));
          await new Promise((r) => setTimeout(r, waitMs));

          const afterText = await session.evaluate("document.body?.innerText || ''");
          const newLines = afterText.split("\n").filter((l: string) => !beforeText.includes(l));

          return Response.json({ ok: true, newContent: newLines.filter((l: string) => l.trim()) });
        }

        // GET /health
        if (pathname === "/health") {
          return Response.json({ ok: true, uptime: process.uptime?.() || 0 });
        }

        return Response.json({ error: "未知路径", routes: [
          "GET /targets", "GET /screenshot?target=", "POST /eval {expr,target?}",
          "GET /dom?target=", "POST /sw-eval {expr}", "POST /chat {message,waitMs?}",
          "GET /health"
        ] }, { status: 404 });
      } catch (err: any) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    },
  });

  console.log(`\n🚀 CDP 调试服务已启动: http://127.0.0.1:${server.port}`);
  console.log(`   Chrome 授权已完成，后续命令不再弹窗\n`);
  console.log(`用法示例:`);
  console.log(`  curl http://127.0.0.1:${server.port}/targets`);
  console.log(`  curl http://127.0.0.1:${server.port}/screenshot > /tmp/ss.png`);
  console.log(`  curl -X POST http://127.0.0.1:${server.port}/eval -H 'Content-Type: application/json' -d '{"expr":"document.title"}'`);
  console.log(`  curl -X POST http://127.0.0.1:${server.port}/chat -H 'Content-Type: application/json' -d '{"message":"你好"}'`);
  console.log(`\n按 Ctrl+C 停止服务\n`);
}

// --- Commands ---
const [, , command, ...args] = process.argv;

async function cmdTargets() {
  const { port } = discoverChrome();
  const targets = await getTargets(port);
  const grouped: Record<string, TargetInfo[]> = {};
  for (const t of targets) {
    (grouped[t.type] ??= []).push(t);
  }
  for (const [type, items] of Object.entries(grouped).sort()) {
    console.log(`\n=== ${type} (${items.length}) ===`);
    for (const t of items) {
      const extMarker = t.url.includes(EXT_ID) ? " ★" : "";
      console.log(`  ${t.title?.slice(0, 60) || "(untitled)"} | ${t.url?.slice(0, 80)}${extMarker}`);
    }
  }
  console.log(`\n总计: ${targets.length} 个目标`);
}

async function cmdScreenshot() {
  const targetFilter = args[0] === "--target" ? args[1] : "sidepanel";
  const outputPath = args.includes("--output")
    ? args[args.indexOf("--output") + 1]
    : `/tmp/bbl-${targetFilter}-${Date.now()}.png`;

  const browserWs = await getBrowserWsUrl();
  const { port } = discoverChrome();
  const targets = await getTargets(port);
  const target = findTarget(targets, targetFilter);
  if (!target) {
    console.error(`❌ 未找到目标: ${targetFilter}`);
    console.error(`可用的扩展目标：`);
    targets.filter((t) => t.url.includes(EXT_ID)).forEach((t) => console.error(`  [${t.type}] ${t.title}`));
    process.exit(1);
  }

  console.log(`📋 目标: [${target.type}] ${target.title}`);
  const session = new BrowserSession(browserWs, target.targetId);
  await session.connect();
  const bytes = await session.screenshot(outputPath);
  await session.close();
  console.log(`📸 截图已保存: ${outputPath} (${bytes} bytes)`);
}

async function cmdEval() {
  const expr = args.join(" ");
  if (!expr) {
    console.error("用法: cdp-debug eval <expression>");
    process.exit(1);
  }

  const browserWs = await getBrowserWsUrl();
  const { port } = discoverChrome();
  const targets = await getTargets(port);
  const target = findTarget(targets, "sidepanel");
  if (!target) {
    console.error("❌ SidePanel 未找到");
    process.exit(1);
  }

  const session = new BrowserSession(browserWs, target.targetId);
  await session.connect();
  const result = await session.evaluate(expr);
  await session.close();
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

async function cmdDom() {
  const browserWs = await getBrowserWsUrl();
  const { port } = discoverChrome();
  const targets = await getTargets(port);
  const target = findTarget(targets, "sidepanel");
  if (!target) {
    console.error("❌ SidePanel 未找到");
    process.exit(1);
  }

  const session = new BrowserSession(browserWs, target.targetId);
  await session.connect();
  const dom = await session.evaluate(`JSON.stringify({
    title: document.title,
    url: location.href,
    bodyChildCount: document.body?.children?.length || 0,
    inputFields: document.querySelectorAll('input, textarea').length,
    buttons: document.querySelectorAll('button').length,
    chatMessages: document.querySelectorAll('[class*=message], [data-role]').length,
    bodyText: document.body?.innerText?.slice(0, 500) || ''
  })`);
  await session.close();
  console.log(JSON.parse(dom));
}

async function cmdChat() {
  const message = args.join(" ");
  if (!message) {
    console.error("用法: cdp-debug chat <message>");
    process.exit(1);
  }

  const browserWs = await getBrowserWsUrl();
  const { port } = discoverChrome();
  const targets = await getTargets(port);
  const target = findTarget(targets, "sidepanel");
  if (!target) {
    console.error("❌ SidePanel 未找到");
    process.exit(1);
  }

  const session = new BrowserSession(browserWs, target.targetId);
  await session.connect();
  await session.send("Runtime.enable");

  // Read text before
  const beforeText = await session.evaluate("document.body?.innerText || ''");
  console.log("📝 发送前对话状态:", beforeText.split("\n").slice(-3).join(" | "));

  // Type message
  const escaped = JSON.stringify(message);
  await session.evaluate(`(() => {
    const ta = document.querySelector('textarea') || document.querySelector('input[type="text"]');
    if (!ta) throw new Error('未找到输入框');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (setter) setter.call(ta, ${escaped});
    else ta.value = ${escaped};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  console.log(`✍️ 已输入: "${message}"`);

  // Click send
  await session.evaluate(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const sendBtn = btns.find(b => {
      const label = b.getAttribute('aria-label') || '';
      return label.includes('发送');
    }) || btns[btns.length - 1];
    if (sendBtn) sendBtn.click();
    return sendBtn ? 'clicked' : 'no-button';
  })()`);
  console.log("🖱️ 已点击发送");

  // Wait for response
  const waitMs = parseInt(process.env.CHAT_WAIT_MS || "10000", 10);
  console.log(`⏳ 等待 ${waitMs / 1000} 秒...`);
  await new Promise((r) => setTimeout(r, waitMs));

  // Screenshot
  const ssPath = `/tmp/bbl-chat-${Date.now()}.png`;
  await session.screenshot(ssPath);
  console.log(`📸 截图: ${ssPath}`);

  // Read latest text
  const afterText = await session.evaluate("document.body?.innerText || ''");
  const newLines = afterText.split("\n").filter((l: string) => !beforeText.includes(l));
  console.log("\n📤 新增内容:");
  for (const line of newLines) {
    if (line.trim()) console.log(`  ${line}`);
  }

  await session.close();
}

async function cmdSwEval() {
  const expr = args.join(" ");
  if (!expr) {
    console.error("用法: cdp-debug sw-eval <expression>");
    process.exit(1);
  }

  const browserWs = await getBrowserWsUrl();
  const { port } = discoverChrome();
  const targets = await getTargets(port);
  const target = findTarget(targets, "sw");
  if (!target) {
    console.error("❌ Service Worker 未找到");
    process.exit(1);
  }

  console.log(`🔧 SW: ${target.url}`);
  const session = new BrowserSession(browserWs, target.targetId);
  await session.connect();
  await session.send("Runtime.enable");
  const result = await session.evaluate(expr);
  await session.close();
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

// --- Main ---
const commands: Record<string, () => Promise<void>> = {
  targets: cmdTargets,
  screenshot: cmdScreenshot,
  eval: cmdEval,
  dom: cmdDom,
  chat: cmdChat,
  "sw-eval": cmdSwEval,
  serve: cmdServe,
};

if (!command || command === "--help" || command === "-h") {
  console.log(`
CDP 直连调试工具

用法: bun tools/cdp-debug.ts <command> [options]

命令:
  targets                列出所有 Chrome 目标
  screenshot [--target <filter>] [--output <path>]
                         截图（默认 SidePanel）
  eval <expression>      在 SidePanel 执行 JS
  dom                    SidePanel DOM 概览
  chat <message>         发送消息并等待回复
  sw-eval <expression>   在 Service Worker 执行 JS
  serve                  启动持久 HTTP 服务（只需一次授权）

持久服务模式（推荐，避免重复弹窗）:
  bun tools/cdp-debug.ts serve &         # 启动后台服务
  curl http://127.0.0.1:9333/targets     # 列出目标
  curl http://127.0.0.1:9333/screenshot > /tmp/ss.png
  curl -X POST http://127.0.0.1:9333/eval -H 'Content-Type: application/json' -d '{"expr":"document.title"}'

目标过滤器 (--target):
  sidepanel / panel      扩展 SidePanel（默认）
  sw / service-worker    扩展 Service Worker
  sandbox                eval-sandbox iframe
  <url/title substring>  任意匹配

环境变量:
  CHROME_CHANNEL=beta    Chrome 渠道（默认 beta）
  CHAT_WAIT_MS=10000     chat 命令等待回复毫秒数
  BBL_EXT_ID=...         扩展 ID
`);
  process.exit(0);
}

const handler = commands[command];
if (!handler) {
  console.error(`未知命令: ${command}`);
  console.error(`可用命令: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}

try {
  await handler();
} catch (err: any) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
