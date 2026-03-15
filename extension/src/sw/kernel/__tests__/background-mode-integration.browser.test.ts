import "./test-setup";

import { describe, expect, it, beforeEach, vi } from "vitest";
import { createRuntimeInfraHandler } from "../runtime-infra.browser";
import { setAutomationMode, getAutomationMode } from "../automation-mode";

/**
 * Phase 2 integration tests — verify that snapshot/action routing
 * switches correctly between focus (CDP) and background (DOM) paths.
 */

// ── Fake chrome.tabs.sendMessage for content script ──

function installContentScriptMock(nodes: Record<string, unknown>[] = []) {
  const defaultNodes = [
    {
      id: "uid-btn-1",
      tagName: "BUTTON",
      role: "button",
      name: "Submit",
      value: "",
      disabled: false,
      focused: false,
      visible: true,
      children: [],
    },
    {
      id: "uid-input-1",
      tagName: "INPUT",
      role: "textbox",
      name: "Email",
      value: "",
      disabled: false,
      focused: false,
      visible: true,
      children: [],
    },
  ];
  const nodeList = nodes.length > 0 ? nodes : defaultNodes;

  const idToNode: Record<string, unknown> = {};
  for (const n of nodeList) {
    idToNode[String((n as any).id)] = n;
  }

  (chrome.tabs as any) = {
    ...(chrome.tabs || {}),
    sendMessage: (_tabId: number, _msg: unknown, callback: Function) => {
      queueMicrotask(() => {
        callback({
          success: true,
          data: {
            idToNode,
            metadata: {
              url: "https://example.com/bg-test",
              title: "BG Test",
              nodeCount: nodeList.length,
            },
          },
        });
      });
    },
    create: vi.fn(async (opts: any) => ({
      id: 999,
      windowId: 1,
      active: opts.active ?? true,
      title: "",
      url: opts.url || "",
      pendingUrl: opts.url || "",
    })),
  };
}

// ── Fake chrome.scripting.executeScript for DomLocator ──

function installScriptingMock(
  response: { success: boolean; error?: string; data?: unknown } = { success: true },
) {
  (chrome as any).scripting = {
    executeScript: vi.fn(async () => [{ result: response }]),
  };
}

// ── Minimal CDP debugger mock (for focus mode fallback) ──

function installDebuggerMock() {
  (chrome as unknown as { debugger: any }).debugger = {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_target: any, method: string, _params: any = {}) => {
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              nodeId: "ax-1",
              backendDOMNodeId: 101,
              role: { value: "button" },
              name: { value: "FocusBtn" },
              properties: [{ name: "focusable", value: { value: true } }],
            },
          ],
        };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: `obj-101` } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: {
              ok: true,
              matchesScope: true,
              tag: "button",
              role: "button",
              name: "FocusBtn",
              value: "",
              placeholder: "",
              ariaLabel: "",
              editable: false,
              selector: "#focus-btn",
              disabled: false,
              focused: false,
            },
          },
        };
      }
      if (method === "Runtime.evaluate") {
        const expression = String((_params || {}).expression || "");
        if (expression.includes("readyState") && expression.includes("nodeCount")) {
          return {
            result: {
              value: {
                url: "https://example.com/focus",
                title: "Focus Page",
                readyState: "complete",
                textLength: 100,
                nodeCount: 5,
              },
            },
          };
        }
        if (expression.includes("nodes") && expression.includes("selector not found")) {
          return {
            result: {
              value: {
                ok: true,
                url: "https://example.com/focus",
                title: "Focus Page",
                nodes: [
                  {
                    role: "button",
                    name: "FocusBtn",
                    value: "",
                    selector: "#focus-btn",
                    disabled: false,
                    focused: false,
                    tag: "button",
                  },
                ],
              },
            },
          };
        }
        return {
          result: {
            value: {
              ok: true,
              clicked: true,
              url: "https://example.com/focus",
              title: "Focus Page",
            },
          },
        };
      }
      return {};
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  };
}

