import type { HookHandler, HookHandlerOptions } from "./hook-runner";
import type { OrchestratorHookMap } from "./orchestrator-hooks";
import type { ExecuteCapability, ExecuteMode } from "./types";
import type { CapabilityExecutionPolicy, RegisterCapabilityPolicyOptions } from "./capability-policy";
import type { RegisterProviderOptions, StepToolProvider } from "./tool-provider-registry";
import type { ToolContract, ToolContractView } from "./tool-contract-registry";
import type { LlmProviderAdapter } from "./llm-provider";
import type { RegisterLlmProviderOptions } from "./llm-provider-registry";

export interface AgentPluginPermissions {
  hooks?: string[];
  modes?: ExecuteMode[];
  capabilities?: ExecuteCapability[];
  replaceProviders?: boolean;
  tools?: string[];
  replaceToolContracts?: boolean;
  llmProviders?: string[];
  replaceLlmProviders?: boolean;
  runtimeMessages?: string[];
  brainEvents?: string[];
}

export interface AgentPluginManifest {
  id: string;
  name: string;
  version: string;
  timeoutMs?: number;
  permissions?: AgentPluginPermissions;
}

type PluginHookEntry<K extends keyof OrchestratorHookMap & string> =
  | HookHandler<OrchestratorHookMap[K]>
  | {
      handler: HookHandler<OrchestratorHookMap[K]>;
      options?: HookHandlerOptions;
    };

type PluginHookEntries<K extends keyof OrchestratorHookMap & string> = PluginHookEntry<K> | PluginHookEntry<K>[];

export interface AgentPluginDefinition {
  manifest: AgentPluginManifest;
  hooks?: Partial<{
    [K in keyof OrchestratorHookMap & string]: PluginHookEntries<K>;
  }>;
  providers?: {
    modes?: Partial<Record<ExecuteMode, StepToolProvider>>;
    capabilities?: Record<ExecuteCapability, StepToolProvider>;
  };
  policies?: {
    capabilities?: Record<ExecuteCapability, CapabilityExecutionPolicy>;
  };
  tools?: ToolContract[];
  llmProviders?: LlmProviderAdapter[];
}

