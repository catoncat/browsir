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
  contextRefs: Array<Record<string, unknown>>;
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

export type UiWidgetSlot = "chat.scene.overlay";

export type UiWidgetCleanup = () => void | Promise<void>;

export interface UiActiveSessionChangePayload {
  sessionId?: string;
  previousSessionId?: string;
}

export type UiActiveSessionChangeListener = (
  payload: UiActiveSessionChangePayload
) => void | Promise<void>;

export interface UiWidgetMountContext {
  pluginId: string;
  widgetId: string;
  slot: UiWidgetSlot;
  getActiveSessionId(): string | undefined;
  isActiveSession(sessionId?: string): boolean;
  onActiveSessionChanged(listener: UiActiveSessionChangeListener): UiWidgetCleanup;
}

export interface UiWidgetDefinition {
  id: string;
  slot: UiWidgetSlot;
  order?: number;
  mount(
    container: HTMLElement,
    context: UiWidgetMountContext
  ): void | UiWidgetCleanup | Promise<void | UiWidgetCleanup>;
}

export interface UiSessionListRenderItem {
  id: string;
  title: string;
  updatedAt?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
}

export interface UiSessionListRenderPayload {
  sessions: UiSessionListRenderItem[];
  activeId: string;
  isOpen: boolean;
  loading?: boolean;
}

export interface UiHeaderRenderPayload {
  sessionId?: string;
  title: string;
  isRunning: boolean;
  isCompacting: boolean;
  forkedFromSessionId?: string;
}

export interface UiMessageListRenderPayload {
  sessionId?: string;
  isRunning: boolean;
  messages: UiMessageRenderPayload[];
}

export interface UiQueueRenderItem {
  id: string;
  behavior: "steer" | "followUp";
  text: string;
}

export interface UiQueueRenderPayload {
  sessionId?: string;
  items: UiQueueRenderItem[];
  state: {
    steer: number;
    followUp: number;
    total: number;
  };
}

export interface UiChatInputRenderPayload {
  sessionId?: string;
  text: string;
  placeholder: string;
  disabled: boolean;
  isRunning: boolean;
  isCompacting: boolean;
  isStartingRun: boolean;
}

export interface UiHookPayloadMap {
  "ui.notice.before_show": UiNoticePayload;
  "ui.runtime.event": UiRuntimeEventPayload;
  "ui.session.changed": UiSessionChangedPayload;
  "ui.session.list.before_render": UiSessionListRenderPayload;
  "ui.header.before_render": UiHeaderRenderPayload;
  "ui.chat_input.before_send": UiChatInputPayload;
  "ui.chat_input.after_send": UiChatInputPayload;
  "ui.chat_input.before_render": UiChatInputRenderPayload;
  "ui.queue.before_render": UiQueueRenderPayload;
  "ui.message.before_render": UiMessageRenderPayload;
  "ui.message.list.before_render": UiMessageListRenderPayload;
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
  registerWidget(definition: UiWidgetDefinition): void;
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
  widgets: UiWidgetDefinition[];
  remoteHookCache: Set<string> | null;
  errorCount: number;
  lastError?: string;
}

interface MountedUiWidgetInstance {
  instanceId: string;
  pluginId: string;
  widgetId: string;
  slot: UiWidgetSlot;
  order: number;
  container: HTMLElement;
  sessionListeners: Set<UiActiveSessionChangeListener>;
  cleanup?: UiWidgetCleanup;
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

export interface UiPluginLoadFailure {
  pluginId: string;
  moduleUrl: string;
  exportName: string;
  error: string;
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

interface RemoteHookResponse<K extends UiHookName> {
  result: UiHookResult<UiHookPayloadMap[K]>;
  registeredHooks?: string[];
}

async function invokeRemoteUiHook<K extends UiHookName>(
  descriptor: UiExtensionDescriptor,
  hook: K,
  payload: UiHookPayloadMap[K]
): Promise<RemoteHookResponse<K>> {
  const response = (await chrome.runtime.sendMessage({
    type: "brain.plugin.ui_hook.run",
    pluginId: descriptor.pluginId,
    hook,
    payload,
    ...(descriptor.sessionId ? { sessionId: descriptor.sessionId } : {}),
    ...(descriptor.exportName ? { exportName: descriptor.exportName } : {})
  })) as RuntimeResponse<{ hookResult?: unknown; registeredHooks?: unknown }>;
  if (!response?.ok) {
    throw new Error(String(response?.error || "brain.plugin.ui_hook.run failed"));
  }
  const data = toRecord(response.data);
  const hookResult = toRecord(data.hookResult);
  const registeredHooks = Array.isArray(data.registeredHooks)
    ? (data.registeredHooks as unknown[]).map((h) => String(h || "").trim()).filter(Boolean)
    : undefined;
  const action = String(hookResult.action || "").trim();
  if (action === "patch") {
    return {
      result: {
        action: "patch",
        patch: toRecord(hookResult.patch) as Partial<UiHookPayloadMap[K]>
      },
      registeredHooks
    };
  }
  if (action === "block") {
    return {
      result: {
        action: "block",
        reason: String(hookResult.reason || "").trim() || undefined
      },
      registeredHooks
    };
  }
  return {
    result: { action: "continue" },
    registeredHooks
  };
}

export class PanelUiPluginRuntime {
  private readonly states = new Map<string, UiPluginState>();
  private readonly defaultTimeoutMs: number;
  private readonly getActiveSessionIdFn: () => string | undefined;
  private readonly hostSlots = new Map<UiWidgetSlot, HTMLElement>();
  private readonly mountedWidgets = new Map<string, MountedUiWidgetInstance>();
  private handlerOrder = 0;

