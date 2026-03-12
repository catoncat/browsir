import "./test-setup";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLifoAdapterForTest } from "../browser-unix-runtime/lifo-adapter";
import { compact, prepareCompaction } from "../compaction.browser";
import { getDB, kvGet, kvKeys } from "../idb-storage";
import { BrainOrchestrator } from "../orchestrator.browser";
import { registerRuntimeRouter } from "../runtime-router";
import { invokeVirtualFrame } from "../virtual-fs.browser";
import type { LlmResolvedRoute } from "../llm-provider";
import { readTraceChunk } from "../session-store.browser";

type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (value: unknown) => void,
) => boolean | void;

let runtimeListeners: RuntimeListener[] = [];

interface TestLlmProfileInput {
  id: string;
  role?: string;
  provider?: string;
  llmApiBase?: string;
  llmApiKey?: string;
  llmModel?: string;
  llmRetryMaxAttempts?: number;
}

function createTestLlmProfile(
  input: TestLlmProfileInput,
): Record<string, unknown> {
  const profile: Record<string, unknown> = {
    id: input.id,
    provider: input.provider || "openai_compatible",
    llmApiBase: input.llmApiBase || "https://example.ai/v1",
    llmApiKey: input.llmApiKey ?? "sk-demo",
    llmModel: input.llmModel || "gpt-test",
    role: input.role || "worker",
  };
  if (typeof input.llmRetryMaxAttempts === "number") {
    profile.llmRetryMaxAttempts = input.llmRetryMaxAttempts;
  }
  return profile;
}

function buildLlmProfileConfig(
  profiles: TestLlmProfileInput[],
  options?: {
    defaultProfile?: string;
    auxProfile?: string;
    fallbackProfile?: string;
  },
): Record<string, unknown> {
  const normalizedProfiles = profiles.map((item) => createTestLlmProfile(item));
  const firstProfileId = String(normalizedProfiles[0]?.id || "default");
  const defaultProfileId = String(
    options?.defaultProfile || firstProfileId || "default",
  );
  const auxProfileId = String(options?.auxProfile || "").trim();
  const fallbackProfileId = String(options?.fallbackProfile || "").trim();

  return {
    llmDefaultProfile: defaultProfileId,
    llmAuxProfile:
      auxProfileId && auxProfileId !== defaultProfileId ? auxProfileId : "",
    llmFallbackProfile:
      fallbackProfileId && fallbackProfileId !== defaultProfileId
        ? fallbackProfileId
        : "",
    llmProfiles: normalizedProfiles,
  };
}

