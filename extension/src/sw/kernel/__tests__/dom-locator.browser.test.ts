import "./test-setup";

import { describe, expect, it, vi, beforeEach } from "vitest";
import { DomLocator } from "../dom-locator";

// -------------------------------------------------------------------
// Mock chrome.scripting.executeScript
// -------------------------------------------------------------------

let mockExecuteScript: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExecuteScript = vi.fn();
  (globalThis as any).chrome.scripting = {
    executeScript: mockExecuteScript,
  };
});

describe("DomLocator", () => {
  const TAB_ID = 42;

  it("calls chrome.scripting.executeScript with correct tabId", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { success: true } },
    ]);

    const locator = new DomLocator(TAB_ID);
    await locator.click("uid-1");

    expect(mockExecuteScript).toHaveBeenCalledTimes(1);
    const call = mockExecuteScript.mock.calls[0][0];
    expect(call.target.tabId).toBe(TAB_ID);
    expect(call.args[0].action).toBe("click");
    expect(call.args[0].uid).toBe("uid-1");
  });

  it("click passes options through", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { success: true } },
    ]);

    const locator = new DomLocator(TAB_ID);
    await locator.click("uid-2", { count: 2, highlight: false });

    const payload = mockExecuteScript.mock.calls[0][0].args[0];
    expect(payload.count).toBe(2);
    expect(payload.highlight).toBe(false);
  });

  it("fill sends value in payload", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { success: true } },
    ]);

    const locator = new DomLocator(TAB_ID);
    await locator.fill("uid-3", { value: "hello world" });

    const payload = mockExecuteScript.mock.calls[0][0].args[0];
    expect(payload.action).toBe("fill");
    expect(payload.value).toBe("hello world");
  });

  it("hover sends correct action", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { success: true } },
    ]);

    const locator = new DomLocator(TAB_ID);
    await locator.hover("uid-4");

    const payload = mockExecuteScript.mock.calls[0][0].args[0];
    expect(payload.action).toBe("hover");
  });

  it("boundingBox returns data from the injected script", async () => {
    const box = { x: 10, y: 20, width: 100, height: 50 };
    mockExecuteScript.mockResolvedValue([
      { result: { success: true, data: box } },
    ]);

    const locator = new DomLocator(TAB_ID);
    const res = await locator.boundingBox("uid-5");
    expect(res.success).toBe(true);
    expect(res.data).toEqual(box);
  });

  it("value returns data from the injected script", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { success: true, data: "some text" } },
    ]);

    const locator = new DomLocator(TAB_ID);
    const res = await locator.value("uid-6");
    expect(res.success).toBe(true);
    expect(res.data).toBe("some text");
  });

  it("returns error when element not found", async () => {
    mockExecuteScript.mockResolvedValue([
      { result: { success: false, error: 'Element not found: uid="missing"' } },
    ]);

    const locator = new DomLocator(TAB_ID);
    const res = await locator.click("missing");
    expect(res.success).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("returns error when executeScript throws", async () => {
    mockExecuteScript.mockRejectedValue(new Error("Cannot access tab"));

    const locator = new DomLocator(TAB_ID);
    const res = await locator.click("uid-7");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Cannot access tab");
  });

  it("returns error when no result from injection", async () => {
    mockExecuteScript.mockResolvedValue([{ result: undefined }]);

    const locator = new DomLocator(TAB_ID);
    const res = await locator.click("uid-8");
    expect(res.success).toBe(false);
    expect(res.error).toContain("No result");
  });

  it("returns error when chrome.scripting is unavailable", async () => {
    delete (globalThis as any).chrome.scripting;

    const locator = new DomLocator(TAB_ID);
    const res = await locator.click("uid-9");
    expect(res.success).toBe(false);
    expect(res.error).toContain("unavailable");
  });
});
