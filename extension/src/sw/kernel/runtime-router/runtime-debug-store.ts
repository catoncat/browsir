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
} = {}): JsonRecord {
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
  return {
    schemaVersion: "bbl.runtime-debug.v1",
    summary: {
      routeCount: routeTail.length,
      pluginMessageCount: pluginMessageTail.length,
      pluginHookCount: pluginHookTail.length,
      internalEventCount: internalEventTail.length,
    },
    routes: routeTail.slice(-routeLimit),
    pluginRuntimeMessages: pluginMessageTail.slice(-pluginMessageLimit),
    pluginHookTrace: pluginHookTail.slice(-pluginHookLimit),
    internalEvents: internalEventTail.slice(-internalEventLimit),
  };
}

export function resetRuntimeDebugStoreForTest(): void {
  routeTail.length = 0;
  pluginMessageTail.length = 0;
  pluginHookTail.length = 0;
  internalEventTail.length = 0;
}
