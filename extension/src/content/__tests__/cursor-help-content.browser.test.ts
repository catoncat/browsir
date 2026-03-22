// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PAGE_SOURCE = "bbl-cursor-help-page";
const CONTENT_SOURCE = "bbl-cursor-help-content";
const PAGE_HOOK_READY_ATTR = "data-bbl-cursor-help-page-ready";
const CONTENT_INSTALLED_FLAG = "__bblCursorHelpContentInstalled";

type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | void;

let runtimeListener: RuntimeListener | null = null;

function createOnMessageEvent(): typeof chrome.runtime.onMessage {
  return {
    addListener(listener: RuntimeListener) {
      runtimeListener = listener;
    },
    removeListener(listener: RuntimeListener) {
      if (runtimeListener === listener) {
        runtimeListener = null;
      }
    },
    hasListener(listener: RuntimeListener) {
      return runtimeListener === listener;
    },
    hasListeners() {
      return runtimeListener !== null;
    },
    addRules() {
      // no-op for tests
    },
    getRules() {
      // no-op for tests
    },
    removeRules() {
      // no-op for tests
    },
  } as typeof chrome.runtime.onMessage;
}

function installChromeMock(): void {
  runtimeListener = null;
  (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
    runtime: {
      id: "test-extension-id",
      onMessage: createOnMessageEvent(),
      sendMessage: async () => ({ ok: true }),
    },
  } as unknown as typeof chrome;
}

function dispatchPageMessage(data: Record<string, unknown>): void {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", {
    configurable: true,
    value: window,
  });
  window.dispatchEvent(event);
}

function mockInspectRpc(payload: Record<string, unknown> = {}) {
  const originalPostMessage = window.postMessage.bind(window) as (...args: any[]) => void;
  return vi.spyOn(window, "postMessage").mockImplementation((...args: any[]) => {
    const [message] = args;
    const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
    if (record.source === CONTENT_SOURCE && record.type === "WEBCHAT_INSPECT") {
      const requestPayload =
        record.payload && typeof record.payload === "object"
          ? (record.payload as Record<string, unknown>)
          : {};
      queueMicrotask(() => {
        dispatchPageMessage({
          source: PAGE_SOURCE,
          type: "WEBCHAT_RPC_RESULT",
          payload: {
            rpcId: String(requestPayload.rpcId || ""),
            pageHookReady: true,
            fetchHookReady: true,
            senderReady: false,
            availableModels: [],
            ...payload,
          },
        });
      });
      return undefined;
    }
    return originalPostMessage(...args);
  });
}

function getContentScriptModuleUrl(): string {
  return new URL("../cursor-help-content.ts", import.meta.url).href;
}

async function loadContentScript(): Promise<void> {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>)[CONTENT_INSTALLED_FLAG];
  await import(/* @vite-ignore */ getContentScriptModuleUrl());
}

async function sendRuntimeMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!runtimeListener) {
    throw new Error("runtime listener is not registered");
  }
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    try {
      runtimeListener?.(message, {}, (response) => {
        resolve((response as Record<string, unknown>) || {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

function zeroClientRects(): DOMRectList {
  return {
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {
      yield* [];
    },
  } as DOMRectList;
}

describe("cursor-help-content", () => {
  beforeEach(() => {
    installChromeMock();
    document.documentElement.setAttribute(PAGE_HOOK_READY_ATTR, "1");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).chrome;
    delete (globalThis as Record<string, unknown>)[CONTENT_INSTALLED_FLAG];
    document.body.innerHTML = "";
    document.documentElement.removeAttribute(PAGE_HOOK_READY_ATTR);
  });

  it("falls back to model text collection when popup is minimized", async () => {
    document.body.innerHTML = `
      <button aria-selected="true">Claude Sonnet 4</button>
      <button>Gemini 2.5 Pro</button>
    `;
    mockInspectRpc();
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => zeroClientRects());

    await loadContentScript();
    const response = await sendRuntimeMessage({ type: "webchat.inspect" });

    expect(response.ok).toBe(true);
    expect(response.selectedModel).toBe("Claude Sonnet 4");
    expect(response.availableModels).toEqual(
      expect.arrayContaining(["Claude Sonnet 4", "Gemini 2.5 Pro"]),
    );
  });
});
