#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

interface JsonVersion {
  webSocketDebuggerUrl: string;
}

interface JsonTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface RuntimeMessageResponse {
  ok?: boolean;
  data?: any;
  error?: string;
  [key: string]: any;
}

interface TestCaseResult {
  group: string;
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
}

interface MockLlmRequest {
  ts: string;
  userText: string;
  messageCount: number;
  hasToolResult: boolean;
  hasSharedTabsContext: boolean;
  toolMessages: string[];
}

interface MockLlmServer {
  baseUrl: string;
  getRequests: () => MockLlmRequest[];
  clearRequests: () => void;
  stop: () => Promise<void>;
}

const ROOT_DIR = path.resolve(import.meta.dir, "..");
const EXT_DIR = path.join(ROOT_DIR, "extension");
const BRIDGE_DIR = path.join(ROOT_DIR, "bridge");
const DEFAULT_EVIDENCE_PATH = path.join(ROOT_DIR, "bdd", "evidence", "brain-e2e.latest.json");
const LIVE_EVIDENCE_PATH = path.join(ROOT_DIR, "bdd", "evidence", "brain-e2e-live.latest.json");

const BRIDGE_HOST = "127.0.0.1";
const TEST_TAB_TITLE = "BBL E2E";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pushLog(buffer: string[], chunk: Buffer | string, maxLines = 220): void {
  const text = String(chunk || "");
  const lines = text.split(/\r?\n/).filter(Boolean);
  buffer.push(...lines);
  if (buffer.length > maxLines) {
    buffer.splice(0, buffer.length - maxLines);
  }
}

function resolveEvidencePath(useLiveSuite: boolean): string {
  const customPath = String(process.env.BRAIN_E2E_EVIDENCE_PATH || "").trim();
  if (customPath) {
    return path.isAbsolute(customPath) ? customPath : path.join(ROOT_DIR, customPath);
  }
  return useLiveSuite ? LIVE_EVIDENCE_PATH : DEFAULT_EVIDENCE_PATH;
}

function buildTestPageFixtureScript(): string {
  return `(() => {
    document.title = ${JSON.stringify(TEST_TAB_TITLE)};
    document.body.innerHTML = [
      '<main id="app">',
      '  <label for="name">Name</label>',
      '  <input id="name" type="text" value="" />',
      '  <button id="act" type="button">Act</button>',
      '  <button id="rerender" type="button">Rerender</button>',
      '  <div id="out">idle</div>',
      '</main>'
    ].join('');

    const wireAct = (el) => {
      el.addEventListener("click", () => {
        const value = (document.querySelector("#name") || {}).value || "";
        const out = document.querySelector("#out");
        if (out) out.textContent = "clicked:" + value;
      });
    };

    const act = document.querySelector("#act");
    if (act) wireAct(act);

    const rerender = document.querySelector("#rerender");
    if (rerender) {
      rerender.addEventListener("click", () => {
        const current = document.querySelector("#act");
        if (!current) return;
        const next = current.cloneNode(true);
        next.textContent = "Act2";
        current.replaceWith(next);
        wireAct(next);
        const out = document.querySelector("#out");
        if (out) out.setAttribute("data-rerendered", "1");
      });
    }
    return { ok: true, title: document.title };
  })()`;
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
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

async function waitFor<T>(
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

async function canListen(port: number, host = BRIDGE_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 800; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canListen(port)) return port;
  }
  throw new Error(`找不到空闲端口，起始端口=${start}`);
}

function buildSseResponse(events: Array<Record<string, unknown> | "[DONE]">): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        if (event === "[DONE]") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          continue;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
}

function validateMockChatMessages(messages: any[]): string | null {
  const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i] || {};
    const role = String(item.role || "").trim();
    if (!allowedRoles.has(role)) {
      return `messages[${i}].role 非法: ${role || "<empty>"}`;
    }

    if (role === "tool") {
      const toolCallId = String(item.tool_call_id || "").trim();
      if (!toolCallId) {
        return `messages[${i}] role=tool 缺少 tool_call_id`;
      }
    }

    if (typeof item.content !== "string") {
      return `messages[${i}].content 必须为 string`;
    }
  }

  return null;
}

async function startMockLlmServer(port: number): Promise<MockLlmServer> {
  const requests: MockLlmRequest[] = [];

  const server = Bun.serve({
    hostname: BRIDGE_HOST,
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      let payload: any = null;
      try {
        payload = await req.json();
      } catch {
        return new Response(JSON.stringify({ error: "bad json" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }

      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const validationError = validateMockChatMessages(messages);
      if (validationError) {
        return new Response(
          JSON.stringify({
            error: {
              type: "invalid_request_error",
              message: validationError
            }
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" }
          }
        );
      }

      const lastUser = [...messages].reverse().find((item) => item?.role === "user");
      const userText = String(lastUser?.content || "");
      const toolMessages = messages
        .filter((item) => item?.role === "tool")
        .map((item) => String(item?.content || ""));
      const hasToolResult = messages.some((item) => item?.role === "tool");
      const hasSharedTabsContext = messages.some((item) => {
        if (String(item?.role || "") !== "system") return false;
        const content = String(item?.content || "");
        return content.includes("Shared tabs context (user-selected):");
      });
      requests.push({
        ts: new Date().toISOString(),
        userText,
        messageCount: messages.length,
        hasToolResult,
        hasSharedTabsContext,
        toolMessages: toolMessages.map((item) => item.slice(0, 4_000))
      });
      if (requests.length > 180) {
        requests.splice(0, requests.length - 180);
      }

      if (userText.includes("#LLM_FAIL_HTTP")) {
        return new Response(JSON.stringify({ error: "mock llm http failure" }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }

      if (userText.includes("#LLM_BAD_STREAM")) {
        return new Response("data: {invalid-json}\n\ndata: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" }
        });
      }

      if (userText.includes("#LLM_CHECK_HISTORY_TOOL")) {
        return buildSseResponse([
          {
            choices: [
              {
                delta: {
                  content: hasToolResult ? "HISTORY_TOOL_PRESENT" : "HISTORY_TOOL_MISSING"
                }
              }
            ]
          },
          "[DONE]"
        ]);
      }

      if (userText.includes("#LLM_TAB_TOOLS")) {
        const markerMatch = /OPEN_MARKER=([A-Za-z0-9._:-]+)/.exec(userText);
        const marker = markerMatch?.[1] || "bbl-open-tab-default";
        const tabUrl = `about:blank#${marker}`;

        if (!hasToolResult) {
          return buildSseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_tabs_list_1",
                        type: "function",
                        function: {
                          name: "list_tabs",
                          arguments: JSON.stringify({})
                        }
                      },
                      {
                        index: 1,
                        id: "call_tabs_open_1",
                        type: "function",
                        function: {
                          name: "open_tab",
                          arguments: JSON.stringify({ url: tabUrl, active: false })
                        }
                      }
                    ]
                  }
                }
              ]
            },
            "[DONE]"
          ]);
        }

        const hasListPayload = toolMessages.some((content) => content.includes("\"count\"") && content.includes("\"tabs\""));
        const hasOpenPayload = toolMessages.some(
          (content) => content.includes("\"opened\":true") && content.includes(`#${marker}`)
        );
        const summary = hasListPayload && hasOpenPayload ? "LLM_TAB_TOOLS_SUCCESS" : "LLM_TAB_TOOLS_PARTIAL";

        return buildSseResponse([
          {
            choices: [
              {
                delta: {
                  content: `${summary}:${marker}`
                }
              }
            ]
          },
          "[DONE]"
        ]);
      }

      if (userText.includes("#LLM_TOOL_README")) {
        if (!hasToolResult) {
          return buildSseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_readme_1",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: JSON.stringify({ path: "README.md" })
                        }
                      }
                    ]
                  }
                }
              ]
            },
            "[DONE]"
          ]);
        }
        return buildSseResponse([
          {
            choices: [
              {
                delta: {
                  content: "LLM_TOOL_SUCCESS"
                }
              }
            ]
          },
          "[DONE]"
        ]);
      }

      if (userText.includes("#LLM_MULTI_TURN")) {
        return buildSseResponse([
          {
            choices: [
              {
                delta: {
                  content: "LLM_MULTI_TURN_OK"
                }
              }
            ]
          },
          "[DONE]"
        ]);
      }

      if (userText.includes("#LLM_SHARED_TABS_CHECK")) {
        return buildSseResponse([
          {
            choices: [
              {
                delta: {
                  content: hasSharedTabsContext ? "SHARED_TABS_CONTEXT_PRESENT" : "SHARED_TABS_CONTEXT_MISSING"
                }
              }
            ]
          },
          "[DONE]"
        ]);
      }

      return buildSseResponse([
        {
          choices: [
            {
              delta: {
                content: "LLM_DEFAULT_OK"
              }
            }
          ]
        },
        "[DONE]"
      ]);
    }
  });

  return {
    baseUrl: `http://${BRIDGE_HOST}:${port}/v1`,
    getRequests: () => requests.map((item) => ({ ...item, toolMessages: [...item.toolMessages] })),
    clearRequests: () => {
      requests.length = 0;
    },
    stop: async () => {
      await server.stop(true);
    }
  };
}

