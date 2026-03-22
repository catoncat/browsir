// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const PAGE_SOURCE = "bbl-cursor-help-page";
const CONTENT_SOURCE = "bbl-cursor-help-content";
const PAGE_HOOK_READY_ATTR = "data-bbl-cursor-help-page-ready";
const CURSOR_HELP_RUNTIME_VERSION = "cursor-help-runtime-2026-03-12-r1";

type RuntimeListener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: Record<string, unknown>) => void
) => boolean | void;

let runtimeListener: RuntimeListener | null = null;
let inspectPayload: Record<string, unknown> = {};

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
      id: "test-extension",
      onMessage: createOnMessageEvent(),
      sendMessage: vi.fn(async () => ({ ok: true }))
    }
  } as unknown as typeof chrome;
}

function installPageRpcBridge(): void {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CONTENT_SOURCE || data.type !== "WEBCHAT_INSPECT") return;

    const payload = data.payload && typeof data.payload === "object" ? (data.payload as Record<string, unknown>) : {};
    window.postMessage(
      {
        source: PAGE_SOURCE,
        type: "WEBCHAT_RPC_RESULT",
        payload: {
          rpcId: String(payload.rpcId || "").trim(),
          ...inspectPayload
        }
      },
      window.location.origin
    );
  });
}

function markAsNonRendered(element: Element): void {
  Object.defineProperty(element, "getClientRects", {
    configurable: true,
    value: () => []
  });
}

async function inspectWebchat(): Promise<Record<string, unknown>> {
  if (!runtimeListener) {
    throw new Error("content runtime listener not installed");
  }

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("inspect timed out")), 2_000);
    runtimeListener?.({ type: "webchat.inspect" }, {}, (response) => {
      window.clearTimeout(timer);
      resolve(response);
    });
  });
}

function getContentScriptModuleUrl(): string {
  return new URL("../cursor-help-content.ts", import.meta.url).href;
}

beforeAll(async () => {
  installChromeMock();
  installPageRpcBridge();
  await import(/* @vite-ignore */ getContentScriptModuleUrl());
});

beforeEach(() => {
  inspectPayload = {
    pageHookReady: true,
    fetchHookReady: true,
    senderReady: false,
    canExecute: false,
    selectedModel: "",
    availableModels: [],
    pageRuntimeVersion: CURSOR_HELP_RUNTIME_VERSION
  };
  document.body.innerHTML = "";
  document.documentElement.setAttribute(PAGE_HOOK_READY_ATTR, "1");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible"
  });
});

describe("cursor-help-content webchat.inspect", () => {
  it("keeps model discovery working in hidden popup documents", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    document.body.innerHTML = `
      <button aria-selected="true">GPT-4o mini</button>
      <button>Claude Sonnet 4</button>
      <button>Share</button>
    `;

    const buttons = Array.from(document.querySelectorAll("button"));
    buttons.forEach(markAsNonRendered);

    const response = await inspectWebchat();

    expect(response.ok).toBe(true);
    expect(response.selectedModel).toBe("GPT-4o mini");
    expect(response.availableModels).toEqual(["GPT-4o mini", "Claude Sonnet 4"]);
  });

  it("does not treat prompt-style button text as model names", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    document.body.innerHTML = `
      <button aria-selected="true">GPT-4o mini</button>
      <button>Try Claude Sonnet 4 to review this PR</button>
      <button>Gemini 2.5 Pro</button>
    `;

    const buttons = Array.from(document.querySelectorAll("button"));
    buttons.forEach(markAsNonRendered);

    const response = await inspectWebchat();

    expect(response.ok).toBe(true);
    expect(response.selectedModel).toBe("GPT-4o mini");
    expect(response.availableModels).toEqual(["GPT-4o mini", "Gemini 2.5 Pro"]);
  });

  it("captures the three visible cursor helper models from the model menu", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    document.body.innerHTML = `
      <button aria-selected="true">Sonnet 4.6</button>
      <button>GPT-5.1 Codex Mini</button>
      <button>Gemini 3 Flash</button>
    `;

    const buttons = Array.from(document.querySelectorAll("button"));
    buttons.forEach(markAsNonRendered);

    const response = await inspectWebchat();

    expect(response.ok).toBe(true);
    expect(response.selectedModel).toBe("Sonnet 4.6");
    expect(response.availableModels).toEqual([
      "Sonnet 4.6",
      "GPT-5.1 Codex Mini",
      "Gemini 3 Flash"
    ]);
  });
});
