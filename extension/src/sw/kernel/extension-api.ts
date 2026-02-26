import type { HookHandler, HookHandlerOptions } from "./hook-runner";
import type { OrchestratorHookMap } from "./orchestrator-hooks";
import type { ExecuteCapability, ExecuteMode } from "./types";
import type { CapabilityExecutionPolicy } from "./capability-policy";
import type { StepToolProvider } from "./tool-provider-registry";
import type { ToolContract } from "./tool-contract-registry";
import type { AgentPluginDefinition, AgentPluginManifest } from "./plugin-runtime";
import type { LlmProviderAdapter } from "./llm-provider";
import type { BrainOrchestrator } from "./orchestrator.browser";

type HookKey = keyof OrchestratorHookMap & string;
type HookBuilderEntry = {
  handler: HookHandler<any>;
  options?: HookHandlerOptions;
};
type HookBuilderMap = Partial<Record<HookKey, HookBuilderEntry[]>>;

export interface ExtensionAPI {
  on<K extends keyof OrchestratorHookMap & string>(
    hook: K,
    handler: HookHandler<OrchestratorHookMap[K]>,
    options?: HookHandlerOptions
  ): void;
  registerTool(contract: ToolContract): void;
  registerModeProvider(mode: ExecuteMode, provider: StepToolProvider): void;
  registerCapabilityProvider(capability: ExecuteCapability, provider: StepToolProvider): void;
  registerCapabilityPolicy(capability: ExecuteCapability, policy: CapabilityExecutionPolicy): void;
  registerProvider(name: string, provider: Pick<LlmProviderAdapter, "resolveRequestUrl" | "send">): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void;

function pushHookEntry(
  hooks: HookBuilderMap,
  hook: HookKey,
  entry: HookBuilderEntry
): void {
  const current = hooks[hook] || [];
  hooks[hook] = [...current, entry];
}

function ensureNonEmptyString(value: unknown, message: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

export function buildPluginDefinitionFromExtension(
  manifest: AgentPluginManifest,
  setup: ExtensionFactory
): AgentPluginDefinition {
  const hooks: HookBuilderMap = {};
  const modeProviders = new Map<ExecuteMode, StepToolProvider>();
  const capabilityProviders = new Map<ExecuteCapability, StepToolProvider>();
  const capabilityPolicies = new Map<ExecuteCapability, CapabilityExecutionPolicy>();
  const tools = new Map<string, ToolContract>();
  const llmProviders = new Map<string, LlmProviderAdapter>();

  const api: ExtensionAPI = {
    on(hook, handler, options = {}) {
      pushHookEntry(hooks, hook, {
        handler,
        options
      });
    },
    registerTool(contract) {
      const name = ensureNonEmptyString(contract?.name, "registerTool 需要 contract.name");
      tools.set(name, {
        ...contract,
        name
      });
    },
    registerModeProvider(mode, provider) {
      const normalizedMode = ensureNonEmptyString(mode, "registerModeProvider 需要 mode") as ExecuteMode;
      modeProviders.set(normalizedMode, provider);
    },
    registerCapabilityProvider(capability, provider) {
      const normalized = ensureNonEmptyString(capability, "registerCapabilityProvider 需要 capability");
      capabilityProviders.set(normalized, provider);
    },
    registerCapabilityPolicy(capability, policy) {
      const normalized = ensureNonEmptyString(capability, "registerCapabilityPolicy 需要 capability");
      capabilityPolicies.set(normalized, policy);
    },
    registerProvider(name, provider) {
      const id = ensureNonEmptyString(name, "registerProvider 需要 provider id");
      llmProviders.set(id, {
        id,
        resolveRequestUrl: provider.resolveRequestUrl,
        send: provider.send
      });
    }
  };

  setup(api);

  const hasHooks = Object.keys(hooks).length > 0;
  const hasModeProviders = modeProviders.size > 0;
  const hasCapabilityProviders = capabilityProviders.size > 0;
  const hasCapabilityPolicies = capabilityPolicies.size > 0;

  const providers: NonNullable<AgentPluginDefinition["providers"]> = {};
  if (hasModeProviders) {
    providers.modes = Object.fromEntries(modeProviders.entries()) as NonNullable<AgentPluginDefinition["providers"]>["modes"];
  }
  if (hasCapabilityProviders) {
    providers.capabilities = Object.fromEntries(capabilityProviders.entries());
  }

  const policies: NonNullable<AgentPluginDefinition["policies"]> = {};
  if (hasCapabilityPolicies) {
    policies.capabilities = Object.fromEntries(capabilityPolicies.entries());
  }

  return {
    manifest,
    ...(hasHooks ? { hooks: hooks as AgentPluginDefinition["hooks"] } : {}),
    ...(hasModeProviders || hasCapabilityProviders ? { providers } : {}),
    ...(hasCapabilityPolicies ? { policies } : {}),
    ...(tools.size > 0 ? { tools: Array.from(tools.values()) } : {}),
    ...(llmProviders.size > 0 ? { llmProviders: Array.from(llmProviders.values()) } : {})
  };
}

export function registerExtension(
  orchestrator: BrainOrchestrator,
  manifest: AgentPluginManifest,
  setup: ExtensionFactory,
  options: { enable?: boolean; replace?: boolean } = {}
): void {
  const definition = buildPluginDefinitionFromExtension(manifest, setup);
  orchestrator.registerPlugin(definition, options);
}
