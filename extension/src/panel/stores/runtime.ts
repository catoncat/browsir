import { defineStore } from "pinia";
import { ref } from "vue";

interface RuntimeResponse<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface ConversationMessage {
  role: string;
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
}

interface SessionForkSource {
  sessionId: string;
  leafId: string;
  sourceEntryId: string;
  reason: string;
}

interface SessionIndexEntry {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  parentSessionId?: string;
  forkedFrom?: SessionForkSource | null;
}

interface RuntimeStateView {
  running?: boolean;
  compacting?: boolean;
  paused: boolean;
  stopped: boolean;
  lifecycle?: "idle" | "running" | "stopping";
  queue?: {
    dequeueMode?: "one-at-a-time" | "all";
    steer?: number;
    followUp?: number;
    total?: number;
    items?: Array<{
      id?: string;
      behavior?: "steer" | "followUp";
      text?: string;
      timestamp?: string;
    }>;
  };
  retry: {
    active: boolean;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
  };
}

function normalizeRuntimeState(raw: RuntimeStateView | null | undefined): RuntimeStateView | null {
  if (!raw) return null;
  const running = raw.running === true;
  const stopped = raw.stopped === true;
  const lifecycle: "idle" | "running" | "stopping" = running
    ? (stopped ? "stopping" : "running")
    : "idle";
  return {
    ...raw,
    lifecycle
  };
}

export interface PanelLlmProfile {
  id: string;
  provider: string;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  role: string;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
}

export interface PanelLlmProfileChains {
  [role: string]: string[];
}

interface PanelConfig {
  bridgeUrl: string;
  bridgeToken: string;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  llmDefaultProfile: string;
  llmProfiles: PanelLlmProfile[];
  llmProfileChains: PanelLlmProfileChains;
  llmEscalationPolicy: "upgrade_only" | "disabled";
  llmSystemPromptCustom: string;
  maxSteps: number;
  autoTitleInterval: number;
  bridgeInvokeTimeoutMs: number;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
  devAutoReload: boolean;
  devReloadIntervalMs: number;
}

interface RuntimeHealth {
  bridgeUrl: string;
  llmApiBase: string;
  llmModel: string;
  hasLlmApiKey: boolean;
  systemPromptPreview: string;
}

interface EditUserRerunResult {
  sessionId: string;
  runtime: RuntimeStateView;
  mode: "retry" | "fork";
  sourceSessionId: string;
  sourceEntryId: string;
  activeSourceEntryId: string;
}

interface EditUserRerunOptions {
  setActive?: boolean;
}

interface LoadConversationOptions {
  setActive?: boolean;
}

interface RegenerateFromAssistantOptions {
  mode?: "fork" | "retry";
  setActive?: boolean;
}

interface RegenerateFromAssistantResult {
  sessionId: string;
  mode: "fork" | "retry";
  sourceEntryId?: string;
}

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  location: string;
  source: string;
  enabled: boolean;
  disableModelInvocation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillInstallInput {
  id?: string;
  name?: string;
  description?: string;
  location: string;
  source?: string;
  enabled?: boolean;
  disableModelInvocation?: boolean;
}

export interface SkillDiscoverRoot {
  root: string;
  source?: string;
}

export interface SkillDiscoverOptions {
  sessionId?: string;
  roots?: SkillDiscoverRoot[];
  autoInstall?: boolean;
  replace?: boolean;
  maxFiles?: number;
  timeoutMs?: number;
}

export interface SkillDiscoverResult {
  sessionId: string;
  roots: Array<{ root: string; source: string }>;
  counts: {
    scanned: number;
    discovered: number;
    installed: number;
    skipped: number;
  };
  discovered: Array<Record<string, unknown>>;
  installed: SkillMetadata[];
  skipped: Array<Record<string, unknown>>;
  skills?: SkillMetadata[];
}

