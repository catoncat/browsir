import {
  HOST_PROTOCOL_VERSION,
  type HostCommandEnvelope,
  type HostResponseEnvelope,
  type HostServiceId,
} from "./host-protocol";

let requestCounter = 0;

function nextId(): string {
  requestCounter += 1;
  return `host-${Date.now()}-${requestCounter}`;
}

async function ensureOffscreenHost(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "sandbox-host.html",
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Host shared offscreen services for browser brain loop",
  });
}

export async function sendHostCommand<TPayload extends object, TData>(
  service: HostServiceId,
  action: string,
  payload: TPayload,
): Promise<TData> {
  await ensureOffscreenHost();
  const message: HostCommandEnvelope<TPayload> = {
    type: "host.command",
    protocolVersion: HOST_PROTOCOL_VERSION,
    id: nextId(),
    service,
    action,
    payload,
  };

  const response = (await chrome.runtime.sendMessage(
    message,
  )) as HostResponseEnvelope<TData> | undefined;

  if (!response || response.type !== "host.response") {
    throw new Error("Host broker returned no response");
  }
  if (response.protocolVersion !== HOST_PROTOCOL_VERSION) {
    throw new Error(
      `Host protocol mismatch: expected ${HOST_PROTOCOL_VERSION}, got ${String(
        response.protocolVersion || "unknown",
      )}`,
    );
  }
  if (!response.ok) {
    throw new Error(String(response.error || "Host command failed"));
  }
  return response.data;
}
