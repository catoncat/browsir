import "./test-setup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compact, prepareCompaction } from "../compaction.browser";
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

async function waitForStreamEvent(
  sessionId: string,
  eventType: string,
  timeoutMs = 2500
): Promise<{ event: Record<string, unknown>; stream: Array<Record<string, unknown>> }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await invokeRuntime({
      type: "brain.step.stream",
      sessionId
    });
    const stream = Array.isArray((out.data as Record<string, unknown>)?.stream)
      ? (((out.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
      : [];
    const event = stream.find((item) => String(item.type || "") === eventType);
    if (event) {
      return { event, stream };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitForStreamEvent timeout: ${sessionId}:${eventType}`);
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

  it("fork 后应保留 compaction 上下文供 LLM 使用，但 conversation view 不应出现摘要消息", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const sourceMeta = await orchestrator.sessions.createSession({ title: "compaction-fork-source" });
    const sourceSessionId = sourceMeta.header.id;

    const user1 = await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "Q1"
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "A1"
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "Q2"
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "A2"
    });

    const beforeCompaction = await orchestrator.sessions.buildSessionContext(sourceSessionId);
    const preparation = prepareCompaction({
      reason: "threshold",
      entries: beforeCompaction.entries,
      previousSummary: beforeCompaction.previousSummary,
      keepTail: 2,
      splitTurn: true
    });
    const draft = await compact(preparation, async () => "mock-compaction-summary");
    await orchestrator.sessions.appendCompaction(sourceSessionId, "threshold", draft);

    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "Q3"
    });
    const sourceLeafAssistant = await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "A3"
    });

    const sourceContextAtLeaf = await orchestrator.sessions.buildSessionContext(sourceSessionId, sourceLeafAssistant.id);
    expect(sourceContextAtLeaf.previousSummary.length).toBeGreaterThan(0);
    expect(sourceContextAtLeaf.messages.some((msg) => msg.role === "system")).toBe(false);

    const forked = await invokeRuntime({
      type: "brain.session.fork",
      sessionId: sourceSessionId,
      leafId: sourceLeafAssistant.id,
      sourceEntryId: user1.id,
      reason: "compaction-fork-regression"
    });
    expect(forked.ok).toBe(true);
    const forkedSessionId = String(((forked.data as Record<string, unknown>) || {}).sessionId || "");
    expect(forkedSessionId).not.toBe("");

    const forkContext = await orchestrator.sessions.buildSessionContext(forkedSessionId);
    expect(forkContext.previousSummary).toBe(sourceContextAtLeaf.previousSummary);
    expect(forkContext.messages.map((msg) => `${msg.role}:${msg.content}`)).toEqual(
      sourceContextAtLeaf.messages.map((msg) => `${msg.role}:${msg.content}`)
    );
    expect(forkContext.messages.some((msg) => msg.role === "system")).toBe(false);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId: forkedSessionId
    });
    expect(viewed.ok).toBe(true);
    const viewMessages = readConversationMessages(viewed);
    expect(viewMessages.some((item) => String(item.role || "") === "system")).toBe(false);
    expect(viewMessages.length).toBeGreaterThan(forkContext.messages.length);
    expect(viewMessages.some((item) => String(item.content || "") === "Q1")).toBe(true);
    expect(viewMessages.some((item) => String(item.content || "") === "A1")).toBe(true);
    const forkBranch = await orchestrator.sessions.getBranch(forkedSessionId);
    const expectedConversation = forkBranch
      .filter((entry) => entry.type === "message")
      .map((entry) => `${entry.role}:${entry.text}`);
    expect(viewMessages.map((item) => `${String(item.role || "")}:${String(item.content || "")}`)).toEqual(
      expectedConversation
    );
  });

  it("supports regenerate and emits input.regenerate stream event", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "初始问题",
      autoRun: false
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
      rebaseLeafToPreviousUser: true,
      autoRun: false
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

  it("supports brain.agent.run single and binds role/profile into route selection", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const capturedBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<string, unknown>;
      capturedBodies.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "agent-single-ok"
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
        llmModel: "gpt-legacy",
        llmDefaultProfile: "worker.basic",
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker"
          }
        ],
        llmProfileChains: {
          worker: ["worker.basic"]
        }
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.agent.run",
      mode: "single",
      agent: "worker",
      profile: "worker.basic",
      task: "请完成一次 single 子任务"
    });
    expect(started.ok).toBe(true);
    const startedData = (started.data || {}) as Record<string, unknown>;
    expect(String(startedData.mode || "")).toBe("single");
    const runSessionId = String(startedData.runSessionId || "");
    expect(runSessionId).not.toBe("");
    const result = (startedData.result || {}) as Record<string, unknown>;
    const sessionId = String(result.sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    const selected = stream.find((item) => String(item.type || "") === "llm.route.selected") as Record<string, unknown> | undefined;
    const selectedPayload = (selected?.payload || {}) as Record<string, unknown>;
    expect(String(selectedPayload.role || "")).toBe("worker");
    expect(String(selectedPayload.profile || "")).toBe("worker.basic");

    const runRequest = capturedBodies.find((body) => Array.isArray(body.tools) && body.stream === true);
    expect(runRequest).toBeDefined();
    expect(String(runRequest?.model || "")).toBe("gpt-worker-basic");

    const runDone = await waitForStreamEvent(runSessionId, "subagent.run.end", 5000);
    const runDonePayload = (runDone.event.payload || {}) as Record<string, unknown>;
    expect(String(runDonePayload.mode || "")).toBe("single");
    expect(String(runDonePayload.status || "")).toBe("done");
    expect(Number(runDonePayload.completedCount || 0)).toBe(1);
    const hasTaskStart = runDone.stream.some((item) => String(item.type || "") === "subagent.task.start");
    const hasTaskEnd = runDone.stream.some((item) => String(item.type || "") === "subagent.task.end");
    expect(hasTaskStart).toBe(true);
    expect(hasTaskEnd).toBe(true);
  });

  it("supports brain.agent.run parallel with per-task role/profile routing", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const runModels: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<string, unknown>;
      if (Array.isArray(body.tools) && body.stream === true) {
        runModels.push(String(body.model || ""));
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "agent-parallel-ok"
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
        llmModel: "gpt-legacy",
        llmDefaultProfile: "worker.basic",
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker"
          },
          {
            id: "reviewer.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-reviewer-basic",
            role: "reviewer"
          }
        ],
        llmProfileChains: {
          worker: ["worker.basic"],
          reviewer: ["reviewer.basic"]
        }
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.agent.run",
      mode: "parallel",
      tasks: [
        {
          agent: "worker",
          role: "worker",
          profile: "worker.basic",
          task: "子任务A"
        },
        {
          agent: "reviewer",
          role: "reviewer",
          profile: "reviewer.basic",
          task: "子任务B"
        }
      ]
    });
    expect(started.ok).toBe(true);
    const startedData = (started.data || {}) as Record<string, unknown>;
    expect(String(startedData.mode || "")).toBe("parallel");
    const runSessionId = String(startedData.runSessionId || "");
    expect(runSessionId).not.toBe("");
    const results = Array.isArray(startedData.results) ? (startedData.results as Array<Record<string, unknown>>) : [];
    expect(results.length).toBe(2);
    const sessionIds = results.map((item) => String(item.sessionId || ""));
    expect(sessionIds[0]).not.toBe("");
    expect(sessionIds[1]).not.toBe("");
    expect(sessionIds[0]).not.toBe(sessionIds[1]);

    const streamA = await waitForLoopDone(sessionIds[0]);
    const streamB = await waitForLoopDone(sessionIds[1]);
    const selectedA = streamA.find((item) => String(item.type || "") === "llm.route.selected") as Record<string, unknown> | undefined;
    const selectedB = streamB.find((item) => String(item.type || "") === "llm.route.selected") as Record<string, unknown> | undefined;
    const payloadA = (selectedA?.payload || {}) as Record<string, unknown>;
    const payloadB = (selectedB?.payload || {}) as Record<string, unknown>;
    const selectedProfiles = [String(payloadA.profile || ""), String(payloadB.profile || "")].sort();
    expect(selectedProfiles).toEqual(["reviewer.basic", "worker.basic"]);
    expect(runModels.sort()).toEqual(["gpt-reviewer-basic", "gpt-worker-basic"]);

    const runDone = await waitForStreamEvent(runSessionId, "subagent.run.end", 5000);
    const runDonePayload = (runDone.event.payload || {}) as Record<string, unknown>;
    expect(String(runDonePayload.mode || "")).toBe("parallel");
    expect(String(runDonePayload.status || "")).toBe("done");
    expect(Number(runDonePayload.completedCount || 0)).toBe(2);
    const taskStartCount = runDone.stream.filter((item) => String(item.type || "") === "subagent.task.start").length;
    const taskEndCount = runDone.stream.filter((item) => String(item.type || "") === "subagent.task.end").length;
    expect(taskStartCount).toBe(2);
    expect(taskEndCount).toBe(2);
  });

  it("brain.agent.run parallel rejects oversized task list", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const tasks = Array.from({ length: 9 }).map((_, i) => ({
      agent: "worker",
      task: `task-${i + 1}`
    }));
    const out = await invokeRuntime({
      type: "brain.agent.run",
      mode: "parallel",
      tasks
    });
    expect(out.ok).toBe(false);
    expect(String(out.error || "")).toContain("不能超过 8");
  });

  it("supports brain.agent.run chain and returns fan-in summary with {previous} injection", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<string, unknown>;
      if (Array.isArray(body.tools) && body.stream === true) {
        const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
        let lastUser = "";
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const item = messages[i] || {};
          if (String(item.role || "") !== "user") continue;
          lastUser = String(item.content || "");
          if (lastUser.trim()) break;
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `chain:${lastUser}`
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
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "title-ok"
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
        llmModel: "gpt-legacy",
        llmDefaultProfile: "worker.basic",
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker"
          },
          {
            id: "reviewer.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-reviewer-basic",
            role: "reviewer"
          }
        ],
        llmProfileChains: {
          worker: ["worker.basic"],
          reviewer: ["reviewer.basic"]
        }
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.agent.run",
      mode: "chain",
      waitTimeoutMs: 5000,
      chain: [
        {
          agent: "worker",
          role: "worker",
          profile: "worker.basic",
          task: "第一步: Alpha"
        },
        {
          agent: "reviewer",
          role: "reviewer",
          profile: "reviewer.basic",
          task: "第二步: {previous} + Beta"
        }
      ]
    });
    expect(started.ok).toBe(true);
    const startedData = (started.data || {}) as Record<string, unknown>;
    expect(String(startedData.mode || "")).toBe("chain");
    const runSessionId = String(startedData.runSessionId || "");
    expect(runSessionId).not.toBe("");
    const results = Array.isArray(startedData.results) ? (startedData.results as Array<Record<string, unknown>>) : [];
    expect(results.length).toBe(2);
    expect(String(results[0].status || "")).toBe("done");
    expect(String(results[1].status || "")).toBe("done");
    expect(String(results[0].output || "")).toContain("第一步: Alpha");
    expect(String(results[1].task || "")).toContain(String(results[0].output || "").trim());
    const fanIn = (startedData.fanIn || {}) as Record<string, unknown>;
    expect(String(fanIn.finalOutput || "")).toBe(String(results[1].output || ""));
    expect(String(fanIn.summary || "")).toContain("1. worker [done]");
    expect(String(fanIn.summary || "")).toContain("2. reviewer [done]");

    const runDone = await waitForStreamEvent(runSessionId, "subagent.run.end", 5000);
    const runDonePayload = (runDone.event.payload || {}) as Record<string, unknown>;
    expect(String(runDonePayload.mode || "")).toBe("chain");
    expect(String(runDonePayload.status || "")).toBe("done");
    expect(Number(runDonePayload.completedCount || 0)).toBe(2);
    const taskStartCount = runDone.stream.filter((item) => String(item.type || "") === "subagent.task.start").length;
    const taskEndCount = runDone.stream.filter((item) => String(item.type || "") === "subagent.task.end").length;
    expect(taskStartCount).toBe(2);
    expect(taskEndCount).toBe(2);
  });

  it("brain.agent.run chain rejects autoRun=false", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const out = await invokeRuntime({
      type: "brain.agent.run",
      mode: "chain",
      autoRun: false,
      chain: [
        {
          agent: "worker",
          task: "第一步"
        }
      ]
    });
    expect(out.ok).toBe(false);
    expect(String(out.error || "")).toContain("需要 autoRun=true");
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

  it("tool_call 的 fs.read 优先走 capability provider（不强绑 bridge mode）", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.fs.read.script-mode",
        name: "fs-read-script-mode",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.fs.read.script-mode.provider",
            mode: "script",
            priority: 50,
            canHandle: (input) => String((input.args?.frame as Record<string, unknown> | undefined)?.tool || "") === "read",
            invoke: async (input) => ({
              provider: "plugin-script-fs",
              mode: input.mode,
              receivedFrame: input.args?.frame || null
            })
          }
        }
      }
    });

    let llmCall = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_read_1",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({
                          path: "/tmp/demo.txt"
                        })
                      }
                    }
                  ]
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
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done"
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "读取 /tmp/demo.txt"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolMessage = [...messages]
      .reverse()
      .find((entry) => String(entry.role || "") === "tool" && String(entry.toolName || "") === "read_file");
    expect(toolMessage).toBeDefined();
    const payload = JSON.parse(String(toolMessage?.content || "{}")) as Record<string, unknown>;
    expect(payload.provider).toBe("plugin-script-fs");
    expect(payload.mode).toBe("script");
    expect(((payload.receivedFrame || {}) as Record<string, unknown>).tool).toBe("read");
  });

  it("tool_call 的 click 优先走 capability provider 并保留 verify 语义", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let providerInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.script-mode",
        name: "browser-action-script-mode",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"]
        }
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.script-mode.provider",
            mode: "script",
            priority: 50,
            invoke: async (input) => {
              providerInvoked += 1;
              return {
                data: {
                  provider: "plugin-script-browser-action",
                  action: input.args?.action || null
                },
                verified: true,
                verifyReason: "verified"
              };
            }
          }
        }
      }
    });

    let llmCall = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_action_1",
                      type: "function",
                      function: {
                        name: "click",
                        arguments: JSON.stringify({
                          tabId: 1,
                          ref: "e0",
                          expect: {
                            selectorExists: "#done"
                          }
                        })
                      }
                    }
                  ]
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
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done"
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "点击提交按钮"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(providerInvoked).toBe(1);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayloads = messages
      .filter((entry) => String(entry.role || "") === "tool")
      .map((entry) => JSON.parse(String(entry.content || "{}")) as Record<string, unknown>);
    const actionPayload = toolPayloads.find((entry) => String(entry.tool || "") === "click");
    expect(actionPayload).toBeDefined();
    expect(String(actionPayload?.errorCode || "")).not.toBe("E_VERIFY_FAILED");
  });

  it("tool_call 支持 search_elements + fill_form 的 UID 链路", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let snapshotInvoked = 0;
    let actionInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.uid-flow",
        name: "browser-uid-flow",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.snapshot", "browser.action"]
        }
      },
      providers: {
        capabilities: {
          "browser.snapshot": {
            id: "plugin.browser.uid-flow.snapshot",
            mode: "script",
            priority: 90,
            invoke: async () => {
              snapshotInvoked += 1;
              return {
                data: {
                  snapshotId: "snap-uid-flow",
                  tabId: 1,
                  nodes: [
                    {
                      uid: "e0",
                      ref: "e0",
                      role: "input",
                      placeholder: "Search",
                      selector: "#name"
                    }
                  ]
                },
                verified: false,
                verifyReason: "verify_policy_off"
              };
            }
          },
          "browser.action": {
            id: "plugin.browser.uid-flow.action",
            mode: "script",
            priority: 90,
            invoke: async () => {
              actionInvoked += 1;
              return {
                data: {
                  ok: true
                },
                verified: true,
                verifyReason: "verified"
              };
            }
          }
        }
      }
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_search_elements_1",
                      type: "function",
                      function: {
                        name: "search_elements",
                        arguments: JSON.stringify({
                          tabId: 1,
                          query: "search input"
                        })
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (llmCall === 2) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_fill_form_1",
                      type: "function",
                      function: {
                        name: "fill_form",
                        arguments: JSON.stringify({
                          tabId: 1,
                          elements: [
                            {
                              uid: "e0",
                              value: "cat"
                            }
                          ]
                        })
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done"
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "sk-demo",
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 search_elements 与 fill_form"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(snapshotInvoked).toBe(1);
    expect(actionInvoked).toBe(1);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayloads = messages
      .filter((entry) => String(entry.role || "") === "tool")
      .map((entry) => JSON.parse(String(entry.content || "{}")) as Record<string, unknown>);
    expect(toolPayloads.some((entry) => String(entry.tool || "") === "search_elements")).toBe(true);
    expect(toolPayloads.some((entry) => String(entry.tool || "") === "fill_form")).toBe(true);
  });

  it("tool_call 支持 AIPex 风格工具名（get_all_tabs/search_elements/fill_element_by_uid/click）", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let snapshotInvoked = 0;
    let actionInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.aipex-names",
        name: "browser-aipex-names",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.snapshot", "browser.action"]
        }
      },
      providers: {
        capabilities: {
          "browser.snapshot": {
            id: "plugin.browser.aipex-names.snapshot",
            mode: "script",
            priority: 80,
            invoke: async () => {
              snapshotInvoked += 1;
              return {
                data: {
                  snapshotId: "snap-aipex-name",
                  tabId: 1,
                  nodes: [
                    { uid: "e-input", ref: "e-input", role: "input", selector: "#name" },
                    { uid: "e-btn", ref: "e-btn", role: "button", selector: "#submit" }
                  ]
                },
                verified: false,
                verifyReason: "verify_policy_off"
              };
            }
          },
          "browser.action": {
            id: "plugin.browser.aipex-names.action",
            mode: "script",
            priority: 80,
            invoke: async () => {
              actionInvoked += 1;
              return {
                data: { ok: true },
                verified: true,
                verifyReason: "verified"
              };
            }
          }
        }
      }
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_get_tabs",
                      type: "function",
                      function: {
                        name: "get_all_tabs",
                        arguments: "{}"
                      }
                    },
                    {
                      id: "call_search_elements",
                      type: "function",
                      function: {
                        name: "search_elements",
                        arguments: JSON.stringify({ tabId: 1, query: "input button" })
                      }
                    },
                    {
                      id: "call_fill_uid",
                      type: "function",
                      function: {
                        name: "fill_element_by_uid",
                        arguments: JSON.stringify({ tabId: 1, uid: "e-input", value: "cat" })
                      }
                    },
                    {
                      id: "call_click_uid",
                      type: "function",
                      function: {
                        name: "click",
                        arguments: JSON.stringify({ tabId: 1, uid: "e-btn" })
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "ok"
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "sk-demo",
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "在当前页面填写输入框并点击按钮后回复 ok"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(snapshotInvoked).toBeGreaterThanOrEqual(0);
    expect(actionInvoked).toBeGreaterThanOrEqual(0);
    expect(llmCall).toBeGreaterThanOrEqual(2);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    expect(messages.some((entry) => String(entry.role || "") === "assistant")).toBe(true);
  });

  it("tool_call fill_element_by_uid 在无 uid/ref 时应拒绝并要求先 search_elements", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let providerInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.ref-required",
        name: "browser-action-ref-required",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"]
        }
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.ref-required.provider",
            mode: "script",
            priority: 70,
            invoke: async () => {
              providerInvoked += 1;
              return {
                data: {
                  provider: "plugin-browser-action-ref-required"
                },
                verified: true,
                verifyReason: "verified"
              };
            }
          }
        }
      }
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_action_ref_required_1",
                      type: "function",
                      function: {
                        name: "fill_element_by_uid",
                        arguments: JSON.stringify({
                          tabId: 1,
                          selector: "#submit",
                          value: "cat"
                        })
                      }
                    }
                  ]
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
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done"
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 fill_element_by_uid ref required"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(0);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayload = messages
      .filter((entry) => String(entry.role || "") === "tool" && String(entry.toolCallId || "") === "call_action_ref_required_1")
      .map((entry) => JSON.parse(String(entry.content || "{}")) as Record<string, unknown>)[0];
    expect(toolPayload).toBeDefined();
    expect(String(toolPayload.errorCode || "")).toBe("E_REF_REQUIRED");
  });

  it("tool_call fill_element_by_uid 失败时输出可恢复协议并给出 focus 升级提示", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let providerInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.fail-protocol",
        name: "browser-action-fail-protocol",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"]
        }
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.fail-protocol.provider",
            mode: "script",
            priority: 70,
            invoke: async (input) => {
              providerInvoked += 1;
              return {
                data: {
                  provider: "plugin-browser-action-fail-protocol",
                  action: input.args?.action || null
                },
                verified: false,
                verifyReason: "verify_failed"
              };
            }
          }
        }
      }
    });

    const capturedBodies: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      llmCall += 1;
      capturedBodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_action_fail_1",
                      type: "function",
                      function: {
                        name: "fill_element_by_uid",
                        arguments: JSON.stringify({
                          tabId: 1,
                          ref: "e-missing",
                          value: "cat",
                          expect: {
                            selectorExists: "#done"
                          }
                        })
                      }
                    }
                  ]
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
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done"
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 fill_element_by_uid 失败协议"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(1);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const secondBody = capturedBodies[1] || {};
    const secondMessages = Array.isArray(secondBody.messages) ? (secondBody.messages as Array<Record<string, unknown>>) : [];
    const toolMessageToLlm = secondMessages.find(
      (entry) => String(entry.role || "") === "tool" && String(entry.tool_call_id || "") === "call_action_fail_1"
    );
    expect(toolMessageToLlm).toBeDefined();
    const toolPayloadToLlm = JSON.parse(String(toolMessageToLlm?.content || "{}")) as Record<string, unknown>;
    expect(["failed_execute", "failed_verify"]).toContain(String(toolPayloadToLlm.errorReason || ""));
    expect(String(toolPayloadToLlm.retryHint || "")).toContain("focus");
    expect(["execute", "verify"]).toContain(String(((toolPayloadToLlm.failureClass || {}) as Record<string, unknown>).phase || ""));
    expect(String(((toolPayloadToLlm.modeEscalation || {}) as Record<string, unknown>).to || "")).toBe("focus");
    expect(String(((toolPayloadToLlm.resume || {}) as Record<string, unknown>).action || "")).toBe("resume_current_step");
    expect(String(((toolPayloadToLlm.stepRef || {}) as Record<string, unknown>).toolCallId || "")).toBe("call_action_fail_1");

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const persistedToolMessage = messages.find(
      (entry) => String(entry.role || "") === "tool" && String(entry.toolCallId || "") === "call_action_fail_1"
    );
    expect(persistedToolMessage).toBeDefined();
    const persistedPayload = JSON.parse(String(persistedToolMessage?.content || "{}")) as Record<string, unknown>;
    expect(String(((persistedPayload.modeEscalation || {}) as Record<string, unknown>).to || "")).toBe("focus");
    expect(String(((persistedPayload.resume || {}) as Record<string, unknown>).strategy || "")).toBe("retry_with_fresh_snapshot");
  });

  it("click 遇到 focus_required 失败时应自动切 focus 并续跑当前 step", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let providerInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.focus-recover",
        name: "browser-action-focus-recover",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"]
        }
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.focus-recover.provider",
            mode: "script",
            priority: 80,
            invoke: async (input) => {
              providerInvoked += 1;
              const action = (input.args?.action || {}) as Record<string, unknown>;
              if (action.forceFocus !== true) {
                const error = new Error("background mode requires focus") as Error & {
                  code?: string;
                  retryable?: boolean;
                };
                error.code = "E_CDP_BACKEND_ACTION";
                error.retryable = true;
                throw error;
              }
              return {
                data: {
                  provider: "plugin-browser-action-focus-recover",
                  action
                },
                verified: true,
                verifyReason: "verified"
              };
            }
          }
        }
      }
    });

    const capturedBodies: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      llmCall += 1;
      capturedBodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_action_focus_recover_1",
                      type: "function",
                      function: {
                        name: "click",
                        arguments: JSON.stringify({
                          tabId: 1,
                          ref: "e0"
                        })
                      }
                    }
                  ]
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
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done"
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 focus auto recover"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(2);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const escalatedEvent = stream.find((item) => String(item.type || "") === "tool.mode_escalation") as Record<string, unknown> | undefined;
    expect(escalatedEvent).toBeDefined();
    const escalatedPayload = (escalatedEvent?.payload || {}) as Record<string, unknown>;
    expect(String(escalatedPayload.to || "")).toBe("focus");

    const secondBody = capturedBodies[1] || {};
    const secondMessages = Array.isArray(secondBody.messages) ? (secondBody.messages as Array<Record<string, unknown>>) : [];
    const toolMessage = secondMessages.find(
      (entry) => String(entry.role || "") === "tool" && String(entry.tool_call_id || "") === "call_action_focus_recover_1"
    );
    expect(toolMessage).toBeDefined();
    expect(String(toolMessage?.content || "")).toContain('"modeEscalated":true');
  });

  it("strict verify 不可判定时应以 progress_uncertain 收口", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.verify-skipped",
        name: "browser-action-verify-skipped",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"]
        }
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.verify-skipped.provider",
            mode: "script",
            priority: 60,
            invoke: async () => ({
              data: {
                provider: "plugin-browser-action-verify-skipped"
              },
              verified: false,
              verifyReason: "verify_skipped"
            })
          }
        }
      }
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: `call_action_uncertain_${llmCall}`,
                    type: "function",
                    function: {
                      name: "click",
                      arguments: JSON.stringify({
                        tabId: 1,
                        ref: "e0",
                        expect: {
                          selectorExists: "#done"
                        }
                      })
                    }
                  }
                ]
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请执行页面导航并验证结果"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    const done = stream.find((item) => String(item.type || "") === "loop_done") as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("progress_uncertain");
  });

  it("重复同签名 tool_calls 时应触发 loop_no_progress 并 progress_uncertain 收口", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.no-progress.read",
        name: "no-progress-read",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.no-progress.read.provider",
            mode: "script",
            priority: 80,
            invoke: async () => ({
              text: "no-progress"
            })
          }
        }
      }
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: `call_read_file_repeat_${llmCall}`,
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({
                        path: "/tmp/no-progress.txt"
                      })
                    }
                  }
                ]
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请查看当前标签页并继续执行"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    const done = stream.find((item) => String(item.type || "") === "loop_done") as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("progress_uncertain");

    const noProgress = stream.find((item) => String(item.type || "") === "loop_no_progress") as Record<string, unknown> | undefined;
    expect(noProgress).toBeDefined();
    const noProgressPayload = (noProgress?.payload || {}) as Record<string, unknown>;
    expect(String(noProgressPayload.reason || "")).toBe("repeat_signature");
    expect(String(noProgressPayload.signature || "")).toContain("read_file");
    expect(Number(noProgressPayload.sameSignatureStreak || 0)).toBeGreaterThanOrEqual(3);
    const noProgressFailureClass = (noProgressPayload.failureClass || {}) as Record<string, unknown>;
    expect(String(noProgressFailureClass.phase || "")).toBe("progress_guard");
    expect(String(noProgressFailureClass.reason || "")).toBe("progress_uncertain");
    const noProgressResume = (noProgressPayload.resume || {}) as Record<string, unknown>;
    expect(String(noProgressResume.action || "")).toBe("resume_current_step");
    expect(String(noProgressResume.strategy || "")).toBe("replan");
  });

  it("loop_no_progress 应先给出 retry 决策，超预算后 continue 并保持 guard 信号", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.no-progress.budget",
        name: "no-progress-budget",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.no-progress.budget.provider",
            mode: "script",
            priority: 80,
            invoke: async () => ({
              text: "budget"
            })
          }
        }
      }
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: `call_budget_${llmCall}`,
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({
                        path: "/tmp/no-progress-budget.txt"
                      })
                    }
                  }
                ]
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请继续读取文件并推进"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    const done = stream.find((item) => String(item.type || "") === "loop_done") as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("progress_uncertain");

    const noProgressEvents = stream.filter((item) => String(item.type || "") === "loop_no_progress");
    expect(noProgressEvents.length).toBeGreaterThanOrEqual(1);
    const firstPayload = (noProgressEvents[0]?.payload || {}) as Record<string, unknown>;
    const lastPayload = (noProgressEvents[noProgressEvents.length - 1]?.payload || {}) as Record<string, unknown>;
    expect(["retry", "continue"]).toContain(String(firstPayload.decision || ""));
    expect(String(lastPayload.decision || "")).toBe("continue");
    expect(String(((lastPayload.failureClass || {}) as Record<string, unknown>).phase || "")).toBe("progress_guard");
  });

  it("同一会话二轮请求会保留历史 tool role 并补齐 assistant/tool_call 配对", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.history.tool.read",
        name: "history-tool-read",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.read"]
        }
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.history.tool.read.provider",
            mode: "script",
            priority: 50,
            canHandle: (input) => String((input.args?.frame as Record<string, unknown> | undefined)?.tool || "") === "read",
            invoke: async () => ({
              provider: "history-tool-read"
            })
          }
        }
      }
    });

    const capturedBodies: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      llmCall += 1;
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      capturedBodies.push(body);

      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_read_history_1",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({
                          path: "/tmp/history.txt"
                        })
                      }
                    }
                  ]
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
      }

      if (llmCall === 2) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "FIRST_TURN_DONE"
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
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "SECOND_TURN_DONE"
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
        llmModel: "gpt-test",
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const first = await invokeRuntime({
      type: "brain.run.start",
      prompt: "第一轮读取文件",
      sessionOptions: {
        title: "History Tool Session",
        metadata: {
          titleSource: "manual"
        }
      }
    });
    expect(first.ok).toBe(true);
    const sessionId = String(((first.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");
    await waitForLoopDone(sessionId);

    const second = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "第二轮继续"
    });
    expect(second.ok).toBe(true);

    const deadline = Date.now() + 2500;
    while (fetchSpy.mock.calls.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    const thirdBody = capturedBodies[2] || {};
    const thirdMessages = Array.isArray(thirdBody.messages)
      ? (thirdBody.messages as Array<Record<string, unknown>>)
      : [];
    const toolMessage = thirdMessages.find(
      (item) => String(item.role || "") === "tool" && String(item.tool_call_id || "") === "call_read_history_1"
    );
    expect(toolMessage).toBeDefined();
    const pairedAssistant = thirdMessages.find((item) => {
      if (String(item.role || "") !== "assistant") return false;
      const calls = Array.isArray(item.tool_calls) ? (item.tool_calls as Array<Record<string, unknown>>) : [];
      return calls.some((call) => String(call.id || "") === "call_read_history_1");
    });
    expect(pairedAssistant).toBeDefined();
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

    const executedWithMode = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      mode: "bridge",
      capability: "fs.virtual.read",
      action: "read_file",
      args: {
        path: "mem://missing.txt"
      },
      verifyPolicy: "off"
    });
    expect(executedWithMode.ok).toBe(true);
    const withModeResult = (executedWithMode.data || {}) as Record<string, unknown>;
    expect(withModeResult.ok).toBe(false);
    expect(withModeResult.errorCode).toBe("E_RUNTIME_NOT_READY");
    expect(String(withModeResult.error || "")).toContain("capability provider 未就绪");
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

    const deadline = Date.now() + 1200;
    let stepDelta: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      const afterStream = await invokeRuntime({
        type: "brain.step.stream",
        sessionId
      });
      expect(afterStream.ok).toBe(true);
      const fullStream = Array.isArray((afterStream.data as Record<string, unknown>)?.stream)
        ? (((afterStream.data as Record<string, unknown>).stream as unknown[]) as Array<Record<string, unknown>>)
        : [];
      const delta = fullStream.slice(baseline.length);
      stepDelta = delta.filter((entry) => {
        const type = String(entry.type || "");
        return type === "step_execute" || type === "step_execute_result";
      });
      if (stepDelta.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(stepDelta).toHaveLength(2);
    expect(String(stepDelta[0].type || "")).toBe("step_execute");
    expect(String(stepDelta[1].type || "")).toBe("step_execute_result");
    expect(String((stepDelta[0].payload as Record<string, unknown> | undefined)?.capability || "")).toBe("fs.virtual.read");
    expect(String((stepDelta[1].payload as Record<string, unknown> | undefined)?.capabilityUsed || "")).toBe("fs.virtual.read");
  });

  it("brain.step.stream 支持按 maxEvents/maxBytes 裁剪并返回元信息", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const created = await orchestrator.createSession({ title: "stream-limit" });
    const sessionId = created.sessionId;

    for (let i = 0; i < 40; i += 1) {
      orchestrator.events.emit("step_planned", sessionId, {
        index: i,
        mode: "tool_call",
        action: "mock",
        marker: `m-${i}`,
        payload: "x".repeat(220)
      });
    }

    const deadline = Date.now() + 1500;
    let data: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      const out = await invokeRuntime({
        type: "brain.step.stream",
        sessionId,
        maxEvents: 5,
        maxBytes: 12_000
      });
      expect(out.ok).toBe(true);
      data = (out.data || {}) as Record<string, unknown>;
      const streamMeta = (data.streamMeta || {}) as Record<string, unknown>;
      if (Number(streamMeta.totalEvents || 0) >= 40) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const stream = Array.isArray(data.stream) ? (data.stream as Array<Record<string, unknown>>) : [];
    const streamMeta = (data.streamMeta || {}) as Record<string, unknown>;

    expect(stream.length).toBeLessThanOrEqual(5);
    expect(stream.length).toBeGreaterThan(0);
    expect(streamMeta.truncated).toBe(true);
    expect(Number(streamMeta.totalEvents || 0)).toBeGreaterThanOrEqual(40);
    expect(Number(streamMeta.returnedEvents || 0)).toBe(stream.length);
    const latest = stream[stream.length - 1] || {};
    const latestPayload = (latest.payload || {}) as Record<string, unknown>;
    expect(Number(latestPayload.index || -1)).toBe(39);
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
    expect(fetchSpy).toHaveBeenCalled();
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
    expect(timeline).toEqual(["before", "fetch", "after"]);
    const eventTypes = stream.map((item) => String(item.type || ""));
    expect(eventTypes).toContain("llm.request");
    expect(eventTypes).toContain("llm.response.parsed");
    const llmReq = stream.find((item) => String(item.type || "") === "llm.request") || {};
    const llmReqPayload = ((llmReq as Record<string, unknown>).payload || {}) as Record<string, unknown>;
    expect("payload" in llmReqPayload).toBe(false);
    expect(Number(llmReqPayload.messageCount || 0)).toBeGreaterThan(0);
    expect(Number(llmReqPayload.messageChars || 0)).toBeGreaterThan(0);
    expect(typeof llmReqPayload.lastUserSnippet).toBe("string");
  });

  it("缺少 LLM 配置时应以 failed_execute 结束而非 done", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "",
        llmModel: "gpt-test"
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "缺少 llm key 的场景"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    const done = stream.find((item) => String(item.type || "") === "loop_done") as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("failed_execute");

    const skipped = stream.find((item) => String(item.type || "") === "llm.skipped") as Record<string, unknown> | undefined;
    const skippedPayload = (skipped?.payload || {}) as Record<string, unknown>;
    expect(String(skippedPayload.reason || "")).toBe("missing_llm_config");
  });

  it("浏览器任务未显式给 tabId 时也应要求可验证 browser proof", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "已完成"
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
        llmModel: "gpt-test",
        llmRetryMaxAttempts: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "在书签页面搜索 cat 并把结果链接发我"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(fetchSpy).toHaveBeenCalled();
    const done = stream.find((item) => String(item.type || "") === "loop_done") as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("progress_uncertain");
    const guardCount = stream.filter((item) => String(item.type || "") === "loop_guard_browser_progress_missing").length;
    const noProgressCount = stream.filter((item) => String(item.type || "") === "loop_no_progress").length;
    expect(guardCount > 0 || noProgressCount > 0).toBe(true);
  });

  it("LLM 抛出字符串错误时应稳定收口，避免 details 写入字符串导致二次异常", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw "llm-timeout";
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmApiBase: "https://example.ai/v1",
        llmApiKey: "sk-demo",
        llmModel: "gpt-test",
        llmRetryMaxAttempts: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试字符串错误兼容"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(fetchSpy).toHaveBeenCalled();
    const done = stream.find((item) => String(item.type || "") === "loop_done") as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("failed_execute");
    const doneMessage = `${String(donePayload.message || "")} ${String(donePayload.error || "")}`;
    expect(doneMessage).not.toContain("Cannot create property 'details'");

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const assistantMessages = messages.filter((item) => String(item.role || "") === "assistant");
    const lastAssistant = String((assistantMessages[assistantMessages.length - 1] || {}).content || "");
    expect(lastAssistant).toContain("llm-timeout");
    expect(lastAssistant).not.toContain("Cannot create property 'details'");
  });

  it("使用 profile 配置时应发出 llm.route.selected 并命中 provider/model", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<string, unknown>;
      capturedBodies.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "profile-route-ok"
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
        llmModel: "gpt-legacy",
        llmDefaultProfile: "worker.basic",
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker"
          }
        ],
        llmProfileChains: {
          worker: ["worker.basic"]
        }
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 profile 选路事件"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    const runRequest = capturedBodies.find((body) => Array.isArray(body.tools) && body.stream === true);
    expect(runRequest).toBeDefined();
    expect(String(runRequest?.model || "")).toBe("gpt-worker-basic");
    const selected = stream.find((item) => String(item.type || "") === "llm.route.selected") as Record<string, unknown> | undefined;
    const payload = (selected?.payload || {}) as Record<string, unknown>;
    expect(String(payload.profile || "")).toBe("worker.basic");
    expect(String(payload.provider || "")).toBe("openai_compatible");
    expect(String(payload.model || "")).toBe("gpt-worker-basic");
  });

  it("profile 指向未注册 provider 时应 llm.route.blocked 并 failed_execute", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmDefaultProfile: "worker.basic",
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "missing_provider",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker"
          }
        ]
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 provider 缺失失败语义"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    const blocked = stream.find((item) => String(item.type || "") === "llm.route.blocked") as Record<string, unknown> | undefined;
    const blockedPayload = (blocked?.payload || {}) as Record<string, unknown>;
    expect(String(blockedPayload.reason || "")).toBe("provider_not_found");
    const done = stream.find((item) => String(item.type || "") === "loop_done") as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("failed_execute");
  });

  it("LLM 重复失败后应升级 profile 并发出 llm.route.escalated", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<string, unknown>;
      const model = String(body.model || "");
      if (model === "gpt-worker-basic") {
        return new Response(
          JSON.stringify({
            error: {
              message: "temporary unavailable"
            }
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "escalation-ok"
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
        llmDefaultProfile: "worker.basic",
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker",
            llmRetryMaxAttempts: 1
          },
          {
            id: "worker.pro",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-pro",
            role: "worker",
            llmRetryMaxAttempts: 0
          }
        ],
        llmProfileChains: {
          worker: ["worker.basic", "worker.pro"]
        },
        llmEscalationPolicy: "upgrade_only"
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 profile 自动升级"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(fetchSpy).toHaveBeenCalled();
    const escalated = stream.find((item) => String(item.type || "") === "llm.route.escalated") as Record<string, unknown> | undefined;
    const escalatedPayload = (escalated?.payload || {}) as Record<string, unknown>;
    expect(String(escalatedPayload.fromProfile || "")).toBe("worker.basic");
    expect(String(escalatedPayload.toProfile || "")).toBe("worker.pro");

    const selectedEvents = stream.filter((item) => String(item.type || "") === "llm.route.selected");
    expect(selectedEvents.length).toBeGreaterThanOrEqual(2);
    const afterEscalation = selectedEvents[selectedEvents.length - 1] as Record<string, unknown>;
    const afterEscalationPayload = (afterEscalation.payload || {}) as Record<string, unknown>;
    expect(String(afterEscalationPayload.profile || "")).toBe("worker.pro");
    expect(String(afterEscalationPayload.source || "")).toBe("escalation");

    const done = stream.find((item) => String(item.type || "") === "loop_done") as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("done");
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

  it("brain.run.start 会注入 available_skills（过滤 disable-model-invocation）", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const bodyText = String(init?.body || "");
      const body = (JSON.parse(bodyText || "{}") || {}) as Record<string, unknown>;
      capturedBodies.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "skills-prompt-ok"
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

    const visibleSkill = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.visible",
        name: "Visible Skill",
        description: "visible in available skills",
        location: "mem://skills/visible/SKILL.md",
        source: "project",
        enabled: true
      }
    });
    expect(visibleSkill.ok).toBe(true);

    const hiddenSkill = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.hidden",
        name: "Hidden Skill",
        description: "should not be model-invoked",
        location: "mem://skills/hidden/SKILL.md",
        source: "project",
        enabled: true,
        disableModelInvocation: true
      }
    });
    expect(hiddenSkill.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 available skills prompt"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    const runBody = capturedBodies.find((item) => item.stream === true) || {};
    const runMessages = Array.isArray(runBody.messages) ? (runBody.messages as Array<Record<string, unknown>>) : [];
    const systemText = runMessages
      .filter((item) => String(item.role || "") === "system")
      .map((item) => String(item.content || ""))
      .join("\n");
    expect(systemText).toContain("<available_skills>");
    expect(systemText).toContain('name="Visible Skill"');
    expect(systemText).toContain('location="mem://skills/visible/SKILL.md"');
    expect(systemText).not.toContain("skill.hidden");
    expect(systemText).not.toContain("mem://skills/hidden/SKILL.md");
  });

  it("brain.run.start 支持 /skill:<id> 显式展开并注入 skill block + args", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerCapabilityProvider(
      "fs.read",
      {
        id: "test.skill.slash.fs.read",
        mode: "script",
        priority: 100,
        invoke: async () => ({
          content: "# SKILL\n1. 分析输入\n2. 输出结果"
        })
      },
      { replace: true }
    );

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const bodyText = String(init?.body || "");
      const body = (JSON.parse(bodyText || "{}") || {}) as Record<string, unknown>;
      capturedBodies.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "slash-skill-ok"
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

    const installed = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.slash.demo",
        name: "Slash Demo",
        location: "mem://skills/slash-demo/SKILL.md",
        source: "project",
        enabled: true
      }
    });
    expect(installed.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "/skill:skill.slash.demo 请输出 hello"
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    const runBody = capturedBodies.find((item) => item.stream === true) || {};
    const runMessages = Array.isArray(runBody.messages) ? (runBody.messages as Array<Record<string, unknown>>) : [];
    const userText = runMessages
      .filter((item) => String(item.role || "") === "user")
      .map((item) => String(item.content || ""))
      .join("\n");
    expect(userText).toContain('<skill id="skill.slash.demo"');
    expect(userText).toContain("<skill_args>");
    expect(userText).toContain("请输出 hello");
    expect(userText).toContain("1. 分析输入");
  });

  it("brain.run.start 在 /skill 指向不存在 skill 时应失败", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "/skill:skill.not-found test",
      autoRun: false
    });
    expect(started.ok).toBe(false);
    expect(String(started.error || "")).toContain("skill 不存在");
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

  it("supports brain.skill lifecycle routes", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const installed = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.pi.align",
        name: "PI Align",
        description: "align runtime behavior with PI",
        location: "mem://skills/pi-align/SKILL.md",
        source: "project",
        enabled: false
      }
    });
    expect(installed.ok).toBe(true);
    const installedData = (installed.data || {}) as Record<string, unknown>;
    expect(String(installedData.skillId || "")).toBe("skill.pi.align");
    const installedSkill = (installedData.skill || {}) as Record<string, unknown>;
    expect(Boolean(installedSkill.enabled)).toBe(false);

    const listedAfterInstall = await invokeRuntime({
      type: "brain.skill.list"
    });
    expect(listedAfterInstall.ok).toBe(true);
    const listedSkillsAfterInstall = Array.isArray((listedAfterInstall.data as Record<string, unknown>)?.skills)
      ? (((listedAfterInstall.data as Record<string, unknown>).skills as unknown[]) as Array<Record<string, unknown>>)
      : [];
    expect(listedSkillsAfterInstall.some((item) => String(item.id || "") === "skill.pi.align")).toBe(true);

    const enabled = await invokeRuntime({
      type: "brain.skill.enable",
      skillId: "skill.pi.align"
    });
    expect(enabled.ok).toBe(true);
    const enabledSkill = (((enabled.data as Record<string, unknown>) || {}).skill || {}) as Record<string, unknown>;
    expect(Boolean(enabledSkill.enabled)).toBe(true);

    const disabled = await invokeRuntime({
      type: "brain.skill.disable",
      skillId: "skill.pi.align"
    });
    expect(disabled.ok).toBe(true);
    const disabledSkill = (((disabled.data as Record<string, unknown>) || {}).skill || {}) as Record<string, unknown>;
    expect(Boolean(disabledSkill.enabled)).toBe(false);

    const uninstalled = await invokeRuntime({
      type: "brain.skill.uninstall",
      skillId: "skill.pi.align"
    });
    expect(uninstalled.ok).toBe(true);
    const uninstalledData = (uninstalled.data || {}) as Record<string, unknown>;
    expect(Boolean(uninstalledData.removed)).toBe(true);

    const listedAfterUninstall = await invokeRuntime({
      type: "brain.skill.list"
    });
    expect(listedAfterUninstall.ok).toBe(true);
    const listedSkillsAfterUninstall = Array.isArray((listedAfterUninstall.data as Record<string, unknown>)?.skills)
      ? (((listedAfterUninstall.data as Record<string, unknown>).skills as unknown[]) as Array<Record<string, unknown>>)
      : [];
    expect(listedSkillsAfterUninstall.some((item) => String(item.id || "") === "skill.pi.align")).toBe(false);
  });

  it("brain.skill.resolve should read content through fs.read capability", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerCapabilityProvider(
      "fs.read",
      {
        id: "test.skill.resolve.fs.read",
        mode: "script",
        priority: 90,
        invoke: async (input) => ({
          content: `# SKILL\nloaded from ${String(input.args?.path || "")}`
        })
      },
      { replace: true }
    );

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed skill resolve context",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const installed = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.resolve.demo",
        name: "Resolve Demo",
        location: "mem://skills/resolve-demo/SKILL.md",
        source: "project"
      }
    });
    expect(installed.ok).toBe(true);

    const resolved = await invokeRuntime({
      type: "brain.skill.resolve",
      sessionId,
      skillId: "skill.resolve.demo"
    });
    expect(resolved.ok).toBe(true);
    const resolvedData = (resolved.data || {}) as Record<string, unknown>;
    expect(String(resolvedData.skillId || "")).toBe("skill.resolve.demo");
    expect(String(resolvedData.content || "")).toContain("mem://skills/resolve-demo/SKILL.md");
    expect(String(resolvedData.promptBlock || "")).toContain('<skill id="skill.resolve.demo"');
  });

  it("brain.skill.discover should scan + parse frontmatter + auto install", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed discover context",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const root = "/repo/.agents/skills";
    const scanStdout = [
      `0\tproject\t${root}\t${root}/write-doc.md`,
      `0\tproject\t${root}\t${root}/browser-flow/SKILL.md`,
      `0\tproject\t${root}\t${root}/browser-flow/README.md`,
      `0\tproject\t${root}\t${root}/.hidden/SKILL.md`,
      `0\tproject\t${root}\t${root}/vendor/node_modules/pkg/SKILL.md`
    ].join("\n");

    orchestrator.registerCapabilityProvider(
      "process.exec",
      {
        id: "test.skill.discover.process.exec",
        mode: "script",
        priority: 100,
        invoke: async () => ({
          response: {
            data: {
              data: {
                stdout: scanStdout,
                stderr: "",
                exitCode: 0
              }
            }
          }
        })
      },
      { replace: true }
    );

    orchestrator.registerCapabilityProvider(
      "fs.read",
      {
        id: "test.skill.discover.fs.read",
        mode: "script",
        priority: 100,
        invoke: async (input) => {
          const path = String(input.args?.path || "");
          if (path.endsWith("/write-doc.md")) {
            return {
              content: `---
id: skill.write.doc
name: Write Doc
description: write docs by template
---
# SKILL
Do write-doc`
            };
          }
          if (path.endsWith("/browser-flow/SKILL.md")) {
            return {
              content: `---
name: Browser Flow
description: execute browser flow
disable-model-invocation: true
---
# SKILL
Do browser-flow`
            };
          }
          throw new Error(`unexpected read path: ${path}`);
        }
      },
      { replace: true }
    );

    const discovered = await invokeRuntime({
      type: "brain.skill.discover",
      sessionId,
      roots: [{ root, source: "project" }]
    });
    expect(discovered.ok).toBe(true);
    const data = (discovered.data || {}) as Record<string, unknown>;
    const counts = (data.counts || {}) as Record<string, unknown>;
    expect(Number(counts.scanned || 0)).toBe(2);
    expect(Number(counts.discovered || 0)).toBe(2);
    expect(Number(counts.installed || 0)).toBe(2);
    expect(Number(counts.skipped || 0)).toBe(0);

    const skills = Array.isArray(data.skills) ? (data.skills as Array<Record<string, unknown>>) : [];
    expect(skills.some((item) => String(item.id || "") === "skill.write.doc")).toBe(true);
    expect(skills.some((item) => String(item.id || "") === "browser-flow")).toBe(true);
    expect(
      skills.some((item) => String(item.id || "") === "browser-flow" && item.disableModelInvocation === true)
    ).toBe(true);
  });

  it("brain.skill.discover should skip skill without frontmatter.description", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed discover context missing description",
      autoRun: false
    });
    expect(started.ok).toBe(true);
    const sessionId = String(((started.data as Record<string, unknown>) || {}).sessionId || "");
    expect(sessionId).not.toBe("");

    const root = "/repo/.agents/skills";
    orchestrator.registerCapabilityProvider(
      "process.exec",
      {
        id: "test.skill.discover.skip.process.exec",
        mode: "script",
        priority: 100,
        invoke: async () => ({
          stdout: `0\tproject\t${root}\t${root}/missing-description.md`,
          stderr: "",
          exitCode: 0
        })
      },
      { replace: true }
    );

    orchestrator.registerCapabilityProvider(
      "fs.read",
      {
        id: "test.skill.discover.skip.fs.read",
        mode: "script",
        priority: 100,
        invoke: async () => ({
          content: `---
name: Missing Description
---
# SKILL
description missing`
        })
      },
      { replace: true }
    );

    const discovered = await invokeRuntime({
      type: "brain.skill.discover",
      sessionId,
      roots: [{ root, source: "project" }]
    });
    expect(discovered.ok).toBe(true);
    const data = (discovered.data || {}) as Record<string, unknown>;
    const counts = (data.counts || {}) as Record<string, unknown>;
    expect(Number(counts.discovered || 0)).toBe(0);
    expect(Number(counts.installed || 0)).toBe(0);
    expect(Number(counts.skipped || 0)).toBe(1);

    const skipped = Array.isArray(data.skipped) ? (data.skipped as Array<Record<string, unknown>>) : [];
    expect(String((skipped[0] || {}).reason || "")).toContain("description");
  });

  it("brain.skill routes validate payload and missing resources", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const installMissingLocation = await invokeRuntime({
      type: "brain.skill.install"
    });
    expect(installMissingLocation.ok).toBe(false);
    expect(String(installMissingLocation.error || "")).toContain("brain.skill.install 需要 location");

    const enableMissingSkillId = await invokeRuntime({
      type: "brain.skill.enable"
    });
    expect(enableMissingSkillId.ok).toBe(false);
    expect(String(enableMissingSkillId.error || "")).toContain("brain.skill.enable 需要 skillId");

    const resolveMissingSkillId = await invokeRuntime({
      type: "brain.skill.resolve",
      sessionId: "session-demo"
    });
    expect(resolveMissingSkillId.ok).toBe(false);
    expect(String(resolveMissingSkillId.error || "")).toContain("brain.skill.resolve 需要 skillId");

    const resolveMissingSessionId = await invokeRuntime({
      type: "brain.skill.resolve",
      skillId: "skill.any"
    });
    expect(resolveMissingSessionId.ok).toBe(false);
    expect(String(resolveMissingSessionId.error || "")).toContain("brain.skill.resolve 需要 sessionId");

    const discoverMissingSessionId = await invokeRuntime({
      type: "brain.skill.discover"
    });
    expect(discoverMissingSessionId.ok).toBe(false);
    expect(String(discoverMissingSessionId.error || "")).toContain("brain.skill.discover 需要 sessionId");

    const uninstallMissingSkill = await invokeRuntime({
      type: "brain.skill.uninstall",
      skillId: "skill.not-found"
    });
    expect(uninstallMissingSkill.ok).toBe(false);
    expect(String(uninstallMissingSkill.error || "")).toContain("skill 不存在: skill.not-found");
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
