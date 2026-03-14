import { defineStore } from "pinia";
import { sendMessage } from "./send-message";
import { toRecord, toIntInRange } from "./store-helpers";

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

export const usePluginStore = defineStore("plugin", () => {
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

  return {
    listPlugins,
    installPlugin,
    validatePluginPackage,
    enablePlugin,
    disablePlugin,
    unregisterPlugin,
  };
});
