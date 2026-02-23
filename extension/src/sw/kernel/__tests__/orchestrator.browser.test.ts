import "./test-setup";

import { describe, expect, it } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";

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
});
