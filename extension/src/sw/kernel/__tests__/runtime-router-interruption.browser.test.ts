import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
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
});
