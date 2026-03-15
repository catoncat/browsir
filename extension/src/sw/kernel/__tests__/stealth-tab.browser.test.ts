import "./test-setup";

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  createStealthTab,
  isStealthTab,
  getStealthWindowId,
  getStealthTabCount,
  closeStealthTab,
  closeStealthWindow,
  handleTabRemoved,
  resetStealthState,
} from "../stealth-tab";

let nextTabId = 100;
let nextWindowId = 500;
const createdTabs: Array<{ id: number; windowId: number; url: string }> = [];
const removedTabIds: number[] = [];
const removedWindowIds: number[] = [];

beforeEach(() => {
  resetStealthState();
  nextTabId = 100;
  nextWindowId = 500;
  createdTabs.length = 0;
  removedTabIds.length = 0;
  removedWindowIds.length = 0;

  // Mock chrome.windows
  (chrome as any).windows = {
    create: vi.fn(async (opts: any) => {
      const wid = nextWindowId++;
      const blankTabId = nextTabId++;
      createdTabs.push({ id: blankTabId, windowId: wid, url: "" });
      return {
        id: wid,
        state: opts.state || "normal",
        focused: opts.focused ?? true,
        tabs: [{ id: blankTabId, windowId: wid, url: "about:blank" }],
      };
    }),
    get: vi.fn(async (wid: number) => {
      if (removedWindowIds.includes(wid)) throw new Error("window not found");
      return { id: wid };
    }),
    remove: vi.fn(async (wid: number) => {
      removedWindowIds.push(wid);
    }),
  };

  // Mock chrome.tabs
  (chrome.tabs as any) = {
    ...(chrome.tabs || {}),
    create: vi.fn(async (opts: any) => {
      const tid = nextTabId++;
      const tab = {
        id: tid,
        windowId: opts.windowId ?? 1,
        url: opts.url || "",
        active: opts.active ?? true,
        title: "",
        pendingUrl: opts.url || "",
      };
      createdTabs.push({ id: tid, windowId: tab.windowId, url: tab.url });
      return tab;
    }),
    remove: vi.fn(async (tid: number) => {
      removedTabIds.push(tid);
    }),
  };
});

describe("stealth-tab", () => {
  it("creates a stealth tab in a minimized window", async () => {
    const tab = await createStealthTab("https://example.com");

    expect(tab.id).toBeDefined();
    expect(tab.url).toBe("https://example.com");
    expect(chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "popup",
        state: "minimized",
        focused: false,
      }),
    );
    expect(isStealthTab(tab.id!)).toBe(true);
    expect(getStealthTabCount()).toBe(1);
  });

  it("reuses the same stealth window for multiple tabs", async () => {
    const tab1 = await createStealthTab("https://a.com");
    const tab2 = await createStealthTab("https://b.com");

    expect(tab1.windowId).toBe(tab2.windowId);
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(getStealthTabCount()).toBe(2);
  });

  it("creates a new window if the previous one was closed", async () => {
    const tab1 = await createStealthTab("https://a.com");
    const firstWindowId = getStealthWindowId();

    // Simulate external window close
    removedWindowIds.push(firstWindowId!);

    const tab2 = await createStealthTab("https://b.com");

    expect(chrome.windows.create).toHaveBeenCalledTimes(2);
    expect(getStealthWindowId()).not.toBe(firstWindowId);
  });

  it("removes blank tab created with the window", async () => {
    await createStealthTab("https://example.com");

    // The window creation creates a blank tab (id=100), then we removed it
    expect(removedTabIds).toContain(100);
  });

  it("isStealthTab returns false for non-stealth tabs", () => {
    expect(isStealthTab(999)).toBe(false);
  });

  it("closeStealthTab removes the tab and updates tracking", async () => {
    const tab = await createStealthTab("https://example.com");
    const tabId = tab.id!;

    await closeStealthTab(tabId);

    expect(isStealthTab(tabId)).toBe(false);
    expect(getStealthTabCount()).toBe(0);
    expect(removedTabIds).toContain(tabId);
  });

  it("auto-closes stealth window when last tab is closed", async () => {
    const tab1 = await createStealthTab("https://a.com");
    const tab2 = await createStealthTab("https://b.com");
    const windowId = getStealthWindowId()!;

    await closeStealthTab(tab1.id!);
    // Window should still exist (tab2 remains)
    expect(getStealthWindowId()).toBe(windowId);

    await closeStealthTab(tab2.id!);
    // Window should be closed now
    expect(getStealthWindowId()).toBeNull();
    expect(removedWindowIds).toContain(windowId);
  });

  it("handleTabRemoved cleans up externally closed tabs", async () => {
    const tab = await createStealthTab("https://example.com");
    const tabId = tab.id!;

    handleTabRemoved(tabId);

    expect(isStealthTab(tabId)).toBe(false);
    expect(getStealthTabCount()).toBe(0);
  });

  it("closeStealthWindow clears all state", async () => {
    await createStealthTab("https://a.com");
    await createStealthTab("https://b.com");

    await closeStealthWindow();

    expect(getStealthWindowId()).toBeNull();
    expect(getStealthTabCount()).toBe(0);
  });

  it("handles closeStealthTab for non-stealth tabs gracefully", async () => {
    await closeStealthTab(999);
    // Should not throw
    expect(getStealthTabCount()).toBe(0);
  });
});
