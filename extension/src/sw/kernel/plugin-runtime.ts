import type { HookHandler, HookHandlerOptions } from "./hook-runner";
import type { OrchestratorHookMap } from "./orchestrator-hooks";
import type { ExecuteCapability, ExecuteMode } from "./types";
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
}

interface RuntimeHost {
  onHook<K extends keyof OrchestratorHookMap & string>(
    hook: K,
    handler: HookHandler<OrchestratorHookMap[K]>,
    options?: HookHandlerOptions
  ): () => void;
  registerToolProvider(mode: ExecuteMode, provider: StepToolProvider, options?: RegisterProviderOptions): void;
  unregisterToolProvider(mode: ExecuteMode, expectedProviderId?: string): boolean;
  registerCapabilityProvider(capability: ExecuteCapability, provider: StepToolProvider, options?: RegisterProviderOptions): void;
  unregisterCapabilityProvider(capability: ExecuteCapability, expectedProviderId?: string): boolean;
}

interface PluginState {
  definition: AgentPluginDefinition;
  enabled: boolean;
  unregisterHooks: Array<() => void>;
  ownedModeProviders: Array<{ mode: ExecuteMode; providerId: string }>;
  ownedCapabilityProviders: Array<{ capability: ExecuteCapability; providerId: string }>;
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
            id: entry.options.id || `${id}:${hook}`
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
        this.host.registerToolProvider(
          mode,
          {
            ...provider,
            id: provider.id || `${id}:mode:${mode}`
          },
          {
            replace: permissions.replaceProviders === true
          }
        );
        state.ownedModeProviders.push({ mode, providerId: provider.id || `${id}:mode:${mode}` });
      }

      for (const [capability, provider] of Object.entries(state.definition.providers?.capabilities || {})) {
        if (!provider) continue;
        if (!isAllowed(permissions.capabilities, capability)) {
          throw new Error(`plugin ${id} 未授权 capability provider: ${capability}`);
        }
        this.host.registerCapabilityProvider(
          capability,
          {
            ...provider,
            id: provider.id || `${id}:capability:${capability}`
          },
          {
            replace: permissions.replaceProviders === true
          }
        );
        state.ownedCapabilityProviders.push({
          capability,
          providerId: provider.id || `${id}:capability:${capability}`
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
      this.host.unregisterToolProvider(item.mode, item.providerId);
    }
    for (const item of state.ownedCapabilityProviders.splice(0)) {
      this.host.unregisterCapabilityProvider(item.capability, item.providerId);
    }

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
        capabilities: Object.keys(state.definition.providers?.capabilities || {})
      };
    });
  }
}
