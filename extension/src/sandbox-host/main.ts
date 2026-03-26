/**
 * sandbox-host/main.ts
 *
 * Offscreen document (or standalone host page) that hosts long-lived services
 * for the extension:
 * - sandbox relay -> eval-sandbox iframe
 * - wechat host service -> login/state skeleton for channel runtime
 *
 * Communication flow:
 *   SW  →  chrome.runtime.sendMessage  →  this page
 *   this page  →  service dispatch / postMessage  →  child service
 *   child service  →  this page
 *   this page  →  sendResponse  →  SW
 */

import {
  HOST_PROTOCOL_VERSION,
  type HostCommandEnvelope,
  type HostResponseEnvelope,
} from "../sw/kernel/host-protocol";
import { WechatHostService } from "./wechat-service";

const SANDBOX_URL = chrome.runtime.getURL("eval-sandbox.html");
const wechatService = new WechatHostService();

// --- State ---

let iframe: HTMLIFrameElement | null = null;
let iframeReady = false;
const pendingQueue: Array<{
  data: unknown;
  resolve: (value: unknown) => void;
}> = [];
const inflightRequests = new Map<
  string,
  { resolve: (value: unknown) => void }
>();

// --- iframe lifecycle ---

function createSandboxIframe(): HTMLIFrameElement {
  const el = document.createElement("iframe");
  el.src = SANDBOX_URL;
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function ensureIframe(): HTMLIFrameElement {
  if (!iframe || !iframe.isConnected) {
    iframe = createSandboxIframe();
    iframeReady = false;
  }
  return iframe;
}

function destroyIframe(): void {
  if (iframe && iframe.isConnected) {
    iframe.remove();
  }
  iframe = null;
  iframeReady = false;
  // Reject all inflight requests
  for (const [id, { resolve }] of inflightRequests) {
    resolve({
      type: "sandbox-bash-result",
      id,
      ok: false,
      stdout: "",
      stderr: "sandbox iframe destroyed",
      exitCode: 1,
      vfsDiff: [],
    });
  }
  inflightRequests.clear();
}

// --- Message relay: sandbox iframe → this page ---

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (!data || typeof data.type !== "string") return;

  if (data.type === "sandbox-ready") {
    iframeReady = true;
    // Flush pending queue
    for (const pending of pendingQueue) {
      sendToIframe(pending.data, pending.resolve);
    }
    pendingQueue.length = 0;
    return;
  }

  if (data.type === "sandbox-pong" || data.type === "sandbox-bash-result") {
    const id = String(data.id || "");
    const inflight = inflightRequests.get(id);
    if (inflight) {
      inflightRequests.delete(id);
      inflight.resolve(data);
    }
    return;
  }
});

function sendToIframe(
  data: unknown,
  resolve: (value: unknown) => void
): void {
  const el = ensureIframe();
  if (!iframeReady) {
    pendingQueue.push({ data, resolve });
    return;
  }

  const id = (data as any)?.id;
  if (id) {
    inflightRequests.set(String(id), { resolve });
  }

  el.contentWindow?.postMessage(data, "*");
}

async function handleWechatHostCommand(
  message: HostCommandEnvelope<Record<string, unknown>>,
): Promise<HostResponseEnvelope<unknown>> {
  if (message.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return {
      type: "host.response",
      protocolVersion: HOST_PROTOCOL_VERSION,
      id: message.id,
      service: message.service,
      action: message.action,
      ok: false,
      error: `Unsupported host protocol version: ${String(
        message.protocolVersion || "unknown",
      )}`,
    };
  }

  try {
    let data: unknown;
    switch (message.action) {
      case "get_state":
        data = wechatService.getState();
        break;
      case "login.start":
        data = await wechatService.startLogin();
        break;
      case "logout":
        data = wechatService.logout();
        break;
      case "enable":
        data = wechatService.enable();
        break;
      case "disable":
        data = wechatService.disable();
        break;
      case "reply.text":
        data = await wechatService.sendReply(
          message.payload as unknown as {
            deliveryId: string;
            channelTurnId: string;
            sessionId: string;
            userId: string;
            parts: Array<{ kind: "text"; text: string }>;
          },
        );
        break;
      default:
        return {
          type: "host.response",
          protocolVersion: HOST_PROTOCOL_VERSION,
          id: message.id,
          service: message.service,
          action: message.action,
          ok: false,
          error: `Unsupported wechat action: ${message.action}`,
        };
    }

    return {
      type: "host.response",
      protocolVersion: HOST_PROTOCOL_VERSION,
      id: message.id,
      service: message.service,
      action: message.action,
      ok: true,
      data,
    };
  } catch (error) {
    return {
      type: "host.response",
      protocolVersion: HOST_PROTOCOL_VERSION,
      id: message.id,
      service: message.service,
      action: message.action,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- Message relay: SW → this page ---

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    const data = message as Record<string, unknown> | undefined;
    if (!data || typeof data.type !== "string") return false;

    if (data.type === "host.command") {
      const envelope = data as unknown as HostCommandEnvelope<
        Record<string, unknown>
      >;
      if (envelope.service === "wechat") {
        void handleWechatHostCommand(envelope).then(sendResponse);
        return true;
      }
      sendResponse({
        type: "host.response",
        protocolVersion: HOST_PROTOCOL_VERSION,
        id: String(envelope.id || ""),
        service: envelope.service,
        action: envelope.action,
        ok: false,
        error: `Unsupported host service: ${String(envelope.service || "unknown")}`,
      });
      return false;
    }

    // Only handle sandbox-* messages
    if (!String(data.type).startsWith("sandbox-")) return false;

    if (data.type === "sandbox-reset") {
      destroyIframe();
      ensureIframe();
      sendResponse({ ok: true });
      return false;
    }

    // Forward to sandbox iframe and wait for response
    sendToIframe(data, (result) => {
      sendResponse(result);
    });

    return true; // keep sendResponse channel open for async reply
  }
);

// Initialize iframe on load
ensureIframe();
