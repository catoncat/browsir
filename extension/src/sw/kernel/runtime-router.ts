import { initSessionIndex, resetSessionStore } from "./storage-reset.browser";
import { kvGet, kvSet } from "./idb-storage";
import { BrainOrchestrator } from "./orchestrator.browser";
import {
  createRuntimeInfraHandler,
  type RuntimeInfraHandler,
  type RuntimeInfraResult,
} from "./runtime-infra.browser";
import {
  createRuntimeLoopController,
  type RuntimeLoopController,
} from "./runtime-loop.browser";
import { clearVirtualFilesForSession } from "./browser-unix-runtime/lifo-adapter";
import { invokeVirtualFrame, isVirtualUri } from "./virtual-fs.browser";
import { registerExtension, type ExtensionFactory } from "./extension-api";
import type {
  AgentPluginDefinition,
  AgentPluginManifest,
  AgentPluginPermissions,
} from "./plugin-runtime";
import type { LlmProviderAdapter, LlmProviderSendInput } from "./llm-provider";
import { normalizeSkillCreateRequest } from "./skill-create";
import { handleWebChatRuntimeMessage } from "./web-chat-executor.browser";
import {
  removeSessionIndexEntry,
  removeSessionMeta,
  removeTraceRecords,
  writeSessionMeta,
} from "./session-store.browser";
import {
  nowIso,
  randomId,
  type MessageEntry,
  type SessionEntry,
  type SessionMeta,
} from "./types";
import exampleSendSuccessPluginPackage from "../../../plugins/example-send-success-global-message/plugin.json";
import exampleMissionHudDogPluginPackage from "../../../plugins/example-mission-hud-dog/plugin.json";

interface RuntimeOk<T = unknown> {
  ok: true;
  data: T;
}

interface RuntimeErr {
  ok: false;
  error: string;
}

type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

const SESSION_TITLE_MAX = 28;
const SESSION_TITLE_MIN = 2;
const SESSION_TITLE_SOURCE_MANUAL = "manual";
const DEFAULT_STEP_STREAM_MAX_EVENTS = 240;
const DEFAULT_STEP_STREAM_MAX_BYTES = 256 * 1024;
const MAX_STEP_STREAM_MAX_EVENTS = 5000;
const MAX_STEP_STREAM_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SUBAGENT_PARALLEL_TASKS = 8;
const MAX_SUBAGENT_PARALLEL_CONCURRENCY = 4;
const MAX_SUBAGENT_CHAIN_TASKS = 8;
const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 60_000;
const MAX_SUBAGENT_WAIT_TIMEOUT_MS = 300_000;
const SUBAGENT_IDLE_GRACE_MS = 150;
const CHAIN_PREVIOUS_TOKEN = "{previous}";
const DEFAULT_SKILL_DISCOVER_MAX_FILES = 256;
const MAX_SKILL_DISCOVER_MAX_FILES = 4096;
const MAX_PLUGIN_PACKAGE_READ_BYTES = 512 * 1024;
const BUILTIN_PLUGIN_ID_PREFIX = "runtime.builtin.plugin.";
const UI_EXTENSION_STORAGE_KEY = "brain.plugin.ui_extensions";
const PLUGIN_REGISTRY_STORAGE_KEY = "brain.plugin.registry:v1";
const PLUGIN_EXAMPLE_SEED_STORAGE_KEY = "brain.plugin.seed.examples:v1";
const PLUGIN_SANDBOX_DEFAULT_SESSION_ID = "plugin-studio";
const PLUGIN_SANDBOX_RUNNER_PATH = "mem://__bbl/plugin-host-runner.cjs";
const PLUGIN_SANDBOX_RESULT_PREFIX = "__BBL_PLUGIN_RESULT__";
const DEFAULT_SKILL_DISCOVER_ROOTS: Array<{ root: string; source: string }> = [
  { root: "mem://skills", source: "browser" },
];
const PLUGIN_SANDBOX_RUNNER_SOURCE = String.raw`const RESULT_PREFIX = "__BBL_PLUGIN_RESULT__";

function toRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function emit(payload) {
  process.stdout.write(RESULT_PREFIX + JSON.stringify(payload) + "\n");
}

async function loadFactory(modulePath, exportName) {
  let moduleNs;
  const moduleSourceBase64 = String(
    process.env.BBL_PLUGIN_MODULE_SOURCE_BASE64 || "",
  ).trim();
  if (moduleSourceBase64) {
    const moduleSource = Buffer.from(moduleSourceBase64, "base64").toString(
      "utf8",
    );
    const module = {
      exports: {},
    };
    const exports = module.exports;
    const normalizedPath = String(modulePath || "");
    const lastSlash = normalizedPath.lastIndexOf("/");
    const moduleDir =
      lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) || "/" : "/";
    const executeModule = new Function(
      "module",
      "exports",
      "require",
      "__filename",
      "__dirname",
      String(moduleSource || ""),
    );
    executeModule(module, exports, require, normalizedPath, moduleDir);
    moduleNs = module.exports;
  } else {
    try {
      moduleNs = require(modulePath);
    } catch (_error) {
      const fileUrl = String(modulePath || "").startsWith("file://")
        ? String(modulePath || "")
        : encodeURI("file://" + String(modulePath || ""));
      moduleNs = await import(fileUrl);
    }
  }
  const target = String(exportName || "default").trim() || "default";
  const setup = target === "default" ? ((moduleNs && moduleNs.default) || moduleNs) : moduleNs?.[target];
  if (typeof setup !== "function") {
    throw new Error("plugin module missing export: " + target);
  }
  return setup;
}

function installChromeBridge(state) {
  const baseChrome = globalThis.chrome && typeof globalThis.chrome === "object" ? globalThis.chrome : {};
  const baseRuntime = baseChrome.runtime && typeof baseChrome.runtime === "object" ? baseChrome.runtime : {};
  globalThis.chrome = {
    ...baseChrome,
    runtime: {
      ...baseRuntime,
      sendMessage(message) {
        state.runtimeMessages.push(message);
        return Promise.resolve({ ok: true });
      }
    }
  };
}

function normalizePriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

function normalizeHookDecision(result) {
  const row = toRecord(result);
  const action = String(row.action || "").trim();
  if (action === "block") {
    return {
      action: "block",
      reason: String(row.reason || "").trim() || undefined
    };
  }
  if (action === "patch") {
    return {
      action: "patch",
      patch: toRecord(row.patch)
    };
  }
  return {
    action: "continue"
  };
}

async function serializeResponse(response) {
  const headers = {};
  if (response && response.headers && typeof response.headers.forEach === "function") {
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
  }
  const bodyText = await response.text();
  return {
    status: Number(response && response.status) || 200,
    statusText: String((response && response.statusText) || ""),
    headers,
    bodyText: String(bodyText || "")
  };
}

function createApi(registry) {
  return {
    on(hook, handler, options = {}) {
      const name = String(hook || "").trim();
      if (!name || typeof handler !== "function") return;
      if (!Array.isArray(registry.hooks[name])) registry.hooks[name] = [];
      registry.sequence += 1;
      const normalizedOptions = toRecord(options);
      const entry = {
        hook: name,
        handlerId: String(normalizedOptions.id || "").trim() || name + "#" + registry.sequence,
        handler,
        options: normalizedOptions
      };
      registry.hooks[name].push(entry);
      registry.hookRegistrations.push({
        hook: entry.hook,
        handlerId: entry.handlerId,
        options: normalizedOptions
      });
    },
    registerTool(contract) {
      const row = toRecord(contract);
      const name = String(row.name || "").trim();
      if (!name) return;
      registry.tools[name] = clonePlain(row);
    },
    registerModeProvider(mode, provider) {
      const normalizedMode = String(mode || "").trim();
      const row = toRecord(provider);
      const id = String(row.id || "").trim() || "mode:" + normalizedMode;
      if (!normalizedMode || typeof provider?.invoke !== "function") return;
      registry.modeProviders[normalizedMode] = {
        provider,
        meta: {
          mode: normalizedMode,
          id,
          priority: normalizePriority(row.priority)
        }
      };
    },
    registerCapabilityProvider(capability, provider) {
      const normalizedCapability = String(capability || "").trim();
      const row = toRecord(provider);
      const id =
        String(row.id || "").trim() || "capability:" + normalizedCapability;
      if (!normalizedCapability || typeof provider?.invoke !== "function") return;
      registry.capabilityProviders[normalizedCapability] = {
        provider,
        meta: {
          capability: normalizedCapability,
          id,
          mode: String(row.mode || "").trim() || undefined,
          priority: normalizePriority(row.priority),
          hasCanHandle: typeof provider?.canHandle === "function"
        }
      };
    },
    registerCapabilityPolicy(capability, policy) {
      const normalizedCapability = String(capability || "").trim();
      if (!normalizedCapability) return;
      registry.capabilityPolicies[normalizedCapability] = clonePlain(toRecord(policy));
    },
    registerProvider(name, provider) {
      const id = String(name || "").trim();
      const staticRequestUrl = String(
        provider?.__bblStaticRequestUrl || provider?.staticRequestUrl || ""
      ).trim();
      if (
        !id ||
        !provider ||
        typeof provider !== "object" ||
        typeof provider.resolveRequestUrl !== "function" ||
        typeof provider.send !== "function"
      ) {
        return;
      }
      registry.llmProviders[id] = {
        provider,
        meta: {
          id,
          staticRequestUrl: staticRequestUrl || undefined
        }
      };
    }
  };
}

async function runHook(handlers, payload) {
  let hasPatch = false;
  const mergedPatch = {};
  let current = payload;
  for (const item of handlers) {
    const decision = normalizeHookDecision(await Promise.resolve(item.handler(current)));
    if (decision.action === "block") {
      return decision;
    }
    if (decision.action === "patch") {
      Object.assign(mergedPatch, decision.patch);
      hasPatch = true;
      if (current && typeof current === "object" && !Array.isArray(current)) {
        current = {
          ...current,
          ...decision.patch
        };
      }
    }
  }
  if (hasPatch) {
    return {
      action: "patch",
      patch: mergedPatch
    };
  }
  return {
    action: "continue"
  };
}

async function runHookRegistration(registry, hook, handlerId, payload) {
  const handlers = Array.isArray(registry.hooks[hook]) ? registry.hooks[hook] : [];
  const target = handlers.find((item) => item.handlerId === handlerId);
  if (!target) {
    throw new Error("hook registration not found: " + hook + ":" + handlerId);
  }
  return normalizeHookDecision(await Promise.resolve(target.handler(payload)));
}

(async () => {
  try {
    const modulePath = String(process.argv[2] || "").trim();
    const inputBase64 = String(process.env.BBL_PLUGIN_INPUT_BASE64 || "").trim();
    if (!modulePath || !inputBase64) {
      throw new Error("runner args missing: <module-path> + BBL_PLUGIN_INPUT_BASE64");
    }
    const rawInput = Buffer.from(inputBase64, "base64").toString("utf8");
    const input = JSON.parse(String(rawInput || "{}"));
    const state = {
      runtimeMessages: []
    };
    installChromeBridge(state);

    const registry = {
      sequence: 0,
      hooks: {},
      hookRegistrations: [],
      modeProviders: {},
      capabilityProviders: {},
      capabilityPolicies: {},
      tools: {},
      llmProviders: {}
    };
    const setup = await loadFactory(modulePath, String(input.exportName || "default"));
    await Promise.resolve(setup(createApi(registry)));

    const op = String(input.op || "describe").trim() || "describe";
    if (op === "describe") {
      emit({
        ok: true,
        hooks: Object.keys(registry.hooks),
        hookRegistrations: registry.hookRegistrations,
        modeProviders: Object.values(registry.modeProviders).map((item) => item.meta),
        capabilityProviders: Object.values(registry.capabilityProviders).map((item) => item.meta),
        capabilityPolicies: Object.entries(registry.capabilityPolicies).map(([capability, policy]) => ({
          capability,
          policy
        })),
        tools: Object.values(registry.tools),
        llmProviders: Object.values(registry.llmProviders).map((item) => item.meta)
      });
      return;
    }

    if (op === "runHook") {
      const hook = String(input.hook || "").trim();
      const handlers = Array.isArray(registry.hooks[hook]) ? registry.hooks[hook] : [];
      const hookResult = await runHook(handlers, input.payload);
      emit({
        ok: true,
        hookResult,
        runtimeMessages: state.runtimeMessages
      });
      return;
    }

    if (op === "runHookRegistration") {
      const hook = String(input.hook || "").trim();
      const handlerId = String(input.handlerId || "").trim();
      const hookResult = await runHookRegistration(registry, hook, handlerId, input.payload);
      emit({
        ok: true,
        hookResult,
        runtimeMessages: state.runtimeMessages
      });
      return;
    }

    if (op === "runModeProviderInvoke") {
      const mode = String(input.mode || "").trim();
      const target = registry.modeProviders[mode];
      if (!target) {
        throw new Error("mode provider not found: " + mode);
      }
      const data = await Promise.resolve(target.provider.invoke(input.input));
      emit({
        ok: true,
        data,
        runtimeMessages: state.runtimeMessages
      });
      return;
    }

    if (op === "runCapabilityProviderCanHandle") {
      const capability = String(input.capability || "").trim();
      const target = registry.capabilityProviders[capability];
      if (!target) {
        throw new Error("capability provider not found: " + capability);
      }
      const accepted =
        typeof target.provider.canHandle === "function"
          ? await Promise.resolve(target.provider.canHandle(input.input))
          : true;
      emit({
        ok: true,
        accepted: accepted === true,
        runtimeMessages: state.runtimeMessages
      });
      return;
    }

    if (op === "runCapabilityProviderInvoke") {
      const capability = String(input.capability || "").trim();
      const target = registry.capabilityProviders[capability];
      if (!target) {
        throw new Error("capability provider not found: " + capability);
      }
      const data = await Promise.resolve(target.provider.invoke(input.input));
      emit({
        ok: true,
        data,
        runtimeMessages: state.runtimeMessages
      });
      return;
    }

    if (op === "runLlmProviderResolveRequestUrl") {
      const providerId = String(input.providerId || "").trim();
      const target = registry.llmProviders[providerId];
      if (!target) {
        throw new Error("llm provider not found: " + providerId);
      }
      const requestUrl = await Promise.resolve(target.provider.resolveRequestUrl(input.route));
      emit({
        ok: true,
        requestUrl: String(requestUrl || ""),
        runtimeMessages: state.runtimeMessages
      });
      return;
    }

    if (op === "runLlmProviderSend") {
      const providerId = String(input.providerId || "").trim();
      const target = registry.llmProviders[providerId];
      if (!target) {
        throw new Error("llm provider not found: " + providerId);
      }
      const controller = new AbortController();
      if (input.signalAborted === true) controller.abort();
      const providerInput = {
        ...toRecord(input.input),
        signal: controller.signal
      };
      const response = await Promise.resolve(target.provider.send(providerInput));
      emit({
        ok: true,
        response: await serializeResponse(response),
        runtimeMessages: state.runtimeMessages
      });
      return;
    }

    throw new Error("unsupported op: " + op);
  } catch (error) {
    emit({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    process.exitCode = 1;
  }
})();`;

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(String(text || ""));
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function quoteForShellSingle(value: string): string {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

function ok<T>(data: T): RuntimeResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): RuntimeResult {
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

function fromInfraResult(result: RuntimeInfraResult): RuntimeResult {
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: String(result.error || "runtime infra failed") };
}

function requireSessionId(message: unknown): string {
  const payload = toRecord(message);
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId 不能为空");
  return sessionId;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.length > 0 ? out : [];
}

function parseJsonObjectText(
  value: string,
  field: string,
): Record<string, unknown> {
  const text = String(value || "").trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${field} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} 必须是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function readVirtualJsonObject(
  path: string,
  field: string,
  sessionId = "default",
): Promise<Record<string, unknown>> {
  const resolvedPath = String(path || "").trim();
  if (!resolvedPath) throw new Error(`${field} 不能为空`);
  if (!isVirtualUri(resolvedPath)) {
    throw new Error(`${field} 仅支持 mem://`);
  }
  const result = await invokeVirtualFrame({
    tool: "read",
    args: {
      path: resolvedPath,
      offset: 0,
      limit: MAX_PLUGIN_PACKAGE_READ_BYTES,
      runtime: "sandbox",
    },
    sessionId: String(sessionId || "").trim() || "default",
  });
  const payload = toRecord(result);
  if (payload.truncated === true) {
    throw new Error(
      `${field} 超过读取上限 ${MAX_PLUGIN_PACKAGE_READ_BYTES} bytes`,
    );
  }
  const content = String(payload.content || "");
  return parseJsonObjectText(content, field);
}

async function readVirtualTextFile(
  path: string,
  field: string,
  sessionId = "default",
): Promise<string> {
  const resolvedPath = String(path || "").trim();
  if (!resolvedPath) throw new Error(`${field} 不能为空`);
  if (!isVirtualUri(resolvedPath)) {
    throw new Error(`${field} 仅支持 mem://`);
  }
  const result = await invokeVirtualFrame({
    tool: "read",
    args: {
      path: resolvedPath,
      offset: 0,
      limit: MAX_PLUGIN_PACKAGE_READ_BYTES,
      runtime: "sandbox",
    },
    sessionId: String(sessionId || "").trim() || "default",
  });
  const payload = toRecord(result);
  if (payload.truncated === true) {
    throw new Error(
      `${field} 超过读取上限 ${MAX_PLUGIN_PACKAGE_READ_BYTES} bytes`,
    );
  }
  return String(payload.content || "");
}

async function writeVirtualTextFile(
  path: string,
  content: string,
  sessionId = "default",
): Promise<Record<string, unknown>> {
  const resolvedPath = String(path || "").trim();
  if (!resolvedPath) throw new Error("write path 不能为空");
  if (!isVirtualUri(resolvedPath)) {
    throw new Error("write path 仅支持 mem://");
  }
  return await invokeVirtualFrame({
    tool: "write",
    args: {
      path: resolvedPath,
      content: String(content || ""),
      mode: "overwrite",
      runtime: "sandbox",
    },
    sessionId: String(sessionId || "").trim() || "default",
  });
}

function toSafeVirtualSegment(input: unknown): string {
  const text = String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return text || "plugin";
}

function buildPluginVirtualSourcePaths(pluginId: string): {
  root: string;
  packagePath: string;
  indexPath: string;
  uiPath: string;
} {
  const segment = toSafeVirtualSegment(pluginId);
  const root = `mem://plugins/${segment}`;
  return {
    root,
    packagePath: `${root}/plugin.json`,
    indexPath: `${root}/index.js`,
    uiPath: `${root}/ui.js`,
  };
}

