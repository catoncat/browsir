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

function installChromeMock(): void {
  (globalThis as typeof globalThis & { chrome?: Record<string, unknown> }).chrome = {
    runtime: {
      id: "test-extension",
      onMessage: {
        addListener(listener: RuntimeListener) {
          runtimeListener = listener;
        }
      },
      sendMessage: vi.fn(async () => ({ ok: true }))
    }
  };
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

beforeAll(async () => {
  installChromeMock();
  installPageRpcBridge();
  await import("../cursor-help-content");
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
});
