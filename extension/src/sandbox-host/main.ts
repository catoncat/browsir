/**
 * sandbox-host/main.ts
 *
 * Offscreen document (or standalone host page) that embeds the
 * eval-sandbox.html iframe and relays messages between the Service Worker
 * and the sandbox page.
 *
 * Communication flow:
 *   SW  →  chrome.runtime.sendMessage  →  this page
 *   this page  →  postMessage  →  sandbox iframe
 *   sandbox iframe  →  postMessage  →  this page
 *   this page  →  sendResponse  →  SW
 */

const SANDBOX_URL = chrome.runtime.getURL("eval-sandbox.html");

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
  el.setAttribute("sandbox", "allow-scripts");
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

// --- Message relay: SW → this page ---

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    const data = message as Record<string, unknown> | undefined;
    if (!data || typeof data.type !== "string") return false;

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