  constructor(options: { defaultTimeoutMs?: number; getActiveSessionId?: () => string | undefined } = {}) {
    this.defaultTimeoutMs = clampTimeout(options.defaultTimeoutMs, 120);
    this.getActiveSessionIdFn = typeof options.getActiveSessionId === "function"
      ? options.getActiveSessionId
      : () => undefined;
  }

  listDescriptors(): UiExtensionDescriptor[] {
    return Array.from(this.states.values()).map((state) => ({
      ...state.descriptor,
      enabled: state.enabled
    }));
  }

  listLoadFailures(): UiPluginLoadFailure[] {
    const out: UiPluginLoadFailure[] = [];
    for (const [pluginId, state] of this.states.entries()) {
      const error = String(state.lastError || "").trim();
      if (!error) continue;
      out.push({
        pluginId,
        moduleUrl: state.descriptor.moduleUrl,
        exportName: state.descriptor.exportName,
        error
      });
    }
    out.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
    return out;
  }

  async hydrate(input: unknown[]): Promise<void> {
    const nextList = Array.isArray(input) ? input.map((item) => normalizeDescriptor(item)).filter(Boolean) as UiExtensionDescriptor[] : [];
    const nextIds = new Set(nextList.map((item) => item.pluginId));
    for (const pluginId of Array.from(this.states.keys())) {
      if (!nextIds.has(pluginId)) {
        await this.unregister(pluginId);
      }
    }

    for (const descriptor of nextList) {
      await this.upsertDescriptor(descriptor);
    }
    for (const descriptor of nextList) {
      if (descriptor.enabled) {
        await this.enable(descriptor.pluginId);
      } else {
        await this.disable(descriptor.pluginId);
      }
    }
  }

  async registerDescriptor(input: unknown): Promise<void> {
    const descriptor = normalizeDescriptor(input);
    if (!descriptor) return;
    await this.upsertDescriptor(descriptor);
    if (descriptor.enabled) {
      await this.enable(descriptor.pluginId);
    }
  }

  async attachHostSlot(slot: UiWidgetSlot, host: HTMLElement): Promise<void> {
    this.assertWidgetSlot(slot);
    if (!host) return;
    await this.unmountWidgetsInSlot(slot);
    this.hostSlots.set(slot, host);
    await this.mountWidgetsForSlot(slot);
  }

  async detachHostSlot(slot: UiWidgetSlot): Promise<void> {
    this.assertWidgetSlot(slot);
    await this.unmountWidgetsInSlot(slot);
    this.hostSlots.delete(slot);
  }

  async enable(pluginId: string): Promise<void> {
    const id = String(pluginId || "").trim();
    const state = this.states.get(id);
    if (!state) return;
    if (state.enabled) return;
    if (isVirtualModuleUrl(state.descriptor.moduleUrl)) {
      state.enabled = true;
      state.handlers = [];
      state.widgets = [];
      state.remoteHookCache = null;
      state.lastError = undefined;
      return;
    }

    const collectedHandlers: UiHandlerEntry[] = [];
    const collectedWidgets: UiWidgetDefinition[] = [];
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
      },
      registerWidget: (definition) => {
        if (!definition || typeof definition !== "object") return;
        const widgetId = String(definition.id || "").trim();
        const slot = this.normalizeWidgetSlot(definition.slot);
        if (!widgetId || !slot || typeof definition.mount !== "function") return;
        const nextDefinition: UiWidgetDefinition = {
          id: widgetId,
          slot,
          order: Number.isFinite(Number(definition.order)) ? Math.floor(Number(definition.order)) : 0,
          mount: definition.mount
        };
        const existingIndex = collectedWidgets.findIndex((item) => item.id === widgetId);
        if (existingIndex >= 0) {
          collectedWidgets.splice(existingIndex, 1, nextDefinition);
          return;
        }
        collectedWidgets.push(nextDefinition);
      }
    };

