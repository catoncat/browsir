import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";
import { registerRuntimeRouter } from "../runtime-router";

type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean | void;

let runtimeListener: RuntimeListener | null = null;

function invokeRuntime(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!runtimeListener) {
      reject(new Error("runtime listener not registered"));
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`runtime response timeout: ${String(message.type || "")}`));
    }, 1500);

    try {
      runtimeListener(message, {}, (response) => {
        clearTimeout(timer);
        resolve((response || {}) as Record<string, unknown>);
      });
    } catch (error) {
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

describe("runtime-router.browser", () => {
  beforeEach(() => {
    runtimeListener = null;
    (chrome.runtime.onMessage as unknown as { addListener: (cb: RuntimeListener) => void }).addListener = (cb) => {
      runtimeListener = cb;
    };
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
