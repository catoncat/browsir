export interface UiExtensionDescriptor {
  pluginId: string;
  moduleUrl: string;
  exportName: string;
  enabled: boolean;
  updatedAt: string;
  sessionId?: string;
}

export interface UiNoticePayload {
  type: "success" | "error";
  message: string;
  source?: string;
  sessionId?: string;
  durationMs?: number;
  dedupeKey?: string;
  ts?: string;
}

export interface UiRuntimeEventPayload {
  type: string;
  message: unknown;
}

export interface UiSessionChangedPayload {
  sessionId: string;
  previousSessionId: string;
  reason?: string;
}

export interface UiChatInputPayload {
  text: string;
  tabIds: number[];
  skillIds: string[];
  mode: "normal" | "steer" | "followUp";
  sessionId?: string;
}

export interface UiMessageRenderPayload {
  role: string;
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
}

export interface UiToolRenderPayload {
  toolName: string;
  toolCallId: string;
  content: string;
}

export interface UiHookPayloadMap {
  "ui.notice.before_show": UiNoticePayload;
  "ui.runtime.event": UiRuntimeEventPayload;
  "ui.session.changed": UiSessionChangedPayload;
  "ui.chat_input.before_send": UiChatInputPayload;
  "ui.chat_input.after_send": UiChatInputPayload;
  "ui.message.before_render": UiMessageRenderPayload;
  "ui.tool.call.before_render": UiToolRenderPayload;
  "ui.tool.result.before_render": UiToolRenderPayload;
}

export type UiHookName = keyof UiHookPayloadMap;

export type UiHookResult<T> =
  | { action: "continue" }
  | { action: "patch"; patch: Partial<T> }
  | { action: "block"; reason?: string };

export type UiHookHandler<K extends UiHookName> = (
  event: UiHookPayloadMap[K]
) => UiHookResult<UiHookPayloadMap[K]> | void | Promise<UiHookResult<UiHookPayloadMap[K]> | void>;

export interface PanelUiPluginApi {
  on<K extends UiHookName>(
    hook: K,
    handler: UiHookHandler<K>,
    options?: {
      id?: string;
      priority?: number;
      timeoutMs?: number;
    }
  ): void;
}

export type PanelUiPluginFactory = (api: PanelUiPluginApi) => void | Promise<void>;

interface UiHandlerEntry {
  hook: UiHookName;
  id: string;
  priority: number;
  timeoutMs: number;
  order: number;
  handler: (event: unknown) => UiHookResult<unknown> | void | Promise<UiHookResult<unknown> | void>;
}

interface UiPluginState {
  descriptor: UiExtensionDescriptor;
  enabled: boolean;
  handlers: UiHandlerEntry[];
  errorCount: number;
  lastError?: string;
}

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface RunHookResult<T> {
  blocked: boolean;
  reason?: string;
  value: T;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeDescriptor(input: unknown): UiExtensionDescriptor | null {
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
    sessionId: String(row.sessionId || "").trim() || undefined
  };
}

function clonePayload<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function clampTimeout(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(20, Math.min(5_000, Math.floor(n)));
}

async function loadPluginFactory(moduleUrl: string, exportName: string): Promise<PanelUiPluginFactory> {
  const moduleNs = (await import(/* @vite-ignore */ moduleUrl)) as Record<string, unknown>;
  const target = String(exportName || "default").trim() || "default";
  const setup = target === "default" ? moduleNs.default : moduleNs[target];
  if (typeof setup !== "function") {
    throw new Error(`ui plugin ${moduleUrl} 缺少可执行导出: ${target}`);
  }
  return setup as PanelUiPluginFactory;
}

function isVirtualModuleUrl(moduleUrl: string): boolean {
  return /^mem:\/\//i.test(String(moduleUrl || "").trim());
}

