import { defineStore } from "pinia";
import { ref } from "vue";
import {
  normalizeBrowserRuntimeStrategy,
  type BrowserRuntimeStrategy,
} from "../../sw/kernel/browser-runtime-strategy";
import {
  normalizeCompactionSettings,
  type CompactionSettings,
} from "../../shared/compaction";
import { normalizeProviderConnectionConfig } from "../../shared/llm-provider-config";
import { sendMessage } from "./send-message";
import { useChatStore } from "./chat-store";
export type {
  ConversationMessage,
  SessionForkSource,
  SessionIndexEntry,
  RuntimeStateView,
} from "./chat-store";

export interface PanelLlmProfile {
  id: string;
  provider: string;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  providerOptions?: Record<string, unknown>;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
}

interface PanelConfig {
  bridgeUrl: string;
  bridgeToken: string;
  browserRuntimeStrategy: BrowserRuntimeStrategy;
  compaction: CompactionSettings;
  llmDefaultProfile: string;
  llmAuxProfile: string;
  llmFallbackProfile: string;
  llmProfiles: PanelLlmProfile[];
  llmSystemPromptCustom: string;
  maxSteps: number;
  autoTitleInterval: number;
  bridgeInvokeTimeoutMs: number;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
  devAutoReload: boolean;
  devReloadIntervalMs: number;
}