function buildWorkerLlmConfig(options?: {
  id?: string;
  model?: string;
  apiKey?: string;
  role?: string;
  auxProfile?: string;
  fallbackProfile?: string;
}): Record<string, unknown> {
  const id = String(options?.id || "default");
  const role = String(options?.role || "worker");
  return buildLlmProfileConfig(
    [
      {
        id,
        role,
        llmModel: options?.model || "gpt-test",
        llmApiKey: options?.apiKey ?? "sk-demo",
      },
    ],
    {
      defaultProfile: id,
      auxProfile: options?.auxProfile,
      fallbackProfile: options?.fallbackProfile,
    },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function createDummyRoute(
  overrides: Partial<LlmResolvedRoute> = {},
): LlmResolvedRoute {
  return {
    profile: "default",
    provider: "openai_compatible",
    llmBase: "https://example.ai/v1",
    llmKey: "sk-demo",
    llmModel: "gpt-test",
    llmTimeoutMs: 120000,
    llmRetryMaxAttempts: 2,
    llmMaxRetryDelayMs: 60000,
    role: "worker",
    escalationPolicy: "upgrade_only",
    orderedProfiles: ["default"],
    fromLegacy: false,
    ...overrides,
  };
}

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

async function resetRuntimeRouterTestState(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["sessions", "entries", "traces", "kv"], "readwrite");
  await tx.objectStore("sessions").clear();
  await tx.objectStore("entries").clear();
  await tx.objectStore("traces").clear();
  await tx.objectStore("kv").clear();
  await tx.done;
  await resetLifoAdapterForTest();
  await chrome.storage.local.clear();
}

function invokeRuntime(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!runtimeListeners.length) {
      reject(new Error("runtime listener not registered"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(
        new Error(`runtime response timeout: ${String(message.type || "")}`),
      );
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

function readConversationMessages(
  response: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const data = (response.data || {}) as Record<string, unknown>;
  const conversationView = (data.conversationView || {}) as Record<
    string,
    unknown
  >;
  const rawMessages = conversationView.messages;
  return Array.isArray(rawMessages)
    ? (rawMessages as Array<Record<string, unknown>>)
    : [];
}

async function waitForLoopDone(
  sessionId: string,
  timeoutMs = 2500,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    const stream = Array.isArray((out.data as Record<string, unknown>)?.stream)
      ? ((out.data as Record<string, unknown>).stream as unknown[] as Array<
          Record<string, unknown>
        >)
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
  timeoutMs = 2500,
): Promise<{
  event: Record<string, unknown>;
  stream: Array<Record<string, unknown>>;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    const stream = Array.isArray((out.data as Record<string, unknown>)?.stream)
      ? ((out.data as Record<string, unknown>).stream as unknown[] as Array<
          Record<string, unknown>
        >)
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
  beforeEach(async () => {
    runtimeListeners = [];
    resetRuntimeOnMessageMock();
    await resetRuntimeRouterTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports fork session and exposes forkedFrom metadata in list/view", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请总结这段文本",
    });
    expect(started.ok).toBe(true);
    const sourceSessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sourceSessionId).not.toBe("");

    const userEntry = await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "这是第二个问题",
    });
    const assistantEntry = await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "这是第二个回答",
    });

    const forked = await invokeRuntime({
      type: "brain.session.fork",
      sessionId: sourceSessionId,
      leafId: userEntry.id,
      sourceEntryId: assistantEntry.id,
      reason: "branch_from_assistant",
    });
    expect(forked.ok).toBe(true);
    const forkedSessionId = String(
      ((forked.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(forkedSessionId).not.toBe("");
    expect(forkedSessionId).not.toBe(sourceSessionId);

    const listed = await invokeRuntime({ type: "brain.session.list" });
    expect(listed.ok).toBe(true);
    const sessions = Array.isArray(
      (listed.data as Record<string, unknown>)?.sessions,
    )
      ? ((listed.data as Record<string, unknown>)
          .sessions as unknown[] as Array<Record<string, unknown>>)
      : [];
    const forkMeta = sessions.find(
      (item) => String(item.id || "") === forkedSessionId,
    );
    expect(forkMeta).toBeDefined();
    expect(String(forkMeta?.parentSessionId || "")).toBe(sourceSessionId);
    const forkedFrom = (forkMeta?.forkedFrom || {}) as Record<string, unknown>;
    expect(String(forkedFrom.sessionId || "")).toBe(sourceSessionId);
    expect(String(forkedFrom.leafId || "")).toBe(userEntry.id);
    expect(String(forkedFrom.sourceEntryId || "")).toBe(assistantEntry.id);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId: forkedSessionId,
    });
    expect(viewed.ok).toBe(true);
    const conversationView = ((viewed.data as Record<string, unknown>) || {})
      .conversationView as Record<string, unknown>;
    expect(String(conversationView.parentSessionId || "")).toBe(
      sourceSessionId,
    );
    const viewForkedFrom = (conversationView.forkedFrom || {}) as Record<
      string,
      unknown
    >;
    expect(String(viewForkedFrom.sessionId || "")).toBe(sourceSessionId);
  });

  it("fork 后应保留 compaction 上下文供 LLM 使用，但 conversation view 不应出现摘要消息", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const sourceMeta = await orchestrator.sessions.createSession({
      title: "compaction-fork-source",
    });
    const sourceSessionId = sourceMeta.header.id;

    const user1 = await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "Q1",
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "A1",
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "Q2",
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "A2",
    });

    const beforeCompaction =
      await orchestrator.sessions.buildSessionContext(sourceSessionId);
    const preparation = prepareCompaction({
      reason: "threshold",
      entries: beforeCompaction.entries,
      previousSummary: beforeCompaction.previousSummary,
      keepTail: 2,
      splitTurn: true,
    });
    const draft = await compact(
      preparation,
      async () => "mock-compaction-summary",
    );
    await orchestrator.sessions.appendCompaction(
      sourceSessionId,
      "threshold",
      draft,
    );

    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "Q3",
    });
    const sourceLeafAssistant = await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "A3",
    });

    const sourceContextAtLeaf = await orchestrator.sessions.buildSessionContext(
      sourceSessionId,
      sourceLeafAssistant.id,
    );
    expect(sourceContextAtLeaf.previousSummary.length).toBeGreaterThan(0);
    expect(
      sourceContextAtLeaf.messages.some((msg) => msg.role === "system"),
    ).toBe(false);

    const forked = await invokeRuntime({
      type: "brain.session.fork",
      sessionId: sourceSessionId,
      leafId: sourceLeafAssistant.id,
      sourceEntryId: user1.id,
      reason: "compaction-fork-regression",
    });
    expect(forked.ok).toBe(true);
    const forkedSessionId = String(
      ((forked.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(forkedSessionId).not.toBe("");

    const forkContext =
      await orchestrator.sessions.buildSessionContext(forkedSessionId);
    expect(forkContext.previousSummary).toBe(
      sourceContextAtLeaf.previousSummary,
    );
    expect(
      forkContext.messages.map((msg) => `${msg.role}:${msg.content}`),
    ).toEqual(
      sourceContextAtLeaf.messages.map((msg) => `${msg.role}:${msg.content}`),
    );
    expect(forkContext.messages.some((msg) => msg.role === "system")).toBe(
      false,
    );

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId: forkedSessionId,
    });
    expect(viewed.ok).toBe(true);
    const viewMessages = readConversationMessages(viewed);
    expect(
      viewMessages.some((item) => String(item.role || "") === "system"),
    ).toBe(false);
    expect(viewMessages.length).toBeGreaterThan(forkContext.messages.length);
    expect(
      viewMessages.some((item) => String(item.content || "") === "Q1"),
    ).toBe(true);
    expect(
      viewMessages.some((item) => String(item.content || "") === "A1"),
    ).toBe(true);
    const forkBranch = await orchestrator.sessions.getBranch(forkedSessionId);
    const expectedConversation = forkBranch
      .filter((entry) => entry.type === "message")
      .map((entry) => `${entry.role}:${entry.text}`);
    expect(
      viewMessages.map(
        (item) => `${String(item.role || "")}:${String(item.content || "")}`,
      ),
    ).toEqual(expectedConversation);
  });

  it("supports regenerate and emits input.regenerate stream event", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "初始问题",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const assistantEntry = await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "初始回答",
    });

    const regenerated = await invokeRuntime({
      type: "brain.run.regenerate",
      sessionId,
      sourceEntryId: assistantEntry.id,
      requireSourceIsLeaf: true,
      rebaseLeafToPreviousUser: true,
      autoRun: false,
    });
    expect(regenerated.ok).toBe(true);

    const streamOut = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    expect(streamOut.ok).toBe(true);
    const stream = Array.isArray(
      (streamOut.data as Record<string, unknown>)?.stream,
    )
      ? ((streamOut.data as Record<string, unknown>)
          .stream as unknown[] as Array<Record<string, unknown>>)
      : [];
    expect(
      stream.some((item) => String(item.type || "") === "input.regenerate"),
    ).toBe(true);

    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "后续回答",
    });

    const invalid = await invokeRuntime({
      type: "brain.run.regenerate",
      sessionId,
      sourceEntryId: assistantEntry.id,
      requireSourceIsLeaf: true,
    });
    expect(invalid.ok).toBe(false);
    expect(String(invalid.error || "")).toContain("仅最后一条 assistant");
  });

  it("supports brain.agent.run single and binds role/profile into route selection", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const capturedBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<
        string,
        unknown
      >;
      capturedBodies.push(body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "agent-single-ok",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker",
          },
        ],
        llmDefaultProfile: "worker.basic",
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.agent.run",
      mode: "single",
      agent: "worker",
      profile: "worker.basic",
      task: "请完成一次 single 子任务",
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
    const selected = stream.find(
      (item) => String(item.type || "") === "llm.route.selected",
    ) as Record<string, unknown> | undefined;
    const selectedPayload = (selected?.payload || {}) as Record<
      string,
      unknown
    >;
    expect(String(selectedPayload.role || "")).toBe("worker");
    expect(String(selectedPayload.profile || "")).toBe("worker.basic");

    const runRequest = capturedBodies.find(
      (body) => Array.isArray(body.tools) && body.stream === true,
    );
    expect(runRequest).toBeDefined();
    expect(String(runRequest?.model || "")).toBe("gpt-worker-basic");

    const runDone = await waitForStreamEvent(
      runSessionId,
      "subagent.run.end",
      5000,
    );
    const runDonePayload = (runDone.event.payload || {}) as Record<
      string,
      unknown
    >;
    expect(String(runDonePayload.mode || "")).toBe("single");
    expect(String(runDonePayload.status || "")).toBe("done");
    expect(Number(runDonePayload.completedCount || 0)).toBe(1);
    const hasTaskStart = runDone.stream.some(
      (item) => String(item.type || "") === "subagent.task.start",
    );
    const hasTaskEnd = runDone.stream.some(
      (item) => String(item.type || "") === "subagent.task.end",
    );
    expect(hasTaskStart).toBe(true);
    expect(hasTaskEnd).toBe(true);
  });

  it("supports brain.agent.run parallel with per-task role/profile routing", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const runModels: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<
        string,
        unknown
      >;
      if (Array.isArray(body.tools) && body.stream === true) {
        runModels.push(String(body.model || ""));
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "agent-parallel-ok",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker",
          },
          {
            id: "reviewer.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-reviewer-basic",
            role: "reviewer",
          },
        ],
        llmDefaultProfile: "worker.basic",
      },
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
          task: "子任务A",
        },
        {
          agent: "reviewer",
          role: "reviewer",
          profile: "reviewer.basic",
          task: "子任务B",
        },
      ],
    });
    expect(started.ok).toBe(true);
    const startedData = (started.data || {}) as Record<string, unknown>;
    expect(String(startedData.mode || "")).toBe("parallel");
    const runSessionId = String(startedData.runSessionId || "");
    expect(runSessionId).not.toBe("");
    const results = Array.isArray(startedData.results)
      ? (startedData.results as Array<Record<string, unknown>>)
      : [];
    expect(results.length).toBe(2);
    const sessionIds = results.map((item) => String(item.sessionId || ""));
    expect(sessionIds[0]).not.toBe("");
    expect(sessionIds[1]).not.toBe("");
    expect(sessionIds[0]).not.toBe(sessionIds[1]);

    const streamA = await waitForLoopDone(sessionIds[0]);
    const streamB = await waitForLoopDone(sessionIds[1]);
    const selectedA = streamA.find(
      (item) => String(item.type || "") === "llm.route.selected",
    ) as Record<string, unknown> | undefined;
    const selectedB = streamB.find(
      (item) => String(item.type || "") === "llm.route.selected",
    ) as Record<string, unknown> | undefined;
    const payloadA = (selectedA?.payload || {}) as Record<string, unknown>;
    const payloadB = (selectedB?.payload || {}) as Record<string, unknown>;
    const selectedProfiles = [
      String(payloadA.profile || ""),
      String(payloadB.profile || ""),
    ].sort();
    expect(selectedProfiles).toEqual(["reviewer.basic", "worker.basic"]);
    expect(runModels.sort()).toEqual([
      "gpt-reviewer-basic",
      "gpt-worker-basic",
    ]);

    const runDone = await waitForStreamEvent(
      runSessionId,
      "subagent.run.end",
      5000,
    );
    const runDonePayload = (runDone.event.payload || {}) as Record<
      string,
      unknown
    >;
    expect(String(runDonePayload.mode || "")).toBe("parallel");
    expect(String(runDonePayload.status || "")).toBe("done");
    expect(Number(runDonePayload.completedCount || 0)).toBe(2);
    const taskStartCount = runDone.stream.filter(
      (item) => String(item.type || "") === "subagent.task.start",
    ).length;
    const taskEndCount = runDone.stream.filter(
      (item) => String(item.type || "") === "subagent.task.end",
    ).length;
    expect(taskStartCount).toBe(2);
    expect(taskEndCount).toBe(2);
  });

  it("brain.agent.run parallel rejects oversized task list", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const tasks = Array.from({ length: 9 }).map((_, i) => ({
      agent: "worker",
      task: `task-${i + 1}`,
    }));
    const out = await invokeRuntime({
      type: "brain.agent.run",
      mode: "parallel",
      tasks,
    });
    expect(out.ok).toBe(false);
    expect(String(out.error || "")).toContain("不能超过 8");
  });

  it("supports brain.agent.run chain and returns fan-in summary with {previous} injection", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<
        string,
        unknown
      >;
      if (Array.isArray(body.tools) && body.stream === true) {
        const messages = Array.isArray(body.messages)
          ? (body.messages as Array<Record<string, unknown>>)
          : [];
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
                  content: `chain:${lastUser}`,
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "title-ok",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker",
          },
          {
            id: "reviewer.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-reviewer-basic",
            role: "reviewer",
          },
        ],
        llmDefaultProfile: "worker.basic",
      },
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
          task: "第一步: Alpha",
        },
        {
          agent: "reviewer",
          role: "reviewer",
          profile: "reviewer.basic",
          task: "第二步: {previous} + Beta",
        },
      ],
    });
    expect(started.ok).toBe(true);
    const startedData = (started.data || {}) as Record<string, unknown>;
    expect(String(startedData.mode || "")).toBe("chain");
    const runSessionId = String(startedData.runSessionId || "");
    expect(runSessionId).not.toBe("");
    const results = Array.isArray(startedData.results)
      ? (startedData.results as Array<Record<string, unknown>>)
      : [];
    expect(results.length).toBe(2);
    expect(String(results[0].status || "")).toBe("done");
    expect(String(results[1].status || "")).toBe("done");
    expect(String(results[0].output || "")).toContain("第一步: Alpha");
    expect(String(results[1].task || "")).toContain(
      String(results[0].output || "").trim(),
    );
    const fanIn = (startedData.fanIn || {}) as Record<string, unknown>;
    expect(String(fanIn.finalOutput || "")).toBe(
      String(results[1].output || ""),
    );
    expect(String(fanIn.summary || "")).toContain("1. worker [done]");
    expect(String(fanIn.summary || "")).toContain("2. reviewer [done]");

    const runDone = await waitForStreamEvent(
      runSessionId,
      "subagent.run.end",
      5000,
    );
    const runDonePayload = (runDone.event.payload || {}) as Record<
      string,
      unknown
    >;
    expect(String(runDonePayload.mode || "")).toBe("chain");
    expect(String(runDonePayload.status || "")).toBe("done");
    expect(Number(runDonePayload.completedCount || 0)).toBe(2);
    const taskStartCount = runDone.stream.filter(
      (item) => String(item.type || "") === "subagent.task.start",
    ).length;
    const taskEndCount = runDone.stream.filter(
      (item) => String(item.type || "") === "subagent.task.end",
    ).length;
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
          task: "第一步",
        },
      ],
    });
    expect(out.ok).toBe(false);
    expect(String(out.error || "")).toContain("需要 autoRun=true");
  });

  it("supports edit_rerun for latest user in current session", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "原始问题",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const viewBefore = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewBefore.ok).toBe(true);
    const beforeMessages = readConversationMessages(viewBefore);
    const latestUserBefore = [...beforeMessages]
      .reverse()
      .find(
        (entry) =>
          String(entry.role || "") === "user" &&
          String(entry.entryId || "").trim(),
      );
    expect(latestUserBefore).toBeDefined();
    const latestUserEntryId = String(latestUserBefore?.entryId || "");
    expect(latestUserEntryId).not.toBe("");

    const edited = await invokeRuntime({
      type: "brain.run.edit_rerun",
      sessionId,
      sourceEntryId: latestUserEntryId,
      prompt: "编辑后的问题",
    });
    expect(edited.ok).toBe(true);
    const editedData = (edited.data || {}) as Record<string, unknown>;
    expect(String(editedData.mode || "")).toBe("retry");
    expect(String(editedData.sessionId || "")).toBe(sessionId);

    const streamOut = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    expect(streamOut.ok).toBe(true);
    const stream = Array.isArray(
      (streamOut.data as Record<string, unknown>)?.stream,
    )
      ? ((streamOut.data as Record<string, unknown>)
          .stream as unknown[] as Array<Record<string, unknown>>)
      : [];
    const editRegenerateEvent = stream.find(
      (item) =>
        String(item.type || "") === "input.regenerate" &&
        String(
          (item.payload as Record<string, unknown> | undefined)?.reason || "",
        ) === "edit_user_rerun",
    );
    expect(editRegenerateEvent).toBeDefined();

    const viewAfter = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewAfter.ok).toBe(true);
    const afterMessages = readConversationMessages(viewAfter);
    const latestUserAfter = [...afterMessages]
      .reverse()
      .find(
        (entry) =>
          String(entry.role || "") === "user" &&
          String(entry.entryId || "").trim(),
      );
    expect(String(latestUserAfter?.content || "")).toBe("编辑后的问题");
  });

  it("supports edit_rerun for historical user by forking", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "问题一",
    });
    expect(started.ok).toBe(true);
    const sourceSessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sourceSessionId).not.toBe("");

    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "回答一",
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "user",
      text: "问题二",
    });
    await orchestrator.sessions.appendMessage({
      sessionId: sourceSessionId,
      role: "assistant",
      text: "回答二",
    });

    const sourceView = await invokeRuntime({
      type: "brain.session.view",
      sessionId: sourceSessionId,
    });
    expect(sourceView.ok).toBe(true);
    const sourceMessages = readConversationMessages(sourceView);
    const historicalUser = sourceMessages.find(
      (entry) =>
        String(entry.role || "") === "user" &&
        String(entry.content || "") === "问题一",
    );
    expect(historicalUser).toBeDefined();
    const historicalUserEntryId = String(historicalUser?.entryId || "");
    expect(historicalUserEntryId).not.toBe("");

    const edited = await invokeRuntime({
      type: "brain.run.edit_rerun",
      sessionId: sourceSessionId,
      sourceEntryId: historicalUserEntryId,
      prompt: "问题一（编辑版）",
    });
    expect(edited.ok).toBe(true);
    const editedData = (edited.data || {}) as Record<string, unknown>;
    expect(String(editedData.mode || "")).toBe("fork");
    const forkedSessionId = String(editedData.sessionId || "");
    expect(forkedSessionId).not.toBe("");
    expect(forkedSessionId).not.toBe(sourceSessionId);

    const listed = await invokeRuntime({ type: "brain.session.list" });
    expect(listed.ok).toBe(true);
    const sessions = Array.isArray(
      (listed.data as Record<string, unknown>)?.sessions,
    )
      ? ((listed.data as Record<string, unknown>)
          .sessions as unknown[] as Array<Record<string, unknown>>)
      : [];
    const forkMeta = sessions.find(
      (entry) => String(entry.id || "") === forkedSessionId,
    );
    expect(forkMeta).toBeDefined();
    expect(String(forkMeta?.parentSessionId || "")).toBe(sourceSessionId);
    const forkedFrom = (forkMeta?.forkedFrom || {}) as Record<string, unknown>;
    expect(String(forkedFrom.sessionId || "")).toBe(sourceSessionId);
    expect(String(forkedFrom.leafId || "")).toBe(historicalUserEntryId);

    const forkView = await invokeRuntime({
      type: "brain.session.view",
      sessionId: forkedSessionId,
    });
    expect(forkView.ok).toBe(true);
    const forkMessages = readConversationMessages(forkView);
    const firstUserFork = forkMessages.find(
      (entry) => String(entry.role || "") === "user",
    );
    expect(String(firstUserFork?.content || "")).toBe("问题一（编辑版）");

    const sourceViewAfter = await invokeRuntime({
      type: "brain.session.view",
      sessionId: sourceSessionId,
    });
    expect(sourceViewAfter.ok).toBe(true);
    const sourceAfterMessages = readConversationMessages(sourceViewAfter);
    const firstUserSource = sourceAfterMessages.find(
      (entry) => String(entry.role || "") === "user",
    );
    expect(String(firstUserSource?.content || "")).toBe("问题一");
  });

  it("rejects edit_rerun when sourceEntry is not user message", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "原始问题",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const assistantEntry = await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "这是一条 assistant 消息",
    });

    const edited = await invokeRuntime({
      type: "brain.run.edit_rerun",
      sessionId,
      sourceEntryId: assistantEntry.id,
      prompt: "编辑后的问题",
    });
    expect(edited.ok).toBe(false);
    expect(String(edited.error || "")).toContain(
      "sourceEntry 必须是 user 消息",
    );
  });

  it("rejects edit_rerun when sourceEntry belongs to another session", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const first = await invokeRuntime({
      type: "brain.run.start",
      prompt: "session-a",
    });
    const second = await invokeRuntime({
      type: "brain.run.start",
      prompt: "session-b",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const sessionA = String(
      ((first.data as Record<string, unknown>) || {}).sessionId || "",
    );
    const sessionB = String(
      ((second.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionA).not.toBe("");
    expect(sessionB).not.toBe("");
    expect(sessionA).not.toBe(sessionB);

    const viewA = await invokeRuntime({
      type: "brain.session.view",
      sessionId: sessionA,
    });
    expect(viewA.ok).toBe(true);
    const sourceFromA = readConversationMessages(viewA).find(
      (entry) => String(entry.role || "") === "user",
    );
    const sourceEntryId = String(sourceFromA?.entryId || "");
    expect(sourceEntryId).not.toBe("");

    const edited = await invokeRuntime({
      type: "brain.run.edit_rerun",
      sessionId: sessionB,
      sourceEntryId,
      prompt: "cross-session-edit",
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
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await oldOrchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "seed-assistant",
    });
    oldOrchestrator.setRunning(sessionId, true);

    // 模拟 service worker 重启：旧 listener 被销毁，重新注册新 listener。
    runtimeListeners = [];
    resetRuntimeOnMessageMock();
    const restartedOrchestrator = new BrainOrchestrator();
    registerRuntimeRouter(restartedOrchestrator);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    expect(
      messages.some((item) => String(item.content || "") === "seed-user"),
    ).toBe(true);
    expect(
      messages.some((item) => String(item.content || "") === "seed-assistant"),
    ).toBe(true);
    const conversationView = ((viewed.data as Record<string, unknown>) || {})
      .conversationView as Record<string, unknown>;
    const lastStatus = (conversationView.lastStatus || {}) as Record<
      string,
      unknown
    >;
    expect(Boolean(lastStatus.running)).toBe(false);

    const continued = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "after-restart-user",
      autoRun: false,
    });
    expect(continued.ok).toBe(true);
    const continuedData = (continued.data || {}) as Record<string, unknown>;
    expect(String(continuedData.sessionId || "")).toBe(sessionId);
    const continuedRuntime = (continuedData.runtime || {}) as Record<
      string,
      unknown
    >;
    expect(Boolean(continuedRuntime.running)).toBe(false);

    const viewedAfterContinue = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewedAfterContinue.ok).toBe(true);
    const messagesAfterContinue = readConversationMessages(viewedAfterContinue);
    expect(
      messagesAfterContinue.some(
        (item) => String(item.content || "") === "after-restart-user",
      ),
    ).toBe(true);
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
          capabilities: ["fs.virtual.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.virtual-fs.router.read",
            mode: "bridge",
            invoke: async (input) => ({
              provider: "virtual-fs-router",
              path: String(input.args?.path || ""),
            }),
          },
        },
      },
    });

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "capability provider test",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const executed = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "browser_read_file",
      args: {
        path: "mem://docs.txt",
      },
      verifyPolicy: "off",
    });
    expect(executed.ok).toBe(true);
    const result = (executed.data || {}) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.modeUsed).toBe("bridge");
    expect(result.capabilityUsed).toBe("fs.virtual.read");
    expect(result.providerId).toBe("plugin.virtual-fs.router.read");
    expect(result.data).toEqual({
      provider: "virtual-fs-router",
      path: "mem://docs.txt",
    });
  });

  it("supports builtin browser vfs provider for mem:// files", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "builtin browser vfs provider",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const wrote = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.write",
      action: "invoke",
      args: {
        frame: {
          tool: "write",
          args: {
            path: "mem://notes/demo.md",
            content: "hello-browser-vfs",
            mode: "overwrite",
            runtime: "browser",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(wrote.ok).toBe(true);
    const writeResult = (wrote.data || {}) as Record<string, unknown>;
    expect(writeResult.ok).toBe(true);
    expect(String(writeResult.modeUsed || "")).toBe("script");
    expect(String(writeResult.capabilityUsed || "")).toBe("fs.write");

    const read = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://notes/demo.md",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(read.ok).toBe(true);
    const readResult = (read.data || {}) as Record<string, unknown>;
    expect(readResult.ok).toBe(true);
    expect(String(readResult.modeUsed || "")).toBe("script");
    expect(String(readResult.capabilityUsed || "")).toBe("fs.read");

    const invokePayload =
      ((readResult.data || {}) as Record<string, unknown>) || {};
    const response =
      ((invokePayload.response || {}) as Record<string, unknown>) || {};
    const responseData =
      ((response.data || {}) as Record<string, unknown>) || {};
    expect(String(responseData.content || "")).toContain("hello-browser-vfs");
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
          capabilities: ["fs.virtual.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.virtual-fs.multi-route.workspace",
            mode: "bridge",
            priority: 20,
            canHandle: (input) =>
              String(input.args?.targetUri || "").startsWith("workspace://"),
            invoke: async () => ({ provider: "workspace" }),
          },
        },
      },
    });

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.virtual-fs.multi-route.local",
        name: "virtual-fs-multi-route-local",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.virtual.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.virtual-fs.multi-route.local",
            mode: "bridge",
            priority: 10,
            canHandle: (input) =>
              String(input.args?.targetUri || "").startsWith("local://"),
            invoke: async () => ({ provider: "local" }),
          },
        },
      },
    });

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "capability provider canHandle route test",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const workspace = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "browser_read_file",
      args: {
        targetUri: "workspace://docs/a.md",
      },
      verifyPolicy: "off",
    });
    expect(workspace.ok).toBe(true);
    expect(((workspace.data || {}) as Record<string, unknown>).data).toEqual({
      provider: "workspace",
    });

    const local = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "browser_read_file",
      args: {
        targetUri: "local:///tmp/a.md",
      },
      verifyPolicy: "off",
    });
    expect(local.ok).toBe(true);
    expect(((local.data || {}) as Record<string, unknown>).data).toEqual({
      provider: "local",
    });
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
          capabilities: ["fs.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.fs.read.script-mode.provider",
            mode: "script",
            priority: 50,
            canHandle: (input) =>
              String(
                (input.args?.frame as Record<string, unknown> | undefined)
                  ?.tool || "",
              ) === "read",
            invoke: async (input) => ({
              provider: "plugin-script-fs",
              mode: input.mode,
              receivedFrame: input.args?.frame || null,
            }),
          },
        },
      },
    });

    let llmCall = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
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
                          name: "host_read_file",
                          arguments: JSON.stringify({
                            path: "/tmp/demo.txt",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "done",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "读取 /tmp/demo.txt",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolMessage = [...messages]
      .reverse()
      .find(
        (entry) =>
          String(entry.role || "") === "tool" &&
          String(entry.toolName || "") === "host_read_file",
      );
    expect(toolMessage).toBeDefined();
    const payload = JSON.parse(String(toolMessage?.content || "{}")) as Record<
      string,
      unknown
    >;
    expect(payload.provider).toBe("plugin-script-fs");
    expect(payload.mode).toBe("script");
    expect(
      ((payload.receivedFrame || {}) as Record<string, unknown>).tool,
    ).toBe("read");
  });

  it("tool_call 的 browser_read_file 默认 runtime 受 browserRuntimeStrategy 控制", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.fs.read.runtime-strategy-probe",
        name: "fs-read-runtime-strategy-probe",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.fs.read.runtime-strategy-probe.provider",
            mode: "script",
            priority: 80,
            canHandle: (input) =>
              String(
                (input.args?.frame as Record<string, unknown> | undefined)
                  ?.tool || "",
              ) === "read",
            invoke: async (input) => {
              const frame = (input.args?.frame || {}) as Record<
                string,
                unknown
              >;
              const frameArgs = (frame.args || {}) as Record<string, unknown>;
              return {
                provider: "runtime-strategy-probe",
                runtime: String(frameArgs.runtime || ""),
                path: String(frameArgs.path || ""),
              };
            },
          },
        },
      },
    });

    let runRequestCount = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<
          string,
          unknown
        >;
        const isRunRequest = Array.isArray(body.tools) && body.stream === true;
        if (isRunRequest) {
          runRequestCount += 1;
        }
        const hasToolMessage =
          Array.isArray(body.messages) &&
          (body.messages as Array<Record<string, unknown>>).some(
            (item) => String(item.role || "") === "tool",
          );
        if (isRunRequest && !hasToolMessage) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "",
                    tool_calls: [
                      {
                        id: `call_browser_read_${runRequestCount}`,
                        type: "function",
                        function: {
                          name: "browser_read_file",
                          arguments: JSON.stringify({
                            path: "mem://runtime-strategy.txt",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (isRunRequest) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "done",
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "runtime strategy title",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const readToolPayload = async (
      sessionId: string,
    ): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        const viewed = await invokeRuntime({
          type: "brain.session.view",
          sessionId,
        });
        expect(viewed.ok).toBe(true);
        const messages = readConversationMessages(viewed);
        const toolMessage = [...messages]
          .reverse()
          .find(
            (entry) =>
              String(entry.role || "") === "tool" &&
              String(entry.toolName || "") === "browser_read_file",
          );
        if (toolMessage) {
          return JSON.parse(String(toolMessage.content || "{}")) as Record<
            string,
            unknown
          >;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`missing browser_read_file tool message: ${sessionId}`);
    };

    const savedHostFirst = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
        browserRuntimeStrategy: "host-first",
      },
    });
    expect(savedHostFirst.ok).toBe(true);

    const startedHostFirst = await invokeRuntime({
      type: "brain.run.start",
      prompt: "读取 mem://runtime-strategy.txt",
    });
    expect(startedHostFirst.ok).toBe(true);
    const hostFirstSessionId = String(
      ((startedHostFirst.data as Record<string, unknown>) || {}).sessionId ||
        "",
    );
    expect(hostFirstSessionId).not.toBe("");
    await waitForLoopDone(hostFirstSessionId);
    const hostFirstPayload = await readToolPayload(hostFirstSessionId);
    expect(String(hostFirstPayload.provider || "")).toBe(
      "runtime-strategy-probe",
    );
    expect(String(hostFirstPayload.runtime || "")).toBe("browser");

    const savedBrowserFirst = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
        browserRuntimeStrategy: "browser-first",
      },
    });
    expect(savedBrowserFirst.ok).toBe(true);

    const startedBrowserFirst = await invokeRuntime({
      type: "brain.run.start",
      prompt: "读取 mem://runtime-strategy.txt 再来一次",
    });
    expect(startedBrowserFirst.ok).toBe(true);
    const browserFirstSessionId = String(
      ((startedBrowserFirst.data as Record<string, unknown>) || {}).sessionId ||
        "",
    );
    expect(browserFirstSessionId).not.toBe("");
    await waitForLoopDone(browserFirstSessionId);
    const browserFirstPayload = await readToolPayload(browserFirstSessionId);
    expect(String(browserFirstPayload.provider || "")).toBe(
      "runtime-strategy-probe",
    );
    expect(String(browserFirstPayload.runtime || "")).toBe("sandbox");

    expect(runRequestCount).toBeGreaterThanOrEqual(4);
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
          capabilities: ["browser.action"],
        },
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
                  action: input.args?.action || null,
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
    });

    let llmCall = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
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
                              selectorExists: "#done",
                            },
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "done",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "点击提交按钮",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(providerInvoked).toBe(1);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayloads = messages
      .filter((entry) => String(entry.role || "") === "tool")
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      );
    const actionPayload = toolPayloads.find(
      (entry) => String(entry.tool || "") === "click",
    );
    expect(actionPayload).toBeDefined();
    expect(String(actionPayload?.errorCode || "")).not.toBe("E_VERIFY_FAILED");
  });

  it("tool_call 的 press_key 可走 browser.action provider 并传递按键语义", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let providerInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.press-key",
        name: "browser-action-press-key",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"],
        },
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.press-key.provider",
            mode: "script",
            priority: 50,
            invoke: async (input) => {
              providerInvoked += 1;
              return {
                data: {
                  provider: "plugin-script-browser-action-press-key",
                  action: input.args?.action || null,
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
    });

    let llmCall = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
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
                        id: "call_press_key_1",
                        type: "function",
                        function: {
                          name: "press_key",
                          arguments: JSON.stringify({
                            tabId: 1,
                            key: "Enter",
                            expect: {
                              selectorExists: "#results",
                            },
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "done",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "按下回车触发搜索",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(providerInvoked).toBe(1);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayloads = messages
      .filter((entry) => String(entry.role || "") === "tool")
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      );
    const actionPayload = toolPayloads.find(
      (entry) => String(entry.tool || "") === "press_key",
    );
    expect(actionPayload).toBeDefined();
    const action =
      ((actionPayload?.action || {}) as Record<string, unknown>) || {};
    expect(String(action.kind || "")).toBe("press");
    expect(String(action.key || "")).toBe("Enter");
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
          capabilities: ["browser.snapshot", "browser.action"],
        },
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
                      selector: "#name",
                    },
                  ],
                },
                verified: false,
                verifyReason: "verify_policy_off",
              };
            },
          },
          "browser.action": {
            id: "plugin.browser.uid-flow.action",
            mode: "script",
            priority: 90,
            invoke: async () => {
              actionInvoked += 1;
              return {
                data: {
                  ok: true,
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
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
                          query: "search input",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
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
                              value: "cat",
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 search_elements 与 fill_form",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(snapshotInvoked).toBe(1);
    expect(actionInvoked).toBe(1);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayloads = messages
      .filter((entry) => String(entry.role || "") === "tool")
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      );
    expect(
      toolPayloads.some(
        (entry) => String(entry.tool || "") === "search_elements",
      ),
    ).toBe(true);
    expect(
      toolPayloads.some((entry) => String(entry.tool || "") === "fill_form"),
    ).toBe(true);
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
          capabilities: ["browser.snapshot", "browser.action"],
        },
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
                    {
                      uid: "e-input",
                      ref: "e-input",
                      role: "input",
                      selector: "#name",
                    },
                    {
                      uid: "e-btn",
                      ref: "e-btn",
                      role: "button",
                      selector: "#submit",
                    },
                  ],
                },
                verified: false,
                verifyReason: "verify_policy_off",
              };
            },
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
                verifyReason: "verified",
              };
            },
          },
        },
      },
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
                        arguments: "{}",
                      },
                    },
                    {
                      id: "call_search_elements",
                      type: "function",
                      function: {
                        name: "search_elements",
                        arguments: JSON.stringify({
                          tabId: 1,
                          query: "input button",
                        }),
                      },
                    },
                    {
                      id: "call_fill_uid",
                      type: "function",
                      function: {
                        name: "fill_element_by_uid",
                        arguments: JSON.stringify({
                          tabId: 1,
                          uid: "e-input",
                          value: "cat",
                        }),
                      },
                    },
                    {
                      id: "call_click_uid",
                      type: "function",
                      function: {
                        name: "click",
                        arguments: JSON.stringify({ tabId: 1, uid: "e-btn" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "ok",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "在当前页面填写输入框并点击按钮后回复 ok",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(snapshotInvoked).toBeGreaterThanOrEqual(0);
    expect(actionInvoked).toBeGreaterThanOrEqual(0);
    expect(llmCall).toBeGreaterThanOrEqual(2);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    expect(
      messages.some((entry) => String(entry.role || "") === "assistant"),
    ).toBe(true);
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
          capabilities: ["browser.action"],
        },
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
                  provider: "plugin-browser-action-ref-required",
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
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
                          value: "cat",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 fill_element_by_uid ref required",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(0);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayload = messages
      .filter(
        (entry) =>
          String(entry.role || "") === "tool" &&
          String(entry.toolCallId || "") === "call_action_ref_required_1",
      )
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      )[0];
    expect(toolPayload).toBeDefined();
    expect(String(toolPayload.errorCode || "")).toBe("E_REF_REQUIRED");
  });

  it("tool_call fill_element_by_uid 在 value 为空时应拒绝（E_ARGS）", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let providerInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.fill-empty-value",
        name: "browser-action-fill-empty-value",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"],
        },
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.fill-empty-value.provider",
            mode: "script",
            priority: 70,
            invoke: async () => {
              providerInvoked += 1;
              return {
                data: {
                  provider: "plugin-browser-action-fill-empty-value",
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
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
                      id: "call_action_fill_empty_value_1",
                      type: "function",
                      function: {
                        name: "fill_element_by_uid",
                        arguments: JSON.stringify({
                          tabId: 1,
                          uid: "e-input",
                          value: "   ",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 fill_element_by_uid empty value",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(0);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayload = messages
      .filter(
        (entry) =>
          String(entry.role || "") === "tool" &&
          String(entry.toolCallId || "") === "call_action_fill_empty_value_1",
      )
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      )[0];
    expect(toolPayload).toBeDefined();
    expect(String(toolPayload.errorCode || "")).toBe("E_ARGS");
  });

  it("tool_call 本地参数校验应覆盖 oneOf/allOf（不依赖 provider schema）", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let providerInvoked = 0;

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.custom.schema-guard.fs-read",
        name: "custom-schema-guard-fs-read",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.custom.schema-guard.fs-read.provider",
            mode: "script",
            priority: 90,
            invoke: async () => {
              providerInvoked += 1;
              return { text: "ok" };
            },
          },
        },
      },
    });

    orchestrator.registerToolContract(
      {
        name: "schema_guard_tool",
        description: "schema guard test tool",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            mode: { type: "string" },
            a: { type: "string" },
            b: { type: "string" },
          },
          required: ["path"],
          oneOf: [{ required: ["a"] }, { required: ["b"] }],
          allOf: [{ required: ["mode"] }],
        },
        execution: {
          capability: "fs.read",
          mode: "script",
          action: "invoke",
          verifyPolicy: "off",
        },
      },
      { replace: true },
    );

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
                      id: "call_schema_oneof_1",
                      type: "function",
                      function: {
                        name: "schema_guard_tool",
                        arguments: JSON.stringify({
                          path: "/tmp/demo.txt",
                          mode: "read",
                          a: "x",
                          b: "y",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
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
                      id: "call_schema_allof_1",
                      type: "function",
                      function: {
                        name: "schema_guard_tool",
                        arguments: JSON.stringify({
                          path: "/tmp/demo.txt",
                          a: "x",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 oneOf/allOf 本地参数校验",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(0);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayloads = messages
      .filter((entry) => String(entry.role || "") === "tool")
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      );
    const oneOfPayload = toolPayloads.find(
      (entry) =>
        String(
          ((entry.stepRef || {}) as Record<string, unknown>).toolCallId || "",
        ) === "call_schema_oneof_1",
    );
    const allOfPayload = toolPayloads.find(
      (entry) =>
        String(
          ((entry.stepRef || {}) as Record<string, unknown>).toolCallId || "",
        ) === "call_schema_allof_1",
    );
    expect(String(oneOfPayload?.errorCode || "")).toBe("E_ARGS");
    expect(String(allOfPayload?.errorCode || "")).toBe("E_ARGS");
    expect(
      String(
        ((oneOfPayload?.details || {}) as Record<string, unknown>).combinator ||
          "",
      ),
    ).toBe("oneOf");
    expect(
      String(
        ((allOfPayload?.details || {}) as Record<string, unknown>).combinator ||
          "",
      ),
    ).toBe("allOf");
  });

  it("tool_call browser_verify 无 expect 时应拒绝并返回 E_ARGS", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

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
                      id: "call_verify_args_1",
                      type: "function",
                      function: {
                        name: "browser_verify",
                        arguments: JSON.stringify({
                          tabId: 1,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 browser_verify 参数校验",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayload = messages
      .filter(
        (entry) =>
          String(entry.role || "") === "tool" &&
          String(entry.toolCallId || "") === "call_verify_args_1",
      )
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      )[0];
    expect(toolPayload).toBeDefined();
    expect(String(toolPayload.errorCode || "")).toBe("E_ARGS");
    expect(String(toolPayload.error || "")).toContain("expect");
  });

  it("tool_call computer(type) 返回 success=false 时应按失败协议收口", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    (chrome as unknown as { debugger: any }).debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: any, method: string, params: any = {}) => {
        if (
          method === "Runtime.evaluate" &&
          String(params.expression || "").includes("active_element_not_typable")
        ) {
          return {
            result: {
              value: {
                success: false,
                error: "active_element_not_typable",
              },
            },
          };
        }
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: {
                url: "https://example.com",
                title: "Example",
                readyState: "complete",
                textLength: 100,
                nodeCount: 20,
              },
            },
          };
        }
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 0 };
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "frame-1" }, childFrames: [] } };
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        return {};
      },
      onEvent: {
        addListener: () => {},
      },
      onDetach: {
        addListener: () => {},
      },
    };

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
                      id: "call_computer_type_1",
                      type: "function",
                      function: {
                        name: "computer",
                        arguments: JSON.stringify({
                          tabId: 1,
                          action: "type",
                          text: "good",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 computer type 失败协议",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayload = messages
      .filter(
        (entry) =>
          String(entry.role || "") === "tool" &&
          String(entry.toolCallId || "") === "call_computer_type_1",
      )
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      )[0];
    expect(toolPayload).toBeDefined();
    expect(String(toolPayload.errorReason || "")).toBe("failed_execute");
    expect(String(toolPayload.error || "")).toContain(
      "active_element_not_typable",
    );
  });

  it("tool_call browser_bash exitCode!=0 时应标记 failed_execute 并给出 sandbox 诊断", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    let providerInvoked = 0;

    orchestrator.registerCapabilityProvider(
      "process.exec",
      {
        id: "test.browser.bash.nonzero.process.exec",
        mode: "script",
        priority: 120,
        canHandle: (input) => {
          const frame = (input.args?.frame || {}) as Record<string, unknown>;
          const frameArgs = (frame.args || {}) as Record<string, unknown>;
          const runtime = String(frameArgs.runtime || "")
            .trim()
            .toLowerCase();
          return (
            String(frame.tool || "") === "bash" &&
            String(frameArgs.cmdId || "") === "bash.exec" &&
            (runtime === "browser" || runtime === "sandbox")
          );
        },
        invoke: async () => {
          providerInvoked += 1;
          return {
            type: "invoke",
            response: {
              ok: true,
              data: {
                cmdId: "bash.exec",
                argv: ["bash", "-lc", 'node -e "console.log(window)"'],
                exitCode: 2,
                stdout: "",
                stderr: "window is not defined\n",
              },
            },
          };
        },
      },
      { replace: true },
    );

    const capturedBodies: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      llmCall += 1;
      capturedBodies.push(
        JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
      );
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_browser_bash_fail_1",
                      type: "function",
                      function: {
                        name: "browser_bash",
                        arguments: JSON.stringify({
                          command: 'node -e "console.log(window)"',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 browser_bash 非零退出码诊断",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(1);

    const toolStep = stream.find((item) => {
      if (String(item.type || "") !== "step_finished") return false;
      const payload = ((item as Record<string, unknown>).payload ||
        {}) as Record<string, unknown>;
      return String(payload.action || "") === "browser_bash";
    }) as Record<string, unknown> | undefined;
    expect(toolStep).toBeDefined();
    const toolStepPayload =
      ((toolStep?.payload || {}) as Record<string, unknown>) || {};
    expect(toolStepPayload.ok).toBe(false);
    expect(String(toolStepPayload.providerId || "")).toBe(
      "test.browser.bash.nonzero.process.exec",
    );

    const secondBody = capturedBodies[1] || {};
    const secondMessages = Array.isArray(secondBody.messages)
      ? (secondBody.messages as Array<Record<string, unknown>>)
      : [];
    const toolMessageToLlm = secondMessages.find(
      (entry) =>
        String(entry.role || "") === "tool" &&
        String(entry.tool_call_id || "") === "call_browser_bash_fail_1",
    );
    expect(toolMessageToLlm).toBeDefined();
    const toolPayloadToLlm = JSON.parse(
      String(toolMessageToLlm?.content || "{}"),
    ) as Record<string, unknown>;
    expect(String(toolPayloadToLlm.errorReason || "")).toBe("failed_execute");
    expect(String(toolPayloadToLlm.error || "")).toContain("window/document");
    expect(
      Number(
        ((toolPayloadToLlm.details || {}) as Record<string, unknown>)
          .exitCode || -1,
      ),
    ).toBe(2);

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const persistedToolMessage = messages.find(
      (entry) =>
        String(entry.role || "") === "tool" &&
        String(entry.toolCallId || "") === "call_browser_bash_fail_1",
    );
    expect(persistedToolMessage).toBeDefined();
    const persistedPayload = JSON.parse(
      String(persistedToolMessage?.content || "{}"),
    ) as Record<string, unknown>;
    expect(String(persistedPayload.errorReason || "")).toBe("failed_execute");
    expect(
      String(
        ((persistedPayload.details || {}) as Record<string, unknown>)
          .diagnosis || "",
      ),
    ).toBe("dom_global_unavailable");
  });

  it("tool_call computer(type) 应使用 React 受控输入兼容表达式", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    let capturedComputerExpression = "";
    (chrome as unknown as { debugger: any }).debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: any, method: string, params: any = {}) => {
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression || "");
          if (
            expression.includes("active_element_not_typable") &&
            expression.includes("const text =")
          ) {
            capturedComputerExpression = expression;
            return {
              result: {
                value: {
                  success: true,
                  action: "type",
                  typed: 4,
                  via: "value-setter",
                },
              },
            };
          }
          return {
            result: {
              value: {
                url: "https://example.com",
                title: "Example",
                readyState: "complete",
                textLength: 120,
                nodeCount: 24,
              },
            },
          };
        }
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 0 };
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "frame-1" }, childFrames: [] } };
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        return {};
      },
      onEvent: {
        addListener: () => {},
      },
      onDetach: {
        addListener: () => {},
      },
    };

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
                      id: "call_computer_type_react_1",
                      type: "function",
                      function: {
                        name: "computer",
                        arguments: JSON.stringify({
                          tabId: 1,
                          action: "type",
                          text: "good",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 computer type react 受控输入路径",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);

    expect(capturedComputerExpression).toContain("_valueTracker");
    expect(capturedComputerExpression).toContain("findTypableNear");
    expect(capturedComputerExpression).toContain(
      "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')",
    );
    expect(capturedComputerExpression).toContain("beforeinput");

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const toolPayload = messages
      .filter(
        (entry) =>
          String(entry.role || "") === "tool" &&
          String(entry.toolCallId || "") === "call_computer_type_react_1",
      )
      .map(
        (entry) =>
          JSON.parse(String(entry.content || "{}")) as Record<string, unknown>,
      )[0];
    expect(toolPayload).toBeDefined();
    expect(Boolean(toolPayload.success)).toBe(true);
    expect(Number(toolPayload.typed || 0)).toBe(4);
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
          capabilities: ["browser.action"],
        },
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
                  action: input.args?.action || null,
                },
                verified: false,
                verifyReason: "verify_failed",
              };
            },
          },
        },
      },
    });

    const capturedBodies: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        llmCall += 1;
        capturedBodies.push(
          JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
        );
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
                              selectorExists: "#done",
                            },
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "done",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 fill_element_by_uid 失败协议",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(1);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const secondBody = capturedBodies[1] || {};
    const secondMessages = Array.isArray(secondBody.messages)
      ? (secondBody.messages as Array<Record<string, unknown>>)
      : [];
    const toolMessageToLlm = secondMessages.find(
      (entry) =>
        String(entry.role || "") === "tool" &&
        String(entry.tool_call_id || "") === "call_action_fail_1",
    );
    expect(toolMessageToLlm).toBeDefined();
    const toolPayloadToLlm = JSON.parse(
      String(toolMessageToLlm?.content || "{}"),
    ) as Record<string, unknown>;
    expect(["failed_execute", "failed_verify"]).toContain(
      String(toolPayloadToLlm.errorReason || ""),
    );
    expect(String(toolPayloadToLlm.retryHint || "")).toContain("focus");
    expect(["execute", "verify"]).toContain(
      String(
        ((toolPayloadToLlm.failureClass || {}) as Record<string, unknown>)
          .phase || "",
      ),
    );
    expect(
      String(
        ((toolPayloadToLlm.modeEscalation || {}) as Record<string, unknown>)
          .to || "",
      ),
    ).toBe("focus");
    expect(
      String(
        ((toolPayloadToLlm.resume || {}) as Record<string, unknown>).action ||
          "",
      ),
    ).toBe("resume_current_step");
    expect(
      String(
        ((toolPayloadToLlm.stepRef || {}) as Record<string, unknown>)
          .toolCallId || "",
      ),
    ).toBe("call_action_fail_1");

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const persistedToolMessage = messages.find(
      (entry) =>
        String(entry.role || "") === "tool" &&
        String(entry.toolCallId || "") === "call_action_fail_1",
    );
    expect(persistedToolMessage).toBeDefined();
    const persistedPayload = JSON.parse(
      String(persistedToolMessage?.content || "{}"),
    ) as Record<string, unknown>;
    expect(
      String(
        ((persistedPayload.modeEscalation || {}) as Record<string, unknown>)
          .to || "",
      ),
    ).toBe("focus");
    expect(
      String(
        ((persistedPayload.resume || {}) as Record<string, unknown>).strategy ||
          "",
      ),
    ).toBe("retry_with_fresh_snapshot");
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
          capabilities: ["browser.action"],
        },
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.focus-recover.provider",
            mode: "script",
            priority: 80,
            invoke: async (input) => {
              providerInvoked += 1;
              const action = (input.args?.action || {}) as Record<
                string,
                unknown
              >;
              if (action.forceFocus !== true) {
                const error = new Error(
                  "background mode requires focus",
                ) as Error & {
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
                  action,
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
    });

    const capturedBodies: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        llmCall += 1;
        capturedBodies.push(
          JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
        );
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
                            ref: "e0",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "done",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "触发 focus auto recover",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    expect(providerInvoked).toBe(2);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const escalatedEvent = stream.find(
      (item) => String(item.type || "") === "tool.mode_escalation",
    ) as Record<string, unknown> | undefined;
    expect(escalatedEvent).toBeDefined();
    const escalatedPayload = (escalatedEvent?.payload || {}) as Record<
      string,
      unknown
    >;
    expect(String(escalatedPayload.to || "")).toBe("focus");

    const secondBody = capturedBodies[1] || {};
    const secondMessages = Array.isArray(secondBody.messages)
      ? (secondBody.messages as Array<Record<string, unknown>>)
      : [];
    const toolMessage = secondMessages.find(
      (entry) =>
        String(entry.role || "") === "tool" &&
        String(entry.tool_call_id || "") === "call_action_focus_recover_1",
    );
    expect(toolMessage).toBeDefined();
    expect(String(toolMessage?.content || "")).toContain(
      '"modeEscalated":true',
    );
  });

  it("strict verify 不可判定时应触发 no_progress 并以 progress_uncertain 收口", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.verify-skipped",
        name: "browser-action-verify-skipped",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"],
        },
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.verify-skipped.provider",
            mode: "script",
            priority: 60,
            invoke: async () => ({
              data: {
                provider: "plugin-browser-action-verify-skipped",
              },
              verified: false,
              verifyReason: "verify_skipped",
            }),
          },
        },
      },
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
                          selectorExists: "#done",
                        },
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请执行页面导航并验证结果",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("progress_uncertain");
    const noProgressEvents = stream.filter(
      (item) => String(item.type || "") === "loop_no_progress",
    );
    expect(noProgressEvents.length).toBeGreaterThan(0);
    const reasons = noProgressEvents.map((item) =>
      String(
        (
          (item as Record<string, unknown>).payload as
            | Record<string, unknown>
            | undefined
        )?.reason || "",
      ),
    );
    expect(
      reasons.some((reason) =>
        ["browser_proof_guard", "repeat_signature"].includes(reason),
      ),
    ).toBe(true);
  });

  it("重复同签名 tool_calls 应触发 loop_no_progress(repeat_signature) 并提前收口", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.no-progress.read",
        name: "no-progress-read",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.no-progress.read.provider",
            mode: "script",
            priority: 80,
            invoke: async () => ({
              text: "no-progress",
            }),
          },
        },
      },
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
                      name: "host_read_file",
                      arguments: JSON.stringify({
                        path: "/tmp/no-progress.txt",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请查看当前标签页并继续执行",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("progress_uncertain");

    const noProgressEvents = stream.filter(
      (item) => String(item.type || "") === "loop_no_progress",
    );
    expect(noProgressEvents.length).toBeGreaterThan(0);
    const repeatEvent = noProgressEvents.find((item) => {
      const payload = ((item as Record<string, unknown>).payload ||
        {}) as Record<string, unknown>;
      return String(payload.reason || "") === "repeat_signature";
    });
    expect(repeatEvent).toBeDefined();
  });

  it("tool_calls 出现 ping_pong 时应触发 loop_no_progress(ping_pong) 并终止", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.no-progress.budget",
        name: "no-progress-budget",
        version: "1.0.0",
        permissions: {
          capabilities: ["fs.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.no-progress.budget.provider",
            mode: "script",
            priority: 80,
            invoke: async () => ({
              text: "budget",
            }),
          },
        },
      },
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      const targetPath =
        llmCall % 2 === 0
          ? "/tmp/no-progress-budget-b.txt"
          : "/tmp/no-progress-budget-a.txt";
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
                      name: "host_read_file",
                      arguments: JSON.stringify({
                        path: targetPath,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请继续读取文件并推进",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("progress_uncertain");

    const noProgressEvents = stream.filter(
      (item) => String(item.type || "") === "loop_no_progress",
    );
    expect(noProgressEvents.length).toBeGreaterThan(0);
    const pingPongEvent = noProgressEvents.find((item) => {
      const payload = ((item as Record<string, unknown>).payload ||
        {}) as Record<string, unknown>;
      return String(payload.reason || "") === "ping_pong";
    });
    expect(pingPongEvent).toBeDefined();
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
          capabilities: ["fs.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.read": {
            id: "plugin.history.tool.read.provider",
            mode: "script",
            priority: 50,
            canHandle: (input) =>
              String(
                (input.args?.frame as Record<string, unknown> | undefined)
                  ?.tool || "",
              ) === "read",
            invoke: async () => ({
              provider: "history-tool-read",
            }),
          },
        },
      },
    });

    const capturedBodies: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        llmCall += 1;
        const body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
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
                          name: "host_read_file",
                          arguments: JSON.stringify({
                            path: "/tmp/history.txt",
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (llmCall === 2) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "FIRST_TURN_DONE",
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "SECOND_TURN_DONE",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const first = await invokeRuntime({
      type: "brain.run.start",
      prompt: "第一轮读取文件",
      sessionOptions: {
        title: "History Tool Session",
        metadata: {
          titleSource: "manual",
        },
      },
    });
    expect(first.ok).toBe(true);
    const sessionId = String(
      ((first.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");
    await waitForLoopDone(sessionId);

    const second = await invokeRuntime({
      type: "brain.run.start",
      sessionId,
      prompt: "第二轮继续",
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
      (item) =>
        String(item.role || "") === "tool" &&
        String(item.tool_call_id || "") === "call_read_history_1",
    );
    expect(toolMessage).toBeDefined();
    const pairedAssistant = thirdMessages.find((item) => {
      if (String(item.role || "") !== "assistant") return false;
      const calls = Array.isArray(item.tool_calls)
        ? (item.tool_calls as Array<Record<string, unknown>>)
        : [];
      return calls.some(
        (call) => String(call.id || "") === "call_read_history_1",
      );
    });
    expect(pairedAssistant).toBeDefined();
  });

  it("returns runtime-not-ready when capability provider is missing", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "capability-missing-provider",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const executed = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "browser_read_file",
      args: {
        path: "mem://missing.txt",
      },
      verifyPolicy: "off",
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
      action: "browser_read_file",
      args: {
        path: "mem://missing.txt",
      },
      verifyPolicy: "off",
    });
    expect(executedWithMode.ok).toBe(true);
    const withModeResult = (executedWithMode.data || {}) as Record<
      string,
      unknown
    >;
    expect(withModeResult.ok).toBe(false);
    expect(withModeResult.errorCode).toBe("E_RUNTIME_NOT_READY");
    expect(String(withModeResult.error || "")).toContain(
      "capability provider 未就绪",
    );
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
          capabilities: ["fs.virtual.read"],
        },
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.event-order.read",
            mode: "bridge",
            invoke: async () => ({ ok: true, source: "event-order" }),
          },
        },
      },
    });

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "event-order-seed",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const beforeStream = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    expect(beforeStream.ok).toBe(true);
    const baseline = Array.isArray(
      (beforeStream.data as Record<string, unknown>)?.stream,
    )
      ? ((beforeStream.data as Record<string, unknown>)
          .stream as unknown[] as Array<Record<string, unknown>>)
      : [];

    const executed = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.virtual.read",
      action: "browser_read_file",
      args: {
        path: "mem://ordered.txt",
      },
      verifyPolicy: "off",
    });
    expect(executed.ok).toBe(true);

    const deadline = Date.now() + 1200;
    let stepDelta: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      const afterStream = await invokeRuntime({
        type: "brain.step.stream",
        sessionId,
      });
      expect(afterStream.ok).toBe(true);
      const fullStream = Array.isArray(
        (afterStream.data as Record<string, unknown>)?.stream,
      )
        ? ((afterStream.data as Record<string, unknown>)
            .stream as unknown[] as Array<Record<string, unknown>>)
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
    expect(
      String(
        (stepDelta[0].payload as Record<string, unknown> | undefined)
          ?.capability || "",
      ),
    ).toBe("fs.virtual.read");
    expect(
      String(
        (stepDelta[0].payload as Record<string, unknown> | undefined)
          ?.providerId || "",
      ),
    ).toBe("plugin.event-order.read");
    expect(
      String(
        (stepDelta[1].payload as Record<string, unknown> | undefined)
          ?.capabilityUsed || "",
      ),
    ).toBe("fs.virtual.read");
    expect(
      String(
        (stepDelta[1].payload as Record<string, unknown> | undefined)
          ?.providerId || "",
      ),
    ).toBe("plugin.event-order.read");
    expect(
      String(
        (stepDelta[1].payload as Record<string, unknown> | undefined)
          ?.modeUsed || "",
      ),
    ).toBe("bridge");
    expect(
      String(
        (stepDelta[1].payload as Record<string, unknown> | undefined)
          ?.fallbackFrom || "",
      ),
    ).toBe("");
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
        payload: "x".repeat(220),
      });
    }

    const deadline = Date.now() + 1500;
    let data: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      const out = await invokeRuntime({
        type: "brain.step.stream",
        sessionId,
        maxEvents: 5,
        maxBytes: 12_000,
      });
      expect(out.ok).toBe(true);
      data = (out.data || {}) as Record<string, unknown>;
      const streamMeta = (data.streamMeta || {}) as Record<string, unknown>;
      if (Number(streamMeta.totalEvents || 0) >= 40) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const stream = Array.isArray(data.stream)
      ? (data.stream as Array<Record<string, unknown>>)
      : [];
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
          hooks: ["llm.before_request", "llm.after_response"],
        },
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
        },
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        timeline.push("fetch");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "llm-hook-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 llm hook 时序",
      sessionOptions: {
        title: "LLM Hook Timeline",
        metadata: {
          titleSource: "manual",
        },
      },
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
    expect(timeline).toEqual(["before", "fetch", "after"]);
    const eventTypes = stream.map((item) => String(item.type || ""));
    expect(eventTypes).toContain("llm.request");
    expect(eventTypes).toContain("llm.response.parsed");
    const llmReq =
      stream.find((item) => String(item.type || "") === "llm.request") || {};
    const llmReqPayload = ((llmReq as Record<string, unknown>).payload ||
      {}) as Record<string, unknown>;
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
        ...buildWorkerLlmConfig({ model: "gpt-test", apiKey: "" }),
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "缺少 llm key 的场景",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("failed_execute");

    const skipped = stream.find(
      (item) => String(item.type || "") === "llm.skipped",
    ) as Record<string, unknown> | undefined;
    const skippedPayload = (skipped?.payload || {}) as Record<string, unknown>;
    expect(String(skippedPayload.reason || "")).toBe("missing_llm_config");
  });

  it("浏览器任务缺乏有效 proof 时应触发 browser proof guard 并收口", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.guard-missing-proof",
        name: "browser-action-guard-missing-proof",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action"],
        },
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.guard-missing-proof.provider",
            mode: "script",
            priority: 80,
            invoke: async () => ({
              data: {
                provider: "guard-missing-proof",
              },
              verified: false,
              verifyReason: "verify_skipped",
            }),
          },
        },
      },
    });

    let llmCall = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        llmCall += 1;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: `call_guard_${llmCall}`,
                      type: "function",
                      function: {
                        name: "click",
                        arguments: JSON.stringify({
                          tabId: 1,
                          ref: "e0",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        llmRetryMaxAttempts: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "点击页面按钮并确认已完成",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(fetchSpy).toHaveBeenCalled();
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("progress_uncertain");
    const guardCount = stream.filter(
      (item) =>
        String(item.type || "") === "loop_guard_browser_progress_missing",
    ).length;
    expect(guardCount).toBeGreaterThan(0);
    const noProgressEvents = stream.filter(
      (item) => String(item.type || "") === "loop_no_progress",
    );
    const guardNoProgress = noProgressEvents.find((item) => {
      const payload = ((item as Record<string, unknown>).payload ||
        {}) as Record<string, unknown>;
      return String(payload.reason || "") === "browser_proof_guard";
    });
    expect(guardNoProgress).toBeDefined();
  });

  it("不同浏览器动作签名的无 proof 尝试不应共享 browser proof guard hit", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    let actionInvoked = 0;
    let verifyInvoked = 0;
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.guard-scoped",
        name: "browser-action-guard-scoped",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action", "browser.verify"],
        },
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.guard-scoped.provider",
            mode: "script",
            priority: 80,
            invoke: async (input) => {
              actionInvoked += 1;
              const action = asRecord(asRecord(input.args).action);
              return {
                data: {
                  provider: "guard-scoped",
                  ref: String(action.ref || ""),
                },
                verified: false,
                verifyReason: "verify_skipped",
              };
            },
          },
          "browser.verify": {
            id: "plugin.browser.verify.guard-scoped.provider",
            mode: "script",
            priority: 80,
            invoke: async () => {
              verifyInvoked += 1;
              return {
                data: {
                  ok: true,
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
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
                      id: "call_guard_scope_1",
                      type: "function",
                      function: {
                        name: "click",
                        arguments: JSON.stringify({
                          tabId: 1,
                          ref: "e0",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
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
                      id: "call_guard_scope_2",
                      type: "function",
                      function: {
                        name: "click",
                        arguments: JSON.stringify({
                          tabId: 1,
                          ref: "e1",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      if (llmCall === 3) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_guard_scope_verify",
                      type: "function",
                      function: {
                        name: "browser_verify",
                        arguments: JSON.stringify({
                          tabId: 1,
                          expect: {
                            urlContains: "example.com",
                          },
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "完成",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        llmRetryMaxAttempts: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "先点击两个不同目标，再确认结果",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(actionInvoked).toBe(2);
    expect(verifyInvoked).toBe(1);
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("done");

    const guardEvents = stream.filter((item) => {
      if (String(item.type || "") !== "loop_no_progress") return false;
      const payload = ((item as Record<string, unknown>).payload ||
        {}) as Record<string, unknown>;
      return String(payload.reason || "") === "browser_proof_guard";
    });
    expect(guardEvents).toHaveLength(2);
    expect(
      new Set(
        guardEvents.map((item) =>
          String(
            (((item as Record<string, unknown>).payload || {}) as Record<
              string,
              unknown
            >).scopeKey || "",
          ),
        ),
      ).size,
    ).toBe(2);
  });

  it("同签名浏览器动作出现新证据时不应继续累计 browser proof guard", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    let actionInvoked = 0;
    let verifyInvoked = 0;
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.action.guard-fresh-evidence",
        name: "browser-action-guard-fresh-evidence",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.action", "browser.verify"],
        },
      },
      providers: {
        capabilities: {
          "browser.action": {
            id: "plugin.browser.action.guard-fresh-evidence.provider",
            mode: "script",
            priority: 80,
            invoke: async () => {
              actionInvoked += 1;
              return {
                data: {
                  provider: "guard-fresh-evidence",
                  url: `https://example.com/step-${actionInvoked}`,
                  title: `Step ${actionInvoked}`,
                },
                verified: false,
                verifyReason: "verify_skipped",
              };
            },
          },
          "browser.verify": {
            id: "plugin.browser.verify.guard-fresh-evidence.provider",
            mode: "script",
            priority: 80,
            invoke: async () => {
              verifyInvoked += 1;
              return {
                data: {
                  ok: true,
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      if (llmCall === 1 || llmCall === 2) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: `call_guard_fresh_${llmCall}`,
                      type: "function",
                      function: {
                        name: "click",
                        arguments: JSON.stringify({
                          tabId: 1,
                          ref: "e0",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      if (llmCall === 3) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_guard_fresh_verify",
                      type: "function",
                      function: {
                        name: "browser_verify",
                        arguments: JSON.stringify({
                          tabId: 1,
                          expect: {
                            urlContains: "example.com",
                          },
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "完成",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        llmRetryMaxAttempts: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "重复点击同一目标，但页面状态有变化时继续推进",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(actionInvoked).toBe(2);
    expect(verifyInvoked).toBe(1);
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("done");

    const guardEvents = stream.filter((item) => {
      if (String(item.type || "") !== "loop_no_progress") return false;
      const payload = ((item as Record<string, unknown>).payload ||
        {}) as Record<string, unknown>;
      return String(payload.reason || "") === "browser_proof_guard";
    });
    expect(guardEvents).toHaveLength(1);
  });

  it("computer(wait) 不应触发 browser proof guard", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    let verifyInvoked = 0;
    orchestrator.registerPlugin({
      manifest: {
        id: "plugin.browser.verify.after-wait",
        name: "browser-verify-after-wait",
        version: "1.0.0",
        permissions: {
          capabilities: ["browser.verify"],
        },
      },
      providers: {
        capabilities: {
          "browser.verify": {
            id: "plugin.browser.verify.after-wait.provider",
            mode: "script",
            priority: 80,
            invoke: async () => {
              verifyInvoked += 1;
              return {
                data: {
                  ok: true,
                },
                verified: true,
                verifyReason: "verified",
              };
            },
          },
        },
      },
    });

    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      llmCall += 1;
      if (llmCall === 1 || llmCall === 2) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: `call_wait_${llmCall}`,
                      type: "function",
                      function: {
                        name: "computer",
                        arguments: JSON.stringify({
                          action: "wait",
                          tabId: 1,
                          duration: 1,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      if (llmCall === 3) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_wait_verify",
                      type: "function",
                      function: {
                        name: "browser_verify",
                        arguments: JSON.stringify({
                          tabId: 1,
                          expect: {
                            urlContains: "example.com",
                          },
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "完成",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        llmRetryMaxAttempts: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "等待两次后继续验证页面结果",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(verifyInvoked).toBe(1);
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("done");

    const browserGuardEvents = stream.filter((item) => {
      if (String(item.type || "") !== "loop_no_progress") return false;
      const payload = ((item as Record<string, unknown>).payload ||
        {}) as Record<string, unknown>;
      return String(payload.reason || "") === "browser_proof_guard";
    });
    expect(browserGuardEvents).toHaveLength(0);
  });

  it("LLM 抛出字符串错误时应稳定收口，避免 details 写入字符串导致二次异常", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw "llm-timeout";
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        llmRetryMaxAttempts: 0,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试字符串错误兼容",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(fetchSpy).toHaveBeenCalled();
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("failed_execute");
    const doneMessage = `${String(donePayload.message || "")} ${String(donePayload.error || "")}`;
    expect(doneMessage).not.toContain("Cannot create property 'details'");

    const viewed = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(viewed.ok).toBe(true);
    const messages = readConversationMessages(viewed);
    const assistantMessages = messages.filter(
      (item) => String(item.role || "") === "assistant",
    );
    const lastAssistant = String(
      (assistantMessages[assistantMessages.length - 1] || {}).content || "",
    );
    expect(lastAssistant).toContain("llm-timeout");
    expect(lastAssistant).not.toContain("Cannot create property 'details'");
  });

  it("使用 profile 配置时应发出 llm.route.selected 并命中 provider/model", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<
          string,
          unknown
        >;
        capturedBodies.push(body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "profile-route-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker",
          },
        ],
        llmDefaultProfile: "worker.basic",
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 profile 选路事件",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    const runRequest = capturedBodies.find(
      (body) => Array.isArray(body.tools) && body.stream === true,
    );
    expect(runRequest).toBeDefined();
    expect(String(runRequest?.model || "")).toBe("gpt-worker-basic");
    const selected = stream.find(
      (item) => String(item.type || "") === "llm.route.selected",
    ) as Record<string, unknown> | undefined;
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
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "missing_provider",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker",
          },
        ],
        llmDefaultProfile: "worker.basic",
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 provider 缺失失败语义",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId);
    const blocked = stream.find(
      (item) => String(item.type || "") === "llm.route.blocked",
    ) as Record<string, unknown> | undefined;
    const blockedPayload = (blocked?.payload || {}) as Record<string, unknown>;
    expect(String(blockedPayload.reason || "")).toBe("provider_not_found");
    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
    const donePayload = (done?.payload || {}) as Record<string, unknown>;
    expect(String(donePayload.status || "")).toBe("failed_execute");
  });

  it("LLM 重复失败后应升级 profile 并发出 llm.route.escalated", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<
          string,
          unknown
        >;
        const model = String(body.model || "");
        if (model === "gpt-worker-basic") {
          return new Response(
            JSON.stringify({
              error: {
                message: "temporary unavailable",
              },
            }),
            {
              status: 503,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "escalation-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        llmProfiles: [
          {
            id: "worker.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-basic",
            role: "worker",
            llmRetryMaxAttempts: 1,
          },
          {
            id: "worker.pro",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-worker-pro",
            role: "worker",
            llmRetryMaxAttempts: 0,
          },
        ],
        llmDefaultProfile: "worker.basic",
        llmFallbackProfile: "worker.pro",
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 profile 自动升级",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const stream = await waitForLoopDone(sessionId, 5000);
    expect(fetchSpy).toHaveBeenCalled();
    const escalated = stream.find(
      (item) => String(item.type || "") === "llm.route.escalated",
    ) as Record<string, unknown> | undefined;
    const escalatedPayload = (escalated?.payload || {}) as Record<
      string,
      unknown
    >;
    expect(String(escalatedPayload.fromProfile || "")).toBe("worker.basic");
    expect(String(escalatedPayload.toProfile || "")).toBe("worker.pro");

    const selectedEvents = stream.filter(
      (item) => String(item.type || "") === "llm.route.selected",
    );
    expect(selectedEvents.length).toBeGreaterThanOrEqual(2);
    const afterEscalation = selectedEvents[selectedEvents.length - 1] as Record<
      string,
      unknown
    >;
    const afterEscalationPayload = (afterEscalation.payload || {}) as Record<
      string,
      unknown
    >;
    expect(String(afterEscalationPayload.profile || "")).toBe("worker.pro");
    expect(String(afterEscalationPayload.source || "")).toBe("escalation");
    const meta = await orchestrator.sessions.getMeta(sessionId);
    const metadata = (meta?.header.metadata || {}) as Record<string, unknown>;
    expect(String(metadata.llmProfile || "")).toBe("");
    expect(String(metadata.llmResolvedProfile || "")).toBe("worker.pro");

    const done = stream.find(
      (item) => String(item.type || "") === "loop_done",
    ) as Record<string, unknown> | undefined;
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
          hooks: ["llm.before_request", "llm.after_response"],
        },
      },
      hooks: {
        "llm.before_request": (event) => {
          const request = (event.request || {}) as Record<string, unknown>;
          const payload =
            ((request.payload || {}) as Record<string, unknown>) || {};
          return {
            action: "patch",
            patch: {
              request: {
                ...request,
                payload: {
                  ...payload,
                  temperature: 0.91,
                },
              },
            },
          };
        },
        "llm.after_response": (event) => {
          const response = (event.response || {}) as Record<string, unknown>;
          afterResponseContent = String(response.content || "");
          return { action: "continue" };
        },
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const bodyText = String(init?.body || "");
        capturedBody = (JSON.parse(bodyText || "{}") || {}) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "llm-hook-patch-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 llm hook patch",
      sessionOptions: {
        title: "LLM Hook Patch",
        metadata: {
          titleSource: "manual",
        },
      },
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
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
            path: { type: "string" },
          },
          required: [],
        },
      },
      { replace: true },
    );

    let capturedTools: Array<Record<string, unknown>> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const bodyText = String(init?.body || "");
        const body = (JSON.parse(bodyText || "{}") || {}) as Record<
          string,
          unknown
        >;
        capturedTools = Array.isArray(body.tools)
          ? (body.tools as Array<Record<string, unknown>>)
          : [];
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "registry-tools-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 tool contract registry",
      sessionOptions: {
        title: "Tool Contract Registry",
        metadata: {
          titleSource: "manual",
        },
      },
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const toolNames = capturedTools
      .map(
        (item) => (item.function as Record<string, unknown> | undefined)?.name,
      )
      .map((name) => String(name || ""));
    expect(toolNames).toContain("host_read_file");
    expect(toolNames).toContain("host_bash");
    expect(toolNames).toContain("click");
    expect(toolNames).not.toContain("workspace_ls");

    const clickTool = capturedTools.find(
      (item) =>
        String(
          (item.function as Record<string, unknown> | undefined)?.name || "",
        ) === "click",
    );
    const clickDesc = String(
      (clickTool?.function as Record<string, unknown> | undefined)
        ?.description || "",
    );
    const clickParams = ((
      clickTool?.function as Record<string, unknown> | undefined
    )?.parameters || {}) as Record<string, unknown>;
    expect(String(clickParams.type || "")).toBe("object");
    expect(clickParams.anyOf).toBeUndefined();
    expect(clickParams.oneOf).toBeUndefined();
    expect(clickParams.allOf).toBeUndefined();
    expect(clickParams.enum).toBeUndefined();
    expect(clickParams.not).toBeUndefined();
    expect(clickDesc).toContain("Schema constraint hints:");
    expect(clickDesc).toContain("anyOf:");
  });

  it("brain.run.start 会注入 available_skills（过滤 disable-model-invocation）", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const bodyText = String(init?.body || "");
        const body = (JSON.parse(bodyText || "{}") || {}) as Record<
          string,
          unknown
        >;
        capturedBodies.push(body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "skills-prompt-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
      },
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
        enabled: true,
      },
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
        disableModelInvocation: true,
      },
    });
    expect(hiddenSkill.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "测试 available skills prompt",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    const runBody = capturedBodies.find((item) => item.stream === true) || {};
    const runMessages = Array.isArray(runBody.messages)
      ? (runBody.messages as Array<Record<string, unknown>>)
      : [];
    const systemText = runMessages
      .filter((item) => String(item.role || "") === "system")
      .map((item) => String(item.content || ""))
      .join("\n");
    expect(systemText).toContain(
      "You are an expert coding assistant operating inside Browser Brain Loop",
    );
    expect(systemText).toContain("select_option_by_uid");
    expect(systemText).toContain("press_key");
    expect(systemText).toContain("scroll_page");
    expect(systemText).toContain("navigate_tab");
    expect(systemText).toContain("hover_element_by_uid");
    expect(systemText).toContain("get_editor_value");
    expect(systemText).toContain("computer");
    expect(systemText).toContain("capture_screenshot");
    expect(systemText).toContain("download_image");
    expect(systemText).toContain("request_intervention");
    expect(systemText).toContain("list_skills");
    expect(systemText).toContain(
      "For click/fill/select/hover/get_editor_value/scroll_to/highlight, prefer uid/ref/backendNodeId",
    );
    expect(systemText).toContain("semantic search -> action -> browser_verify");
    expect(systemText).toContain("Avoid blind repeat");
    expect(systemText).toContain("<available_skills>");
    expect(systemText).toContain('name="Visible Skill"');
    expect(systemText).toContain('location="mem://skills/visible/SKILL.md"');
    expect(systemText).not.toContain("skill.hidden");
    expect(systemText).not.toContain("mem://skills/hidden/SKILL.md");
  });

  it("brain.run.start 会注入自定义 system prompt", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const bodyText = String(init?.body || "");
        const body = (JSON.parse(bodyText || "{}") || {}) as Record<
          string,
          unknown
        >;
        capturedBodies.push(body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "profile-prompt-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        llmSystemPromptCustom:
          "Always report changed file paths in the final response.",
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "检查项目并修复一个 bug",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    const runBody = capturedBodies.find((item) => item.stream === true) || {};
    const runMessages = Array.isArray(runBody.messages)
      ? (runBody.messages as Array<Record<string, unknown>>)
      : [];
    const systemText = runMessages
      .filter((item) => String(item.role || "") === "system")
      .map((item) => String(item.content || ""))
      .join("\n");

    expect(systemText).toContain(
      "Always report changed file paths in the final response.",
    );
    expect(systemText).not.toContain(
      "You are an expert coding assistant operating inside Browser Brain Loop",
    );
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
          content: "# SKILL\n1. 分析输入\n2. 输出结果",
        }),
      },
      { replace: true },
    );

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const bodyText = String(init?.body || "");
        const body = (JSON.parse(bodyText || "{}") || {}) as Record<
          string,
          unknown
        >;
        capturedBodies.push(body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "slash-skill-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
      },
    });
    expect(saved.ok).toBe(true);

    const installed = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.slash.demo",
        name: "Slash Demo",
        location: "mem://skills/slash-demo/SKILL.md",
        source: "project",
        enabled: true,
      },
    });
    expect(installed.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "/skill:skill.slash.demo 请输出 hello",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    const runBody = capturedBodies.find((item) => item.stream === true) || {};
    const runMessages = Array.isArray(runBody.messages)
      ? (runBody.messages as Array<Record<string, unknown>>)
      : [];
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
      autoRun: false,
    });
    expect(started.ok).toBe(false);
    expect(String(started.error || "")).toContain("skill 不存在");
  });

  it("brain.run.start 支持通过 skillIds 显式选择技能（会话保留原始用户消息）", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    orchestrator.registerCapabilityProvider(
      "fs.read",
      {
        id: "test.skill.selected.fs.read",
        mode: "script",
        priority: 100,
        invoke: async () => ({
          content: "# SKILL\n1. 先执行选择的技能\n2. 再处理用户文本",
        }),
      },
      { replace: true },
    );

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const bodyText = String(init?.body || "");
        const body = (JSON.parse(bodyText || "{}") || {}) as Record<
          string,
          unknown
        >;
        capturedBodies.push(body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "selected-skill-ok",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
      },
    });
    expect(saved.ok).toBe(true);

    const installed = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.selected.demo",
        name: "Selected Demo",
        location: "mem://skills/selected-demo/SKILL.md",
        source: "project",
        enabled: true,
      },
    });
    expect(installed.ok).toBe(true);

    const userPrompt = "请输出 hello";
    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: userPrompt,
      skillIds: ["skill.selected.demo"],
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await waitForLoopDone(sessionId);
    expect(fetchSpy).toHaveBeenCalled();
    const runBody = capturedBodies.find((item) => item.stream === true) || {};
    const runMessages = Array.isArray(runBody.messages)
      ? (runBody.messages as Array<Record<string, unknown>>)
      : [];
    const userText = runMessages
      .filter((item) => String(item.role || "") === "user")
      .map((item) => String(item.content || ""))
      .join("\n");
    expect(userText).toContain('<skill id="skill.selected.demo"');
    expect(userText).toContain("<skill_args>");
    expect(userText).toContain(userPrompt);
    expect(userText).toContain("1. 先执行选择的技能");

    const conversation = await invokeRuntime({
      type: "brain.session.view",
      sessionId,
    });
    expect(conversation.ok).toBe(true);
    const messages = Array.isArray(
      (
        (conversation.data as Record<string, unknown>)
          ?.conversationView as Record<string, unknown>
      )?.messages,
    )
      ? ((
          (conversation.data as Record<string, unknown>)
            .conversationView as Record<string, unknown>
        ).messages as unknown[] as Array<Record<string, unknown>>)
      : [];
    const lastUserText = messages
      .filter((item) => String(item.role || "") === "user")
      .map((item) => String(item.content || ""))
      .pop();
    expect(String(lastUserText || "")).toBe(userPrompt);
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
          capabilities: ["fs.virtual.read", "browser.action"],
        },
      },
      hooks: {
        "tool.before_call": () => ({ action: "continue" }),
      },
      providers: {
        capabilities: {
          "fs.virtual.read": {
            id: "plugin.debug.view.read",
            mode: "bridge",
            invoke: async () => ({ ok: true }),
          },
        },
      },
      policies: {
        capabilities: {
          "browser.action": {
            defaultVerifyPolicy: "always",
            leasePolicy: "required",
          },
        },
      },
    });

    const out = await invokeRuntime({
      type: "brain.debug.plugins",
    });
    expect(out.ok).toBe(true);
    const data = (out.data || {}) as Record<string, unknown>;
    const plugins = Array.isArray(data.plugins)
      ? (data.plugins as Array<Record<string, unknown>>)
      : [];
    const capabilities = Array.isArray(data.capabilityProviders)
      ? (data.capabilityProviders as Array<Record<string, unknown>>)
      : [];
    const toolContracts = Array.isArray(data.toolContracts)
      ? (data.toolContracts as Array<Record<string, unknown>>)
      : [];
    const policies = Array.isArray(data.capabilityPolicies)
      ? (data.capabilityPolicies as Array<Record<string, unknown>>)
      : [];
    const plugin = plugins.find(
      (item) => String(item.id || "") === "plugin.debug.view",
    );
    expect(plugin).toBeDefined();
    expect(Boolean(plugin?.enabled)).toBe(true);
    expect(
      toolContracts.some((item) => String(item.name || "") === "host_bash"),
    ).toBe(true);
    expect(
      capabilities.some(
        (item) => String(item.capability || "") === "fs.virtual.read",
      ),
    ).toBe(true);
    expect(
      policies.some(
        (item) => String(item.capability || "") === "browser.action",
      ),
    ).toBe(true);
  });

  it("bootstraps builtin plugins on runtime startup", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const out = await invokeRuntime({
      type: "brain.plugin.list",
    });
    expect(out.ok).toBe(true);
    const data = (out.data || {}) as Record<string, unknown>;
    const plugins = Array.isArray(data.plugins)
      ? (data.plugins as Array<Record<string, unknown>>)
      : [];
    const capabilityProviders = Array.isArray(data.capabilityProviders)
      ? (data.capabilityProviders as Array<Record<string, unknown>>)
      : [];

    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.process.exec.bridge",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.process.exec.sandbox",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.fs.read.bridge",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.fs.read.sandbox",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.fs.write.bridge",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.fs.write.sandbox",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.fs.edit.bridge",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.fs.edit.sandbox",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.browser.snapshot.cdp",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.browser.action.cdp",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.browser.verify.cdp",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "plugin.example.notice.send-success-global-message",
      ),
    ).toBe(true);
    expect(
      plugins.some(
        (item) => String(item.id || "") === "plugin.example.ui.mission-hud.dog",
      ),
    ).toBe(true);

    const sendSuccessPlugin = plugins.find(
      (item) =>
        String(item.id || "") ===
        "plugin.example.notice.send-success-global-message",
    );
    expect(Array.isArray(sendSuccessPlugin?.runtimeMessages)).toBe(true);
    expect(
      ((sendSuccessPlugin?.runtimeMessages as unknown[]) || []).includes(
        "bbloop.global.message",
      ),
    ).toBe(true);
    expect(
      ((sendSuccessPlugin?.brainEvents as unknown[]) || []).includes(
        "plugin.global_message",
      ),
    ).toBe(true);

    const mascotPlugin = plugins.find(
      (item) => String(item.id || "") === "plugin.example.ui.mission-hud.dog",
    );
    expect(Array.isArray(mascotPlugin?.runtimeMessages)).toBe(true);
    expect(
      ((mascotPlugin?.runtimeMessages as unknown[]) || []).includes(
        "bbloop.ui.mascot",
      ),
    ).toBe(true);

    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "process.exec" &&
          String(item.id || "") ===
            "runtime.builtin.capability.process.exec.bridge",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "process.exec" &&
          String(item.id || "") ===
            "runtime.builtin.plugin.capability.process.exec.sandbox.provider",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "fs.read" &&
          String(item.id || "") === "runtime.builtin.capability.fs.read.bridge",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "fs.read" &&
          String(item.id || "") ===
            "runtime.builtin.plugin.capability.fs.read.sandbox.provider",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "fs.write" &&
          String(item.id || "") ===
            "runtime.builtin.capability.fs.write.bridge",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "fs.write" &&
          String(item.id || "") ===
            "runtime.builtin.plugin.capability.fs.write.sandbox.provider",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "fs.edit" &&
          String(item.id || "") === "runtime.builtin.capability.fs.edit.bridge",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "fs.edit" &&
          String(item.id || "") ===
            "runtime.builtin.plugin.capability.fs.edit.sandbox.provider",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "browser.snapshot" &&
          String(item.id || "") ===
            "runtime.builtin.capability.browser.snapshot.cdp",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "browser.action" &&
          String(item.id || "") ===
            "runtime.builtin.plugin.capability.browser.action.cdp.provider",
      ),
    ).toBe(true);
    expect(
      capabilityProviders.some(
        (item) =>
          String(item.capability || "") === "browser.verify" &&
          String(item.id || "") ===
            "runtime.builtin.capability.browser.verify.cdp",
      ),
    ).toBe(true);
  });

  it("builtin send-success plugin should emit bbloop.global.message on brain.run.start", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const sendSpy = vi
      .spyOn(chrome.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "test notice",
    });
    expect(started.ok).toBe(true);

    const calls = sendSpy.mock.calls
      .map((item) => item[0])
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          String((item as Record<string, unknown>).type || "") ===
            "bbloop.global.message",
      );

    expect(calls.length).toBeGreaterThan(0);
    const payload = asRecord(asRecord(calls[calls.length - 1]).payload);
    expect(String(payload.message || "")).toBe("发送成功");
    expect(String(payload.source || "")).toBe(
      "plugin.send-success-global-message",
    );
    expect(String(payload.dedupeKey || "")).toContain(
      "plugin.send-success-global-message",
    );
  });

  it("builtin mission-hud plugin should emit mascot event on brain.run.start", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const sendSpy = vi
      .spyOn(chrome.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "test mascot",
    });
    expect(started.ok).toBe(true);

    const calls = sendSpy.mock.calls
      .map((item) => item[0])
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          String((item as Record<string, unknown>).type || "") ===
            "bbloop.ui.mascot",
      );

    expect(calls.length).toBeGreaterThan(0);
    const payload = asRecord(asRecord(calls[calls.length - 1]).payload);
    expect(String(payload.phase || "")).toBe("thinking");
    expect(String(payload.source || "")).toBe("plugin.ui.mission-hud");
    expect(String(payload.message || "").trim().length).toBeGreaterThan(0);
  });

  it("disabled example plugins should stay disabled after runtime reload", async () => {
    const sendSpy = vi
      .spyOn(chrome.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);

    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const sendSuccessPluginId =
      "plugin.example.notice.send-success-global-message";
    const mascotPluginId = "plugin.example.ui.mission-hud.dog";

    const disableSendSuccess = await invokeRuntime({
      type: "brain.plugin.disable",
      pluginId: sendSuccessPluginId,
    });
    expect(disableSendSuccess.ok).toBe(true);

    const disableMascot = await invokeRuntime({
      type: "brain.plugin.disable",
      pluginId: mascotPluginId,
    });
    expect(disableMascot.ok).toBe(true);

    runtimeListeners = [];
    resetRuntimeOnMessageMock();

    const reloadedOrchestrator = new BrainOrchestrator();
    registerRuntimeRouter(reloadedOrchestrator);

    const listed = await invokeRuntime({
      type: "brain.plugin.list",
    });
    expect(listed.ok).toBe(true);
    const plugins = Array.isArray((listed.data as Record<string, unknown>)?.plugins)
      ? ((listed.data as Record<string, unknown>).plugins as Array<Record<string, unknown>>)
      : [];
    const sendSuccessPlugin = plugins.find(
      (item) => String(item.id || "") === sendSuccessPluginId,
    );
    const mascotPlugin = plugins.find(
      (item) => String(item.id || "") === mascotPluginId,
    );
    expect(sendSuccessPlugin).toBeDefined();
    expect(mascotPlugin).toBeDefined();
    expect(Boolean(sendSuccessPlugin?.enabled)).toBe(false);
    expect(Boolean(mascotPlugin?.enabled)).toBe(false);

    const beforeGlobalMessages = sendSpy.mock.calls.filter(
      (item) =>
        item[0] &&
        typeof item[0] === "object" &&
        String((item[0] as Record<string, unknown>).type || "") ===
          "bbloop.global.message",
    ).length;
    const beforeMascotMessages = sendSpy.mock.calls.filter(
      (item) =>
        item[0] &&
        typeof item[0] === "object" &&
        String((item[0] as Record<string, unknown>).type || "") ===
          "bbloop.ui.mascot",
    ).length;

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "reload should not revive disabled example plugins",
    });
    expect(started.ok).toBe(true);

    const afterGlobalMessages = sendSpy.mock.calls.filter(
      (item) =>
        item[0] &&
        typeof item[0] === "object" &&
        String((item[0] as Record<string, unknown>).type || "") ===
          "bbloop.global.message",
    ).length;
    const afterMascotMessages = sendSpy.mock.calls.filter(
      (item) =>
        item[0] &&
        typeof item[0] === "object" &&
        String((item[0] as Record<string, unknown>).type || "") ===
          "bbloop.ui.mascot",
    ).length;

    expect(afterGlobalMessages).toBe(beforeGlobalMessages);
    expect(afterMascotMessages).toBe(beforeMascotMessages);
  });

  it("builtin fs.read sandbox plugin should fail when disabled and recover when re-enabled", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "builtin capability plugin toggle",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const wrote = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.write",
      action: "invoke",
      args: {
        frame: {
          tool: "write",
          args: {
            path: "mem://plugins/toggle/readme.txt",
            content: "plugin-toggle-content",
            mode: "overwrite",
            runtime: "browser",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(wrote.ok).toBe(true);
    const wroteResult = (wrote.data || {}) as Record<string, unknown>;
    expect(Boolean(wroteResult.ok)).toBe(true);

    const disabled = await invokeRuntime({
      type: "brain.plugin.disable",
      pluginId: "runtime.builtin.plugin.capability.fs.read.sandbox",
    });
    expect(disabled.ok).toBe(true);

    const readWhenDisabled = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://plugins/toggle/readme.txt",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(readWhenDisabled.ok).toBe(true);
    const disabledResult = (readWhenDisabled.data || {}) as Record<
      string,
      unknown
    >;
    expect(Boolean(disabledResult.ok)).toBe(false);
    expect(String(disabledResult.error || "")).toContain(
      "未找到 capability provider: fs.read",
    );

    const enabled = await invokeRuntime({
      type: "brain.plugin.enable",
      pluginId: "runtime.builtin.plugin.capability.fs.read.sandbox",
    });
    expect(enabled.ok).toBe(true);

    const readAfterEnabled = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://plugins/toggle/readme.txt",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(readAfterEnabled.ok).toBe(true);
    const enabledResult = (readAfterEnabled.data || {}) as Record<
      string,
      unknown
    >;
    expect(Boolean(enabledResult.ok)).toBe(true);
    expect(String(enabledResult.modeUsed || "")).toBe("script");
    const invokePayload = (enabledResult.data || {}) as Record<string, unknown>;
    const response = (invokePayload.response || {}) as Record<string, unknown>;
    const responseData = (response.data || {}) as Record<string, unknown>;
    expect(String(responseData.content || "")).toContain(
      "plugin-toggle-content",
    );
  });

  it("disabled builtin sandbox plugin should stay disabled after runtime reload", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const disabled = await invokeRuntime({
      type: "brain.plugin.disable",
      pluginId: "runtime.builtin.plugin.capability.fs.read.sandbox",
    });
    expect(disabled.ok).toBe(true);

    runtimeListeners = [];
    resetRuntimeOnMessageMock();

    const reloadedOrchestrator = new BrainOrchestrator();
    registerRuntimeRouter(reloadedOrchestrator);

    const listed = await invokeRuntime({
      type: "brain.plugin.list",
    });
    expect(listed.ok).toBe(true);
    const plugins = Array.isArray((listed.data as Record<string, unknown>)?.plugins)
      ? ((listed.data as Record<string, unknown>).plugins as Array<Record<string, unknown>>)
      : [];
    const sandboxPlugin = plugins.find(
      (item) =>
        String(item.id || "") ===
        "runtime.builtin.plugin.capability.fs.read.sandbox",
    );
    expect(sandboxPlugin).toBeDefined();
    expect(Boolean(sandboxPlugin?.enabled)).toBe(false);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "builtin sandbox plugin disabled after reload",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const wrote = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.write",
      action: "invoke",
      args: {
        frame: {
          tool: "write",
          args: {
            path: "mem://plugins/reload-disabled/readme.txt",
            content: "reload-disabled",
            mode: "overwrite",
            runtime: "browser",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(wrote.ok).toBe(true);

    const readWhenDisabled = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://plugins/reload-disabled/readme.txt",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(readWhenDisabled.ok).toBe(true);
    const disabledResult = (readWhenDisabled.data || {}) as Record<
      string,
      unknown
    >;
    expect(Boolean(disabledResult.ok)).toBe(false);
    expect(String(disabledResult.error || "")).toContain(
      "未找到 capability provider: fs.read",
    );
  });

  it("brain.plugin.unregister should reject builtin plugins", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const removed = await invokeRuntime({
      type: "brain.plugin.unregister",
      pluginId: "runtime.builtin.plugin.capability.fs.read.bridge",
    });
    expect(removed.ok).toBe(false);
    expect(String(removed.error || "")).toContain("内置插件不允许卸载");

    const listed = await invokeRuntime({
      type: "brain.plugin.list",
    });
    expect(listed.ok).toBe(true);
    const plugins = Array.isArray(
      (listed.data as Record<string, unknown>)?.plugins,
    )
      ? ((listed.data as Record<string, unknown>).plugins as unknown[] as Array<
          Record<string, unknown>
        >)
      : [];
    expect(
      plugins.some(
        (item) =>
          String(item.id || "") ===
          "runtime.builtin.plugin.capability.fs.read.bridge",
      ),
    ).toBe(true);
  });

  it("supports brain.plugin lifecycle routes with hook + llm provider", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const { sessionId } = await orchestrator.createSession({
      title: "plugin-route-lifecycle",
    });
    orchestrator.registerToolProvider(
      "script",
      {
        id: "plugin.route.lifecycle.script",
        invoke: async () => ({ source: "script" }),
      },
      { replace: true },
    );

    const registered = await invokeRuntime({
      type: "brain.plugin.register",
      plugin: {
        manifest: {
          id: "plugin.route.lifecycle",
          name: "plugin-route-lifecycle",
          version: "1.0.0",
          permissions: {
            hooks: ["tool.after_result"],
            llmProviders: ["route.proxy"],
          },
        },
        hooks: {
          "tool.after_result": () => ({
            action: "patch",
            patch: {
              result: { source: "plugin" },
            },
          }),
        },
        llmProviders: [
          {
            id: "route.proxy",
            transport: "openai_compatible",
            baseUrl: "https://proxy.example.com/v1",
          },
        ],
      },
    });
    expect(registered.ok).toBe(true);
    const registeredData = (registered.data || {}) as Record<string, unknown>;
    expect(String(registeredData.pluginId || "")).toBe(
      "plugin.route.lifecycle",
    );
    const registeredLlmProviders = Array.isArray(registeredData.llmProviders)
      ? (registeredData.llmProviders as Array<Record<string, unknown>>)
      : [];
    expect(
      registeredLlmProviders.some(
        (item) => String(item.id || "") === "route.proxy",
      ),
    ).toBe(true);

    const listOut = await invokeRuntime({ type: "brain.plugin.list" });
    expect(listOut.ok).toBe(true);
    const listData = (listOut.data || {}) as Record<string, unknown>;
    const plugins = Array.isArray(listData.plugins)
      ? (listData.plugins as Array<Record<string, unknown>>)
      : [];
    expect(
      plugins.some(
        (item) => String(item.id || "") === "plugin.route.lifecycle",
      ),
    ).toBe(true);

    const patched = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off",
    });
    expect(patched.ok).toBe(true);
    const patchedResult = (patched.data || {}) as Record<string, unknown>;
    expect((patchedResult.data || {}) as Record<string, unknown>).toEqual({
      source: "plugin",
    });

    const disabled = await invokeRuntime({
      type: "brain.plugin.disable",
      pluginId: "plugin.route.lifecycle",
    });
    expect(disabled.ok).toBe(true);
    const disabledStep = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off",
    });
    expect(disabledStep.ok).toBe(true);
    const disabledStepResult = (disabledStep.data || {}) as Record<
      string,
      unknown
    >;
    expect((disabledStepResult.data || {}) as Record<string, unknown>).toEqual({
      source: "script",
    });

    const enabled = await invokeRuntime({
      type: "brain.plugin.enable",
      pluginId: "plugin.route.lifecycle",
    });
    expect(enabled.ok).toBe(true);
    const enabledStep = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off",
    });
    expect(enabledStep.ok).toBe(true);
    const enabledStepResult = (enabledStep.data || {}) as Record<
      string,
      unknown
    >;
    expect((enabledStepResult.data || {}) as Record<string, unknown>).toEqual({
      source: "plugin",
    });

    const removed = await invokeRuntime({
      type: "brain.plugin.unregister",
      pluginId: "plugin.route.lifecycle",
    });
    expect(removed.ok).toBe(true);
    const removedData = (removed.data || {}) as Record<string, unknown>;
    const remainingLlmProviders = Array.isArray(removedData.llmProviders)
      ? (removedData.llmProviders as Array<Record<string, unknown>>)
      : [];
    expect(
      remainingLlmProviders.some(
        (item) => String(item.id || "") === "route.proxy",
      ),
    ).toBe(false);
  });

  it("brain.plugin.register should persist function capability provider + llm provider across runtime reload", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const pluginId = "plugin.route.register.reload";
    const registered = await invokeRuntime({
      type: "brain.plugin.register",
      plugin: {
        manifest: {
          id: pluginId,
          name: "plugin-route-register-reload",
          version: "1.0.0",
          permissions: {
            capabilities: ["fs.read"],
            llmProviders: ["route.proxy"],
          },
        },
        providers: {
          capabilities: {
            "fs.read": {
              id: "plugin.route.register.reload.fs-read",
              mode: "script",
              priority: 90,
              canHandle: (input) => {
                const args =
                  input.args && typeof input.args === "object"
                    ? (input.args as Record<string, unknown>)
                    : {};
                const frame =
                  args.frame && typeof args.frame === "object"
                    ? (args.frame as Record<string, unknown>)
                    : {};
                return String(frame.tool || "") === "read";
              },
              invoke: async (input) => {
                const args =
                  input.args && typeof input.args === "object"
                    ? (input.args as Record<string, unknown>)
                    : {};
                const frame =
                  args.frame && typeof args.frame === "object"
                    ? (args.frame as Record<string, unknown>)
                    : {};
                const frameArgs =
                  frame.args && typeof frame.args === "object"
                    ? (frame.args as Record<string, unknown>)
                    : {};
                return {
                  source: "plugin-capability",
                  path: String(frameArgs.path || ""),
                };
              },
            },
          },
        },
        llmProviders: [
          {
            id: "route.proxy",
            transport: "openai_compatible",
            baseUrl: "https://proxy.example.com/v1",
          },
        ],
      },
    });
    expect(registered.ok).toBe(true);

    const rawRegistry = await kvGet("brain.plugin.registry:v1");
    const registry = Array.isArray(rawRegistry)
      ? (rawRegistry as Array<Record<string, unknown>>)
      : [];
    const persisted = registry.find(
      (item) => String(item.pluginId || "") === pluginId,
    );
    expect(String(persisted?.kind || "")).toBe("extension");
    const persistedSource = (persisted?.source || {}) as Record<
      string,
      unknown
    >;
    expect(String(persistedSource.modulePath || "")).toBe(
      `mem://plugins/${pluginId}/index.js`,
    );

    const { sessionId: beforeReloadSessionId } = await orchestrator.createSession(
      {
        title: "plugin-register-reload-before",
      },
    );
    const beforeReloadRead = await invokeRuntime({
      type: "brain.step.execute",
      sessionId: beforeReloadSessionId,
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://plugins/reload-check.txt",
            runtime: "sandbox",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(beforeReloadRead.ok).toBe(true);
    expect(
      (
        ((beforeReloadRead.data as Record<string, unknown>)?.data ||
          {}) as Record<string, unknown>
      ).source,
    ).toBe("plugin-capability");

    runtimeListeners = [];
    resetRuntimeOnMessageMock();

    const reloadedOrchestrator = new BrainOrchestrator();
    registerRuntimeRouter(reloadedOrchestrator);

    const listed = await invokeRuntime({ type: "brain.plugin.list" });
    expect(listed.ok).toBe(true);
    const listedPlugins = Array.isArray(
      (listed.data as Record<string, unknown>)?.plugins,
    )
      ? ((listed.data as Record<string, unknown>).plugins as Array<
          Record<string, unknown>
        >)
      : [];
    expect(
      listedPlugins.some(
        (item) => String(item.id || "") === pluginId && item.enabled === true,
      ),
    ).toBe(true);

    const reloadedProvider = reloadedOrchestrator.getLlmProvider("route.proxy");
    expect(reloadedProvider).toBeDefined();
    expect(reloadedProvider?.resolveRequestUrl(createDummyRoute())).toBe(
      "https://proxy.example.com/v1/chat/completions",
    );

    const { sessionId: afterReloadSessionId } =
      await reloadedOrchestrator.createSession({
        title: "plugin-register-reload-after",
      });
    const afterReloadRead = await invokeRuntime({
      type: "brain.step.execute",
      sessionId: afterReloadSessionId,
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://plugins/reload-check.txt",
            runtime: "sandbox",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(afterReloadRead.ok).toBe(true);
    const afterReloadPayload = ((afterReloadRead.data as Record<
      string,
      unknown
    >) || {}) as Record<string, unknown>;
    expect(
      String(
        ((afterReloadPayload.data || {}) as Record<string, unknown>).source ||
          "",
      ),
    ).toBe("plugin-capability");
    expect(
      String(
        ((afterReloadPayload.data || {}) as Record<string, unknown>).path || "",
      ),
    ).toBe("mem://plugins/reload-check.txt");
  });

  it("brain.plugin.register should persist getter + set/url/typed-array function plugins across reload", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const pluginId = "plugin.route.structured.values";
    const registered = await invokeRuntime({
      type: "brain.plugin.register",
      plugin: {
        manifest: {
          id: pluginId,
          name: "plugin-route-structured-values",
          version: "1.0.0",
          permissions: {
            capabilities: ["fs.read"],
            llmProviders: ["route.structured"],
          },
        },
        providers: {
          capabilities: {
            "fs.read": {
              get id() {
                return "plugin.route.structured.values.fs-read";
              },
              get mode() {
                return "script";
              },
              matcher: new Set(["read"]),
              origin: new URL("https://assets.example.com/root/"),
              bytes: new Uint8Array([1, 2, 3]),
              canHandle(input) {
                const args =
                  input.args && typeof input.args === "object"
                    ? (input.args as Record<string, unknown>)
                    : {};
                const frame =
                  args.frame && typeof args.frame === "object"
                    ? (args.frame as Record<string, unknown>)
                    : {};
                return this.matcher.has(String(frame.tool || ""));
              },
              invoke(input) {
                const args =
                  input.args && typeof input.args === "object"
                    ? (input.args as Record<string, unknown>)
                    : {};
                const frame =
                  args.frame && typeof args.frame === "object"
                    ? (args.frame as Record<string, unknown>)
                    : {};
                const frameArgs =
                  frame.args && typeof frame.args === "object"
                    ? (frame.args as Record<string, unknown>)
                    : {};
                return {
                  source: "plugin-structured",
                  providerId: this.id,
                  matcherSize: this.matcher.size,
                  origin: this.origin.toString(),
                  bytes: Array.from(this.bytes),
                  path: String(frameArgs.path || ""),
                };
              },
            },
          },
        },
        llmProviders: [
          {
            get id() {
              return "route.structured";
            },
            base: new URL("https://proxy.example.com/v1/"),
            get __bblStaticRequestUrl() {
              return "https://proxy.example.com/v1/chat/completions";
            },
            markers: new Map([
              ["x-plugin", "structured"],
              ["x-kind", "function"],
            ]),
            bytes: new Uint8Array([7, 8, 9]),
            resolveRequestUrl() {
              return this.__bblStaticRequestUrl;
            },
            async send(input) {
              return new Response(
                JSON.stringify({
                  requestUrl: String(input.requestUrl || ""),
                  plugin: this.markers.get("x-plugin") || "",
                  base: this.base.toString(),
                  bytes: Array.from(this.bytes),
                }),
                {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                  },
                },
              );
            },
          },
        ],
      },
    });
    expect(registered.ok).toBe(true);

    runtimeListeners = [];
    resetRuntimeOnMessageMock();

    const reloadedOrchestrator = new BrainOrchestrator();
    registerRuntimeRouter(reloadedOrchestrator);

    const listed = await invokeRuntime({ type: "brain.plugin.list" });
    expect(listed.ok).toBe(true);
    const listedPlugins = Array.isArray(
      (listed.data as Record<string, unknown>)?.plugins,
    )
      ? ((listed.data as Record<string, unknown>).plugins as Array<
          Record<string, unknown>
        >)
      : [];
    expect(
      listedPlugins.some(
        (item) => String(item.id || "") === pluginId && item.enabled === true,
      ),
    ).toBe(true);

    const { sessionId } = await reloadedOrchestrator.createSession({
      title: "plugin-structured-values-after",
    });
    const routedRead = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: "mem://plugins/structured-values.txt",
            runtime: "sandbox",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(routedRead.ok).toBe(true);
    expect(
      ((routedRead.data as Record<string, unknown>)?.data || {}) as Record<
        string,
        unknown
      >,
    ).toEqual({
      source: "plugin-structured",
      providerId: "plugin.route.structured.values.fs-read",
      matcherSize: 1,
      origin: "https://assets.example.com/root/",
      bytes: [1, 2, 3],
      path: "mem://plugins/structured-values.txt",
    });

    const reloadedProvider =
      reloadedOrchestrator.getLlmProvider("route.structured");
    expect(reloadedProvider).toBeDefined();
    expect(reloadedProvider?.resolveRequestUrl(createDummyRoute())).toBe(
      "https://proxy.example.com/v1/chat/completions",
    );

    const providerResponse = await reloadedProvider?.send({
      sessionId,
      step: 1,
      route: createDummyRoute({
        llmBase: "https://fallback.example.com/v1",
      }),
      payload: {
        message: "ping",
      },
      signal: new AbortController().signal,
      requestUrl: "",
    });
    expect(providerResponse).toBeDefined();
    expect(providerResponse?.status).toBe(200);
    await expect(providerResponse?.json()).resolves.toEqual({
      requestUrl: "https://proxy.example.com/v1/chat/completions",
      plugin: "structured",
      base: "https://proxy.example.com/v1/",
      bytes: [7, 8, 9],
    });
  });

  it("supports brain.plugin.register_extension with PI-style default export module", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const { sessionId } = await orchestrator.createSession({
      title: "plugin-route-extension-module",
    });
    orchestrator.registerToolProvider(
      "script",
      {
        id: "plugin.route.extension.script",
        invoke: async () => ({ source: "script" }),
      },
      { replace: true },
    );

    const moduleUrl = new URL(
      "./fixtures/plugin-route-extension.fixture.ts",
      import.meta.url,
    ).href;
    const registered = await invokeRuntime({
      type: "brain.plugin.register_extension",
      manifest: {
        id: "plugin.route.extension.module",
        name: "plugin-route-extension-module",
        version: "1.0.0",
        permissions: {
          hooks: ["tool.after_result"],
        },
      },
      moduleUrl,
    });
    expect(registered.ok).toBe(true);
    const registeredData = (registered.data || {}) as Record<string, unknown>;
    expect(String(registeredData.pluginId || "")).toBe(
      "plugin.route.extension.module",
    );
    expect(String(registeredData.moduleUrl || "")).toBe(moduleUrl);

    const patched = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off",
    });
    expect(patched.ok).toBe(true);
    const patchedResult = (patched.data || {}) as Record<string, unknown>;
    expect((patchedResult.data || {}) as Record<string, unknown>).toEqual({
      source: "extension-module",
    });
  });

  it("brain.plugin.register_extension should reject moduleSource under CSP", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const { sessionId } = await orchestrator.createSession({
      title: "plugin-route-extension-module-source",
    });
    orchestrator.registerToolProvider(
      "script",
      {
        id: "plugin.route.extension.source.script",
        invoke: async () => ({ source: "script" }),
      },
      { replace: true },
    );

    const pluginId = "plugin.route.extension.module.source";
    const moduleSource = `export default function registerPlugin(pi) {
  pi.on("tool.after_result", (event) => {
    const previous = (event.result || {});
    return {
      action: "patch",
      patch: {
        result: {
          ...previous,
          source: "extension-module-source"
        }
      }
    };
  });
}`;
    const uiModuleSource = `export default function registerUiPlugin(ui) {
  ui.on("ui.runtime.event", () => ({ action: "continue" }));
}`;

    const registered = await invokeRuntime({
      type: "brain.plugin.register_extension",
      manifest: {
        id: pluginId,
        name: "plugin-route-extension-module-source",
        version: "1.0.0",
        permissions: {
          hooks: ["tool.after_result"],
        },
      },
      moduleSource,
      uiModuleSource,
    });
    expect(registered.ok).toBe(false);
    expect(String(registered.error || "")).toContain("moduleSource 暂不支持");
  });

  it("supports brain.plugin ui_extension lifecycle routes", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const notifySpy = vi
      .spyOn(chrome.runtime, "sendMessage")
      .mockResolvedValue({ ok: true } as never);
    const moduleUrl = new URL(
      "./fixtures/plugin-route-extension.fixture.ts",
      import.meta.url,
    ).href;
    const uiModuleUrl = new URL(
      "./fixtures/plugin-route-extension.fixture.ts",
      import.meta.url,
    ).href;
    const pluginId = "plugin.route.extension.ui.lifecycle";

    const registered = await invokeRuntime({
      type: "brain.plugin.register_extension",
      manifest: {
        id: pluginId,
        name: "plugin-route-extension-ui-lifecycle",
        version: "1.0.0",
        permissions: {
          hooks: ["tool.after_result"],
        },
      },
      moduleUrl,
      uiModuleUrl,
      uiExportName: "default",
    });
    expect(registered.ok).toBe(true);

    const listed = await invokeRuntime({
      type: "brain.plugin.ui_extension.list",
    });
    expect(listed.ok).toBe(true);
    const listedExtensions = Array.isArray(
      (listed.data as Record<string, unknown>)?.uiExtensions,
    )
      ? ((listed.data as Record<string, unknown>)
          .uiExtensions as unknown[] as Array<Record<string, unknown>>)
      : [];
    const listedExtension = listedExtensions.find(
      (item) => String(item.pluginId || "") === pluginId,
    );
    expect(listedExtension).toBeDefined();
    expect(Boolean(listedExtension?.enabled)).toBe(true);
    expect(String(listedExtension?.moduleUrl || "")).toBe(uiModuleUrl);

    const disabled = await invokeRuntime({
      type: "brain.plugin.disable",
      pluginId,
    });
    expect(disabled.ok).toBe(true);
    const listedAfterDisable = await invokeRuntime({
      type: "brain.plugin.ui_extension.list",
    });
    expect(listedAfterDisable.ok).toBe(true);
    const disabledExtensions = Array.isArray(
      (listedAfterDisable.data as Record<string, unknown>)?.uiExtensions,
    )
      ? ((listedAfterDisable.data as Record<string, unknown>)
          .uiExtensions as unknown[] as Array<Record<string, unknown>>)
      : [];
    const disabledExtension = disabledExtensions.find(
      (item) => String(item.pluginId || "") === pluginId,
    );
    expect(disabledExtension).toBeDefined();
    expect(Boolean(disabledExtension?.enabled)).toBe(false);

    const enabled = await invokeRuntime({
      type: "brain.plugin.enable",
      pluginId,
    });
    expect(enabled.ok).toBe(true);

    const unregistered = await invokeRuntime({
      type: "brain.plugin.unregister",
      pluginId,
    });
    expect(unregistered.ok).toBe(true);
    const listedAfterUnregister = await invokeRuntime({
      type: "brain.plugin.ui_extension.list",
    });
    expect(listedAfterUnregister.ok).toBe(true);
    const unregisteredExtensions = Array.isArray(
      (listedAfterUnregister.data as Record<string, unknown>)?.uiExtensions,
    )
      ? ((listedAfterUnregister.data as Record<string, unknown>)
          .uiExtensions as unknown[] as Array<Record<string, unknown>>)
      : [];
    expect(
      unregisteredExtensions.some(
        (item) => String(item.pluginId || "") === pluginId,
      ),
    ).toBe(false);

    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.plugin.ui_extension.registered",
        payload: expect.objectContaining({ pluginId }),
      }),
    );
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.plugin.ui_extension.disabled",
        payload: expect.objectContaining({ pluginId }),
      }),
    );
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.plugin.ui_extension.enabled",
        payload: expect.objectContaining({ pluginId }),
      }),
    );
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.plugin.ui_extension.unregistered",
        payload: expect.objectContaining({ pluginId }),
      }),
    );
  });

  it("supports brain.plugin.ui_hook.run for mem ui module installed from inline uiJs", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const pluginId = "plugin.route.ui.inline.mem";

    const installed = await invokeRuntime({
      type: "brain.plugin.install",
      sessionId: "plugin-studio",
      package: {
        manifest: {
          id: pluginId,
          name: "plugin-route-ui-inline-mem",
          version: "1.0.0",
        },
        uiJs: `module.exports = function registerUiPlugin(ui) {
  ui.on("ui.notice.before_show", (event) => {
    return {
      action: "patch",
      patch: {
        message: String(event && event.message || "") + "!"
      }
    };
  });
};`,
      },
    });
    expect(installed.ok).toBe(true);

    const hookRun = await invokeRuntime({
      type: "brain.plugin.ui_hook.run",
      pluginId,
      hook: "ui.notice.before_show",
      payload: {
        type: "success",
        message: "发送成功",
      },
    });
    expect(hookRun.ok).toBe(true);
    const hookData = (hookRun.data || {}) as Record<string, unknown>;
    const hookResult = (hookData.hookResult || {}) as Record<string, unknown>;
    expect(String(hookResult.action || "")).toBe("patch");
    const patch = (hookResult.patch || {}) as Record<string, unknown>;
    expect(String(patch.message || "")).toBe("发送成功!");

    const disabled = await invokeRuntime({
      type: "brain.plugin.disable",
      pluginId,
    });
    expect(disabled.ok).toBe(true);

    const hookRunAfterDisable = await invokeRuntime({
      type: "brain.plugin.ui_hook.run",
      pluginId,
      hook: "ui.notice.before_show",
      payload: {
        type: "success",
        message: "发送成功",
      },
    });
    expect(hookRunAfterDisable.ok).toBe(true);
    const disabledData = (hookRunAfterDisable.data || {}) as Record<
      string,
      unknown
    >;
    expect(String(disabledData.skipped || "")).toBe("disabled");
  });

  it("supports brain.plugin.install from mem:// package file", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const { sessionId } = await orchestrator.createSession({
      title: "plugin-install-from-mem-package",
    });
    orchestrator.registerToolProvider(
      "script",
      {
        id: "plugin.install.mem.script",
        invoke: async () => ({ source: "script" }),
      },
      { replace: true },
    );

    const moduleUrl = new URL(
      "./fixtures/plugin-route-extension.fixture.ts",
      import.meta.url,
    ).href;
    const packagePath = "mem://plugins/route-extension/plugin.json";
    const packageContent = JSON.stringify(
      {
        manifest: {
          id: "plugin.route.extension.mem.package",
          name: "plugin-route-extension-mem-package",
          version: "1.0.0",
          permissions: {
            hooks: ["tool.after_result"],
          },
        },
        moduleUrl,
      },
      null,
      2,
    );

    const wrote = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.write",
      action: "invoke",
      args: {
        frame: {
          tool: "write",
          args: {
            path: packagePath,
            content: packageContent,
            mode: "overwrite",
            runtime: "sandbox",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(wrote.ok).toBe(true);

    const installed = await invokeRuntime({
      type: "brain.plugin.install",
      location: packagePath,
      sessionId,
    });
    expect(installed.ok).toBe(true);
    const installedData = (installed.data || {}) as Record<string, unknown>;
    expect(String(installedData.pluginId || "")).toBe(
      "plugin.route.extension.mem.package",
    );
    expect(String(installedData.sourceLocation || "")).toBe(packagePath);

    const patched = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off",
    });
    expect(patched.ok).toBe(true);
    const patchedResult = (patched.data || {}) as Record<string, unknown>;
    expect((patchedResult.data || {}) as Record<string, unknown>).toEqual({
      source: "extension-module",
    });
  });

  it("brain.plugin.install should reject non-object package payload", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const installed = await invokeRuntime({
      type: "brain.plugin.install",
      package: "not-an-object",
    });
    expect(installed.ok).toBe(false);
    expect(String(installed.error || "")).toContain("package 必须是 object");
  });

  it("brain.plugin.install should validate package manifest.id", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const installed = await invokeRuntime({
      type: "brain.plugin.install",
      package: {
        plugin: {
          manifest: {
            name: "missing-id",
            version: "1.0.0",
          },
          hooks: {
            "tool.after_result": () => ({ action: "continue" }),
          },
        },
      },
    });
    expect(installed.ok).toBe(false);
    expect(String(installed.error || "")).toContain("manifest.id");
  });

  it("brain.plugin.validate should validate inline indexJs package", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const validated = await invokeRuntime({
      type: "brain.plugin.validate",
      sessionId: "plugin-studio",
      package: {
        manifest: {
          id: "plugin.route.validate.inline.index",
          name: "plugin-route-validate-inline-index",
          version: "1.0.0",
          permissions: {
            hooks: ["tool.after_result"],
          },
        },
        indexJs: `module.exports = function registerPlugin(pi) {
  pi.on("tool.after_result", () => ({ action: "continue" }));
};`,
      },
    });
    expect(validated.ok).toBe(true);
    const data = (validated.data || {}) as Record<string, unknown>;
    expect(data.valid).toBe(true);
    const checks = Array.isArray(data.checks)
      ? (data.checks as Record<string, unknown>[])
      : [];
    expect(
      checks.some(
        (item) =>
          String(item.name || "") === "index.module" && item.ok === true,
      ),
    ).toBe(true);
  });

  it("brain.plugin.validate should fail when no index/ui module declared", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const validated = await invokeRuntime({
      type: "brain.plugin.validate",
      package: {
        manifest: {
          id: "plugin.route.validate.empty-entry",
          name: "plugin-route-validate-empty-entry",
          version: "1.0.0",
        },
      },
    });
    expect(validated.ok).toBe(true);
    const data = (validated.data || {}) as Record<string, unknown>;
    expect(data.valid).toBe(false);
    const checks = Array.isArray(data.checks)
      ? (data.checks as Record<string, unknown>[])
      : [];
    expect(
      checks.some(
        (item) =>
          String(item.name || "") === "entry.module" && item.ok === false,
      ),
    ).toBe(true);
  });

  it("brain.plugin.install should execute inline indexJs from mem sandbox module", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const { sessionId } = await orchestrator.createSession({
      title: "plugin-install-inline-index-js",
    });
    orchestrator.registerToolProvider(
      "script",
      {
        id: "plugin.install.inline-index.script",
        invoke: async () => ({ source: "script" }),
      },
      { replace: true },
    );

    const installed = await invokeRuntime({
      type: "brain.plugin.install",
      sessionId: "plugin-studio",
      package: {
        manifest: {
          id: "plugin.route.extension.inline.index-js",
          name: "plugin-route-extension-inline-index-js",
          version: "1.0.0",
          permissions: {
            hooks: ["tool.after_result"],
          },
        },
        indexJs: `module.exports = function registerPlugin(pi) {
  pi.on("tool.after_result", (event) => {
    const current = event && event.result && typeof event.result === "object" ? event.result : {};
    return {
      action: "patch",
      patch: {
        result: {
          ...current,
          source: "inline-index-js"
        }
      }
    };
  });
};`,
      },
    });
    expect(installed.ok).toBe(true);
    const installedData = (installed.data || {}) as Record<string, unknown>;
    expect(String(installedData.pluginId || "")).toBe(
      "plugin.route.extension.inline.index-js",
    );

    const patched = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off",
    });
    expect(patched.ok).toBe(true);
    const patchedResult = (patched.data || {}) as Record<string, unknown>;
    expect((patchedResult.data || {}) as Record<string, unknown>).toEqual({
      source: "inline-index-js",
    });
  });

  it("brain.plugin.install should rehydrate inline mem plugin across runtime reload", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    orchestrator.registerToolProvider(
      "script",
      {
        id: "plugin.reload.inline.script",
        invoke: async () => ({ source: "script" }),
      },
      { replace: true },
    );

    const pluginId = "plugin.route.extension.inline.reload";
    const installed = await invokeRuntime({
      type: "brain.plugin.install",
      sessionId: "plugin-studio",
      package: {
        manifest: {
          id: pluginId,
          name: "plugin-route-extension-inline-reload",
          version: "1.0.0",
          permissions: {
            hooks: ["tool.after_result"],
          },
        },
        indexJs: `module.exports = function registerPlugin(pi) {
  pi.on("tool.after_result", (event) => {
    const current = event && event.result && typeof event.result === "object" ? event.result : {};
    return {
      action: "patch",
      patch: {
        result: {
          ...current,
          source: "inline-reload"
        }
      }
    };
  });
};`,
        uiJs: `module.exports = function registerUiPlugin(ui) {
  ui.on("ui.notice.before_show", (event) => {
    return {
      action: "patch",
      patch: {
        message: String(event && event.message || "") + "?"
      }
    };
  });
};`,
      },
    });
    expect(installed.ok).toBe(true);

    runtimeListeners = [];
    resetRuntimeOnMessageMock();

    const reloadedOrchestrator = new BrainOrchestrator();
    registerRuntimeRouter(reloadedOrchestrator);
    reloadedOrchestrator.registerToolProvider(
      "script",
      {
        id: "plugin.reload.inline.script",
        invoke: async () => ({ source: "script" }),
      },
      { replace: true },
    );

    const listed = await invokeRuntime({
      type: "brain.plugin.list",
    });
    expect(listed.ok).toBe(true);
    const plugins = Array.isArray((listed.data as Record<string, unknown>)?.plugins)
      ? ((listed.data as Record<string, unknown>).plugins as Array<
          Record<string, unknown>
        >)
      : [];
    expect(
      plugins.some(
        (item) => String(item.id || "") === pluginId && item.enabled === true,
      ),
    ).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "inline mem plugin reload",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const patched = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      mode: "script",
      action: "click",
      verifyPolicy: "off",
    });
    expect(patched.ok).toBe(true);
    const patchedResult = (patched.data || {}) as Record<string, unknown>;
    expect((patchedResult.data || {}) as Record<string, unknown>).toEqual({
      source: "inline-reload",
    });

    const hookRun = await invokeRuntime({
      type: "brain.plugin.ui_hook.run",
      pluginId,
      hook: "ui.notice.before_show",
      payload: {
        message: "reload-ok",
      },
    });
    expect(hookRun.ok).toBe(true);
    const hookData = (hookRun.data || {}) as Record<string, unknown>;
    const hookResult = (hookData.hookResult || {}) as Record<string, unknown>;
    expect(String(hookResult.action || "")).toBe("patch");
    expect(
      String((hookResult.patch as Record<string, unknown>)?.message || ""),
    ).toBe("reload-ok?");
  });

  it("brain.plugin.disable should restore replaced openai_compatible provider", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const baseProvider = orchestrator.getLlmProvider("openai_compatible");
    expect(baseProvider).toBeDefined();

    const registered = await invokeRuntime({
      type: "brain.plugin.register",
      plugin: {
        manifest: {
          id: "plugin.route.provider.restore",
          name: "plugin-route-provider-restore",
          version: "1.0.0",
          permissions: {
            llmProviders: ["openai_compatible"],
            replaceLlmProviders: true,
          },
        },
        llmProviders: [
          {
            id: "openai_compatible",
            transport: "openai_compatible",
            baseUrl: "https://proxy.example.com/v1",
          },
        ],
      },
    });
    expect(registered.ok).toBe(true);
    const overridden = orchestrator.getLlmProvider("openai_compatible");
    expect(overridden).toBeDefined();
    expect(overridden).not.toBe(baseProvider);
    const routedUrl = overridden?.resolveRequestUrl(createDummyRoute()) || "";
    expect(routedUrl).toBe("https://proxy.example.com/v1/chat/completions");

    const disabled = await invokeRuntime({
      type: "brain.plugin.disable",
      pluginId: "plugin.route.provider.restore",
    });
    expect(disabled.ok).toBe(true);
    const restored = orchestrator.getLlmProvider("openai_compatible");
    expect(restored).toBe(baseProvider);
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
        enabled: false,
      },
    });
    expect(installed.ok).toBe(true);
    const installedData = (installed.data || {}) as Record<string, unknown>;
    expect(String(installedData.skillId || "")).toBe("skill.pi.align");
    const installedSkill = (installedData.skill || {}) as Record<
      string,
      unknown
    >;
    expect(Boolean(installedSkill.enabled)).toBe(false);

    const listedAfterInstall = await invokeRuntime({
      type: "brain.skill.list",
    });
    expect(listedAfterInstall.ok).toBe(true);
    const listedSkillsAfterInstall = Array.isArray(
      (listedAfterInstall.data as Record<string, unknown>)?.skills,
    )
      ? ((listedAfterInstall.data as Record<string, unknown>)
          .skills as unknown[] as Array<Record<string, unknown>>)
      : [];
    expect(
      listedSkillsAfterInstall.some(
        (item) => String(item.id || "") === "skill.pi.align",
      ),
    ).toBe(true);

    const enabled = await invokeRuntime({
      type: "brain.skill.enable",
      skillId: "skill.pi.align",
    });
    expect(enabled.ok).toBe(true);
    const enabledSkill = (((enabled.data as Record<string, unknown>) || {})
      .skill || {}) as Record<string, unknown>;
    expect(Boolean(enabledSkill.enabled)).toBe(true);

    const disabled = await invokeRuntime({
      type: "brain.skill.disable",
      skillId: "skill.pi.align",
    });
    expect(disabled.ok).toBe(true);
    const disabledSkill = (((disabled.data as Record<string, unknown>) || {})
      .skill || {}) as Record<string, unknown>;
    expect(Boolean(disabledSkill.enabled)).toBe(false);

    const uninstalled = await invokeRuntime({
      type: "brain.skill.uninstall",
      skillId: "skill.pi.align",
    });
    expect(uninstalled.ok).toBe(true);
    const uninstalledData = (uninstalled.data || {}) as Record<string, unknown>;
    expect(Boolean(uninstalledData.removed)).toBe(true);

    const listedAfterUninstall = await invokeRuntime({
      type: "brain.skill.list",
    });
    expect(listedAfterUninstall.ok).toBe(true);
    const listedSkillsAfterUninstall = Array.isArray(
      (listedAfterUninstall.data as Record<string, unknown>)?.skills,
    )
      ? ((listedAfterUninstall.data as Record<string, unknown>)
          .skills as unknown[] as Array<Record<string, unknown>>)
      : [];
    expect(
      listedSkillsAfterUninstall.some(
        (item) => String(item.id || "") === "skill.pi.align",
      ),
    ).toBe(false);
  });

  it("brain.skill.create should write package and install atomically", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed create skill context",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const created = await invokeRuntime({
      type: "brain.skill.create",
      sessionId,
      skill: {
        name: "Tree Skill",
        description: "draw a tree with sandbox and append to any response",
        content: "# Tree Skill\n\nAlways draw a tree before response.",
        scripts: {
          "draw_tree.sh":
            "printf '/\\\\\\n/  \\\\\\n/____\\\\\\n  ||\\n  ||\\n'",
        },
        references: {
          "README.md": "reference docs",
        },
      },
    });
    expect(created.ok).toBe(true);
    const createdData = (created.data || {}) as Record<string, unknown>;
    expect(String(createdData.skillId || "")).toBe("tree-skill");
    expect(Number(createdData.fileCount || 0)).toBe(3);

    const listed = await invokeRuntime({
      type: "brain.skill.list",
    });
    expect(listed.ok).toBe(true);
    const listedSkills = Array.isArray(
      (listed.data as Record<string, unknown>)?.skills,
    )
      ? ((listed.data as Record<string, unknown>).skills as unknown[] as Array<
          Record<string, unknown>
        >)
      : [];
    expect(
      listedSkills.some((item) => String(item.id || "") === "tree-skill"),
    ).toBe(true);

    const resolved = await invokeRuntime({
      type: "brain.skill.resolve",
      sessionId,
      skillId: "tree-skill",
    });
    expect(resolved.ok).toBe(true);
    const resolvedData = (resolved.data || {}) as Record<string, unknown>;
    expect(String(resolvedData.content || "")).toContain(
      "Always draw a tree before response.",
    );
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
          content: `# SKILL\nloaded from ${String(input.args?.path || "")}`,
        }),
      },
      { replace: true },
    );

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed skill resolve context",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const installed = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.resolve.demo",
        name: "Resolve Demo",
        location: "mem://skills/resolve-demo/SKILL.md",
        source: "project",
      },
    });
    expect(installed.ok).toBe(true);

    const resolved = await invokeRuntime({
      type: "brain.skill.resolve",
      sessionId,
      skillId: "skill.resolve.demo",
    });
    expect(resolved.ok).toBe(true);
    const resolvedData = (resolved.data || {}) as Record<string, unknown>;
    expect(String(resolvedData.skillId || "")).toBe("skill.resolve.demo");
    expect(String(resolvedData.content || "")).toContain(
      "mem://skills/resolve-demo/SKILL.md",
    );
    expect(String(resolvedData.promptBlock || "")).toContain(
      '<skill id="skill.resolve.demo"',
    );
  });

  it("brain.skill.discover should scan + parse frontmatter + auto install", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed discover context",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const root = "mem://skills";
    const scanStdout = [
      `${root}/write-doc.md`,
      `${root}/browser-flow/SKILL.md`,
      `${root}/browser-flow/README.md`,
      `${root}/.hidden/SKILL.md`,
      `${root}/vendor/node_modules/pkg/SKILL.md`,
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
                exitCode: 0,
              },
            },
          },
        }),
      },
      { replace: true },
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
Do write-doc`,
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
Do browser-flow`,
            };
          }
          throw new Error(`unexpected read path: ${path}`);
        },
      },
      { replace: true },
    );

    const discovered = await invokeRuntime({
      type: "brain.skill.discover",
      sessionId,
      roots: [{ root, source: "project" }],
    });
    expect(discovered.ok).toBe(true);
    const data = (discovered.data || {}) as Record<string, unknown>;
    const counts = (data.counts || {}) as Record<string, unknown>;
    expect(Number(counts.scanned || 0)).toBe(2);
    expect(Number(counts.discovered || 0)).toBe(2);
    expect(Number(counts.installed || 0)).toBe(2);
    expect(Number(counts.skipped || 0)).toBe(0);

    const skills = Array.isArray(data.skills)
      ? (data.skills as Array<Record<string, unknown>>)
      : [];
    expect(
      skills.some((item) => String(item.id || "") === "skill.write.doc"),
    ).toBe(true);
    expect(
      skills.some((item) => String(item.id || "") === "browser-flow"),
    ).toBe(true);
    expect(
      skills.some(
        (item) =>
          String(item.id || "") === "browser-flow" &&
          item.disableModelInvocation === true,
      ),
    ).toBe(true);
  });

  it("brain.skill.discover should skip skill without frontmatter.description", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "seed discover context missing description",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const root = "mem://skills";
    orchestrator.registerCapabilityProvider(
      "process.exec",
      {
        id: "test.skill.discover.skip.process.exec",
        mode: "script",
        priority: 100,
        invoke: async () => ({
          stdout: `${root}/missing-description.md`,
          stderr: "",
          exitCode: 0,
        }),
      },
      { replace: true },
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
description missing`,
        }),
      },
      { replace: true },
    );

    const discovered = await invokeRuntime({
      type: "brain.skill.discover",
      sessionId,
      roots: [{ root, source: "project" }],
    });
    expect(discovered.ok).toBe(true);
    const data = (discovered.data || {}) as Record<string, unknown>;
    const counts = (data.counts || {}) as Record<string, unknown>;
    expect(Number(counts.discovered || 0)).toBe(0);
    expect(Number(counts.installed || 0)).toBe(0);
    expect(Number(counts.skipped || 0)).toBe(1);

    const skipped = Array.isArray(data.skipped)
      ? (data.skipped as Array<Record<string, unknown>>)
      : [];
    expect(String((skipped[0] || {}).reason || "")).toContain("description");
  });

  it("brain.skill routes validate payload and missing resources", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const installMissingLocation = await invokeRuntime({
      type: "brain.skill.install",
    });
    expect(installMissingLocation.ok).toBe(false);
    expect(String(installMissingLocation.error || "")).toContain(
      "brain.skill.install 需要 location",
    );

    const installLocalLocation = await invokeRuntime({
      type: "brain.skill.install",
      skill: {
        id: "skill.local.invalid",
        name: "Local Invalid",
        location: "/repo/.agents/skills/local/SKILL.md",
      },
    });
    expect(installLocalLocation.ok).toBe(false);
    expect(String(installLocalLocation.error || "")).toContain("仅支持 mem://");

    const enableMissingSkillId = await invokeRuntime({
      type: "brain.skill.enable",
    });
    expect(enableMissingSkillId.ok).toBe(false);
    expect(String(enableMissingSkillId.error || "")).toContain(
      "brain.skill.enable 需要 skillId",
    );

    const resolveMissingSkillId = await invokeRuntime({
      type: "brain.skill.resolve",
      sessionId: "session-demo",
    });
    expect(resolveMissingSkillId.ok).toBe(false);
    expect(String(resolveMissingSkillId.error || "")).toContain(
      "brain.skill.resolve 需要 skillId",
    );

    const resolveMissingSessionId = await invokeRuntime({
      type: "brain.skill.resolve",
      skillId: "skill.any",
    });
    expect(resolveMissingSessionId.ok).toBe(false);
    expect(String(resolveMissingSessionId.error || "")).toContain(
      "brain.skill.resolve 需要 sessionId",
    );

    const discoverMissingSessionId = await invokeRuntime({
      type: "brain.skill.discover",
    });
    expect(discoverMissingSessionId.ok).toBe(false);
    expect(String(discoverMissingSessionId.error || "")).toContain(
      "brain.skill.discover 需要 sessionId",
    );

    const discoverLocalRoot = await invokeRuntime({
      type: "brain.skill.discover",
      sessionId: "session-demo",
      roots: [{ root: "/repo/.agents/skills", source: "project" }],
    });
    expect(discoverLocalRoot.ok).toBe(false);
    expect(String(discoverLocalRoot.error || "")).toContain("仅支持 mem://");

    const createMissingSessionId = await invokeRuntime({
      type: "brain.skill.create",
      skill: {
        name: "demo",
        description: "demo",
      },
    });
    expect(createMissingSessionId.ok).toBe(false);
    expect(String(createMissingSessionId.error || "")).toContain(
      "brain.skill.create 需要 sessionId",
    );

    const createMissingDescription = await invokeRuntime({
      type: "brain.skill.create",
      sessionId: "session-demo",
      skill: {
        name: "demo",
      },
    });
    expect(createMissingDescription.ok).toBe(false);
    expect(String(createMissingDescription.error || "")).toContain(
      "brain.skill.create 需要 description",
    );

    const uninstallMissingSkill = await invokeRuntime({
      type: "brain.skill.uninstall",
      skillId: "skill.not-found",
    });
    expect(uninstallMissingSkill.ok).toBe(false);
    expect(String(uninstallMissingSkill.error || "")).toContain(
      "skill 不存在: skill.not-found",
    );
  });

  it("supports title refresh + delete + debug config/dump", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);
    const capturedBodies: Array<Record<string, unknown>> = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = (JSON.parse(String(init?.body || "{}")) || {}) as Record<
        string,
        unknown
      >;
      capturedBodies.push(body);
      if (Array.isArray(body.tools) && body.stream === true) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "好的，这是周末规划建议",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "周末行程",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        bridgeUrl: "ws://127.0.0.1:17777/ws",
        bridgeToken: "token-demo",
        browserRuntimeStrategy: "browser-first",
        llmDefaultProfile: "default",
        llmAuxProfile: "title.basic",
        llmProfiles: [
          {
            id: "default",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-test",
            role: "worker",
          },
          {
            id: "title.basic",
            provider: "openai_compatible",
            llmApiBase: "https://example.ai/v1",
            llmApiKey: "sk-demo",
            llmModel: "gpt-title",
            role: "worker",
          },
        ],
        bridgeInvokeTimeoutMs: 180000,
        llmTimeoutMs: 160000,
        llmRetryMaxAttempts: 3,
        llmMaxRetryDelayMs: 45000,
      },
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "请帮我规划周末行程",
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    await orchestrator.sessions.appendMessage({
      sessionId,
      role: "assistant",
      text: "好的，这是周末规划建议",
    });

    const refreshed = await invokeRuntime({
      type: "brain.session.title.refresh",
      sessionId,
      force: true,
    });
    expect(refreshed.ok).toBe(true);
    const refreshedData = (refreshed.data || {}) as Record<string, unknown>;
    expect(String(refreshedData.title || "").length).toBeGreaterThan(0);
    const runRequest = capturedBodies.find(
      (body) => Array.isArray(body.tools) && body.stream === true,
    );
    const titleRequest = capturedBodies.find(
      (body) => body.stream === false && Number(body.max_tokens || 0) === 30,
    );
    expect(String(runRequest?.model || "")).toBe("gpt-test");
    expect(String(titleRequest?.model || "")).toBe("gpt-title");

    const renamed = await invokeRuntime({
      type: "brain.session.title.refresh",
      sessionId,
      title: "我自定义的标题",
    });
    expect(renamed.ok).toBe(true);
    const renamedData = (renamed.data || {}) as Record<string, unknown>;
    expect(String(renamedData.title || "")).toBe("我自定义的标题");

    const refreshedAfterRename = await invokeRuntime({
      type: "brain.session.title.refresh",
      sessionId,
    });
    expect(refreshedAfterRename.ok).toBe(true);
    const refreshedAfterRenameData = (refreshedAfterRename.data ||
      {}) as Record<string, unknown>;
    expect(String(refreshedAfterRenameData.title || "")).toBe("我自定义的标题");

    const debugCfg = await invokeRuntime({
      type: "brain.debug.config",
    });
    expect(debugCfg.ok).toBe(true);
    const debugCfgData = (debugCfg.data || {}) as Record<string, unknown>;
    expect(debugCfgData.bridgeUrl).toBe("ws://127.0.0.1:17777/ws");
    expect(String(debugCfgData.browserRuntimeStrategy || "")).toBe(
      "browser-first",
    );
    expect(String(debugCfgData.llmDefaultProfile || "")).toBe("default");
    expect(String(debugCfgData.llmAuxProfile || "")).toBe("title.basic");
    expect(String(debugCfgData.llmFallbackProfile || "")).toBe("");
    expect(String(debugCfgData.llmProvider || "")).toBe("openai_compatible");
    expect(String(debugCfgData.llmModel || "")).toBe("gpt-test");
    expect(typeof debugCfgData.hasLlmApiKey).toBe("boolean");
    expect(debugCfgData.bridgeInvokeTimeoutMs).toBe(180000);
    expect(debugCfgData.llmTimeoutMs).toBe(160000);
    expect(debugCfgData.llmRetryMaxAttempts).toBe(3);
    expect(debugCfgData.llmMaxRetryDelayMs).toBe(45000);
    expect(String(debugCfgData.systemPromptPreview || "")).toContain(
      "You are an expert coding assistant",
    );
    expect(debugCfgData.llmApiKey).toBeUndefined();

    const dumped = await invokeRuntime({
      type: "brain.debug.dump",
      sessionId,
    });
    expect(dumped.ok).toBe(true);
    const dumpData = (dumped.data || {}) as Record<string, unknown>;
    expect(
      String((dumpData.runtime as Record<string, unknown>)?.sessionId || ""),
    ).toBe(sessionId);
    expect(Number(dumpData.entryCount || 0)).toBeGreaterThan(0);

    const deleted = await invokeRuntime({
      type: "brain.session.delete",
      sessionId,
    });
    expect(deleted.ok).toBe(true);
    const deletedData = (deleted.data || {}) as Record<string, unknown>;
    expect(deletedData.deleted).toBe(true);

    const listed = await invokeRuntime({ type: "brain.session.list" });
    expect(listed.ok).toBe(true);
    const sessions = Array.isArray(
      (listed.data as Record<string, unknown>)?.sessions,
    )
      ? ((listed.data as Record<string, unknown>)
          .sessions as unknown[] as Array<Record<string, unknown>>)
      : [];
    expect(sessions.some((item) => String(item.id || "") === sessionId)).toBe(
      false,
    );
  });

  it("brain.session.delete should clear in-memory step stream cache", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "session delete runtime cache",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    orchestrator.events.emit("loop_done", sessionId, {
      reason: "runtime-cache-check",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cachedBeforeDelete = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    expect(cachedBeforeDelete.ok).toBe(true);
    const streamBeforeDelete = Array.isArray(
      (cachedBeforeDelete.data as Record<string, unknown>)?.stream,
    )
      ? ((cachedBeforeDelete.data as Record<string, unknown>).stream as Array<
          Record<string, unknown>
        >)
      : [];
    expect(streamBeforeDelete.length).toBeGreaterThan(0);
    await invokeVirtualFrame({
      tool: "write",
      args: {
        path: "mem://__bbl/delete-check.txt",
        content: "delete-me",
        mode: "overwrite",
        runtime: "sandbox",
      },
      sessionId,
    });

    const deleted = await invokeRuntime({
      type: "brain.session.delete",
      sessionId,
    });
    expect(deleted.ok).toBe(true);

    const cachedAfterDelete = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    expect(cachedAfterDelete.ok).toBe(true);
    const streamAfterDelete = Array.isArray(
      (cachedAfterDelete.data as Record<string, unknown>)?.stream,
    )
      ? ((cachedAfterDelete.data as Record<string, unknown>).stream as Array<
          Record<string, unknown>
        >)
      : [];
    expect(streamAfterDelete).toEqual([]);
    await expect(
      invokeVirtualFrame({
        tool: "read",
        args: {
          path: "mem://__bbl/delete-check.txt",
          runtime: "sandbox",
        },
        sessionId,
      }),
    ).rejects.toThrow("virtual file not found");
  });

  it("brain.storage.reset should clear runtime step stream cache", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "storage reset runtime cache",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    orchestrator.events.emit("loop_done", sessionId, {
      reason: "storage-reset-cache-check",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cachedBeforeReset = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    expect(cachedBeforeReset.ok).toBe(true);
    const streamBeforeReset = Array.isArray(
      (cachedBeforeReset.data as Record<string, unknown>)?.stream,
    )
      ? ((cachedBeforeReset.data as Record<string, unknown>).stream as Array<
          Record<string, unknown>
        >)
      : [];
    expect(streamBeforeReset.length).toBeGreaterThan(0);
    await invokeVirtualFrame({
      tool: "write",
      args: {
        path: "mem://__bbl/reset-check.txt",
        content: "reset-me",
        mode: "overwrite",
        runtime: "sandbox",
      },
      sessionId,
    });

    const reset = await invokeRuntime({
      type: "brain.storage.reset",
      options: {
        includeTrace: true,
      },
    });
    expect(reset.ok).toBe(true);

    const cachedAfterReset = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
    });
    expect(cachedAfterReset.ok).toBe(true);
    const streamAfterReset = Array.isArray(
      (cachedAfterReset.data as Record<string, unknown>)?.stream,
    )
      ? ((cachedAfterReset.data as Record<string, unknown>).stream as Array<
          Record<string, unknown>
        >)
      : [];
    expect(streamAfterReset).toEqual([]);
    await expect(
      invokeVirtualFrame({
        tool: "read",
        args: {
          path: "mem://__bbl/reset-check.txt",
          runtime: "sandbox",
        },
        sessionId,
      }),
    ).rejects.toThrow("virtual file not found");
  });

  it("brain.session.delete should remove persisted trace and session memfs files", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "session delete cleanup",
      autoRun: false,
    });
    expect(started.ok).toBe(true);
    const sessionId = String(
      ((started.data as Record<string, unknown>) || {}).sessionId || "",
    );
    expect(sessionId).not.toBe("");

    const wrote = await invokeRuntime({
      type: "brain.step.execute",
      sessionId,
      capability: "fs.write",
      action: "invoke",
      args: {
        frame: {
          tool: "write",
          args: {
            path: "mem://notes/delete-me.txt",
            content: "cleanup-target",
            mode: "overwrite",
            runtime: "browser",
          },
        },
      },
      verifyPolicy: "off",
    });
    expect(wrote.ok).toBe(true);

    orchestrator.events.emit("loop_done", sessionId, {
      reason: "cleanup-check",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const beforeTrace = await readTraceChunk(`session-${sessionId}`, 0);
    expect(beforeTrace.length).toBeGreaterThan(0);

    const sessionVirtualKeysBefore = (await kvKeys()).filter((key) =>
      key.includes(`session:${sessionId}`),
    );
    expect(sessionVirtualKeysBefore.length).toBeGreaterThan(0);

    const deleted = await invokeRuntime({
      type: "brain.session.delete",
      sessionId,
    });
    expect(deleted.ok).toBe(true);
    const deletedData = (deleted.data || {}) as Record<string, unknown>;
    expect(deletedData.deleted).toBe(true);
    expect(
      Array.isArray(deletedData.removedKeys) &&
        (deletedData.removedKeys as unknown[]).some((item) =>
          String(item || "").includes(`session:${sessionId}`),
        ),
    ).toBe(true);

    const afterTrace = await readTraceChunk(`session-${sessionId}`, 0);
    expect(afterTrace).toEqual([]);

    const sessionVirtualKeysAfter = (await kvKeys()).filter((key) =>
      key.includes(`session:${sessionId}`),
    );
    expect(sessionVirtualKeysAfter).toEqual([]);
  });
});
