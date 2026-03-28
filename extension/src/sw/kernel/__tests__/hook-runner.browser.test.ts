import "./test-setup";

import { describe, expect, it, vi } from "vitest";
import { HookRunner } from "../hook-runner";

type TestHookMap = {
  "compaction.summary": {
    summary: string;
  };
};

describe("hook-runner", () => {
  it("replaces an existing hook registration when the same id is reused", async () => {
    const runner = new HookRunner<TestHookMap>();
    const first = vi.fn(() => ({
      action: "patch" as const,
      patch: { summary: "first" },
    }));
    const second = vi.fn(() => ({
      action: "patch" as const,
      patch: { summary: "second" },
    }));

    runner.on("compaction.summary", first, {
      id: "runtime-loop.compaction.summary",
      priority: 100,
    });
    runner.on("compaction.summary", second, {
      id: "runtime-loop.compaction.summary",
      priority: 100,
    });

    const result = await runner.run("compaction.summary", {
      summary: "",
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(result.blocked).toBe(false);
    expect(result.patchCount).toBe(1);
    expect(result.value.summary).toBe("second");
  });

  it("old unregister closures do not remove the replacement handler", async () => {
    const runner = new HookRunner<TestHookMap>();
    const first = vi.fn(() => ({
      action: "patch" as const,
      patch: { summary: "first" },
    }));
    const second = vi.fn(() => ({
      action: "patch" as const,
      patch: { summary: "second" },
    }));

    const unregisterFirst = runner.on("compaction.summary", first, {
      id: "runtime-loop.compaction.summary",
      priority: 100,
    });
    runner.on("compaction.summary", second, {
      id: "runtime-loop.compaction.summary",
      priority: 100,
    });

    unregisterFirst();

    const result = await runner.run("compaction.summary", {
      summary: "",
    });

    expect(second).toHaveBeenCalledOnce();
    expect(result.value.summary).toBe("second");
  });
});