export interface PluginRuntimeView {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  timeoutMs: number;
  lastError?: string;
  errorCount: number;
  hooks: string[];
  modes: ExecuteMode[];
  capabilities: ExecuteCapability[];
  policyCapabilities: ExecuteCapability[];
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

interface RuntimeHost {
  onHook<K extends keyof OrchestratorHookMap & string>(
    hook: K,
    handler: HookHandler<OrchestratorHookMap[K]>,
    options?: HookHandlerOptions
  ): () => void;
  registerToolProvider(mode: ExecuteMode, provider: StepToolProvider, options?: RegisterProviderOptions): void;
  unregisterToolProvider(mode: ExecuteMode, expectedProviderId?: string): boolean;
  getToolProvider(mode: ExecuteMode): StepToolProvider | undefined;
  registerCapabilityProvider(capability: ExecuteCapability, provider: StepToolProvider, options?: RegisterProviderOptions): void;
  unregisterCapabilityProvider(capability: ExecuteCapability, expectedProviderId?: string): boolean;
  getCapabilityProvider(capability: ExecuteCapability): StepToolProvider | undefined;
  getCapabilityProviders(capability: ExecuteCapability): StepToolProvider[];
  registerCapabilityPolicy(
    capability: ExecuteCapability,
    policy: CapabilityExecutionPolicy,
    options?: RegisterCapabilityPolicyOptions
  ): string;
  unregisterCapabilityPolicy(capability: ExecuteCapability, expectedPolicyId?: string): boolean;
  getCapabilityPolicy(capability: ExecuteCapability): {
    capability: ExecuteCapability;
    source: "builtin" | "override";
    id: string;
    policy: CapabilityExecutionPolicy;
  } | null;
  registerToolContract(contract: ToolContract, options?: { replace?: boolean }): void;
  unregisterToolContract(name: string): boolean;
  resolveToolContract(name: string): ToolContract | null;
  listToolContracts(): ToolContractView[];
  registerLlmProvider(provider: LlmProviderAdapter, options?: RegisterLlmProviderOptions): void;
  unregisterLlmProvider(id: string): boolean;
  getLlmProvider(id: string): LlmProviderAdapter | undefined;
}

interface ReplacedModeProvider {
  mode: ExecuteMode;
  provider: StepToolProvider;
}

interface ReplacedCapabilityProvider {
  capability: ExecuteCapability;
  providers: StepToolProvider[];
}

interface ReplacedCapabilityPolicy {
  capability: ExecuteCapability;
  policyId: string;
  policy: CapabilityExecutionPolicy;
}

interface ReplacedToolContract {
  name: string;
  contract: ToolContract;
}

interface ReplacedLlmProvider {
  id: string;
  provider: LlmProviderAdapter;
}

interface PluginState {
  definition: AgentPluginDefinition;
  enabled: boolean;
  unregisterHooks: Array<() => void>;
  ownedModeProviders: Array<{ mode: ExecuteMode; providerId: string }>;
  ownedCapabilityProviders: Array<{ capability: ExecuteCapability; providerId: string }>;
  ownedCapabilityPolicies: Array<{ capability: ExecuteCapability; policyId: string }>;
  ownedToolContracts: string[];
  ownedLlmProviders: string[];
  replacedModeProviders: ReplacedModeProvider[];
  replacedCapabilityProviders: ReplacedCapabilityProvider[];
  replacedCapabilityPolicies: ReplacedCapabilityPolicy[];
  replacedToolContracts: ReplacedToolContract[];
  replacedLlmProviders: ReplacedLlmProvider[];
  errorCount: number;
  lastError?: string;
  usageTotalCalls: number;
  usageTotalErrors: number;
  usageTotalTimeouts: number;
  usageLastUsedAt?: string;
  usageHookCalls: Record<string, number>;
}

function toHookEntry<K extends keyof OrchestratorHookMap & string>(entry: PluginHookEntry<K>): {
  handler: HookHandler<OrchestratorHookMap[K]>;
  options: HookHandlerOptions;
} {
  if (typeof entry === "function") {
    return { handler: entry, options: {} };
  }
  return {
    handler: entry.handler,
    options: entry.options ?? {}
  };
}

function normalizeHookEntries<K extends keyof OrchestratorHookMap & string>(entries: PluginHookEntries<K>): PluginHookEntry<K>[] {
  const list = Array.isArray(entries) ? entries : [entries];
  return list.filter(Boolean);
}

function toUniqueStringList(input: unknown): string[] {
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

export class PluginRuntime {
  private readonly host: RuntimeHost;
  private readonly plugins = new Map<string, PluginState>();

  constructor(host: RuntimeHost) {
    this.host = host;
  }

  register(definition: AgentPluginDefinition, options: { enable?: boolean; replace?: boolean } = {}): void {
    const manifest = definition.manifest;
    const id = String(manifest.id || "").trim();
    if (!id) throw new Error("plugin.manifest.id 不能为空");
    if (!options.replace && this.plugins.has(id)) {
      throw new Error(`plugin already registered: ${id}`);
    }
    if (options.replace && this.plugins.has(id)) {
      this.unregister(id);
    }

    const state: PluginState = {
      definition,
      enabled: false,
      unregisterHooks: [],
      ownedModeProviders: [],
      ownedCapabilityProviders: [],
      ownedCapabilityPolicies: [],
      ownedToolContracts: [],
      ownedLlmProviders: [],
      replacedModeProviders: [],
      replacedCapabilityProviders: [],
      replacedCapabilityPolicies: [],
      replacedToolContracts: [],
      replacedLlmProviders: [],
      errorCount: 0,
      usageTotalCalls: 0,
      usageTotalErrors: 0,
      usageTotalTimeouts: 0,
      usageHookCalls: {}
    };
    this.plugins.set(id, state);
    if (options.enable !== false) {
      this.enable(id);
    }
  }

  unregister(pluginId: string): boolean {
    const id = String(pluginId || "").trim();
    const current = this.plugins.get(id);
    if (!current) return false;
    this.disable(id);
    this.plugins.delete(id);
    return true;
  }

  enable(pluginId: string): void {
    const id = String(pluginId || "").trim();
    const state = this.plugins.get(id);
    if (!state) throw new Error(`plugin 不存在: ${id}`);
    if (state.enabled) return;

    const manifest = state.definition.manifest;
    const permissions = manifest.permissions ?? {};
    const allowReplaceModeProviders = permissions.replaceProviders !== false;
    const allowReplaceCapabilityProviders = permissions.replaceProviders === true;
    const allowReplaceCapabilityPolicies = permissions.replaceProviders !== false;
    const allowReplaceTools = permissions.replaceToolContracts !== false;
    const allowReplaceLlmProviders = permissions.replaceLlmProviders !== false;
    const timeoutMs = Math.max(50, Math.min(10_000, Number(manifest.timeoutMs || 1500)));

    try {
      for (const [hook, raw] of Object.entries(state.definition.hooks || {})) {
        if (!raw) continue;
        const entries = normalizeHookEntries(raw as PluginHookEntries<keyof OrchestratorHookMap & string>);
        for (const [idx, item] of entries.entries()) {
          const entry = toHookEntry(item);
          const unregister = this.host.onHook(
            hook as keyof OrchestratorHookMap & string,
            async (payload) => {
              const hookName = String(hook || "").trim();
              state.usageTotalCalls += 1;
              state.usageLastUsedAt = new Date().toISOString();
              if (hookName) {
                state.usageHookCalls[hookName] = (state.usageHookCalls[hookName] || 0) + 1;
              }
              const timeoutResult = { __bblTimeout: true as const };
              const timer = new Promise<typeof timeoutResult>((resolve) =>
                setTimeout(() => resolve(timeoutResult), timeoutMs)
              );
              try {
                const result = await Promise.race([Promise.resolve(entry.handler(payload)), timer]);
                if (result && typeof result === "object" && (result as { __bblTimeout?: boolean }).__bblTimeout === true) {
                  state.usageTotalTimeouts += 1;
                  state.usageTotalErrors += 1;
                  state.lastError = `plugin hook timeout: ${hookName || "unknown"}`;
                  state.errorCount += 1;
                  return { action: "continue" };
                }
                if (!result) return { action: "continue" };
                return result;
              } catch (error) {
                state.usageTotalErrors += 1;
                state.lastError = error instanceof Error ? error.message : String(error);
                state.errorCount += 1;
                return { action: "continue" };
              }
            },
            {
              ...entry.options,
              // Hook id 总是挂插件命名空间，避免跨插件冲突卸载。
              id: `${id}:${hook}:${String(entry.options.id || `handler-${idx + 1}`).trim() || `handler-${idx + 1}`}`
            }
          );
          state.unregisterHooks.push(unregister);
        }
      }

      for (const [mode, provider] of Object.entries(state.definition.providers?.modes || {}) as Array<
        [ExecuteMode, StepToolProvider | undefined]
      >) {
        if (!provider) continue;
        const nextProviderId = provider.id || `${id}:mode:${mode}`;
        if (allowReplaceModeProviders) {
          const previous = this.host.getToolProvider(mode);
          if (previous) {
            state.replacedModeProviders.push({ mode, provider: previous });
          }
        }
        this.host.registerToolProvider(
          mode,
          {
            ...provider,
            id: nextProviderId
          },
          {
            replace: allowReplaceModeProviders
          }
        );
        state.ownedModeProviders.push({ mode, providerId: nextProviderId });
      }

      for (const [capability, provider] of Object.entries(state.definition.providers?.capabilities || {})) {
        if (!provider) continue;
        const nextProviderId = provider.id || `${id}:capability:${capability}`;
        if (allowReplaceCapabilityProviders) {
          const previous = this.host.getCapabilityProviders(capability);
          if (previous.length > 0) {
            state.replacedCapabilityProviders.push({ capability, providers: previous });
          }
        }
        this.host.registerCapabilityProvider(
          capability,
          {
            ...provider,
            id: nextProviderId
          },
          {
            replace: allowReplaceCapabilityProviders
          }
        );
        state.ownedCapabilityProviders.push({
          capability,
          providerId: nextProviderId
        });
      }

      for (const [capability, policy] of Object.entries(state.definition.policies?.capabilities || {})) {
        if (!policy) continue;
        if (allowReplaceCapabilityPolicies) {
          const previous = this.host.getCapabilityPolicy(capability);
          if (previous?.source === "override") {
            state.replacedCapabilityPolicies.push({
              capability,
              policyId: previous.id,
              policy: previous.policy
            });
          }
        }
        const policyId = this.host.registerCapabilityPolicy(capability, policy, {
          replace: allowReplaceCapabilityPolicies,
          id: `${id}:policy:${capability}`
        });
        state.ownedCapabilityPolicies.push({
          capability,
          policyId
        });
      }

      for (const toolContract of Array.isArray(state.definition.tools) ? state.definition.tools : []) {
        const toolName = String(toolContract?.name || "").trim();
        if (!toolName) {
          throw new Error(`plugin ${id} tool contract name 不能为空`);
        }
        if (allowReplaceTools) {
          const previousView = this.host.listToolContracts().find((item) => String(item.name || "") === toolName);
          if (previousView?.source === "override") {
            const previous = this.host.resolveToolContract(toolName);
            if (previous) {
              state.replacedToolContracts.push({
                name: toolName,
                contract: previous
              });
            }
          }
        }
        this.host.registerToolContract(
          {
            ...toolContract,
            name: toolName
          },
          {
            replace: allowReplaceTools
          }
        );
        state.ownedToolContracts.push(toolName);
      }

      for (const llmProvider of Array.isArray(state.definition.llmProviders) ? state.definition.llmProviders : []) {
        const providerId = String(llmProvider?.id || "").trim();
        if (!providerId) {
          throw new Error(`plugin ${id} llm provider id 不能为空`);
        }
        if (allowReplaceLlmProviders) {
          const previous = this.host.getLlmProvider(providerId);
          if (previous) {
            state.replacedLlmProviders.push({
              id: providerId,
              provider: previous
            });
          }
        }
        this.host.registerLlmProvider(
          {
            ...llmProvider,
            id: providerId
          },
          {
            replace: allowReplaceLlmProviders
          }
        );
        state.ownedLlmProviders.push(providerId);
      }

      state.enabled = true;
      state.lastError = undefined;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.errorCount += 1;
      this.disable(id);
      throw error;
    }
  }

  disable(pluginId: string): void {
    const id = String(pluginId || "").trim();
    const state = this.plugins.get(id);
    if (!state) return;

    for (const unregister of state.unregisterHooks.splice(0)) {
      try {
        unregister();
      } catch {
        // noop
      }
    }

    for (const item of state.ownedModeProviders.splice(0)) {
      const removed = this.host.unregisterToolProvider(item.mode, item.providerId);
      if (!removed) continue;
      const replaced = state.replacedModeProviders.find((entry) => entry.mode === item.mode);
      if (!replaced) continue;
      if (this.host.getToolProvider(item.mode)) continue;
      this.host.registerToolProvider(item.mode, replaced.provider, { replace: false });
    }
    for (const item of state.ownedCapabilityProviders.splice(0)) {
      const removed = this.host.unregisterCapabilityProvider(item.capability, item.providerId);
      if (!removed) continue;
      const replaced = state.replacedCapabilityProviders.find((entry) => entry.capability === item.capability);
      if (!replaced) continue;
      if (this.host.getCapabilityProviders(item.capability).length > 0) continue;
      for (const provider of replaced.providers) {
        this.host.registerCapabilityProvider(item.capability, provider, { replace: false });
      }
    }
    for (const item of state.ownedCapabilityPolicies.splice(0)) {
      const removed = this.host.unregisterCapabilityPolicy(item.capability, item.policyId);
      if (!removed) continue;
      const replaced = state.replacedCapabilityPolicies.find((entry) => entry.capability === item.capability);
      if (!replaced) continue;
      const current = this.host.getCapabilityPolicy(item.capability);
      if (current?.source === "override") continue;
      this.host.registerCapabilityPolicy(item.capability, replaced.policy, {
        replace: false,
        id: replaced.policyId
      });
    }
    for (const toolName of state.ownedToolContracts.splice(0)) {
      const removed = this.host.unregisterToolContract(toolName);
      if (!removed) continue;
      const replaced = state.replacedToolContracts.find((entry) => entry.name === toolName);
      if (!replaced) continue;
      this.host.registerToolContract(replaced.contract, { replace: true });
    }
    for (const providerId of state.ownedLlmProviders.splice(0)) {
      const removed = this.host.unregisterLlmProvider(providerId);
      if (!removed) continue;
      const replaced = state.replacedLlmProviders.find((entry) => entry.id === providerId);
      if (!replaced) continue;
      if (this.host.getLlmProvider(providerId)) continue;
      this.host.registerLlmProvider(replaced.provider, { replace: false });
    }
    state.replacedModeProviders = [];
    state.replacedCapabilityProviders = [];
    state.replacedCapabilityPolicies = [];
    state.replacedToolContracts = [];
    state.replacedLlmProviders = [];

    state.enabled = false;
  }

  list(): PluginRuntimeView[] {
    return Array.from(this.plugins.values()).map((state) => {
      const manifest = state.definition.manifest;
      const permissions = manifest.permissions || {};
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        enabled: state.enabled,
        timeoutMs: Math.max(50, Math.min(10_000, Number(manifest.timeoutMs || 1500))),
        lastError: state.lastError,
        errorCount: state.errorCount,
        hooks: Object.keys(state.definition.hooks || {}),
        modes: Object.keys(state.definition.providers?.modes || {}) as ExecuteMode[],
        capabilities: Object.keys(state.definition.providers?.capabilities || {}),
        policyCapabilities: Object.keys(state.definition.policies?.capabilities || {}),
        tools: (Array.isArray(state.definition.tools) ? state.definition.tools : [])
          .map((item) => String(item?.name || "").trim())
          .filter(Boolean),
        llmProviders: (Array.isArray(state.definition.llmProviders) ? state.definition.llmProviders : [])
          .map((item) => String(item?.id || "").trim())
          .filter(Boolean),
        runtimeMessages: toUniqueStringList(permissions.runtimeMessages),
        brainEvents: toUniqueStringList(permissions.brainEvents),
        usageTotalCalls: state.usageTotalCalls,
        usageTotalErrors: state.usageTotalErrors,
        usageTotalTimeouts: state.usageTotalTimeouts,
        usageLastUsedAt: state.usageLastUsedAt,
        usageHookCalls: { ...state.usageHookCalls }
      };
    });
  }
}
