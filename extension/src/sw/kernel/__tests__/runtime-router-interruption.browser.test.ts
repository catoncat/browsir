import "./test-setup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";
import { registerRuntimeRouter } from "../runtime-router";

type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean | void;

let runtimeListeners: RuntimeListener[] = [];

function resetRuntimeOnMessageMock(): void {
  const onMessage = chrome.runtime.onMessage as unknown as {
    addListener: (cb: RuntimeListener) => void;
    removeListener: (cb: RuntimeListener) => void;
    hasListener: (cb: RuntimeListener) => boolean;
  };
  onMessage.addListener = (cb) => {
    runtimeListeners.push(cb);
  };
  onMessage.removeListener = (cb) => {
    runtimeListeners = runtimeListeners.filter((item) => item !== cb);
  };
  onMessage.hasListener = (cb) => runtimeListeners.includes(cb);
}

function invokeRuntime(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!runtimeListeners.length) {
      reject(new Error("runtime listener not registered"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`runtime response timeout: ${String(message.type || "")}`));
    }, 2500);

    try {
      for (const listener of runtimeListeners) {
        listener(message, {}, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve((response || {}) as Record<string, unknown>);
        });
        if (settled) break;
      }
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

describe("runtime-router interruption boundary", () => {
  beforeEach(() => {
    runtimeListeners = [];
    resetRuntimeOnMessageMock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("user stop should not be treated as implicit interruption recovery", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stopped = await invokeRuntime({
      type: "brain.run.stop",
      sessionId
    });
    expect(stopped.ok).toBe(true);
    const stopRuntime = (stopped.data || {}) as Record<string, unknown>;
    expect(Boolean(stopRuntime.stopped)).toBe(true);

    const noAutoRun = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "after-stop-no-auto",
      autoRun: false
    });
    expect(noAutoRun.ok).toBe(true);
    const noAutoRuntime = ((noAutoRun.data as Record<string, unknown>)?.runtime || {}) as Record<string, unknown>;
    expect(Boolean(noAutoRuntime.stopped)).toBe(true);

    const autoRun = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "after-stop-auto",
      autoRun: true
    });
    expect(autoRun.ok).toBe(true);
    const autoRuntime = ((autoRun.data as Record<string, unknown>)?.runtime || {}) as Record<string, unknown>;
    expect(Boolean(autoRuntime.stopped)).toBe(false);
  });

  it("stop 后若仍在收尾中，不应被新的 start 提前重启", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    // 模拟「仍在执行中的 run」：此时 stop 应仅标记 stopped，不应立即把 running 置 false。
    orchestrator.setRunning(sessionId, true);

    const stopped = await invokeRuntime({
      type: "brain.run.stop",
      sessionId
    });
    expect(stopped.ok).toBe(true);
    const stopRuntime = (stopped.data || {}) as Record<string, unknown>;
    expect(Boolean(stopRuntime.stopped)).toBe(true);
    expect(Boolean(stopRuntime.running)).toBe(true);

    const restartDuringStopping = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "start-while-stopping",
      autoRun: true,
      streamingBehavior: "followUp"
    });
    expect(restartDuringStopping.ok).toBe(true);
    const restartRuntime = ((restartDuringStopping.data as Record<string, unknown>)?.runtime || {}) as Record<string, unknown>;
    expect(Boolean(restartRuntime.running)).toBe(true);
    expect(Boolean(restartRuntime.stopped)).toBe(true);

  });

  it("stop 夹在 setRunning 与 runAgentLoop 之间时应复位 running", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const originalSetRunning = orchestrator.setRunning.bind(orchestrator);
    vi.spyOn(orchestrator, "setRunning").mockImplementation((sessionId: string, running: boolean) => {
      originalSetRunning(sessionId, running);
      if (running) {
        orchestrator.stop(sessionId);
      }
    });

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "race-stop-before-loop"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const deadline = Date.now() + 3000;
    let sawLoopSkip = false;
    while (Date.now() < deadline) {
      const out = await invokeRuntime({
        type: "brain.step.stream",
        sessionId
      });
      const stream = Array.isArray((out.data as Record<string, unknown>)?.stream)
        ? (((out.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
        : [];
      sawLoopSkip = stream.some((event) => String(event.type || "") === "loop_skip_stopped");
      if (sawLoopSkip) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(sawLoopSkip).toBe(true);

    const view = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(view.ok).toBe(true);
    const runtime = ((((view.data as Record<string, unknown>) || {}).conversationView as Record<string, unknown>)
      ?.lastStatus || {}) as Record<string, unknown>;
    expect(Boolean(runtime.stopped)).toBe(true);
    expect(Boolean(runtime.running)).toBe(false);
  });

  it("pre_send compaction 检查不应阻塞 brain.run.start 返回", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const artificialDelayMs = 320;
    orchestrator.onHook("compaction.check.before", async (payload) => {
      if (payload.source !== "pre_send") {
        return { action: "continue" };
      }
      await new Promise((resolve) => setTimeout(resolve, artificialDelayMs));
      return { action: "continue" };
    });

    const startedAt = Date.now();
    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "slow-pre-send-compaction"
    });
    const elapsedMs = Date.now() - startedAt;

    expect(started.ok).toBe(true);
    const runtime = ((started.data as Record<string, unknown>)?.runtime || {}) as Record<string, unknown>;
    expect(Boolean(runtime.running)).toBe(true);
    expect(elapsedMs).toBeLessThan(artificialDelayMs);
  });

  it("running 时普通 prompt 必须显式声明 streamingBehavior", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    orchestrator.setRunning(sessionId, true);
    const missingBehavior = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "no-behavior"
    });
    expect(missingBehavior.ok).toBe(false);
    expect(String(missingBehavior.error || "")).toContain("streamingBehavior");
  });

  it("running 时 steer/followUp 入队，并在 stop 时清空队列", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    orchestrator.setRunning(sessionId, true);

    const steered = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "steer-a",
      streamingBehavior: "steer"
    });
    expect(steered.ok).toBe(true);
    const steerRuntime = ((steered.data as Record<string, unknown>)?.runtime || {}) as Record<string, unknown>;
    const steerQueue = (steerRuntime.queue || {}) as Record<string, unknown>;
    expect(Number(steerQueue.steer || 0)).toBe(1);
    expect(Number(steerQueue.total || 0)).toBe(1);

    const followUp = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "follow-b",
      streamingBehavior: "followUp"
    });
    expect(followUp.ok).toBe(true);
    const followRuntime = ((followUp.data as Record<string, unknown>)?.runtime || {}) as Record<string, unknown>;
    const followQueue = (followRuntime.queue || {}) as Record<string, unknown>;
    expect(Number(followQueue.followUp || 0)).toBe(1);
    expect(Number(followQueue.total || 0)).toBe(2);

    const stopResult = await invokeRuntime({
      type: "brain.run.stop",
      sessionId
    });
    expect(stopResult.ok).toBe(true);
    const stopQueue = ((stopResult.data as Record<string, unknown>)?.queue || {}) as Record<string, unknown>;
    expect(Number(stopQueue.total || 0)).toBe(0);
  });

  it("显式 brain.run.steer / brain.run.follow_up 与 start+streamingBehavior 等价", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    orchestrator.setRunning(sessionId, true);

    const steer = await invokeRuntime({
      type: "brain.run.steer",
      sessionId,
      prompt: "steer-x"
    });
    expect(steer.ok).toBe(true);
    const steerQueue = (((steer.data as Record<string, unknown>)?.runtime as Record<string, unknown>)?.queue ||
      {}) as Record<string, unknown>;
    expect(Number(steerQueue.steer || 0)).toBe(1);

    const follow = await invokeRuntime({
      type: "brain.run.follow_up",
      sessionId,
      prompt: "follow-y"
    });
    expect(follow.ok).toBe(true);
    const followQueue = (((follow.data as Record<string, unknown>)?.runtime as Record<string, unknown>)?.queue ||
      {}) as Record<string, unknown>;
    expect(Number(followQueue.followUp || 0)).toBe(1);
  });

  it("running 时可把 followUp 队列项直接插入为 steer", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    orchestrator.setRunning(sessionId, true);

    const queued = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "follow-insert",
      streamingBehavior: "followUp"
    });
    expect(queued.ok).toBe(true);
    const queuedRuntime = ((queued.data as Record<string, unknown>)?.runtime || {}) as Record<string, unknown>;
    const queuedQueue = (queuedRuntime.queue || {}) as Record<string, unknown>;
    const queuedItems = Array.isArray(queuedQueue.items)
      ? (queuedQueue.items as Array<Record<string, unknown>>)
      : [];
    const queuedPromptId = String((queuedItems[0] || {}).id || "");
    expect(queuedPromptId).not.toBe("");
    expect(Number(queuedQueue.followUp || 0)).toBe(1);

    const promoted = await invokeRuntime({
      type: "brain.run.queue.promote",
      sessionId,
      queuedPromptId
    });
    expect(promoted.ok).toBe(true);
    const promotedRuntime = (promoted.data || {}) as Record<string, unknown>;
    const promotedQueue = (promotedRuntime.queue || {}) as Record<string, unknown>;
    expect(Number(promotedQueue.followUp || 0)).toBe(0);
    expect(Number(promotedQueue.steer || 0)).toBe(1);
    const promotedItems = Array.isArray(promotedQueue.items)
      ? (promotedQueue.items as Array<Record<string, unknown>>)
      : [];
    const promotedItem = promotedItems.find((item) => String(item.id || "") === queuedPromptId) || {};
    expect(String((promotedItem as Record<string, unknown>).behavior || "")).toBe("steer");
  });

  it("followUp 会在当前 loop_done 后自动启动下一轮", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    let fetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 70));
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `assistant-${fetchCount}`
              }
            }
          ]
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "sk-demo",
        llmModel: "gpt-test"
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "first-round"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const queued = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "second-round",
      streamingBehavior: "followUp"
    });
    expect(queued.ok).toBe(true);

    const deadline = Date.now() + 5000;
    let loopDoneCount = 0;
    while (Date.now() < deadline) {
      const out = await invokeRuntime({
        type: "brain.step.stream",
        sessionId
      });
      const stream = Array.isArray((out.data as Record<string, unknown>)?.stream)
        ? (((out.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
        : [];
      loopDoneCount = stream.filter((event) => String(event.type || "") === "loop_done").length;
      if (loopDoneCount >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(loopDoneCount).toBeGreaterThanOrEqual(2);
    expect(fetchCount).toBeGreaterThanOrEqual(2);

    const conversation = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(conversation.ok).toBe(true);
    const messages = ((((conversation.data as Record<string, unknown>) || {}).conversationView as Record<string, unknown>)
      ?.messages || []) as Array<Record<string, unknown>>;
    const hasFollowUpUser = messages.some(
      (item) => String(item.role || "") === "user" && String(item.content || "").includes("second-round")
    );
    expect(hasFollowUpUser).toBe(true);
  });
});