function emitPluginRuntimeMessage(message: unknown): void {
  try {
    const maybePromise = chrome.runtime.sendMessage(
      message as Record<string, unknown>,
    );
    if (
      maybePromise &&
      typeof (maybePromise as Promise<unknown>).catch === "function"
    ) {
      void (maybePromise as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // ignore runtime dispatch failure from plugin sandbox
  }
}

function previewJsonText(value: unknown, max = 600): string {
  let text = "";
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value ?? "");
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(80, max - 1))}…`;
}

function emitPluginHookTrace(payload: Record<string, unknown>): void {
  try {
    const maybePromise = chrome.runtime.sendMessage({
      type: "bbloop.plugin.trace",
      payload,
    });
    if (
      maybePromise &&
      typeof (maybePromise as Promise<unknown>).catch === "function"
    ) {
      void (maybePromise as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // ignore runtime dispatch failure from plugin trace
  }
}

function parsePluginSandboxResult(output: unknown): Record<string, unknown> {
  const row = toRecord(output);
  const stdout = String(row.stdout || "");
  const stderr = String(row.stderr || "");
  const exitCode = Number.isFinite(Number(row.exitCode))
    ? Number(row.exitCode)
    : -1;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = String(lines[i] || "").trim();
    if (!line.startsWith(PLUGIN_SANDBOX_RESULT_PREFIX)) continue;
    const jsonText = line.slice(PLUGIN_SANDBOX_RESULT_PREFIX.length);
    return parseJsonObjectText(jsonText, "plugin sandbox result");
  }
  const stderrPreview = stderr.replace(/\s+/g, " ").trim().slice(0, 260);
  const stdoutPreview = stdout.replace(/\s+/g, " ").trim().slice(0, 260);
  throw new Error(
    `plugin sandbox 缺少可解析结果 (exit=${exitCode}, stderr=${stderrPreview || "<empty>"}, stdout=${stdoutPreview || "<empty>"})`,
  );
}

type PluginSandboxRunnerOp =
  | "describe"
  | "runHook"
  | "runHookRegistration"
  | "runModeProviderInvoke"
  | "runCapabilityProviderCanHandle"
  | "runCapabilityProviderInvoke"
  | "runLlmProviderResolveRequestUrl"
  | "runLlmProviderSend";

async function invokePluginSandboxRunnerInBrowser(input: {
  sessionId: string;
  modulePath: string;
  exportName: string;
  op: PluginSandboxRunnerOp;
  hook?: string;
  handlerId?: string;
  mode?: string;
  capability?: string;
  providerId?: string;
  payload?: unknown;
  route?: unknown;
  signalAborted?: boolean;
  runnerInput?: unknown;
}): Promise<Record<string, unknown>> {
  const sessionId =
    String(input.sessionId || "").trim() || PLUGIN_SANDBOX_DEFAULT_SESSION_ID;
  const payload: Record<string, unknown> = {
    op: input.op,
    exportName: input.exportName,
  };
  if (input.op === "runHook" || input.op === "runHookRegistration") {
    payload.hook = String(input.hook || "").trim();
    if (input.op === "runHookRegistration") {
      payload.handlerId = String(input.handlerId || "").trim();
    }
    payload.payload = input.payload;
  }
  if (input.op === "runModeProviderInvoke") {
    payload.mode = String(input.mode || "").trim();
    payload.input = input.runnerInput;
  }
  if (
    input.op === "runCapabilityProviderCanHandle" ||
    input.op === "runCapabilityProviderInvoke"
  ) {
    payload.capability = String(input.capability || "").trim();
    payload.input = input.runnerInput;
  }
  if (input.op === "runLlmProviderResolveRequestUrl") {
    payload.providerId = String(input.providerId || "").trim();
    payload.route = input.route;
  }
  if (input.op === "runLlmProviderSend") {
    payload.providerId = String(input.providerId || "").trim();
    payload.input = input.runnerInput;
    payload.signalAborted = input.signalAborted === true;
  }
  const payloadBase64 = encodeBase64Utf8(JSON.stringify(payload));
  const moduleSourceBase64 = encodeBase64Utf8(
    await readVirtualTextFile(input.modulePath, "plugin sandbox module", sessionId),
  );
  await writeVirtualTextFile(
    PLUGIN_SANDBOX_RUNNER_PATH,
    PLUGIN_SANDBOX_RUNNER_SOURCE,
    sessionId,
  );
  const command = `BBL_PLUGIN_MODULE_SOURCE_BASE64=${quoteForShellSingle(moduleSourceBase64)} BBL_PLUGIN_INPUT_BASE64=${quoteForShellSingle(payloadBase64)} node ${PLUGIN_SANDBOX_RUNNER_PATH} ${input.modulePath}`;
  const raw = await invokeVirtualFrame({
    tool: "bash",
    args: {
      cmdId: "bash.exec",
      args: [command],
      cwd: "mem://",
      runtime: "sandbox",
    },
    sessionId,
  });
  const row = toRecord(raw);
  const parsed = parsePluginSandboxResult(row);
  if (parsed.ok !== true) {
    throw new Error(String(parsed.error || "plugin sandbox 执行失败"));
  }
  return parsed;
}

async function invokePluginSandboxRunner(input: {
  sessionId: string;
  modulePath: string;
  exportName: string;
  op: PluginSandboxRunnerOp;
  hook?: string;
  handlerId?: string;
  mode?: string;
  capability?: string;
  providerId?: string;
  payload?: unknown;
  route?: unknown;
  signalAborted?: boolean;
  runnerInput?: unknown;
}): Promise<Record<string, unknown>> {
  return await invokePluginSandboxRunnerInBrowser(input);
}

interface PluginSandboxHookRegistrationView {
  hook: string;
  handlerId: string;
  options: Record<string, unknown>;
}

interface PluginSandboxModeProviderView {
  mode: string;
  id: string;
  priority?: number;
}

interface PluginSandboxCapabilityProviderView {
  capability: string;
  id: string;
  mode?: string;
  priority?: number;
  hasCanHandle?: boolean;
}

interface PluginSandboxCapabilityPolicyView {
  capability: string;
  policy: Record<string, unknown>;
}

interface PluginSandboxLlmProviderView {
  id: string;
  staticRequestUrl?: string;
}

function normalizePluginSandboxHookRegistrations(
  input: unknown,
): PluginSandboxHookRegistrationView[] {
  if (!Array.isArray(input)) return [];
  const out: PluginSandboxHookRegistrationView[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const row = toRecord(item);
    const hook = String(row.hook || "").trim();
    const handlerId = String(row.handlerId || "").trim();
    if (!hook || !handlerId) continue;
    const key = `${hook}:${handlerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      hook,
      handlerId,
      options: toRecord(row.options),
    });
  }
  return out;
}

function normalizePluginSandboxModeProviders(
  input: unknown,
): PluginSandboxModeProviderView[] {
  if (!Array.isArray(input)) return [];
  const out: PluginSandboxModeProviderView[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const row = toRecord(item);
    const mode = String(row.mode || "").trim();
    const id = String(row.id || "").trim();
    if (!mode || !id || seen.has(mode)) continue;
    seen.add(mode);
    out.push({
      mode,
      id,
      ...(Number.isFinite(Number(row.priority))
        ? { priority: Math.floor(Number(row.priority)) }
        : {}),
    });
  }
  return out;
}

function normalizePluginSandboxCapabilityProviders(
  input: unknown,
): PluginSandboxCapabilityProviderView[] {
  if (!Array.isArray(input)) return [];
  const out: PluginSandboxCapabilityProviderView[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const row = toRecord(item);
    const capability = String(row.capability || "").trim();
    const id = String(row.id || "").trim();
    if (!capability || !id || seen.has(capability)) continue;
    seen.add(capability);
    out.push({
      capability,
      id,
      ...(String(row.mode || "").trim()
        ? { mode: String(row.mode || "").trim() }
        : {}),
      ...(Number.isFinite(Number(row.priority))
        ? { priority: Math.floor(Number(row.priority)) }
        : {}),
      ...(row.hasCanHandle === true ? { hasCanHandle: true } : {}),
    });
  }
  return out;
}

function normalizePluginSandboxCapabilityPolicies(
  input: unknown,
): PluginSandboxCapabilityPolicyView[] {
  if (!Array.isArray(input)) return [];
  const out: PluginSandboxCapabilityPolicyView[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const row = toRecord(item);
    const capability = String(row.capability || "").trim();
    if (!capability || seen.has(capability)) continue;
    seen.add(capability);
    out.push({
      capability,
      policy: toRecord(row.policy),
    });
  }
  return out;
}

function normalizePluginSandboxTools(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) return [];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const row = toRecord(item);
    const name = String(row.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(row);
  }
  return out;
}

function normalizePluginSandboxLlmProviders(
  input: unknown,
): PluginSandboxLlmProviderView[] {
  if (!Array.isArray(input)) return [];
  const out: PluginSandboxLlmProviderView[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const row = toRecord(item);
    const id = String(row.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      ...(String(row.staticRequestUrl || "").trim()
        ? { staticRequestUrl: String(row.staticRequestUrl || "").trim() }
        : {}),
    });
  }
  return out;
}

function toPluginSandboxRuntimeMessages(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function emitPluginSandboxRuntimeMessages(messages: unknown[]): void {
  for (const message of messages) {
    emitPluginRuntimeMessage(message);
  }
}

function toPluginSandboxHookResult(input: unknown): Record<string, unknown> {
  return toRecord(toRecord(input).hookResult);
}

function normalizePluginSandboxHeaders(
  input: unknown,
): Record<string, string> {
  const headers = toRecord(input);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key || "").trim();
    if (!name) continue;
    out[name] = String(value ?? "");
  }
  return out;
}

async function loadExtensionFactoryFromVirtualModule(input: {
  manifest: AgentPluginManifest;
  modulePath: string;
  exportName: string;
  sessionId: string;
}): Promise<ExtensionFactory> {
  const describe = await invokePluginSandboxRunner({
    sessionId: input.sessionId,
    modulePath: input.modulePath,
    exportName: input.exportName,
    op: "describe",
  });
  const hookRegistrations = normalizePluginSandboxHookRegistrations(
    describe.hookRegistrations,
  );
  const modeProviders = normalizePluginSandboxModeProviders(
    describe.modeProviders,
  );
  const capabilityProviders = normalizePluginSandboxCapabilityProviders(
    describe.capabilityProviders,
  );
  const capabilityPolicies = normalizePluginSandboxCapabilityPolicies(
    describe.capabilityPolicies,
  );
  const tools = normalizePluginSandboxTools(describe.tools);
  const llmProviders = normalizePluginSandboxLlmProviders(describe.llmProviders);

  return (api) => {
    for (const registration of hookRegistrations) {
      api.on(
        registration.hook as never,
        async (eventPayload: unknown) => {
          const startedAt = Date.now();
          try {
            const executed = await invokePluginSandboxRunner({
              sessionId: input.sessionId,
              modulePath: input.modulePath,
              exportName: input.exportName,
              op: "runHookRegistration",
              hook: registration.hook,
              handlerId: registration.handlerId,
              payload: eventPayload,
            });

            const runtimeMessages = toPluginSandboxRuntimeMessages(
              executed.runtimeMessages,
            );
            emitPluginSandboxRuntimeMessages(runtimeMessages);

            const hookResult = toPluginSandboxHookResult(executed);
            emitPluginHookTrace({
              traceType: "sw_hook",
              pluginId: String(input.manifest.id || "").trim(),
              hook: registration.hook,
              handlerId: registration.handlerId,
              modulePath: input.modulePath,
              exportName: input.exportName,
              sessionId: input.sessionId,
              startedAt: new Date(startedAt).toISOString(),
              durationMs: Math.max(0, Date.now() - startedAt),
              requestPreview: previewJsonText(eventPayload),
              responsePreview: previewJsonText(hookResult),
              runtimeMessageCount: runtimeMessages.length,
            });

            const action = String(hookResult.action || "").trim();
            if (action === "patch") {
              return {
                action: "patch",
                patch: toRecord(hookResult.patch),
              };
            }
            if (action === "block") {
              const reason = String(hookResult.reason || "").trim();
              return {
                action: "block",
                ...(reason ? { reason } : {}),
              };
            }
            return {
              action: "continue",
            };
          } catch (error) {
            emitPluginHookTrace({
              traceType: "sw_hook",
              pluginId: String(input.manifest.id || "").trim(),
              hook: registration.hook,
              handlerId: registration.handlerId,
              modulePath: input.modulePath,
              exportName: input.exportName,
              sessionId: input.sessionId,
              startedAt: new Date(startedAt).toISOString(),
              durationMs: Math.max(0, Date.now() - startedAt),
              requestPreview: previewJsonText(eventPayload),
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
        registration.options,
      );
    }

    for (const provider of modeProviders) {
      api.registerModeProvider(provider.mode as never, {
        id: provider.id,
        mode: provider.mode as never,
        ...(typeof provider.priority === "number"
          ? { priority: provider.priority }
          : {}),
        invoke: async (providerInput) => {
          const executed = await invokePluginSandboxRunner({
            sessionId: input.sessionId,
            modulePath: input.modulePath,
            exportName: input.exportName,
            op: "runModeProviderInvoke",
            mode: provider.mode,
            runnerInput: providerInput,
          });
          emitPluginSandboxRuntimeMessages(
            toPluginSandboxRuntimeMessages(executed.runtimeMessages),
          );
          return executed.data;
        },
      });
    }

    for (const provider of capabilityProviders) {
      api.registerCapabilityProvider(provider.capability as never, {
        id: provider.id,
        ...(provider.mode ? { mode: provider.mode as never } : {}),
        ...(typeof provider.priority === "number"
          ? { priority: provider.priority }
          : {}),
        ...(provider.hasCanHandle
          ? {
              canHandle: async (providerInput) => {
                const executed = await invokePluginSandboxRunner({
                  sessionId: input.sessionId,
                  modulePath: input.modulePath,
                  exportName: input.exportName,
                  op: "runCapabilityProviderCanHandle",
                  capability: provider.capability,
                  runnerInput: providerInput,
                });
                emitPluginSandboxRuntimeMessages(
                  toPluginSandboxRuntimeMessages(executed.runtimeMessages),
                );
                return executed.accepted === true;
              },
            }
          : {}),
        invoke: async (providerInput) => {
          const executed = await invokePluginSandboxRunner({
            sessionId: input.sessionId,
            modulePath: input.modulePath,
            exportName: input.exportName,
            op: "runCapabilityProviderInvoke",
            capability: provider.capability,
            runnerInput: providerInput,
          });
          emitPluginSandboxRuntimeMessages(
            toPluginSandboxRuntimeMessages(executed.runtimeMessages),
          );
          return executed.data;
        },
      });
    }

    for (const policy of capabilityPolicies) {
      api.registerCapabilityPolicy(policy.capability as never, policy.policy);
    }

    for (const tool of tools) {
      api.registerTool(tool as never);
    }

    for (const provider of llmProviders) {
      api.registerProvider(provider.id, {
        resolveRequestUrl(route) {
          return (
            String(provider.staticRequestUrl || "").trim() ||
            String(route.llmBase || "").trim() ||
            `plugin+sandbox://${provider.id}`
          );
        },
        send: async (sendInput: LlmProviderSendInput) => {
          let requestUrl = String(sendInput.requestUrl || "").trim();
          const fallbackRequestUrl = String(sendInput.route.llmBase || "")
            .trim();
          if (!requestUrl || requestUrl === fallbackRequestUrl) {
            const resolved = await invokePluginSandboxRunner({
              sessionId: input.sessionId,
              modulePath: input.modulePath,
              exportName: input.exportName,
              op: "runLlmProviderResolveRequestUrl",
              providerId: provider.id,
              route: sendInput.route,
            });
            emitPluginSandboxRuntimeMessages(
              toPluginSandboxRuntimeMessages(resolved.runtimeMessages),
            );
            requestUrl = String(resolved.requestUrl || "").trim() || requestUrl;
          }
          const executed = await invokePluginSandboxRunner({
            sessionId: input.sessionId,
            modulePath: input.modulePath,
            exportName: input.exportName,
            op: "runLlmProviderSend",
            providerId: provider.id,
            signalAborted: sendInput.signal.aborted,
            runnerInput: {
              sessionId: sendInput.sessionId,
              step: sendInput.step,
              route: sendInput.route,
              payload: sendInput.payload,
              ...(requestUrl ? { requestUrl } : {}),
            },
          });
          emitPluginSandboxRuntimeMessages(
            toPluginSandboxRuntimeMessages(executed.runtimeMessages),
          );
          const response = toRecord(executed.response);
          return new Response(String(response.bodyText || ""), {
            status: Number(response.status) || 200,
            statusText: String(response.statusText || ""),
            headers: normalizePluginSandboxHeaders(response.headers),
          });
        },
      });
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describePluginModuleValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (value instanceof RegExp) return "RegExp";
  if (typeof value === "function") return "function";
  if (typeof value === "object") {
    return value?.constructor?.name || "object";
  }
  return typeof value;
}

function normalizeFunctionModuleSource(
  value: (...args: any[]) => unknown,
  path: string,
): string {
  const source = Function.prototype.toString.call(value).trim();
  if (!source) {
    throw new Error(`${path} 函数源码为空`);
  }
  if (/^(async\s+)?function\b/.test(source)) {
    return `(${source})`;
  }
  if (/^(get|set)\s+[A-Za-z_$][\w$]*\s*\(/.test(source)) {
    throw new Error(`${path} 暂不支持 getter/setter 序列化`);
  }
  if (source.includes("=>")) {
    return `(${source})`;
  }
  if (/^(async\s+)?function\b/.test(source) || /^class\b/.test(source)) {
    return `(${source})`;
  }
  if (/^async\s+[A-Za-z_$][\w$]*\s*\(/.test(source)) {
    return `(async function ${source.slice("async ".length)})`;
  }
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(source)) {
    return `(function ${source})`;
  }
  return `(${source})`;
}

function serializeValueToModuleSource(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "Number.NaN";
    if (value === Number.POSITIVE_INFINITY) return "Number.POSITIVE_INFINITY";
    if (value === Number.NEGATIVE_INFINITY) return "Number.NEGATIVE_INFINITY";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") {
    return normalizeFunctionModuleSource(value, path);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) =>
        serializeValueToModuleSource(item, `${path}[${index}]`, seen),
      )
      .join(", ")}]`;
  }
  if (value instanceof Date) {
    return `new Date(${JSON.stringify(value.toISOString())})`;
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (!isPlainObject(value)) {
    throw new Error(
      `${path} 含不支持的值类型: ${describePluginModuleValue(value)}`,
    );
  }
  if (seen.has(value)) {
    throw new Error(`${path} 存在循环引用，无法持久化`);
  }
  seen.add(value);
  try {
    return `{${Object.entries(value)
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}: ${serializeValueToModuleSource(
            entryValue,
            `${path}.${key}`,
            seen,
          )}`,
      )
      .join(", ")}}`;
  } finally {
    seen.delete(value);
  }
}

function buildDeclarativeLlmProviderModuleSource(
  spec: DeclarativeLlmProviderSpec,
): string {
  const headersSource = serializeValueToModuleSource(
    spec.headers,
    `llmProviders.${spec.id}.headers`,
  );
  const requestUrl = spec.baseUrl + spec.endpointPath;
  return `{
    id: ${JSON.stringify(spec.id)},
    __bblStaticRequestUrl: ${JSON.stringify(requestUrl)},
    resolveRequestUrl(route) {
      return ${JSON.stringify(requestUrl)};
    },
    async send(input) {
      const requestUrl = String(input.requestUrl || "").trim() || this.resolveRequestUrl(input.route);
      const authHeader = (() => {
        if (${JSON.stringify(spec.authMode)} === "none") return "";
        if (${JSON.stringify(spec.authMode)} === "static_bearer") {
          return "Bearer " + ${JSON.stringify(spec.staticApiKey)};
        }
        return "Bearer " + String(input.route && input.route.llmKey || "");
      })();
      const headers = {
        "content-type": "application/json",
        ...${headersSource}
      };
      if (authHeader) {
        headers.authorization = authHeader;
      }
      return await fetch(requestUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(input.payload),
        signal: input.signal
      });
    }
  }`;
}

function buildDefinitionPluginModuleSource(
  source: Record<string, unknown>,
): string {
  const lines = ["module.exports = function registerPlugin(pi) {"];
  const hooks = toRecord(source.hooks);
  for (const [hookName, hookEntries] of Object.entries(hooks)) {
    const list = Array.isArray(hookEntries) ? hookEntries : [hookEntries];
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      const row = typeof entry === "function" ? {} : toRecord(entry);
      const handler =
        typeof entry === "function" ? entry : row.handler;
      if (typeof handler !== "function") {
        throw new Error(`plugin.hooks.${hookName}[${index}] handler 必须是函数`);
      }
      const options =
        typeof entry === "function" ? {} : toRecord(row.options);
      lines.push(
        `  pi.on(${JSON.stringify(hookName)}, ${serializeValueToModuleSource(
          handler,
          `hooks.${hookName}[${index}].handler`,
        )}, ${serializeValueToModuleSource(
          options,
          `hooks.${hookName}[${index}].options`,
        )});`,
      );
    }
  }

  const providers = toRecord(source.providers);
  const modeProviders = toRecord(providers.modes);
  for (const [mode, provider] of Object.entries(modeProviders)) {
    lines.push(
      `  pi.registerModeProvider(${JSON.stringify(mode)}, ${serializeValueToModuleSource(
        provider,
        `providers.modes.${mode}`,
      )});`,
    );
  }
  const capabilityProviders = toRecord(providers.capabilities);
  for (const [capability, provider] of Object.entries(capabilityProviders)) {
    lines.push(
      `  pi.registerCapabilityProvider(${JSON.stringify(
        capability,
      )}, ${serializeValueToModuleSource(
        provider,
        `providers.capabilities.${capability}`,
      )});`,
    );
  }

  const policies = toRecord(source.policies);
  const capabilityPolicies = toRecord(policies.capabilities);
  for (const [capability, policy] of Object.entries(capabilityPolicies)) {
    lines.push(
      `  pi.registerCapabilityPolicy(${JSON.stringify(
        capability,
      )}, ${serializeValueToModuleSource(
        policy,
        `policies.capabilities.${capability}`,
      )});`,
    );
  }

  const tools = Array.isArray(source.tools) ? source.tools : [];
  for (let index = 0; index < tools.length; index += 1) {
    lines.push(
      `  pi.registerTool(${serializeValueToModuleSource(
        tools[index],
        `tools[${index}]`,
      )});`,
    );
  }

  const llmProviders = Array.isArray(source.llmProviders)
    ? source.llmProviders
    : [];
  for (let index = 0; index < llmProviders.length; index += 1) {
    const provider = llmProviders[index];
    const row = toRecord(provider);
    const providerId = String(row.id || "").trim();
    if (!providerId) {
      throw new Error(`llmProviders[${index}] 缺少 id`);
    }
    const providerSource =
      typeof row.resolveRequestUrl === "function" &&
      typeof row.send === "function"
        ? `{
    id: ${JSON.stringify(providerId)},
    ${
      String(row.__bblStaticRequestUrl || row.staticRequestUrl || "").trim()
        ? `__bblStaticRequestUrl: ${JSON.stringify(
            String(
              row.__bblStaticRequestUrl || row.staticRequestUrl || "",
            ).trim(),
          )},`
        : ""
    }
    resolveRequestUrl: ${serializeValueToModuleSource(
      row.resolveRequestUrl,
      `llmProviders[${index}].resolveRequestUrl`,
    )},
    send: ${serializeValueToModuleSource(
      row.send,
      `llmProviders[${index}].send`,
    )}
  }`
        : buildDeclarativeLlmProviderModuleSource(
            normalizeDeclarativeLlmProviderSpec(provider),
          );
    lines.push(
      `  pi.registerProvider(${JSON.stringify(providerId)}, ${providerSource});`,
    );
  }

  lines.push("};");
  return lines.join("\n");
}

async function materializeDefinitionPluginSource(
  source: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const manifest = normalizePluginManifest(source.manifest);
  const paths = buildPluginVirtualSourcePaths(manifest.id);
  const moduleSessionId =
    String(
      source.moduleSessionId ||
        source.sessionId ||
        PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
    ).trim() || PLUGIN_SANDBOX_DEFAULT_SESSION_ID;
  const moduleSource = buildDefinitionPluginModuleSource({
    ...source,
    manifest,
  });
  await writeVirtualTextFile(paths.indexPath, moduleSource, moduleSessionId);
  const next: Record<string, unknown> = {
    manifest,
    modulePath: paths.indexPath,
    exportName: "default",
    moduleSessionId,
  };
  const copyFields = [
    "uiModuleUrl",
    "uiModulePath",
    "uiModule",
    "uiExportName",
    "uiModuleSessionId",
    "sessionId",
  ] as const;
  for (const key of copyFields) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    next[key] = value;
  }
  await writeVirtualTextFile(
    paths.packagePath,
    JSON.stringify(next, null, 2),
    moduleSessionId,
  );
  return next;
}

async function materializeExtensionFactoryPluginSource(
  source: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const manifest = normalizePluginManifest(source.manifest);
  const setup = source.setup;
  if (typeof setup !== "function") {
    throw new Error("plugin.setup 必须是函数");
  }
  const paths = buildPluginVirtualSourcePaths(manifest.id);
  const moduleSessionId =
    String(
      source.moduleSessionId ||
        source.sessionId ||
        PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
    ).trim() || PLUGIN_SANDBOX_DEFAULT_SESSION_ID;
  const moduleSource = `module.exports = ${serializeValueToModuleSource(
    setup,
    "setup",
  )};`;
  await writeVirtualTextFile(paths.indexPath, moduleSource, moduleSessionId);
  const next: Record<string, unknown> = {
    manifest,
    modulePath: paths.indexPath,
    exportName: "default",
    moduleSessionId,
  };
  const copyFields = [
    "uiModuleUrl",
    "uiModulePath",
    "uiModule",
    "uiExportName",
    "uiModuleSessionId",
    "sessionId",
  ] as const;
  for (const key of copyFields) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    next[key] = value;
  }
  await writeVirtualTextFile(
    paths.packagePath,
    JSON.stringify(next, null, 2),
    moduleSessionId,
  );
  return next;
}

