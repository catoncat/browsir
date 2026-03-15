import type { ExtensionFactory } from "../extension-api";
import type { HookHandler } from "../hook-runner";
import type { LlmProviderSendInput } from "../llm-provider";
import type { OrchestratorHookMap } from "../orchestrator-hooks";
import type { AgentPluginManifest } from "../plugin-runtime";
import { invokeVirtualFrame, isVirtualUri } from "../virtual-fs.browser";
import { removeVirtualPathRecursively } from "./virtual-resource-ops";

export const MAX_PLUGIN_PACKAGE_READ_BYTES = 512 * 1024;
export const PLUGIN_SANDBOX_DEFAULT_SESSION_ID = "plugin-studio";
const PLUGIN_SANDBOX_RUNNER_PATH = "mem://__bbl/plugin-host-runner.cjs";
const PLUGIN_SANDBOX_RESULT_PREFIX = "__BBL_PLUGIN_RESULT__";
const PLUGIN_SANDBOX_RUNNER_SOURCE = String.raw`const RESULT_PREFIX = "__BBL_PLUGIN_RESULT__";

function toRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeModuleSource(source) {
  const text = String(source || "");
  if (!/(^|\n)\s*export\s+default\b/.test(text)) {
    return text;
  }
  return text.replace(
    /(^|\n)([ \t]*)export\s+default\b/,
    (_match, prefix, indent) => prefix + indent + "module.exports =",
  );
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
    const moduleSource = normalizeModuleSource(
      Buffer.from(moduleSourceBase64, "base64").toString("utf8"),
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
      if (
        !id ||
        !provider ||
        typeof provider !== "object" ||
        typeof provider.resolveRequestUrl !== "function" ||
        typeof provider.send !== "function"
      ) {
        return;
      }
      let staticRequestUrl = String(
        provider?.__bblStaticRequestUrl || provider?.staticRequestUrl || ""
      ).trim();
      if (!staticRequestUrl) {
        try {
          staticRequestUrl = String(
            provider.resolveRequestUrl({
              profile: "",
              provider: id,
              llmBase: "",
              llmKey: "",
              llmModel: "",
              llmTimeoutMs: 0,
              llmRetryMaxAttempts: 0,
              llmMaxRetryDelayMs: 0,
              role: "",
              escalationPolicy: "upgrade_only",
              orderedProfiles: [],
              fromLegacy: false
            }) || ""
          ).trim();
        } catch (_error) {
          staticRequestUrl = "";
        }
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
        registeredHooks: Object.keys(registry.hooks),
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

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
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

function toSafeVirtualSegment(input: unknown): string {
  const text = String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return text || "plugin";
}

export function buildPluginVirtualSourcePaths(pluginId: string): {
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

export async function readVirtualJsonObject(
  path: string,
  field: string,
  sessionId = "default",
): Promise<Record<string, unknown>> {
  const content = await readVirtualTextFile(path, field, sessionId);
  return parseJsonObjectText(content, field);
}

export async function readVirtualTextFile(
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

export async function writeVirtualTextFile(
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

export async function cleanupPluginVirtualArtifacts(
  pluginId: string,
  sessionId: string,
): Promise<void> {
  const root = buildPluginVirtualSourcePaths(pluginId).root;
  await removeVirtualPathRecursively(root, sessionId);
}

export function emitPluginRuntimeMessage(message: unknown): void {
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

export function previewJsonText(value: unknown, max = 600): string {
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

export function emitPluginHookTrace(payload: Record<string, unknown>): void {
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

export type PluginSandboxRunnerOp =
  | "describe"
  | "runHook"
  | "runHookRegistration"
  | "runModeProviderInvoke"
  | "runCapabilityProviderCanHandle"
  | "runCapabilityProviderInvoke"
  | "runLlmProviderResolveRequestUrl"
  | "runLlmProviderSend";

export async function invokePluginSandboxRunner(input: {
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

export async function loadExtensionFactoryFromVirtualModule(input: {
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
      const hookName = registration.hook as keyof OrchestratorHookMap & string;
      const hookHandler = (async (eventPayload: unknown) => {
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
      }) as HookHandler<
        OrchestratorHookMap[keyof OrchestratorHookMap & string]
      >;
      api.on(hookName, hookHandler, registration.options);
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
