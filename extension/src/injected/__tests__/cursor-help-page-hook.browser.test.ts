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

function installModelMenuTrigger(
  trigger: HTMLButtonElement,
  models: Array<{ label: string; selected?: boolean }>,
  top = 120,
): void {
  installVisibleRect(trigger, top);
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  let listbox: HTMLDivElement | null = null;
  const renderListbox = () => {
    listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    installVisibleRect(listbox, top + 40);
    for (const [index, model] of models.entries()) {
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", model.selected ? "true" : "false");
      option.textContent = model.label;
      installVisibleRect(option, top + 44 + index * 40);
      listbox.appendChild(option);
    }
    document.body.appendChild(listbox);
  };

  trigger.addEventListener("click", () => {
    const expanded = trigger.getAttribute("aria-expanded") === "true";
    if (expanded) {
      trigger.setAttribute("aria-expanded", "false");
      listbox?.remove();
      listbox = null;
      return;
    }
    trigger.setAttribute("aria-expanded", "true");
    renderListbox();
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

  it("ignores sentence-like labels that only mention a model name", async () => {
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
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
              { label: "Ask Gemini 2.5 Pro to review this file" },
              { label: "GPT-4o mini" },
            ],
          },
          return: null,
        },
      },
    });

    await loadPageHook();

    const payload = await inspectPageHook();

    expect(payload.availableModels).toEqual(["Claude Sonnet 4.6", "GPT-4o mini"]);
  });

  it("expands the model menu when the base catalog only exposes the current model", async () => {
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
    Object.defineProperty(textarea, "__reactFiber$test", {
      configurable: true,
      value: {
        type: { displayName: "ChatInput" },
        memoizedProps: {
          onSubmit() {},
        },
        return: {
          memoizedProps: {
            selectedModel: { label: "Sonnet 4.6" },
            availableModels: [{ label: "Sonnet 4.6", selected: true }],
          },
          return: null,
        },
      },
    });

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "Sonnet 4.6";
    installModelMenuTrigger(
      trigger,
      [
        { label: "Sonnet 4.6", selected: true },
        { label: "GPT-5.1 Codex Mini" },
        { label: "Gemini 2.5 Flash" },
      ],
      120,
    );
    document.body.appendChild(trigger);

    await loadPageHook();

    const payload = await inspectPageHook();

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(payload.selectedModel).toBe("Sonnet 4.6");
    expect(payload.availableModels).toEqual(["Sonnet 4.6", "GPT-5.1 Codex Mini", "Gemini 2.5 Flash"]);
  });
});