interface RuntimeHealth {
  bridgeUrl: string;
  llmDefaultProfile: string;
  llmAuxProfile: string;
  llmFallbackProfile: string;
  llmProvider: string;
  llmModel: string;
  hasLlmApiKey: boolean;
  systemPromptPreview: string;
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  location: string;
  source: string;
  enabled: boolean;
  disableModelInvocation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillInstallInput {
  id?: string;
  name?: string;
  description?: string;
  location: string;
  source?: string;
  enabled?: boolean;
  disableModelInvocation?: boolean;
}

export interface SkillDiscoverRoot {
  root: string;
  source?: string;
}

export interface SkillDiscoverOptions {
  sessionId?: string;
  roots?: SkillDiscoverRoot[];
  autoInstall?: boolean;
  replace?: boolean;
  maxFiles?: number;
  timeoutMs?: number;
}

export interface SkillDiscoverResult {
  sessionId: string;
  roots: Array<{ root: string; source: string }>;
  counts: {
    scanned: number;
    discovered: number;
    installed: number;
    skipped: number;
  };
  discovered: Array<Record<string, unknown>>;
  installed: SkillMetadata[];
  skipped: Array<Record<string, unknown>>;
  skills?: SkillMetadata[];
}

export interface PluginMetadata {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  timeoutMs: number;
  lastError?: string;
  errorCount: number;
  hooks: string[];
  modes: string[];
  capabilities: string[];
  policyCapabilities: string[];
  tools: string[];
  llmProviders: string[];
  runtimeMessages: string[];
  brainEvents: string[];
  usageTotalCalls: number;
  usageTotalErrors: number;
  usageTotalTimeouts: number;
  usageLastUsedAt?: string;
  usageHookCalls: Record<string, number>;
}

export interface PluginUiExtensionMetadata {
  pluginId: string;
  moduleUrl: string;
  exportName: string;
  enabled: boolean;
  updatedAt: string;
  sessionId?: string;
}

export interface PluginListResult {
  plugins: PluginMetadata[];
  modeProviders: Array<Record<string, unknown>>;
  toolContracts: Array<Record<string, unknown>>;
  llmProviders: Array<Record<string, unknown>>;
  capabilityProviders: Array<Record<string, unknown>>;
  capabilityPolicies: Array<Record<string, unknown>>;
  uiExtensions: PluginUiExtensionMetadata[];
}

export interface PluginRegisterResult {
  pluginId: string;
  enabled: boolean;
  plugin: PluginMetadata | null;
  llmProviders: Array<Record<string, unknown>>;
  moduleUrl?: string;
  exportName?: string;
}

export interface PluginUnregisterResult {
  pluginId: string;
  removed: boolean;
  llmProviders: Array<Record<string, unknown>>;
}

export interface PluginInstallInput {
  location?: string;
  path?: string;
  package?: Record<string, unknown>;
  sessionId?: string;
}

export interface PluginValidateCheck {
  name: string;
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

export interface PluginValidateResult {
  pluginId: string;
  valid: boolean;
  warnings: string[];
  checks: PluginValidateCheck[];
  sourceLocation?: string;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function toStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function toNumberRecord(input: unknown): Record<string, number> {
  const row = toRecord(input);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = String(key || "").trim();
    if (!name) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) continue;
    out[name] = Math.floor(n);
  }
  return out;
}

function normalizePluginMetadata(input: unknown): PluginMetadata {
  const row = toRecord(input);
  return {
    id: String(row.id || "").trim(),
    name: String(row.name || "").trim(),
    version: String(row.version || "").trim(),
    enabled: row.enabled === true,
    timeoutMs: toIntInRange(row.timeoutMs, 1500, 50, 10000),
    lastError: String(row.lastError || "").trim() || undefined,
    errorCount: toIntInRange(row.errorCount, 0, 0, Number.MAX_SAFE_INTEGER),
    hooks: toStringArray(row.hooks),
    modes: toStringArray(row.modes),
    capabilities: toStringArray(row.capabilities),
    policyCapabilities: toStringArray(row.policyCapabilities),
    tools: toStringArray(row.tools),
    llmProviders: toStringArray(row.llmProviders),
    runtimeMessages: toStringArray(row.runtimeMessages),
    brainEvents: toStringArray(row.brainEvents),
    usageTotalCalls: toIntInRange(
      row.usageTotalCalls,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    usageTotalErrors: toIntInRange(
      row.usageTotalErrors,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    usageTotalTimeouts: toIntInRange(
      row.usageTotalTimeouts,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    usageLastUsedAt: String(row.usageLastUsedAt || "").trim() || undefined,
    usageHookCalls: toNumberRecord(row.usageHookCalls),
  };
}

function normalizePluginUiExtensionMetadata(
  input: unknown,
): PluginUiExtensionMetadata | null {
  const row = toRecord(input);
  const pluginId = String(row.pluginId || "").trim();
  const moduleUrl = String(row.moduleUrl || "").trim();
  if (!pluginId || !moduleUrl) return null;
  return {
    pluginId,
    moduleUrl,
    exportName: String(row.exportName || "default").trim() || "default",
    enabled: row.enabled !== false,
    updatedAt: String(row.updatedAt || "").trim() || new Date().toISOString(),
    sessionId: String(row.sessionId || "").trim() || undefined,
  };
}

function normalizePluginListResult(input: unknown): PluginListResult {
  const row = toRecord(input);
  const uiExtensions = Array.isArray(row.uiExtensions)
    ? row.uiExtensions
        .map((item) => normalizePluginUiExtensionMetadata(item))
        .filter((item): item is PluginUiExtensionMetadata => Boolean(item))
    : [];
  return {
    plugins: Array.isArray(row.plugins)
      ? row.plugins.map((item) => normalizePluginMetadata(item))
      : [],
    modeProviders: Array.isArray(row.modeProviders)
      ? row.modeProviders.map((item) => toRecord(item))
      : [],
    toolContracts: Array.isArray(row.toolContracts)
      ? row.toolContracts.map((item) => toRecord(item))
      : [],
    llmProviders: Array.isArray(row.llmProviders)
      ? row.llmProviders.map((item) => toRecord(item))
      : [],
    capabilityProviders: Array.isArray(row.capabilityProviders)
      ? row.capabilityProviders.map((item) => toRecord(item))
      : [],
    capabilityPolicies: Array.isArray(row.capabilityPolicies)
      ? row.capabilityPolicies.map((item) => toRecord(item))
      : [],
    uiExtensions,
  };
}

function normalizePluginRegisterResult(input: unknown): PluginRegisterResult {
  const row = toRecord(input);
  const pluginRaw = toRecord(row.plugin);
  return {
    pluginId: String(row.pluginId || "").trim(),
    enabled: row.enabled === true,
    plugin:
      Object.keys(pluginRaw).length > 0
        ? normalizePluginMetadata(pluginRaw)
        : null,
    llmProviders: Array.isArray(row.llmProviders)
      ? row.llmProviders.map((item) => toRecord(item))
      : [],
    moduleUrl: String(row.moduleUrl || "").trim() || undefined,
    exportName: String(row.exportName || "").trim() || undefined,
  };
}

function normalizePluginValidateResult(input: unknown): PluginValidateResult {
  const row = toRecord(input);
  const checks = Array.isArray(row.checks)
    ? row.checks
        .map((item) => {
          const check = toRecord(item);
          return {
            name: String(check.name || "").trim(),
            ok: check.ok === true,
            error: String(check.error || "").trim() || undefined,
            details:
              Object.keys(toRecord(check.details)).length > 0
                ? toRecord(check.details)
                : undefined,
          } as PluginValidateCheck;
        })
        .filter((item) => item.name)
    : [];
  return {
    pluginId: String(row.pluginId || "").trim(),
    valid: row.valid === true,
    warnings: toStringArray(row.warnings),
    checks,
    sourceLocation: String(row.sourceLocation || "").trim() || undefined,
  };
}

function normalizePluginUnregisterResult(
  input: unknown,
): PluginUnregisterResult {
  const row = toRecord(input);
  return {
    pluginId: String(row.pluginId || "").trim(),
    removed: row.removed === true,
    llmProviders: Array.isArray(row.llmProviders)
      ? row.llmProviders.map((item) => toRecord(item))
      : [],
  };
}

export const DEFAULT_PANEL_LLM_PROVIDER = "openai_compatible";
export const DEFAULT_PANEL_LLM_API_BASE = "https://ai.chen.rs/v1";
export const DEFAULT_PANEL_LLM_MODEL = "gpt-5.3-codex";

interface LlmProfileDefaults {
  id: string;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
}

function createDefaultLlmProfile(
  defaults: LlmProfileDefaults,
): PanelLlmProfile {
  const id = String(defaults.id || "default").trim() || "default";
  return {
    id,
    provider: DEFAULT_PANEL_LLM_PROVIDER,
    llmApiBase: DEFAULT_PANEL_LLM_API_BASE,
    llmApiKey: "",
    llmModel: DEFAULT_PANEL_LLM_MODEL,
    providerOptions: {},
    llmTimeoutMs: defaults.llmTimeoutMs,
    llmRetryMaxAttempts: defaults.llmRetryMaxAttempts,
    llmMaxRetryDelayMs: defaults.llmMaxRetryDelayMs,
  };
}

function normalizeSingleLlmProfile(
  raw: Record<string, unknown>,
  defaults: LlmProfileDefaults,
): PanelLlmProfile {
  const base = createDefaultLlmProfile(defaults);
  const id = String(raw.id || base.id).trim() || base.id;
  const connection = normalizeProviderConnectionConfig({
    provider: raw.provider || base.provider,
    llmApiBase: raw.llmApiBase ?? base.llmApiBase,
    llmApiKey: raw.llmApiKey ?? base.llmApiKey,
  });
  return {
    id,
    provider: String(raw.provider || base.provider).trim() || base.provider,
    llmApiBase: connection.llmApiBase,
    llmApiKey: connection.llmApiKey,
    llmModel: String(raw.llmModel || base.llmModel).trim() || base.llmModel,
    providerOptions: toRecord(raw.providerOptions),
    llmTimeoutMs: toIntInRange(
      raw.llmTimeoutMs,
      defaults.llmTimeoutMs,
      1_000,
      300_000,
    ),
    llmRetryMaxAttempts: toIntInRange(
      raw.llmRetryMaxAttempts,
      defaults.llmRetryMaxAttempts,
      0,
      6,
    ),
    llmMaxRetryDelayMs: toIntInRange(
      raw.llmMaxRetryDelayMs,
      defaults.llmMaxRetryDelayMs,
      0,
      300_000,
    ),
  };
}

function normalizeLlmProfiles(
  raw: unknown,
  defaults: LlmProfileDefaults,
): PanelLlmProfile[] {
  const out: PanelLlmProfile[] = [];
  const dedup = new Set<string>();

  const pushProfile = (value: unknown, idOverride?: string) => {
    const row = toRecord(value);
    const profile = normalizeSingleLlmProfile(row, {
      ...defaults,
      id: String(idOverride || defaults.id || "default").trim() || "default",
    });
    if (dedup.has(profile.id)) return;
    dedup.add(profile.id);
    out.push(profile);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) pushProfile(item);
  }

  if (out.length === 0) {
    out.push(createDefaultLlmProfile(defaults));
  }

  return out;
}

function extractContentFromStepExecuteResult(value: unknown): string {
  const root = toRecord(value);
  const rootData = toRecord(root.data);
  const rootDataData = toRecord(rootData.data);
  const rootDataResponse = toRecord(rootData.response);
  const rootDataResponseData = toRecord(rootDataResponse.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates: unknown[] = [
    root.content,
    root.text,
    rootData.content,
    rootData.text,
    rootDataData.content,
    rootDataData.text,
    rootDataResponse.content,
    rootDataResponse.text,
    rootDataResponseData.content,
    rootDataResponseData.text,
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
  throw new Error("文件读取工具未返回 content 文本");
}

function normalizeConfig(
  raw: Record<string, unknown> | null | undefined,
): PanelConfig {
  const bridgeUrl = String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws");
  const bridgeToken = String(raw?.bridgeToken || "");
  const llmTimeoutMs = toIntInRange(raw?.llmTimeoutMs, 120000, 1_000, 300_000);
  const llmRetryMaxAttempts = toIntInRange(raw?.llmRetryMaxAttempts, 2, 0, 6);
  const llmMaxRetryDelayMs = toIntInRange(
    raw?.llmMaxRetryDelayMs,
    60000,
    0,
    300_000,
  );
  const defaultProfile =
    String(raw?.llmDefaultProfile || "default").trim() || "default";

  const llmProfiles = normalizeLlmProfiles(raw?.llmProfiles, {
    id: defaultProfile,
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
  });
  const validProfileIds = new Set(llmProfiles.map((item) => item.id));
  const llmDefaultProfile = validProfileIds.has(defaultProfile)
    ? defaultProfile
    : llmProfiles[0]?.id || "default";
  const auxProfile = String(raw?.llmAuxProfile || "").trim();
  const fallbackProfile = String(raw?.llmFallbackProfile || "").trim();

  return {
    bridgeUrl,
    bridgeToken,
    browserRuntimeStrategy: normalizeBrowserRuntimeStrategy(
      raw?.browserRuntimeStrategy,
      "browser-first",
    ),
    compaction: normalizeCompactionSettings(raw?.compaction),
    llmDefaultProfile,
    llmAuxProfile:
      auxProfile &&
      auxProfile !== llmDefaultProfile &&
      validProfileIds.has(auxProfile)
        ? auxProfile
        : "",
    llmFallbackProfile:
      fallbackProfile &&
      fallbackProfile !== llmDefaultProfile &&
      validProfileIds.has(fallbackProfile)
        ? fallbackProfile
        : "",
    llmProfiles,
    llmSystemPromptCustom: String(raw?.llmSystemPromptCustom || ""),
    maxSteps: toIntInRange(raw?.maxSteps, 100, 1, 500),
    autoTitleInterval: toIntInRange(raw?.autoTitleInterval, 10, 0, 100),
    bridgeInvokeTimeoutMs: toIntInRange(
      raw?.bridgeInvokeTimeoutMs,
      120000,
      1_000,
      300_000,
    ),
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
    devAutoReload: raw?.devAutoReload === true,
    devReloadIntervalMs: toIntInRange(
      raw?.devReloadIntervalMs,
      1500,
      500,
      30000,
    ),
  };
}

function normalizeHealth(
  raw: Record<string, unknown> | null | undefined,
): RuntimeHealth {
  return {
    bridgeUrl: String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws"),
    llmDefaultProfile: String(raw?.llmDefaultProfile || "default"),
    llmAuxProfile: String(raw?.llmAuxProfile || ""),
    llmFallbackProfile: String(raw?.llmFallbackProfile || ""),
    llmProvider: String(raw?.llmProvider || DEFAULT_PANEL_LLM_PROVIDER),
    llmModel: String(raw?.llmModel || DEFAULT_PANEL_LLM_MODEL),
    hasLlmApiKey: Boolean(raw?.hasLlmApiKey),
    systemPromptPreview: String(raw?.systemPromptPreview || ""),
  };
}

export const useRuntimeStore = defineStore("runtime", () => {
  const chatStore = useChatStore();
  const loading = ref(false);
  const savingConfig = ref(false);
  const error = ref("");
  const health = ref<RuntimeHealth>(
    normalizeHealth({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      llmDefaultProfile: "default",
      llmAuxProfile: "",
      llmFallbackProfile: "",
      llmProvider: DEFAULT_PANEL_LLM_PROVIDER,
      llmModel: DEFAULT_PANEL_LLM_MODEL,
      hasLlmApiKey: false,
    }),
  );
  const config = ref<PanelConfig>(
    normalizeConfig({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      llmDefaultProfile: "default",
      llmAuxProfile: "",
      llmFallbackProfile: "",
      compaction: normalizeCompactionSettings(undefined),
      llmSystemPromptCustom: "",
      autoTitleInterval: 10,
      bridgeInvokeTimeoutMs: 120000,
      llmTimeoutMs: 120000,
      llmRetryMaxAttempts: 2,
      llmMaxRetryDelayMs: 60000,
    }),
  );

  async function ensureSkillSessionId(
    inputSessionId?: string,
  ): Promise<string> {
    const provided = String(inputSessionId || "").trim();
    if (provided) return provided;
    const current = String(chatStore.activeSessionId || "").trim();
    if (current) return current;
    await chatStore.createSession();
    return chatStore.activeSessionId;
  }

  async function listSkills(): Promise<SkillMetadata[]> {
    const out = await sendMessage<{ skills: SkillMetadata[] }>(
      "brain.skill.list",
    );
    return Array.isArray(out.skills) ? out.skills : [];
  }

  async function readVirtualFile(
    path: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<string> {
    const sessionId = await ensureSkillSessionId();
    const step = await sendMessage<Record<string, unknown>>(
      "brain.step.execute",
      {
        sessionId,
        capability: "fs.read",
        action: "invoke",
        args: {
          frame: {
            tool: "read",
            args: {
              path: String(path || "").trim(),
              runtime: "sandbox",
              ...(options.offset == null ? {} : { offset: options.offset }),
              ...(options.limit == null ? {} : { limit: options.limit }),
            },
          },
        },
        verifyPolicy: "off",
      },
    );
    const result = toRecord(step);
    if (result.ok !== true) {
      throw new Error(String(result.error || "文件读取失败"));
    }
    return extractContentFromStepExecuteResult(result.data);
  }

  async function writeVirtualFile(
    path: string,
    content: string,
    mode: "overwrite" | "append" | "create" = "overwrite",
  ): Promise<void> {
    const sessionId = await ensureSkillSessionId();
    const step = await sendMessage<Record<string, unknown>>(
      "brain.step.execute",
      {
        sessionId,
        capability: "fs.write",
        action: "invoke",
        args: {
          frame: {
            tool: "write",
            args: {
              path: String(path || "").trim(),
              runtime: "sandbox",
              content: String(content || ""),
              mode,
            },
          },
        },
        verifyPolicy: "off",
      },
    );
    const result = toRecord(step);
    if (result.ok !== true) {
      throw new Error(String(result.error || "文件写入失败"));
    }
  }

  async function installSkill(
    input: SkillInstallInput,
    options: { replace?: boolean } = {},
  ): Promise<SkillMetadata> {
    const payload: Record<string, unknown> = {
      skill: {
        ...input,
      },
    };
    if (options.replace === true) payload.replace = true;
    const out = await sendMessage<{ skill: SkillMetadata }>(
      "brain.skill.install",
      payload,
    );
    return out.skill;
  }

  async function enableSkill(skillId: string): Promise<SkillMetadata> {
    const out = await sendMessage<{ skill: SkillMetadata }>(
      "brain.skill.enable",
      { skillId },
    );
    return out.skill;
  }

  async function disableSkill(skillId: string): Promise<SkillMetadata> {
    const out = await sendMessage<{ skill: SkillMetadata }>(
      "brain.skill.disable",
      { skillId },
    );
    return out.skill;
  }

  async function uninstallSkill(skillId: string): Promise<boolean> {
    const out = await sendMessage<{ removed: boolean }>(
      "brain.skill.uninstall",
      { skillId },
    );
    return out.removed === true;
  }

  async function discoverSkills(
    options: SkillDiscoverOptions = {},
  ): Promise<SkillDiscoverResult> {
    const sessionId = await ensureSkillSessionId(options.sessionId);
    const out = await sendMessage<SkillDiscoverResult>("brain.skill.discover", {
      sessionId,
      ...(Array.isArray(options.roots) && options.roots.length > 0
        ? { roots: options.roots }
        : {}),
      ...(options.autoInstall === undefined
        ? {}
        : { autoInstall: options.autoInstall }),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
      ...(options.maxFiles == null ? {} : { maxFiles: options.maxFiles }),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
    });
    return out;
  }

  async function runSkill(skillId: string, argsText = ""): Promise<void> {
    const id = String(skillId || "").trim();
    if (!id) {
      throw new Error("skillId 不能为空");
    }
    const args = String(argsText || "").trim();
    const prompt = args ? `/skill:${id} ${args}` : `/skill:${id}`;
    await chatStore.sendPrompt(prompt);
  }

  async function listPlugins(): Promise<PluginListResult> {
    const out = await sendMessage<Record<string, unknown>>("brain.plugin.list");
    return normalizePluginListResult(out);
  }

  async function enablePlugin(pluginId: string): Promise<PluginRegisterResult> {
    const out = await sendMessage<Record<string, unknown>>(
      "brain.plugin.enable",
      {
        pluginId: String(pluginId || "").trim(),
      },
    );
    return normalizePluginRegisterResult(out);
  }

  async function disablePlugin(
    pluginId: string,
  ): Promise<PluginRegisterResult> {
    const out = await sendMessage<Record<string, unknown>>(
      "brain.plugin.disable",
      {
        pluginId: String(pluginId || "").trim(),
      },
    );
    return normalizePluginRegisterResult(out);
  }

  async function unregisterPlugin(
    pluginId: string,
  ): Promise<PluginUnregisterResult> {
    const out = await sendMessage<Record<string, unknown>>(
      "brain.plugin.unregister",
      {
        pluginId: String(pluginId || "").trim(),
      },
    );
    return normalizePluginUnregisterResult(out);
  }

  async function installPlugin(
    input: PluginInstallInput,
    options: { replace?: boolean; enable?: boolean } = {},
  ): Promise<PluginRegisterResult> {
    const payload: Record<string, unknown> = {};
    const location = String(input.location || input.path || "").trim();
    if (location) payload.location = location;
    if (input.package && typeof input.package === "object")
      payload.package = toRecord(input.package);
    const sessionId = String(input.sessionId || "").trim();
    if (sessionId) payload.sessionId = sessionId;
    if (options.replace === true) payload.replace = true;
    if (options.enable === false) payload.enable = false;
    const out = await sendMessage<Record<string, unknown>>(
      "brain.plugin.install",
      payload,
    );
    return normalizePluginRegisterResult(out);
  }

  async function validatePluginPackage(
    input: PluginInstallInput,
  ): Promise<PluginValidateResult> {
    const payload: Record<string, unknown> = {};
    const location = String(input.location || input.path || "").trim();
    if (location) payload.location = location;
    if (input.package && typeof input.package === "object")
      payload.package = toRecord(input.package);
    const sessionId = String(input.sessionId || "").trim();
    if (sessionId) payload.sessionId = sessionId;
    const out = await sendMessage<Record<string, unknown>>(
      "brain.plugin.validate",
      payload,
    );
    return normalizePluginValidateResult(out);
  }

  async function bootstrap() {
    loading.value = true;
    error.value = "";
    try {
      const cfg = await sendMessage<Record<string, unknown>>("config.get");
      config.value = normalizeConfig(cfg);
      await Promise.all([refreshHealth(), chatStore.refreshSessions()]);
      if (!String(config.value.llmSystemPromptCustom || "").trim()) {
        const preview = String(health.value.systemPromptPreview || "");
        if (preview.trim()) {
          config.value.llmSystemPromptCustom = preview;
        }
      }
      if (chatStore.activeSessionId) {
        await chatStore.loadConversation(chatStore.activeSessionId, { setActive: false });
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function refreshHealth() {
    const raw =
      await sendMessage<Record<string, unknown>>("brain.debug.config");
    health.value = normalizeHealth(raw);
  }

  async function saveConfig() {
    savingConfig.value = true;
    error.value = "";
    try {
      const llmTimeoutMs = Math.max(
        1000,
        Number(config.value.llmTimeoutMs || 120000),
      );
      const llmRetryMaxAttempts = Math.max(
        0,
        Math.min(6, Number(config.value.llmRetryMaxAttempts || 2)),
      );
      const llmMaxRetryDelayMs = Math.max(
        0,
        Number(config.value.llmMaxRetryDelayMs || 60000),
      );

      const llmProfiles = normalizeLlmProfiles(config.value.llmProfiles, {
        id:
          String(config.value.llmDefaultProfile || "default").trim() ||
          "default",
        llmTimeoutMs,
        llmRetryMaxAttempts,
        llmMaxRetryDelayMs,
      });
      const profileIds = new Set(llmProfiles.map((item) => item.id));
      const llmDefaultProfileRaw = String(
        config.value.llmDefaultProfile || "",
      ).trim();
      const llmDefaultProfile = profileIds.has(llmDefaultProfileRaw)
        ? llmDefaultProfileRaw
        : llmProfiles[0]?.id || "default";
      const llmAuxProfileRaw = String(config.value.llmAuxProfile || "").trim();
      const llmFallbackProfileRaw = String(
        config.value.llmFallbackProfile || "",
      ).trim();
      const llmAuxProfile =
        llmAuxProfileRaw &&
        llmAuxProfileRaw !== llmDefaultProfile &&
        profileIds.has(llmAuxProfileRaw)
          ? llmAuxProfileRaw
          : "";
      const llmFallbackProfile =
        llmFallbackProfileRaw &&
        llmFallbackProfileRaw !== llmDefaultProfile &&
        profileIds.has(llmFallbackProfileRaw)
          ? llmFallbackProfileRaw
          : "";
      const browserRuntimeStrategy = normalizeBrowserRuntimeStrategy(
        config.value.browserRuntimeStrategy,
        "browser-first",
      );

      config.value.llmProfiles = llmProfiles;
      config.value.llmDefaultProfile = llmDefaultProfile;
      config.value.llmAuxProfile = llmAuxProfile;
      config.value.llmFallbackProfile = llmFallbackProfile;
      config.value.browserRuntimeStrategy = browserRuntimeStrategy;
      config.value.compaction = normalizeCompactionSettings(
        config.value.compaction,
      );

      await sendMessage("config.save", {
        payload: {
          bridgeUrl: config.value.bridgeUrl.trim(),
          bridgeToken: config.value.bridgeToken,
          browserRuntimeStrategy,
          compaction: config.value.compaction,
          llmDefaultProfile,
          llmAuxProfile,
          llmFallbackProfile,
          llmProfiles,
          llmSystemPromptCustom: config.value.llmSystemPromptCustom,
          maxSteps: Math.max(1, Number(config.value.maxSteps || 100)),
          autoTitleInterval: Math.max(
            0,
            Number(config.value.autoTitleInterval ?? 10),
          ),
          bridgeInvokeTimeoutMs: Math.max(
            1000,
            Number(config.value.bridgeInvokeTimeoutMs || 120000),
          ),
          llmTimeoutMs,
          llmRetryMaxAttempts,
          llmMaxRetryDelayMs,
          devAutoReload: config.value.devAutoReload,
          devReloadIntervalMs: Math.max(
            500,
            Number(config.value.devReloadIntervalMs || 1500),
          ),
        },
      });
      await sendMessage("bridge.connect");
      await refreshHealth();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      savingConfig.value = false;
    }
  }

  return {
    loading,
    savingConfig,
    error,
    health,
    config,
    bootstrap,
    refreshHealth,
    listSkills,
    readVirtualFile,
    writeVirtualFile,
    installSkill,
    enableSkill,
    disableSkill,
    uninstallSkill,
    discoverSkills,
    runSkill,
    listPlugins,
    installPlugin,
    validatePluginPackage,
    enablePlugin,
    disablePlugin,
    unregisterPlugin,
    saveConfig,
  };
});