    try {
      await this.unmountWidgetsForPlugin(id);
      const setup = await loadPluginFactory(state.descriptor.moduleUrl, state.descriptor.exportName);
      await Promise.resolve(setup(api));
      state.handlers = collectedHandlers;
      state.widgets = collectedWidgets;
      state.enabled = true;
      state.lastError = undefined;
      await this.mountWidgetsForPlugin(id);
    } catch (error) {
      state.errorCount += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.handlers = [];
      state.widgets = [];
      state.enabled = false;
      await this.unmountWidgetsForPlugin(id);
      this.reportPluginError(id, state.descriptor.moduleUrl, "ui plugin enable failed", error);
    }
  }

  async disable(pluginId: string): Promise<void> {
    const id = String(pluginId || "").trim();
    const state = this.states.get(id);
    if (!state) return;
    await this.unmountWidgetsForPlugin(id);
    state.enabled = false;
    state.handlers = [];
    state.widgets = [];
    state.remoteHookCache = null;
    state.lastError = undefined;
  }

  async unregister(pluginId: string): Promise<void> {
    const id = String(pluginId || "").trim();
    if (!id) return;
    await this.unmountWidgetsForPlugin(id);
    this.states.delete(id);
  }

  async dispose(): Promise<void> {
    for (const instanceId of Array.from(this.mountedWidgets.keys())) {
      await this.unmountWidgetInstance(instanceId);
    }
    this.hostSlots.clear();
  }

