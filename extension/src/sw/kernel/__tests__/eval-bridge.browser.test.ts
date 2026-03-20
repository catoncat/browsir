import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxBash, sandboxReset } from "../eval-bridge";

describe("eval-bridge", () => {
  beforeEach(() => {
    // Provide getContexts + sendMessage mocks
    (globalThis as any).chrome = {
      ...(globalThis as any).chrome,
      runtime: {
        ...(globalThis as any).chrome?.runtime,
        getContexts: vi.fn(),
        sendMessage: vi.fn(),
      },
      offscreen: {
        createDocument: vi.fn(),
      },
    };
  });

  describe("sandboxBash", () => {
    it("prefers offscreen relay even when SidePanel is available", async () => {
      const chromeRuntime = (globalThis as any).chrome.runtime;
      chromeRuntime.getContexts.mockImplementation(
        async ({ contextTypes }: { contextTypes?: string[] }) => {
          if (contextTypes?.includes("OFFSCREEN_DOCUMENT")) return [];
          if (contextTypes?.includes("SIDE_PANEL")) return [{ contextType: "SIDE_PANEL" }];
          return [];
        }
      );
      chromeRuntime.sendMessage.mockResolvedValue({
        ok: true,
        stdout: "hello",
        stderr: "",
        exitCode: 0,
        vfsDiff: [],
      });

      const result = await sandboxBash({
        command: "echo hello",
        files: [],
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("hello");
      expect(result.exitCode).toBe(0);
      expect(
        (globalThis as any).chrome.offscreen.createDocument
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "sandbox-host.html",
        })
      );
    });

    it("creates offscreen document when no relay exists", async () => {
      const chromeRuntime = (globalThis as any).chrome.runtime;
      chromeRuntime.getContexts
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      chromeRuntime.sendMessage.mockResolvedValue({
        ok: true,
        stdout: "from offscreen",
        stderr: "",
        exitCode: 0,
        vfsDiff: [{ op: "add", path: "/test.txt", content: "data" }],
      });

      const result = await sandboxBash({
        command: "echo test",
        files: [{ path: "/input.txt", content: "input" }],
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toBe("from offscreen");
      expect(result.vfsDiff).toHaveLength(1);
      expect(result.vfsDiff[0]).toEqual({
        op: "add",
        path: "/test.txt",
        content: "data",
      });
      // Should create offscreen document
      expect(
        (globalThis as any).chrome.offscreen.createDocument
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "sandbox-host.html",
        })
      );
    });

    it("returns error result when sendMessage fails", async () => {
      const chromeRuntime = (globalThis as any).chrome.runtime;
      chromeRuntime.getContexts.mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
      chromeRuntime.sendMessage.mockRejectedValue(new Error("disconnected"));

      const result = await sandboxBash({
        command: "echo fail",
        files: [],
      });

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("disconnected");
      expect(result.vfsDiff).toEqual([]);
    });

    it("returns error result when no response from sandbox", async () => {
      const chromeRuntime = (globalThis as any).chrome.runtime;
      chromeRuntime.getContexts.mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
      chromeRuntime.sendMessage.mockResolvedValue(null);

      const result = await sandboxBash({
        command: "echo missing",
        files: [],
      });

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain("No response from sandbox relay");
    });

    it("passes files, cwd, and timeoutMs in message", async () => {
      const chromeRuntime = (globalThis as any).chrome.runtime;
      chromeRuntime.getContexts.mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
      chromeRuntime.sendMessage.mockResolvedValue({
        ok: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        vfsDiff: [],
      });

      await sandboxBash({
        command: "cat /a.txt",
        files: [{ path: "/a.txt", content: "aaa" }],
        cwd: "/home",
        timeoutMs: 5000,
      });

      const sentMessage = chromeRuntime.sendMessage.mock.calls[0][0];
      expect(sentMessage.type).toBe("sandbox-bash");
      expect(sentMessage.command).toBe("cat /a.txt");
      expect(sentMessage.files).toEqual([{ path: "/a.txt", content: "aaa" }]);
      expect(sentMessage.cwd).toBe("/home");
      expect(sentMessage.timeoutMs).toBe(5000);
      expect(sentMessage.id).toMatch(/^sb-/);
    });

    it("skips offscreen creation if already exists", async () => {
      const chromeRuntime = (globalThis as any).chrome.runtime;
      chromeRuntime.getContexts.mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
      chromeRuntime.sendMessage.mockResolvedValue({
        ok: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
        vfsDiff: [],
      });

      await sandboxBash({ command: "ls", files: [] });

      expect(
        (globalThis as any).chrome.offscreen.createDocument
      ).not.toHaveBeenCalled();
    });
  });

  describe("sandboxReset", () => {
    it("sends reset message", async () => {
      const chromeRuntime = (globalThis as any).chrome.runtime;
      chromeRuntime.sendMessage.mockResolvedValue({ ok: true });

      await sandboxReset();

      expect(chromeRuntime.sendMessage).toHaveBeenCalledWith({
        type: "sandbox-reset",
      });
    });

    it("ignores errors when relay unavailable", async () => {
      const chromeRuntime = (globalThis as any).chrome.runtime;
      chromeRuntime.sendMessage.mockRejectedValue(new Error("no relay"));

      // Should not throw
      await expect(sandboxReset()).resolves.toBeUndefined();
    });
  });
});
