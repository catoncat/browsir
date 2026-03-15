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
 *
 * 环境变量：
 *   CHROME_CHANNEL        Chrome 渠道 ("beta" | "stable"，默认 beta)
 *   CHROME_PORT           自定义调试端口（默认从 DevToolsActivePort 读取）
 *   BBL_EXT_ID            扩展 ID（默认 jhfgfgnkpceegbkojajfadeijojekgod）
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
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
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
  const f = filter.toLowerCase();
  if (f === "sidepanel" || f === "panel") {
    return targets.find((t) => t.url.includes(EXT_ID) && t.url.includes("sidepanel"));
  }
  if (f === "sw" || f === "service-worker") {
    return targets.find(
      (t) => t.type === "service_worker" && t.url.includes(EXT_ID),
    );
  }
  if (f === "sandbox") {
    return targets.find(
      (t) => t.url.includes(EXT_ID) && t.url.includes("eval-sandbox"),
    );
  }
  return targets.find(
    (t) => t.url.toLowerCase().includes(f) || t.title.toLowerCase().includes(f),
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
    // Send with sessionId for flattened session
    const id = (this.client as any).nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        (this.client as any).pending.delete(id);
        reject(new Error(`session: CDP 调用超时 ${method}`));
      }, 20_000);
      (this.client as any).pending.set(id, { resolve, reject, timer });
      (this.client as any).ws.send(
        JSON.stringify({ id, method, params, sessionId: this.sessionId }),
      );
    });
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
