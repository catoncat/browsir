/**
 * sandbox-relay.ts
 *
 * SidePanel / Plugin Studio side relay.
 * Creates a hidden sandbox iframe and relays messages between
 * the Service Worker and the sandbox page.
 *
 * Call `initSandboxRelay()` once at page startup.
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
  el.setAttribute("aria-hidden", "true");
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
  if (iframe?.isConnected) {
    iframe.remove();
  }
  iframe = null;
  iframeReady = false;
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

// --- iframe message handling ---

function onIframeMessage(event: MessageEvent): void {
  const data = event.data;
  if (!data || typeof data.type !== "string") return;

  if (data.type === "sandbox-ready") {
    iframeReady = true;
    for (const pending of pendingQueue) {
      forwardToIframe(pending.data, pending.resolve);
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
  }
}

function forwardToIframe(
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

// --- SW message handling ---

function onSwMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean {
  const data = message as Record<string, unknown> | undefined;
  if (!data || typeof data.type !== "string") return false;
  if (!String(data.type).startsWith("sandbox-")) return false;

  if (data.type === "sandbox-reset") {
    destroyIframe();
    ensureIframe();
    sendResponse({ ok: true });
    return false;
  }

  forwardToIframe(data, (result) => {
    sendResponse(result);
  });

  return true; // keep channel open for async response
}

// --- Public API ---

let initialized = false;

/**
 * Initialize the sandbox relay. Call once at page startup.
 * Creates a hidden iframe and sets up message listeners.
 */
export function initSandboxRelay(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener("message", onIframeMessage);
  chrome.runtime.onMessage.addListener(onSwMessage);
  ensureIframe();
}
