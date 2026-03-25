import "./test-setup";

import { describe, expect, it, vi } from "vitest";
import {
  isCursorHelpUrl,
  readLiveCursorHelpSlot,
} from "../cursor-help-tab-ops";

describe("cursor-help-tab-ops", () => {
  it("accepts localized Cursor Help home urls", () => {
    expect(isCursorHelpUrl("https://cursor.com/help")).toBe(true);
    expect(isCursorHelpUrl("https://cursor.com/cn/help")).toBe(true);
    expect(isCursorHelpUrl("https://cursor.com/zh-CN/help")).toBe(true);
  });

  it("rejects non-home Cursor pages", () => {
    expect(isCursorHelpUrl("https://cursor.com/help/getting-started/install")).toBe(false);
    expect(isCursorHelpUrl("https://cursor.com/cn/help/getting-started/install")).toBe(false);
    expect(isCursorHelpUrl("https://example.com/cn/help")).toBe(false);
  });

  it("keeps localized tabs as live slots", async () => {
    (chrome as unknown as Record<string, unknown>).tabs = {
      get: vi.fn(async () => ({
        id: 7,
        windowId: 9,
        url: "https://cursor.com/cn/help",
      })),
    };

    const live = await readLiveCursorHelpSlot({
      slotId: "slot-1",
      tabId: 7,
      windowId: 9,
      lanePreference: "primary",
      status: "warming",
      lastKnownUrl: "",
      lastReadyAt: 0,
      lastUsedAt: 0,
      lastHealthCheckedAt: 0,
      recoveryAttemptCount: 0,
    });

    expect(live).toMatchObject({
      slotId: "slot-1",
      tabId: 7,
      windowId: 9,
      lastKnownUrl: "https://cursor.com/cn/help",
    });
  });
});
