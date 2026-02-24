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

function readConversationMessages(response: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = (response.data || {}) as Record<string, unknown>;
  const conversationView = (data.conversationView || {}) as Record<string, unknown>;
  const rawMessages = conversationView.messages;
  return Array.isArray(rawMessages) ? (rawMessages as Array<Record<string, unknown>>) : [];
}

async function waitForLoopDone(sessionId: string, timeoutMs = 2500): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await invokeRuntime({
      type: "brain.step.stream",
      sessionId
    });
    const stream = Array.isArray((out.data as Record<string, unknown>)?.stream)
      ? (((out.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
      : [];
    if (stream.some((event) => String(event.type || "") === "loop_done")) {
      return stream;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitForLoopDone timeout: ${sessionId}`);
}

describe("runtime-router.browser", () => {
  beforeEach(() => {
    runtimeListeners = [];
    resetRuntimeOnMessageMock();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports fork session and exposes forkedFrom metadata in list/view", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请总结这段文本"
    });
    expect(started.ok).toBe(true);
    const sourceSessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sourceSessionId).not.toBe("");

    const userEntry = await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "这是第二个问题"
    });
    const assistantEntry = await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "这是第二个回答"
    });

    const forked = await invokeRuntime({
      type: "brain.session.fork",
      sessionId: sourceSessionId,
      leafId: userEntry.id,
      sourceEntryId: assistantEntry.id,
      reason: "branch_from_assistant"
    });
    expect(forked.ok).toBe(true);
    const forkedSessionId = String(((forked.data as Record<string, unknown>) || {}).sessionId || "");
    expect(forkedSessionId).not.toBe("");
    expect(forkedSessionId).not.toBe(sourceSessionId);

    const listed = await invokeRuntime({ type: "brain.session.list" });
    expect(listed.ok).toBe(true);
    const sessions = Array.isArray((listed.data as Record<string, unknown>)?.sessions)
      ? (((listed.data as Record<string, unknown>).sessions as unknown[]) as Array<Record<string, unknown>>)
      : [];
    const forkMeta = sessions.find((item) => String(item.id || "") === forkedSessionId);
    expect(forkMeta).toBeDefined();
    expect(String(forkMeta?.parentSessionId || "")).toBe(sourceSessionId);
    const forkedFrom = (forkMeta?.forkedFrom || {}) as Record<string, unknown>;
    expect(String(forkedFrom.sessionId || "")).toBe(sourceSessionId);
    expect(String(forkedFrom.leafId || "")).toBe(userEntry.id);
    expect(String(forkedFrom.sourceEntryId || "")).toBe(assistantEntry.id);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId: forkedSessionId
    });
    expect(viewed.ok).toBe(true);
    const conversationView = ((viewed.data as Record<string, unknown>) || {}).conversationView as Record<string, unknown>;
    expect(String(conversationView.parentSessionId || "")).toBe(sourceSessionId);
    const viewForkedFrom = (conversationView.forkedFrom || {}) as Record<string, unknown>;
    expect(String(viewForkedFrom.sessionId || "")).toBe(sourceSessionId);
  });

  it("supports regenerate and emits input.regenerate stream event", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "初始问题"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const assistantEntry = await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "初始回答"
    });

    const regenerated = await invokeRuntime({
      type: "brain.run.regenerate",
      sessionId,
      sourceEntryId: assistantEntry.id,
      requireSourceIsLeaf: true,
      rebaseLeafToPreviousUser: true
    });
    expect(regenerated.ok).toBe(true);

    const streamOut = await invokeRuntime({
      type: "brain.step.stream",
      sessionId
    });
    expect(streamOut.ok).toBe(true);
    const stream = Array.isArray((streamOut.data as Record<string, unknown>)?.stream)
      ? (((streamOut.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
      : [];
    expect(stream.some((item) => String(item.type || "") === "input.regenerate")).toBe(true);

    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "后续回答"
    });

    const invalid = await invokeRuntime({
      type: "brain.run.regenerate",
      sessionId,
      sourceEntryId: assistantEntry.id,
      requireSourceIsLeaf: true
    });
    expect(invalid.ok).toBe(false);
    expect(String(invalid.error || "")).toContain("仅最后一条 assistant");
  });

  it("supports edit_rerun for latest user in current session", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "原始问题"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const viewBefore = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewBefore.ok).toBe(true);
    const beforeMessages = readConversationMessages(viewBefore);
    const latestUserBefore = [...beforeMessages]
      .reverse()
      .find((entry) => String(entry.role || "") === "user" && String(entry.entryId || "").trim());
    expect(latestUserBefore).toBeDefined();
    const latestUserEntryId = String(latestUserBefore?.entryId || "");
    expect(latestUserEntryId).not.toBe("");

    const edited = await invokeRuntime({
      type: "brain.run.edit_rerun",
      sessionId,
      sourceEntryId: latestUserEntryId,
      prompt: "编辑后的问题"
    });
    expect(edited.ok).toBe(true);
    const editedData = (edited.data || {}) as Record<string, unknown>;
    expect(String(editedData.mode || "")).toBe("retry");
    expect(String(editedData.sessionId || "")).toBe(sessionId);

    const streamOut = await invokeRuntime({
      type: "brain.step.stream",
      sessionId
    });
    expect(streamOut.ok).toBe(true);
    const stream = Array.isArray((streamOut.data as Record<string, unknown>)?.stream)
      ? (((streamOut.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
      : [];
    const editRegenerateEvent = stream.find(
      (item) =>
        String(item.type || "") === "input.regenerate" &&
        String((item.payload as Record<string, unknown> | undefined)?.reason || "") === "edit_user_rerun"
    );
    expect(editRegenerateEvent).toBeDefined();

    const viewAfter = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewAfter.ok).toBe(true);
    const afterMessages = readConversationMessages(viewAfter);
    const latestUserAfter = [...afterMessages]
      .reverse()
      .find((entry) => String(entry.role || "") === "user" && String(entry.entryId || "").trim());
    expect(String(latestUserAfter?.content || "")).toBe("编辑后的问题");
  });

  it("supports edit_rerun for historical user by forking", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "问题一"
    });
    expect(started.ok).toBe(true);
    const sourceSessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sourceSessionId).not.toBe("");

    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "回答一"
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "问题二"
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "回答二"
    });

    const sourceView = await invokeRuntime({
      type: "brain.session.view",
      sessionId: sourceSessionId
    });
    expect(sourceView.ok).toBe(true);
    const sourceMessages = readConversationMessages(sourceView);
    const historicalUser = sourceMessages.find(
      (entry) => String(entry.role || "") === "user" && String(entry.content || "") === "问题一"
    );
    expect(historicalUser).toBeDefined();
    const historicalUserEntryId = String(historicalUser?.entryId || "");
    expect(historicalUserEntryId).not.toBe("");

    const edited = await invokeRuntime({
      type: "brain.run.edit_rerun",
      sessionId: sourceSessionId,
      sourceEntryId: historicalUserEntryId,
      prompt: "问题一（编辑版）"
    });
    expect(edited.ok).toBe(true);
    const editedData = (edited.data || {}) as Record<string, unknown>;
    expect(String(editedData.mode || "")).toBe("fork");
    const forkedSessionId = String(editedData.sessionId || "");
    expect(forkedSessionId).not.toBe("");
    expect(forkedSessionId).not.toBe(sourceSessionId);

    const listed = await invokeRuntime({ type: "brain.session.list" });
    expect(listed.ok).toBe(true);
    const sessions = Array.isArray((listed.data as Record<string, unknown>)?.sessions)
      ? (((listed.data as Record<string, unknown>).sessions as unknown[]) as Array<Record<string, unknown>>)
      : [];
    const forkMeta = sessions.find((entry) => String(entry.id || "") === forkedSessionId);
    expect(forkMeta).toBeDefined();
    expect(String(forkMeta?.parentSessionId || "")).toBe(sourceSessionId);
    const forkedFrom = (forkMeta?.forkedFrom || {}) as Record<string, unknown>;
    expect(String(forkedFrom.sessionId || "")).toBe(sourceSessionId);
    expect(String(forkedFrom.leafId || "")).toBe(historicalUserEntryId);

    const forkView = await invokeRuntime({
      type: "brain.session.view",
      sessionId: forkedSessionId
    });
    expect(forkView.ok).toBe(true);
    const forkMessages = readConversationMessages(forkView);
    const firstUserFork = forkMessages.find((entry) => String(entry.role || "") === "user");
    expect(String(firstUserFork?.content || "")).toBe("问题一（编辑版）");

    const sourceViewAfter = await invokeRuntime({
      type: "brain.session.view",
      sessionId: sourceSessionId
    });
    expect(sourceViewAfter.ok).toBe(true);
    const sourceAfterMessages = readConversationMessages(sourceViewAfter);
    const firstUserSource = sourceAfterMessages.find((entry) => String(entry.role || "") === "user");
    expect(String(firstUserSource?.content || "")).toBe("问题一");
  });

  it("rejects edit_rerun when sourceEntry is not user message", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "原始问题"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const assistantEntry = await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "这是一条 assistant 消息"
    });

    const edited = await invokeRuntime({
      type: "brain.run.edit_rerun",
      sessionId,
      sourceEntryId: assistantEntry.id,
      prompt: "编辑后的问题"
    });
    expect(edited.ok).toBe(false);
    expect(String(edited.error || "")).toContain("sourceEntry 必须是 user 消息");
  });

  it("rejects edit_rerun when sourceEntry belongs to another session", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const first = await invokeRuntime({
      type: "brain.run.start",
      prompt: "session-a"
    });
    const second = await invokeRuntime({
      type: "brain.run.start",
      prompt: "session-b"
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const sessionA = String(((first.data as Record<string, unknown>) || {}).sessionId || "");
    const sessionB = String(((second.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionA).not.toBe("");
    expect(sessionB).not.toBe("");
    expect(sessionA).not.toBe(sessionB);

    const viewA = await invokeRuntime({
      type: "brain.session.view",
      sessionId: sessionA
    });
    expect(viewA.ok).toBe(true);
    const sourceFromA = readConversationMessages(viewA).find((entry) => String(entry.role || "") === "user");
    const sourceEntryId = String(sourceFromA?.entryId || "");
    expect(sourceEntryId).not.toBe("");

    const edited = await invokeRuntime({
      type: "brain.run.edit_rerun",
      sessionId: sessionB,
      sourceEntryId,
      prompt: "cross-session-edit"
    });
    expect(edited.ok).toBe(false);
    expect(String(edited.error || "")).toContain("sourceEntry 不存在");
  });

  it("service worker 重启后可恢复会话并继续同一 session 对话", async () => {
    const oldOrchestrator = new BrainOrchestrator();
    registerRuntimeRouter(oldOrchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed-user",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await oldOrchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "seed-assistant"
    });
    oldOrchestrator.setRunning(sessionId, true);

    // 模拟 service worker 重启：旧 listener 被销毁，重新注册新 listener。
    runtimeListeners = [];
    resetRuntimeOnMessageMock();
    const restartedOrchestrator = new BrainOrchestrator();
    registerRuntimeRouter(restartedOrchestrator);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    expect(messages.some((item) => String(item.content || "") === "seed-user")).toBe(true);
    expect(messages.some((item) => String(item.content || "") === "seed-assistant")).toBe(true);
    const conversationView = ((viewed.data as Record<string, unknown>) || {}).conversationView as Record<string, unknown>;
    const lastStatus = (conversationView.lastStatus || {}) as Record<string, unknown>;
    expect(Boolean(lastStatus.running)).toBe(false);

    const continued = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "after-restart-user",
      autoRun: false
    });
    expect(continued.ok).toBe(true);
    const continuedData = (continued.data || {}) as Record<string, unknown>;
    expect(String(continuedData.sessionId || "")).toBe(sessionId);
    const continuedRuntime = (continuedData.runtime || {}) as Record<string, unknown>;
    expect(Boolean(continuedRuntime.running)).toBe(false);

    const viewedAfterContinue = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewedAfterContinue.ok).toBe(true);
    const messagesAfterContinue = readConversationMessages(viewedAfterContinue);
    expect(messagesAfterContinue.some((item) => String(item.content || "") === "after-restart-user")).toBe(true);
  });

  it("supports capability provider in brain.step.execute", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.virtual-fs.router",
        name: "virtual-fs-router",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.virtual.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.virtual-fs.router.read",
            mode: "bridge",
            invoke: async (input) => ({
              provider: "virtual-fs-router",
              path: String(input.args?.path || "")
            })
          }
        }
      }
    });

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "capability provider test",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const executed = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "read_file",
      args: {
        path: "mem://docs.txt"
      },
      verifyPolicy: "off"
    });
    expect(executed.ok).toBe(true);
    const result = (executed.data || {}) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.modeUsed).toBe("bridge");
    expect(result.capabilityUsed).toBe("fs.virtual.read");
    expect(result.data).toEqual({
      provider: "virtual-fs-router",
      path: "mem://docs.txt"
    });
  });

  it("routes capability providers by canHandle in brain.step.execute", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.virtual-fs.multi-route",
        name: "virtual-fs-multi-route",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.virtual.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.virtual-fs.multi-route.workspace",
            mode: "bridge",
            priority: 20,
            canHandle: (input) => String(input.args?.targetUri || "").startsWith("workspace://"),
            invoke: async () => ({ provider: "workspace" })
          }
        }
      }
    });

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.virtual-fs.multi-route.local",
        name: "virtual-fs-multi-route-local",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.virtual.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.virtual-fs.multi-route.local",
            mode: "bridge",
            priority: 10,
            canHandle: (input) => String(input.args?.targetUri || "").startsWith("local://"),
            invoke: async () => ({ provider: "local" })
          }
        }
      }
    });

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "capability provider canHandle route test",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const workspace = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "read_file",
      args: {
        targetUri: "workspace://docs/a.md"
      },
      verifyPolicy: "off"
    });
    expect(workspace.ok).toBe(true);
    expect(((workspace.data || {}) as Record<string, unknown>).data).toEqual({ provider: "workspace" });

    const local = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "read_file",
      args: {
        targetUri: "local:///tmp/a.md"
      },
      verifyPolicy: "off"
    });
    expect(local.ok).toBe(true);
    expect(((local.data || {}) as Record<string, unknown>).data).toEqual({ provider: "local" });
  });

  it("returns runtime-not-ready when capability provider is missing", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "capability-missing-provider",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const executed = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "read_file",
      args: {
        path: "mem://missing.txt"
      },
      verifyPolicy: "off"
    });
    expect(executed.ok).toBe(true);
    const result = (executed.data || {}) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("E_RUNTIME_NOT_READY");
    expect(String(result.error || "")).toContain("capability provider 未就绪");
    expect(result.capabilityUsed).toBe("fs.virtual.read");
  });

  it("brain.step.execute 事件顺序严格为 step_execute -> step_execute_result（单次）", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.event-order",
        name: "event-order",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.virtual.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.event-order.read",
            mode: "bridge",
            invoke: async () => ({ ok: true, source: "event-order" })
          }
        }
      }
    });

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "event-order-seed",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const beforeStream = await invokeRuntime({
      type: "brain.step.stream",
      sessionId
    });
    expect(beforeStream.ok).toBe(true);
    const baseline = Array.isArray((beforeStream.data as Record<string, unknown>)?.stream)
      ? (((beforeStream.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
      : [];

    const executed = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "read_file",
      args: {
        path: "mem://ordered.txt"
      },
      verifyPolicy: "off"
    });
    expect(executed.ok).toBe(true);

    const afterStream = await invokeRuntime({
      type: "brain.step.stream",
      sessionId
    });
    expect(afterStream.ok).toBe(true);
    const fullStream = Array.isArray((afterStream.data as Record<string, unknown>)?.stream)
      ? (((afterStream.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
      : [];
    const delta = fullStream.slice(baseline.length);
    const stepDelta = delta.filter((entry) => {
      const type = String(entry.type || "");
      return type === "step_execute" || type === "step_execute_result";
    });

    expect(stepDelta).toHaveLength(2);
    expect(String(stepDelta[0].type || "")).toBe("step_execute");
    expect(String(stepDelta[1].type || "")).toBe("step_execute_result");
    expect(String((stepDelta[0].payload as Record<string, unknown> | undefined)?.capability || "")).toBe("fs.virtual.read");
    expect(String((stepDelta[1].payload as Record<string, unknown> | undefined)?.capabilityUsed || "")).toBe("fs.virtual.read");
  });

  it("brain.run.start 主链路会触发 llm.before_request 和 llm.after_response", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const timeline: string[] = [];
    let beforeCount = 0;
    let afterCount = 0;
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.llm.hook.timeline",
        name: "llm-hook-timeline",
        version: "1.0.0",
        permissions: {
          hooks: ["llm.before_request", "llm.after_response"]
        }
      },
      hooks: {
        "llm.before_request": () => {
          beforeCount += 1;
          timeline.push("before");
          return { action: "continue" };
        },
        "llm.after_response": () => {
          afterCount += 1;
          timeline.push("after");
          return { action: "continue" };
        }
      }
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      timeline.push("fetch");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "llm-hook-ok"
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
      prompt: "测试 llm hook 时序",
      sessionOptions: {
        title: "LLM Hook Timeline",
        metadata: {
          titleSource: "manual"
        }
      }
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
    expect(timeline).toEqual(["before", "fetch", "after"]);
    const eventTypes = stream.map((item) => String(item.type || ""));
    expect(eventTypes).toContain("llm.request");
    expect(eventTypes).toContain("llm.response.parsed");
  });

  it("llm.before_request patch 会改写真实请求 body", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    let capturedBody: Record<string, unknown> | null = null;
    let afterResponseContent = "";
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.llm.hook.patch",
        name: "llm-hook-patch",
        version: "1.0.0",
        permissions: {
          hooks: ["llm.before_request", "llm.after_response"]
        }
      },
      hooks: {
        "llm.before_request": (event) => {
          const request = (event.request || {}) as Record<string, unknown>;
          const payload = ((request.payload || {}) as Record<string, unknown>) || {};
          return {
            action: "patch",
            patch: {
              request: {
                ...request,
                payload: {
                  ...payload,
                  temperature: 0.91
                }
              }
            }
          };
        },
        "llm.after_response": (event) => {
          const response = (event.response || {}) as Record<string, unknown>;
          afterResponseContent = String(response.content || "");
          return { action: "continue" };
        }
      }
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const bodyText = String(init?.body || "");
      capturedBody = (JSON.parse(bodyText || "{}") || {}) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "llm-hook-patch-ok"
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
      prompt: "测试 llm hook patch",
      sessionOptions: {
        title: "LLM Hook Patch",
        metadata: {
          titleSource: "manual"
        }
      }
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capturedBody).toBeTruthy();
    expect(capturedBody?.temperature).toBe(0.91);
    expect(afterResponseContent).toBe("llm-hook-patch-ok");
  });

  it("brain.run.start 的 LLM tools 来自 tool contract registry", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerToolContract(
      {
        name: "workspace_ls",
        description: "List workspace files",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: []
        }
      },
      { replace: true }
    );

    let capturedTools: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const bodyText = String(init?.body || "");
      const body = (JSON.parse(bodyText || "{}") || {}) as Record<string, unknown>;
      capturedTools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "registry-tools-ok"
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
      prompt: "测试 tool contract registry",
      sessionOptions: {
        title: "Tool Contract Registry",
        metadata: {
          titleSource: "manual"
        }
      }
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const toolNames = capturedTools
      .map((item) => (item.function as Record<string, unknown> | undefined)?.name)
      .map((name) => String(name || ""));
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("bash");
    expect(toolNames).not.toContain("workspace_ls");
  });

  it("supports brain.debug.plugins view", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.debug.view",
        name: "debug-view",
        version: "1.0.0",
        permissions: {
          hooks: ["tool.before_call"],
          capabilities: ["fs.virtual.read", "browser.action"]
        }
      },
      hooks: {
        "tool.before_call": () => ({ action: "continue" })
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.debug.view.read",
            mode: "bridge",
            invoke: async () => ({ ok: true })
          }
        }
      },
      policies: {
        capabilities: {
          "browser.action": {
            defaultVerifyPolicy: "always",
            leasePolicy: "required"
          }
        }
      }
    });

    const out = await invokeRuntime({
      type: "brain.debug.plugins"
    });
    expect(out.ok).toBe(true);
    const data = (out.data || {}) as Record<string, unknown>;
    const plugins = Array.isArray(data.plugins) ? (data.plugins as Array<Record<string, unknown>>) : [];
    const capabilities = Array.isArray(data.capabilityProviders)
      ? (data.capabilityProviders as Array<Record<string, unknown>>)
      : [];
    const toolContracts = Array.isArray(data.toolContracts) ? (data.toolContracts as Array<Record<string, unknown>>) : [];
    const policies = Array.isArray(data.capabilityPolicies) ? (data.capabilityPolicies as Array<Record<string, unknown>>) : [];
    const plugin = plugins.find((item) => String(item.id || "") === "plugin.debug.view");
    expect(plugin).toBeDefined();
    expect(Boolean(plugin?.enabled)).toBe(true);
    expect(toolContracts.some((item) => String(item.name || "") === "bash")).toBe(true);
    expect(capabilities.some((item) => String(item.capability || "") === "fs.virtual.read")).toBe(true);
    expect(policies.some((item) => String(item.capability || "") === "browser.action")).toBe(true);
  });

  it("supports title refresh + delete + debug config/dump", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        bridgeUrl: "ws://127.0.0.1:17777/ws",
        bridgeToken: "token-demo",
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "sk-demo",
        llmModel: "gpt-test",
        bridgeInvokeTimeoutMs: 180000,
        llmTimeoutMs: 160000,
        llmRetryMaxAttempts: 3,
        llmMaxRetryDelayMs: 45000
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请帮我规划周末行程"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "好的，这是周末规划建议"
    });

    const refreshed = await invokeRuntime({
      type: "brain.session.title.refresh",
      sessionId,
      force: true
    });
    expect(refreshed.ok).toBe(true);
    const refreshedData = (refreshed.data || {}) as Record<string, unknown>;
    expect(String(refreshedData.title || "").length).toBeGreaterThan(0);

    const renamed = await invokeRuntime({
      type: "brain.session.title.refresh",
      sessionId,
      title: "我自定义的标题"
    });
    expect(renamed.ok).toBe(true);
    const renamedData = (renamed.data || {}) as Record<string, unknown>;
    expect(String(renamedData.title || "")).toBe("我自定义的标题");

    const refreshedAfterRename = await invokeRuntime({
      type: "brain.session.title.refresh",
      sessionId
    });
    expect(refreshedAfterRename.ok).toBe(true);
    const refreshedAfterRenameData = (refreshedAfterRename.data || {}) as Record<string, unknown>;
    expect(String(refreshedAfterRenameData.title || "")).toBe("我自定义的标题");

    const debugCfg = await invokeRuntime({
      type: "brain.debug.config"
    });
    expect(debugCfg.ok).toBe(true);
    const debugCfgData = (debugCfg.data || {}) as Record<string, unknown>;
    expect(debugCfgData.bridgeUrl).toBe("ws://127.0.0.1:17777/ws");
    expect(debugCfgData.hasLlmApiKey).toBe(true);
    expect(debugCfgData.bridgeInvokeTimeoutMs).toBe(180000);
    expect(debugCfgData.llmTimeoutMs).toBe(160000);
    expect(debugCfgData.llmRetryMaxAttempts).toBe(3);
    expect(debugCfgData.llmMaxRetryDelayMs).toBe(45000);
    expect(debugCfgData.llmApiKey).toBeUndefined();

    const dumped = await invokeRuntime({
      type: "brain.debug.dump",
      sessionId
    });
    expect(dumped.ok).toBe(true);
    const dumpData = (dumped.data || {}) as Record<string, unknown>;
    expect(String((dumpData.runtime as Record<string, unknown>)?.sessionId || "")).toBe(sessionId);
    expect(Number(dumpData.entryCount || 0)).toBeGreaterThan(0);

    const deleted = await invokeRuntime({
      type: "brain.session.delete",
      sessionId
    });
    expect(deleted.ok).toBe(true);
    const deletedData = (deleted.data || {}) as Record<string, unknown>;
    expect(deletedData.deleted).toBe(true);

    const listed = await invokeRuntime({ type: "brain.session.list" });
    expect(listed.ok).toBe(true);
    const sessions = Array.isArray((listed.data as Record<string, unknown>)?.sessions)
      ? (((listed.data as Record<string, unknown>).sessions as unknown[]) as Array<Record<string, unknown>>)
      : [];
    expect(sessions.some((item) => String(item.id || "") === sessionId)).toBe(false);
  });
});
