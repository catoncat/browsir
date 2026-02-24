export type HookPayload = Record<string, unknown>;

export type HookAction<TPayload extends HookPayload> =
  | { action: "continue" }
  | { action: "patch"; patch: Partial<TPayload> }
  | { action: "block"; reason: string };

export type HookHandler<TPayload extends HookPayload> =
  | ((payload: TPayload) => HookAction<TPayload> | void)
  | ((payload: TPayload) => Promise<HookAction<TPayload> | void>);

export interface HookHandlerOptions {
  id?: string;
  priority?: number;
}

interface HookRegistration<TPayload extends HookPayload> {
  id: string;
  priority: number;
  seq: number;
  handler: HookHandler<TPayload>;
}

export interface HookExecutionError {
  hook: string;
  hookId: string;
  message: string;
}

export interface HookRunResult<TPayload extends HookPayload> {
  blocked: boolean;
  reason?: string;
  value: TPayload;
  patchCount: number;
  errors: HookExecutionError[];
}

export class HookRunner<TMap extends { [K in keyof TMap]: HookPayload }> {
  private readonly handlers = new Map<keyof TMap & string, HookRegistration<TMap[keyof TMap & string]>[]>();
  private sequence = 0;

  on<K extends keyof TMap & string>(
    hook: K,
    handler: HookHandler<TMap[K]>,
    options: HookHandlerOptions = {}
  ): () => void {
    const registrations = (this.handlers.get(hook) as HookRegistration<TMap[K]>[] | undefined) ?? [];
    const id = options.id?.trim() || `${hook}#${this.sequence + 1}`;
    const registration: HookRegistration<TMap[K]> = {
      id,
      priority: options.priority ?? 0,
      seq: this.sequence++,
      handler
    };
    registrations.push(registration);
    registrations.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.seq - b.seq;
    });
    this.handlers.set(hook, registrations as HookRegistration<TMap[keyof TMap & string]>[]);
    return () => this.off(hook, id);
  }

  off<K extends keyof TMap & string>(hook: K, hookId: string): boolean {
    const registrations = this.handlers.get(hook);
    if (!registrations || registrations.length === 0) return false;
    const next = registrations.filter((item) => item.id !== hookId);
    if (next.length === registrations.length) return false;
    if (next.length === 0) {
      this.handlers.delete(hook);
    } else {
      this.handlers.set(hook, next as HookRegistration<TMap[keyof TMap & string]>[]);
    }
    return true;
  }

  async run<K extends keyof TMap & string>(hook: K, initialValue: TMap[K]): Promise<HookRunResult<TMap[K]>> {
    const registrations = (this.handlers.get(hook) as HookRegistration<TMap[K]>[] | undefined) ?? [];
    let value = initialValue;
    let patchCount = 0;
    const errors: HookExecutionError[] = [];

    for (const registration of registrations) {
      let decision: HookAction<TMap[K]> | void;
      try {
        decision = await registration.handler(value);
      } catch (error) {
        errors.push({
          hook,
          hookId: registration.id,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      if (!decision || decision.action === "continue") continue;
      if (decision.action === "block") {
        return {
          blocked: true,
          reason: decision.reason,
          value,
          patchCount,
          errors
        };
      }
      value = { ...value, ...decision.patch };
      patchCount += 1;
    }

    return {
      blocked: false,
      value,
      patchCount,
      errors
    };
  }
}
