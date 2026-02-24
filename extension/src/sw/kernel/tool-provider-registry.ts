import type { ExecuteCapability, ExecuteMode, ExecuteStepInput } from "./types";

export interface StepToolProvider {
  id: string;
  mode?: ExecuteMode;
  invoke(input: ExecuteStepInput): Promise<unknown>;
}

export interface RegisterProviderOptions {
  replace?: boolean;
}

export class ToolProviderRegistry {
  private readonly modeProviders = new Map<ExecuteMode, StepToolProvider>();
  private readonly capabilityProviders = new Map<ExecuteCapability, StepToolProvider>();

  register(mode: ExecuteMode, provider: StepToolProvider, options: RegisterProviderOptions = {}): void {
    if (!options.replace && this.modeProviders.has(mode)) {
      throw new Error(`provider already registered: ${mode}`);
    }
    this.modeProviders.set(mode, provider);
  }

  registerCapability(capability: ExecuteCapability, provider: StepToolProvider, options: RegisterProviderOptions = {}): void {
    const key = String(capability || "").trim();
    if (!key) throw new Error("capability 不能为空");
    if (!options.replace && this.capabilityProviders.has(key)) {
      throw new Error(`provider already registered: ${key}`);
    }
    this.capabilityProviders.set(key, provider);
  }

  unregister(mode: ExecuteMode, expectedProviderId?: string): boolean {
    const current = this.modeProviders.get(mode);
    if (!current) return false;
    if (expectedProviderId && current.id !== expectedProviderId) return false;
    return this.modeProviders.delete(mode);
  }

  unregisterCapability(capability: ExecuteCapability, expectedProviderId?: string): boolean {
    const key = String(capability || "").trim();
    const current = this.capabilityProviders.get(key);
    if (!current) return false;
    if (expectedProviderId && current.id !== expectedProviderId) return false;
    return this.capabilityProviders.delete(key);
  }

  has(mode: ExecuteMode): boolean {
    return this.modeProviders.has(mode);
  }

  hasCapability(capability: ExecuteCapability): boolean {
    return this.capabilityProviders.has(String(capability || "").trim());
  }

  get(mode: ExecuteMode): StepToolProvider | undefined {
    return this.modeProviders.get(mode);
  }

  getCapability(capability: ExecuteCapability): StepToolProvider | undefined {
    return this.capabilityProviders.get(String(capability || "").trim());
  }

  list(): Array<{ mode: ExecuteMode; id: string }> {
    return Array.from(this.modeProviders.entries()).map(([mode, provider]) => ({
      mode,
      id: provider.id
    }));
  }

  listCapabilities(): Array<{ capability: ExecuteCapability; id: string; mode?: ExecuteMode }> {
    return Array.from(this.capabilityProviders.entries()).map(([capability, provider]) => ({
      capability,
      id: provider.id,
      mode: provider.mode
    }));
  }

  resolveMode(input: ExecuteStepInput): ExecuteMode | null {
    const mode = input.mode;
    if (mode && this.modeProviders.has(mode)) return mode;
    const capability = String(input.capability || "").trim();
    if (!capability) return mode || null;
    const provider = this.capabilityProviders.get(capability);
    if (provider?.mode) return provider.mode;
    return mode || null;
  }

  async invoke(
    mode: ExecuteMode,
    input: ExecuteStepInput
  ): Promise<{
    data: unknown;
    modeUsed: ExecuteMode;
    providerId: string;
    capabilityUsed?: ExecuteCapability;
  }> {
    const capability = String(input.capability || "").trim();
    if (capability) {
      const capabilityProvider = this.capabilityProviders.get(capability);
      if (capabilityProvider) {
        const modeUsed = capabilityProvider.mode || mode;
        return {
          data: await capabilityProvider.invoke({ ...input, mode: modeUsed }),
          modeUsed,
          providerId: capabilityProvider.id,
          capabilityUsed: capability
        };
      }
    }

    const provider = this.modeProviders.get(mode);
    if (!provider) {
      throw new Error(`${mode} adapter 未配置`);
    }
    return {
      data: await provider.invoke({ ...input, mode }),
      modeUsed: provider.mode || mode,
      providerId: provider.id
    };
  }
}
