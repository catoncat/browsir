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
      const systemMessage = messages.find((item) => item?.role === "system");
      const systemText = String(systemMessage?.content || "");
      const userText = String(lastUser?.content || "");

      // 处理标题总结请求
      if (systemText.includes("生成一个非常简短、精准的标题")) {
        await sleep(220);
        return buildSseResponse([
          {
            choices: [
              {
                delta: {
                  content: "AI 总结的标题"
                }
              }
            ]
          },
          "[DONE]"
        ]);
      }
      const delayMatch = /#LLM_DELAY_(\d{2,5})/.exec(userText);
      const delayMs = delayMatch ? Math.max(0, Math.min(10_000, Number(delayMatch[1]))) : 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
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

      if (userText.includes("#LLM_RETRY_AFTER_CAP")) {
        return new Response(
          JSON.stringify({
            error: {
              type: "rate_limit",
              message: "Your quota will reset after 120s"
            }
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "120"
            }
          }
        );
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

      if (userText.includes("#LLM_BASH_TIMEOUT_RECOVER")) {
        const sawRecoveredOutput = toolMessages.some((content) => content.includes("RECOVERED"));
        const sawRetryableSignal = toolMessages.some(
          (content) => content.includes('"retryable":true') || content.includes('"errorCode":"E_TIMEOUT"')
        );

        if (!hasToolResult) {
          return buildSseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_bash_timeout_1",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: "sleep 1; echo FIRST_ATTEMPT",
                            timeoutMs: 250
                          })
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

        if (!sawRecoveredOutput && sawRetryableSignal) {
          return buildSseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_bash_timeout_2",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: "sleep 1; echo RECOVERED",
                            timeoutMs: 2600
                          })
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
                  content: sawRecoveredOutput ? "LLM_BASH_TIMEOUT_RECOVER_SUCCESS" : "LLM_BASH_TIMEOUT_RECOVER_INCOMPLETE"
                }
              }
            ]
          },
          "[DONE]"
        ]);
      }

      if (userText.includes("#LLM_CDP_VERIFY_FAIL_CONTINUE")) {
        if (!hasToolResult) {
          return buildSseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_cdp_verify_fail_1",
                        type: "function",
                        function: {
                          name: "browser_action",
                          arguments: JSON.stringify({
                            kind: "navigate",
                            url: "about:blank#cdp-verify-fail-continue",
                            expect: {
                              textIncludes: "__EXPECT_TEXT_THAT_WILL_NOT_EXIST__"
                            }
                          })
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
                  content: "LLM_CDP_VERIFY_RECOVERED"
                }
              }
            ]
          },
          "[DONE]"
        ]);
      }

      if (userText.includes("#LLM_RETRY_CIRCUIT")) {
        const failCount = toolMessages.filter((content) => content.includes('"errorCode":"E_TIMEOUT"')).length;
        return buildSseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_bash_circuit_${failCount + 1}`,
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({
                          command: "sleep 1; echo CIRCUIT",
                          timeoutMs: 200
                        })
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

    await runCase("brain.runtime", "LLM 工具超时后可按失败信号调整 timeout 重试成功", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex",
          llmTimeoutMs: 10_000,
          llmRetryMaxAttempts: 2
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "触发工具超时后重试 #LLM_BASH_TIMEOUT_RECOVER"
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "sessionId 为空");

      const dump = await waitFor(
        "brain.debug.dump tool-timeout-retry trace",
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
        40_000,
        250
      );

      const stream = Array.isArray(dump.stepStream) ? dump.stepStream : [];
      assert(
        stream.some((item: any) => item?.type === "step_finished" && item?.payload?.mode === "tool_call" && item?.payload?.ok === false),
        "应先出现一次失败的 tool_call"
      );
      assert(
        stream.some((item: any) => item?.type === "step_finished" && item?.payload?.mode === "tool_call" && item?.payload?.ok === true),
        "应出现后续成功的 tool_call"
      );
      assert(
        stream.some((item: any) => item?.type === "loop_done" && item?.payload?.status === "done"),
        "工具超时重试场景应最终 done"
      );

      const requests = mockLlm!.getRequests();
      assert(requests.length >= 3, `预期 >=3 次 LLM 请求，实际=${requests.length}`);
      const toolMessagesJoined = requests.flatMap((req) => req.toolMessages).join("\n");
      assert(toolMessagesJoined.includes('"retryable":true'), "失败 tool payload 应包含 retryable=true 提示");
      assert(toolMessagesJoined.includes("RECOVERED"), "后续 tool 结果应包含 RECOVERED");
    });

    await runCase("brain.runtime", "CDP 失败后不中断，LLM 可继续推进并完成", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex",
          llmTimeoutMs: 10_000,
          llmRetryMaxAttempts: 2
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "触发 cdp verify 失败但应继续 #LLM_CDP_VERIFY_FAIL_CONTINUE"
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "sessionId 为空");

      const dump = await waitFor(
        "brain.debug.dump cdp-failure-continue trace",
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
        40_000,
        250
      );

      const stream = Array.isArray(dump.stepStream) ? dump.stepStream : [];
      const loopDoneEvent = stream.find((item: any) => item?.type === "loop_done");
      const loopStatus = String(loopDoneEvent?.payload?.status || "");
      const failedToolStep = stream.find(
        (item: any) => item?.type === "step_finished" && item?.payload?.mode === "tool_call" && item?.payload?.ok === false
      );
      const loopErrorEvent = stream.find((item: any) => item?.type === "loop_error");
      const requests = mockLlm!.getRequests();
      const toolMessagesJoined = requests.flatMap((req) => req.toolMessages).join("\n");
      assert(
        loopStatus === "done",
        `CDP 失败后应允许继续并最终 done，当前=${loopStatus || "unknown"}; failedStep=${JSON.stringify(
          failedToolStep?.payload || {}
        )}; loopError=${JSON.stringify(loopErrorEvent?.payload || {})}; payload=${toolMessagesJoined.slice(0, 500)}`
      );

      assert(requests.length >= 2, `预期 >=2 次 LLM 请求，实际=${requests.length}`);
      assert(requests.some((req) => req.hasToolResult), "后续 LLM 请求应收到 tool failure payload");
      assert(
        toolMessagesJoined.includes('"errorReason":"failed_verify"') || toolMessagesJoined.includes('"errorReason":"failed_execute"'),
        "tool failure payload 应包含失败原因"
      );
      assert(toolMessagesJoined.includes('"tool":"browser_action"'), "tool failure payload 应标识 browser_action");
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
          if (!(textarea instanceof HTMLTextAreaElement)) return { ok: false, error: "textarea missing" };
          if (textarea.disabled) return { ok: false, error: "textarea disabled" };
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

      await sendPromptByUi(`请回复第一条结果 ${marker}-1 #LLM_DELAY_1800`);

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

      const userEditReady = await waitFor(
        "panel user edit action ready",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const editBtns = Array.from(document.querySelectorAll('button[aria-label="编辑并重跑"]'));
            const enabledCount = editBtns.filter((btn) => btn instanceof HTMLButtonElement && !btn.disabled).length;
            return {
              editCount: editBtns.length,
              enabledCount
            };
          })()`);
          if ((out?.editCount || 0) < 1) return null;
          if ((out?.enabledCount || 0) < 1) return null;
          return out;
        },
        12_000,
        200
      );
      assert((userEditReady?.editCount || 0) >= 1, "user 消息应显示编辑并重跑按钮");
      assert((userEditReady?.enabledCount || 0) >= 1, "user 消息编辑按钮应处于可点击状态");

      const sessionsBeforeLatestUserEdit = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
      assert(sessionsBeforeLatestUserEdit.ok === true, "编辑最后一条 user 前读取会话列表失败");
      const sourceSessionIdBeforeLatestEdit = String((sessionsBeforeLatestUserEdit.data?.sessions || [])[0]?.id || "");
      assert(sourceSessionIdBeforeLatestEdit.length > 0, "编辑最后一条 user 前会话为空");
      const sessionCountBeforeLatestEdit = Number((sessionsBeforeLatestUserEdit.data?.sessions || []).length || 0);

      const sourceViewBeforeLatestEdit = await sendBgMessage(sidepanelClient!, {
        type: "brain.session.view",
        sessionId: sourceSessionIdBeforeLatestEdit
      });
      assert(sourceViewBeforeLatestEdit.ok === true, "编辑最后一条 user 前读取会话详情失败");
      const sourceMessagesBeforeLatestEdit = Array.isArray(sourceViewBeforeLatestEdit.data?.conversationView?.messages)
        ? sourceViewBeforeLatestEdit.data.conversationView.messages
        : [];
      const latestUserBeforeEdit = [...sourceMessagesBeforeLatestEdit]
        .reverse()
        .find((item: any) => String(item?.role || "") === "user" && String(item?.entryId || "").trim());
      const latestUserEntryIdBeforeEdit = String(latestUserBeforeEdit?.entryId || "");
      assert(latestUserEntryIdBeforeEdit.length > 0, "编辑最后一条 user 前未找到目标 user");
      const dumpBeforeLatestEdit = await sendBgMessage(sidepanelClient!, {
        type: "brain.debug.dump",
        sessionId: sourceSessionIdBeforeLatestEdit
      });
      assert(dumpBeforeLatestEdit.ok === true, "编辑最后一条 user 前读取 trace 失败");
      const streamBeforeLatestEdit = Array.isArray(dumpBeforeLatestEdit.data?.stepStream) ? dumpBeforeLatestEdit.data.stepStream : [];
      const regenerateCountBeforeLatestEdit = streamBeforeLatestEdit.filter((item: any) => item?.type === "input.regenerate").length;
      const loopDoneCountBeforeLatestEdit = streamBeforeLatestEdit.filter((item: any) => item?.type === "loop_done").length;

      const editedLatestText = `请回复第一条结果 ${marker}-1(编辑版) #LLM_DELAY_1800`;
      await waitFor(
        "panel latest user edit button ready",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const sourceEntryId = ${JSON.stringify(latestUserEntryIdBeforeEdit)};
            const btn = document.querySelector('button[aria-label="编辑并重跑"][data-entry-id="' + sourceEntryId + '"]');
            if (!(btn instanceof HTMLButtonElement)) return null;
            return btn.disabled ? null : true;
          })()`);
          return out === true ? true : null;
        },
        12_000,
        120
      );
      const userInlineEditSubmitted = await sidepanelClient!.evaluate(`(async () => {
        const sourceEntryId = ${JSON.stringify(latestUserEntryIdBeforeEdit)};
        const target = document.querySelector('button[aria-label="编辑并重跑"][data-entry-id="' + sourceEntryId + '"]');
        if (!(target instanceof HTMLButtonElement)) return { ok: false, error: "edit button missing for latest user" };
        if (target.disabled) return { ok: false, error: "edit button disabled for latest user" };
        const item = target.closest('[role="listitem"]');
        if (!item) return { ok: false, error: "message listitem missing" };
        const composer = document.querySelector('textarea[aria-label="消息输入框"]');
        const composerValueBefore = composer && typeof composer.value === "string" ? String(composer.value || "") : "";
        target.click();
        let inlineInput = null;
        for (let i = 0; i < 50; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const node = item.querySelector('[data-testid="user-inline-editor-input"]') || document.querySelector('[data-testid="user-inline-editor-input"]');
          if (node instanceof HTMLTextAreaElement) {
            inlineInput = node;
            break;
          }
        }
        if (!(inlineInput instanceof HTMLTextAreaElement)) {
          return { ok: false, error: "inline editor input missing" };
        }
        const focused = document.activeElement === inlineInput;
        const inlineValueBefore = String(inlineInput.value || "");
        inlineInput.value = ${JSON.stringify(editedLatestText)};
        inlineInput.dispatchEvent(new Event("input", { bubbles: true }));
        const submitBtn = item.querySelector('button[aria-label="提交编辑并重跑"]');
        if (!(submitBtn instanceof HTMLButtonElement)) {
          return { ok: false, error: "inline submit button missing" };
        }
        submitBtn.click();
        const composerValueAfter = composer && typeof composer.value === "string" ? String(composer.value || "") : "";
        return {
          ok: true,
          focused,
          inlineValueBefore,
          composerValueBefore,
          composerValueAfter
        };
      })()`);
      assert(userInlineEditSubmitted?.ok === true, `inline 编辑最后一条 user 失败: ${userInlineEditSubmitted?.error || "unknown"}`);
      assert(
        String(userInlineEditSubmitted?.inlineValueBefore || "").includes(`${marker}-1`),
        "inline editor 初始值应为该 user 消息内容"
      );
      assert(userInlineEditSubmitted?.focused === true, "inline editor 打开后应自动聚焦");
      assert(
        String(userInlineEditSubmitted?.composerValueBefore || "") === String(userInlineEditSubmitted?.composerValueAfter || ""),
        "底部输入框不应被 inline 编辑回填覆盖"
      );

      await waitFor(
        "panel latest user edit rerun placeholder",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const regen = document.querySelector('[data-testid="regenerate-placeholder"]');
            if (regen) {
              const mode = String(regen.getAttribute("data-mode") || "");
              const busy = String(regen.getAttribute("aria-busy") || "") === "true";
              if (busy) return { mode, source: "placeholder" };
            }
            const tool = document.querySelector('[data-testid="tool-running-placeholder"]');
            if (tool) return { mode: "retry", source: "tool_pending" };
            const streaming = document.querySelector('[data-testid="assistant-streaming-message"]');
            if (streaming) return { mode: "retry", source: "assistant_streaming" };
            return null;
          })()`);
          if (!out) return null;
          if (String(out.mode || "") !== "retry") return null;
          return out;
        },
        12_000,
        200
      );

      await waitFor(
        "panel latest user edit rerun trace visible",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId: sourceSessionIdBeforeLatestEdit
          });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const regenerateCount = stream.filter((item: any) => item?.type === "input.regenerate").length;
          const loopDoneCount = stream.filter((item: any) => item?.type === "loop_done").length;
          const hit = stream.slice(regenerateCountBeforeLatestEdit).some(
            (item: any) => item?.type === "input.regenerate" && item?.payload?.reason === "edit_user_rerun" && item?.payload?.mode === "retry"
          );
          if (!hit) return null;
          if (regenerateCount <= regenerateCountBeforeLatestEdit) return null;
          if (loopDoneCount <= loopDoneCountBeforeLatestEdit) return null;
          return true;
        },
        45_000,
        250
      );

      const sessionsAfterLatestUserEdit = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
      assert(sessionsAfterLatestUserEdit.ok === true, "编辑最后一条 user 后读取会话列表失败");
      const sessionCountAfterLatestEdit = Number((sessionsAfterLatestUserEdit.data?.sessions || []).length || 0);
      assert(
        sessionCountAfterLatestEdit === sessionCountBeforeLatestEdit,
        `编辑最后一条 user 不应新建会话，期望 ${sessionCountBeforeLatestEdit}，实际 ${sessionCountAfterLatestEdit}`
      );

      await sendPromptByUi(`请回复第二条结果 ${marker}-2 #LLM_DELAY_1800`);

      const multiAssistantReady = await waitFor(
        "panel two assistant actions ready",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const retryBtns = Array.from(document.querySelectorAll('button[aria-label="重新回答"]'));
            const forkBtns = Array.from(document.querySelectorAll('button[aria-label="在新对话中分叉"]'));
            const copyBtns = Array.from(document.querySelectorAll('button[aria-label="复制内容"], button[aria-label="已复制"]'));
            const enabledForkCount = forkBtns.filter((btn) => btn instanceof HTMLButtonElement && !btn.disabled).length;
            return {
              retryCount: retryBtns.length,
              forkCount: forkBtns.length,
              copyCount: copyBtns.length,
              enabledForkCount
            };
          })()`);
          if ((out?.retryCount || 0) < 1) return null;
          if ((out?.forkCount || 0) < 1) return null;
          if ((out?.copyCount || 0) < 1) return null;
          if ((out?.enabledForkCount || 0) < 1) return null;
          return out;
        },
        35_000,
        250
      );
      assert((multiAssistantReady?.retryCount || 0) === 1, "仅最后一条 assistant 应显示重新回答按钮");
      assert((multiAssistantReady?.forkCount || 0) >= 1, "assistant 未显示分叉按钮");
      assert((multiAssistantReady?.enabledForkCount || 0) >= 1, "assistant 分叉按钮应处于可点击状态");

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

      await waitFor(
        "panel historical fork button enabled",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const buttons = Array.from(document.querySelectorAll('button[aria-label="在新对话中分叉"]'));
            return buttons.some((btn) => btn instanceof HTMLButtonElement && !btn.disabled) ? true : null;
          })()`);
          return out === true ? true : null;
        },
        12_000,
        120
      );

      const sessionCountBeforeFork = Number((await sendBgMessage(sidepanelClient!, { type: "brain.session.list" })).data?.sessions?.length || 0);

      const forkClicked = await sidepanelClient!.evaluate(`(async () => {
        for (let i = 0; i < 30; i += 1) {
          const forkBtns = Array.from(document.querySelectorAll('button[aria-label="在新对话中分叉"]'));
          if (forkBtns.length < 1) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            continue;
          }
          const enabledForkBtns = forkBtns.filter((btn) => btn instanceof HTMLButtonElement && !btn.disabled);
          if (enabledForkBtns.length < 1) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            continue;
          }
          const firstEnabled = enabledForkBtns[0];
          const lastEnabled = enabledForkBtns[enabledForkBtns.length - 1];
          if (!(firstEnabled instanceof HTMLButtonElement)) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            continue;
          }
          firstEnabled.click();
          return {
            ok: true,
            forkCount: forkBtns.length,
            enabledForkCount: enabledForkBtns.length,
            clickedHistorical: enabledForkBtns.length > 1 ? firstEnabled !== lastEnabled : true,
            sourceEntryId: String(firstEnabled.getAttribute("data-entry-id") || "")
          };
        }
        return { ok: false, error: "history fork button disabled" };
      })()`);
      assert(forkClicked?.ok === true, `点击历史分叉失败: ${forkClicked?.error || "unknown"}`);
      if ((forkClicked?.enabledForkCount || 0) > 1) {
        assert(forkClicked?.clickedHistorical === true, "未点击到历史 assistant 的分叉按钮");
      }

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
      const forkSessionId = String(newestFork?.id || "");
      assert(String(newestFork?.title || "").includes("重答分支"), "分叉会话标题应包含“重答分支”");
      assert(String(newestFork?.forkedFrom?.sessionId || "").length > 0, "分叉会话应包含 fork 来源 sessionId");
      assert(forkSessionId.length > 0, "分叉会话 sessionId 为空");

      await waitFor(
        "panel header shows fork source",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const node = document.querySelector('[data-testid="fork-session-indicator"]');
            if (!(node instanceof HTMLElement)) return null;
            const label = String(node.getAttribute("aria-label") || "");
            return { label };
          })()`);
          return String(out?.label || "").includes("来自分叉") ? true : null;
        },
        10_000,
        200
      );

      const expectedForkSourceEntryId = String(forkClicked?.sourceEntryId || "");

      await waitFor(
        "panel fork auto regenerate placeholder visible",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const regen = document.querySelector('[data-testid="regenerate-placeholder"]');
            if (regen) {
              const text = String(regen.textContent || "");
              const busy = String(regen.getAttribute("aria-busy") || "") === "true";
              const mode = String(regen.getAttribute("data-mode") || "");
              const sourceEntryId = String(regen.getAttribute("data-source-entry-id") || "");
              const hasSpinner = Boolean(regen.querySelector('[data-testid="regenerate-spinner"]'));
              if (!text.includes("正在重新生成回复…")) return null;
              if (!busy || !hasSpinner) return null;
              return { mode, sourceEntryId, source: "placeholder" };
            }
            const tool = document.querySelector('[data-testid="tool-running-placeholder"]');
            if (tool) return { mode: "fork", sourceEntryId: "", source: "tool_pending" };
            const streaming = document.querySelector('[data-testid="assistant-streaming-message"]');
            if (streaming) return { mode: "fork", sourceEntryId: "", source: "assistant_streaming" };
            const hasRetry = document.querySelectorAll('button[aria-label="重新回答"]').length > 0;
            const hasCopy = document.querySelectorAll('button[aria-label="复制内容"], button[aria-label="已复制"]').length > 0;
            if (hasRetry && hasCopy) return { mode: "fork", sourceEntryId: "", source: "already_done" };
            return null;
          })()`);
          if (!out) return null;
          if (String(out.mode || "") !== "fork") return null;
          if (
            String(out.source || "") === "placeholder" &&
            expectedForkSourceEntryId &&
            String(out.sourceEntryId || "") !== expectedForkSourceEntryId
          ) {
            return null;
          }
          return out;
        },
        12_000,
        200
      );

      await waitFor(
        "panel fork auto regenerate trace visible",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId: forkSessionId
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
      const viewBeforeRetry = await sendBgMessage(sidepanelClient!, {
        type: "brain.session.view",
        sessionId: retrySessionId
      });
      assert(viewBeforeRetry.ok === true, "重试前读取会话详情失败");
      const messagesBeforeRetry = Array.isArray(viewBeforeRetry.data?.conversationView?.messages)
        ? viewBeforeRetry.data.conversationView.messages
        : [];
      const lastAssistantBeforeRetry = [...messagesBeforeRetry]
        .reverse()
        .find((item: any) => String(item?.role || "") === "assistant" && String(item?.entryId || "").trim());
      const assistantEntryIdBeforeRetry = String(lastAssistantBeforeRetry?.entryId || "");
      assert(assistantEntryIdBeforeRetry.length > 0, "重试前未找到 assistant entryId");
      const dumpBeforeRetryTrace = await sendBgMessage(sidepanelClient!, {
        type: "brain.debug.dump",
        sessionId: retrySessionId
      });
      assert(dumpBeforeRetryTrace.ok === true, "重试前读取 stepStream 失败");
      const streamBeforeRetryTrace = Array.isArray(dumpBeforeRetryTrace.data?.stepStream) ? dumpBeforeRetryTrace.data.stepStream : [];
      const regenerateCountBeforeRetry = streamBeforeRetryTrace.filter((item: any) => item?.type === "input.regenerate").length;
      const loopDoneCountBeforeRetry = streamBeforeRetryTrace.filter((item: any) => item?.type === "loop_done").length;

      const retryClicked = await sidepanelClient!.evaluate(`(() => {
        const retryBtns = Array.from(document.querySelectorAll('button[aria-label="重新回答"]'));
        if (retryBtns.length < 1) return { ok: false, error: "retry button missing" };
        const last = retryBtns[retryBtns.length - 1];
        if (!last) return { ok: false, error: "retry button empty" };
        if (last.disabled) return { ok: false, error: "retry button disabled" };
        last.click();
        return { ok: true, sourceEntryId: String(last.getAttribute("data-entry-id") || "") };
      })()`);
      assert(retryClicked?.ok === true, `点击最后一条重试失败: ${retryClicked?.error || "unknown"}`);
      assert(
        String(retryClicked?.sourceEntryId || "") === assistantEntryIdBeforeRetry,
        "重试按钮 entryId 应与最后一条 assistant 一致"
      );

      await waitFor(
        "panel retry placeholder visible",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const regen = document.querySelector('[data-testid="regenerate-placeholder"]');
            if (regen) {
              const text = String(regen.textContent || "");
              const busy = String(regen.getAttribute("aria-busy") || "") === "true";
              const mode = String(regen.getAttribute("data-mode") || "");
              const sourceEntryId = String(regen.getAttribute("data-source-entry-id") || "");
              const hasSpinner = Boolean(regen.querySelector('[data-testid="regenerate-spinner"]'));
              if (!text.includes("正在重新生成回复…")) return null;
              if (!busy || !hasSpinner) return null;
              return { mode, sourceEntryId, source: "placeholder" };
            }
            const tool = document.querySelector('[data-testid="tool-running-placeholder"]');
            if (tool) return { mode: "retry", sourceEntryId: "", source: "tool_pending" };
            const streaming = document.querySelector('[data-testid="assistant-streaming-message"]');
            if (streaming) return { mode: "retry", sourceEntryId: "", source: "assistant_streaming" };
            return null;
          })()`);
          if (!out) return null;
          if (String(out.mode || "") !== "retry") return null;
          if (
            String(out.source || "") === "placeholder" &&
            String(out.sourceEntryId || "") !== assistantEntryIdBeforeRetry
          ) {
            return null;
          }
          return out;
        },
        12_000,
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
          const regenerateCount = stream.filter((item: any) => item?.type === "input.regenerate").length;
          const loopDoneCount = stream.filter((item: any) => item?.type === "loop_done").length;
          if (regenerateCount <= regenerateCountBeforeRetry) return null;
          if (loopDoneCount <= loopDoneCountBeforeRetry) return null;
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
      const viewAfterRetry = await sendBgMessage(sidepanelClient!, {
        type: "brain.session.view",
        sessionId: retrySessionId
      });
      assert(viewAfterRetry.ok === true, "重试后读取会话详情失败");
      const messagesAfterRetry = Array.isArray(viewAfterRetry.data?.conversationView?.messages)
        ? viewAfterRetry.data.conversationView.messages
        : [];
      const lastAssistantAfterRetry = [...messagesAfterRetry]
        .reverse()
        .find((item: any) => String(item?.role || "") === "assistant" && String(item?.entryId || "").trim());
      const assistantEntryIdAfterRetry = String(lastAssistantAfterRetry?.entryId || "");
      assert(
        assistantEntryIdAfterRetry.length > 0 && assistantEntryIdAfterRetry !== assistantEntryIdBeforeRetry,
        `最后一条重试应生成新的 assistant entry，重试前=${assistantEntryIdBeforeRetry}，重试后=${assistantEntryIdAfterRetry}`
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

    await runCase("panel.vnext", "user inline 编辑：最后一条重跑，历史消息分叉重跑", async () => {
      const marker = `panel-user-edit-${Date.now()}`;

      const sendPromptByUi = async (text: string) => {
        const out = await sidepanelClient!.evaluate(`(() => {
          const textarea = document.querySelector('textarea[aria-label="消息输入框"]');
          if (!(textarea instanceof HTMLTextAreaElement)) return { ok: false, error: "composer missing" };
          if (textarea.disabled) return { ok: false, error: "composer disabled" };
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

      const created = await sidepanelClient!.evaluate(`(() => {
        const btn = document.querySelector('button[aria-label="开始新对话"]');
        if (!(btn instanceof HTMLButtonElement)) return { ok: false, error: "new session button missing" };
        btn.click();
        return { ok: true };
      })()`);
      assert(created?.ok === true, `点击新建对话失败: ${created?.error || "unknown"}`);
      await waitFor(
        "panel composer ready after creating new session",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const textarea = document.querySelector('textarea[aria-label="消息输入框"]');
            if (!(textarea instanceof HTMLTextAreaElement)) return null;
            return textarea.disabled ? null : true;
          })()`);
          return out === true ? true : null;
        },
        12_000,
        120
      );

      await sendPromptByUi(`请回答 ${marker}-q1 #LLM_DELAY_1800`);
      await waitFor(
        "panel first run ready for historical user edit scenario",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const retryBtns = document.querySelectorAll('button[aria-label="重新回答"]');
            const editBtns = document.querySelectorAll('button[aria-label="编辑并重跑"]');
            return {
              retryCount: retryBtns.length,
              editCount: editBtns.length
            };
          })()`);
          if (Number(out?.retryCount || 0) < 1) return null;
          if (Number(out?.editCount || 0) < 1) return null;
          return out;
        },
        45_000,
        250
      );

      await waitFor(
        "panel idle before sending second prompt",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => ({
            running: !!document.querySelector('button[aria-label="停止生成"]')
          }))()`);
          return out?.running ? null : true;
        },
        20_000,
        200
      );

      await sendPromptByUi(`请回答 ${marker}-q2 #LLM_DELAY_1800`);

      await waitFor(
        "panel second run ready for historical user edit scenario",
        async () => {
          const ui = await sidepanelClient!.evaluate(`(() => {
            const editBtns = document.querySelectorAll('button[aria-label="编辑并重跑"]');
            const retryBtns = document.querySelectorAll('button[aria-label="重新回答"]');
            return {
              editCount: editBtns.length,
              retryCount: retryBtns.length
            };
          })()`);
          if (Number(ui?.editCount || 0) < 1) return null;
          if (Number(ui?.retryCount || 0) < 1) return null;

          const listed = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
          if (!listed.ok) return null;
          const candidates = Array.isArray(listed.data?.sessions) ? listed.data.sessions : [];
          for (const candidate of candidates) {
            const currentSessionId = String(candidate?.id || "");
            if (!currentSessionId) continue;
            const viewed = await sendBgMessage(sidepanelClient!, {
              type: "brain.session.view",
              sessionId: currentSessionId
            });
            if (!viewed.ok) continue;
            const msgs = Array.isArray(viewed.data?.conversationView?.messages) ? viewed.data.conversationView.messages : [];
            const userCount = msgs.filter((item: any) => String(item?.role || "") === "user").length;
            const hasQ2 = msgs.some(
              (item: any) => String(item?.role || "") === "user" && String(item?.content || "").includes(`${marker}-q2`)
            );
            if (!hasQ2 || userCount < 2) continue;
            return { ui, userCount };
          }
          return null;
        },
        45_000,
        250
      );

      const listBeforeHistoricalEdit = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
      assert(listBeforeHistoricalEdit.ok === true, "历史 user 编辑前读取会话列表失败");
      const sessionsBeforeHistoricalEdit = Array.isArray(listBeforeHistoricalEdit.data?.sessions) ? listBeforeHistoricalEdit.data.sessions : [];
      const sessionCountBeforeHistoricalEdit = Number(sessionsBeforeHistoricalEdit.length || 0);
      let sourceSessionId = "";
      let sourceMessagesBeforeHistoricalEdit: any[] = [];
      for (const session of sessionsBeforeHistoricalEdit) {
        const candidateSessionId = String(session?.id || "");
        if (!candidateSessionId) continue;
        const viewed = await sendBgMessage(sidepanelClient!, {
          type: "brain.session.view",
          sessionId: candidateSessionId
        });
        if (!viewed.ok) continue;
        const msgs = Array.isArray(viewed.data?.conversationView?.messages) ? viewed.data.conversationView.messages : [];
        const matched = msgs.some(
          (item: any) => String(item?.role || "") === "user" && String(item?.content || "").includes(`${marker}-q2`)
        );
        if (!matched) continue;
        sourceSessionId = candidateSessionId;
        sourceMessagesBeforeHistoricalEdit = msgs;
        break;
      }
      assert(sourceSessionId.length > 0, "历史 user 编辑前未定位到目标会话");
      const sourceUsers = sourceMessagesBeforeHistoricalEdit.filter(
        (item: any) => String(item?.role || "") === "user" && String(item?.content || "").includes(`${marker}-q`)
      );
      assert(sourceUsers.length >= 2, "历史 user 编辑场景至少需要两条目标 user 消息");
      const historicalUser = sourceUsers.find((item: any) => String(item?.content || "").includes(`${marker}-q1`));
      assert(historicalUser, "未找到待编辑的历史 user(q1)");
      const historicalUserEntryId = String(historicalUser?.entryId || "");
      const historicalUserOriginalText = String(historicalUser?.content || "");
      assert(historicalUserEntryId.length > 0, "未找到历史 user entryId");

      const editedHistoricalText = `请回答 ${marker}-q1(编辑版) #LLM_DELAY_1800`;
      await waitFor(
        "panel idle before historical inline edit submit",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => ({
            running: !!document.querySelector('button[aria-label="停止生成"]')
          }))()`);
          return out?.running ? null : true;
        },
        20_000,
        200
      );

      await waitFor(
        "panel historical edit button enabled",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const sourceEntryId = ${JSON.stringify(historicalUserEntryId)};
            const btn = document.querySelector('button[aria-label="编辑并重跑"][data-entry-id="' + sourceEntryId + '"]');
            if (!(btn instanceof HTMLButtonElement)) return null;
            return btn.disabled ? null : true;
          })()`);
          return out === true ? true : null;
        },
        20_000,
        200
      );

      const historicalEditSubmitted = await sidepanelClient!.evaluate(`(async () => {
        const sourceEntryId = ${JSON.stringify(historicalUserEntryId)};
        const target = document.querySelector('button[aria-label="编辑并重跑"][data-entry-id="' + sourceEntryId + '"]');
        if (!(target instanceof HTMLButtonElement)) return { ok: false, error: "historical edit button missing" };
        if (target.disabled) return { ok: false, error: "historical edit button disabled" };
        const item = target.closest('[role="listitem"]');
        if (!item) return { ok: false, error: "historical listitem missing" };
        target.click();
        let inlineInput = null;
        for (let i = 0; i < 50; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const node = item.querySelector('[data-testid="user-inline-editor-input"]') || document.querySelector('[data-testid="user-inline-editor-input"]');
          if (node instanceof HTMLTextAreaElement) {
            inlineInput = node;
            break;
          }
        }
        if (!(inlineInput instanceof HTMLTextAreaElement)) return { ok: false, error: "historical inline input missing" };
        const focused = document.activeElement === inlineInput;
        inlineInput.value = ${JSON.stringify(editedHistoricalText)};
        inlineInput.dispatchEvent(new Event("input", { bubbles: true }));
        const submitBtn = item.querySelector('button[aria-label="提交编辑并重跑"]');
        if (!(submitBtn instanceof HTMLButtonElement)) return { ok: false, error: "historical inline submit missing" };
        submitBtn.click();
        return { ok: true, focused };
      })()`);
      assert(historicalEditSubmitted?.ok === true, `提交历史 user inline 编辑失败: ${historicalEditSubmitted?.error || "unknown"}`);
      assert(historicalEditSubmitted?.focused === true, "历史 user inline editor 打开后应自动聚焦");

      await waitFor(
        "panel historical user edit fork scene overlay visible",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const node = document.querySelector('[data-testid="chat-fork-switch-overlay"]');
            if (!(node instanceof HTMLElement)) return null;
            const phase = String(node.getAttribute("data-phase") || "");
            return phase ? { phase } : null;
          })()`);
          return out;
        },
        12_000,
        80
      );

      const sessionsAfterHistoricalEdit = await waitFor(
        "panel historical user edit creates fork session",
        async () => {
          const listed = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
          if (!listed.ok) return null;
          const sessionsNow = Array.isArray(listed.data?.sessions) ? listed.data.sessions : [];
          if (Number(sessionsNow.length || 0) !== sessionCountBeforeHistoricalEdit + 1) return null;
          return sessionsNow;
        },
        30_000,
        250
      );
      const forkSession = sessionsAfterHistoricalEdit.find(
        (item: any) =>
          String(item?.id || "") !== sourceSessionId &&
          String(item?.forkedFrom?.sessionId || "") === sourceSessionId &&
          String(item?.forkedFrom?.leafId || "") === historicalUserEntryId
      );
      const forkSessionId = String(forkSession?.id || "");
      assert(forkSessionId.length > 0, "历史 user 编辑后 fork sessionId 为空");
      assert(forkSessionId !== sourceSessionId, "历史 user 编辑后应切到分叉会话");
      assert(String(forkSession?.forkedFrom?.sessionId || "") === sourceSessionId, "分叉来源 sessionId 不正确");
      assert(String(forkSession?.forkedFrom?.leafId || "").length > 0, "分叉来源 leafId 为空");

      await waitFor(
        "panel historical user edit shows fork source indicator",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const node = document.querySelector('[data-testid="fork-session-indicator"]');
            if (!(node instanceof HTMLElement)) return null;
            const label = String(node.getAttribute("aria-label") || "");
            const jumpButton = Array.from(document.querySelectorAll("button")).find((btn) =>
              String(btn.textContent || "").includes("跳回来源对话")
            );
            return {
              label,
              hasJump: jumpButton instanceof HTMLButtonElement
            };
          })()`);
          if (!out) return null;
          if (!String(out.label || "").includes("来自分叉")) return null;
          return out.hasJump ? out : null;
        },
        12_000,
        200
      );

      await waitFor(
        "panel historical user edit trace visible",
        async () => {
          const dump = await sendBgMessage(sidepanelClient!, {
            type: "brain.debug.dump",
            sessionId: forkSessionId
          });
          if (!dump.ok) return null;
          const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
          const hit = stream.some(
            (item: any) => item?.type === "input.regenerate" && item?.payload?.reason === "edit_user_rerun" && item?.payload?.mode === "fork"
          );
          const hasLoopDone = stream.some((item: any) => item?.type === "loop_done");
          if (!hit || !hasLoopDone) return null;
          return true;
        },
        45_000,
        250
      );

      const forkView = await sendBgMessage(sidepanelClient!, {
        type: "brain.session.view",
        sessionId: forkSessionId
      });
      assert(forkView.ok === true, "读取分叉会话详情失败");
      const forkMessages = Array.isArray(forkView.data?.conversationView?.messages) ? forkView.data.conversationView.messages : [];
      const forkUsers = forkMessages.filter((item: any) => String(item?.role || "") === "user");
      assert(
        forkUsers.some((item: any) => String(item?.content || "") === editedHistoricalText),
        `分叉会话应包含编辑后的 user 文本，期望=${editedHistoricalText}`
      );
      assert(
        !forkUsers.some((item: any) => String(item?.content || "") === historicalUserOriginalText),
        "分叉会话不应保留被编辑 user 的原文本"
      );

      const sourceViewAfterHistoricalEdit = await sendBgMessage(sidepanelClient!, {
        type: "brain.session.view",
        sessionId: sourceSessionId
      });
      assert(sourceViewAfterHistoricalEdit.ok === true, "读取原会话详情失败");
      const sourceMessagesAfterHistoricalEdit = Array.isArray(sourceViewAfterHistoricalEdit.data?.conversationView?.messages)
        ? sourceViewAfterHistoricalEdit.data.conversationView.messages
        : [];
      const firstSourceUserAfter = sourceMessagesAfterHistoricalEdit.find(
        (item: any) => String(item?.role || "") === "user" && String(item?.entryId || "") === historicalUserEntryId
      );
      assert(
        String(firstSourceUserAfter?.content || "") === historicalUserOriginalText,
        "历史 user 分叉重跑不应改写原会话消息"
      );
    });

    await runCase("brain.runtime", "LLM Retry-After 超上限时应快速失败且不进入长等待重试", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex",
          llmTimeoutMs: 10_000,
          llmRetryMaxAttempts: 2,
          llmMaxRetryDelayMs: 1_000
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "触发 Retry-After 上限治理 #LLM_RETRY_AFTER_CAP"
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "sessionId 为空");

      const dump = await waitFor(
        "brain.debug.dump llm-retry-after-cap trace",
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
        20_000,
        250
      );

      const stream = Array.isArray(dump.stepStream) ? dump.stepStream : [];
      assert(
        stream.some((item: any) => item?.type === "loop_done" && item?.payload?.status === "failed_execute"),
        "Retry-After 超上限应 failed_execute 收口"
      );
      assert(
        !stream.some((item: any) => item?.type === "auto_retry_start"),
        "Retry-After 超上限不应进入自动重试"
      );
      assert(
        stream.some(
          (item: any) =>
            item?.type === "loop_error" && String(item?.payload?.message || "").includes("exceeds cap")
        ),
        "应包含超上限错误信息"
      );
    });

    await runCase("brain.runtime", "重复可恢复工具失败应触发熔断并停止循环", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex",
          llmTimeoutMs: 10_000,
          llmRetryMaxAttempts: 2
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const started = await sendBgMessage(sidepanelClient!, {
        type: "brain.run.start",
        prompt: "触发可恢复失败熔断 #LLM_RETRY_CIRCUIT"
      });
      assert(started.ok === true, `brain.run.start 失败: ${started.error || "unknown"}`);
      const sessionId = String(started.data?.sessionId || "");
      assert(sessionId.length > 0, "sessionId 为空");

      const dump = await waitFor(
        "brain.debug.dump retry-circuit trace",
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
        40_000,
        250
      );

      const stream = Array.isArray(dump.stepStream) ? dump.stepStream : [];
      assert(
        stream.some((item: any) => item?.type === "retry_circuit_open" || item?.type === "retry_budget_exhausted"),
        "应出现重试熔断或预算耗尽事件"
      );
      assert(
        stream.some((item: any) => item?.type === "loop_done" && item?.payload?.status === "failed_execute"),
        "熔断后应以 failed_execute 收口"
      );
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

    await runCase("brain.session", "session 标题生命周期：自动生成 + 菜单重刷 + 列表重命名 + 自动阈值", async () => {
      mockLlm?.clearRequests();
      const saveConfig = await sendBgMessage(sidepanelClient!, {
        type: "config.save",
        payload: {
          bridgeUrl: `ws://${BRIDGE_HOST}:${bridgePort}/ws`,
          bridgeToken,
          llmApiBase: mockLlm!.baseUrl,
          llmApiKey: "mock-key",
          llmModel: "gpt-5.3-codex",
          autoTitleInterval: 10
        }
      });
      assert(saveConfig.ok === true, `config.save 失败: ${saveConfig.error || "unknown"}`);

      const sendPromptByUi = async (text: string) => {
        const out = await sidepanelClient!.evaluate(`(() => {
          const textarea = document.querySelector('textarea[aria-label="消息输入框"]');
          if (!(textarea instanceof HTMLTextAreaElement)) return { ok: false, error: "composer missing" };
          if (textarea.disabled) return { ok: false, error: "composer disabled" };
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

      const findSessionIdByUserMarker = async (markerText: string): Promise<string> => {
        const listed = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
        if (!listed.ok) return "";
        const sessions = Array.isArray(listed.data?.sessions) ? listed.data.sessions : [];
        for (const session of sessions) {
          const candidateSessionId = String(session?.id || "");
          if (!candidateSessionId) continue;
          const viewed = await sendBgMessage(sidepanelClient!, {
            type: "brain.session.view",
            sessionId: candidateSessionId
          });
          if (!viewed.ok) continue;
          const msgs = Array.isArray(viewed.data?.conversationView?.messages) ? viewed.data.conversationView.messages : [];
          if (
            msgs.some(
              (item: any) => String(item?.role || "") === "user" && String(item?.content || "").includes(markerText)
            )
          ) {
            return candidateSessionId;
          }
        }
        return "";
      };

      const waitLoopDoneCount = async (sessionId: string, minCount: number, label: string) => {
        await waitFor(
          label,
          async () => {
            const out = await sendBgMessage(sidepanelClient!, { type: "brain.debug.dump", sessionId });
            if (!out.ok) return null;
            const stream = Array.isArray(out.data?.stepStream) ? out.data.stepStream : [];
            const loopDoneCount = stream.filter((item: any) => item?.type === "loop_done").length;
            return loopDoneCount >= minCount ? loopDoneCount : null;
          },
          35_000,
          250
        );
      };

      const getSessionRowTitle = async (sessionId: string): Promise<string> => {
        const listed = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
        if (!listed.ok) return "";
        const listedSessions = Array.isArray(listed.data?.sessions) ? listed.data.sessions : [];
        const row = listedSessions.find((item: any) => String(item?.id || "") === sessionId);
        return String(row?.title || "");
      };

      const getTitleAutoUpdateCount = async (sessionId: string): Promise<number> => {
        const dump = await sendBgMessage(sidepanelClient!, { type: "brain.debug.dump", sessionId });
        if (!dump.ok) return 0;
        const stream = Array.isArray(dump.data?.stepStream) ? dump.data.stepStream : [];
        return stream.filter((item: any) => item?.type === "session_title_auto_updated").length;
      };

      const clickMoreMenuItem = async (itemText: string, missingError: string) => {
        const out = await sidepanelClient!.evaluate(`(async () => {
          const toggle = document.querySelector('button[aria-label="打开更多菜单"], button[aria-label="关闭更多菜单"]');
          if (!(toggle instanceof HTMLButtonElement)) return { ok: false, error: "more menu toggle missing" };

          const findMenuItem = () => {
            const scopedRoot = toggle.closest("div.relative");
            const scopedCandidates = scopedRoot ? Array.from(scopedRoot.querySelectorAll('button[role="menuitem"]')) : [];
            const candidates =
              scopedCandidates.length > 0
                ? scopedCandidates
                : Array.from(document.querySelectorAll('button[role="menuitem"]'));
            return candidates.find((btn) => String(btn.textContent || "").includes(${JSON.stringify(itemText)}));
          };

          for (let i = 0; i < 60; i += 1) {
            let menuItem = findMenuItem();
            if (menuItem instanceof HTMLButtonElement && !menuItem.disabled) {
              menuItem.click();
              return { ok: true };
            }

            const expanded = String(toggle.getAttribute("aria-expanded") || "");
            if (expanded !== "true") {
              toggle.click();
            }

            await new Promise((resolve) => setTimeout(resolve, 50));
            menuItem = findMenuItem();
            if (menuItem instanceof HTMLButtonElement && !menuItem.disabled) {
              menuItem.click();
              return { ok: true };
            }
            await new Promise((resolve) => setTimeout(resolve, 30));
          }

          return { ok: false, error: ${JSON.stringify(missingError)} };
        })()`);

        assert(out?.ok === true, `点击更多菜单项失败(${itemText}): ${out?.error || "unknown"}`);
      };

      const marker = `title-life-${Date.now()}`;
      const created = await sidepanelClient!.evaluate(`(() => {
        const btn = document.querySelector('button[aria-label="开始新对话"]');
        if (!(btn instanceof HTMLButtonElement)) return { ok: false, error: "new session button missing" };
        btn.click();
        return { ok: true };
      })()`);
      assert(created?.ok === true, `点击新建对话失败: ${created?.error || "unknown"}`);
      await waitFor(
        "title lifecycle composer ready",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const textarea = document.querySelector('textarea[aria-label="消息输入框"]');
            if (!(textarea instanceof HTMLTextAreaElement)) return null;
            return textarea.disabled ? null : true;
          })()`);
          return out === true ? true : null;
        },
        12_000,
        120
      );

      await sendPromptByUi(`请帮我整理 PI 书签搜索的执行复盘 ${marker}-q1`);
      const sessionId = await waitFor(
        "title lifecycle session created",
        async () => {
          const id = await findSessionIdByUserMarker(`${marker}-q1`);
          return id || null;
        },
        35_000,
        250
      );
      assert(sessionId.length > 0, "标题生命周期场景 sessionId 为空");

      await waitLoopDoneCount(sessionId, 1, "session title auto update loop_done");
      const initialTitle = await getSessionRowTitle(sessionId);
      assert(initialTitle === "AI 总结的标题", `自动生成的标题不符合预期，预期="AI 总结的标题"，实际="${initialTitle}"`);

      const updateCountBeforeManualRefresh = await getTitleAutoUpdateCount(sessionId);
      await clickMoreMenuItem("重新生成标题", "regenerate title menu item missing");
      await waitFor(
        "header regenerating title indicator",
        async () => {
          const text = await sidepanelClient!.evaluate(`(() => document.body?.innerText || "")()`);
          return String(text).includes("正在重新生成标题") ? true : null;
        },
        10_000,
        80
      );
      await waitFor(
        "manual title refresh trace",
        async () => {
          const count = await getTitleAutoUpdateCount(sessionId);
          return count > updateCountBeforeManualRefresh ? count : null;
        },
        20_000,
        200
      );
      const afterManualRefreshTitle = await getSessionRowTitle(sessionId);
      assert(
        afterManualRefreshTitle === "AI 总结的标题",
        `手动刷新后的标题不符合预期，预期="AI 总结的标题"，实际="${afterManualRefreshTitle}"`
      );

      const renamedTitle = `我自定义的标题-${String(Date.now()).slice(-4)}`;
      const renameSubmitted = await sidepanelClient!.evaluate(`(async () => {
        const openList = document.querySelector('button[aria-label="查看会话历史列表"]');
        if (!(openList instanceof HTMLButtonElement)) return { ok: false, error: "open history list button missing" };
        openList.click();
        let activeItem = null;
        for (let i = 0; i < 30; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const activeBtn = document.querySelector('button[aria-current="true"]');
          const item =
            activeBtn?.closest("li.group") ||
            activeBtn?.closest("li") ||
            activeBtn?.closest('[role="listitem"]') ||
            activeBtn?.closest("div");
          if (item instanceof HTMLElement) {
            activeItem = item;
            break;
          }
        }
        if (!(activeItem instanceof HTMLElement)) return { ok: false, error: "active session item missing" };
        const renameBtn = activeItem.querySelector('button[aria-label^="重命名会话:"]');
        if (!(renameBtn instanceof HTMLButtonElement)) return { ok: false, error: "rename button missing" };
        renameBtn.click();
        let input = null;
        for (let i = 0; i < 30; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const node = activeItem.querySelector('input[type="text"]');
          if (node instanceof HTMLInputElement) {
            input = node;
            break;
          }
        }
        if (!(input instanceof HTMLInputElement)) return { ok: false, error: "rename input missing" };
        input.focus();
        input.value = ${JSON.stringify(renamedTitle)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          })
        );
        const closeBtn = document.querySelector('button[aria-label="关闭会话列表"]');
        if (closeBtn instanceof HTMLButtonElement) {
          closeBtn.click();
        }
        return { ok: true };
      })()`);
      assert(renameSubmitted?.ok === true, `会话列表重命名失败: ${renameSubmitted?.error || "unknown"}`);
      await waitFor(
        "renamed title persisted to session list",
        async () => {
          const current = await getSessionRowTitle(sessionId);
          return current === renamedTitle ? true : null;
        },
        20_000,
        200
      );

      await sendPromptByUi(`继续完善 ${marker}-q2`);
      await waitLoopDoneCount(sessionId, 2, "renamed title follow-up loop_done");
      const titleAfterFollow = await getSessionRowTitle(sessionId);
      assert(
        titleAfterFollow === renamedTitle,
        `手动重命名后下一轮不应被自动覆盖，期望="${renamedTitle}"，实际="${titleAfterFollow}"`
      );

      await clickMoreMenuItem("系统设置", "settings menu item missing");
      await waitFor(
        "settings dialog opened",
        async () => {
          const opened = await sidepanelClient!.evaluate(`(() => !!document.querySelector('[role="dialog"][aria-label="系统设置"]'))()`);
          return opened ? true : null;
        },
        20_000,
        120
      );
      const settingsSaved = await sidepanelClient!.evaluate(`(() => {
        const input = document.querySelector('#settings-auto-title-interval');
        if (!(input instanceof HTMLInputElement)) return { ok: false, error: "auto title interval input missing" };
        input.focus();
        input.value = "6";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const apiBaseInput = document.querySelector('#settings-api-base');
        if (apiBaseInput instanceof HTMLInputElement) {
          apiBaseInput.value = ${JSON.stringify(mockLlm!.baseUrl)};
          apiBaseInput.dispatchEvent(new Event("input", { bubbles: true }));
          apiBaseInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const apiKeyInput = document.querySelector('#settings-api-key');
        if (apiKeyInput instanceof HTMLInputElement) {
          apiKeyInput.value = "mock-key";
          apiKeyInput.dispatchEvent(new Event("input", { bubbles: true }));
          apiKeyInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const modelInput = document.querySelector('#settings-model-name');
        if (modelInput instanceof HTMLInputElement) {
          modelInput.value = "gpt-5.3-codex";
          modelInput.dispatchEvent(new Event("input", { bubbles: true }));
          modelInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const saveBtn = Array.from(document.querySelectorAll('button')).find((btn) =>
          String(btn.textContent || "").includes("Apply & Restart System")
        );
        if (!(saveBtn instanceof HTMLButtonElement)) return { ok: false, error: "settings save button missing" };
        saveBtn.click();
        return { ok: true };
      })()`);
      assert(settingsSaved?.ok === true, `设置页保存 autoTitleInterval 失败: ${settingsSaved?.error || "unknown"}`);
      await waitFor(
        "settings autoTitleInterval persisted",
        async () => {
          const cfg = await sendBgMessage(sidepanelClient!, { type: "config.get" });
          if (!cfg.ok) return null;
          return Number(cfg.data?.autoTitleInterval || 0) === 6 ? true : null;
        },
        20_000,
        200
      );
      await sidepanelClient!.evaluate(`(() => {
        const closeBtn = document.querySelector('button[aria-label="关闭设置"]');
        if (closeBtn instanceof HTMLButtonElement) {
          closeBtn.click();
          return true;
        }
        const dialog = document.querySelector('[role="dialog"][aria-label="系统设置"]');
        if (dialog instanceof HTMLElement) {
          dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }
        return true;
      })()`);

      const intervalMarker = `${marker}-interval`;
      const listedBeforeInterval = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
      assert(listedBeforeInterval.ok === true, "interval 前读取 session.list 失败");
      const knownIntervalSessionIds = new Set(
        (Array.isArray(listedBeforeInterval.data?.sessions) ? listedBeforeInterval.data.sessions : [])
          .map((item: any) => String(item?.id || ""))
          .filter(Boolean)
      );
      const createdForInterval = await sidepanelClient!.evaluate(`(() => {
        const btn = document.querySelector('button[aria-label="开始新对话"]');
        if (!(btn instanceof HTMLButtonElement)) return { ok: false, error: "new session button missing for interval case" };
        btn.click();
        return { ok: true };
      })()`);
      assert(createdForInterval?.ok === true, `创建 interval 会话失败: ${createdForInterval?.error || "unknown"}`);
      await waitFor(
        "interval composer ready",
        async () => {
          const out = await sidepanelClient!.evaluate(`(() => {
            const textarea = document.querySelector('textarea[aria-label="消息输入框"]');
            if (!(textarea instanceof HTMLTextAreaElement)) return null;
            return textarea.disabled ? null : true;
          })()`);
          return out === true ? true : null;
        },
        12_000,
        120
      );

      const intervalSessionId = await waitFor(
        "interval new session created",
        async () => {
          const listed = await sendBgMessage(sidepanelClient!, { type: "brain.session.list" });
          if (!listed.ok) return null;
          const sessions = Array.isArray(listed.data?.sessions) ? listed.data.sessions : [];
          const created = sessions.find((item: any) => {
            const id = String(item?.id || "");
            return id && !knownIntervalSessionIds.has(id);
          });
          const id = String(created?.id || "");
          return id || null;
        },
        20_000,
        200
      );
      assert(intervalSessionId.length > 0, "interval 新会话 sessionId 为空");

      await sendPromptByUi(`请回答 ${intervalMarker}-q1`);
      await waitLoopDoneCount(intervalSessionId, 1, "interval loop_done #1");
      const autoUpdatesAfterQ1 = await getTitleAutoUpdateCount(intervalSessionId);

      await sendPromptByUi(`请回答 ${intervalMarker}-q2`);
      await waitLoopDoneCount(intervalSessionId, 2, "interval loop_done #2");
      const autoUpdatesAfterQ2 = await getTitleAutoUpdateCount(intervalSessionId);
      assert(
        autoUpdatesAfterQ2 === autoUpdatesAfterQ1,
        `autoTitleInterval=6 时第二轮不应触发自动标题，q1=${autoUpdatesAfterQ1}, q2=${autoUpdatesAfterQ2}`
      );

      await sendPromptByUi(`请回答 ${intervalMarker}-q3`);
      await waitLoopDoneCount(intervalSessionId, 3, "interval loop_done #3");
      const autoUpdatesAfterQ3 = await waitFor(
        "interval auto title update #3",
        async () => {
          const count = await getTitleAutoUpdateCount(intervalSessionId);
          return count > autoUpdatesAfterQ2 ? count : null;
        },
        20_000,
        200
      );
      assert(
        autoUpdatesAfterQ3 > autoUpdatesAfterQ2,
        `autoTitleInterval=6 时第三轮应触发自动标题，q2=${autoUpdatesAfterQ2}, q3=${autoUpdatesAfterQ3}`
      );

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
