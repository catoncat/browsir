import type { HookHandler, HookHandlerOptions } from "./hook-runner";
import type { OrchestratorHookMap } from "./orchestrator-hooks";
import type { ExecuteCapability, ExecuteMode } from "./types";
import type { CapabilityExecutionPolicy, RegisterCapabilityPolicyOptions } from "./capability-policy";
import type { RegisterProviderOptions, StepToolProvider } from "./tool-provider-registry";

export interface AgentPluginPermissions {
  hooks?: string[];
  modes?: ExecuteMode[];
  capabilities?: ExecuteCapability[];
  replaceProviders?: boolean;
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

export interface AgentPluginDefinition {
  manifest: AgentPluginManifest;
  hooks?: Partial<{
    [K in keyof OrchestratorHookMap & string]: PluginHookEntry<K>;
  }>;
  providers?: {
    modes?: Partial<Record<ExecuteMode, StepToolProvider>>;
    capabilities?: Record<ExecuteCapability, StepToolProvider>;
  };
  policies?: {
    capabilities?: Record<ExecuteCapability, CapabilityExecutionPolicy>;
  };
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
}

interface ReplacedModeProvider {
  mode: ExecuteMode;
  provider: StepToolProvider;
}

interface ReplacedCapabilityProvider {
  capability: ExecuteCapability;
  provider: StepToolProvider;
}

interface ReplacedCapabilityPolicy {
  capability: ExecuteCapability;
  policyId: string;
  policy: CapabilityExecutionPolicy;
}

interface PluginState {
  definition: AgentPluginDefinition;
  enabled: boolean;
  unregisterHooks: Array<() => void>;
  ownedModeProviders: Array<{ mode: ExecuteMode; providerId: string }>;
  ownedCapabilityProviders: Array<{ capability: ExecuteCapability; providerId: string }>;
  ownedCapabilityPolicies: Array<{ capability: ExecuteCapability; policyId: string }>;
  replacedModeProviders: ReplacedModeProvider[];
  replacedCapabilityProviders: ReplacedCapabilityProvider[];
  replacedCapabilityPolicies: ReplacedCapabilityPolicy[];
  errorCount: number;
  lastError?: string;
}

function isAllowed(list: string[] | undefined, value: string): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.includes("*") || list.includes(value);
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
      replacedModeProviders: [],
      replacedCapabilityProviders: [],
      replacedCapabilityPolicies: [],
      errorCount: 0
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
    const allowReplace = permissions.replaceProviders === true;
    const timeoutMs = Math.max(50, Math.min(10_000, Number(manifest.timeoutMs || 1500)));

    try {
      for (const [hook, raw] of Object.entries(state.definition.hooks || {})) {
        if (!raw) continue;
        if (!isAllowed(permissions.hooks, hook)) {
          throw new Error(`plugin ${id} 未授权 hook: ${hook}`);
        }
        const entry = toHookEntry(raw as PluginHookEntry<keyof OrchestratorHookMap & string>);
        const unregister = this.host.onHook(
          hook as keyof OrchestratorHookMap & string,
          async (payload) => {
            const timer = new Promise<{ action: "continue" }>((resolve) =>
              setTimeout(() => resolve({ action: "continue" }), timeoutMs)
            );
            try {
              const result = await Promise.race([Promise.resolve(entry.handler(payload)), timer]);
              if (!result) return { action: "continue" };
              return result;
            } catch (error) {
              state.lastError = error instanceof Error ? error.message : String(error);
              state.errorCount += 1;
              return { action: "continue" };
            }
          },
          {
            ...entry.options,
            // Hook id 总是挂插件命名空间，避免跨插件冲突卸载。
            id: `${id}:${hook}:${String(entry.options.id || "handler").trim() || "handler"}`
          }
        );
        state.unregisterHooks.push(unregister);
      }

      for (const [mode, provider] of Object.entries(state.definition.providers?.modes || {}) as Array<
        [ExecuteMode, StepToolProvider | undefined]
      >) {
        if (!provider) continue;
        if (!isAllowed(permissions.modes, mode)) {
          throw new Error(`plugin ${id} 未授权 mode provider: ${mode}`);
        }
        const nextProviderId = provider.id || `${id}:mode:${mode}`;
        if (allowReplace) {
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
            replace: allowReplace
          }
        );
        state.ownedModeProviders.push({ mode, providerId: nextProviderId });
      }

      for (const [capability, provider] of Object.entries(state.definition.providers?.capabilities || {})) {
        if (!provider) continue;
        if (!isAllowed(permissions.capabilities, capability)) {
          throw new Error(`plugin ${id} 未授权 capability provider: ${capability}`);
        }
        const nextProviderId = provider.id || `${id}:capability:${capability}`;
        if (allowReplace) {
          const previous = this.host.getCapabilityProvider(capability);
          if (previous) {
            state.replacedCapabilityProviders.push({ capability, provider: previous });
          }
        }
        this.host.registerCapabilityProvider(
          capability,
          {
            ...provider,
            id: nextProviderId
          },
          {
            replace: allowReplace
          }
        );
        state.ownedCapabilityProviders.push({
          capability,
          providerId: nextProviderId
        });
      }

      for (const [capability, policy] of Object.entries(state.definition.policies?.capabilities || {})) {
        if (!policy) continue;
        if (!isAllowed(permissions.capabilities, capability)) {
          throw new Error(`plugin ${id} 未授权 capability policy: ${capability}`);
        }
        if (allowReplace) {
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
          replace: allowReplace,
          id: `${id}:policy:${capability}`
        });
        state.ownedCapabilityPolicies.push({
          capability,
          policyId
        });
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
      if (this.host.getCapabilityProvider(item.capability)) continue;
      this.host.registerCapabilityProvider(item.capability, replaced.provider, { replace: false });
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
    state.replacedModeProviders = [];
    state.replacedCapabilityProviders = [];
    state.replacedCapabilityPolicies = [];

    state.enabled = false;
  }

  list(): PluginRuntimeView[] {
    return Array.from(this.plugins.values()).map((state) => {
      const manifest = state.definition.manifest;
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
        policyCapabilities: Object.keys(state.definition.policies?.capabilities || {})
      };
    });
  }
}
