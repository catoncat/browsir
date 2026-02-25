import "./test-setup";

import { describe, expect, it } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";

function mockCompactionSummary(orchestrator: BrainOrchestrator, summary = "mock-compaction-summary"): void {
  orchestrator.onHook("compaction.summary", () => ({
    action: "patch",
    patch: { summary }
  }));
}

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
    mockCompactionSummary(orchestrator);
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

  it("冷启动读取 step stream 时不重复放大 trace 记录", async () => {
    const first = new BrainOrchestrator();
    const created = await first.createSession({ title: "trace-no-duplication" });
    const sessionId = created.sessionId;

    first.events.emit("loop_start", sessionId, { prompt: "trace check" });
    first.events.emit("llm.request", sessionId, { step: 1, model: "gpt-test", messageCount: 1 });
    first.events.emit("loop_done", sessionId, { status: "done", llmSteps: 1, toolSteps: 0 });

    await waitForTraceEvent(first, sessionId, "loop_done");

    const restored = new BrainOrchestrator();
    const trace = await waitForTraceEvent(restored, sessionId, "loop_done");
    const typeCounts = trace.reduce<Record<string, number>>((acc, item) => {
      const key = String(item.type || "unknown");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    expect(typeCounts.loop_start).toBe(1);
    expect(typeCounts["llm.request"]).toBe(1);
    expect(typeCounts.loop_done).toBe(1);
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
    mockCompactionSummary(orchestrator);
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
