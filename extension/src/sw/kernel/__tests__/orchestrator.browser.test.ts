import "./test-setup";

import { describe, expect, it } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";

async function waitForTraceEvent(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  eventType: string,
  timeoutMs = 1000
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const trace = (await orchestrator.getStepStream(sessionId)) as Array<{ type: string; [key: string]: unknown }>;
    if (trace.some((record) => record.type === eventType)) {
      return trace;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitForTraceEvent timeout: ${eventType}`);
}

describe("orchestrator.browser", () => {
  it("retryable 错误先触发 auto_retry_start", async () => {
    const orchestrator = new BrainOrchestrator({ retryMaxAttempts: 2, retryBaseDelayMs: 10, retryCapDelayMs: 20 });
    const events: string[] = [];
    orchestrator.events.subscribe((event) => {
      events.push(event.type);
    });

    const created = await orchestrator.createSession({ title: "retry-case" });
    const decision = await orchestrator.handleAgentEnd({
      sessionId: created.sessionId,
      error: { message: "network timeout", code: "ETIMEDOUT" },
      overflow: false
    });

    expect(decision.action).toBe("retry");
    expect(events.includes("auto_retry_start")).toBe(true);
  });

  it("overflow 不走 retry，走 compaction", async () => {
    const orchestrator = new BrainOrchestrator({ thresholdTokens: 1 });
    const events: string[] = [];
    orchestrator.events.subscribe((event) => {
      events.push(event.type);
    });

    const created = await orchestrator.createSession({ title: "overflow-case" });
    await orchestrator.appendUserMessage(created.sessionId, "hello");

    const decision = await orchestrator.handleAgentEnd({
      sessionId: created.sessionId,
      error: { message: "context length exceeded", code: "OVERFLOW" },
      overflow: true
    });

    expect(decision.action).toBe("continue");
    expect(events).toContain("auto_compaction_start");
    expect(events).toContain("session_compact");
    expect(events).toContain("auto_compaction_end");
  });

  it("重启后保留会话与 trace，但运行态不会自动恢复", async () => {
    const oldOrchestrator = new BrainOrchestrator();
    const created = await oldOrchestrator.createSession({ title: "restart-recovery" });
    const sessionId = created.sessionId;

    await oldOrchestrator.appendUserMessage(sessionId, "重启前用户消息");
    oldOrchestrator.setRunning(sessionId, true);
    oldOrchestrator.events.emit("loop_start", sessionId, {
      prompt: "重启前进行中的任务"
    });

    const restoredOrchestrator = new BrainOrchestrator();
    const restoredEntries = await restoredOrchestrator.sessions.getEntries(sessionId);
    expect(
      restoredEntries.some((entry) => {
        if (entry.type !== "message") return false;
        return String(entry.text || "") === "重启前用户消息";
      })
    ).toBe(true);

    const restoredRunState = restoredOrchestrator.getRunState(sessionId);
    expect(restoredRunState.running).toBe(false);

    const restoredTrace = await waitForTraceEvent(restoredOrchestrator, sessionId, "loop_start");
    expect(restoredTrace.some((record) => record.type === "loop_start")).toBe(true);
  });

  it("script 成功时不走 fallback", async () => {
    const orchestrator = new BrainOrchestrator();
    orchestrator.registerToolProvider(
      "script",
      {
        id: "test.script.success",
        invoke: async () => ({ ok: true, source: "script" })
      },
      { replace: true }
    );
    const created = await orchestrator.createSession({ title: "script-success" });

    const result = await orchestrator.executeStep({
      sessionId: created.sessionId,
      mode: "script",
      action: "click",
      args: { ref: "a1" }
    });

    expect(result.ok).toBe(true);
    expect(result.modeUsed).toBe("script");
    expect(result.fallbackFrom).toBeUndefined();
    expect(result.data).toEqual({ ok: true, source: "script" });
  });

  it("script 失败后降级到 cdp", async () => {
    const orchestrator = new BrainOrchestrator();
    orchestrator.registerToolProvider(
      "script",
      {
        id: "test.script.fail",
        invoke: async () => {
          throw new Error("script-failed");
        }
      },
      { replace: true }
    );
    orchestrator.registerToolProvider(
      "cdp",
      {
        id: "test.cdp.fallback",
        invoke: async () => ({ ok: true, source: "cdp" })
      },
      { replace: true }
    );
    const created = await orchestrator.createSession({ title: "script-fallback" });

    const result = await orchestrator.executeStep({
      sessionId: created.sessionId,
      mode: "script",
      action: "click",
      args: { ref: "a1" }
    });

    expect(result.ok).toBe(true);
    expect(result.modeUsed).toBe("cdp");
    expect(result.fallbackFrom).toBe("script");
    expect(result.data).toEqual({ ok: true, source: "cdp" });
  });

  it("cdp 失败时直接返回失败", async () => {
    const orchestrator = new BrainOrchestrator();
    orchestrator.registerToolProvider(
      "cdp",
      {
        id: "test.cdp.fail",
        invoke: async () => {
          throw new Error("cdp-failed");
        }
      },
      { replace: true }
    );
    const created = await orchestrator.createSession({ title: "cdp-failed" });

    const result = await orchestrator.executeStep({
      sessionId: created.sessionId,
      mode: "cdp",
      action: "click",
      args: { ref: "a1" }
    });

    expect(result.ok).toBe(false);
    expect(result.modeUsed).toBe("cdp");
    expect(result.verified).toBe(false);
    expect(result.error).toContain("cdp-failed");
  });

  it("script 失败且无 cdp provider 时保持抛错语义", async () => {
    const orchestrator = new BrainOrchestrator();
    orchestrator.registerToolProvider(
      "script",
      {
        id: "test.script.only",
        invoke: async () => {
          throw new Error("script-failed");
        }
      },
      { replace: true }
    );
    const created = await orchestrator.createSession({ title: "missing-cdp-provider" });

    await expect(
      orchestrator.executeStep({
        sessionId: created.sessionId,
        mode: "script",
        action: "click",
        args: { ref: "a1" }
      })
    ).rejects.toThrow("cdp adapter 未配置");
  });

  it("tool.before_call hook 可阻断执行", async () => {
    let called = false;
    const orchestrator = new BrainOrchestrator();
    orchestrator.registerToolProvider(
      "script",
      {
        id: "test.script.hook.block",
        invoke: async () => {
          called = true;
          return { ok: true };
        }
      },
      { replace: true }
    );
    const created = await orchestrator.createSession({ title: "hook-block" });
    orchestrator.onHook("tool.before_call", () => ({ action: "block", reason: "policy-deny" }));

    const result = await orchestrator.executeStep({
      sessionId: created.sessionId,
      mode: "script",
      action: "click"
    });

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("policy-deny");
  });

  it("tool.after_result hook 可改写结果", async () => {
    const orchestrator = new BrainOrchestrator();
    orchestrator.registerToolProvider(
      "script",
      {
        id: "test.script.hook.patch",
        invoke: async () => ({ value: 1 })
      },
      { replace: true }
    );
    const created = await orchestrator.createSession({ title: "hook-patch" });
    orchestrator.onHook("tool.after_result", () => ({
      action: "patch",
      patch: { result: { value: 2, patched: true } }
    }));

    const result = await orchestrator.executeStep({
      sessionId: created.sessionId,
      mode: "script",
      action: "click"
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ value: 2, patched: true });
  });

  it("compaction.check.before 可阻断 preSendCompactionCheck", async () => {
    const orchestrator = new BrainOrchestrator({ thresholdTokens: 1 });
    const created = await orchestrator.createSession({ title: "compaction-check-block" });
    await orchestrator.appendUserMessage(created.sessionId, "hello");
    orchestrator.onHook("compaction.check.before", (payload) => {
      if (payload.source === "pre_send") {
        return { action: "block", reason: "manual-stop" };
      }
      return { action: "continue" };
    });

    const compacted = await orchestrator.preSendCompactionCheck(created.sessionId);

    expect(compacted).toBe(false);
  });

  it("agent_end.after 可改写最终决策", async () => {
    const orchestrator = new BrainOrchestrator({ thresholdTokens: 1 });
    const created = await orchestrator.createSession({ title: "agent-end-after-patch" });
    await orchestrator.appendUserMessage(created.sessionId, "hello");
    orchestrator.onHook("agent_end.after", () => ({
      action: "patch",
      patch: {
        decision: {
          action: "done" as const,
          reason: "patched_by_hook",
          sessionId: created.sessionId
        }
      }
    }));

    const decision = await orchestrator.handleAgentEnd({
      sessionId: created.sessionId,
      error: null,
      overflow: true
    });

    expect(decision.action).toBe("done");
    expect(decision.reason).toBe("patched_by_hook");
  });
});
