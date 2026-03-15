import "./test-setup";

import { describe, expect, it, vi } from "vitest";
import {
  getAutomationMode,
  setAutomationMode,
  onAutomationModeChange,
} from "../automation-mode";

describe("automation-mode", () => {
  describe("getAutomationMode", () => {
    it('returns "focus" by default when storage is empty', async () => {
      expect(await getAutomationMode()).toBe("focus");
    });

    it("returns the stored mode", async () => {
      await chrome.storage.local.set({ "brain:automation_mode": "background" });
      expect(await getAutomationMode()).toBe("background");
    });

    it('returns "focus" for an invalid stored value', async () => {
      await chrome.storage.local.set({ "brain:automation_mode": "invalid" });
      expect(await getAutomationMode()).toBe("focus");
    });
  });

  describe("setAutomationMode", () => {
    it("persists a valid mode", async () => {
      await setAutomationMode("background");
      const result = await chrome.storage.local.get("brain:automation_mode");
      expect(result["brain:automation_mode"]).toBe("background");
    });

    it("throws on an invalid mode", async () => {
      await expect(
        setAutomationMode("invalid" as any),
      ).rejects.toThrow("Invalid automation mode");
    });
  });

  describe("onAutomationModeChange", () => {
    it("calls the callback when the storage key changes", () => {
      // Set up a real listener store
      const listeners: Function[] = [];
      (chrome.storage as any).onChanged = {
        addListener: (fn: Function) => listeners.push(fn),
        removeListener: (fn: Function) => {
          const idx = listeners.indexOf(fn);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };

      const cb = vi.fn();
      const unsub = onAutomationModeChange(cb);

      // Simulate a change event
      for (const l of listeners) {
        l(
          { "brain:automation_mode": { oldValue: "focus", newValue: "background" } },
          "local",
        );
      }
      expect(cb).toHaveBeenCalledWith("background");

      // Unsubscribe
      unsub();
      cb.mockClear();
      for (const l of listeners) {
        l(
          { "brain:automation_mode": { oldValue: "background", newValue: "focus" } },
          "local",
        );
      }
      expect(cb).not.toHaveBeenCalled();
    });

    it("ignores changes from non-local storage areas", () => {
      const listeners: Function[] = [];
      (chrome.storage as any).onChanged = {
        addListener: (fn: Function) => listeners.push(fn),
        removeListener: () => {},
      };

      const cb = vi.fn();
      onAutomationModeChange(cb);

      for (const l of listeners) {
        l(
          { "brain:automation_mode": { newValue: "background" } },
          "sync",
        );
      }
      expect(cb).not.toHaveBeenCalled();
    });

    it("ignores unrelated storage key changes", () => {
      const listeners: Function[] = [];
      (chrome.storage as any).onChanged = {
        addListener: (fn: Function) => listeners.push(fn),
        removeListener: () => {},
      };

      const cb = vi.fn();
      onAutomationModeChange(cb);

      for (const l of listeners) {
        l(
          { "some_other_key": { newValue: "whatever" } },
          "local",
        );
      }
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
