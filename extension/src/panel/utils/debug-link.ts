type JsonRecord = Record<string, unknown>;

interface RuntimeResponse<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string;
}

export type DebugExportTargetKind = "session" | "plugin";
export type DebugExportChannel =
  | "routes"
  | "pluginRuntimeMessages"
  | "pluginHookTrace"
  | "internalEvents";

export interface DebugExportFilters {
  channels?: DebugExportChannel[];
  eventTypes?: string[];
  text?: string;
  errorsOnly?: boolean;
  limit?: number;
}

export interface PublishDebugLinkOptions {
  bridgeUrl: string;
  bridgeToken: string;
  title?: string;
  target: {
    kind: DebugExportTargetKind;
    sessionId?: string;
    pluginId?: string;
  };
  filters?: DebugExportFilters;
  clientPayload?: JsonRecord;
}

export interface PublishedDebugLinkResult {
  payload: JsonRecord;
  exportId: string;
  downloadUrl: string;
  item: JsonRecord;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function clipText(value: unknown, max = 120): string {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function resolveBridgeHttpBase(bridgeUrlRaw: unknown): string {
  const fallback = "http://127.0.0.1:8787";
  const raw = String(bridgeUrlRaw || "").trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "ws:") return `http://${parsed.host}`;
    if (parsed.protocol === "wss:") return `https://${parsed.host}`;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function appendBridgeTokenToUrl(urlRaw: string, token: string): string {
  const url = new URL(urlRaw);
  url.searchParams.set("token", token);
  return url.toString();
}

async function sendMessage<T = unknown>(
  type: string,
  payload: JsonRecord = {},
): Promise<T> {
  const out = (await chrome.runtime.sendMessage({
    type,
    ...payload,
  })) as RuntimeResponse<T>;
  if (!out?.ok) {
    throw new Error(String(out?.error || `${type} failed`));
  }
  return out.data as T;
}

function normalizeFilters(input: DebugExportFilters | undefined): DebugExportFilters {
  const raw = input || {};
  const channels = Array.isArray(raw.channels)
    ? raw.channels.filter((item) =>
        item === "routes"
        || item === "pluginRuntimeMessages"
        || item === "pluginHookTrace"
        || item === "internalEvents"
      )
    : [];
  const eventTypes = Array.isArray(raw.eventTypes)
    ? raw.eventTypes.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  return {
    channels,
    eventTypes,
    text: clipText(raw.text, 180) || undefined,
    errorsOnly: raw.errorsOnly === true,
    limit: Math.max(10, Math.min(200, Math.floor(Number(raw.limit || 80)))) || 80,
  };
}

function pickDiagnosticsSummary(payload: JsonRecord): JsonRecord {
  return {
    summary: toRecord(payload.summary),
    timeline: Array.isArray(payload.timeline) ? payload.timeline : [],
    recentEvents: Array.isArray(payload.recentEvents) ? payload.recentEvents : [],
    debug: toRecord(payload.debug),
    sessionMeta: toRecord(payload.sessionMeta),
  };
}

async function collectSessionArtifact(
  sessionId: string | undefined,
  filters: DebugExportFilters,
): Promise<JsonRecord> {
  const runtime = await sendMessage<Record<string, unknown>>("brain.debug.runtime", {
    sessionId: sessionId || undefined,
    routeLimit: filters.limit,
    pluginMessageLimit: filters.limit,
    pluginHookLimit: filters.limit,
    internalEventLimit: filters.limit,
    channels: filters.channels,
    eventTypes: filters.eventTypes,
    text: filters.text,
    errorsOnly: filters.errorsOnly,
  });
  const diagnostics = await sendMessage<Record<string, unknown>>("brain.debug.dump", {
    sessionId: sessionId || undefined,
    maxEvents: 5000,
    maxBytes: 4 * 1024 * 1024,
  });
  return {
    runtime,
    diagnostics: pickDiagnosticsSummary(toRecord(diagnostics)),
  };
}

async function collectPluginArtifact(
  sessionId: string | undefined,
  pluginId: string,
  filters: DebugExportFilters,
): Promise<JsonRecord> {
  const runtime = await sendMessage<Record<string, unknown>>("brain.debug.runtime", {
    sessionId: sessionId || undefined,
    pluginId,
    routeLimit: filters.limit,
    pluginMessageLimit: filters.limit,
    pluginHookLimit: filters.limit,
    internalEventLimit: filters.limit,
    channels: filters.channels,
    eventTypes: filters.eventTypes,
    text: filters.text,
    errorsOnly: filters.errorsOnly,
  });
  return { runtime };
}

export async function publishDebugLinkToBridge(
  options: PublishDebugLinkOptions,
): Promise<PublishedDebugLinkResult> {
  const bridgeUrl = String(options.bridgeUrl || "").trim();
  const bridgeToken = String(options.bridgeToken || "").trim();
  if (!bridgeUrl) {
    throw new Error("bridgeUrl 未配置");
  }
  if (!bridgeToken) {
    throw new Error("bridgeToken 未配置");
  }

  const target = options.target || { kind: "session" as const };
  const kind = target.kind === "plugin" ? "plugin" : "session";
  const sessionId = String(target.sessionId || "").trim() || undefined;
  const pluginId = String(target.pluginId || "").trim() || undefined;
  const filters = normalizeFilters(options.filters);
  if (kind === "plugin" && !pluginId) {
    throw new Error("plugin 调试链接需要 pluginId");
  }

  const data =
    kind === "plugin"
      ? await collectPluginArtifact(sessionId, pluginId || "", filters)
      : await collectSessionArtifact(sessionId, filters);

  const payload: JsonRecord = {
    schemaVersion: "bbl.debug.export.v1",
    generatedAt: new Date().toISOString(),
    target: {
      kind,
      sessionId: sessionId || "",
      pluginId: pluginId || "",
    },
    filters,
    data,
    client: toRecord(options.clientPayload),
  };

  const baseUrl = resolveBridgeHttpBase(bridgeUrl);
  const response = await fetch(
    `${baseUrl}/api/debug-snapshots?token=${encodeURIComponent(bridgeToken)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: sessionId || (pluginId || kind),
        title:
          clipText(options.title || "", 96)
          || (kind === "plugin"
            ? `插件调试 ${pluginId}`
            : `会话调试 ${sessionId || "active"}`),
        payload,
      }),
    },
  );

  const result = toRecord(await response.json().catch(() => ({})));
  if (!response.ok || result.ok === false) {
    throw new Error(
      String(result.error || `publish debug link failed: ${response.status}`),
    );
  }

  const resultData = toRecord(result.data);
  const item = toRecord(resultData.item || result.item);
  const downloadPath = String(
    resultData.downloadUrl || result.downloadUrl || "",
  ).trim();
  const unsignedDownloadUrl =
    downloadPath.startsWith("http://") || downloadPath.startsWith("https://")
      ? downloadPath
      : `${baseUrl}${downloadPath}`;

  return {
    payload,
    exportId: String(item.id || ""),
    downloadUrl: appendBridgeTokenToUrl(unsignedDownloadUrl, bridgeToken),
    item,
  };
}