  async notifyActiveSessionChanged(sessionId?: string, previousSessionId?: string): Promise<void> {
    const payload: UiActiveSessionChangePayload = {
      sessionId: String(sessionId || "").trim() || undefined,
      previousSessionId: String(previousSessionId || "").trim() || undefined
    };
    for (const mounted of this.mountedWidgets.values()) {
      for (const listener of mounted.sessionListeners) {
        try {
          await Promise.resolve(listener(payload));
        } catch (error) {
          const state = this.states.get(mounted.pluginId);
          if (!state) continue;
          state.errorCount += 1;
          state.lastError = error instanceof Error ? error.message : String(error);
          this.reportPluginError(
            mounted.pluginId,
            state.descriptor.moduleUrl,
            "ui widget active session listener failed",
            error
          );
        }
      }
    }
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
      if (state.remoteHookCache && !state.remoteHookCache.has(hook)) continue;
      try {
        const remote = await this.runWithTimeout(
          invokeRemoteUiHook(descriptor, hook, current),
          this.defaultTimeoutMs
        ) as RemoteHookResponse<K> | null;
        if (remote?.registeredHooks) {
          state.remoteHookCache = new Set(remote.registeredHooks);
        }
        const next = await this.applyHookResult(state, remote?.result ?? null, current);
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

  private async upsertDescriptor(descriptor: UiExtensionDescriptor): Promise<void> {
    const current = this.states.get(descriptor.pluginId);
    if (!current) {
      this.states.set(descriptor.pluginId, {
        descriptor,
        enabled: false,
        handlers: [],
        widgets: [],
        remoteHookCache: null,
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
      await this.unmountWidgetsForPlugin(descriptor.pluginId);
      current.enabled = false;
      current.handlers = [];
      current.widgets = [];
      current.remoteHookCache = null;
    }
  }

  private normalizeWidgetSlot(input: unknown): UiWidgetSlot | null {
    return String(input || "").trim() === "chat.scene.overlay" ? "chat.scene.overlay" : null;
  }

  private assertWidgetSlot(slot: UiWidgetSlot): void {
    if (slot !== "chat.scene.overlay") {
      throw new Error(`unknown ui widget slot: ${String(slot || "")}`);
    }
  }

  private getActiveSessionId(): string | undefined {
    const sessionId = String(this.getActiveSessionIdFn() || "").trim();
    return sessionId || undefined;
  }

  private async mountWidgetsForSlot(slot: UiWidgetSlot): Promise<void> {
    const host = this.hostSlots.get(slot);
    if (!host) return;
    const candidates: Array<{ pluginId: string; widget: UiWidgetDefinition }> = [];
    for (const [pluginId, state] of this.states.entries()) {
      if (!state.enabled) continue;
      for (const widget of state.widgets) {
        if (widget.slot !== slot) continue;
        candidates.push({ pluginId, widget });
      }
    }
    candidates.sort((a, b) => {
      const orderDiff = (Number(a.widget.order) || 0) - (Number(b.widget.order) || 0);
      if (orderDiff !== 0) return orderDiff;
      const pluginDiff = a.pluginId.localeCompare(b.pluginId);
      if (pluginDiff !== 0) return pluginDiff;
      return a.widget.id.localeCompare(b.widget.id);
    });
    for (const item of candidates) {
      await this.mountWidget(item.pluginId, item.widget, host);
    }
  }

  private async mountWidgetsForPlugin(pluginId: string): Promise<void> {
    const state = this.states.get(pluginId);
    if (!state || !state.enabled) return;
    const widgets = [...state.widgets].sort((a, b) => {
      const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
      if (orderDiff !== 0) return orderDiff;
      return a.id.localeCompare(b.id);
    });
    for (const widget of widgets) {
      const host = this.hostSlots.get(widget.slot);
      if (!host) continue;
      await this.mountWidget(pluginId, widget, host);
    }
  }

  private async mountWidget(pluginId: string, widget: UiWidgetDefinition, host: HTMLElement): Promise<void> {
    const state = this.states.get(pluginId);
    if (!state || !state.enabled) return;
    const instanceId = `${pluginId}:${widget.id}`;
    if (this.mountedWidgets.has(instanceId)) return;
    const doc = host.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!doc?.createElement) return;
    const container = doc.createElement("div") as HTMLElement;
    container.dataset.pluginWidgetInstance = instanceId;
    container.dataset.pluginId = pluginId;
    container.dataset.widgetId = widget.id;
    container.setAttribute("data-plugin-widget-instance", instanceId);
    container.setAttribute("data-plugin-id", pluginId);
    container.setAttribute("data-widget-id", widget.id);
    host.appendChild(container);
    const sessionListeners = new Set<UiActiveSessionChangeListener>();
    try {
      const cleanup = await Promise.resolve(widget.mount(container, {
        pluginId,
        widgetId: widget.id,
        slot: widget.slot,
        getActiveSessionId: () => this.getActiveSessionId(),
        isActiveSession: (sessionId?: string) => {
          const currentSessionId = this.getActiveSessionId();
          const candidate = String(sessionId || "").trim();
          if (!candidate) return true;
          if (!currentSessionId) return true;
          return currentSessionId === candidate;
        },
        onActiveSessionChanged: (listener) => {
          if (typeof listener !== "function") return () => undefined;
          sessionListeners.add(listener);
          return () => {
            sessionListeners.delete(listener);
          };
        }
      }));
      this.mountedWidgets.set(instanceId, {
        instanceId,
        pluginId,
        widgetId: widget.id,
        slot: widget.slot,
        order: Number(widget.order) || 0,
        container,
        sessionListeners,
        cleanup: typeof cleanup === "function" ? cleanup : undefined
      });
    } catch (error) {
      container.remove();
      state.errorCount += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      this.reportPluginError(pluginId, state.descriptor.moduleUrl, "ui widget mount failed", error);
    }
  }

  private async unmountWidgetsForPlugin(pluginId: string): Promise<void> {
    const ids = Array.from(this.mountedWidgets.values())
      .filter((item) => item.pluginId === pluginId)
      .map((item) => item.instanceId);
    for (const instanceId of ids) {
      await this.unmountWidgetInstance(instanceId);
    }
  }

  private async unmountWidgetsInSlot(slot: UiWidgetSlot): Promise<void> {
    const ids = Array.from(this.mountedWidgets.values())
      .filter((item) => item.slot === slot)
      .map((item) => item.instanceId);
    for (const instanceId of ids) {
      await this.unmountWidgetInstance(instanceId);
    }
  }

  private async unmountWidgetInstance(instanceId: string): Promise<void> {
    const mounted = this.mountedWidgets.get(instanceId);
    if (!mounted) return;
    this.mountedWidgets.delete(instanceId);
    mounted.sessionListeners.clear();
    try {
      await Promise.resolve(mounted.cleanup?.());
    } catch (error) {
      const state = this.states.get(mounted.pluginId);
      if (state) {
        state.errorCount += 1;
        state.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    mounted.container.remove();
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
          ...(toRecord(current) as unknown as UiHookPayloadMap[K]),
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

  private reportPluginError(
    pluginId: string,
    moduleUrl: string,
    label: string,
    error: unknown
  ): void {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    console.error(`[panel-ui-plugin] ${label}`, {
      pluginId,
      moduleUrl,
      error: message
    });
  }
}

export function createPanelUiPluginRuntime(
  options: { defaultTimeoutMs?: number; getActiveSessionId?: () => string | undefined } = {}
): PanelUiPluginRuntime {
  return new PanelUiPluginRuntime(options);
}