async function materializeInlinePluginSources(
  source: Record<string, unknown>,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const manifest = toRecord(source.manifest);
  const pluginId = String(manifest.id || "").trim();
  if (!pluginId) return source;

  const indexJs = String(source.indexJs || "").trim();
  const uiJs = String(source.uiJs || "").trim();
  if (!indexJs && !uiJs) return source;

  const paths = buildPluginVirtualSourcePaths(pluginId);
  const next: Record<string, unknown> = {
    ...source,
  };
  const existingModulePath = String(
    source.modulePath || source.moduleUrl || source.module || "",
  ).trim();

  if (indexJs) {
    const modulePath = existingModulePath || paths.indexPath;
    await writeVirtualTextFile(modulePath, indexJs, sessionId);
    next.modulePath = modulePath;
    next.moduleSessionId = sessionId;
  }

  if (uiJs) {
    const uiModulePath =
      String(
        source.uiModulePath || source.uiModuleUrl || source.uiModule || "",
      ).trim() || paths.uiPath;
    await writeVirtualTextFile(uiModulePath, uiJs, sessionId);
    next.uiModulePath = uiModulePath;
    next.uiModuleSessionId = sessionId;
  }

  await writeVirtualTextFile(
    paths.packagePath,
    JSON.stringify(next, null, 2),
    sessionId,
  );
  return next;
}

function normalizeHeadersRecord(
  input: unknown,
  field: string,
): Record<string, string> {
  if (input === undefined || input === null) return {};
  let source: Record<string, unknown> = {};
  if (typeof input === "string") {
    source = parseJsonObjectText(input, field);
  } else {
    source = toRecord(input);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const headerName = String(key || "").trim();
    if (!headerName) continue;
    out[headerName] = String(value ?? "").trim();
  }
  return out;
}

interface DeclarativeLlmProviderSpec {
  id: string;
  transport: "openai_compatible";
  baseUrl: string;
  endpointPath: string;
  headers: Record<string, string>;
  authMode: "route_api_key" | "static_bearer" | "none";
  staticApiKey: string;
}

function normalizeDeclarativeLlmProviderSpec(
  input: unknown,
): DeclarativeLlmProviderSpec {
  const row = toRecord(input);
  const id = String(row.id || "").trim();
  if (!id) throw new Error("llm provider id 不能为空");

  const transportRaw = String(row.transport || "openai_compatible")
    .trim()
    .toLowerCase();
  if (transportRaw !== "openai_compatible") {
    throw new Error(`llm provider ${id} transport 非法: ${transportRaw}`);
  }

  const baseUrl = String(row.baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!baseUrl) throw new Error(`llm provider ${id} 需要 baseUrl`);
  if (!/^https?:\/\//i.test(baseUrl))
    throw new Error(`llm provider ${id} baseUrl 必须是 http/https URL`);

  const endpointRaw = String(
    row.endpointPath || row.path || "/chat/completions",
  ).trim();
  const endpointPath = endpointRaw.startsWith("/")
    ? endpointRaw
    : `/${endpointRaw}`;
  const authModeRaw = String(row.authMode || "route_api_key")
    .trim()
    .toLowerCase();
  const authMode =
    authModeRaw === "none" ||
    authModeRaw === "static_bearer" ||
    authModeRaw === "route_api_key"
      ? authModeRaw
      : null;
  if (!authMode)
    throw new Error(`llm provider ${id} authMode 非法: ${authModeRaw}`);

  const staticApiKey = String(row.apiKey || row.staticApiKey || "").trim();
  if (authMode === "static_bearer" && !staticApiKey) {
    throw new Error(`llm provider ${id} authMode=static_bearer 时需要 apiKey`);
  }

  return {
    id,
    transport: "openai_compatible",
    baseUrl,
    endpointPath,
    headers: normalizeHeadersRecord(row.headers, `llm provider ${id} headers`),
    authMode,
    staticApiKey,
  };
}

function createDeclarativeOpenAiCompatibleProvider(
  spec: DeclarativeLlmProviderSpec,
): LlmProviderAdapter {
  return {
    id: spec.id,
    resolveRequestUrl() {
      return `${spec.baseUrl}${spec.endpointPath}`;
    },
    async send(input: LlmProviderSendInput): Promise<Response> {
      const requestUrl =
        String(input.requestUrl || "").trim() ||
        this.resolveRequestUrl(input.route);
      const authHeader = (() => {
        if (spec.authMode === "none") return "";
        if (spec.authMode === "static_bearer")
          return `Bearer ${spec.staticApiKey}`;
        return `Bearer ${String(input.route.llmKey || "")}`;
      })();
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...spec.headers,
      };
      if (authHeader) headers.authorization = authHeader;
      return await fetch(requestUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(input.payload),
        signal: input.signal,
      });
    },
  };
}

