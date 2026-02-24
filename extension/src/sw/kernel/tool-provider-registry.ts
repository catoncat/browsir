import type { ExecuteMode, ExecuteStepInput } from "./types";

export interface StepToolProvider {
  id: string;
  invoke(input: ExecuteStepInput): Promise<unknown>;
}

export interface RegisterProviderOptions {
  replace?: boolean;
}

export class ToolProviderRegistry {
  private readonly providers = new Map<ExecuteMode, StepToolProvider>();

  register(mode: ExecuteMode, provider: StepToolProvider, options: RegisterProviderOptions = {}): void {
    if (!options.replace && this.providers.has(mode)) {
      throw new Error(`provider already registered: ${mode}`);
    }
    this.providers.set(mode, provider);
  }

  unregister(mode: ExecuteMode): boolean {
    return this.providers.delete(mode);
  }

  has(mode: ExecuteMode): boolean {
    return this.providers.has(mode);
  }

  get(mode: ExecuteMode): StepToolProvider | undefined {
    return this.providers.get(mode);
  }

  list(): Array<{ mode: ExecuteMode; id: string }> {
    return Array.from(this.providers.entries()).map(([mode, provider]) => ({
      mode,
      id: provider.id
    }));
  }

  async invoke(mode: ExecuteMode, input: ExecuteStepInput): Promise<unknown> {
    const provider = this.providers.get(mode);
    if (!provider) {
      throw new Error(`${mode} adapter 未配置`);
    }
    return provider.invoke(input);
  }
}