async function sendMessage<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = (await chrome.runtime.sendMessage({ type, ...payload })) as RuntimeResponse<T>;
  if (!response?.ok) {
    throw new Error(response?.error || `${type} failed`);
  }
  return response.data as T;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalizeEscalationPolicy(raw: unknown): "upgrade_only" | "disabled" {
  return String(raw || "").trim().toLowerCase() === "disabled" ? "disabled" : "upgrade_only";
}

interface LlmProfileFallback {
  id: string;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
}

function normalizeSingleLlmProfile(raw: Record<string, unknown>, fallback: LlmProfileFallback): PanelLlmProfile {
  const id = String(raw.id || raw.profile || fallback.id || "default").trim() || "default";
  return {
    id,
    provider: String(raw.provider || raw.providerId || "openai_compatible").trim() || "openai_compatible",
    llmApiBase: String(raw.llmApiBase || raw.base || fallback.llmApiBase || "").trim(),
    llmApiKey: String(raw.llmApiKey ?? raw.key ?? fallback.llmApiKey ?? ""),
    llmModel: String(raw.llmModel || raw.model || fallback.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex",
    role: String(raw.role || "worker").trim() || "worker",
    llmTimeoutMs: toIntInRange(raw.llmTimeoutMs, fallback.llmTimeoutMs, 1_000, 300_000),
    llmRetryMaxAttempts: toIntInRange(raw.llmRetryMaxAttempts, fallback.llmRetryMaxAttempts, 0, 6),
    llmMaxRetryDelayMs: toIntInRange(raw.llmMaxRetryDelayMs, fallback.llmMaxRetryDelayMs, 0, 300_000)
  };
}

function normalizeLlmProfiles(raw: unknown, fallback: LlmProfileFallback): PanelLlmProfile[] {
  const out: PanelLlmProfile[] = [];
  const dedup = new Set<string>();

  const pushProfile = (value: unknown, fallbackId?: string) => {
    const row = toRecord(value);
    const profile = normalizeSingleLlmProfile(row, {
      ...fallback,
      id: String(fallbackId || fallback.id || "default").trim() || "default"
    });
    if (dedup.has(profile.id)) return;
    dedup.add(profile.id);
    out.push(profile);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) pushProfile(item);
  } else {
    const map = toRecord(raw);
    for (const [key, value] of Object.entries(map)) {
      pushProfile(value, key);
    }
  }

  if (out.length === 0) {
    pushProfile({}, fallback.id || "default");
  }

  return out;
}

function normalizeLlmProfileChains(raw: unknown, validProfileIds: Set<string>): PanelLlmProfileChains {
  const input = toRecord(raw);
  const out: PanelLlmProfileChains = {};
  for (const [roleRaw, listRaw] of Object.entries(input)) {
    const role = String(roleRaw || "").trim();
    if (!role || !Array.isArray(listRaw)) continue;
    const dedup = new Set<string>();
    const ids: string[] = [];
    for (const item of listRaw) {
      const id = String(item || "").trim();
      if (!id || dedup.has(id)) continue;
      if (validProfileIds.size > 0 && !validProfileIds.has(id)) continue;
      dedup.add(id);
      ids.push(id);
    }
    if (ids.length > 0) out[role] = ids;
  }
  return out;
}