function normalizePluginPermissions(input: unknown): AgentPluginPermissions {
  const row = toRecord(input);
  const hooks = toStringList(row.hooks);
  const modesRaw = toStringList(row.modes);
  const capabilities = toStringList(row.capabilities);
  const tools = toStringList(row.tools);
  const llmProviders = toStringList(row.llmProviders);
  const runtimeMessages = toStringList(row.runtimeMessages);
  const brainEvents = toStringList(row.brainEvents);
  const modes =
    Array.isArray(modesRaw) && modesRaw.length > 0
      ? (modesRaw.filter(
          (item) => item === "script" || item === "cdp" || item === "bridge",
        ) as Array<"script" | "cdp" | "bridge">)
      : undefined;
  return {
    ...(hooks ? { hooks } : {}),
    ...(modes ? { modes } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(tools ? { tools } : {}),
    ...(llmProviders ? { llmProviders } : {}),
    ...(runtimeMessages ? { runtimeMessages } : {}),
    ...(brainEvents ? { brainEvents } : {}),
    ...(row.replaceProviders === true ? { replaceProviders: true } : {}),
    ...(row.replaceToolContracts === true
      ? { replaceToolContracts: true }
      : {}),
    ...(row.replaceLlmProviders === true ? { replaceLlmProviders: true } : {}),
  };
}

function normalizePluginManifest(input: unknown): AgentPluginManifest {
  const row = toRecord(input);
  const id = String(row.id || "").trim();
  if (!id) throw new Error("plugin.manifest.id 不能为空");
  const name = String(row.name || "").trim() || id;
  const version = String(row.version || "").trim() || "0.0.0";
  const timeoutRaw = Number(row.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.max(50, Math.min(10_000, Math.floor(timeoutRaw)))
    : undefined;
  const permissions = normalizePluginPermissions(row.permissions);
  return {
    id,
    name,
    version,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
  };
}

function normalizePluginLlmProviders(
  input: unknown,
): LlmProviderAdapter[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: LlmProviderAdapter[] = [];
  for (const item of input) {
    const row = toRecord(item);
    const send = row.send;
    const resolveRequestUrl = row.resolveRequestUrl;
    const id = String(row.id || "").trim();
    if (
      id &&
      typeof send === "function" &&
      typeof resolveRequestUrl === "function"
    ) {
      out.push({
        id,
        send: send as LlmProviderAdapter["send"],
        resolveRequestUrl:
          resolveRequestUrl as LlmProviderAdapter["resolveRequestUrl"],
      });
      continue;
    }
    const spec = normalizeDeclarativeLlmProviderSpec(item);
    out.push(createDeclarativeOpenAiCompatibleProvider(spec));
  }
  return out;
}

function normalizePluginDefinition(input: unknown): AgentPluginDefinition {
  const row = toRecord(input);
  const manifest = normalizePluginManifest(row.manifest);
  const hooks = row.hooks as AgentPluginDefinition["hooks"] | undefined;
  const providers = row.providers as
    | AgentPluginDefinition["providers"]
    | undefined;
  const policies = row.policies as
    | AgentPluginDefinition["policies"]
    | undefined;
  const tools = Array.isArray(row.tools)
    ? (row.tools as AgentPluginDefinition["tools"])
    : undefined;
  const llmProviders = normalizePluginLlmProviders(row.llmProviders);
  return {
    manifest,
    ...(hooks ? { hooks } : {}),
    ...(providers ? { providers } : {}),
    ...(policies ? { policies } : {}),
    ...(tools ? { tools } : {}),
    ...(llmProviders ? { llmProviders } : {}),
  };
}

type PersistedPluginKind = "builtin_state" | "definition" | "extension";

interface PersistedPluginRecord {
  pluginId: string;
  kind: PersistedPluginKind;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  source?: Record<string, unknown>;
}

function clonePersistableRecord<T>(value: T): T | null {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

function normalizePersistedPluginRecord(
  input: unknown,
): PersistedPluginRecord | null {
  const row = toRecord(input);
  const kind = String(row.kind || "").trim() as PersistedPluginKind;
  if (
    kind !== "builtin_state" &&
    kind !== "definition" &&
    kind !== "extension"
  ) {
    return null;
  }
  const source = toRecord(row.source);
  const manifest = toRecord(source.manifest);
  const pluginId =
    String(row.pluginId || "").trim() || String(manifest.id || "").trim();
  if (!pluginId) return null;
  const createdAt = String(row.createdAt || "").trim() || nowIso();
  const updatedAt = String(row.updatedAt || "").trim() || createdAt;
  if (kind === "builtin_state") {
    return {
      pluginId,
      kind,
      enabled: row.enabled !== false,
      createdAt,
      updatedAt,
    };
  }
  if (Object.keys(source).length === 0) return null;
  const clonedSource = clonePersistableRecord(source);
  if (!clonedSource || typeof clonedSource !== "object") return null;
  return {
    pluginId,
    kind,
    enabled: row.enabled !== false,
    createdAt,
    updatedAt,
    source: clonedSource as Record<string, unknown>,
  };
}

async function readPersistedPluginRecords(): Promise<PersistedPluginRecord[]> {
  const raw = await kvGet(PLUGIN_REGISTRY_STORAGE_KEY);
  const list = Array.isArray(raw) ? raw : [];
  const out: PersistedPluginRecord[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const normalized = normalizePersistedPluginRecord(item);
    if (!normalized) continue;
    if (seen.has(normalized.pluginId)) continue;
    seen.add(normalized.pluginId);
    out.push(normalized);
  }
  return out;
}

async function writePersistedPluginRecords(
  list: PersistedPluginRecord[],
): Promise<void> {
  await kvSet(PLUGIN_REGISTRY_STORAGE_KEY, list);
}

async function upsertPersistedPluginRecord(
  next: PersistedPluginRecord,
): Promise<PersistedPluginRecord> {
  const list = await readPersistedPluginRecords();
  const index = list.findIndex((item) => item.pluginId === next.pluginId);
  const current = index >= 0 ? list[index] : null;
  const merged: PersistedPluginRecord = {
    ...next,
    createdAt: current?.createdAt || next.createdAt,
    updatedAt: next.updatedAt || nowIso(),
  };
  if (index >= 0) {
    list[index] = merged;
  } else {
    list.push(merged);
  }
  await writePersistedPluginRecords(list);
  return merged;
}

async function removePersistedPluginRecord(pluginId: string): Promise<boolean> {
  const id = String(pluginId || "").trim();
  if (!id) return false;
  const list = await readPersistedPluginRecords();
  const next = list.filter((item) => item.pluginId !== id);
  if (next.length === list.length) return false;
  await writePersistedPluginRecords(next);
  return true;
}

async function updatePersistedPluginEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<PersistedPluginRecord | null> {
  const id = String(pluginId || "").trim();
  if (!id) return null;
  const list = await readPersistedPluginRecords();
  const index = list.findIndex((item) => item.pluginId === id);
  if (index >= 0) {
    const next = {
      ...list[index],
      enabled,
      updatedAt: nowIso(),
    };
    list[index] = next;
    await writePersistedPluginRecords(list);
    return next;
  }
  if (!isBuiltinPluginId(id)) return null;
  const next: PersistedPluginRecord = {
    pluginId: id,
    kind: "builtin_state",
    enabled,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  list.push(next);
  await writePersistedPluginRecords(list);
  return next;
}

function buildPersistedExtensionSource(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const source: Record<string, unknown> = {};
  const manifest = clonePersistableRecord(toRecord(input.manifest));
  if (!manifest || Object.keys(manifest).length === 0) {
    return null;
  }
  source.manifest = manifest;
  const copyFields = [
    "moduleUrl",
    "modulePath",
    "module",
    "exportName",
    "moduleSessionId",
    "sessionId",
    "uiModuleUrl",
    "uiModulePath",
    "uiModule",
    "uiExportName",
    "uiModuleSessionId",
  ] as const;
  for (const key of copyFields) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value === undefined) continue;
    source[key] = value;
  }
  return source;
}

async function persistExtensionPluginRegistration(
  source: Record<string, unknown>,
  enabled: boolean,
): Promise<PersistedPluginRecord | null> {
  const persistable = buildPersistedExtensionSource(source);
  const manifest = toRecord(persistable?.manifest);
  const pluginId = String(manifest.id || "").trim();
  if (!persistable || !pluginId) return null;
  return upsertPersistedPluginRecord({
    pluginId,
    kind: "extension",
    enabled,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: persistable,
  });
}

async function persistDefinitionPluginRegistration(
  source: Record<string, unknown>,
  enabled: boolean,
): Promise<PersistedPluginRecord | null> {
  const compiledSource = await materializeDefinitionPluginSource(source);
  return await persistExtensionPluginRegistration(compiledSource, enabled);
}

function defaultExamplePluginSources(): Array<Record<string, unknown>> {
  const out: Record<string, unknown>[] = [];
  const candidates = [
    clonePersistableRecord(exampleSendSuccessPluginPackage),
    clonePersistableRecord(exampleMissionHudDogPluginPackage),
  ];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    out.push(item as Record<string, unknown>);
  }
  return out;
}

async function seedDefaultExamplePluginRecords(): Promise<void> {
  const seeded = await kvGet(PLUGIN_EXAMPLE_SEED_STORAGE_KEY);
  if (seeded) return;
  let list = await readPersistedPluginRecords();
  const knownIds = new Set(list.map((item) => item.pluginId));
  let changed = false;
  for (const source of defaultExamplePluginSources()) {
    const pluginId = String(toRecord(source.manifest).id || "").trim();
    if (!pluginId || knownIds.has(pluginId)) continue;
    list = [
      ...list,
      {
        pluginId,
        kind: "extension",
        enabled: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source,
      },
    ];
    knownIds.add(pluginId);
    changed = true;
  }
  if (changed) {
    await writePersistedPluginRecords(list);
  }
  await kvSet(PLUGIN_EXAMPLE_SEED_STORAGE_KEY, {
    version: 1,
    seededAt: nowIso(),
  });
}

interface UiExtensionDescriptor {
  pluginId: string;
  moduleUrl: string;
  exportName: string;
  enabled: boolean;
  updatedAt: string;
  sessionId?: string;
}

function normalizeUiExtensionDescriptor(
  input: unknown,
): UiExtensionDescriptor | null {
  const row = toRecord(input);
  const pluginId = String(row.pluginId || "").trim();
  const moduleUrl = String(row.moduleUrl || "").trim();
  if (!pluginId || !moduleUrl) return null;
  const exportName = String(row.exportName || "default").trim() || "default";
  const enabled = row.enabled !== false;
  const updatedAt = String(row.updatedAt || "").trim() || nowIso();
  return {
    pluginId,
    moduleUrl,
    exportName,
    enabled,
    updatedAt,
    sessionId: String(row.sessionId || "").trim() || undefined,
  };
}

async function readUiExtensionDescriptors(): Promise<UiExtensionDescriptor[]> {
  const payload = await chrome.storage.local.get(UI_EXTENSION_STORAGE_KEY);
  const list = Array.isArray(toRecord(payload)[UI_EXTENSION_STORAGE_KEY])
    ? (toRecord(payload)[UI_EXTENSION_STORAGE_KEY] as unknown[])
    : [];
  const out: UiExtensionDescriptor[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const normalized = normalizeUiExtensionDescriptor(item);
    if (!normalized) continue;
    if (seen.has(normalized.pluginId)) continue;
    seen.add(normalized.pluginId);
    out.push(normalized);
  }
  return out;
}

async function writeUiExtensionDescriptors(
  list: UiExtensionDescriptor[],
): Promise<void> {
  await chrome.storage.local.set({
    [UI_EXTENSION_STORAGE_KEY]: list,
  });
}

async function upsertUiExtensionDescriptor(
  next: UiExtensionDescriptor,
): Promise<void> {
  const list = await readUiExtensionDescriptors();
  const index = list.findIndex((item) => item.pluginId === next.pluginId);
  if (index >= 0) {
    list[index] = next;
  } else {
    list.push(next);
  }
  await writeUiExtensionDescriptors(list);
}

async function updateUiExtensionDescriptorEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<UiExtensionDescriptor | null> {
  const list = await readUiExtensionDescriptors();
  const index = list.findIndex((item) => item.pluginId === pluginId);
  if (index < 0) return null;
  const next = {
    ...list[index],
    enabled,
    updatedAt: nowIso(),
  };
  list[index] = next;
  await writeUiExtensionDescriptors(list);
  return next;
}

async function removeUiExtensionDescriptor(
  pluginId: string,
): Promise<UiExtensionDescriptor | null> {
  const list = await readUiExtensionDescriptors();
  const index = list.findIndex((item) => item.pluginId === pluginId);
  if (index < 0) return null;
  const [removed] = list.splice(index, 1);
  await writeUiExtensionDescriptors(list);
  return removed || null;
}

async function pruneUiExtensionDescriptors(
  pluginIds: Iterable<string>,
): Promise<void> {
  const allowed = new Set<string>();
  for (const pluginId of pluginIds) {
    const id = String(pluginId || "").trim();
    if (!id) continue;
    allowed.add(id);
  }
  const list = await readUiExtensionDescriptors();
  const next = list.filter((item) => allowed.has(item.pluginId));
  if (next.length === list.length) return;
  await writeUiExtensionDescriptors(next);
}

function notifyUiExtensionLifecycle(
  type:
    | "brain.plugin.ui_extension.registered"
    | "brain.plugin.ui_extension.enabled"
    | "brain.plugin.ui_extension.disabled"
    | "brain.plugin.ui_extension.unregistered",
  descriptor: UiExtensionDescriptor,
): void {
  try {
    const maybePromise = chrome.runtime.sendMessage({
      type,
      payload: descriptor,
    });
    if (
      maybePromise &&
      typeof (maybePromise as Promise<unknown>).catch === "function"
    ) {
      void (maybePromise as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // ignore
  }
}

function resolveUiExtensionDescriptorFromSource(
  pluginId: string,
  source: Record<string, unknown>,
  enabled: boolean,
): UiExtensionDescriptor | null {
  const moduleInput =
    source.uiModuleUrl ?? source.uiModulePath ?? source.uiModule;
  const hasModule =
    String(source.uiModuleUrl || "").trim().length > 0 ||
    String(source.uiModulePath || "").trim().length > 0 ||
    String(source.uiModule || "").trim().length > 0;
  if (!hasModule) return null;
  const moduleUrl = resolvePluginModuleUrl(moduleInput);
  const exportName =
    String(source.uiExportName || "default").trim() || "default";
  const sessionId = String(
    source.uiModuleSessionId ||
      source.moduleSessionId ||
      source.sessionId ||
      PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
  ).trim();
  return {
    pluginId,
    moduleUrl,
    exportName,
    enabled,
    updatedAt: nowIso(),
    ...(isVirtualUri(moduleUrl)
      ? { sessionId: sessionId || PLUGIN_SANDBOX_DEFAULT_SESSION_ID }
      : {}),
  };
}

function hasPluginExtensionEntry(source: Record<string, unknown>): boolean {
  return (
    typeof source.setup === "function" ||
    String(source.moduleUrl || "").trim().length > 0 ||
    String(source.modulePath || "").trim().length > 0 ||
    String(source.module || "").trim().length > 0
  );
}

interface PluginValidationCheck {
  name: string;
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

function buildPluginValidationCheck(
  name: string,
  ok: boolean,
  options: { error?: unknown; details?: Record<string, unknown> } = {},
): PluginValidationCheck {
  return {
    name,
    ok,
    ...(ok
      ? {}
      : {
          error: String(options.error || "").trim() || "校验失败",
        }),
    ...(options.details && Object.keys(options.details).length > 0
      ? { details: options.details }
      : {}),
  };
}

function readPluginInstallSource(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const nested = toRecord(input.plugin);
  if (Object.keys(nested).length > 0) return nested;
  if (Object.prototype.hasOwnProperty.call(input, "plugin")) {
    throw new Error("brain.plugin.install package.plugin 必须是 object");
  }
  return input;
}

function validatePluginInstallSource(source: Record<string, unknown>): void {
  const manifest = toRecord(source.manifest);
  const manifestId = String(manifest.id || "").trim();
  if (!manifestId) {
    throw new Error("brain.plugin.install package manifest.id 不能为空");
  }
}

function resolvePluginModuleUrl(input: unknown): string {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("plugin extension moduleUrl 不能为空");
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw;
  if (raw.startsWith("//"))
    throw new Error(`plugin extension moduleUrl 非法: ${raw}`);
  const normalized = raw.startsWith("/") ? raw.slice(1) : raw;
  const chromeRuntime = (
    globalThis as typeof globalThis & {
      chrome?: {
        runtime?: {
          getURL?: (path: string) => string;
        };
      };
    }
  ).chrome?.runtime;
  if (chromeRuntime?.getURL) {
    return chromeRuntime.getURL(normalized);
  }
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return new URL(raw, import.meta.url).href;
  }
  return new URL(`../../../${normalized}`, import.meta.url).href;
}

async function loadExtensionFactoryFromModule(
  moduleUrl: string,
  exportName = "default",
): Promise<ExtensionFactory> {
  const moduleNs = (await import(/* @vite-ignore */ moduleUrl)) as Record<
    string,
    unknown
  >;
  const target = String(exportName || "default").trim() || "default";
  const setup = target === "default" ? moduleNs.default : moduleNs[target];
  if (typeof setup !== "function") {
    throw new Error(`plugin extension ${moduleUrl} 缺少可执行导出: ${target}`);
  }
  return setup as ExtensionFactory;
}

function readPluginId(payload: Record<string, unknown>): string {
  return String(payload.pluginId || payload.id || "").trim();
}

function isBuiltinPluginId(pluginId: string): boolean {
  return String(pluginId || "")
    .trim()
    .startsWith(BUILTIN_PLUGIN_ID_PREFIX);
}

async function rehydratePersistedPluginRecord(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
  record: PersistedPluginRecord,
): Promise<void> {
  if (record.kind === "builtin_state") {
    if (record.enabled) {
      orchestrator.enablePlugin(record.pluginId);
    } else {
      orchestrator.disablePlugin(record.pluginId);
    }
    return;
  }

  const source = clonePersistableRecord(record.source);
  if (!source || typeof source !== "object") {
    throw new Error(`persisted plugin source 非法: ${record.pluginId}`);
  }

  const message =
    record.kind === "extension"
      ? ({
          ...source,
          type: "brain.plugin.register_extension",
          __pluginPersistenceHydrate: true,
          replace: true,
          enable: record.enabled,
        } as Record<string, unknown>)
      : ({
          type: "brain.plugin.register",
          __pluginPersistenceHydrate: true,
          plugin: source,
          replace: true,
          enable: record.enabled,
        } as Record<string, unknown>);
  const result = await handleBrainPlugin(orchestrator, infra, message);
  if (!result.ok) {
    throw new Error(String(result.error || "plugin rehydrate failed"));
  }
}

async function rehydratePersistedPlugins(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
): Promise<void> {
  await seedDefaultExamplePluginRecords();
  const records = await readPersistedPluginRecords();
  const ordered = [
    ...records.filter((item) => item.kind !== "builtin_state"),
    ...records.filter((item) => item.kind === "builtin_state"),
  ];
  for (const record of ordered) {
    try {
      await rehydratePersistedPluginRecord(orchestrator, infra, record);
    } catch (error) {
      console.warn(
        `[runtime-router] plugin rehydrate failed: ${record.pluginId}`,
        error,
      );
    }
  }
  await pruneUiExtensionDescriptors(
    orchestrator.listPlugins().map((item) => String(item.id || "").trim()),
  );
}

interface RegisterPluginOptions {
  replace: boolean;
  enable: boolean;
}

function resolvePluginRegisterOptions(
  source: Record<string, unknown>,
  payload: Record<string, unknown>,
): RegisterPluginOptions {
  const replaceRaw = source.replace ?? payload.replace;
  const enableRaw = source.enable ?? payload.enable;
  return {
    replace: replaceRaw === true,
    enable: enableRaw === false ? false : true,
  };
}

function normalizeIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function estimateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function clampStepStream(
  source: unknown[],
  rawOptions: { maxEvents?: unknown; maxBytes?: unknown } = {},
): {
  stream: unknown[];
  meta: {
    truncated: boolean;
    cutBy: "events" | "bytes" | null;
    totalEvents: number;
    totalBytes: number;
    returnedEvents: number;
    returnedBytes: number;
    maxEvents: number;
    maxBytes: number;
  };
} {
  const stream = Array.isArray(source) ? source : [];
  const maxEvents = normalizeIntInRange(
    rawOptions.maxEvents,
    DEFAULT_STEP_STREAM_MAX_EVENTS,
    1,
    MAX_STEP_STREAM_MAX_EVENTS,
  );
  const maxBytes = normalizeIntInRange(
    rawOptions.maxBytes,
    DEFAULT_STEP_STREAM_MAX_BYTES,
    2 * 1024,
    MAX_STEP_STREAM_MAX_BYTES,
  );
  const totalEvents = stream.length;
  const totalBytes = stream.reduce(
    (sum, item) => sum + estimateJsonBytes(item),
    0,
  );

  if (totalEvents <= maxEvents && totalBytes <= maxBytes) {
    return {
      stream: stream.slice(),
      meta: {
        truncated: false,
        cutBy: null,
        totalEvents,
        totalBytes,
        returnedEvents: totalEvents,
        returnedBytes: totalBytes,
        maxEvents,
        maxBytes,
      },
    };
  }

  const picked: unknown[] = [];
  let returnedBytes = 0;
  let cutBy: "events" | "bytes" | null = null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const item = stream[i];
    const bytes = estimateJsonBytes(item);
    const exceedEvents = picked.length + 1 > maxEvents;
    const exceedBytes = returnedBytes + bytes > maxBytes;
    if (exceedEvents || exceedBytes) {
      cutBy = exceedEvents ? "events" : "bytes";
      if (picked.length === 0) {
        picked.push(item);
        returnedBytes += bytes;
      }
      break;
    }
    picked.push(item);
    returnedBytes += bytes;
  }
  picked.reverse();
  return {
    stream: picked,
    meta: {
      truncated: true,
      cutBy,
      totalEvents,
      totalBytes,
      returnedEvents: picked.length,
      returnedBytes,
      maxEvents,
      maxBytes,
    },
  };
}

function normalizeSessionTitle(value: unknown, fallback = ""): string {
  const compact = String(value || "")
    .replace(/[`*_>#\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= SESSION_TITLE_MAX) return compact;
  return `${compact.slice(0, SESSION_TITLE_MAX)}…`;
}

function deriveSessionTitleFromEntries(entries: SessionEntry[]): string {
  const list = Array.isArray(entries) ? entries : [];
  for (const item of list) {
    if (item.type !== "message") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text = normalizeSessionTitle(item.text, "");
    if (!text || text.length < SESSION_TITLE_MIN) continue;
    return text;
  }
  return "新对话";
}

function readForkedFrom(meta: SessionMeta | null): {
  sessionId: string;
  leafId: string;
  sourceEntryId: string;
  reason: string;
} | null {
  const metadata = toRecord(meta?.header?.metadata);
  const raw = toRecord(metadata.forkedFrom);
  const sessionId = String(raw.sessionId || "").trim();
  const leafId = String(raw.leafId || "").trim();
  const sourceEntryId = String(raw.sourceEntryId || "").trim();
  const reason = String(raw.reason || "").trim();
  if (!sessionId && !leafId && !sourceEntryId && !reason) return null;
  return { sessionId, leafId, sourceEntryId, reason };
}

function findPreviousUserEntryByChain(
  byId: Map<string, SessionEntry>,
  startEntry: SessionEntry | null | undefined,
): MessageEntry | null {
  let cursor: SessionEntry | null = startEntry ?? null;
  let guard = byId.size + 2;
  while (cursor && guard > 0) {
    guard -= 1;
    if (
      cursor.type === "message" &&
      cursor.role === "user" &&
      String(cursor.id || "").trim()
    ) {
      return cursor;
    }
    const parentId = String(cursor.parentId || "").trim();
    cursor = parentId ? byId.get(parentId) || null : null;
  }
  return null;
}

function findLatestUserEntryInBranch(
  branch: SessionEntry[],
): MessageEntry | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const candidate = branch[i];
    if (candidate.type !== "message" || candidate.role !== "user") continue;
    if (!String(candidate.id || "").trim()) continue;
    if (!String(candidate.text || "").trim()) continue;
    return candidate;
  }
  return null;
}

interface ForkSessionInput {
  sourceSessionId: string;
  leafId: string;
  sourceEntryId?: string;
  reason?: string;
  title?: string;
  targetSessionId?: string;
}

interface ForkSessionResult {
  sessionId: string;
  sourceSessionId: string;
  sourceLeafId: string;
  leafId: string | null;
  copiedEntryCount: number;
}

async function forkSessionFromLeaf(
  orchestrator: BrainOrchestrator,
  input: ForkSessionInput,
): Promise<ForkSessionResult> {
  const sourceSessionId = String(input.sourceSessionId || "").trim();
  const sourceLeafId = String(input.leafId || "").trim();
  if (!sourceSessionId) {
    throw new Error("fork sourceSessionId 不能为空");
  }
  if (!sourceLeafId) {
    throw new Error("fork leafId 不能为空");
  }

  const sourceMeta = await orchestrator.sessions.getMeta(sourceSessionId);
  if (!sourceMeta) {
    throw new Error(`session 不存在: ${sourceSessionId}`);
  }

  const sourceEntries = await orchestrator.sessions.getEntries(sourceSessionId);
  const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  if (!byId.has(sourceLeafId)) {
    throw new Error(`fork leaf 不存在: ${sourceLeafId}`);
  }

  const sourceTitle = String(sourceMeta.header.title || "").trim();
  const forkTitle =
    String(input.title || "").trim() ||
    (sourceTitle ? `${sourceTitle} · 重答分支` : "重答分支");
  const sourceMetadata = toRecord(sourceMeta.header.metadata);
  const forkReason = String(input.reason || "manual");
  const sourceEntryId = String(input.sourceEntryId || "");
  const targetSessionId =
    String(input.targetSessionId || "").trim() || undefined;

  const forkMeta = await orchestrator.sessions.createSession({
    id: targetSessionId,
    parentSessionId: sourceSessionId,
    title: forkTitle,
    model: sourceMeta.header.model,
    metadata: {
      ...sourceMetadata,
      forkedFrom: {
        sessionId: sourceSessionId,
        leafId: sourceLeafId,
        sourceEntryId,
        reason: forkReason,
      },
    },
  });
  const forkSessionId = forkMeta.header.id;

  const branch = await orchestrator.sessions.getBranch(
    sourceSessionId,
    sourceLeafId,
  );
  const oldToNew = new Map<string, string>();
  for (const sourceEntry of branch) {
    const cloned: SessionEntry = {
      ...sourceEntry,
      id: randomId("entry"),
      parentId: sourceEntry.parentId
        ? oldToNew.get(sourceEntry.parentId) || null
        : null,
      timestamp: nowIso(),
    };
    if (cloned.type === "compaction") {
      const oldFirstKept = String(cloned.firstKeptEntryId || "").trim();
      cloned.firstKeptEntryId = oldFirstKept
        ? oldToNew.get(oldFirstKept) || null
        : null;
    }
    await orchestrator.sessions.appendEntry(forkSessionId, cloned);
    oldToNew.set(sourceEntry.id, cloned.id);
  }

  return {
    sessionId: forkSessionId,
    sourceSessionId,
    sourceLeafId,
    leafId: oldToNew.get(sourceLeafId) || null,
    copiedEntryCount: branch.length,
  };
}

async function buildConversationView(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  leafId?: string | null,
): Promise<{
  sessionId: string;
  messageCount: number;
  messages: Array<{
    role: string;
    content: string;
    entryId: string;
    toolName?: string;
    toolCallId?: string;
  }>;
  parentSessionId: string;
  forkedFrom: {
    sessionId: string;
    leafId: string;
    sourceEntryId: string;
    reason: string;
  } | null;
  lastStatus: ReturnType<BrainOrchestrator["getRunState"]>;
  updatedAt: string;
}> {
  const context = await orchestrator.sessions.buildSessionContext(
    sessionId,
    leafId ?? undefined,
  );
  const meta = await orchestrator.sessions.getMeta(sessionId);
  const messages = context.entries
    .filter((entry): entry is MessageEntry => entry.type === "message")
    .map((entry) => ({
      role: entry.role,
      content: entry.text,
      entryId: entry.id,
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
    }));
  return {
    sessionId,
    messageCount: messages.length,
    messages,
    parentSessionId: String(meta?.header?.parentSessionId || ""),
    forkedFrom: readForkedFrom(meta),
    lastStatus: orchestrator.getRunState(sessionId),
    updatedAt: nowIso(),
  };
}

interface AgentRunTaskInput {
  agent: string;
  role: string;
  task: string;
  profile?: string;
  sessionId?: string;
  sessionOptions: Record<string, unknown>;
  autoRun: boolean;
}

function parseAgentRunTask(
  raw: unknown,
  defaultAutoRun: boolean,
): { ok: true; task: AgentRunTaskInput } | { ok: false; error: string } {
  const source = toRecord(raw);
  const agent = String(source.agent || "").trim();
  const role = String(source.role || agent).trim();
  const task = String(source.task || "").trim();
  if (!agent) {
    return { ok: false, error: "brain.agent.run 需要 agent" };
  }
  if (!task) {
    return { ok: false, error: `brain.agent.run(${agent}) 需要非空 task` };
  }
  const profile = String(source.profile || "").trim();
  const sessionId = String(source.sessionId || "").trim();
  const sessionOptions = source.sessionOptions
    ? toRecord(source.sessionOptions)
    : {};
  const autoRun = source.autoRun === false ? false : defaultAutoRun;
  return {
    ok: true,
    task: {
      agent,
      role: role || agent,
      task,
      profile: profile || undefined,
      sessionId: sessionId || undefined,
      sessionOptions,
      autoRun,
    },
  };
}

async function startAgentRunTask(
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  task: AgentRunTaskInput,
  resolvedTask: string,
  parentSessionId?: string,
): Promise<Record<string, unknown>> {
  const sessionOptions = {
    ...toRecord(task.sessionOptions),
  };
  const metadata = {
    ...toRecord(sessionOptions.metadata),
    agent: task.agent,
    agentRole: task.role,
    llmRole: task.role,
  } as Record<string, unknown>;
  if (task.profile) metadata.llmProfile = task.profile;
  sessionOptions.metadata = metadata;
  if (parentSessionId && !String(sessionOptions.parentSessionId || "").trim()) {
    sessionOptions.parentSessionId = parentSessionId;
  }

  const started = await runtimeLoop.startFromPrompt({
    sessionId: task.sessionId || "",
    sessionOptions,
    prompt: resolvedTask,
    autoRun: task.autoRun,
  });
  return {
    agent: task.agent,
    role: task.role,
    profile: task.profile || "",
    task: resolvedTask,
    templateTask: task.task,
    sessionId: started.sessionId,
    runtime: started.runtime,
  };
}

function injectChainPrevious(taskText: string, previousOutput: string): string {
  const source = String(taskText || "");
  if (!source.includes(CHAIN_PREVIOUS_TOKEN)) return source;
  return source.split(CHAIN_PREVIOUS_TOKEN).join(previousOutput);
}

async function waitForLoopDoneBySession(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  timeoutMs: number,
): Promise<{ status: string; timeout: boolean }> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let idleSince = 0;
  while (Date.now() < deadline) {
    const stream = await orchestrator.getStepStream(sessionId);
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const item = stream[i];
      if (String(item.type || "") !== "loop_done") continue;
      const payload = toRecord(item.payload);
      return {
        status: String(payload.status || "").trim() || "done",
        timeout: false,
      };
    }
    const state = orchestrator.getRunState(sessionId);
    if (!state.running && !state.paused) {
      if (!state.stopped) {
        if (!idleSince) {
          idleSince = Date.now();
        } else if (Date.now() - idleSince >= SUBAGENT_IDLE_GRACE_MS) {
          return {
            status: "done",
            timeout: false,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        continue;
      }
      return {
        status: state.stopped ? "stopped" : "unknown",
        timeout: false,
      };
    }
    idleSince = 0;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return {
    status: "timeout",
    timeout: true,
  };
}

async function readLatestAssistantMessage(
  orchestrator: BrainOrchestrator,
  sessionId: string,
): Promise<string> {
  const context = await orchestrator.sessions.buildSessionContext(sessionId);
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const item = context.messages[i];
    if (String(item.role || "") !== "assistant") continue;
    const text = String(item.content || "").trim();
    if (text) return text;
  }
  return "";
}

function buildChainFanInSummary(
  results: Array<Record<string, unknown>>,
): string {
  const lines = results.map((item, index) => {
    const agent = String(item.agent || "").trim() || `agent-${index + 1}`;
    const status = String(item.status || "").trim() || "unknown";
    const output = String(item.output || "")
      .trim()
      .replace(/\s+/g, " ");
    const clipped = output.length > 140 ? `${output.slice(0, 140)}…` : output;
    return `${index + 1}. ${agent} [${status}] ${clipped}`;
  });
  return lines.join("\n");
}

interface StartedSubagentTask {
  index: number;
  agent: string;
  role: string;
  profile: string;
  sessionId: string;
  task: string;
  templateTask: string;
  autoRun: boolean;
}

function resolveSubagentRunSessionId(
  source: Record<string, unknown>,
  parentSessionId: string,
): string {
  const explicit = String(source.runSessionId || "").trim();
  if (explicit) return explicit;
  if (parentSessionId) return parentSessionId;
  return randomId("subagent-run");
}

function classifySubagentRunStatus(results: Array<Record<string, unknown>>): {
  status: string;
  failCount: number;
  timeoutCount: number;
  notStartedCount: number;
} {
  let failCount = 0;
  let timeoutCount = 0;
  let notStartedCount = 0;
  for (const item of results) {
    const status = String(item.status || "").trim() || "unknown";
    const timeout = item.timeout === true || status === "timeout";
    if (timeout) {
      timeoutCount += 1;
      continue;
    }
    if (status === "not_started") {
      notStartedCount += 1;
      continue;
    }
    if (status !== "done") {
      failCount += 1;
    }
  }
  if (timeoutCount > 0)
    return { status: "timeout", failCount, timeoutCount, notStartedCount };
  if (failCount > 0)
    return {
      status: "partial_failed",
      failCount,
      timeoutCount,
      notStartedCount,
    };
  if (notStartedCount > 0)
    return { status: "not_started", failCount, timeoutCount, notStartedCount };
  return { status: "done", failCount, timeoutCount, notStartedCount };
}

async function completeStartedSubagentTask(
  orchestrator: BrainOrchestrator,
  runSessionId: string,
  task: StartedSubagentTask,
  waitTimeoutMs: number,
): Promise<Record<string, unknown>> {
  if (!task.autoRun) {
    const completed = {
      ...task,
      status: "not_started",
      timeout: false,
      output: "",
    };
    orchestrator.events.emit("subagent.task.end", runSessionId, completed);
    return completed;
  }
  const done = await waitForLoopDoneBySession(
    orchestrator,
    task.sessionId,
    waitTimeoutMs,
  );
  const output = await readLatestAssistantMessage(orchestrator, task.sessionId);
  const completed = {
    ...task,
    status: done.status,
    timeout: done.timeout,
    output,
  };
  orchestrator.events.emit("subagent.task.end", runSessionId, completed);
  return completed;
}

function scheduleSubagentRunCompletion(
  orchestrator: BrainOrchestrator,
  runSessionId: string,
  mode: "single" | "parallel",
  tasks: StartedSubagentTask[],
  waitTimeoutMs: number,
): void {
  void Promise.all(
    tasks.map((task) =>
      completeStartedSubagentTask(
        orchestrator,
        runSessionId,
        task,
        waitTimeoutMs,
      ),
    ),
  )
    .then((results) => {
      const summary = classifySubagentRunStatus(results);
      orchestrator.events.emit("subagent.run.end", runSessionId, {
        mode,
        ...summary,
        taskCount: tasks.length,
        completedCount: results.length,
        results,
      });
    })
    .catch((error) => {
      orchestrator.events.emit("subagent.run.end", runSessionId, {
        mode,
        status: "internal_error",
        taskCount: tasks.length,
        completedCount: 0,
        failCount: tasks.length,
        timeoutCount: 0,
        notStartedCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

async function handleBrainAgentRun(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const source = payload.payload ? toRecord(payload.payload) : payload;
  const modeRaw = String(source.mode || "")
    .trim()
    .toLowerCase();
  if (modeRaw !== "single" && modeRaw !== "parallel" && modeRaw !== "chain") {
    return fail("brain.agent.run 需要显式 mode（single|parallel|chain）");
  }
  const mode = modeRaw;
  const parentSessionId = String(
    source.parentSessionId || source.sessionId || "",
  ).trim();
  const defaultAutoRun = source.autoRun === false ? false : true;
  const waitTimeoutMs = normalizeIntInRange(
    source.waitTimeoutMs,
    DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
    1_000,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
  );
  const runSessionId = resolveSubagentRunSessionId(source, parentSessionId);

  if (parentSessionId) {
    await orchestrator.sessions.ensureSession(parentSessionId);
  }

  if (mode === "single") {
    const rawSingle = source.single !== undefined ? source.single : source;
    const parsed = parseAgentRunTask(rawSingle, defaultAutoRun);
    if (!parsed.ok) return fail(parsed.error);
    orchestrator.events.emit("subagent.run.start", runSessionId, {
      mode: "single",
      parentSessionId: parentSessionId || null,
      taskCount: 1,
      waitTimeoutMs,
    });
    const started = await startAgentRunTask(
      runtimeLoop,
      parsed.task,
      parsed.task.task,
      parentSessionId || undefined,
    );
    const startedTask: StartedSubagentTask = {
      index: 1,
      agent: String(started.agent || ""),
      role: String(started.role || ""),
      profile: String(started.profile || ""),
      sessionId: String(started.sessionId || ""),
      task: String(started.task || ""),
      templateTask: String(started.templateTask || ""),
      autoRun: parsed.task.autoRun,
    };
    orchestrator.events.emit("subagent.task.start", runSessionId, startedTask);
    scheduleSubagentRunCompletion(
      orchestrator,
      runSessionId,
      "single",
      [startedTask],
      waitTimeoutMs,
    );
    return ok({
      mode: "single",
      runSessionId,
      result: started,
    });
  }

  if (mode === "parallel") {
    const rawTasks = Array.isArray(source.tasks) ? source.tasks : [];
    if (rawTasks.length === 0) {
      return fail("brain.agent.run parallel 需要非空 tasks");
    }
    if (rawTasks.length > MAX_SUBAGENT_PARALLEL_TASKS) {
      return fail(
        `brain.agent.run parallel tasks 不能超过 ${MAX_SUBAGENT_PARALLEL_TASKS}`,
      );
    }
    const concurrency = normalizeIntInRange(
      source.concurrency,
      Math.min(MAX_SUBAGENT_PARALLEL_CONCURRENCY, rawTasks.length),
      1,
      MAX_SUBAGENT_PARALLEL_CONCURRENCY,
    );
    const parsedTasks: AgentRunTaskInput[] = [];
    for (let i = 0; i < rawTasks.length; i += 1) {
      const parsed = parseAgentRunTask(rawTasks[i], defaultAutoRun);
      if (!parsed.ok) {
        return fail(`brain.agent.run tasks[${i}] 无效: ${parsed.error}`);
      }
      parsedTasks.push(parsed.task);
    }

    orchestrator.events.emit("subagent.run.start", runSessionId, {
      mode: "parallel",
      parentSessionId: parentSessionId || null,
      taskCount: parsedTasks.length,
      concurrency,
      waitTimeoutMs,
    });

    const results: Array<Record<string, unknown>> = new Array(
      parsedTasks.length,
    );
    const startedTasks: StartedSubagentTask[] = new Array(parsedTasks.length);
    let cursor = 0;
    const workerCount = Math.min(concurrency, parsedTasks.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= parsedTasks.length) break;
          const started = await startAgentRunTask(
            runtimeLoop,
            parsedTasks[index],
            parsedTasks[index].task,
            parentSessionId || undefined,
          );
          results[index] = started;
          const startedTask: StartedSubagentTask = {
            index: index + 1,
            agent: String(started.agent || ""),
            role: String(started.role || ""),
            profile: String(started.profile || ""),
            sessionId: String(started.sessionId || ""),
            task: String(started.task || ""),
            templateTask: String(started.templateTask || ""),
            autoRun: parsedTasks[index].autoRun,
          };
          startedTasks[index] = startedTask;
          orchestrator.events.emit(
            "subagent.task.start",
            runSessionId,
            startedTask,
          );
        }
      }),
    );
    scheduleSubagentRunCompletion(
      orchestrator,
      runSessionId,
      "parallel",
      startedTasks,
      waitTimeoutMs,
    );

    return ok({
      mode: "parallel",
      runSessionId,
      concurrency: workerCount,
      results,
    });
  }

  if (mode === "chain") {
    if (!defaultAutoRun) {
      return fail("brain.agent.run chain 需要 autoRun=true");
    }
    const rawChain = Array.isArray(source.chain) ? source.chain : [];
    if (rawChain.length === 0) {
      return fail("brain.agent.run chain 需要非空 chain");
    }
    if (rawChain.length > MAX_SUBAGENT_CHAIN_TASKS) {
      return fail(
        `brain.agent.run chain tasks 不能超过 ${MAX_SUBAGENT_CHAIN_TASKS}`,
      );
    }
    const failFast = source.failFast !== false;
    const parsedChain: AgentRunTaskInput[] = [];
    for (let i = 0; i < rawChain.length; i += 1) {
      const parsed = parseAgentRunTask(rawChain[i], true);
      if (!parsed.ok) {
        return fail(`brain.agent.run chain[${i}] 无效: ${parsed.error}`);
      }
      parsedChain.push(parsed.task);
    }

    orchestrator.events.emit("subagent.run.start", runSessionId, {
      mode: "chain",
      parentSessionId: parentSessionId || null,
      taskCount: parsedChain.length,
      waitTimeoutMs,
      failFast,
    });

    const results: Array<Record<string, unknown>> = [];
    let previousOutput = String(source.previous || "").trim();
    let halted = false;
    let haltedStatus = "";
    let haltedStep = 0;

    for (let i = 0; i < parsedChain.length; i += 1) {
      const task = parsedChain[i];
      const resolvedTask = injectChainPrevious(task.task, previousOutput);
      const started = await startAgentRunTask(
        runtimeLoop,
        task,
        resolvedTask,
        parentSessionId || undefined,
      );
      const startedTask: StartedSubagentTask = {
        index: i + 1,
        agent: String(started.agent || ""),
        role: String(started.role || ""),
        profile: String(started.profile || ""),
        sessionId: String(started.sessionId || ""),
        task: String(started.task || ""),
        templateTask: String(started.templateTask || ""),
        autoRun: true,
      };
      orchestrator.events.emit(
        "subagent.task.start",
        runSessionId,
        startedTask,
      );
      const completed = await completeStartedSubagentTask(
        orchestrator,
        runSessionId,
        startedTask,
        waitTimeoutMs,
      );
      if (String(completed.output || "").trim()) {
        previousOutput = String(completed.output || "").trim();
      }
      results.push(completed);
      if (failFast && String(completed.status || "") !== "done") {
        halted = true;
        haltedStatus = String(completed.status || "");
        haltedStep = i + 1;
        break;
      }
    }

    const fanIn = {
      finalOutput: previousOutput,
      summary: buildChainFanInSummary(results),
    };
    const summary = classifySubagentRunStatus(results);
    orchestrator.events.emit("subagent.run.end", runSessionId, {
      mode: "chain",
      ...summary,
      taskCount: parsedChain.length,
      completedCount: results.length,
      failFast,
      halted,
      haltedStep: halted ? haltedStep : null,
      haltedStatus: halted ? haltedStatus : "",
      fanIn,
      results,
    });

    return ok({
      mode: "chain",
      runSessionId,
      failFast,
      results,
      halted,
      haltedStep: halted ? haltedStep : null,
      haltedStatus: halted ? haltedStatus : "",
      fanIn,
    });
  }

  orchestrator.events.emit("subagent.run.end", runSessionId, {
    mode,
    status: "failed_execute",
    taskCount: 0,
    completedCount: 0,
    failCount: 1,
    timeoutCount: 0,
    notStartedCount: 0,
    error: "unsupported_mode",
  });
  return fail("brain.agent.run 仅支持 mode=single|parallel|chain");
}

async function handleBrainRun(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  infra: RuntimeInfraHandler,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  if (action === "brain.run.start") {
    const rawStreamingBehavior =
      typeof payload.streamingBehavior === "string"
        ? payload.streamingBehavior
        : typeof payload.deliverAs === "string"
          ? payload.deliverAs
          : "";
    const streamingBehavior =
      rawStreamingBehavior === "follow_up"
        ? "followUp"
        : rawStreamingBehavior === "steer" ||
            rawStreamingBehavior === "followUp"
          ? rawStreamingBehavior
          : undefined;
    const out = await runtimeLoop.startFromPrompt({
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      sessionOptions: payload.sessionOptions
        ? toRecord(payload.sessionOptions)
        : {},
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      tabIds: Array.isArray(payload.tabIds) ? payload.tabIds : undefined,
      skillIds: Array.isArray(payload.skillIds) ? payload.skillIds : undefined,
      autoRun: payload.autoRun === false ? false : true,
      streamingBehavior,
    });
    return ok(out);
  }

  if (action === "brain.run.steer" || action === "brain.run.follow_up") {
    const sessionId = requireSessionId(payload);
    const prompt = String(payload.prompt || "").trim();
    const skillIds = Array.isArray(payload.skillIds)
      ? payload.skillIds
      : undefined;
    if (!prompt && (!skillIds || skillIds.length === 0)) {
      return fail(`${action} 需要非空 prompt 或 skillIds`);
    }
    const out = await runtimeLoop.startFromPrompt({
      sessionId,
      prompt,
      skillIds,
      autoRun: true,
      streamingBehavior: action === "brain.run.steer" ? "steer" : "followUp",
    });
    return ok(out);
  }

  if (action === "brain.run.regenerate") {
    const sessionId = requireSessionId(payload);
    await orchestrator.sessions.ensureSession(sessionId);

    const sourceEntryId = String(payload.sourceEntryId || "").trim();
    if (!sourceEntryId) {
      return fail("brain.run.regenerate 需要 sourceEntryId");
    }

    const entries = await orchestrator.sessions.getEntries(sessionId);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const source = byId.get(sourceEntryId);
    if (!source) {
      return fail(`regenerate sourceEntry 不存在: ${sourceEntryId}`);
    }
    if (source.type !== "message" || source.role !== "assistant") {
      return fail("regenerate sourceEntry 必须是 assistant 消息");
    }

    const requireSourceIsLeaf = payload.requireSourceIsLeaf === true;
    const rebaseLeafToPreviousUser = payload.rebaseLeafToPreviousUser === true;
    const currentLeafId =
      (await orchestrator.sessions.getLeaf(sessionId)) || "";
    if (requireSourceIsLeaf && currentLeafId !== sourceEntryId) {
      return fail("仅最后一条 assistant 支持当前会话重试");
    }

    const previousSeed = String(source.parentId || "").trim();
    const previousEntry = previousSeed ? byId.get(previousSeed) : undefined;
    const previousUser = findPreviousUserEntryByChain(byId, previousEntry);
    if (!previousUser) {
      return fail("未找到前序 user 消息，无法重试");
    }

    if (rebaseLeafToPreviousUser && currentLeafId !== previousUser.id) {
      await orchestrator.sessions.setLeaf(sessionId, previousUser.id);
    }

    orchestrator.events.emit("input.regenerate", sessionId, {
      sourceEntryId,
      previousUserEntryId: previousUser.id,
      text: String(previousUser.text || ""),
    });

    const out = await runtimeLoop.startFromRegenerate({
      sessionId,
      prompt: String(previousUser.text || ""),
      autoRun: payload.autoRun === false ? false : true,
    });
    return ok(out);
  }

  if (action === "brain.run.edit_rerun") {
    const sourceSessionId = requireSessionId(payload);
    await orchestrator.sessions.ensureSession(sourceSessionId);

    const sourceEntryId = String(
      payload.sourceEntryId || payload.entryId || "",
    ).trim();
    if (!sourceEntryId) {
      return fail("brain.run.edit_rerun 需要 sourceEntryId");
    }
    const editedPrompt = String(payload.prompt || "").trim();
    if (!editedPrompt) {
      return fail("brain.run.edit_rerun 需要非空 prompt");
    }

    const sourceEntries =
      await orchestrator.sessions.getEntries(sourceSessionId);
    const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    const targetEntry = byId.get(sourceEntryId);
    if (!targetEntry) {
      return fail(`edit_rerun sourceEntry 不存在: ${sourceEntryId}`);
    }
    if (targetEntry.type !== "message" || targetEntry.role !== "user") {
      return fail("edit_rerun sourceEntry 必须是 user 消息");
    }

    const activeLeafId =
      (await orchestrator.sessions.getLeaf(sourceSessionId)) || null;
    const activeBranch = await orchestrator.sessions.getBranch(
      sourceSessionId,
      activeLeafId ?? undefined,
    );
    if (!activeBranch.some((entry) => entry.id === sourceEntryId)) {
      return fail("edit_rerun sourceEntry 不在当前分支");
    }
    const latestUser = findLatestUserEntryInBranch(activeBranch);
    if (!latestUser) {
      return fail("当前分支缺少可编辑 user 消息");
    }
    const mode: "retry" | "fork" =
      latestUser.id === sourceEntryId ? "retry" : "fork";
    const autoRun = payload.autoRun === false ? false : true;

    let runSessionId = sourceSessionId;
    let runSourceEntryId = sourceEntryId;
    if (mode === "fork") {
      const forked = await forkSessionFromLeaf(orchestrator, {
        sourceSessionId,
        leafId: sourceEntryId,
        sourceEntryId,
        reason: String(payload.reason || "edit_user_rerun"),
        title: String(payload.title || "").trim() || undefined,
      });
      runSessionId = forked.sessionId;
      runSourceEntryId = String(forked.leafId || "").trim();
      if (!runSourceEntryId) {
        return fail("edit_rerun fork 后未找到 sourceEntry");
      }
    }

    const runEntries = await orchestrator.sessions.getEntries(runSessionId);
    const runById = new Map(runEntries.map((entry) => [entry.id, entry]));
    const runSource = runById.get(runSourceEntryId);
    if (
      !runSource ||
      runSource.type !== "message" ||
      runSource.role !== "user"
    ) {
      return fail("edit_rerun 目标 user 节点异常");
    }

    const rebaseLeafId = runSource.parentId || null;
    const currentLeafId =
      (await orchestrator.sessions.getLeaf(runSessionId)) || null;
    if (currentLeafId !== rebaseLeafId) {
      await orchestrator.sessions.setLeaf(runSessionId, rebaseLeafId);
    }

    orchestrator.events.emit("input.regenerate", runSessionId, {
      sourceEntryId: runSourceEntryId,
      previousUserEntryId: runSourceEntryId,
      text: editedPrompt,
      mode,
      reason: "edit_user_rerun",
    });

    const out = await runtimeLoop.startFromPrompt({
      sessionId: runSessionId,
      prompt: editedPrompt,
      autoRun,
    });

    return ok({
      ...out,
      mode,
      sourceSessionId,
      sourceEntryId,
      activeSourceEntryId: runSourceEntryId,
    });
  }

  if (action === "brain.run.pause") {
    return ok(orchestrator.pause(requireSessionId(payload)));
  }

  if (action === "brain.run.queue.promote") {
    const sessionId = requireSessionId(payload);
    const queuedPromptId = String(
      payload.queuedPromptId || payload.id || "",
    ).trim();
    if (!queuedPromptId) {
      return fail("brain.run.queue.promote 需要 queuedPromptId");
    }
    const rawTarget = String(
      payload.targetBehavior || payload.behavior || "steer",
    ).trim();
    const targetBehavior = rawTarget === "followUp" ? "followUp" : "steer";
    const runtime = orchestrator.promoteQueuedPrompt(
      sessionId,
      queuedPromptId,
      targetBehavior,
    );
    if (
      targetBehavior === "steer" &&
      runtime.running === true &&
      runtime.stopped !== true
    ) {
      infra.abortBridgeInvokesBySession(sessionId, "steer_preempt");
    }
    return ok(runtime);
  }

  if (action === "brain.run.resume") {
    return ok(orchestrator.resume(requireSessionId(payload)));
  }

  if (action === "brain.run.stop") {
    const sessionId = requireSessionId(payload);
    const runtime = orchestrator.stop(sessionId);
    infra.abortBridgeInvokesBySession(sessionId);
    return ok(runtime);
  }

  return fail(`unsupported brain.run action: ${action}`);
}

async function handleSession(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.session.list") {
    const index = await orchestrator.sessions.listSessions();
    const sessions = await Promise.all(
      index.sessions.map(async (entry) => {
        const meta = await orchestrator.sessions.getMeta(entry.id);
        return {
          ...entry,
          title: normalizeSessionTitle(meta?.header?.title, ""),
          parentSessionId: String(meta?.header?.parentSessionId || ""),
          forkedFrom: readForkedFrom(meta),
        };
      }),
    );
    return ok({ ...index, sessions });
  }

  if (action === "brain.session.get") {
    const sessionId = requireSessionId(payload);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    const entries = await orchestrator.sessions.getEntries(sessionId);
    return ok({ meta, entries });
  }

  if (action === "brain.session.view") {
    const sessionId = requireSessionId(payload);
    const leafId =
      typeof payload.leafId === "string" ? payload.leafId : undefined;
    return ok({
      conversationView: await buildConversationView(
        orchestrator,
        sessionId,
        leafId,
      ),
    });
  }

  if (action === "brain.session.fork") {
    const sessionId = requireSessionId(payload);
    const leafId = String(payload.leafId || "").trim();
    if (!leafId) {
      return fail("brain.session.fork 需要 leafId");
    }
    const forked = await forkSessionFromLeaf(orchestrator, {
      sourceSessionId: sessionId,
      leafId,
      sourceEntryId: String(payload.sourceEntryId || ""),
      reason: String(payload.reason || "manual"),
      title: String(payload.title || "").trim() || undefined,
      targetSessionId:
        String(payload.targetSessionId || "").trim() || undefined,
    });
    return ok(forked);
  }

  if (action === "brain.session.title.refresh") {
    const sessionId = requireSessionId(payload);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    if (!meta) {
      return fail(`session 不存在: ${sessionId}`);
    }
    const hasExplicitTitle = typeof payload.title === "string";
    if (hasExplicitTitle) {
      const manualTitle = normalizeSessionTitle(payload.title, "");
      if (!manualTitle) {
        return fail("title 不能为空");
      }
      const metadata = {
        ...toRecord(meta.header.metadata),
        titleSource: SESSION_TITLE_SOURCE_MANUAL,
      };
      await writeSessionMeta(sessionId, {
        ...meta,
        header: {
          ...meta.header,
          title: manualTitle,
          metadata,
        },
        updatedAt: nowIso(),
      });
      return ok({
        sessionId,
        title: manualTitle,
        updated: manualTitle !== normalizeSessionTitle(meta.header.title, ""),
      });
    }
    const currentTitle = normalizeSessionTitle(meta.header.title, "");
    const force = payload.force === true;
    const derivedTitle = await runtimeLoop.refreshSessionTitle(sessionId, {
      force,
    });
    if (!derivedTitle) {
      const entries = await orchestrator.sessions.getEntries(sessionId);
      const fallbackTitle =
        currentTitle || deriveSessionTitleFromEntries(entries);
      const normalizedFallback = normalizeSessionTitle(fallbackTitle, "新对话");
      if (normalizedFallback && normalizedFallback !== currentTitle) {
        await writeSessionMeta(sessionId, {
          ...meta,
          header: {
            ...meta.header,
            title: normalizedFallback,
          },
          updatedAt: nowIso(),
        });
      }
      return ok({
        sessionId,
        title: normalizedFallback || currentTitle,
        updated: normalizedFallback !== currentTitle,
      });
    }
    return ok({
      sessionId,
      title: derivedTitle,
      updated: derivedTitle !== currentTitle,
    });
  }

  if (action === "brain.session.delete") {
    const sessionId = requireSessionId(payload);
    const metaKey = `session:${sessionId}:meta`;
    orchestrator.stop(sessionId);
    await orchestrator.flushSessionTraceWrites(sessionId);
    await removeSessionMeta(sessionId);
    const removedTraceCount = await removeTraceRecords(`session-${sessionId}`);
    const removedVirtualKeys = await clearVirtualFilesForSession(sessionId);
    const index = await removeSessionIndexEntry(sessionId, nowIso());
    await orchestrator.evictSessionRuntime(sessionId);
    return ok({
      sessionId,
      deleted: true,
      removedCount: 1 + removedTraceCount + removedVirtualKeys.length,
      removedKeys: [
        metaKey,
        ...removedVirtualKeys,
        ...(removedTraceCount > 0 ? [`trace:session-${sessionId}`] : []),
      ],
      index,
    });
  }

  return fail(`unsupported brain.session action: ${action}`);
}

async function handleStep(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const type = String(payload.type || "");
  if (type === "brain.step.stream") {
    const sessionId = requireSessionId(payload);
    const stream = await orchestrator.getStepStream(sessionId);
    const limited = clampStepStream(stream, {
      maxEvents: payload.maxEvents,
      maxBytes: payload.maxBytes,
    });
    return ok({ sessionId, stream: limited.stream, streamMeta: limited.meta });
  }

  if (type === "brain.step.execute") {
    const sessionId = requireSessionId(payload);
    const modeRaw = String(payload.mode || "").trim();
    const mode = ["script", "cdp", "bridge"].includes(modeRaw)
      ? (modeRaw as "script" | "cdp" | "bridge")
      : undefined;
    const capability = String(payload.capability || "").trim() || undefined;
    const action = String(payload.action || "").trim();
    if (modeRaw && !mode) return fail("mode 必须是 script/cdp/bridge");
    if (!mode && !capability) return fail("mode 或 capability 至少需要一个");
    if (!action) return fail("action 不能为空");
    return ok(
      await runtimeLoop.executeStep({
        sessionId,
        mode,
        capability,
        action,
        args: toRecord(payload.args),
        verifyPolicy: payload.verifyPolicy as
          | "off"
          | "on_critical"
          | "always"
          | undefined,
      }),
    );
  }

  return fail(`unsupported step action: ${type}`);
}

async function handleStorage(
  orchestrator: BrainOrchestrator,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  if (action === "brain.storage.reset") {
    const result = await resetSessionStore(toRecord(payload.options));
    await orchestrator.resetRuntimeState();
    return ok(result);
  }
  if (action === "brain.storage.init") {
    return ok(await initSessionIndex());
  }
  return fail(`unsupported storage action: ${action}`);
}

interface SkillDiscoverRootInput {
  root: string;
  source: string;
}

interface SkillDiscoverScanHit {
  root: string;
  source: string;
  path: string;
}

interface ParsedSkillFrontmatter {
  id?: string;
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  warnings: string[];
}

function sanitizeSkillDiscoverCell(input: unknown, field: string): string {
  const text = String(input || "").trim();
  if (!text) return "";
  if (/[\r\n\t]/.test(text)) {
    throw new Error(`brain.skill.discover: ${field} 不能包含换行或制表符`);
  }
  return text;
}

function normalizeSkillDiscoverRoots(
  payload: Record<string, unknown>,
): SkillDiscoverRootInput[] {
  const fallbackSource = String(payload.source || "").trim() || "browser";
  const rawRoots = Array.isArray(payload.roots) ? payload.roots : [];
  const out: SkillDiscoverRootInput[] = [];

  if (rawRoots.length > 0) {
    for (const item of rawRoots) {
      if (typeof item === "string") {
        const root = sanitizeSkillDiscoverCell(item, "root");
        if (!root) continue;
        if (!isVirtualUri(root)) {
          throw new Error("brain.skill.discover 仅支持 mem:// roots");
        }
        out.push({ root: normalizeSkillPath(root), source: fallbackSource });
        continue;
      }
      const row = toRecord(item);
      const root = sanitizeSkillDiscoverCell(
        row.root || row.path || "",
        "root",
      );
      if (!root) continue;
      if (!isVirtualUri(root)) {
        throw new Error("brain.skill.discover 仅支持 mem:// roots");
      }
      const source =
        sanitizeSkillDiscoverCell(row.source || fallbackSource, "source") ||
        fallbackSource;
      out.push({ root: normalizeSkillPath(root), source });
    }
  } else {
    out.push(
      ...DEFAULT_SKILL_DISCOVER_ROOTS.map((item) => ({
        root: normalizeSkillPath(item.root),
        source: item.source,
      })),
    );
  }

  const dedup = new Set<string>();
  const normalized: SkillDiscoverRootInput[] = [];
  for (const item of out) {
    const key = item.root;
    if (dedup.has(key)) continue;
    dedup.add(key);
    normalized.push(item);
  }
  return normalized;
}

function normalizeSkillPath(input: unknown): string {
  const raw = String(input || "")
    .trim()
    .replace(/\\/g, "/");
  const uriMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(raw);
  if (uriMatch) {
    const scheme = String(uriMatch[1] || "")
      .trim()
      .toLowerCase();
    let rest = String(uriMatch[2] || "")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/");
    if (rest.length > 1) {
      rest = rest.replace(/\/+$/g, "");
    }
    return `${scheme}://${rest}`;
  }

  let text = raw.replace(/\/+/g, "/");
  if (text.length > 1) {
    text = text.replace(/\/+$/g, "");
  }
  return text;
}

function pathBaseName(path: string): string {
  const normalized = normalizeSkillPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return normalized;
  return normalized.slice(lastSlash + 1);
}

function pathParentBaseName(path: string): string {
  const normalized = normalizeSkillPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  const parent = normalized.slice(0, lastSlash);
  const parentSlash = parent.lastIndexOf("/");
  if (parentSlash < 0) return parent;
  return parent.slice(parentSlash + 1);
}

function shouldAcceptDiscoveredSkillPath(root: string, path: string): boolean {
  const normalizedRoot = normalizeSkillPath(root);
  const normalizedPath = normalizeSkillPath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  let relative = "";
  if (normalizedPath === normalizedRoot) {
    relative = "";
  } else if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    relative = normalizedPath.slice(normalizedRoot.length + 1);
  } else {
    return false;
  }
  if (!relative) return false;

  const parts = relative.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((item) => item === "node_modules" || item.startsWith(".")))
    return false;
  const base = parts[parts.length - 1] || "";
  if (parts.length === 1) {
    return /\.md$/i.test(base);
  }
  return base === "SKILL.md";
}

function trimQuotePair(text: string): string {
  const value = String(text || "").trim();
  if (!value) return value;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function parseFrontmatterBoolean(raw: string): boolean | undefined {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return undefined;
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  return undefined;
}

function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const out: ParsedSkillFrontmatter = { warnings: [] };
  const lines = String(content || "").split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return out;

  const fields: Record<string, string> = {};
  let endLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    if (line.trim() === "---") {
      endLine = i;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([a-zA-Z0-9._-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    fields[match[1].toLowerCase()] = trimQuotePair(match[2]);
  }
  if (endLine < 0) {
    out.warnings.push("frontmatter 未闭合");
    return out;
  }

  const id = String(fields.id || "").trim();
  const name = String(fields.name || "").trim();
  const description = String(fields.description || "").trim();
  const disableRaw = String(
    fields["disable-model-invocation"] ||
      fields["disable_model_invocation"] ||
      fields["disablemodelinvocation"] ||
      "",
  ).trim();

  if (id) out.id = id;
  if (name) out.name = name;
  if (description) out.description = description;
  if (disableRaw) {
    const parsed = parseFrontmatterBoolean(disableRaw);
    if (parsed === undefined) {
      out.warnings.push("disable-model-invocation 不是布尔值");
    } else {
      out.disableModelInvocation = parsed;
    }
  }
  return out;
}

function deriveSkillNameFromLocation(location: string): string {
  const base = pathBaseName(location);
  const seed =
    base.toUpperCase() === "SKILL.MD"
      ? pathParentBaseName(location)
      : base.replace(/\.md$/i, "");
  const collapsed = String(seed || "")
    .trim()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || "skill";
}

function deriveSkillIdSeedFromLocation(location: string): string {
  const base = pathBaseName(location);
  if (base.toUpperCase() === "SKILL.MD") {
    return pathParentBaseName(location) || location;
  }
  return base.replace(/\.md$/i, "") || location;
}

function extractSkillReadContent(data: unknown): string {
  const root = toRecord(data);
  const rootData = toRecord(root.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates: unknown[] = [
    data,
    root.content,
    root.text,
    rootData.content,
    rootData.text,
    rootResponse.content,
    rootResponse.text,
    rootResponseData.content,
    rootResponseData.text,
    rootResponseInnerData.content,
    rootResponseInnerData.text,
    rootResult.content,
    rootResult.text,
  ];
  for (const item of candidates) {
    if (typeof item === "string") return item;
  }
  throw new Error("brain.skill.discover: 文件读取工具未返回文本");
}

function extractBashExecResult(data: unknown): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  const root = toRecord(data);
  const rootData = toRecord(root.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates = [
    root,
    rootData,
    rootResponse,
    rootResponseData,
    rootResponseInnerData,
    rootResult,
  ];
  for (const item of candidates) {
    const stdout = item.stdout;
    if (typeof stdout !== "string") continue;
    const stderr = typeof item.stderr === "string" ? item.stderr : "";
    const exitCodeRaw = Number(item.exitCode);
    return {
      stdout,
      stderr,
      exitCode: Number.isFinite(exitCodeRaw) ? exitCodeRaw : null,
    };
  }
  throw new Error("brain.skill.discover 未返回 stdout");
}

function parseSkillDiscoverFindOutput(input: {
  root: string;
  source: string;
  stdout: string;
}): SkillDiscoverScanHit[] {
  const rows = String(input.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: SkillDiscoverScanHit[] = [];
  for (const row of rows) {
    const path = normalizeSkillPath(row);
    if (!path) continue;
    if (!shouldAcceptDiscoveredSkillPath(input.root, path)) continue;
    out.push({
      root: input.root,
      source: input.source,
      path,
    });
  }
  return out;
}

async function handleBrainSkill(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.skill.create") {
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) return fail("brain.skill.create 需要 sessionId");
    const nested = toRecord(payload.skill);
    const source =
      Object.keys(nested).length > 0 ? { ...payload, ...nested } : payload;
    const normalized = normalizeSkillCreateRequest(source);
    for (const file of normalized.writes) {
      await writeVirtualTextFile(file.path, file.content, sessionId);
    }
    const skill = await orchestrator.installSkill(normalized.skill, {
      replace: normalized.replace,
    });
    return ok({
      sessionId,
      skillId: skill.id,
      skill,
      root: normalized.root,
      skillDir: normalized.skillDir,
      location: skill.location,
      fileCount: normalized.writes.length,
      files: normalized.writes.map((item) => item.path),
    });
  }

  if (action === "brain.skill.list") {
    return ok({
      skills: await orchestrator.listSkills(),
    });
  }

  if (action === "brain.skill.install") {
    const skillPayload =
      Object.keys(toRecord(payload.skill)).length > 0
        ? toRecord(payload.skill)
        : payload;
    const location = normalizeSkillPath(skillPayload.location);
    if (!location) return fail("brain.skill.install 需要 location");
    if (!isVirtualUri(location)) {
      return fail("brain.skill.install location 仅支持 mem://");
    }

    const skill = await orchestrator.installSkill(
      {
        id: String(skillPayload.id || "").trim() || undefined,
        name: String(skillPayload.name || "").trim() || undefined,
        description: String(skillPayload.description || "").trim() || undefined,
        location,
        source: String(skillPayload.source || "").trim() || undefined,
        enabled:
          skillPayload.enabled === undefined
            ? undefined
            : skillPayload.enabled !== false,
        disableModelInvocation:
          skillPayload.disableModelInvocation === undefined
            ? undefined
            : skillPayload.disableModelInvocation === true,
      },
      {
        replace: payload.replace === true || skillPayload.replace === true,
      },
    );
    return ok({
      skillId: skill.id,
      skill,
    });
  }

  if (action === "brain.skill.resolve") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.resolve 需要 skillId");
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) return fail("brain.skill.resolve 需要 sessionId");
    const capability =
      String(payload.capability || "fs.read").trim() || "fs.read";
    const resolved = await orchestrator.resolveSkillContent(skillId, {
      allowDisabled: payload.allowDisabled === true,
      sessionId,
      capability,
    });
    return ok({
      skillId: resolved.skill.id,
      skill: resolved.skill,
      content: resolved.content,
      promptBlock: resolved.promptBlock,
    });
  }

  if (action === "brain.skill.discover") {
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) return fail("brain.skill.discover 需要 sessionId");

    const roots = normalizeSkillDiscoverRoots(payload);
    if (!roots.length) return fail("brain.skill.discover 需要 roots");

    const discoverCapability =
      String(payload.discoverCapability || "process.exec").trim() ||
      "process.exec";
    const readCapability =
      String(payload.readCapability || "fs.read").trim() || "fs.read";
    const maxFiles = normalizeIntInRange(
      payload.maxFiles,
      DEFAULT_SKILL_DISCOVER_MAX_FILES,
      1,
      MAX_SKILL_DISCOVER_MAX_FILES,
    );
    const timeoutMs = normalizeIntInRange(
      payload.timeoutMs,
      60_000,
      5_000,
      300_000,
    );
    const autoInstall = payload.autoInstall !== false;
    const replace = payload.replace !== false;

    const hits: SkillDiscoverScanHit[] = [];
    let scanStdoutBytes = 0;
    const scanStderrChunks: string[] = [];
    let scanExitCode: number | null = 0;

    for (let i = 0; i < roots.length; i += 1) {
      if (hits.length >= maxFiles) break;
      const rootItem = roots[i];
      const root = normalizeSkillPath(rootItem.root);
      const source = String(rootItem.source || "").trim() || "browser";
      const quotedRoot = `'${root.replace(/'/g, "'\"'\"'")}'`;
      const command = `find ${quotedRoot} -name '*.md'`;
      const discoveredStep = await runtimeLoop.executeStep({
        sessionId,
        capability: discoverCapability,
        action: "invoke",
        args: {
          frame: {
            tool: "bash",
            args: {
              cmdId: "bash.exec",
              args: [command],
              runtime: "sandbox",
              timeoutMs,
            },
          },
        },
        verifyPolicy: "off",
      });
      if (!discoveredStep.ok) {
        return fail(
          discoveredStep.error || `brain.skill.discover 扫描失败: ${root}`,
        );
      }

      const scanResult = extractBashExecResult(discoveredStep.data);
      scanStdoutBytes += scanResult.stdout.length;
      if (scanResult.stderr) scanStderrChunks.push(scanResult.stderr);
      if (scanResult.exitCode !== null && scanResult.exitCode !== 0) {
        scanExitCode = scanResult.exitCode;
      }
      const foundInRoot = parseSkillDiscoverFindOutput({
        root,
        source,
        stdout: scanResult.stdout,
      });
      for (const hit of foundInRoot) {
        hits.push(hit);
        if (hits.length >= maxFiles) break;
      }
    }

    const uniqueHits: SkillDiscoverScanHit[] = [];
    const seenPaths = new Set<string>();
    for (const hit of hits) {
      const normalizedPath = normalizeSkillPath(hit.path);
      if (!normalizedPath || seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);
      uniqueHits.push({
        ...hit,
        path: normalizedPath,
      });
    }

    const skipped: Array<Record<string, unknown>> = [];
    const discovered: Array<Record<string, unknown>> = [];
    const installed: unknown[] = [];

    for (const hit of uniqueHits) {
      let content = "";
      try {
        const readOut = await runtimeLoop.executeStep({
          sessionId,
          capability: readCapability,
          action: "invoke",
          args: {
            path: hit.path,
            frame: {
              tool: "read",
              args: {
                path: hit.path,
                ...(isVirtualUri(hit.path) ? { runtime: "sandbox" } : {}),
              },
            },
          },
          verifyPolicy: "off",
        });
        if (!readOut.ok) {
          skipped.push({
            location: hit.path,
            source: hit.source,
            reason: readOut.error || "文件读取失败",
          });
          continue;
        }
        content = extractSkillReadContent(readOut.data);
      } catch (error) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const frontmatter = parseSkillFrontmatter(content);
      const name = frontmatter.name || deriveSkillNameFromLocation(hit.path);
      const description = String(frontmatter.description || "").trim();
      const idSeed = String(
        frontmatter.id ||
          frontmatter.name ||
          deriveSkillIdSeedFromLocation(hit.path),
      ).trim();
      if (!description) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: "frontmatter.description 缺失，按 Pi 规则跳过",
          warnings: frontmatter.warnings,
        });
        continue;
      }

      const candidate = {
        id: idSeed,
        name,
        description,
        location: hit.path,
        source: hit.source,
        enabled: true,
        disableModelInvocation: frontmatter.disableModelInvocation === true,
        warnings: frontmatter.warnings,
      };
      discovered.push(candidate);

      if (!autoInstall) continue;
      try {
        const skill = await orchestrator.installSkill(
          {
            id: candidate.id,
            name: candidate.name,
            description: candidate.description,
            location: candidate.location,
            source: candidate.source,
            enabled: true,
            disableModelInvocation: candidate.disableModelInvocation,
          },
          {
            replace,
          },
        );
        installed.push(skill);
      } catch (error) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return ok({
      sessionId,
      roots,
      scan: {
        maxFiles,
        timeoutMs,
        discoverCapability,
        readCapability,
        stdoutBytes: scanStdoutBytes,
        stderr: scanStderrChunks.join("\n"),
        exitCode: scanExitCode,
      },
      counts: {
        scanned: uniqueHits.length,
        discovered: discovered.length,
        installed: installed.length,
        skipped: skipped.length,
      },
      discovered,
      installed,
      skipped,
      skills: autoInstall ? await orchestrator.listSkills() : undefined,
    });
  }

  if (action === "brain.skill.enable") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.enable 需要 skillId");
    const skill = await orchestrator.enableSkill(skillId);
    return ok({
      skillId: skill.id,
      skill,
    });
  }

  if (action === "brain.skill.disable") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.disable 需要 skillId");
    const skill = await orchestrator.disableSkill(skillId);
    return ok({
      skillId: skill.id,
      skill,
    });
  }

  if (action === "brain.skill.uninstall") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.uninstall 需要 skillId");
    const removed = await orchestrator.uninstallSkill(skillId);
    if (!removed) return fail(`skill 不存在: ${skillId}`);
    return ok({
      skillId,
      removed,
    });
  }

  return fail(`unsupported brain.skill action: ${action}`);
}

