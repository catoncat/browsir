type JsonRecord = Record<string, unknown>;

export interface RuntimeRouteDebugEvent {
  ts: string;
  type: string;
  ok: boolean;
  durationMs: number;
  sessionId?: string;
  pluginId?: string;
  skillId?: string;
  error?: string;
  summary?: string;
}

export interface RuntimePluginMessageDebugEvent {
  ts: string;
  type: string;
  pluginId?: string;
  preview: string;
}

export interface RuntimePluginHookDebugEvent {
  ts: string;
  traceType: string;
  pluginId: string;
  hook?: string;
  durationMs?: number;
  error?: string;
  requestPreview?: string;
  responsePreview?: string;
  runtimeMessageCount?: number;
  sessionId?: string;
  modulePath?: string;
  exportName?: string;
}

export interface RuntimeInternalDebugEvent {
  ts: string;
  type: string;
  ok?: boolean;
  pluginId?: string;
  detail?: string;
}

type RuntimeDebugChannel = "routes" | "pluginRuntimeMessages" | "pluginHookTrace" | "internalEvents";

const ROUTE_TAIL_LIMIT = 80;
const PLUGIN_MESSAGE_TAIL_LIMIT = 80;
const PLUGIN_HOOK_TAIL_LIMIT = 80;
const INTERNAL_EVENT_TAIL_LIMIT = 40;

