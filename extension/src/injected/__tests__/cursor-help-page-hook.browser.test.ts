// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONTENT_SOURCE = "bbl-cursor-help-content";
const PAGE_SOURCE = "bbl-cursor-help-page";
const PAGE_HOOK_INSTALLED_FLAG = "__bblCursorHelpPageHookInstalled";

function installVisibleRect(element: HTMLElement, top = 160): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 320,
      bottom: top + 36,
      width: 320,
      height: 36,
      toJSON: () => ({}),
    }),
  });
}

async function loadPageHook(): Promise<void> {
  vi.resetModules();
  delete (window as typeof window & Record<string, unknown>)[PAGE_HOOK_INSTALLED_FLAG];
  await import("../cursor-help-page-hook");
}

async function inspectPageHook(): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      reject(new Error("inspect timed out"));
    }, 2_000);

    const handleMessage = (event: MessageEvent) => {
      const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
      if (data.source !== PAGE_SOURCE || data.type !== "WEBCHAT_RPC_RESULT") return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
      resolve((data.payload as Record<string, unknown>) || {});
    };

    window.addEventListener("message", handleMessage);
    const event = new MessageEvent("message", {
      data: {
        source: CONTENT_SOURCE,
        type: "WEBCHAT_INSPECT",
        payload: { rpcId: "test-rpc-id" },
      },
    });
    Object.defineProperty(event, "source", {
      configurable: true,
      value: window,
    });
    window.dispatchEvent(event);
  });
}

describe("cursor-help-page-hook", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    document.body.innerHTML = `<textarea aria-label="Chat message"></textarea>`;
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
    installVisibleRect(textarea);
    Object.defineProperty(textarea, "__reactFiber$test", {
      configurable: true,
      value: {
        type: { displayName: "ChatInput" },
        memoizedProps: {
          onSubmit() {},
        },
        return: {
          memoizedProps: {
            selectedModel: { label: "Claude Sonnet 4.6" },
            availableModels: [
              { label: "Claude Sonnet 4.6", selected: true },
              { label: "Gemini 2.5 Pro" },
            ],
          },
          return: null,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as typeof window & Record<string, unknown>)[PAGE_HOOK_INSTALLED_FLAG];
    document.body.innerHTML = "";
  });

  it("returns selected and available models via WEBCHAT_INSPECT", async () => {
    await loadPageHook();

    const payload = await inspectPageHook();

    expect(payload.pageHookReady).toBe(true);
    expect(payload.selectedModel).toBe("Claude Sonnet 4.6");
    expect(payload.availableModels).toEqual(["Claude Sonnet 4.6", "Gemini 2.5 Pro"]);
  });
});