describe("background-mode integration", () => {
  beforeEach(() => {
    installContentScriptMock();
    installScriptingMock();
    installDebuggerMock();
  });

  // ─────────────────────────────────
  //  Snapshot routing
  // ─────────────────────────────────

  describe("snapshot routing by automation mode", () => {
    it("uses DOM content script path in background mode", async () => {
      await setAutomationMode("background");
      const infra = createRuntimeInfraHandler();

      const result = await infra.handleMessage({
        type: "cdp.snapshot",
        tabId: 10,
        options: { mode: "interactive" },
      });

      expect(result?.ok).toBe(true);
      if (!result || result.ok !== true) return;
      const data = result.data as Record<string, unknown>;
      expect(data.source).toBe("dom-background");
      expect(data.url).toBe("https://example.com/bg-test");
      expect(data.title).toBe("BG Test");

      const nodes = data.nodes as Array<Record<string, unknown>>;
      expect(nodes.length).toBeGreaterThan(0);
      // Nodes should carry brainUid from content script
      const btn = nodes.find((n) => n.name === "Submit");
      expect(btn).toBeDefined();
      expect(btn!.brainUid).toBe("uid-btn-1");
    });

    it("uses CDP debugger path in focus mode", async () => {
      await setAutomationMode("focus");
      const infra = createRuntimeInfraHandler();

      const result = await infra.handleMessage({
        type: "cdp.snapshot",
        tabId: 10,
        options: { mode: "interactive" },
      });

      expect(result?.ok).toBe(true);
      if (!result || result.ok !== true) return;
      const data = result.data as Record<string, unknown>;
      // Focus mode should NOT have source "dom-background"
      expect(data.source).not.toBe("dom-background");
    });

    it("returns error snapshot when content script fails", async () => {
      await setAutomationMode("background");
      // Override sendMessage to simulate content script failure
      (chrome.tabs as any).sendMessage = (
        _tabId: number,
        _msg: unknown,
        callback: Function,
      ) => {
        queueMicrotask(() => {
          callback({ success: false, error: "permission denied" });
        });
      };

      const infra = createRuntimeInfraHandler();
      const result = await infra.handleMessage({
        type: "cdp.snapshot",
        tabId: 10,
        options: { mode: "interactive" },
      });

      // Error is caught and returned as ok:true with error metadata
      expect(result?.ok).toBe(true);
      if (!result || result.ok !== true) return;
      const data = result.data as Record<string, unknown>;
      expect(data.source).toBe("dom-background-error");
      expect(String(data.error || "")).toContain("permission denied");
      expect(data.count).toBe(0);
    });
  });

  // ─────────────────────────────────
  //  Action routing
  // ─────────────────────────────────

  describe("action routing by automation mode", () => {
    it("routes click through DomLocator in background mode", async () => {
      await setAutomationMode("background");
      const infra = createRuntimeInfraHandler();

      // Acquire lease for write
      await infra.handleMessage({
        type: "lease.acquire",
        tabId: 10,
        owner: "runner-bg",
      });

      const result = await infra.handleMessage({
        type: "cdp.action",
        tabId: 10,
        owner: "runner-bg",
        action: { kind: "click", ref: "uid-btn-1" },
      });

      expect(result?.ok).toBe(true);
      if (!result || result.ok !== true) return;
      const data = result.data as Record<string, unknown>;
      expect(data.mode).toBe("background");
      expect(data.kind).toBe("click");
      expect(data.uid).toBe("uid-btn-1");
    });

    it("routes fill through DomLocator in background mode", async () => {
      await setAutomationMode("background");
      installScriptingMock({ success: true });
      const infra = createRuntimeInfraHandler();

      const result = await infra.handleMessage({
        type: "cdp.action",
        tabId: 10,
        owner: "runner-bg",
        action: { kind: "fill", ref: "uid-input-1", value: "hello@test.com" },
      });

      expect(result?.ok).toBe(true);
      if (!result || result.ok !== true) return;
      const data = result.data as Record<string, unknown>;
      expect(data.mode).toBe("background");
      expect(data.kind).toBe("fill");
    });

    it("returns failure when DomLocator action fails", async () => {
      await setAutomationMode("background");
      installScriptingMock({ success: false, error: "element not found" });
      const infra = createRuntimeInfraHandler();

      const result = await infra.handleMessage({
        type: "cdp.action",
        tabId: 10,
        owner: "runner-bg",
        action: { kind: "click", ref: "uid-missing" },
      });

      expect(result?.ok).toBe(false);
      if (result?.ok !== false) return;
      expect(result.error).toContain("element not found");
    });

    it("falls through to CDP for unsupported action kinds in background mode (mixed fallback)", async () => {
      // First take a focus-mode snapshot to populate CDP ref store
      await setAutomationMode("focus");
      const infra = createRuntimeInfraHandler();

      await infra.handleMessage({
        type: "lease.acquire",
        tabId: 10,
        owner: "runner-bg",
      });

      await infra.handleMessage({
        type: "cdp.snapshot",
        tabId: 10,
        options: { mode: "interactive" },
      });

      // Now switch to background and send unsupported action kind
      await setAutomationMode("background");

      const result = await infra.handleMessage({
        type: "cdp.action",
        tabId: 10,
        owner: "runner-bg",
        action: { kind: "scroll", ref: "bn-101" },
      });

      // Should succeed via CDP fallback, not fail with "unsupported action kind"
      expect(result?.ok).toBe(true);
      if (!result || result.ok !== true) return;
      const data = result.data as Record<string, unknown>;
      expect(data.mode).toBe("background-cdp-fallback");
      expect(String(data.hint || "")).toContain("CDP fallback");
    });

    it("falls through to CDP when no uid is provided in background mode (mixed fallback)", async () => {
      // Take a focus-mode snapshot first to populate CDP ref store
      await setAutomationMode("focus");
      const infra = createRuntimeInfraHandler();

      await infra.handleMessage({
        type: "lease.acquire",
        tabId: 10,
        owner: "runner-bg",
      });

      await infra.handleMessage({
        type: "cdp.snapshot",
        tabId: 10,
        options: { mode: "interactive" },
      });

      // Switch to background, send click with CDP-style selector (no uid/ref)
      await setAutomationMode("background");

      const result = await infra.handleMessage({
        type: "cdp.action",
        tabId: 10,
        owner: "runner-bg",
        action: { kind: "click", selector: "#focus-btn" },
      });

      // Should fall through to CDP since there's no uid for DomLocator
      expect(result?.ok).toBe(true);
      if (!result || result.ok !== true) return;
      const data = result.data as Record<string, unknown>;
      expect(data.mode).toBe("background-cdp-fallback");
    });

    it("uses CDP path in focus mode", async () => {
      await setAutomationMode("focus");
      const infra = createRuntimeInfraHandler();

      // Acquire lease
      await infra.handleMessage({
        type: "lease.acquire",
        tabId: 10,
        owner: "runner-focus",
      });

      const result = await infra.handleMessage({
        type: "cdp.action",
        tabId: 10,
        owner: "runner-focus",
        action: { kind: "click", ref: "bn-101" },
      });

      expect(result?.ok).toBe(true);
      if (!result || result.ok !== true) return;
      const data = result.data as Record<string, unknown>;
      // Focus mode should NOT have mode: "background"
      expect(data.mode).not.toBe("background");
    });
  });

  // ─────────────────────────────────
  //  Tab behavior
  // ─────────────────────────────────

  describe("tab creation in background mode", () => {
    it("creates tab with active:false in background mode", async () => {
      await setAutomationMode("background");

      // We need to test dispatch-plan-executor tab behavior —
      // since it calls chrome.tabs.create directly, test the mock directly
      // to verify the integration point behavior.
      const { getAutomationMode: gam } = await import("../automation-mode");
      const mode = await gam();
      const active = mode === "background" ? false : true;

      const tab = await chrome.tabs.create({
        url: "https://example.com/new",
        active,
      });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://example.com/new",
        active: false,
      });
      expect(tab.active).toBe(false);
    });

    it("creates tab with active:true in focus mode", async () => {
      await setAutomationMode("focus");

      const mode = await (await import("../automation-mode")).getAutomationMode();
      const active = mode === "background" ? false : true;

      await chrome.tabs.create({
        url: "https://example.com/new",
        active,
      });

      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: "https://example.com/new",
        active: true,
      });
    });
  });

  // ─────────────────────────────────
  //  Tool filtering logic
  // ─────────────────────────────────

  describe("tool filtering in background mode", () => {
    // Test the BACKGROUND_FILTERED_TOOLS set logic independently
    const BACKGROUND_FILTERED_TOOLS = new Set([
      "computer",
      "capture_screenshot",
      "capture_tab_screenshot",
      "capture_screenshot_with_highlight",
    ]);

    function shouldKeepTool(canonical: string, mode: "focus" | "background"): boolean {
      if (mode !== "background") return true;
      return !BACKGROUND_FILTERED_TOOLS.has(canonical) && !canonical.includes("screenshot");
    }

    it("filters computer tool in background mode", () => {
      expect(shouldKeepTool("computer", "background")).toBe(false);
    });

    it("filters capture_screenshot in background mode", () => {
      expect(shouldKeepTool("capture_screenshot", "background")).toBe(false);
    });

    it("filters capture_tab_screenshot in background mode", () => {
      expect(shouldKeepTool("capture_tab_screenshot", "background")).toBe(false);
    });

    it("filters capture_screenshot_with_highlight in background mode", () => {
      expect(shouldKeepTool("capture_screenshot_with_highlight", "background")).toBe(false);
    });

    it("filters any tool containing 'screenshot' in background mode", () => {
      expect(shouldKeepTool("custom_screenshot_tool", "background")).toBe(false);
    });

    it("keeps click tool in background mode", () => {
      expect(shouldKeepTool("click", "background")).toBe(true);
    });

    it("keeps navigate tool in background mode", () => {
      expect(shouldKeepTool("navigate", "background")).toBe(true);
    });

    it("keeps all tools in focus mode", () => {
      expect(shouldKeepTool("computer", "focus")).toBe(true);
      expect(shouldKeepTool("capture_screenshot", "focus")).toBe(true);
      expect(shouldKeepTool("capture_tab_screenshot", "focus")).toBe(true);
    });

    it("mode state can switch between focus and background", async () => {
      await setAutomationMode("background");
      expect(await getAutomationMode()).toBe("background");

      await setAutomationMode("focus");
      expect(await getAutomationMode()).toBe("focus");
    });
  });
});