async function invokeRemoteUiHook<K extends UiHookName>(
  descriptor: UiExtensionDescriptor,
  hook: K,
  payload: UiHookPayloadMap[K]
): Promise<UiHookResult<UiHookPayloadMap[K]> | null> {
  const response = (await chrome.runtime.sendMessage({
    type: "brain.plugin.ui_hook.run",
    pluginId: descriptor.pluginId,
    hook,
    payload,
    ...(descriptor.sessionId ? { sessionId: descriptor.sessionId } : {}),
    ...(descriptor.exportName ? { exportName: descriptor.exportName } : {})
  })) as RuntimeResponse<{ hookResult?: unknown }>;
  if (!response?.ok) {
    throw new Error(String(response?.error || "brain.plugin.ui_hook.run failed"));
  }
  const hookResult = toRecord(toRecord(response.data).hookResult);
  const action = String(hookResult.action || "").trim();
  if (action === "patch") {
    return {
      action: "patch",
      patch: toRecord(hookResult.patch) as Partial<UiHookPayloadMap[K]>
    };
  }
  if (action === "block") {
    return {
      action: "block",
      reason: String(hookResult.reason || "").trim() || undefined
    };
  }
  return {
    action: "continue"
  };
}

export class PanelUiPluginRuntime {
  private readonly states = new Map<string, UiPluginState>();
  private readonly defaultTimeoutMs: number;
  private handlerOrder = 0;

  constructor(options: { defaultTimeoutMs?: number } = {}) {
    this.defaultTimeoutMs = clampTimeout(options.defaultTimeoutMs, 120);
  }

  listDescriptors(): UiExtensionDescriptor[] {
    return Array.from(this.states.values()).map((state) => ({
      ...state.descriptor,
      enabled: state.enabled
    }));
  }

  async hydrate(input: unknown[]): Promise<void> {
    const nextList = Array.isArray(input) ? input.map((item) => normalizeDescriptor(item)).filter(Boolean) as UiExtensionDescriptor[] : [];
    const nextIds = new Set(nextList.map((item) => item.pluginId));
    for (const pluginId of Array.from(this.states.keys())) {
      if (!nextIds.has(pluginId)) {
        this.unregister(pluginId);
      }
    }

    for (const descriptor of nextList) {
      this.upsertDescriptor(descriptor);
    }
    for (const descriptor of nextList) {
      if (descriptor.enabled) {
        await this.enable(descriptor.pluginId);
      } else {
        this.disable(descriptor.pluginId);
      }
    }
  }

  async registerDescriptor(input: unknown): Promise<void> {
    const descriptor = normalizeDescriptor(input);
    if (!descriptor) return;
    this.upsertDescriptor(descriptor);
    if (descriptor.enabled) {
      await this.enable(descriptor.pluginId);
    }
  }

  async enable(pluginId: string): Promise<void> {
    const id = String(pluginId || "").trim();
    const state = this.states.get(id);
    if (!state) return;
    if (state.enabled) return;
    if (isVirtualModuleUrl(state.descriptor.moduleUrl)) {
      state.enabled = true;
      state.handlers = [];
      state.lastError = undefined;
      return;
    }

    const collectedHandlers: UiHandlerEntry[] = [];
    const api: PanelUiPluginApi = {
      on: (hook, handler, options = {}) => {
        if (typeof handler !== "function") return;
        collectedHandlers.push({
          hook,
          id: String(options.id || `${id}:${hook}:${collectedHandlers.length + 1}`).trim() || `${id}:${hook}:${collectedHandlers.length + 1}`,
          priority: Number(options.priority) || 0,
          timeoutMs: clampTimeout(options.timeoutMs, this.defaultTimeoutMs),
          order: this.handlerOrder++,
          handler: handler as UiHandlerEntry["handler"]
        });
      }
    };

    try {
      const setup = await loadPluginFactory(state.descriptor.moduleUrl, state.descriptor.exportName);
      await Promise.resolve(setup(api));
      state.handlers = collectedHandlers;
      state.enabled = true;
      state.lastError = undefined;
    } catch (error) {
      state.errorCount += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.handlers = [];
      state.enabled = false;
    }
  }

  disable(pluginId: string): void {
    const id = String(pluginId || "").trim();
    const state = this.states.get(id);
    if (!state) return;
    state.enabled = false;
    state.handlers = [];
  }

  unregister(pluginId: string): void {
    const id = String(pluginId || "").trim();
    if (!id) return;
    this.states.delete(id);
  }

