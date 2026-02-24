import type { ExecuteCapability, ExecuteMode, ExecuteStepInput } from "./types";

export interface StepToolProvider {
  id: string;
  mode?: ExecuteMode;
  priority?: number;
  canHandle?(input: ExecuteStepInput): boolean | Promise<boolean>;
  invoke(input: ExecuteStepInput): Promise<unknown>;
}

export interface RegisterProviderOptions {
  replace?: boolean;
}

export class ToolProviderRegistry {
  private readonly modeProviders = new Map<ExecuteMode, StepToolProvider>();
  private readonly capabilityProviders = new Map<ExecuteCapability, StepToolProvider[]>();

  private normalizeCapability(capability: ExecuteCapability): string {
    return String(capability || "").trim();
  }

  private rankProviders(list: StepToolProvider[]): StepToolProvider[] {
    return [...list].sort((a, b) => {
      const delta = (Number(b.priority) || 0) - (Number(a.priority) || 0);
      if (delta !== 0) return delta;
      return 0;
    });
  }

  private getCapabilityProviderList(capability: ExecuteCapability): StepToolProvider[] {
    const key = this.normalizeCapability(capability);
    if (!key) return [];
    const list = this.capabilityProviders.get(key) || [];
    if (!list.length) return [];
    return this.rankProviders(list);
  }

  private async resolveCapabilityProvider(
    capability: ExecuteCapability,
    input: ExecuteStepInput,
    modeHint?: ExecuteMode
  ): Promise<StepToolProvider | null> {
    const candidates = this.getCapabilityProviderList(capability);
    if (!candidates.length) return null;
    for (const provider of candidates) {
      if (modeHint && provider.mode && provider.mode !== modeHint) continue;
      if (!provider.canHandle) return provider;
      const accepted = await provider.canHandle({ ...input, mode: provider.mode || modeHint || input.mode });
      if (accepted) return provider;
    }
    return null;
  }

  register(mode: ExecuteMode, provider: StepToolProvider, options: RegisterProviderOptions = {}): void {
    if (!options.replace && this.modeProviders.has(mode)) {
      throw new Error(`provider already registered: ${mode}`);
    }
    this.modeProviders.set(mode, provider);
  }

  registerCapability(capability: ExecuteCapability, provider: StepToolProvider, options: RegisterProviderOptions = {}): void {
    const key = this.normalizeCapability(capability);
    if (!key) throw new Error("capability 不能为空");

    const nextProvider = { ...provider };
    if (options.replace) {
      this.capabilityProviders.set(key, [nextProvider]);
      return;
    }

    const current = this.capabilityProviders.get(key) || [];
    if (current.some((item) => item.id === nextProvider.id)) {
      throw new Error(`provider already registered: ${key}:${nextProvider.id}`);
    }
    this.capabilityProviders.set(key, [...current, nextProvider]);
  }

  unregister(mode: ExecuteMode, expectedProviderId?: string): boolean {
    const current = this.modeProviders.get(mode);
    if (!current) return false;
    if (expectedProviderId && current.id !== expectedProviderId) return false;
    return this.modeProviders.delete(mode);
  }

  unregisterCapability(capability: ExecuteCapability, expectedProviderId?: string): boolean {
    const key = this.normalizeCapability(capability);
    const current = this.capabilityProviders.get(key) || [];
    if (!current.length) return false;
    if (!expectedProviderId) {
      return this.capabilityProviders.delete(key);
    }
    const next = current.filter((item) => item.id !== expectedProviderId);
    if (next.length === current.length) return false;
    if (next.length === 0) {
      this.capabilityProviders.delete(key);
    } else {
      this.capabilityProviders.set(key, next);
    }
    return true;
  }

  has(mode: ExecuteMode): boolean {
    return this.modeProviders.has(mode);
  }

  hasCapability(capability: ExecuteCapability): boolean {
    return this.getCapabilityProviderList(capability).length > 0;
  }

  get(mode: ExecuteMode): StepToolProvider | undefined {
    return this.modeProviders.get(mode);
  }

  getCapability(capability: ExecuteCapability): StepToolProvider | undefined {
    return this.getCapabilityProviderList(capability)[0];
  }

  getCapabilities(capability: ExecuteCapability): StepToolProvider[] {
    return this.getCapabilityProviderList(capability);
  }

  list(): Array<{ mode: ExecuteMode; id: string }> {
    return Array.from(this.modeProviders.entries()).map(([mode, provider]) => ({
      mode,
      id: provider.id
    }));
  }

  listCapabilities(): Array<{ capability: ExecuteCapability; id: string; mode?: ExecuteMode }> {
    const out: Array<{ capability: ExecuteCapability; id: string; mode?: ExecuteMode }> = [];
    for (const [capability, providers] of this.capabilityProviders.entries()) {
      for (const provider of this.rankProviders(providers)) {
        out.push({
          capability,
          id: provider.id,
          mode: provider.mode
        });
      }
    }
    return out;
  }

  resolveMode(input: ExecuteStepInput): ExecuteMode | null {
    const mode = input.mode;
    const capability = this.normalizeCapability(input.capability || "");
    if (capability) {
      const candidates = this.getCapabilityProviderList(capability);
      if (candidates.length > 0) {
        if (mode) return mode;
        const byMode = candidates.find((provider) => provider.mode);
        return byMode?.mode || null;
      }
    }
    if (mode && this.modeProviders.has(mode)) return mode;
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
    const capability = this.normalizeCapability(input.capability || "");
    if (capability) {
      const capabilityProvider = await this.resolveCapabilityProvider(capability, input, mode);
      if (!capabilityProvider) throw new Error(`未找到 capability provider: ${capability}`);
      const modeUsed = capabilityProvider.mode || mode;
      return {
        data: await capabilityProvider.invoke({ ...input, mode: modeUsed }),
        modeUsed,
        providerId: capabilityProvider.id,
        capabilityUsed: capability
      };
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