function resolveChromeBinary(): string {
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

async function listTargets(chromePort: number): Promise<JsonTarget[]> {
  return fetchJson<JsonTarget[]>(`http://${BRIDGE_HOST}:${chromePort}/json/list`);
}

async function createTarget(chromePort: number, url: string): Promise<JsonTarget> {
  const endpoint = `http://${BRIDGE_HOST}:${chromePort}/json/new?${encodeURIComponent(url)}`;
  return fetchJson<JsonTarget>(endpoint, { method: "PUT" });
}

async function closeTarget(chromePort: number, targetId: string): Promise<void> {
  const endpoint = `http://${BRIDGE_HOST}:${chromePort}/json/close/${encodeURIComponent(targetId)}`;
  await fetch(endpoint).catch(() => null);
}

async function killProcess(proc: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!proc || proc.killed) return;
  proc.kill("SIGTERM");
  await sleep(300);
  if (!proc.killed) proc.kill("SIGKILL");
}

class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timer: Timer }>();
  private closed = false;

  constructor(
    private readonly name: string,
    private readonly wsUrl: string
  ) {}

  async connect(timeoutMs = 12_000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(`${this.name}: ${message}`));
      };

      const timer = setTimeout(() => fail(`websocket 连接超时 ${this.wsUrl}`), timeoutMs);
      const ws = new WebSocket(this.wsUrl);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        this.ws = ws;
        resolve();
      });

      ws.addEventListener("message", (event) => {
        let msg: any;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (typeof msg?.id !== "number") return;
        const record = this.pending.get(msg.id);
        if (!record) return;
        this.pending.delete(msg.id);
        clearTimeout(record.timer);

        if (msg.error) {
          record.reject(new Error(`${this.name}: ${msg.error.message || "CDP error"}`));
          return;
        }
        record.resolve(msg.result ?? null);
      });

      ws.addEventListener("close", () => {
        this.closed = true;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`${this.name}: websocket 已关闭`));
        }
        this.pending.clear();
      });

      ws.addEventListener("error", () => {
        fail("websocket 连接失败");
      });
    });
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    this.ws.close();
    this.ws = null;
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    if (this.closed) throw new Error(`${this.name}: websocket 已关闭`);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.name}: websocket 未连接`);
    }

    const id = this.nextId++;
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: CDP 调用超时 ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(payload));
    });
  }

  async evaluate(
    expression: string,
    options: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number } = {}
  ): Promise<any> {
    const out = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: options.awaitPromise ?? true,
        returnByValue: options.returnByValue ?? true
      },
      options.timeoutMs ?? 20_000
    );

    if (out?.exceptionDetails) {
      const description = out?.result?.description || out?.exceptionDetails?.text || "Runtime.evaluate exception";
      throw new Error(`${this.name}: ${description}`);
    }

    if (options.returnByValue === false) {
      return out?.result;
    }
    return out?.result?.value;
  }
}

async function sendBgMessage(sidepanel: CdpClient, message: Record<string, unknown>): Promise<RuntimeMessageResponse> {
  const serialized = JSON.stringify(message);
  const expr = `(async () => {
    const msg = ${serialized};
    return await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => done({ ok: false, error: "runtime.sendMessage timeout" }), 15000);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) {
            done({ ok: false, error: err.message || String(err) });
            return;
          }
          done(resp ?? { ok: false, error: "empty response" });
        });
      } catch (err) {
        clearTimeout(timer);
        done({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  })()`;

  return (await sidepanel.evaluate(expr)) as RuntimeMessageResponse;
}

async function main() {
  const useLiveLlmSuite = String(process.env.BRAIN_E2E_ENABLE_LIVE_LLM || "").trim().toLowerCase() === "true";
  const evidencePath = resolveEvidencePath(useLiveLlmSuite);
  const startedAt = Date.now();
  const testResults: TestCaseResult[] = [];
  const bridgeLogs: string[] = [];
  const chromeLogs: string[] = [];

  let fatalError: string | null = null;
  let bridgeProcess: ChildProcessWithoutNullStreams | null = null;
  let chromeProcess: ChildProcessWithoutNullStreams | null = null;
  let sidepanelClient: CdpClient | null = null;
  let debugClient: CdpClient | null = null;
  let pageClient: CdpClient | null = null;
  let mockLlm: MockLlmServer | null = null;
  let chromeProfileDir = "";
  let chromePort = 0;
  let bridgePort = 0;
  let mockLlmPort = 0;

  const headless = process.env.BRAIN_E2E_HEADLESS === "true";
  const chromeBin = resolveChromeBinary();
  const bridgeToken = process.env.BRAIN_E2E_BRIDGE_TOKEN || `brain-e2e-${Date.now()}`;
  const evidenceDir = path.dirname(evidencePath);
  const liveLlmBase = String(process.env.BRAIN_E2E_LIVE_LLM_BASE || "https://ai.chen.rs/v1").trim();
  const liveLlmKey = String(process.env.BRAIN_E2E_LIVE_LLM_KEY || "").trim();
  const liveLlmModel = String(process.env.BRAIN_E2E_LIVE_LLM_MODEL || "gpt-5.3-codex").trim();

  async function runCase(group: string, name: string, fn: () => Promise<void>) {
    const caseStarted = Date.now();
    try {
      await fn();
      const durationMs = Date.now() - caseStarted;
      testResults.push({ group, name, status: "passed", durationMs });
      console.log(`[PASS] ${group} / ${name} (${durationMs}ms)`);
    } catch (err) {
      const durationMs = Date.now() - caseStarted;
      const message = err instanceof Error ? err.message : String(err);
      testResults.push({ group, name, status: "failed", durationMs, error: message });
      console.error(`[FAIL] ${group} / ${name} (${durationMs}ms): ${message}`);
    }
  }

  try {
    if (useLiveLlmSuite && !liveLlmKey) {
      throw new Error("BRAIN_E2E_LIVE_LLM_KEY 为空；live suite 需要真实 LLM key");
    }

    bridgePort = Number(process.env.BRAIN_E2E_BRIDGE_PORT || (await findFreePort(18_787)));
    chromePort = Number(process.env.BRAIN_E2E_CHROME_PORT || (await findFreePort(19_333)));
    mockLlmPort = Number(process.env.BRAIN_E2E_LLM_PORT || (await findFreePort(20_201)));
    mockLlm = await startMockLlmServer(mockLlmPort);

    bridgeProcess = spawn("bun", ["run", "start"], {
      cwd: BRIDGE_DIR,
      env: {
        ...process.env,
        BRIDGE_HOST,
        BRIDGE_PORT: String(bridgePort),
        BRIDGE_TOKEN: bridgeToken
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    bridgeProcess.stdout.on("data", (chunk) => pushLog(bridgeLogs, chunk));
    bridgeProcess.stderr.on("data", (chunk) => pushLog(bridgeLogs, chunk));

    await waitFor("bridge /health", async () => {
      try {
        const data = await fetchJson<{ ok: boolean }>(`http://${BRIDGE_HOST}:${bridgePort}/health`, {}, 1500);
        return data?.ok ? data : null;
      } catch {
        return null;
      }
    });

    chromeProfileDir = path.join(os.tmpdir(), `brain-e2e-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(chromeProfileDir, { recursive: true });

    const chromeArgs = [
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${chromeProfileDir}`,
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ];
    if (headless) {
      chromeArgs.splice(chromeArgs.length - 1, 0, "--headless=new", "--disable-gpu");
    }

    chromeProcess = spawn(chromeBin, chromeArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    chromeProcess.stdout.on("data", (chunk) => pushLog(chromeLogs, chunk));
    chromeProcess.stderr.on("data", (chunk) => pushLog(chromeLogs, chunk));

    await waitFor<JsonVersion>("chrome /json/version", async () => {
      try {
        return await fetchJson<JsonVersion>(`http://${BRIDGE_HOST}:${chromePort}/json/version`, {}, 1500);
      } catch {
        return null;
      }
    });

    const sidepanelTarget = await waitFor<JsonTarget>("extension sidepanel page", async () => {
      const targets = await listTargets(chromePort);
      const candidates = targets
        .filter((item) => item.type === "service_worker")
        .map((item) => /chrome-extension:\/\/([a-z]{32})\/service[-_]worker\.js$/.exec(item.url || ""))
        .filter(Boolean)
        .map((match) => match![1]);

      for (const extId of candidates) {
        // eslint-disable-next-line no-await-in-loop
        const opened = await createTarget(chromePort, `chrome-extension://${extId}/sidepanel.html`);
        if (opened.url.startsWith(`chrome-extension://${extId}/sidepanel.html`) && opened.webSocketDebuggerUrl) {
          return opened;
        }
      }
      return null;
    }, 45_000, 550);
    const extIdMatch = /chrome-extension:\/\/([a-z]{32})\//.exec(String(sidepanelTarget.url || ""));
    assert(extIdMatch?.[1], `无法从 sidepanel url 提取扩展 ID: ${sidepanelTarget.url || "unknown"}`);
    const extId = extIdMatch![1];
    const debugTarget = await createTarget(chromePort, `chrome-extension://${extId}/debug.html`);
    assert(!!debugTarget.webSocketDebuggerUrl, "debug 页缺少 webSocketDebuggerUrl");

    const testPageTarget = await createTarget(chromePort, "about:blank");
    assert(!!testPageTarget.webSocketDebuggerUrl, "测试页缺少 webSocketDebuggerUrl");

    sidepanelClient = new CdpClient("sidepanel", sidepanelTarget.webSocketDebuggerUrl!);
    await sidepanelClient.connect();
    await sidepanelClient.send("Runtime.enable");
    debugClient = new CdpClient("debug-page", debugTarget.webSocketDebuggerUrl!);
    await debugClient.connect();
    await debugClient.send("Runtime.enable");

    pageClient = new CdpClient("test-page", testPageTarget.webSocketDebuggerUrl!);
    await pageClient.connect();
    await pageClient.send("Runtime.enable");

    await pageClient.evaluate(buildTestPageFixtureScript());

    await waitFor("sidepanel ready", async () => {
      try {
        const ready = await sidepanelClient!.evaluate(`(() => {
          const bodyText = document.body?.innerText || "";
          const hasTitle = bodyText.includes("Browser Brain") || bodyText.includes("Terminal");
          const hasStartButton = !!document.querySelector("button");
          const hasAppRoot = !!document.querySelector("#app");
          const bootFailed = document.body.classList.contains("no-dist");
          return {
            hasTitle,
            hasStartButton,
            hasAppRoot,
            bootFailed
          };
        })()`);

        if (ready?.bootFailed) {
          throw new Error("sidepanel boot failed");
        }
        const done = !!ready?.hasAppRoot && !ready?.bootFailed;
        return done ? true : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("boot failed")) {
          throw err;
        }
        return null;
      }
    });
    await waitFor("debug page ready", async () => {
      try {
        const ready = await debugClient!.evaluate(`(() => {
          const hasTitle = !!document.querySelector(".debug-title");
          const hasAppRoot = !!document.querySelector("#app");
          const bootFailed = document.body.classList.contains("no-dist");
          return {
            hasTitle,
            hasAppRoot,
            bootFailed
          };
        })()`);
        if (ready?.bootFailed) {
          throw new Error("debug page boot failed");
        }
        return ready?.hasTitle && ready?.hasAppRoot ? true : null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("boot failed")) {
          throw err;
        }
        return null;
      }
    });

    await runCase("panel.vnext", "dist sidepanel 路径可直接加载", async () => {
      const distTarget = await createTarget(chromePort, `chrome-extension://${extId}/dist/sidepanel.html`);
      assert(!!distTarget.webSocketDebuggerUrl, "dist sidepanel 缺少 webSocketDebuggerUrl");

      const distClient = new CdpClient("sidepanel-dist", distTarget.webSocketDebuggerUrl!);
      try {
        await distClient.connect();
        await distClient.send("Runtime.enable");

        await waitFor(
          "dist sidepanel ready",
          async () => {
            try {
              const ready = await distClient.evaluate(`(() => {
                const hasAppRoot = !!document.querySelector("#app");
                const bootFailed = document.body.classList.contains("no-dist");
                return { hasAppRoot, bootFailed };
              })()`);
              if (ready?.bootFailed) {
                throw new Error("dist sidepanel boot failed");
              }
              return ready?.hasAppRoot ? true : null;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (message.includes("boot failed")) {
                throw err;
              }
              return null;
            }
          },
          20_000,
          250
        );
      } finally {
        await distClient.close().catch(() => {});
        await closeTarget(chromePort, distTarget.id).catch(() => {});
      }
    });

    const testTabId = await waitFor<number>("test tab id", async () => {
      const out = await sidepanelClient!.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        const target = tabs.find((tab) => tab && tab.title === ${JSON.stringify(TEST_TAB_TITLE)});
        return target ? target.id : null;
      })()`);
      return Number.isInteger(out) ? out : null;
    });

    const acquireAndUseLease = async (
      owner: string,
      fn: (owner: string) => Promise<void>,
      ttlMs: number = 30_000
    ): Promise<void> => {
      const acquired = await sendBgMessage(sidepanelClient, {
        type: "lease.acquire",
        tabId: testTabId,
        owner,
        sessionId: `s-${owner}`,
        agentId: owner,
        ttlMs
      });
      assert(acquired.ok === true && acquired.data?.ok === true, `lease.acquire 失败: ${JSON.stringify(acquired)}`);

      try {
        await fn(owner);
      } finally {
        await sendBgMessage(sidepanelClient!, {
          type: "lease.release",
          tabId: testTabId,
          owner,
          sessionId: `s-${owner}`,
          agentId: owner
        });
      }
    };

    const resetTestPageFixture = async () => {
      await pageClient!.send("Page.navigate", { url: "about:blank" }).catch(() => null);
      await sleep(120);
      await pageClient!.evaluate(buildTestPageFixtureScript());
      const observed = await sendBgMessage(sidepanelClient!, {
        type: "cdp.observe",
        tabId: testTabId
      });
      assert(observed.ok === true, `重置测试页失败: ${observed.error || "unknown"}`);
    };

    await runCase("service-worker API", "snapshot interactive 返回 ref/node handles", async () => {
      const snapshot = await sendBgMessage(sidepanelClient, {
        type: "cdp.snapshot",
        tabId: testTabId,
        options: {
          mode: "interactive",
          diff: false,
          format: "json"
        }
      });

      assert(snapshot.ok === true, `cdp.snapshot 失败: ${snapshot.error || "unknown"}`);
      const data = snapshot.data;
      assert(data?.mode === "interactive", `snapshot mode 不是 interactive: ${data?.mode}`);
      assert(Array.isArray(data?.nodes) && data.nodes.length > 0, "interactive snapshot nodes 为空");

      const actNode = data.nodes.find((node: any) => node.selector === "#act");
      assert(!!actNode, "找不到 #act 节点");
      assert(typeof actNode.ref === "string" && actNode.ref.length > 0, "#act 缺少 ref");
      const hasHandle = Number.isInteger(actNode.nodeId) || Number.isInteger(actNode.backendNodeId);
      assert(hasHandle, "#act 缺少 nodeId/backendNodeId");
    });

    await runCase("service-worker API", "lease + cdp_action + verify 闭环", async () => {
      await acquireAndUseLease("owner-flow", async (owner) => {
        const snap = await sendBgMessage(sidepanelClient!, {
          type: "cdp.snapshot",
          tabId: testTabId,
          options: { mode: "interactive", diff: false, format: "json" }
        });
        assert(snap.ok === true, "snapshot 失败");

        const nodes = snap.data?.nodes || [];
        const input = nodes.find((node: any) => node.selector === "#name");
        const act = nodes.find((node: any) => node.selector === "#act");
        assert(input?.ref, "缺少 #name ref");
        assert(act?.ref, "缺少 #act ref");

        const fillResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.action",
          tabId: testTabId,
          owner,
          sessionId: "session-owner-flow",
          agentId: "owner-flow",
          action: { kind: "fill", ref: input.ref, value: "alice" }
        });
        assert(fillResp.ok === true, `fill 失败: ${fillResp.error || "unknown"}`);

        const clickResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.action",
          tabId: testTabId,
          owner,
          sessionId: "session-owner-flow",
          agentId: "owner-flow",
          action: { kind: "click", ref: act.ref }
        });
        assert(clickResp.ok === true, `click 失败: ${clickResp.error || "unknown"}`);

        const verifyResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.verify",
          tabId: testTabId,
          action: { textIncludes: "clicked:alice" }
        });
        assert(verifyResp.ok === true, `verify 调用失败: ${verifyResp.error || "unknown"}`);
        assert(verifyResp.data?.ok === true, `verify 断言失败: ${JSON.stringify(verifyResp.data)}`);
      });
    });

    await runCase("service-worker API", "ref 存在但句柄过期时可 fallback", async () => {
      await acquireAndUseLease("owner-ref-fallback", async (owner) => {
        const snap = await sendBgMessage(sidepanelClient!, {
          type: "cdp.snapshot",
          tabId: testTabId,
          options: { mode: "interactive", diff: false, format: "json" }
        });
        assert(snap.ok === true, "snapshot 失败");

        const nodes = snap.data?.nodes || [];
        const input = nodes.find((node: any) => node.selector === "#name");
        const act = nodes.find((node: any) => node.selector === "#act");
        const rerender = nodes.find((node: any) => node.selector === "#rerender");
        assert(input?.ref && act?.ref && rerender?.ref, "缺少关键 ref 节点");

        const fillResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.action",
          tabId: testTabId,
          owner,
          sessionId: "session-owner-ref-fallback",
          agentId: "owner-ref-fallback",
          action: { kind: "fill", ref: input.ref, value: "bob" }
        });
        assert(fillResp.ok === true, "fill 失败");

        const rerenderResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.action",
          tabId: testTabId,
          owner,
          sessionId: "session-owner-ref-fallback",
          agentId: "owner-ref-fallback",
          action: { kind: "click", ref: rerender.ref }
        });
        assert(rerenderResp.ok === true, `rerender click 失败: ${rerenderResp.error || "unknown"}`);

        const clickOldRefResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.action",
          tabId: testTabId,
          owner,
          sessionId: "session-owner-ref-fallback",
          agentId: "owner-ref-fallback",
          action: { kind: "click", ref: act.ref }
        });
        assert(clickOldRefResp.ok === true, `旧 ref click 未 fallback: ${clickOldRefResp.error || "unknown"}`);

        const verifyResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.verify",
          tabId: testTabId,
          action: { textIncludes: "clicked:bob" }
        });
        assert(verifyResp.ok === true && verifyResp.data?.ok === true, "fallback 后 verify 失败");
      });
    });

    await runCase("service-worker API", "ref 不存在时按现状返回稳定错误", async () => {
      await acquireAndUseLease("owner-ref-missing", async (owner) => {
        const resp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.action",
          tabId: testTabId,
          owner,
          sessionId: "session-owner-ref-missing",
          agentId: "owner-ref-missing",
          action: { kind: "click", ref: "e404404", selector: "#act" }
        });

        assert(resp.ok === false, "ref 不存在时应失败");
        assert(typeof resp.error === "string" && resp.error.includes("ref e404404 not found"), `错误不符合预期: ${resp.error}`);
      });
    });

    await runCase("service-worker API", "ref 过期且 selector 无效时返回稳定错误契约", async () => {
      await acquireAndUseLease("owner-ref-stale", async (owner) => {
        const snap = await sendBgMessage(sidepanelClient!, {
          type: "cdp.snapshot",
          tabId: testTabId,
          options: { mode: "interactive", diff: false, format: "json" }
        });
        assert(snap.ok === true, "snapshot 失败");
        const act = (snap.data?.nodes || []).find((node: any) => node.selector === "#act");
        assert(act?.ref, "找不到 #act ref");

        const navResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.action",
          tabId: testTabId,
          owner,
          sessionId: "session-owner-ref-stale",
          agentId: "owner-ref-stale",
          action: {
            kind: "navigate",
            url: "about:blank"
          }
        });
        assert(navResp.ok === true, `导航失败: ${navResp.error || "unknown"}`);

        const actionResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.action",
          tabId: testTabId,
          owner,
          sessionId: "session-owner-ref-stale",
          agentId: "owner-ref-stale",
          action: { kind: "click", ref: act.ref, selector: "#missing-act" }
        });
        assert(actionResp.ok === false, "目标失效时应失败");
        assert(typeof actionResp.error === "string" && actionResp.error.length > 0, "错误消息为空");
      });
    });

    await runCase("service-worker API", "lease 冲突 + release + 过期后可恢复", async () => {
      const ownerA = "owner-lease-A";
      const ownerB = "owner-lease-B";

      const a1 = await sendBgMessage(sidepanelClient, {
        type: "lease.acquire",
        tabId: testTabId,
        owner: ownerA,
        sessionId: "s-lease-a1",
        agentId: ownerA,
        ttlMs: 6000
      });
      assert(a1.ok === true && a1.data?.ok === true, `ownerA acquire 失败: ${JSON.stringify(a1)}`);

      const bBlocked = await sendBgMessage(sidepanelClient, {
        type: "lease.acquire",
        tabId: testTabId,
        owner: ownerB,
        sessionId: "s-lease-b1",
        agentId: ownerB,
        ttlMs: 6000
      });
      assert(bBlocked.ok === true, "ownerB acquire 响应错误");
      assert(bBlocked.data?.ok === false && bBlocked.data?.reason === "locked_by_other", "ownerB 应被拒绝");

      const hbBlocked = await sendBgMessage(sidepanelClient, {
        type: "lease.heartbeat",
        tabId: testTabId,
        owner: ownerB,
        sessionId: "s-lease-b1",
        agentId: ownerB,
        ttlMs: 6000
      });
      assert(hbBlocked.ok === true && hbBlocked.data?.ok === false, "ownerB heartbeat 应失败");

      const releaseA = await sendBgMessage(sidepanelClient, {
        type: "lease.release",
        tabId: testTabId,
        owner: ownerA,
        sessionId: "s-lease-a1",
        agentId: ownerA
      });
      assert(releaseA.ok === true && releaseA.data?.ok === true, "ownerA release 失败");

      const b2 = await sendBgMessage(sidepanelClient, {
        type: "lease.acquire",
        tabId: testTabId,
        owner: ownerB,
        sessionId: "s-lease-b2",
        agentId: ownerB,
        ttlMs: 6000
      });
      assert(b2.ok === true && b2.data?.ok === true, "release 后 ownerB acquire 应成功");

      await sendBgMessage(sidepanelClient, {
        type: "lease.release",
        tabId: testTabId,
        owner: ownerB,
        sessionId: "s-lease-b2",
        agentId: ownerB
      });

      const a2 = await sendBgMessage(sidepanelClient, {
        type: "lease.acquire",
        tabId: testTabId,
        owner: ownerA,
        sessionId: "s-lease-a2",
        agentId: ownerA,
        ttlMs: 2100
      });
      assert(a2.ok === true && a2.data?.ok === true, "ownerA acquire(过期测试) 失败");

      await sleep(2400);

      const b3 = await sendBgMessage(sidepanelClient, {
        type: "lease.acquire",
        tabId: testTabId,
        owner: ownerB,
        sessionId: "s-lease-b3",
        agentId: ownerB,
        ttlMs: 6000
      });
      assert(b3.ok === true && b3.data?.ok === true, "过期后 ownerB acquire 应成功");

      await sendBgMessage(sidepanelClient, {
        type: "lease.release",
        tabId: testTabId,
        owner: ownerB,
        sessionId: "s-lease-b3",
        agentId: ownerB
      });
    });

    await runCase("service-worker API", "snapshot 支持 compact/maxTokens/a11y 字段", async () => {
      await resetTestPageFixture();
      const resp = await sendBgMessage(sidepanelClient, {
        type: "cdp.snapshot",
        tabId: testTabId,
        options: {
          mode: "full",
          filter: "all",
          diff: true,
          format: "compact",
          maxTokens: 80
        }
      });
      assert(resp.ok === true, `cdp.snapshot 失败: ${resp.error || "unknown"}`);
      const data = resp.data || {};
      assert(typeof data.compact === "string" && data.compact.length > 0, "compact 快照为空");
      assert(Array.isArray(data.nodes) && data.nodes.length > 0, "a11y nodes 为空");
      assert(data.nodes.every((node: any) => typeof node.ref === "string" && typeof node.role === "string"), "nodes 缺少 ref/role");
      assert(data.diff === null || typeof data.diff === "object", "diff 类型非法");
      assert(typeof data.truncated === "boolean", "truncated 应为 boolean");
    });

    await runCase("service-worker API", "cdp.verify 支持 urlChanged 断言", async () => {
      await resetTestPageFixture();
      await acquireAndUseLease("owner-verify-url-changed", async (owner) => {
        const before = await sendBgMessage(sidepanelClient!, {
          type: "cdp.observe",
          tabId: testTabId
        });
        assert(before.ok === true, "cdp.observe 失败");
        const previousUrl = String(before.data?.page?.url || "");
        assert(previousUrl.length > 0, "previousUrl 为空");

        const verifyResp = await sendBgMessage(sidepanelClient!, {
          type: "cdp.verify",
          tabId: testTabId,
          action: { expect: { urlChanged: true, previousUrl: `${previousUrl}#old` } }
        });
        assert(verifyResp.ok === true, `verify 调用失败: ${verifyResp.error || "unknown"}`);
        assert(verifyResp.data?.ok === true, `urlChanged 断言失败: ${JSON.stringify(verifyResp.data)}`);
      });
    });

    await runCase("brain.runtime", "brain.step.execute 可执行 cdp action + verify", async () => {
      await resetTestPageFixture();
      const sessionId = `brain-step-${Date.now()}`;
      const created = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        sessionId,
        prompt: "seed",
        autoRun: false
      });
      assert(created.ok === true, `brain.run.start 失败: ${created.error || "unknown"}`);

      const fill = await sendBgMessage(sidepanelClient!, {
        type: "brain.step.execute",
        sessionId,
        mode: "cdp",
        action: "action",
        args: {
          tabId: testTabId,
          action: { kind: "fill", selector: "#name", value: "dora" }
        }
      });
      assert(fill.ok === true, `brain.step.execute(fill) 响应失败: ${fill.error || "unknown"}`);
      assert(fill.data?.ok === true, `brain.step.execute(fill) 执行失败: ${JSON.stringify(fill.data)}`);

      const click = await sendBgMessage(sidepanelClient!, {
        type: "brain.step.execute",
        sessionId,
        mode: "cdp",
        action: "action",
        args: {
          tabId: testTabId,
          action: { kind: "click", selector: "#act" }
        }
      });
      assert(click.ok === true, `brain.step.execute(click) 响应失败: ${click.error || "unknown"}`);
      assert(click.data?.ok === true, `brain.step.execute(click) 执行失败: ${JSON.stringify(click.data)}`);

      const verify = await sendBgMessage(sidepanelClient!, {
        type: "brain.step.execute",
        sessionId,
        mode: "cdp",
        action: "verify",
        args: {
          tabId: testTabId,
          action: { expect: { textIncludes: "clicked:dora" } }
        },
        verifyPolicy: "always"
      });
      assert(verify.ok === true, `brain.step.execute(verify) 响应失败: ${verify.error || "unknown"}`);
      assert(verify.data?.ok === true, `brain.step.execute(verify) 执行失败: ${JSON.stringify(verify.data)}`);
      assert(verify.data?.verified === true, `brain.step.execute(verify) 应 verified=true: ${JSON.stringify(verify.data)}`);
    });

    await runCase("brain.runtime", "brain.run.start 支持 tool_calls 闭环并写入 step stream", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex"
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);
      const connect = await sendBgMessage(sidepanelClient!, { type: "bridge.connect" });
      assert(connect.ok === true, `bridge.connect 失败: ${connect.error || "unknown"}`);

      const marker = `brain-run-${Date.now()}`;
      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: `#LLM_TAB_TOOLS OPEN_MARKER=${marker}`
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "brain.run.start 未返回 sessionId");

      const done = await waitFor(
        "brain.run.start loop_done",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId
          });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const messages = Array.isArray(dump.data?.conversationView?.messages) ? dump.data.conversationView.messages : [];
          const hasDone = stream.some((item: any) => item?.type === "loop_done");
          if (!hasDone) return null;
          const hasToolStep = stream.some((item: any) => item?.type === "step_finished" && item?.payload?.mode === "tool_call" && item?.payload?.ok === true);
          const hasSuccessText = messages.some((item: any) => String(item?.content || "").includes("LLM_TAB_TOOLS_SUCCESS"));
          return { hasToolStep, hasSuccessText };
        },
        35_000,
        250
      );

      assert(done.hasToolStep === true, "step stream 应包含 tool_call 成功记录");
      assert(done.hasSuccessText === true, "会话消息应包含 LLM_TAB_TOOLS_SUCCESS");

      const requests = mockLlm!.getRequests();
      assert(requests.length >= 2, `LLM 请求次数不足，expected>=2 got=${requests.length}`);
      assert(requests.some((req) => req.hasToolResult), "后续轮次应包含 tool result");
    });

    await runCase("brain.runtime", "同一会话第二轮继续执行不应触发 LLM HTTP 400", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex"
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const firstTurn = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: `先走一轮工具调用 #LLM_TAB_TOOLS OPEN_MARKER=multi-turn-${Date.now()}`
      });
      assert(firstTurn.ok === true, `first brain.run.start 失败: ${firstTurn.error || "unknown"}`);
      const sessionId = String(firstTurn.data?.sessionId || "");
      assert(sessionId.length > 0, "first turn sessionId 为空");

      const firstDone = await waitFor(
        "first turn loop_done",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, { type: "brain.debug.dump", sessionId });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const messages = Array.isArray(dump.data?.conversationView?.messages) ? dump.data.conversationView.messages : [];
          const doneItem = [...stream].reverse().find((item: any) => item?.type === "loop_done");
          if (!doneItem) return null;
          return { doneItem, messages };
        },
        35_000,
        250
      );
      assert(firstDone.doneItem?.payload?.status === "done", "第一轮应成功完成");
      assert(
        firstDone.messages.some((item: any) => String(item?.content || "").includes("LLM_TAB_TOOLS_SUCCESS")),
        "第一轮应完成工具闭环"
      );

      await waitFor(
        "first turn runtime idle",
        async () => {
          const view = await sendBgMessage(sidepanelClient!, { type: "brain.session.view", sessionId });
          if (!view.ok) return null;
          return view.data?.conversationView?.lastStatus?.running ? null : true;
        },
        8_000,
        120
      );

      const beforeSecondDump = await sendBgMessage(sidepanelClient!, { type: "brain.debug.dump", sessionId });
      assert(beforeSecondDump.ok === true, `second turn 之前 dump 失败: ${beforeSecondDump.error || "unknown"}`);
      const beforeStream = Array.isArray(beforeSecondDump.data?.stepStream) ? beforeSecondDump.data.stepStream : [];
      const beforeLoopDoneCount = beforeStream.filter((item: any) => item?.type === "loop_done").length;

      const secondTurn = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        sessionId,
        prompt: "继续第二轮 #LLM_MULTI_TURN"
      });
      assert(secondTurn.ok === true, `second brain.run.start 失败: ${secondTurn.error || "unknown"}`);

      const secondDone = await waitFor(
        "second turn loop_done",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, { type: "brain.debug.dump", sessionId });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const messages = Array.isArray(dump.data?.conversationView?.messages) ? dump.data.conversationView.messages : [];
          const loopDoneItems = stream.filter((item: any) => item?.type === "loop_done");
          if (loopDoneItems.length <= beforeLoopDoneCount) return null;
          const doneItem = [...stream].reverse().find((item: any) => item?.type === "loop_done");
          if (!doneItem) return null;
          return { doneItem, messages };
        },
        35_000,
        250
      );

      assert(secondDone.doneItem?.payload?.status === "done", "第二轮应成功完成");
      assert(
        secondDone.messages.some((item: any) => String(item?.content || "").includes("LLM_MULTI_TURN_OK")),
        "第二轮应包含 LLM_MULTI_TURN_OK"
      );
      assert(
        !secondDone.messages.some((item: any) => String(item?.content || "").includes("LLM HTTP 400")),
        "第二轮不应出现 LLM HTTP 400"
      );
    });

    await runCase("brain.runtime", "brain.run.start 注入 shared tabs 上下文并每次覆盖", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex"
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const tabsForShare = await sidepanelClient!.evaluate(`(async () => {
        const tabs = await chrome.tabs.query({});
        return tabs
          .filter((tab) => Number.isInteger(tab?.id) && String(tab?.url || tab?.pendingUrl || "").trim())
          .slice(0, 3)
          .map((tab) => ({ id: Number(tab.id), title: String(tab.title || ""), url: String(tab.url || tab.pendingUrl || "") }));
      })()`);
      assert(Array.isArray(tabsForShare), "tabsForShare 应为数组");
      assert(tabsForShare.length >= 2, `可分享 tab 不足，实际=${tabsForShare.length}`);

      const firstIds = [Number(tabsForShare[0].id), Number(tabsForShare[1].id)];
      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "检查共享 tabs 注入 #LLM_SHARED_TABS_CHECK turn=1",
        tabIds: firstIds
      });
      assert(started.ok === true, `brain.run.start(turn1) 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "turn1 sessionId 为空");

      const firstDump = await waitFor(
        "shared tabs turn1 done",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId
          });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const hasDone = stream.some((item: any) => item?.type === "loop_done");
          if (!hasDone) return null;
          return dump.data;
        },
        35_000,
        250
      );

      const firstSharedTabs = Array.isArray(firstDump?.meta?.header?.metadata?.sharedTabs)
        ? firstDump.meta.header.metadata.sharedTabs
        : [];
      assert(firstSharedTabs.length === firstIds.length, `turn1 sharedTabs 数量不符，期望=${firstIds.length} 实际=${firstSharedTabs.length}`);
      assert(
        firstIds.every((id) => firstSharedTabs.some((item: any) => Number(item?.id) === id && String(item?.title || "").trim() && String(item?.url || "").trim())),
        "turn1 sharedTabs 应包含每个 tab 的 id/title/url"
      );
      const firstMessages = Array.isArray(firstDump?.conversationView?.messages) ? firstDump.conversationView.messages : [];
      assert(
        firstMessages.some((item: any) => String(item?.content || "").includes("SHARED_TABS_CONTEXT_PRESENT")),
        "turn1 assistant 回复应包含 SHARED_TABS_CONTEXT_PRESENT"
      );

      const secondIds = [Number(tabsForShare[1].id)];
      const secondTurn = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        sessionId,
        prompt: "检查共享 tabs 覆盖 #LLM_SHARED_TABS_CHECK turn=2",
        tabIds: secondIds
      });
      assert(secondTurn.ok === true, `brain.run.start(turn2) 失败: ${secondTurn.error || "unknown"}`);

      const secondDump = await waitFor(
        "shared tabs turn2 done",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId
          });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const loopDoneCount = stream.filter((item: any) => item?.type === "loop_done").length;
          if (loopDoneCount < 2) return null;
          return dump.data;
        },
        35_000,
        250
      );
      const secondSharedTabs = Array.isArray(secondDump?.meta?.header?.metadata?.sharedTabs)
        ? secondDump.meta.header.metadata.sharedTabs
        : [];
      assert(secondSharedTabs.length === secondIds.length, `turn2 sharedTabs 应按新集合覆盖，期望=${secondIds.length} 实际=${secondSharedTabs.length}`);
      assert(
        secondSharedTabs.every((item: any) => Number(item?.id) === secondIds[0]),
        "turn2 sharedTabs 应只保留最新 tab 集合"
      );

      const thirdTurn = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        sessionId,
        prompt: "检查空共享不污染 #LLM_SHARED_TABS_CHECK turn=3",
        tabIds: []
      });
      assert(thirdTurn.ok === true, `brain.run.start(turn3) 失败: ${thirdTurn.error || "unknown"}`);

      const thirdDump = await waitFor(
        "shared tabs turn3 done",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId
          });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const loopDoneCount = stream.filter((item: any) => item?.type === "loop_done").length;
          if (loopDoneCount < 3) return null;
          return dump.data;
        },
        35_000,
        250
      );
      const thirdMetadata = thirdDump?.meta?.header?.metadata || {};
      const thirdSharedTabs = Array.isArray(thirdMetadata?.sharedTabs) ? thirdMetadata.sharedTabs : [];
      assert(thirdSharedTabs.length === 0, "turn3 空 tabIds 不应污染 sharedTabs");

      const requests = mockLlm!.getRequests();
      const sharedRequests = requests.filter((req) => req.userText.includes("#LLM_SHARED_TABS_CHECK"));
      assert(sharedRequests.length >= 3, `shared tabs 请求次数不足，期望>=3 实际=${sharedRequests.length}`);
      assert(sharedRequests[0]?.hasSharedTabsContext === true, "turn1 请求应带 shared tabs context");
      assert(sharedRequests[1]?.hasSharedTabsContext === true, "turn2 请求应带 shared tabs context");
      assert(sharedRequests[2]?.hasSharedTabsContext === false, "turn3 请求不应带 shared tabs context");
    });

    await runCase("brain.runtime", "brain.debug.dump 可观测 llm 原始调用与工具步骤", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex"
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);
      const connect = await sendBgMessage(sidepanelClient!, { type: "bridge.connect" });
      assert(connect.ok === true, `bridge.connect 失败: ${connect.error || "unknown"}`);

      const marker = `brain-debug-${Date.now()}`;
      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: `执行 tab 工具链路 #LLM_TAB_TOOLS OPEN_MARKER=${marker}`
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "sessionId 为空");

      const dump = await waitFor(
        "brain.debug.dump llm+tool trace",
        async () => {
          const out = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId
          });
          if (!out.ok) return null;
          const stream = Array.isArray(out.data?.stepStream) ? out.data.stepStream : [];
          const hasDone = stream.some((item: any) => item?.type === "loop_done");
          if (!hasDone) return null;
          return out.data;
        },
        35_000,
        250
      );

      const stream = Array.isArray(dump.stepStream) ? dump.stepStream : [];
      assert(stream.some((item: any) => item?.type === "llm.request"), "stepStream 缺少 llm.request");
      assert(stream.some((item: any) => item?.type === "llm.response.raw"), "stepStream 缺少 llm.response.raw");
      assert(stream.some((item: any) => item?.type === "llm.response.parsed"), "stepStream 缺少 llm.response.parsed");
      assert(
        stream.some((item: any) => item?.type === "step_finished" && item?.payload?.mode === "tool_call"),
        "stepStream 缺少 tool_call step_finished"
      );

      const requests = mockLlm!.getRequests();
      assert(requests.length >= 2, `预期 >=2 次 LLM 调用，实际=${requests.length}`);
      assert(requests.some((req) => req.hasToolResult), "debug 场景应包含携带 tool result 的请求");

      const tabProbe = await sidepanelClient!.evaluate(`(async () => {
        const marker = ${JSON.stringify(marker)};
        const tabs = await chrome.tabs.query({});
        const found = tabs.find((tab) => String(tab.url || tab.pendingUrl || "").includes(marker));
        if (found?.id) {
          try { await chrome.tabs.remove(found.id); } catch {}
        }
        return { found: !!found };
      })()`);
      assert(tabProbe?.found === true, "debug 场景 open_tab 应创建 marker tab");
    });

    await runCase("brain.runtime", "LLM HTTP 失败时应产生 auto_retry 事件并失败收口", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex"
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "触发 llm http 失败 #LLM_FAIL_HTTP"
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "sessionId 为空");

      const dump = await waitFor(
        "brain.debug.dump retry trace",
        async () => {
          const out = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId
          });
          if (!out.ok) return null;
          const stream = Array.isArray(out.data?.stepStream) ? out.data.stepStream : [];
          if (!stream.some((item: any) => item?.type === "loop_done")) return null;
          return out.data;
        },
        35_000,
        250
      );

      const stream = Array.isArray(dump.stepStream) ? dump.stepStream : [];
      assert(stream.some((item: any) => item?.type === "auto_retry_start"), "失败场景应有 auto_retry_start");
      assert(
        stream.some((item: any) => item?.type === "auto_retry_end" && item?.payload?.success === false),
        "失败场景应有 auto_retry_end(success=false)"
      );
      assert(
        stream.some((item: any) => item?.type === "loop_done" && item?.payload?.status === "failed_execute"),
        "失败场景应以 failed_execute 收口"
      );
    });

    await runCase("panel.vnext", "sidepanel 渲染并支持复制/历史分叉/最后一条重试", async () => {
      const marker = `panel-actions-${Date.now()}`;

      const base = await sidepanelClient!.evaluate(`(() => ({
        hasComposer: !!document.querySelector("textarea")
      }))()`);
      assert(base.hasComposer === true, "缺少输入框");

      const sendPromptByUi = async (text: string) => {
        const out = await sidepanelClient!.evaluate(`(() => {
          const textarea = document.querySelector("textarea");
          if (!textarea) return { ok: false, error: "textarea missing" };
          textarea.focus();
          textarea.value = ${JSON.stringify(text)};
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true
            })
          );
          return { ok: true };
        })()`);
        assert(out?.ok === true, `UI 发送 prompt 失败: ${out?.error || "unknown"}`);
      };

      await sendPromptByUi(`请回复第一条结果 ${marker}-1`);

      await waitFor(
        "panel first assistant action ready",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const copyBtns = Array.from(document.querySelectorAll('button[aria-label="复制内容"], button[aria-label="已复制"]'));
            const retryBtns = Array.from(document.querySelectorAll('button[aria-label="重新回答"]'));
            const forkBtns = Array.from(document.querySelectorAll('button[aria-label="在新对话中分叉"]'));
            return {
              copyCount: copyBtns.length,
              retryCount: retryBtns.length,
              forkCount: forkBtns.length
            };
          })()`);
          if ((out?.copyCount || 0) < 1) return null;
          if ((out?.retryCount || 0) < 1) return null;
          if ((out?.forkCount || 0) < 1) return null;
          return out;
        },
        45_000,
        250
      );

      await sendPromptByUi(`请回复第二条结果 ${marker}-2`);

      const multiAssistantReady = await waitFor(
        "panel two assistant actions ready",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const retryBtns = Array.from(document.querySelectorAll('button[aria-label="重新回答"]'));
            const forkBtns = Array.from(document.querySelectorAll('button[aria-label="在新对话中分叉"]'));
            const copyBtns = Array.from(document.querySelectorAll('button[aria-label="复制内容"], button[aria-label="已复制"]'));
            return {
              retryCount: retryBtns.length,
              forkCount: forkBtns.length,
              copyCount: copyBtns.length
            };
          })()`);
          if ((out?.retryCount || 0) < 1) return null;
          if ((out?.forkCount || 0) < 2) return null;
          if ((out?.copyCount || 0) < 2) return null;
          return out;
        },
        35_000,
        250
      );
      assert((multiAssistantReady?.retryCount || 0) === 1, "仅最后一条 assistant 应显示重新回答按钮");
      assert((multiAssistantReady?.forkCount || 0) >= 2, "历史 assistant 未显示分叉按钮");

      await sidepanelClient!.evaluate(`(() => {
        globalThis.__BRAIN_E2E_CLIPBOARD_WRITE = async () => true;
        return true;
      })()`);

      const copyClicked = await sidepanelClient!.evaluate(`(() => {
        const copyBtns = Array.from(document.querySelectorAll('button[aria-label="复制内容"], button[aria-label="已复制"]'));
        const last = copyBtns[copyBtns.length - 1];
        if (!last) return { ok: false, error: "copy button missing" };
        last.click();
        return { ok: true };
      })()`);
      assert(copyClicked?.ok === true, `点击复制失败: ${copyClicked?.error || "unknown"}`);

      await waitFor(
        "panel copy success notice",
        async () => {
          const text = await sidepanelClient!.evaluate(`(() => document.body?.innerText || "")()`);
          return String(text).includes("已复制") ? true : null;
        },
        10_000,
        200
      );

      const sessionCountBeforeFork = Number((await sendBgMessage(sidepanelClient!, { type: "brain.session.list" })).data?.sessions?.length || 0);

      const forkClicked = await sidepanelClient!.evaluate(`(() => {
        const forkBtns = Array.from(document.querySelectorAll('button[aria-label="在新对话中分叉"]'));
        if (forkBtns.length < 2) return { ok: false, error: "fork buttons less than 2" };
        const first = forkBtns[0];
        const last = forkBtns[forkBtns.length - 1];
        if (!first) return { ok: false, error: "history fork button missing" };
        if (first.disabled) return { ok: false, error: "history fork button disabled" };
        first.click();
        return {
          ok: true,
          clickedHistorical: first !== last
        };
      })()`);
      assert(forkClicked?.ok === true, `点击历史分叉失败: ${forkClicked?.error || "unknown"}`);
      assert(forkClicked?.clickedHistorical === true, "未点击到历史 assistant 的分叉按钮");

      await waitFor(
        "panel fork notice",
        async () => {
          const text = await sidepanelClient!.evaluate(`(() => document.body?.innerText || "")()`);
          return String(text).includes("已分叉到新对话") ? true : null;
        },
        10_000,
        200
      );

      const listedAfterFork = await waitFor(
        "panel fork creates one new session",
        async () => {
          const listedNow = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
          if (!listedNow.ok) return null;
          const sessionsNow = Array.isArray(listedNow.data?.sessions) ? listedNow.data.sessions : [];
          const currentCount = Number(sessionsNow.length || 0);
          if (currentCount !== sessionCountBeforeFork + 1) return null;
          return sessionsNow;
        },
        20_000,
        250
      );
      assert(Array.isArray(listedAfterFork), "分叉后 session.list 返回异常");
      const newestFork = listedAfterFork[0] || {};
      assert(String(newestFork?.title || "").includes("重答分支"), "分叉会话标题应包含“重答分支”");
      assert(String(newestFork?.forkedFrom?.sessionId || "").length > 0, "分叉会话应包含 fork 来源 sessionId");

      await waitFor(
        "panel header shows fork source",
        async () => {
          const text = await sidepanelClient!.evaluate(`(() => document.body?.innerText || "")()`);
          return String(text).includes("分叉自") ? true : null;
        },
        10_000,
        200
      );

      await sendPromptByUi(`请在分叉会话继续回答 ${marker}-3`);

      await waitFor(
        "panel fork session has assistant for latest retry",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const copyCount = document.querySelectorAll('button[aria-label="复制内容"], button[aria-label="已复制"]').length;
            const retryCount = document.querySelectorAll('button[aria-label="重新回答"]').length;
            return { copyCount, retryCount };
          })()`);
          if (Number(out?.copyCount || 0) < 1) return null;
          if (Number(out?.retryCount || 0) < 1) return null;
          return out;
        },
        45_000,
        250
      );

      const listedBeforeRetry = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
      assert(listedBeforeRetry.ok === true, "重试前读取会话列表失败");
      const sessionsBeforeRetry = Array.isArray(listedBeforeRetry.data?.sessions) ? listedBeforeRetry.data.sessions : [];
      const sessionCountBeforeRetry = Number(sessionsBeforeRetry.length || 0);
      const retrySessionId = String(sessionsBeforeRetry[0]?.id || "");
      assert(retrySessionId.length > 0, "重试前无法定位当前会话");

      const retryClicked = await sidepanelClient!.evaluate(`(() => {
        const retryBtns = Array.from(document.querySelectorAll('button[aria-label="重新回答"]'));
        if (retryBtns.length < 1) return { ok: false, error: "retry button missing" };
        const last = retryBtns[retryBtns.length - 1];
        if (!last) return { ok: false, error: "retry button empty" };
        if (last.disabled) return { ok: false, error: "retry button disabled" };
        last.click();
        return { ok: true };
      })()`);
      assert(retryClicked?.ok === true, `点击最后一条重试失败: ${retryClicked?.error || "unknown"}`);

      await waitFor(
        "panel retry notice",
        async () => {
          const text = await sidepanelClient!.evaluate(`(() => document.body?.innerText || "")()`);
          return String(text).includes("已发起重新回答") ? true : null;
        },
        10_000,
        200
      );

      await waitFor(
        "panel latest retry trace visible",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId: retrySessionId
          });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const hasRegenerateInput = stream.some((item: any) => item?.type === "input.regenerate");
          const hasLoopDone = stream.some((item: any) => item?.type === "loop_done");
          if (!hasRegenerateInput || !hasLoopDone) return null;
          return true;
        },
        35_000,
        250
      );

      const sessionCountAfterRetry = Number((await sendBgMessage(sidepanelClient!, { type: "brain.session.list" })).data?.sessions?.length || 0);
      assert(
        sessionCountAfterRetry === sessionCountBeforeRetry,
        `最后一条重试不应新建会话，期望 ${sessionCountBeforeRetry}，实际 ${sessionCountAfterRetry}`
      );

      await sidepanelClient!.evaluate(`(() => {
        globalThis.__BRAIN_E2E_CLIPBOARD_WRITE = async () => {
          throw new Error("mock clipboard unavailable");
        };
        return true;
      })()`);

      const copyFailClicked = await sidepanelClient!.evaluate(`(() => {
        const copyBtns = Array.from(document.querySelectorAll('button[aria-label="复制内容"], button[aria-label="已复制"]'));
        const last = copyBtns[copyBtns.length - 1];
        if (!last) return { ok: false, error: "copy button missing for fail case" };
        last.click();
        return { ok: true };
      })()`);
      assert(copyFailClicked?.ok === true, `点击复制(失败场景)失败: ${copyFailClicked?.error || "unknown"}`);

      await waitFor(
        "panel copy failure degrade notice",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const text = document.body?.innerText || "";
            return {
              hasErrorNotice: text.includes("复制失败，请检查剪贴板权限"),
              hasComposer: !!document.querySelector("textarea"),
              hasApp: !!document.querySelector("#app")
            };
          })()`);
          if (!out?.hasErrorNotice) return null;
          if (!out?.hasComposer) return null;
          if (!out?.hasApp) return null;
          return out;
        },
        10_000,
        200
      );

      await sidepanelClient!.evaluate(`(() => {
        delete globalThis.__BRAIN_E2E_CLIPBOARD_WRITE;
        return true;
      })()`);
    });

    await runCase("debug.console", "Live Events 可显示 brain.event", async () => {
      assert(debugClient, "debug 页面未连接");
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: "",
          llmApiKey: "",
          llmModel: "gpt-5.3-codex"
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);
      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "live-events-smoke"
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      await waitFor(
        "debug live events",
        async () => {
          const out = await debugClient!.evaluate(`(() => {
            const text = document.body?.innerText || "";
            return text.includes("input.user") || text.includes("loop_done");
          })()`);
          return out === true ? true : null;
        },
        25_000,
        300
      );
    });

    await runCase("brain.runtime", "brain.run.stop 状态通过 session.view 回显", async () => {
      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "stop-state-smoke",
        autoRun: false
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "sessionId 为空");

      const stopped = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.stop",
        sessionId
      });
      assert(stopped.ok === true, `brain.run.stop 失败: ${stopped.error || "unknown"}`);
      assert(stopped.data?.stopped === true, "brain.run.stop 后 stopped 应为 true");

      const view = await sendBgMessage(sidepanelClient!, {
        type: "brain.session.view",
        sessionId
      });
      assert(view.ok === true, `brain.session.view 失败: ${view.error || "unknown"}`);
      assert(view.data?.conversationView?.lastStatus?.stopped === true, "session.view.lastStatus.stopped 应为 true");
    });

    await runCase("brain.session", "session 标题自动生成 + 手动刷新 + 删除", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex"
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "请帮我整理 PI 书签搜索的执行复盘 #TITLE_DELETE"
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "sessionId 为空");

      await waitFor(
        "session title auto update loop_done",
        async () => {
          const out = await sendBgMessage(sidepanelClient!, { type: "brain.debug.dump", sessionId });
          if (!out.ok) return null;
          const stream = Array.isArray(out.data?.stepStream) ? out.data.stepStream : [];
          return stream.some((item: any) => item?.type === "loop_done") ? true : null;
        },
        35_000,
        250
      );

      const listed = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
      assert(listed.ok === true, `brain.session.list 失败: ${listed.error || "unknown"}`);
      const listedSessions = Array.isArray(listed.data?.sessions) ? listed.data.sessions : [];
      const row = listedSessions.find((item: any) => String(item?.id || "") === sessionId);
      assert(!!row, "新会话应出现在 session.list");
      assert(String(row?.title || "").trim().length > 0, "第一轮完成后应自动生成会话标题");

      const refreshed = await sendBgMessage(sidepanelClient!, {
        type: "brain.session.title.refresh",
        sessionId
      });
      assert(refreshed.ok === true, `brain.session.title.refresh 失败: ${refreshed.error || "unknown"}`);
      assert(String(refreshed.data?.title || "").trim().length > 0, "手动刷新标题后 title 不能为空");

      const deleted = await sendBgMessage(sidepanelClient!, {
        type: "brain.session.delete",
        sessionId
      });
      assert(deleted.ok === true, `brain.session.delete 失败: ${deleted.error || "unknown"}`);
      assert(deleted.data?.deleted === true, "session.delete 应返回 deleted=true");

      const listedAfterDelete = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
      assert(listedAfterDelete.ok === true, `删除后 brain.session.list 失败: ${listedAfterDelete.error || "unknown"}`);
      const left = Array.isArray(listedAfterDelete.data?.sessions) ? listedAfterDelete.data.sessions : [];
      assert(!left.some((item: any) => String(item?.id || "") === sessionId), "删除后会话不应出现在 session.list");
    });

    if (useLiveLlmSuite) {
      await runCase("brain.runtime llm-live", "真实 LLM 在浏览器目标上达到可验证成功率", async () => {
        const attemptsRaw = Number(process.env.BRAIN_E2E_LIVE_ATTEMPTS || 3);
        const attempts = Number.isInteger(attemptsRaw) && attemptsRaw > 0 ? attemptsRaw : 3;
        const defaultMinPass = Math.ceil(attempts * 0.67);
        const minPassRaw = Number(process.env.BRAIN_E2E_LIVE_MIN_PASS || defaultMinPass);
        const minPass = Math.max(1, Math.min(attempts, Number.isInteger(minPassRaw) ? minPassRaw : defaultMinPass));
        const outcomes: Array<Record<string, unknown>> = [];
        let passedAttempts = 0;

        for (let i = 1; i <= attempts; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await resetTestPageFixture();
          const marker = `live-${Date.now()}-${i}`;
          const prompt = `在 tabId=${testTabId} 上完成任务：1) 将 #name 填为 \"${marker}\"；2) 点击 #act；3) 验证页面出现 clicked:${marker}；完成后回复 ok。`;
          const started =
            // eslint-disable-next-line no-await-in-loop
            await sendBgMessage(sidepanelClient!, {
              type: "brain.run.start",
              prompt
            });
          assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
          const sessionId = String(started.data?.sessionId || "");
          assert(sessionId.length > 0, "sessionId 为空");

          // eslint-disable-next-line no-await-in-loop
          const dump = await waitFor(
            "brain live loop_done",
            async () => {
              const out = await sendBgMessage(sidepanelClient!, { type: "brain.debug.dump", sessionId });
              if (!out.ok) return null;
              const stream = Array.isArray(out.data?.stepStream) ? out.data.stepStream : [];
              return stream.some((item: any) => item?.type === "loop_done") ? out.data : null;
            },
            90_000,
            300
          );
          const status = Array.isArray(dump.stepStream)
            ? dump.stepStream.find((item: any) => item?.type === "loop_done")?.payload?.status || null
            : null;
          // eslint-disable-next-line no-await-in-loop
          const verifyResp = await sendBgMessage(sidepanelClient!, {
            type: "cdp.verify",
            tabId: testTabId,
            action: { expect: { textIncludes: `clicked:${marker}` } }
          });
          const verified = verifyResp.ok === true && verifyResp.data?.ok === true;
          const pass = status === "done" && verified;
          if (pass) passedAttempts += 1;

          outcomes.push({
            attempt: i,
            status,
            pass,
            verified
          });
        }

        assert(
          passedAttempts >= minPass,
          `真实 LLM 冒烟未达标: passed=${passedAttempts}/${attempts}, min=${minPass}, outcomes=${JSON.stringify(outcomes).slice(0, 1200)}`
        );
      });
    }

    const failedCount = testResults.filter((item) => item.status === "failed").length;
    if (failedCount > 0) {
      fatalError = `${failedCount} 个测试失败`;
    }
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
  } finally {
    await debugClient?.close().catch(() => {});
    await sidepanelClient?.close().catch(() => {});
    await pageClient?.close().catch(() => {});
    await mockLlm?.stop().catch(() => {});

    await killProcess(chromeProcess);
    await killProcess(bridgeProcess);

    if (chromeProfileDir) {
      await rm(chromeProfileDir, { recursive: true, force: true }).catch(() => {});
    }

    await mkdir(evidenceDir, { recursive: true });

    const passedCount = testResults.filter((item) => item.status === "passed").length;
    const failedCount = testResults.filter((item) => item.status === "failed").length;
    const evidence = {
      version: "1.0.0",
      ts: new Date().toISOString(),
      passed: !fatalError && failedCount === 0,
      summary: {
        total: testResults.length,
        passed: passedCount,
        failed: failedCount,
        durationMs: Date.now() - startedAt
      },
      env: {
        chromeBin,
        headless,
        chromePort,
        bridgePort,
        mockLlmPort,
        useLiveLlmSuite,
        liveLlmBase: useLiveLlmSuite ? liveLlmBase : "",
        liveLlmModel: useLiveLlmSuite ? liveLlmModel : ""
      },
      tests: testResults,
      fatalError: fatalError || null,
      debug: {
        bridgeLogsTail: bridgeLogs.slice(-80),
        chromeLogsTail: chromeLogs.slice(-80)
      }
    };

    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`[brain:e2e] evidence -> ${path.relative(ROOT_DIR, evidencePath)}`);
    console.log(`[brain:e2e] summary: passed=${passedCount} failed=${failedCount}`);
  }

  if (fatalError) {
    throw new Error(fatalError);
  }
}

main().catch((err) => {
  console.error(`[brain:e2e] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