async function handleBrainPlugin(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  const isPluginPersistenceHydrate =
    payload.__pluginPersistenceHydrate === true;

  if (action === "brain.plugin.list") {
    const uiExtensions = await readUiExtensionDescriptors();
    return ok({
      plugins: orchestrator.listPlugins(),
      modeProviders: orchestrator.listToolProviders(),
      toolContracts: orchestrator.listToolContracts(),
      llmProviders: orchestrator.listLlmProviders(),
      capabilityProviders: orchestrator.listCapabilityProviders(),
      capabilityPolicies: orchestrator.listCapabilityPolicies(),
      uiExtensions,
    });
  }

  if (action === "brain.plugin.ui_extension.list") {
    return ok({
      uiExtensions: await readUiExtensionDescriptors(),
    });
  }

  if (action === "brain.plugin.ui_hook.run") {
    const pluginId = String(payload.pluginId || payload.id || "").trim();
    if (!pluginId) return fail("brain.plugin.ui_hook.run 需要 pluginId");
    const hook = String(payload.hook || "").trim();
    if (!hook) return fail("brain.plugin.ui_hook.run 需要 hook");

    const descriptor =
      (await readUiExtensionDescriptors()).find(
        (item) => item.pluginId === pluginId,
      ) || null;
    if (!descriptor) {
      return fail(`ui extension 不存在: ${pluginId}`);
    }
    if (descriptor.enabled !== true) {
      return ok({
        pluginId,
        hook,
        hookResult: {
          action: "continue",
        },
        skipped: "disabled",
      });
    }
    if (!isVirtualUri(descriptor.moduleUrl)) {
      return fail(
        `ui hook sandbox 仅支持 mem:// module: ${descriptor.moduleUrl}`,
      );
    }

    const sessionId =
      String(payload.sessionId || descriptor.sessionId || "").trim() ||
      PLUGIN_SANDBOX_DEFAULT_SESSION_ID;
    const exportName =
      String(payload.exportName || descriptor.exportName || "default").trim() ||
      "default";
    const startedAt = Date.now();
    let executed: Record<string, unknown>;
    try {
      executed = await invokePluginSandboxRunner({
        sessionId,
        modulePath: descriptor.moduleUrl,
        exportName,
        op: "runHook",
        hook,
        payload: payload.payload,
      });
    } catch (error) {
      emitPluginHookTrace({
        traceType: "ui_hook",
        pluginId,
        hook,
        modulePath: descriptor.moduleUrl,
        exportName,
        sessionId,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
        requestPreview: previewJsonText(payload.payload),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const runtimeMessages = Array.isArray(executed.runtimeMessages)
      ? executed.runtimeMessages
      : [];
    for (const message of runtimeMessages) {
      emitPluginRuntimeMessage(message);
    }
    const hookResult = toRecord(executed.hookResult);
    emitPluginHookTrace({
      traceType: "ui_hook",
      pluginId,
      hook,
      modulePath: descriptor.moduleUrl,
      exportName,
      sessionId,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      requestPreview: previewJsonText(payload.payload),
      responsePreview: previewJsonText(hookResult),
      runtimeMessageCount: runtimeMessages.length,
    });
    const actionName = String(hookResult.action || "").trim();
    if (actionName === "patch") {
      return ok({
        pluginId,
        hook,
        hookResult: {
          action: "patch",
          patch: toRecord(hookResult.patch),
        },
      });
    }
    if (actionName === "block") {
      return ok({
        pluginId,
        hook,
        hookResult: {
          action: "block",
          reason: String(hookResult.reason || "").trim() || undefined,
        },
      });
    }
    return ok({
      pluginId,
      hook,
      hookResult: {
        action: "continue",
      },
    });
  }

  if (action === "brain.plugin.register_extension") {
    const pluginRaw = toRecord(payload.plugin);
    const source = Object.keys(pluginRaw).length > 0 ? pluginRaw : payload;
    const manifest = normalizePluginManifest(source.manifest);
    const setupRaw = source.setup;
    const moduleInput = source.moduleUrl ?? source.modulePath ?? source.module;
    const exportName =
      String(source.exportName || "default").trim() || "default";
    const moduleSessionId =
      String(source.moduleSessionId || source.sessionId || "").trim() ||
      PLUGIN_SANDBOX_DEFAULT_SESSION_ID;
    const moduleSource = String(source.moduleSource || "").trim();
    if (moduleSource) {
      return fail(
        "moduleSource 暂不支持（CSP 禁止 unsafe-eval），请使用 moduleUrl/modulePath",
      );
    }

    let setup: ExtensionFactory;
    let moduleUrl = "";
    if (typeof setupRaw === "function") {
      setup = setupRaw as ExtensionFactory;
    } else {
      const rawModulePath = String(moduleInput || "").trim();
      moduleUrl = resolvePluginModuleUrl(moduleInput);
      if (isVirtualUri(rawModulePath) || isVirtualUri(moduleUrl)) {
        const virtualModulePath = isVirtualUri(rawModulePath)
          ? rawModulePath
          : moduleUrl;
        setup = await loadExtensionFactoryFromVirtualModule({
          manifest,
          modulePath: virtualModulePath,
          exportName,
          sessionId: moduleSessionId,
        });
        moduleUrl = virtualModulePath;
      } else {
        setup = await loadExtensionFactoryFromModule(moduleUrl, exportName);
      }
    }

    const options = resolvePluginRegisterOptions(source, payload);

    registerExtension(orchestrator, manifest, setup, options);
    const pluginId = manifest.id;
    const current =
      orchestrator.listPlugins().find((item) => item.id === pluginId) || null;
    const uiDescriptor = resolveUiExtensionDescriptorFromSource(
      pluginId,
      source,
      current?.enabled === true,
    );
    try {
      if (!isPluginPersistenceHydrate) {
        const persistenceSourceBase = {
          ...source,
          manifest,
          moduleUrl,
          exportName,
          ...(isVirtualUri(moduleUrl) ? { moduleSessionId } : {}),
          ...(uiDescriptor
            ? {
                uiModuleUrl: uiDescriptor.moduleUrl,
                uiExportName: uiDescriptor.exportName,
                ...(uiDescriptor.sessionId
                  ? { uiModuleSessionId: uiDescriptor.sessionId }
                  : {}),
              }
            : {}),
        } as Record<string, unknown>;
        const persistenceSource =
          typeof setupRaw === "function" && !String(moduleUrl || "").trim()
            ? await materializeExtensionFactoryPluginSource(
                persistenceSourceBase,
              )
            : persistenceSourceBase;
        const persisted = await persistExtensionPluginRegistration(
          persistenceSource,
          current?.enabled === true,
        );
        if (!persisted) {
          throw new Error(`plugin 持久化失败: ${pluginId}`);
        }
      }
      if (uiDescriptor) {
        await upsertUiExtensionDescriptor(uiDescriptor);
        if (!isPluginPersistenceHydrate) {
          notifyUiExtensionLifecycle(
            "brain.plugin.ui_extension.registered",
            uiDescriptor,
          );
        }
      }
    } catch (error) {
      orchestrator.unregisterPlugin(pluginId);
      if (uiDescriptor) {
        await removeUiExtensionDescriptor(pluginId).catch(() => null);
      }
      if (!isPluginPersistenceHydrate) {
        await removePersistedPluginRecord(pluginId).catch(() => false);
      }
      return fail(error);
    }
    return ok({
      pluginId,
      enabled: current?.enabled === true,
      plugin: current,
      moduleUrl,
      exportName,
      llmProviders: orchestrator.listLlmProviders(),
      ...(uiDescriptor ? { uiExtension: uiDescriptor } : {}),
    });
  }

  if (action === "brain.plugin.register") {
    const pluginRaw = toRecord(payload.plugin);
    if (Object.keys(pluginRaw).length === 0) {
      return fail("brain.plugin.register 需要 plugin");
    }
    const definition = normalizePluginDefinition(pluginRaw);
    const options = resolvePluginRegisterOptions(pluginRaw, payload);
    orchestrator.registerPlugin(definition, options);
    const pluginId = definition.manifest.id;
    const current =
      orchestrator.listPlugins().find((item) => item.id === pluginId) || null;
    const uiSource = {
      ...pluginRaw,
      ...payload,
    } as Record<string, unknown>;
    const uiDescriptor = resolveUiExtensionDescriptorFromSource(
      pluginId,
      uiSource,
      current?.enabled === true,
    );
    const persistedDefinitionSource = {
      ...pluginRaw,
      ...("uiModuleUrl" in payload ? { uiModuleUrl: payload.uiModuleUrl } : {}),
      ...("uiModulePath" in payload
        ? { uiModulePath: payload.uiModulePath }
        : {}),
      ...("uiModule" in payload ? { uiModule: payload.uiModule } : {}),
      ...("uiExportName" in payload
        ? { uiExportName: payload.uiExportName }
        : {}),
      ...("uiModuleSessionId" in payload
        ? { uiModuleSessionId: payload.uiModuleSessionId }
        : {}),
      ...("moduleSessionId" in payload
        ? { moduleSessionId: payload.moduleSessionId }
        : {}),
      ...("sessionId" in payload ? { sessionId: payload.sessionId } : {}),
    } as Record<string, unknown>;
    try {
      if (!isPluginPersistenceHydrate) {
        const persisted = await persistDefinitionPluginRegistration(
          persistedDefinitionSource,
          current?.enabled === true,
        );
        if (!persisted) {
          throw new Error(`plugin 持久化失败: ${pluginId}`);
        }
      }
      if (uiDescriptor) {
        await upsertUiExtensionDescriptor(uiDescriptor);
        if (!isPluginPersistenceHydrate) {
          notifyUiExtensionLifecycle(
            "brain.plugin.ui_extension.registered",
            uiDescriptor,
          );
        }
      }
    } catch (error) {
      orchestrator.unregisterPlugin(pluginId);
      if (uiDescriptor) {
        await removeUiExtensionDescriptor(pluginId).catch(() => null);
      }
      if (!isPluginPersistenceHydrate) {
        await removePersistedPluginRecord(pluginId).catch(() => false);
      }
      return fail(error);
    }
    return ok({
      pluginId,
      enabled: current?.enabled === true,
      plugin: current,
      llmProviders: orchestrator.listLlmProviders(),
      ...(uiDescriptor ? { uiExtension: uiDescriptor } : {}),
    });
  }

  if (action === "brain.plugin.validate") {
    const location = String(payload.location || payload.path || "").trim();
    const hasInlinePackage = Object.prototype.hasOwnProperty.call(
      payload,
      "package",
    );
    const packageFromPayload = toRecord(payload.package);
    if (hasInlinePackage && Object.keys(packageFromPayload).length === 0) {
      return fail("brain.plugin.validate 的 package 必须是 object");
    }
    const sessionId = String(payload.sessionId || "").trim() || "default";
    const packageSource =
      Object.keys(packageFromPayload).length > 0
        ? packageFromPayload
        : location
          ? await readVirtualJsonObject(
              location,
              "brain.plugin.validate location",
              sessionId,
            )
          : {};
    if (Object.keys(packageSource).length === 0) {
      return fail("brain.plugin.validate 需要 package 或 location(mem://...)");
    }

    try {
      let pluginSource = readPluginInstallSource(packageSource);
      validatePluginInstallSource(pluginSource);
      pluginSource = await materializeInlinePluginSources(
        pluginSource,
        sessionId,
      );
      const manifest = normalizePluginManifest(pluginSource.manifest);
      const pluginId = manifest.id;
      const checks: PluginValidationCheck[] = [];
      const warnings: string[] = [];

      const hasExtensionEntry = hasPluginExtensionEntry(pluginSource);
      const moduleInput = String(
        pluginSource.modulePath ||
          pluginSource.moduleUrl ||
          pluginSource.module ||
          "",
      ).trim();
      const exportName =
        String(pluginSource.exportName || "default").trim() || "default";
      if (hasExtensionEntry && moduleInput) {
        try {
          const moduleUrl = resolvePluginModuleUrl(moduleInput);
          if (isVirtualUri(moduleUrl)) {
            const describe = await invokePluginSandboxRunner({
              sessionId:
                String(
                  pluginSource.moduleSessionId || sessionId || "",
                ).trim() || sessionId,
              modulePath: moduleUrl,
              exportName,
              op: "describe",
            });
            checks.push(
              buildPluginValidationCheck("index.module", true, {
                details: {
                  moduleUrl,
                  exportName,
                  hooks: toStringList(describe.hooks) || [],
                },
              }),
            );
          } else {
            await loadExtensionFactoryFromModule(moduleUrl, exportName);
            checks.push(
              buildPluginValidationCheck("index.module", true, {
                details: {
                  moduleUrl,
                  exportName,
                },
              }),
            );
          }
        } catch (error) {
          checks.push(
            buildPluginValidationCheck("index.module", false, { error }),
          );
        }
      } else {
        warnings.push(
          "未声明 index.js 扩展入口（modulePath/moduleUrl/module）",
        );
      }

      const uiDescriptor = resolveUiExtensionDescriptorFromSource(
        pluginId,
        pluginSource,
        true,
      );
      if (uiDescriptor) {
        try {
          if (isVirtualUri(uiDescriptor.moduleUrl)) {
            const describe = await invokePluginSandboxRunner({
              sessionId:
                String(uiDescriptor.sessionId || sessionId || "").trim() ||
                sessionId,
              modulePath: uiDescriptor.moduleUrl,
              exportName: uiDescriptor.exportName,
              op: "describe",
            });
            checks.push(
              buildPluginValidationCheck("ui.module", true, {
                details: {
                  moduleUrl: uiDescriptor.moduleUrl,
                  exportName: uiDescriptor.exportName,
                  hooks: toStringList(describe.hooks) || [],
                },
              }),
            );
          } else {
            await loadExtensionFactoryFromModule(
              uiDescriptor.moduleUrl,
              uiDescriptor.exportName,
            );
            checks.push(
              buildPluginValidationCheck("ui.module", true, {
                details: {
                  moduleUrl: uiDescriptor.moduleUrl,
                  exportName: uiDescriptor.exportName,
                },
              }),
            );
          }
        } catch (error) {
          checks.push(
            buildPluginValidationCheck("ui.module", false, { error }),
          );
        }
      } else {
        warnings.push(
          "未声明 ui.js 扩展入口（uiModulePath/uiModuleUrl/uiModule）",
        );
      }

      if (!hasExtensionEntry && !uiDescriptor) {
        checks.push(
          buildPluginValidationCheck("entry.module", false, {
            error: "至少需要 index.js 或 ui.js 入口之一",
          }),
        );
      }

      return ok({
        pluginId,
        valid: checks.every((item) => item.ok),
        checks,
        warnings,
        sourceLocation: location || undefined,
      });
    } catch (error) {
      return fail(error);
    }
  }

  if (action === "brain.plugin.install") {
    const location = String(payload.location || payload.path || "").trim();
    const hasInlinePackage = Object.prototype.hasOwnProperty.call(
      payload,
      "package",
    );
    const packageFromPayload = toRecord(payload.package);
    if (hasInlinePackage && Object.keys(packageFromPayload).length === 0) {
      return fail("brain.plugin.install 的 package 必须是 object");
    }
    const sessionId = String(payload.sessionId || "").trim() || "default";
    const packageSource =
      Object.keys(packageFromPayload).length > 0
        ? packageFromPayload
        : location
          ? await readVirtualJsonObject(
              location,
              "brain.plugin.install location",
              sessionId,
            )
          : {};
    if (Object.keys(packageSource).length === 0) {
      return fail("brain.plugin.install 需要 package 或 location(mem://...)");
    }
    let pluginSource: Record<string, unknown>;
    try {
      pluginSource = readPluginInstallSource(packageSource);
      validatePluginInstallSource(pluginSource);
      pluginSource = await materializeInlinePluginSources(
        pluginSource,
        sessionId,
      );
    } catch (error) {
      return fail(error);
    }
    const installPayload = {
      ...payload,
      ...pluginSource,
    } as Record<string, unknown>;
    const hasExtensionEntry = hasPluginExtensionEntry(installPayload);
    if (hasExtensionEntry) {
      const result = await handleBrainPlugin(orchestrator, infra, {
        ...installPayload,
        type: "brain.plugin.register_extension",
        ...(payload.replace === undefined ? {} : { replace: payload.replace }),
        ...(payload.enable === undefined ? {} : { enable: payload.enable }),
      });
      if (!result.ok) return result;
      return ok({
        ...(toRecord(result.data) as Record<string, unknown>),
        sourceLocation: location || undefined,
      });
    }

    const result = await handleBrainPlugin(orchestrator, infra, {
      ...installPayload,
      type: "brain.plugin.register",
      plugin: pluginSource,
      ...(payload.replace === undefined ? {} : { replace: payload.replace }),
      ...(payload.enable === undefined ? {} : { enable: payload.enable }),
    });
    if (!result.ok) return result;
    return ok({
      ...(toRecord(result.data) as Record<string, unknown>),
      sourceLocation: location || undefined,
    });
  }

  if (action === "brain.plugin.enable") {
    const pluginId = readPluginId(payload);
    if (!pluginId) return fail("brain.plugin.enable 需要 pluginId");
    orchestrator.enablePlugin(pluginId);
    const current =
      orchestrator.listPlugins().find((item) => item.id === pluginId) || null;
    const uiExtension = await updateUiExtensionDescriptorEnabled(
      pluginId,
      true,
    );
    await updatePersistedPluginEnabled(pluginId, true);
    if (uiExtension) {
      if (!isPluginPersistenceHydrate) {
        notifyUiExtensionLifecycle(
          "brain.plugin.ui_extension.enabled",
          uiExtension,
        );
      }
    }
    return ok({
      pluginId,
      enabled: true,
      plugin: current,
      llmProviders: orchestrator.listLlmProviders(),
      ...(uiExtension ? { uiExtension } : {}),
    });
  }

  if (action === "brain.plugin.disable") {
    const pluginId = readPluginId(payload);
    if (!pluginId) return fail("brain.plugin.disable 需要 pluginId");
    orchestrator.disablePlugin(pluginId);
    const current =
      orchestrator.listPlugins().find((item) => item.id === pluginId) || null;
    const uiExtension = await updateUiExtensionDescriptorEnabled(
      pluginId,
      false,
    );
    await updatePersistedPluginEnabled(pluginId, false);
    if (uiExtension) {
      if (!isPluginPersistenceHydrate) {
        notifyUiExtensionLifecycle(
          "brain.plugin.ui_extension.disabled",
          uiExtension,
        );
      }
    }
    return ok({
      pluginId,
      enabled: false,
      plugin: current,
      llmProviders: orchestrator.listLlmProviders(),
      ...(uiExtension ? { uiExtension } : {}),
    });
  }

  if (action === "brain.plugin.unregister") {
    const pluginId = readPluginId(payload);
    if (!pluginId) return fail("brain.plugin.unregister 需要 pluginId");
    if (isBuiltinPluginId(pluginId)) {
      return fail(`内置插件不允许卸载: ${pluginId}`);
    }
    const removed = orchestrator.unregisterPlugin(pluginId);
    if (!removed) return fail(`plugin 不存在: ${pluginId}`);
    await removePersistedPluginRecord(pluginId);
    const removedUiExtension = await removeUiExtensionDescriptor(pluginId);
    if (removedUiExtension) {
      if (!isPluginPersistenceHydrate) {
        notifyUiExtensionLifecycle(
          "brain.plugin.ui_extension.unregistered",
          removedUiExtension,
        );
      }
    }
    return ok({
      pluginId,
      removed: true,
      llmProviders: orchestrator.listLlmProviders(),
      ...(removedUiExtension ? { uiExtension: removedUiExtension } : {}),
    });
  }

  return fail(`unsupported brain.plugin action: ${action}`);
}

async function handleBrainDebug(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  infra: RuntimeInfraHandler,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.debug.dump") {
    const sessionId =
      typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId.trim()
        : "";
    if (sessionId) {
      const meta = await orchestrator.sessions.getMeta(sessionId);
      if (!meta) {
        return fail(`session 不存在: ${sessionId}`);
      }
      const entries = await orchestrator.sessions.getEntries(sessionId);
      const stream = await orchestrator.getStepStream(sessionId);
      const limited = clampStepStream(stream, {
        maxEvents: payload.maxEvents,
        maxBytes: payload.maxBytes,
      });
      const conversationView = await buildConversationView(
        orchestrator,
        sessionId,
      );
      return ok({
        sessionId,
        runtime: orchestrator.getRunState(sessionId),
        meta,
        entryCount: entries.length,
        conversationView,
        stepStream: limited.stream,
        stepStreamMeta: limited.meta,
        globalTail: limited.stream.slice(-80),
      });
    }

    const index = await orchestrator.sessions.listSessions();
    return ok({
      index,
      runningSessions: index.sessions.map((entry) =>
        orchestrator.getRunState(entry.id),
      ),
      globalTail: [],
    });
  }

  if (action === "brain.debug.config") {
    const cfgResult = await infra.handleMessage({ type: "config.get" });
    if (!cfgResult || !cfgResult.ok) {
      return fail(cfgResult?.error || "config.get failed");
    }
    const cfg = toRecord(cfgResult.data);
    const profiles = Array.isArray(cfg.llmProfiles)
      ? cfg.llmProfiles.map((item) => toRecord(item))
      : [];
    const llmDefaultProfile = String(cfg.llmDefaultProfile || "default");
    const activeProfile =
      profiles.find(
        (item) => String(item.id || "").trim() === llmDefaultProfile,
      ) ||
      profiles[0] ||
      ({} as Record<string, unknown>);
    const activeProvider =
      String(activeProfile.provider || "openai_compatible").trim() ||
      "openai_compatible";
    const activeModel = String(activeProfile.llmModel || "").trim();
    const hasLlmApiKey = !!String(activeProfile.llmApiKey || "").trim();
    const systemPromptPreview = await runtimeLoop.getSystemPromptPreview();
    return ok({
      bridgeUrl: String(cfg.bridgeUrl || ""),
      browserRuntimeStrategy: String(
        cfg.browserRuntimeStrategy || "host-first",
      ),
      llmDefaultProfile,
      llmAuxProfile: String(cfg.llmAuxProfile || ""),
      llmFallbackProfile: String(cfg.llmFallbackProfile || ""),
      llmProfilesCount: profiles.length,
      llmProvider: activeProvider,
      llmModel: activeModel,
      bridgeInvokeTimeoutMs: Number(cfg.bridgeInvokeTimeoutMs || 0),
      llmTimeoutMs: Number(cfg.llmTimeoutMs || 0),
      llmRetryMaxAttempts: Number(cfg.llmRetryMaxAttempts || 0),
      llmMaxRetryDelayMs: Number(cfg.llmMaxRetryDelayMs || 0),
      hasLlmApiKey,
      systemPromptPreview,
    });
  }

  if (action === "brain.debug.plugins") {
    return ok({
      plugins: orchestrator.listPlugins(),
      modeProviders: orchestrator.listToolProviders(),
      toolContracts: orchestrator.listToolContracts(),
      llmProviders: orchestrator.listLlmProviders(),
      capabilityProviders: orchestrator.listCapabilityProviders(),
      capabilityPolicies: orchestrator.listCapabilityPolicies(),
    });
  }

  return fail(`unsupported brain.debug action: ${action}`);
}

export function registerRuntimeRouter(orchestrator: BrainOrchestrator): void {
  const infra = createRuntimeInfraHandler();
  const runtimeLoop = createRuntimeLoopController(orchestrator, infra);
  let runtimeReady: Promise<void> | null = null;
  const ensureRuntimeReady = (): Promise<void> => {
    if (!runtimeReady) {
      runtimeReady = rehydratePersistedPlugins(orchestrator, infra).catch(
        (error) => {
          console.warn("[runtime-router] runtime rehydrate failed", error);
        },
      );
    }
    return runtimeReady;
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const run = async () => {
      await ensureRuntimeReady();
      const routeBefore = await orchestrator.runHook("runtime.route.before", {
        type: String(message?.type || ""),
        message,
      });
      if (routeBefore.blocked) {
        return fail(
          `runtime.route.before blocked: ${routeBefore.reason || "blocked"}`,
        );
      }
      const routeInput = routeBefore.value;
      const type = String(routeInput.type || "");
      const routeMessage = routeInput.message as unknown;
      const applyAfter = async (
        result: RuntimeResult,
      ): Promise<RuntimeResult> => {
        const afterHook = await orchestrator.runHook("runtime.route.after", {
          type,
          message: routeMessage,
          result,
        });
        return afterHook.blocked
          ? result
          : (afterHook.value.result as RuntimeResult);
      };

      try {
        if (type === "ping") {
          return await applyAfter(
            ok({ source: "service-worker", version: "vnext" }),
          );
        }

        const infraResult = await infra.handleMessage(routeMessage);
        if (infraResult) return await applyAfter(fromInfraResult(infraResult));

        if (type.startsWith("brain.run.")) {
          return await applyAfter(
            await handleBrainRun(
              orchestrator,
              runtimeLoop,
              infra,
              routeMessage,
            ),
          );
        }

        if (type.startsWith("brain.session.")) {
          return await applyAfter(
            await handleSession(orchestrator, runtimeLoop, routeMessage),
          );
        }

        if (type.startsWith("brain.step.")) {
          return await applyAfter(
            await handleStep(orchestrator, runtimeLoop, routeMessage),
          );
        }

        if (type.startsWith("brain.storage.")) {
          return await applyAfter(await handleStorage(orchestrator, routeMessage));
        }

        if (type.startsWith("brain.skill.")) {
          return await applyAfter(
            await handleBrainSkill(orchestrator, runtimeLoop, routeMessage),
          );
        }

        if (type.startsWith("brain.plugin.")) {
          return await applyAfter(
            await handleBrainPlugin(orchestrator, infra, routeMessage),
          );
        }

        if (type.startsWith("brain.debug.")) {
          return await applyAfter(
            await handleBrainDebug(
              orchestrator,
              runtimeLoop,
              infra,
              routeMessage,
            ),
          );
        }

        if (type === "webchat.transport") {
          const senderTabId = Number((_sender?.tab?.id ?? 0) || 0);
          const handled = await handleWebChatRuntimeMessage(
            routeMessage,
            Number.isInteger(senderTabId) && senderTabId > 0
              ? senderTabId
              : undefined,
          );
          return await applyAfter(
            handled
              ? ok({ handled: true })
              : fail(`Unknown message type: ${type}`),
          );
        }

        if (type === "brain.agent.run") {
          return await applyAfter(
            await handleBrainAgentRun(orchestrator, runtimeLoop, routeMessage),
          );
        }

        if (type === "brain.agent.end") {
          const payload = toRecord(toRecord(routeMessage).payload);
          const sessionId = String(payload.sessionId || "").trim();
          if (!sessionId) return fail("brain.agent.end 需要 payload.sessionId");

          const rawError = toRecord(payload.error);
          const statusNumber = Number(rawError.status);
          const error =
            Object.keys(rawError).length === 0
              ? null
              : {
                  message:
                    typeof rawError.message === "string"
                      ? rawError.message
                      : undefined,
                  code:
                    typeof rawError.code === "string"
                      ? rawError.code
                      : undefined,
                  status: Number.isFinite(statusNumber)
                    ? statusNumber
                    : undefined,
                };

          return await applyAfter(
            ok(
              await orchestrator.handleAgentEnd({
                sessionId,
                error,
                overflow: payload.overflow === true,
              }),
            ),
          );
        }

        return await applyAfter(fail(`Unknown message type: ${type}`));
      } catch (error) {
        await orchestrator.runHook("runtime.route.error", {
          type,
          message: routeMessage,
          error: error instanceof Error ? error.message : String(error),
        });
        return await applyAfter(fail(error));
      }
    };

    void run().then((result) => sendResponse(result));
    return true;
  });
}