const routeTail: RuntimeRouteDebugEvent[] = [];
const pluginMessageTail: RuntimePluginMessageDebugEvent[] = [];
const pluginHookTail: RuntimePluginHookDebugEvent[] = [];
const internalEventTail: RuntimeInternalDebugEvent[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

function clipText(input: unknown, max = 220): string {
  const text = String(input || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function pushTail<T>(tail: T[], value: T, max: number): void {
  tail.push(value);
  if (tail.length > max) {
    tail.splice(0, tail.length - max);
  }
}

export function recordRuntimeRouteDebugEvent(event: RuntimeRouteDebugEvent): void {
  pushTail(
    routeTail,
    {
      ...event,
      ts: String(event.ts || nowIso()),
      type: String(event.type || "").trim() || "unknown",
      durationMs: Math.max(0, Math.floor(Number(event.durationMs || 0))),
      ok: event.ok === true,
      sessionId: clipText(event.sessionId, 80) || undefined,
      pluginId: clipText(event.pluginId, 120) || undefined,
      skillId: clipText(event.skillId, 120) || undefined,
      error: clipText(event.error, 260) || undefined,
      summary: clipText(event.summary, 260) || undefined,
    },
    ROUTE_TAIL_LIMIT
  );
}

export function recordPluginRuntimeMessageDebugEvent(message: unknown): void {
  const row = toRecord(message);
  pushTail(
    pluginMessageTail,
    {
      ts: nowIso(),
      type: String(row.type || row.event || "unknown").trim() || "unknown",
      pluginId: clipText(row.pluginId, 120) || undefined,
      preview: clipText(
        row.preview ||
          row.message ||
          row.detail ||
          (() => {
            try {
              return JSON.stringify(message);
            } catch {
              return String(message ?? "");
            }
          })(),
        260
      ),
    },
    PLUGIN_MESSAGE_TAIL_LIMIT
  );
}

export function recordPluginHookTraceDebugEvent(payload: JsonRecord): void {
  const row = toRecord(payload);
  pushTail(
    pluginHookTail,
    {
      ts: String(row.startedAt || row.ts || nowIso()),
      traceType: String(row.traceType || "hook").trim() || "hook",
      pluginId: String(row.pluginId || "").trim() || "<plugin>",
      hook: clipText(row.hook, 120) || undefined,
      durationMs: Number.isFinite(Number(row.durationMs))
        ? Math.max(0, Math.floor(Number(row.durationMs)))
        : undefined,
      error: clipText(row.error, 260) || undefined,
      requestPreview: clipText(row.requestPreview, 260) || undefined,
      responsePreview: clipText(row.responsePreview, 260) || undefined,
      runtimeMessageCount: Number.isFinite(Number(row.runtimeMessageCount))
        ? Math.max(0, Math.floor(Number(row.runtimeMessageCount)))
        : undefined,
      sessionId: clipText(row.sessionId, 80) || undefined,
      modulePath: clipText(row.modulePath, 200) || undefined,
      exportName: clipText(row.exportName, 120) || undefined,
    },
    PLUGIN_HOOK_TAIL_LIMIT
  );
}

export function recordRuntimeInternalDebugEvent(event: RuntimeInternalDebugEvent): void {
  pushTail(
    internalEventTail,
    {
      ts: String(event.ts || nowIso()),
      type: String(event.type || "").trim() || "runtime.unknown",
      ok:
        event.ok === undefined
          ? undefined
          : event.ok === true,
      pluginId: clipText(event.pluginId, 120) || undefined,
      detail: clipText(event.detail, 260) || undefined,
    },
    INTERNAL_EVENT_TAIL_LIMIT
  );
}

export function getRuntimeDebugSnapshot(options: {
  routeLimit?: unknown;
  pluginMessageLimit?: unknown;
  pluginHookLimit?: unknown;
  internalEventLimit?: unknown;
  pluginId?: unknown;
  eventTypes?: unknown;
  text?: unknown;
  errorsOnly?: unknown;
  channels?: unknown;
} = {}): JsonRecord {
  const pluginId = clipText(options.pluginId, 120) || "";
  const textQuery = clipText(options.text, 180).toLowerCase();
  const errorsOnly = options.errorsOnly === true;
  const eventTypes = Array.isArray(options.eventTypes)
    ? options.eventTypes
        .map((item) => clipText(item, 120).toLowerCase())
        .filter(Boolean)
    : [];
  const channelSet = new Set<RuntimeDebugChannel>(
    Array.isArray(options.channels)
      ? options.channels
          .map((item) => String(item || "").trim())
          .filter(
            (item): item is RuntimeDebugChannel =>
              item === "routes"
              || item === "pluginRuntimeMessages"
              || item === "pluginHookTrace"
              || item === "internalEvents"
          )
      : []
  );
  const routeLimit = Math.max(1, Math.floor(Number(options.routeLimit || 40)));
  const pluginMessageLimit = Math.max(
    1,
    Math.floor(Number(options.pluginMessageLimit || 40))
  );
  const pluginHookLimit = Math.max(
    1,
    Math.floor(Number(options.pluginHookLimit || 40))
  );
  const internalEventLimit = Math.max(
    1,
    Math.floor(Number(options.internalEventLimit || 24))
  );

  const matchesPluginId = (value: unknown, fallback: unknown[] = []): boolean => {
    if (!pluginId) return true;
    const direct = clipText(value, 120);
    if (direct && direct === pluginId) return true;
    return fallback.some((item) => clipText(item, 200).includes(pluginId));
  };

  const matchesEventType = (...values: unknown[]): boolean => {
    if (eventTypes.length === 0) return true;
    const haystack = values
      .map((item) => clipText(item, 160).toLowerCase())
      .filter(Boolean);
    return haystack.some((item) => eventTypes.includes(item));
  };

  const matchesText = (value: unknown): boolean => {
    if (!textQuery) return true;
    const text = clipText(
      (() => {
        try {
          return typeof value === "string" ? value : JSON.stringify(value);
        } catch {
          return String(value ?? "");
        }
      })(),
      2000
    ).toLowerCase();
    return text.includes(textQuery);
  };

  const hasErrorSignal = (row: Record<string, unknown>, extra: unknown[] = []): boolean => {
    if (row.ok === false) return true;
    if (clipText(row.error, 260)) return true;
    if (clipText(row.detail, 260).toLowerCase().includes("error")) return true;
    if (clipText(row.type, 160).toLowerCase().includes("error")) return true;
    if (clipText(row.type, 160).toLowerCase().includes("failed")) return true;
    return extra.some((item) => clipText(item, 260).toLowerCase().includes("error"));
  };

  const filteredRoutes = routeTail.filter((item) => {
    const row = item as unknown as Record<string, unknown>;
    if (!matchesPluginId(item.pluginId, [item.summary, item.error])) return false;
    if (!matchesEventType(item.type)) return false;
    if (!matchesText(row)) return false;
    if (errorsOnly && !hasErrorSignal(row, [item.summary])) return false;
    return true;
  });

  const filteredPluginMessages = pluginMessageTail.filter((item) => {
    const row = item as unknown as Record<string, unknown>;
    if (!matchesPluginId(item.pluginId, [item.preview])) return false;
    if (!matchesEventType(item.type)) return false;
    if (!matchesText(row)) return false;
    if (errorsOnly && !hasErrorSignal(row, [item.preview])) return false;
    return true;
  });

  const filteredPluginHooks = pluginHookTail.filter((item) => {
    const row = item as unknown as Record<string, unknown>;
    if (!matchesPluginId(item.pluginId, [item.requestPreview, item.responsePreview, item.error])) return false;
    if (!matchesEventType(item.traceType, item.hook)) return false;
    if (!matchesText(row)) return false;
    if (errorsOnly && !hasErrorSignal(row, [item.requestPreview, item.responsePreview])) return false;
    return true;
  });

  const filteredInternalEvents = internalEventTail.filter((item) => {
    const row = item as unknown as Record<string, unknown>;
    if (!matchesPluginId(item.pluginId, [item.detail])) return false;
    if (!matchesEventType(item.type)) return false;
    if (!matchesText(row)) return false;
    if (errorsOnly && !hasErrorSignal(row, [item.detail])) return false;
    return true;
  });

  const includeChannel = (channel: RuntimeDebugChannel): boolean =>
    channelSet.size === 0 || channelSet.has(channel);

  return {
    schemaVersion: "bbl.runtime-debug.v1",
    summary: {
      routeCount: filteredRoutes.length,
      pluginMessageCount: filteredPluginMessages.length,
      pluginHookCount: filteredPluginHooks.length,
      internalEventCount: filteredInternalEvents.length,
      filteredByPluginId: pluginId || undefined,
      filteredByEventTypes: eventTypes,
      filteredByText: textQuery || undefined,
      errorsOnly,
      channels:
        channelSet.size > 0 ? Array.from(channelSet.values()) : undefined,
    },
    routes: includeChannel("routes") ? filteredRoutes.slice(-routeLimit) : [],
    pluginRuntimeMessages: includeChannel("pluginRuntimeMessages")
      ? filteredPluginMessages.slice(-pluginMessageLimit)
      : [],
    pluginHookTrace: includeChannel("pluginHookTrace")
      ? filteredPluginHooks.slice(-pluginHookLimit)
      : [],
    internalEvents: includeChannel("internalEvents")
      ? filteredInternalEvents.slice(-internalEventLimit)
      : [],
  };
}

export function resetRuntimeDebugStoreForTest(): void {
  routeTail.length = 0;
  pluginMessageTail.length = 0;
  pluginHookTail.length = 0;
  internalEventTail.length = 0;
}