function extractContentFromStepExecuteResult(value: unknown): string {
  const root = toRecord(value);
  const rootData = toRecord(root.data);
  const rootDataData = toRecord(rootData.data);
  const rootDataResponse = toRecord(rootData.response);
  const rootDataResponseData = toRecord(rootDataResponse.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates: unknown[] = [
    root.content,
    root.text,
    rootData.content,
    rootData.text,
    rootDataData.content,
    rootDataData.text,
    rootDataResponse.content,
    rootDataResponse.text,
    rootDataResponseData.content,
    rootDataResponseData.text,
    rootResponse.content,
    rootResponse.text,
    rootResponseData.content,
    rootResponseData.text,
    rootResponseInnerData.content,
    rootResponseInnerData.text,
    rootResult.content,
    rootResult.text
  ];
  for (const item of candidates) {
    if (typeof item === "string") return item;
  }
  throw new Error("文件读取工具未返回 content 文本");
}

function normalizeConfig(raw: Record<string, unknown> | null | undefined): PanelConfig {
  const bridgeUrl = String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws");
  const bridgeToken = String(raw?.bridgeToken || "");
  const llmApiBase = String(raw?.llmApiBase || "https://ai.chen.rs/v1").trim();
  const llmApiKey = String(raw?.llmApiKey || "");
  const llmModel = String(raw?.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex";
  const llmTimeoutMs = toIntInRange(raw?.llmTimeoutMs, 120000, 1_000, 300_000);
  const llmRetryMaxAttempts = toIntInRange(raw?.llmRetryMaxAttempts, 2, 0, 6);
  const llmMaxRetryDelayMs = toIntInRange(raw?.llmMaxRetryDelayMs, 60000, 0, 300_000);
  const defaultProfile = String(raw?.llmDefaultProfile || "default").trim() || "default";

  const llmProfiles = normalizeLlmProfiles(raw?.llmProfiles, {
    id: defaultProfile,
    llmApiBase,
    llmApiKey,
    llmModel,
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs
  });
  const validProfileIds = new Set(llmProfiles.map((item) => item.id));
  const llmDefaultProfile = validProfileIds.has(defaultProfile) ? defaultProfile : llmProfiles[0]?.id || "default";

  return {
    bridgeUrl,
    bridgeToken,
    llmApiBase,
    llmApiKey,
    llmModel,
    llmDefaultProfile,
    llmProfiles,
    llmProfileChains: normalizeLlmProfileChains(raw?.llmProfileChains, validProfileIds),
    llmEscalationPolicy: normalizeEscalationPolicy(raw?.llmEscalationPolicy),
    llmSystemPromptCustom: String(raw?.llmSystemPromptCustom || ""),
    maxSteps: toIntInRange(raw?.maxSteps, 100, 1, 500),
    autoTitleInterval: toIntInRange(raw?.autoTitleInterval, 10, 0, 100),
    bridgeInvokeTimeoutMs: toIntInRange(raw?.bridgeInvokeTimeoutMs, 120000, 1_000, 300_000),
    llmTimeoutMs,
    llmRetryMaxAttempts,
    llmMaxRetryDelayMs,
    devAutoReload: raw?.devAutoReload !== false,
    devReloadIntervalMs: toIntInRange(raw?.devReloadIntervalMs, 1500, 500, 30000)
  };
}

function normalizeHealth(raw: Record<string, unknown> | null | undefined): RuntimeHealth {
  return {
    bridgeUrl: String(raw?.bridgeUrl || "ws://127.0.0.1:8787/ws"),
    llmApiBase: String(raw?.llmApiBase || ""),
    llmModel: String(raw?.llmModel || "gpt-5.3-codex"),
    hasLlmApiKey: Boolean(raw?.hasLlmApiKey),
    systemPromptPreview: String(raw?.systemPromptPreview || "")
  };
}

export const useRuntimeStore = defineStore("runtime", () => {
  const loading = ref(false);
  const savingConfig = ref(false);
  const isRegeneratingTitle = ref(false);
  const error = ref("");
  const sessions = ref<SessionIndexEntry[]>([]);
  const activeSessionId = ref("");
  const messages = ref<ConversationMessage[]>([]);
  const runtime = ref<RuntimeStateView | null>(null);
  const conversationRequestSeq = ref(0);
  const health = ref<RuntimeHealth>(
    normalizeHealth({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      llmModel: "gpt-5.3-codex",
      hasLlmApiKey: false
    })
  );
  const config = ref<PanelConfig>(
    normalizeConfig({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      llmApiBase: "https://ai.chen.rs/v1",
      llmModel: "gpt-5.3-codex",
      llmSystemPromptCustom: "",
      autoTitleInterval: 10,
      bridgeInvokeTimeoutMs: 120000,
      llmTimeoutMs: 120000,
      llmRetryMaxAttempts: 2,
      llmMaxRetryDelayMs: 60000
    })
  );

  async function refreshSessions() {
    const index = await sendMessage<{ sessions: SessionIndexEntry[] }>("brain.session.list");
    sessions.value = Array.isArray(index.sessions) ? index.sessions : [];
    const activeExists = sessions.value.some((item) => item.id === activeSessionId.value);
    if (!activeExists) {
      activeSessionId.value = sessions.value[0]?.id || "";
    }
  }

  async function loadConversation(sessionId: string, options: LoadConversationOptions = {}) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return;

    const shouldSetActive = options.setActive === true;
    const previousActiveSessionId = activeSessionId.value;
    if (shouldSetActive) {
      activeSessionId.value = normalizedSessionId;
    }

    const requestSeq = ++conversationRequestSeq.value;

    try {
      const view = await sendMessage<{ conversationView: { messages: ConversationMessage[]; lastStatus: RuntimeStateView } }>(
        "brain.session.view",
        { sessionId: normalizedSessionId }
      );

      if (requestSeq !== conversationRequestSeq.value) {
        return;
      }
      if (activeSessionId.value !== normalizedSessionId) {
        return;
      }

      messages.value = view.conversationView?.messages ?? [];
      runtime.value = normalizeRuntimeState(view.conversationView?.lastStatus ?? null);
    } catch (err) {
      if (requestSeq === conversationRequestSeq.value && shouldSetActive) {
        activeSessionId.value = previousActiveSessionId;
      }
      throw err;
    }
  }

  async function createSession() {
    const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.start", {
      autoRun: false
    });
    runtime.value = normalizeRuntimeState(result.runtime);
    activeSessionId.value = result.sessionId;
    await refreshSessions();
    await loadConversation(result.sessionId, { setActive: true });
  }

  async function sendPrompt(
    prompt: string,
    options: { newSession?: boolean; tabIds?: number[]; skillIds?: string[]; streamingBehavior?: "steer" | "followUp" } = {}
  ) {
    const text = prompt.trim();
    const skillIds = Array.isArray(options.skillIds)
      ? Array.from(new Set(options.skillIds.map((id) => String(id || "").trim()).filter((id) => id.length > 0)))
      : [];
    if (!text && skillIds.length === 0) return;
    const useCurrentSession = !options.newSession && !!activeSessionId.value;
    const tabIds = Array.isArray(options.tabIds)
      ? options.tabIds.filter((id) => Number.isInteger(id)).map((id) => Number(id))
      : [];
    const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.start", {
      sessionId: useCurrentSession ? activeSessionId.value : undefined,
      prompt: text,
      tabIds,
      ...(skillIds.length > 0 ? { skillIds } : {}),
      streamingBehavior: options.streamingBehavior
    });
    runtime.value = normalizeRuntimeState(result.runtime);
    activeSessionId.value = result.sessionId;
    await refreshSessions();
    await loadConversation(result.sessionId, { setActive: true });
  }

  async function ensureSkillSessionId(inputSessionId?: string): Promise<string> {
    const provided = String(inputSessionId || "").trim();
    if (provided) return provided;
    const current = String(activeSessionId.value || "").trim();
    if (current) return current;
    const created = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.start", {
      autoRun: false
    });
    runtime.value = normalizeRuntimeState(created.runtime);
    activeSessionId.value = created.sessionId;
    await refreshSessions();
    await loadConversation(created.sessionId, { setActive: true });
    return created.sessionId;
  }

  async function listSkills(): Promise<SkillMetadata[]> {
    const out = await sendMessage<{ skills: SkillMetadata[] }>("brain.skill.list");
    return Array.isArray(out.skills) ? out.skills : [];
  }

  async function readVirtualFile(path: string, options: { offset?: number; limit?: number } = {}): Promise<string> {
    const sessionId = await ensureSkillSessionId();
    const step = await sendMessage<Record<string, unknown>>("brain.step.execute", {
      sessionId,
      capability: "fs.read",
      action: "invoke",
      args: {
        frame: {
          tool: "read",
          args: {
            path: String(path || "").trim(),
            runtime: "browser",
            ...(options.offset == null ? {} : { offset: options.offset }),
            ...(options.limit == null ? {} : { limit: options.limit })
          }
        }
      },
      verifyPolicy: "off"
    });
    const result = toRecord(step);
    if (result.ok !== true) {
      throw new Error(String(result.error || "文件读取失败"));
    }
    return extractContentFromStepExecuteResult(result.data);
  }

  async function writeVirtualFile(
    path: string,
    content: string,
    mode: "overwrite" | "append" | "create" = "overwrite"
  ): Promise<void> {
    const sessionId = await ensureSkillSessionId();
    const step = await sendMessage<Record<string, unknown>>("brain.step.execute", {
      sessionId,
      capability: "fs.write",
      action: "invoke",
      args: {
        frame: {
          tool: "write",
          args: {
            path: String(path || "").trim(),
            runtime: "browser",
            content: String(content || ""),
            mode
          }
        }
      },
      verifyPolicy: "off"
    });
    const result = toRecord(step);
    if (result.ok !== true) {
      throw new Error(String(result.error || "文件写入失败"));
    }
  }

  async function installSkill(input: SkillInstallInput, options: { replace?: boolean } = {}): Promise<SkillMetadata> {
    const payload: Record<string, unknown> = {
      skill: {
        ...input
      }
    };
    if (options.replace === true) payload.replace = true;
    const out = await sendMessage<{ skill: SkillMetadata }>("brain.skill.install", payload);
    return out.skill;
  }

  async function enableSkill(skillId: string): Promise<SkillMetadata> {
    const out = await sendMessage<{ skill: SkillMetadata }>("brain.skill.enable", { skillId });
    return out.skill;
  }

  async function disableSkill(skillId: string): Promise<SkillMetadata> {
    const out = await sendMessage<{ skill: SkillMetadata }>("brain.skill.disable", { skillId });
    return out.skill;
  }

  async function uninstallSkill(skillId: string): Promise<boolean> {
    const out = await sendMessage<{ removed: boolean }>("brain.skill.uninstall", { skillId });
    return out.removed === true;
  }

  async function discoverSkills(options: SkillDiscoverOptions = {}): Promise<SkillDiscoverResult> {
    const sessionId = await ensureSkillSessionId(options.sessionId);
    const out = await sendMessage<SkillDiscoverResult>("brain.skill.discover", {
      sessionId,
      ...(Array.isArray(options.roots) && options.roots.length > 0 ? { roots: options.roots } : {}),
      ...(options.autoInstall === undefined ? {} : { autoInstall: options.autoInstall }),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
      ...(options.maxFiles == null ? {} : { maxFiles: options.maxFiles }),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs })
    });
    return out;
  }

  async function runSkill(skillId: string, argsText = ""): Promise<void> {
    const id = String(skillId || "").trim();
    if (!id) {
      throw new Error("skillId 不能为空");
    }
    const args = String(argsText || "").trim();
    const prompt = args ? `/skill:${id} ${args}` : `/skill:${id}`;
    await sendPrompt(prompt);
  }

  function findAssistantMessageIndex(entryId: string) {
    return messages.value.findIndex((msg) => msg.entryId === entryId && msg.role === "assistant");
  }

  function findLatestAssistantEntryId() {
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const candidate = messages.value[i];
      if (candidate?.role !== "assistant") continue;
      const entryId = String(candidate.entryId || "").trim();
      const content = String(candidate.content || "").trim();
      if (entryId && content) return entryId;
    }
    return "";
  }

  function findPreviousUserEntryId(targetIndex: number) {
    for (let i = targetIndex - 1; i >= 0; i -= 1) {
      const candidate = messages.value[i];
      if (candidate?.role !== "user") continue;
      if (!String(candidate.content || "").trim()) continue;
      if (!String(candidate.entryId || "").trim()) continue;
      return String(candidate.entryId);
    }
    return "";
  }

  async function forkFromAssistantEntry(entryId: string, options: { autoRun?: boolean; setActive?: boolean } = {}) {
    if (!activeSessionId.value) {
      throw new Error("无活跃会话，无法分叉");
    }
    const currentSessionId = activeSessionId.value;
    const targetIndex = findAssistantMessageIndex(entryId);
    if (targetIndex < 0) {
      throw new Error("未找到可分叉的 assistant 消息");
    }
    const previousUserEntryId = findPreviousUserEntryId(targetIndex);
    if (!previousUserEntryId) {
      throw new Error("未找到前序 user 消息，无法分叉");
    }
    const forked = await sendMessage<{ sessionId: string; leafId?: string | null }>("brain.session.fork", {
      sessionId: currentSessionId,
      leafId: entryId,
      sourceEntryId: entryId,
      reason: "branch_from_assistant"
    });
    const forkedSessionId = String(forked.sessionId || "").trim();
    if (!forkedSessionId) {
      throw new Error("创建分叉会话失败");
    }
    const forkedSourceEntryId = String(forked.leafId || "").trim();

    if (options.autoRun === true) {
      if (!forkedSourceEntryId) {
        throw new Error("分叉后未找到可重生成的 sourceEntry");
      }
      const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.regenerate", {
        sessionId: forkedSessionId,
        sourceEntryId: forkedSourceEntryId,
        requireSourceIsLeaf: true,
        rebaseLeafToPreviousUser: true
      });
      runtime.value = normalizeRuntimeState(result.runtime);
    }

    await refreshSessions();
    if (options.setActive === false) {
      // 由上层决定何时切会话（例如播放 fork 场景动画）。
    } else {
      await loadConversation(forkedSessionId, { setActive: true });
    }
    return {
      sessionId: forkedSessionId,
      sourceEntryId: forkedSourceEntryId || entryId,
      mode: "fork" as const
    };
  }

  async function retryLastAssistantEntry(entryId: string, options: { setActive?: boolean } = {}) {
    if (!activeSessionId.value) {
      throw new Error("无活跃会话，无法重试");
    }
    const targetIndex = findAssistantMessageIndex(entryId);
    if (targetIndex < 0) {
      throw new Error("未找到可重试的 assistant 消息");
    }
    const previousUserEntryId = findPreviousUserEntryId(targetIndex);
    if (!previousUserEntryId) {
      throw new Error("未找到前序 user 消息，无法重试");
    }
    const latestAssistantEntryId = findLatestAssistantEntryId();
    if (!latestAssistantEntryId || latestAssistantEntryId !== entryId) {
      throw new Error("仅最后一条 assistant 支持重新回答；历史消息请使用分叉");
    }

    const currentSessionId = activeSessionId.value;
    const result = await sendMessage<{ sessionId: string; runtime: RuntimeStateView }>("brain.run.regenerate", {
      sessionId: currentSessionId,
      sourceEntryId: entryId,
      requireSourceIsLeaf: true,
      rebaseLeafToPreviousUser: true
    });
    runtime.value = normalizeRuntimeState(result.runtime);
    await refreshSessions();
    await loadConversation(currentSessionId, { setActive: options.setActive === true });
    return {
      sessionId: currentSessionId,
      mode: "retry" as const
    };
  }

  async function regenerateFromAssistantEntry(
    entryId: string,
    options: RegenerateFromAssistantOptions = {}
  ): Promise<RegenerateFromAssistantResult> {
    if (options.mode === "fork") {
      return forkFromAssistantEntry(entryId, { autoRun: true, setActive: options.setActive });
    }
    if (options.mode === "retry") {
      return retryLastAssistantEntry(entryId, { setActive: options.setActive });
    }
    const latestAssistantEntryId = findLatestAssistantEntryId();
    if (latestAssistantEntryId && latestAssistantEntryId === entryId) {
      return retryLastAssistantEntry(entryId, { setActive: options.setActive });
    }
    return forkFromAssistantEntry(entryId, { autoRun: true, setActive: options.setActive });
  }

  async function editUserMessageAndRerun(entryId: string, prompt: string, options: EditUserRerunOptions = {}) {
    if (!activeSessionId.value) {
      throw new Error("无活跃会话，无法编辑并重跑");
    }
    const sourceEntryId = String(entryId || "").trim();
    const editedText = String(prompt || "").trim();
    if (!sourceEntryId) {
      throw new Error("sourceEntryId 不能为空");
    }
    if (!editedText) {
      throw new Error("编辑内容不能为空");
    }

    const sourceSessionId = activeSessionId.value;
    const result = await sendMessage<EditUserRerunResult>("brain.run.edit_rerun", {
      sessionId: sourceSessionId,
      sourceEntryId,
      prompt: editedText
    });

    runtime.value = normalizeRuntimeState(result.runtime);
    await refreshSessions();
    if (options.setActive === false) {
      if (result.sessionId === activeSessionId.value) {
        await loadConversation(result.sessionId, { setActive: false });
      }
    } else {
      await loadConversation(result.sessionId, { setActive: true });
    }
    return {
      sessionId: result.sessionId,
      mode: result.mode,
      sourceSessionId: result.sourceSessionId,
      sourceEntryId: result.sourceEntryId,
      activeSourceEntryId: result.activeSourceEntryId
    };
  }

  async function runAction(type: "brain.run.pause" | "brain.run.resume" | "brain.run.stop") {
    if (!activeSessionId.value) return;
    runtime.value = normalizeRuntimeState(await sendMessage<RuntimeStateView>(type, { sessionId: activeSessionId.value }));
  }

  async function promoteQueuedPromptToSteer(queuedPromptId: string) {
    const sessionId = String(activeSessionId.value || "").trim();
    const id = String(queuedPromptId || "").trim();
    if (!sessionId) throw new Error("当前无活动会话");
    if (!id) throw new Error("queuedPromptId 不能为空");

    runtime.value = normalizeRuntimeState(await sendMessage<RuntimeStateView>("brain.run.queue.promote", {
      sessionId,
      queuedPromptId: id,
      targetBehavior: "steer"
    }));
  }

  async function refreshSessionTitle(sessionId = activeSessionId.value, force = true) {
    if (!sessionId) return;
    isRegeneratingTitle.value = true;
    try {
      await sendMessage("brain.session.title.refresh", { sessionId, force });
      await refreshSessions();
      if (activeSessionId.value === sessionId) {
        await loadConversation(sessionId, { setActive: false });
      }
    } finally {
      isRegeneratingTitle.value = false;
    }
  }

  async function updateSessionTitle(sessionId: string, title: string) {
    if (!sessionId) return;
    await sendMessage("brain.session.title.refresh", { sessionId, title });
    await refreshSessions();
    if (activeSessionId.value === sessionId) {
      await loadConversation(sessionId, { setActive: false });
    }
  }

  async function deleteSession(sessionId: string) {
    if (!sessionId) return;
    await sendMessage("brain.session.delete", { sessionId });
    await refreshSessions();
    if (!activeSessionId.value) {
      messages.value = [];
      runtime.value = null;
      return;
    }
    await loadConversation(activeSessionId.value, { setActive: false });
  }

  async function bootstrap() {
    loading.value = true;
    error.value = "";
    try {
      const cfg = await sendMessage<Record<string, unknown>>("config.get");
      config.value = normalizeConfig(cfg);
      await Promise.all([refreshHealth(), refreshSessions()]);
      if (!String(config.value.llmSystemPromptCustom || "").trim()) {
        const preview = String(health.value.systemPromptPreview || "");
        if (preview.trim()) {
          config.value.llmSystemPromptCustom = preview;
        }
      }
      if (activeSessionId.value) {
        await loadConversation(activeSessionId.value, { setActive: false });
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }

  async function refreshHealth() {
    const raw = await sendMessage<Record<string, unknown>>("brain.debug.config");
    health.value = normalizeHealth(raw);
  }

  async function saveConfig() {
    savingConfig.value = true;
    error.value = "";
    try {
      const llmApiBase = config.value.llmApiBase.trim();
      const llmApiKey = config.value.llmApiKey;
      const llmModel = config.value.llmModel.trim() || "gpt-5.3-codex";
      const llmTimeoutMs = Math.max(1000, Number(config.value.llmTimeoutMs || 120000));
      const llmRetryMaxAttempts = Math.max(0, Math.min(6, Number(config.value.llmRetryMaxAttempts || 2)));
      const llmMaxRetryDelayMs = Math.max(0, Number(config.value.llmMaxRetryDelayMs || 60000));

      const llmProfiles = normalizeLlmProfiles(config.value.llmProfiles, {
        id: String(config.value.llmDefaultProfile || "default").trim() || "default",
        llmApiBase,
        llmApiKey,
        llmModel,
        llmTimeoutMs,
        llmRetryMaxAttempts,
        llmMaxRetryDelayMs
      });
      const profileIds = new Set(llmProfiles.map((item) => item.id));
      const llmDefaultProfileRaw = String(config.value.llmDefaultProfile || "").trim();
      const llmDefaultProfile = profileIds.has(llmDefaultProfileRaw)
        ? llmDefaultProfileRaw
        : (llmProfiles[0]?.id || "default");
      const llmProfileChains = normalizeLlmProfileChains(config.value.llmProfileChains, profileIds);
      const llmEscalationPolicy = normalizeEscalationPolicy(config.value.llmEscalationPolicy);

      config.value.llmProfiles = llmProfiles;
      config.value.llmDefaultProfile = llmDefaultProfile;
      config.value.llmProfileChains = llmProfileChains;
      config.value.llmEscalationPolicy = llmEscalationPolicy;

      await sendMessage("config.save", {
        payload: {
          bridgeUrl: config.value.bridgeUrl.trim(),
          bridgeToken: config.value.bridgeToken,
          llmApiBase,
          llmApiKey,
          llmModel,
          llmDefaultProfile,
          llmProfiles,
          llmProfileChains,
          llmEscalationPolicy,
          llmSystemPromptCustom: config.value.llmSystemPromptCustom,
          maxSteps: Math.max(1, Number(config.value.maxSteps || 100)),
          autoTitleInterval: Math.max(0, Number(config.value.autoTitleInterval ?? 10)),
          bridgeInvokeTimeoutMs: Math.max(1000, Number(config.value.bridgeInvokeTimeoutMs || 120000)),
          llmTimeoutMs,
          llmRetryMaxAttempts,
          llmMaxRetryDelayMs,
          devAutoReload: config.value.devAutoReload,
          devReloadIntervalMs: Math.max(500, Number(config.value.devReloadIntervalMs || 1500))
        }
      });
      await sendMessage("bridge.connect");
      await refreshHealth();
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      savingConfig.value = false;
    }
  }

  return {
    loading,
    savingConfig,
    isRegeneratingTitle,
    error,
    sessions,
    activeSessionId,
    messages,
    runtime,
    health,
    config,
    bootstrap,
    refreshSessions,
    refreshHealth,
    loadConversation,
    createSession,
    sendPrompt,
    listSkills,
    readVirtualFile,
    writeVirtualFile,
    installSkill,
    enableSkill,
    disableSkill,
    uninstallSkill,
    discoverSkills,
    runSkill,
    forkFromAssistantEntry,
    retryLastAssistantEntry,
    regenerateFromAssistantEntry,
    editUserMessageAndRerun,
    runAction,
    promoteQueuedPromptToSteer,
    refreshSessionTitle,
    updateSessionTitle,
    deleteSession,
    saveConfig
  };
});
