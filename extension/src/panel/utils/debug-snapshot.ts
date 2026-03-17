type JsonRecord = Record<string, unknown>;

interface RuntimeResponse<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string;
}

export interface PublishDebugSnapshotOptions {
  sessionId?: string;
  bridgeUrl: string;
  bridgeToken: string;
  title?: string;
  scope?: "runtime" | "sandbox" | "plugins" | "skills" | "all";
  routeLimit?: number;
  pluginMessageLimit?: number;
  pluginHookLimit?: number;
  internalEventLimit?: number;
}

export interface PublishedDebugSnapshotResult {
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
  if (!String(token || "").trim()) return urlRaw;
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

export async function publishDebugSnapshotToBridge(
  options: PublishDebugSnapshotOptions,
): Promise<PublishedDebugSnapshotResult> {
  const bridgeUrl = String(options.bridgeUrl || "").trim();
  const bridgeToken = String(options.bridgeToken || "").trim();
  if (!bridgeUrl) {
    throw new Error("bridgeUrl 未配置");
  }

  const sessionId = String(options.sessionId || "").trim();
  const scope = String(options.scope || "all").trim().toLowerCase() || "all";
  const payload = await sendMessage<Record<string, unknown>>(
    "brain.debug.snapshot",
    {
      sessionId: sessionId || undefined,
      scope,
      routeLimit: options.routeLimit ?? 40,
      pluginMessageLimit: options.pluginMessageLimit ?? 40,
      pluginHookLimit: options.pluginHookLimit ?? 40,
      internalEventLimit: options.internalEventLimit ?? 60,
    },
  );
  const baseUrl = resolveBridgeHttpBase(bridgeUrl);
  const publishUrl = appendBridgeTokenToUrl(
    `${baseUrl}/api/debug-snapshots`,
    bridgeToken,
  );
  const response = await fetch(publishUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionId: sessionId || "global",
      title:
        clipText(options.title || "", 96) ||
        (sessionId ? `调试快照 ${sessionId}` : "调试快照"),
      payload,
    }),
  });

  const result = toRecord(await response.json().catch(() => ({})));
  if (!response.ok || result.ok === false) {
    throw new Error(
      String(result.error || `publish debug snapshot failed: ${response.status}`),
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
    payload: toRecord(payload),
    exportId: String(item.id || ""),
    downloadUrl: appendBridgeTokenToUrl(unsignedDownloadUrl, bridgeToken),
    item,
  };
}