  async runHook<K extends UiHookName>(hook: K, payload: UiHookPayloadMap[K]): Promise<RunHookResult<UiHookPayloadMap[K]>> {
    let current = clonePayload(payload);
    const handlers = this.listHandlers(hook);
    for (const item of handlers) {
      const state = this.states.get(item.pluginId);
      if (!state || !state.enabled) continue;
      try {
        const next = await this.applyHookResult(
          state,
          await this.runWithTimeout(item.handler(current), item.timeoutMs),
          current
        );
        if (next.blocked) {
          return next;
        }
        current = next.value;
      } catch (error) {
        state.errorCount += 1;
        state.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const remoteDescriptors = this.listRemoteDescriptors();
    for (const descriptor of remoteDescriptors) {
      const state = this.states.get(descriptor.pluginId);
      if (!state || !state.enabled) continue;
      try {
        const result = await this.runWithTimeout(
          invokeRemoteUiHook(descriptor, hook, current),
          this.defaultTimeoutMs
        );
        const next = await this.applyHookResult(state, result, current);
        if (next.blocked) {
          return next;
        }
        current = next.value;
      } catch (error) {
        state.errorCount += 1;
        state.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      blocked: false,
      value: current
    };
  }

  private upsertDescriptor(descriptor: UiExtensionDescriptor): void {
    const current = this.states.get(descriptor.pluginId);
    if (!current) {
      this.states.set(descriptor.pluginId, {
        descriptor,
        enabled: false,
        handlers: [],
        errorCount: 0
      });
      return;
    }
    const moduleChanged =
      current.descriptor.moduleUrl !== descriptor.moduleUrl
      || current.descriptor.exportName !== descriptor.exportName
      || current.descriptor.sessionId !== descriptor.sessionId;
    current.descriptor = descriptor;
    if (moduleChanged) {
      current.enabled = false;
      current.handlers = [];
    }
  }

  private listHandlers(hook: UiHookName): Array<UiHandlerEntry & { pluginId: string }> {
    const out: Array<UiHandlerEntry & { pluginId: string }> = [];
    for (const [pluginId, state] of this.states.entries()) {
      if (!state.enabled) continue;
      for (const handler of state.handlers) {
        if (handler.hook !== hook) continue;
        out.push({
          ...handler,
          pluginId
        });
      }
    }
    out.sort((a, b) => {
      const p = b.priority - a.priority;
      if (p !== 0) return p;
      return a.order - b.order;
    });
    return out;
  }

  private listRemoteDescriptors(): UiExtensionDescriptor[] {
    const out: UiExtensionDescriptor[] = [];
    for (const state of this.states.values()) {
      if (!state.enabled) continue;
      if (!isVirtualModuleUrl(state.descriptor.moduleUrl)) continue;
      out.push(state.descriptor);
    }
    out.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    return out;
  }

  private async applyHookResult<K extends UiHookName>(
    state: UiPluginState,
    result: unknown,
    current: UiHookPayloadMap[K]
  ): Promise<RunHookResult<UiHookPayloadMap[K]>> {
    if (!result || typeof result !== "object") {
      return {
        blocked: false,
        value: current
      };
    }
    const action = String((result as { action?: string }).action || "").trim();
    if (action === "block") {
      return {
        blocked: true,
        reason: String((result as { reason?: string }).reason || "").trim() || undefined,
        value: current
      };
    }
    if (action === "patch") {
      const patch = toRecord((result as { patch?: unknown }).patch);
      return {
        blocked: false,
        value: {
          ...(toRecord(current) as UiHookPayloadMap[K]),
          ...(patch as Partial<UiHookPayloadMap[K]>)
        }
      };
    }
    state.lastError = undefined;
    return {
      blocked: false,
      value: current
    };
  }

  private async runWithTimeout<T>(value: T | Promise<T>, timeoutMs: number): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`ui plugin hook timeout: ${timeoutMs}ms`));
      }, timeoutMs);
      Promise.resolve(value).then(
        (resolved) => {
          clearTimeout(timer);
          resolve(resolved);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }
}

export function createPanelUiPluginRuntime(options: { defaultTimeoutMs?: number } = {}): PanelUiPluginRuntime {
  return new PanelUiPluginRuntime(options);
}
