import { initSessionIndex, resetSessionStore } from "./storage-reset.browser";
import { BrainOrchestrator } from "./orchestrator.browser";
import { createRuntimeInfraHandler, type RuntimeInfraHandler, type RuntimeInfraResult } from "./runtime-infra.browser";
import { createRuntimeLoopController, type RuntimeLoopController } from "./runtime-loop.browser";
import { isVirtualUri } from "./virtual-fs.browser";
import {
  removeSessionIndexEntry,
  removeSessionMeta,
  writeSessionMeta
} from "./session-store.browser";
import { nowIso, randomId, type MessageEntry, type SessionEntry, type SessionMeta } from "./types";

interface RuntimeOk<T = unknown> {
  ok: true;
  data: T;
}

interface RuntimeErr {
  ok: false;
  error: string;
}

type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

const SESSION_TITLE_MAX = 28;
const SESSION_TITLE_MIN = 2;
const SESSION_TITLE_SOURCE_MANUAL = "manual";
const DEFAULT_STEP_STREAM_MAX_EVENTS = 240;
const DEFAULT_STEP_STREAM_MAX_BYTES = 256 * 1024;
const MAX_STEP_STREAM_MAX_EVENTS = 5000;
const MAX_STEP_STREAM_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SUBAGENT_PARALLEL_TASKS = 8;
const MAX_SUBAGENT_PARALLEL_CONCURRENCY = 4;
const MAX_SUBAGENT_CHAIN_TASKS = 8;
const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 60_000;
const MAX_SUBAGENT_WAIT_TIMEOUT_MS = 300_000;
const CHAIN_PREVIOUS_TOKEN = "{previous}";
const DEFAULT_SKILL_DISCOVER_MAX_FILES = 256;
const MAX_SKILL_DISCOVER_MAX_FILES = 4096;
const DEFAULT_SKILL_DISCOVER_ROOTS: Array<{ root: string; source: string }> = [
  { root: "mem://skills", source: "browser" }
];

function ok<T>(data: T): RuntimeResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): RuntimeResult {
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

function fromInfraResult(result: RuntimeInfraResult): RuntimeResult {
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: String(result.error || "runtime infra failed") };
}

function requireSessionId(message: unknown): string {
  const payload = toRecord(message);
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId 不能为空");
  return sessionId;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function estimateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function clampStepStream(
  source: unknown[],
  rawOptions: { maxEvents?: unknown; maxBytes?: unknown } = {}
): {
  stream: unknown[];
  meta: {
    truncated: boolean;
    cutBy: "events" | "bytes" | null;
    totalEvents: number;
    totalBytes: number;
    returnedEvents: number;
    returnedBytes: number;
    maxEvents: number;
    maxBytes: number;
  };
} {
  const stream = Array.isArray(source) ? source : [];
  const maxEvents = normalizeIntInRange(rawOptions.maxEvents, DEFAULT_STEP_STREAM_MAX_EVENTS, 1, MAX_STEP_STREAM_MAX_EVENTS);
  const maxBytes = normalizeIntInRange(rawOptions.maxBytes, DEFAULT_STEP_STREAM_MAX_BYTES, 2 * 1024, MAX_STEP_STREAM_MAX_BYTES);
  const totalEvents = stream.length;
  const totalBytes = stream.reduce((sum, item) => sum + estimateJsonBytes(item), 0);

  if (totalEvents <= maxEvents && totalBytes <= maxBytes) {
    return {
      stream: stream.slice(),
      meta: {
        truncated: false,
        cutBy: null,
        totalEvents,
        totalBytes,
        returnedEvents: totalEvents,
        returnedBytes: totalBytes,
        maxEvents,
        maxBytes
      }
    };
  }

  const picked: unknown[] = [];
  let returnedBytes = 0;
  let cutBy: "events" | "bytes" | null = null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const item = stream[i];
    const bytes = estimateJsonBytes(item);
    const exceedEvents = picked.length + 1 > maxEvents;
    const exceedBytes = returnedBytes + bytes > maxBytes;
    if (exceedEvents || exceedBytes) {
      cutBy = exceedEvents ? "events" : "bytes";
      if (picked.length === 0) {
        picked.push(item);
        returnedBytes += bytes;
      }
      break;
    }
    picked.push(item);
    returnedBytes += bytes;
  }
  picked.reverse();
  return {
    stream: picked,
    meta: {
      truncated: true,
      cutBy,
      totalEvents,
      totalBytes,
      returnedEvents: picked.length,
      returnedBytes,
      maxEvents,
      maxBytes
    }
  };
}

function normalizeSessionTitle(value: unknown, fallback = ""): string {
  const compact = String(value || "")
    .replace(/[`*_>#\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= SESSION_TITLE_MAX) return compact;
  return `${compact.slice(0, SESSION_TITLE_MAX)}…`;
}

function deriveSessionTitleFromEntries(entries: SessionEntry[]): string {
  const list = Array.isArray(entries) ? entries : [];
  for (const item of list) {
    if (item.type !== "message") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    const text = normalizeSessionTitle(item.text, "");
    if (!text || text.length < SESSION_TITLE_MIN) continue;
    return text;
  }
  return "新对话";
}

function readForkedFrom(meta: SessionMeta | null): {
  sessionId: string;
  leafId: string;
  sourceEntryId: string;
  reason: string;
} | null {
  const metadata = toRecord(meta?.header?.metadata);
  const raw = toRecord(metadata.forkedFrom);
  const sessionId = String(raw.sessionId || "").trim();
  const leafId = String(raw.leafId || "").trim();
  const sourceEntryId = String(raw.sourceEntryId || "").trim();
  const reason = String(raw.reason || "").trim();
  if (!sessionId && !leafId && !sourceEntryId && !reason) return null;
  return { sessionId, leafId, sourceEntryId, reason };
}

function findPreviousUserEntryByChain(
  byId: Map<string, SessionEntry>,
  startEntry: SessionEntry | null | undefined
): MessageEntry | null {
  let cursor: SessionEntry | null = startEntry ?? null;
  let guard = byId.size + 2;
  while (cursor && guard > 0) {
    guard -= 1;
    if (cursor.type === "message" && cursor.role === "user" && String(cursor.id || "").trim()) {
      return cursor;
    }
    const parentId = String(cursor.parentId || "").trim();
    cursor = parentId ? byId.get(parentId) || null : null;
  }
  return null;
}

function findLatestUserEntryInBranch(branch: SessionEntry[]): MessageEntry | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const candidate = branch[i];
    if (candidate.type !== "message" || candidate.role !== "user") continue;
    if (!String(candidate.id || "").trim()) continue;
    if (!String(candidate.text || "").trim()) continue;
    return candidate;
  }
  return null;
}

interface ForkSessionInput {
  sourceSessionId: string;
  leafId: string;
  sourceEntryId?: string;
  reason?: string;
  title?: string;
  targetSessionId?: string;
}

interface ForkSessionResult {
  sessionId: string;
  sourceSessionId: string;
  sourceLeafId: string;
  leafId: string | null;
  copiedEntryCount: number;
}

async function forkSessionFromLeaf(
  orchestrator: BrainOrchestrator,
  input: ForkSessionInput
): Promise<ForkSessionResult> {
  const sourceSessionId = String(input.sourceSessionId || "").trim();
  const sourceLeafId = String(input.leafId || "").trim();
  if (!sourceSessionId) {
    throw new Error("fork sourceSessionId 不能为空");
  }
  if (!sourceLeafId) {
    throw new Error("fork leafId 不能为空");
  }

  const sourceMeta = await orchestrator.sessions.getMeta(sourceSessionId);
  if (!sourceMeta) {
    throw new Error(`session 不存在: ${sourceSessionId}`);
  }

  const sourceEntries = await orchestrator.sessions.getEntries(sourceSessionId);
  const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  if (!byId.has(sourceLeafId)) {
    throw new Error(`fork leaf 不存在: ${sourceLeafId}`);
  }

  const sourceTitle = String(sourceMeta.header.title || "").trim();
  const forkTitle = String(input.title || "").trim() || (sourceTitle ? `${sourceTitle} · 重答分支` : "重答分支");
  const sourceMetadata = toRecord(sourceMeta.header.metadata);
  const forkReason = String(input.reason || "manual");
  const sourceEntryId = String(input.sourceEntryId || "");
  const targetSessionId = String(input.targetSessionId || "").trim() || undefined;

  const forkMeta = await orchestrator.sessions.createSession({
    id: targetSessionId,
    parentSessionId: sourceSessionId,
    title: forkTitle,
    model: sourceMeta.header.model,
    metadata: {
      ...sourceMetadata,
      forkedFrom: {
        sessionId: sourceSessionId,
        leafId: sourceLeafId,
        sourceEntryId,
        reason: forkReason
      }
    }
  });
  const forkSessionId = forkMeta.header.id;

  const branch = await orchestrator.sessions.getBranch(sourceSessionId, sourceLeafId);
  const oldToNew = new Map<string, string>();
  for (const sourceEntry of branch) {
    const cloned: SessionEntry = {
      ...sourceEntry,
      id: randomId("entry"),
      parentId: sourceEntry.parentId ? oldToNew.get(sourceEntry.parentId) || null : null,
      timestamp: nowIso()
    };
    if (cloned.type === "compaction") {
      const oldFirstKept = String(cloned.firstKeptEntryId || "").trim();
      cloned.firstKeptEntryId = oldFirstKept ? oldToNew.get(oldFirstKept) || null : null;
    }
    await orchestrator.sessions.appendEntry(forkSessionId, cloned);
    oldToNew.set(sourceEntry.id, cloned.id);
  }

  return {
    sessionId: forkSessionId,
    sourceSessionId,
    sourceLeafId,
    leafId: oldToNew.get(sourceLeafId) || null,
    copiedEntryCount: branch.length
  };
}

async function buildConversationView(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  leafId?: string | null
): Promise<{
  sessionId: string;
  messageCount: number;
  messages: Array<{
    role: string;
    content: string;
    entryId: string;
    toolName?: string;
    toolCallId?: string;
  }>;
  parentSessionId: string;
  forkedFrom: { sessionId: string; leafId: string; sourceEntryId: string; reason: string } | null;
  lastStatus: ReturnType<BrainOrchestrator["getRunState"]>;
  updatedAt: string;
}> {
  const context = await orchestrator.sessions.buildSessionContext(sessionId, leafId ?? undefined);
  const meta = await orchestrator.sessions.getMeta(sessionId);
  const messages = context.entries
    .filter((entry): entry is MessageEntry => entry.type === "message")
    .map((entry) => ({
      role: entry.role,
      content: entry.text,
      entryId: entry.id,
      toolName: entry.toolName,
      toolCallId: entry.toolCallId
    }));
  return {
    sessionId,
    messageCount: messages.length,
    messages,
    parentSessionId: String(meta?.header?.parentSessionId || ""),
    forkedFrom: readForkedFrom(meta),
    lastStatus: orchestrator.getRunState(sessionId),
    updatedAt: nowIso()
  };
}

interface AgentRunTaskInput {
  agent: string;
  role: string;
  task: string;
  profile?: string;
  sessionId?: string;
  sessionOptions: Record<string, unknown>;
  autoRun: boolean;
}

function parseAgentRunTask(raw: unknown, defaultAutoRun: boolean): { ok: true; task: AgentRunTaskInput } | { ok: false; error: string } {
  const source = toRecord(raw);
  const agent = String(source.agent || "").trim();
  const role = String(source.role || agent).trim();
  const task = String(source.task || "").trim();
  if (!agent) {
    return { ok: false, error: "brain.agent.run 需要 agent" };
  }
  if (!task) {
    return { ok: false, error: `brain.agent.run(${agent}) 需要非空 task` };
  }
  const profile = String(source.profile || "").trim();
  const sessionId = String(source.sessionId || "").trim();
  const sessionOptions = source.sessionOptions ? toRecord(source.sessionOptions) : {};
  const autoRun = source.autoRun === false ? false : defaultAutoRun;
  return {
    ok: true,
    task: {
      agent,
      role: role || agent,
      task,
      profile: profile || undefined,
      sessionId: sessionId || undefined,
      sessionOptions,
      autoRun
    }
  };
}

async function startAgentRunTask(
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  task: AgentRunTaskInput,
  resolvedTask: string,
  parentSessionId?: string
): Promise<Record<string, unknown>> {
  const sessionOptions = {
    ...toRecord(task.sessionOptions)
  };
  const metadata = {
    ...toRecord(sessionOptions.metadata),
    agent: task.agent,
    agentRole: task.role,
    llmRole: task.role
  } as Record<string, unknown>;
  if (task.profile) metadata.llmProfile = task.profile;
  sessionOptions.metadata = metadata;
  if (parentSessionId && !String(sessionOptions.parentSessionId || "").trim()) {
    sessionOptions.parentSessionId = parentSessionId;
  }

  const started = await runtimeLoop.startFromPrompt({
    sessionId: task.sessionId || "",
    sessionOptions,
    prompt: resolvedTask,
    autoRun: task.autoRun
  });
  return {
    agent: task.agent,
    role: task.role,
    profile: task.profile || "",
    task: resolvedTask,
    templateTask: task.task,
    sessionId: started.sessionId,
    runtime: started.runtime
  };
}

function injectChainPrevious(taskText: string, previousOutput: string): string {
  const source = String(taskText || "");
  if (!source.includes(CHAIN_PREVIOUS_TOKEN)) return source;
  return source.split(CHAIN_PREVIOUS_TOKEN).join(previousOutput);
}

async function waitForLoopDoneBySession(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  timeoutMs: number
): Promise<{ status: string; timeout: boolean }> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    const stream = await orchestrator.getStepStream(sessionId);
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const item = stream[i];
      if (String(item.type || "") !== "loop_done") continue;
      const payload = toRecord(item.payload);
      return {
        status: String(payload.status || "").trim() || "done",
        timeout: false
      };
    }
    const state = orchestrator.getRunState(sessionId);
    if (!state.running && !state.paused) {
      return {
        status: state.stopped ? "stopped" : "unknown",
        timeout: false
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return {
    status: "timeout",
    timeout: true
  };
}

async function readLatestAssistantMessage(
  orchestrator: BrainOrchestrator,
  sessionId: string
): Promise<string> {
  const context = await orchestrator.sessions.buildSessionContext(sessionId);
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const item = context.messages[i];
    if (String(item.role || "") !== "assistant") continue;
    const text = String(item.content || "").trim();
    if (text) return text;
  }
  return "";
}

function buildChainFanInSummary(results: Array<Record<string, unknown>>): string {
  const lines = results.map((item, index) => {
    const agent = String(item.agent || "").trim() || `agent-${index + 1}`;
    const status = String(item.status || "").trim() || "unknown";
    const output = String(item.output || "").trim().replace(/\s+/g, " ");
    const clipped = output.length > 140 ? `${output.slice(0, 140)}…` : output;
    return `${index + 1}. ${agent} [${status}] ${clipped}`;
  });
  return lines.join("\n");
}

interface StartedSubagentTask {
  index: number;
  agent: string;
  role: string;
  profile: string;
  sessionId: string;
  task: string;
  templateTask: string;
  autoRun: boolean;
}

function resolveSubagentRunSessionId(source: Record<string, unknown>, parentSessionId: string): string {
  const explicit = String(source.runSessionId || "").trim();
  if (explicit) return explicit;
  if (parentSessionId) return parentSessionId;
  return randomId("subagent-run");
}

function classifySubagentRunStatus(results: Array<Record<string, unknown>>): {
  status: string;
  failCount: number;
  timeoutCount: number;
  notStartedCount: number;
} {
  let failCount = 0;
  let timeoutCount = 0;
  let notStartedCount = 0;
  for (const item of results) {
    const status = String(item.status || "").trim() || "unknown";
    const timeout = item.timeout === true || status === "timeout";
    if (timeout) {
      timeoutCount += 1;
      continue;
    }
    if (status === "not_started") {
      notStartedCount += 1;
      continue;
    }
    if (status !== "done") {
      failCount += 1;
    }
  }
  if (timeoutCount > 0) return { status: "timeout", failCount, timeoutCount, notStartedCount };
  if (failCount > 0) return { status: "partial_failed", failCount, timeoutCount, notStartedCount };
  if (notStartedCount > 0) return { status: "not_started", failCount, timeoutCount, notStartedCount };
  return { status: "done", failCount, timeoutCount, notStartedCount };
}

async function completeStartedSubagentTask(
  orchestrator: BrainOrchestrator,
  runSessionId: string,
  task: StartedSubagentTask,
  waitTimeoutMs: number
): Promise<Record<string, unknown>> {
  if (!task.autoRun) {
    const completed = {
      ...task,
      status: "not_started",
      timeout: false,
      output: ""
    };
    orchestrator.events.emit("subagent.task.end", runSessionId, completed);
    return completed;
  }
  const done = await waitForLoopDoneBySession(orchestrator, task.sessionId, waitTimeoutMs);
  const output = await readLatestAssistantMessage(orchestrator, task.sessionId);
  const completed = {
    ...task,
    status: done.status,
    timeout: done.timeout,
    output
  };
  orchestrator.events.emit("subagent.task.end", runSessionId, completed);
  return completed;
}

function scheduleSubagentRunCompletion(
  orchestrator: BrainOrchestrator,
  runSessionId: string,
  mode: "single" | "parallel",
  tasks: StartedSubagentTask[],
  waitTimeoutMs: number
): void {
  void Promise.all(tasks.map((task) => completeStartedSubagentTask(orchestrator, runSessionId, task, waitTimeoutMs)))
    .then((results) => {
      const summary = classifySubagentRunStatus(results);
      orchestrator.events.emit("subagent.run.end", runSessionId, {
        mode,
        ...summary,
        taskCount: tasks.length,
        completedCount: results.length,
        results
      });
    })
    .catch((error) => {
      orchestrator.events.emit("subagent.run.end", runSessionId, {
        mode,
        status: "internal_error",
        taskCount: tasks.length,
        completedCount: 0,
        failCount: tasks.length,
        timeoutCount: 0,
        notStartedCount: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    });
}

async function handleBrainAgentRun(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const source = payload.payload ? toRecord(payload.payload) : payload;
  const modeRaw = String(source.mode || "").trim().toLowerCase();
  if (modeRaw !== "single" && modeRaw !== "parallel" && modeRaw !== "chain") {
    return fail("brain.agent.run 需要显式 mode（single|parallel|chain）");
  }
  const mode = modeRaw;
  const parentSessionId = String(source.parentSessionId || source.sessionId || "").trim();
  const defaultAutoRun = source.autoRun === false ? false : true;
  const waitTimeoutMs = normalizeIntInRange(
    source.waitTimeoutMs,
    DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
    1_000,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS
  );
  const runSessionId = resolveSubagentRunSessionId(source, parentSessionId);

  if (parentSessionId) {
    await orchestrator.sessions.ensureSession(parentSessionId);
  }

  if (mode === "single") {
    const rawSingle = source.single !== undefined ? source.single : source;
    const parsed = parseAgentRunTask(rawSingle, defaultAutoRun);
    if (!parsed.ok) return fail(parsed.error);
    orchestrator.events.emit("subagent.run.start", runSessionId, {
      mode: "single",
      parentSessionId: parentSessionId || null,
      taskCount: 1,
      waitTimeoutMs
    });
    const started = await startAgentRunTask(runtimeLoop, parsed.task, parsed.task.task, parentSessionId || undefined);
    const startedTask: StartedSubagentTask = {
      index: 1,
      agent: String(started.agent || ""),
      role: String(started.role || ""),
      profile: String(started.profile || ""),
      sessionId: String(started.sessionId || ""),
      task: String(started.task || ""),
      templateTask: String(started.templateTask || ""),
      autoRun: parsed.task.autoRun
    };
    orchestrator.events.emit("subagent.task.start", runSessionId, startedTask);
    scheduleSubagentRunCompletion(orchestrator, runSessionId, "single", [startedTask], waitTimeoutMs);
    return ok({
      mode: "single",
      runSessionId,
      result: started
    });
  }

  if (mode === "parallel") {
    const rawTasks = Array.isArray(source.tasks) ? source.tasks : [];
    if (rawTasks.length === 0) {
      return fail("brain.agent.run parallel 需要非空 tasks");
    }
    if (rawTasks.length > MAX_SUBAGENT_PARALLEL_TASKS) {
      return fail(`brain.agent.run parallel tasks 不能超过 ${MAX_SUBAGENT_PARALLEL_TASKS}`);
    }
    const concurrency = normalizeIntInRange(
      source.concurrency,
      Math.min(MAX_SUBAGENT_PARALLEL_CONCURRENCY, rawTasks.length),
      1,
      MAX_SUBAGENT_PARALLEL_CONCURRENCY
    );
    const parsedTasks: AgentRunTaskInput[] = [];
    for (let i = 0; i < rawTasks.length; i += 1) {
      const parsed = parseAgentRunTask(rawTasks[i], defaultAutoRun);
      if (!parsed.ok) {
        return fail(`brain.agent.run tasks[${i}] 无效: ${parsed.error}`);
      }
      parsedTasks.push(parsed.task);
    }

    orchestrator.events.emit("subagent.run.start", runSessionId, {
      mode: "parallel",
      parentSessionId: parentSessionId || null,
      taskCount: parsedTasks.length,
      concurrency,
      waitTimeoutMs
    });

    const results: Array<Record<string, unknown>> = new Array(parsedTasks.length);
    const startedTasks: StartedSubagentTask[] = new Array(parsedTasks.length);
    let cursor = 0;
    const workerCount = Math.min(concurrency, parsedTasks.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= parsedTasks.length) break;
          const started = await startAgentRunTask(runtimeLoop, parsedTasks[index], parsedTasks[index].task, parentSessionId || undefined);
          results[index] = started;
          const startedTask: StartedSubagentTask = {
            index: index + 1,
            agent: String(started.agent || ""),
            role: String(started.role || ""),
            profile: String(started.profile || ""),
            sessionId: String(started.sessionId || ""),
            task: String(started.task || ""),
            templateTask: String(started.templateTask || ""),
            autoRun: parsedTasks[index].autoRun
          };
          startedTasks[index] = startedTask;
          orchestrator.events.emit("subagent.task.start", runSessionId, startedTask);
        }
      })
    );
    scheduleSubagentRunCompletion(orchestrator, runSessionId, "parallel", startedTasks, waitTimeoutMs);

    return ok({
      mode: "parallel",
      runSessionId,
      concurrency: workerCount,
      results
    });
  }

  if (mode === "chain") {
    if (!defaultAutoRun) {
      return fail("brain.agent.run chain 需要 autoRun=true");
    }
    const rawChain = Array.isArray(source.chain) ? source.chain : [];
    if (rawChain.length === 0) {
      return fail("brain.agent.run chain 需要非空 chain");
    }
    if (rawChain.length > MAX_SUBAGENT_CHAIN_TASKS) {
      return fail(`brain.agent.run chain tasks 不能超过 ${MAX_SUBAGENT_CHAIN_TASKS}`);
    }
    const failFast = source.failFast !== false;
    const parsedChain: AgentRunTaskInput[] = [];
    for (let i = 0; i < rawChain.length; i += 1) {
      const parsed = parseAgentRunTask(rawChain[i], true);
      if (!parsed.ok) {
        return fail(`brain.agent.run chain[${i}] 无效: ${parsed.error}`);
      }
      parsedChain.push(parsed.task);
    }

    orchestrator.events.emit("subagent.run.start", runSessionId, {
      mode: "chain",
      parentSessionId: parentSessionId || null,
      taskCount: parsedChain.length,
      waitTimeoutMs,
      failFast
    });

    const results: Array<Record<string, unknown>> = [];
    let previousOutput = String(source.previous || "").trim();
    let halted = false;
    let haltedStatus = "";
    let haltedStep = 0;

    for (let i = 0; i < parsedChain.length; i += 1) {
      const task = parsedChain[i];
      const resolvedTask = injectChainPrevious(task.task, previousOutput);
      const started = await startAgentRunTask(runtimeLoop, task, resolvedTask, parentSessionId || undefined);
      const startedTask: StartedSubagentTask = {
        index: i + 1,
        agent: String(started.agent || ""),
        role: String(started.role || ""),
        profile: String(started.profile || ""),
        sessionId: String(started.sessionId || ""),
        task: String(started.task || ""),
        templateTask: String(started.templateTask || ""),
        autoRun: true
      };
      orchestrator.events.emit("subagent.task.start", runSessionId, startedTask);
      const completed = await completeStartedSubagentTask(orchestrator, runSessionId, startedTask, waitTimeoutMs);
      if (String(completed.output || "").trim()) {
        previousOutput = String(completed.output || "").trim();
      }
      results.push(completed);
      if (failFast && String(completed.status || "") !== "done") {
        halted = true;
        haltedStatus = String(completed.status || "");
        haltedStep = i + 1;
        break;
      }
    }

    const fanIn = {
      finalOutput: previousOutput,
      summary: buildChainFanInSummary(results)
    };
    const summary = classifySubagentRunStatus(results);
    orchestrator.events.emit("subagent.run.end", runSessionId, {
      mode: "chain",
      ...summary,
      taskCount: parsedChain.length,
      completedCount: results.length,
      failFast,
      halted,
      haltedStep: halted ? haltedStep : null,
      haltedStatus: halted ? haltedStatus : "",
      fanIn,
      results
    });

    return ok({
      mode: "chain",
      runSessionId,
      failFast,
      results,
      halted,
      haltedStep: halted ? haltedStep : null,
      haltedStatus: halted ? haltedStatus : "",
      fanIn
    });
  }

  orchestrator.events.emit("subagent.run.end", runSessionId, {
    mode,
    status: "failed_execute",
    taskCount: 0,
    completedCount: 0,
    failCount: 1,
    timeoutCount: 0,
    notStartedCount: 0,
    error: "unsupported_mode"
  });
  return fail("brain.agent.run 仅支持 mode=single|parallel|chain");
}

async function handleBrainRun(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  infra: RuntimeInfraHandler,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  if (action === "brain.run.start") {
    const rawStreamingBehavior =
      typeof payload.streamingBehavior === "string"
        ? payload.streamingBehavior
        : typeof payload.deliverAs === "string"
          ? payload.deliverAs
          : "";
    const streamingBehavior =
      rawStreamingBehavior === "follow_up"
        ? "followUp"
        : rawStreamingBehavior === "steer" || rawStreamingBehavior === "followUp"
          ? rawStreamingBehavior
          : undefined;
    const out = await runtimeLoop.startFromPrompt({
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      sessionOptions: payload.sessionOptions ? toRecord(payload.sessionOptions) : {},
      prompt: typeof payload.prompt === "string" ? payload.prompt : "",
      tabIds: Array.isArray(payload.tabIds) ? payload.tabIds : undefined,
      skillIds: Array.isArray(payload.skillIds) ? payload.skillIds : undefined,
      autoRun: payload.autoRun === false ? false : true,
      streamingBehavior
    });
    return ok(out);
  }

  if (action === "brain.run.steer" || action === "brain.run.follow_up") {
    const sessionId = requireSessionId(payload);
    const prompt = String(payload.prompt || "").trim();
    const skillIds = Array.isArray(payload.skillIds) ? payload.skillIds : undefined;
    if (!prompt && (!skillIds || skillIds.length === 0)) {
      return fail(`${action} 需要非空 prompt 或 skillIds`);
    }
    const out = await runtimeLoop.startFromPrompt({
      sessionId,
      prompt,
      skillIds,
      autoRun: true,
      streamingBehavior: action === "brain.run.steer" ? "steer" : "followUp"
    });
    return ok(out);
  }

  if (action === "brain.run.regenerate") {
    const sessionId = requireSessionId(payload);
    await orchestrator.sessions.ensureSession(sessionId);

    const sourceEntryId = String(payload.sourceEntryId || "").trim();
    if (!sourceEntryId) {
      return fail("brain.run.regenerate 需要 sourceEntryId");
    }

    const entries = await orchestrator.sessions.getEntries(sessionId);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const source = byId.get(sourceEntryId);
    if (!source) {
      return fail(`regenerate sourceEntry 不存在: ${sourceEntryId}`);
    }
    if (source.type !== "message" || source.role !== "assistant") {
      return fail("regenerate sourceEntry 必须是 assistant 消息");
    }

    const requireSourceIsLeaf = payload.requireSourceIsLeaf === true;
    const rebaseLeafToPreviousUser = payload.rebaseLeafToPreviousUser === true;
    const currentLeafId = (await orchestrator.sessions.getLeaf(sessionId)) || "";
    if (requireSourceIsLeaf && currentLeafId !== sourceEntryId) {
      return fail("仅最后一条 assistant 支持当前会话重试");
    }

    const previousSeed = String(source.parentId || "").trim();
    const previousEntry = previousSeed ? byId.get(previousSeed) : undefined;
    const previousUser = findPreviousUserEntryByChain(byId, previousEntry);
    if (!previousUser) {
      return fail("未找到前序 user 消息，无法重试");
    }

    if (rebaseLeafToPreviousUser && currentLeafId !== previousUser.id) {
      await orchestrator.sessions.setLeaf(sessionId, previousUser.id);
    }

    orchestrator.events.emit("input.regenerate", sessionId, {
      sourceEntryId,
      previousUserEntryId: previousUser.id,
      text: String(previousUser.text || "")
    });

    const out = await runtimeLoop.startFromRegenerate({
      sessionId,
      prompt: String(previousUser.text || ""),
      autoRun: payload.autoRun === false ? false : true
    });
    return ok(out);
  }

  if (action === "brain.run.edit_rerun") {
    const sourceSessionId = requireSessionId(payload);
    await orchestrator.sessions.ensureSession(sourceSessionId);

    const sourceEntryId = String(payload.sourceEntryId || payload.entryId || "").trim();
    if (!sourceEntryId) {
      return fail("brain.run.edit_rerun 需要 sourceEntryId");
    }
    const editedPrompt = String(payload.prompt || "").trim();
    if (!editedPrompt) {
      return fail("brain.run.edit_rerun 需要非空 prompt");
    }

    const sourceEntries = await orchestrator.sessions.getEntries(sourceSessionId);
    const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    const targetEntry = byId.get(sourceEntryId);
    if (!targetEntry) {
      return fail(`edit_rerun sourceEntry 不存在: ${sourceEntryId}`);
    }
    if (targetEntry.type !== "message" || targetEntry.role !== "user") {
      return fail("edit_rerun sourceEntry 必须是 user 消息");
    }

    const activeLeafId = (await orchestrator.sessions.getLeaf(sourceSessionId)) || null;
    const activeBranch = await orchestrator.sessions.getBranch(sourceSessionId, activeLeafId ?? undefined);
    if (!activeBranch.some((entry) => entry.id === sourceEntryId)) {
      return fail("edit_rerun sourceEntry 不在当前分支");
    }
    const latestUser = findLatestUserEntryInBranch(activeBranch);
    if (!latestUser) {
      return fail("当前分支缺少可编辑 user 消息");
    }
    const mode: "retry" | "fork" = latestUser.id === sourceEntryId ? "retry" : "fork";
    const autoRun = payload.autoRun === false ? false : true;

    let runSessionId = sourceSessionId;
    let runSourceEntryId = sourceEntryId;
    if (mode === "fork") {
      const forked = await forkSessionFromLeaf(orchestrator, {
        sourceSessionId,
        leafId: sourceEntryId,
        sourceEntryId,
        reason: String(payload.reason || "edit_user_rerun"),
        title: String(payload.title || "").trim() || undefined
      });
      runSessionId = forked.sessionId;
      runSourceEntryId = String(forked.leafId || "").trim();
      if (!runSourceEntryId) {
        return fail("edit_rerun fork 后未找到 sourceEntry");
      }
    }

    const runEntries = await orchestrator.sessions.getEntries(runSessionId);
    const runById = new Map(runEntries.map((entry) => [entry.id, entry]));
    const runSource = runById.get(runSourceEntryId);
    if (!runSource || runSource.type !== "message" || runSource.role !== "user") {
      return fail("edit_rerun 目标 user 节点异常");
    }

    const rebaseLeafId = runSource.parentId || null;
    const currentLeafId = (await orchestrator.sessions.getLeaf(runSessionId)) || null;
    if (currentLeafId !== rebaseLeafId) {
      await orchestrator.sessions.setLeaf(runSessionId, rebaseLeafId);
    }

    orchestrator.events.emit("input.regenerate", runSessionId, {
      sourceEntryId: runSourceEntryId,
      previousUserEntryId: runSourceEntryId,
      text: editedPrompt,
      mode,
      reason: "edit_user_rerun"
    });

    const out = await runtimeLoop.startFromPrompt({
      sessionId: runSessionId,
      prompt: editedPrompt,
      autoRun
    });

    return ok({
      ...out,
      mode,
      sourceSessionId,
      sourceEntryId,
      activeSourceEntryId: runSourceEntryId
    });
  }

  if (action === "brain.run.pause") {
    return ok(orchestrator.pause(requireSessionId(payload)));
  }

  if (action === "brain.run.queue.promote") {
    const sessionId = requireSessionId(payload);
    const queuedPromptId = String(payload.queuedPromptId || payload.id || "").trim();
    if (!queuedPromptId) {
      return fail("brain.run.queue.promote 需要 queuedPromptId");
    }
    const rawTarget = String(payload.targetBehavior || payload.behavior || "steer").trim();
    const targetBehavior = rawTarget === "followUp" ? "followUp" : "steer";
    const runtime = orchestrator.promoteQueuedPrompt(sessionId, queuedPromptId, targetBehavior);
    if (targetBehavior === "steer" && runtime.running === true && runtime.stopped !== true) {
      infra.abortBridgeInvokesBySession(sessionId, "steer_preempt");
    }
    return ok(runtime);
  }

  if (action === "brain.run.resume") {
    return ok(orchestrator.resume(requireSessionId(payload)));
  }

  if (action === "brain.run.stop") {
    const sessionId = requireSessionId(payload);
    const runtime = orchestrator.stop(sessionId);
    infra.abortBridgeInvokesBySession(sessionId);
    return ok(runtime);
  }

  return fail(`unsupported brain.run action: ${action}`);
}

async function handleSession(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.session.list") {
    const index = await orchestrator.sessions.listSessions();
    const sessions = await Promise.all(
      index.sessions.map(async (entry) => {
        const meta = await orchestrator.sessions.getMeta(entry.id);
        return {
          ...entry,
          title: normalizeSessionTitle(meta?.header?.title, ""),
          parentSessionId: String(meta?.header?.parentSessionId || ""),
          forkedFrom: readForkedFrom(meta)
        };
      })
    );
    return ok({ ...index, sessions });
  }

  if (action === "brain.session.get") {
    const sessionId = requireSessionId(payload);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    const entries = await orchestrator.sessions.getEntries(sessionId);
    return ok({ meta, entries });
  }

  if (action === "brain.session.view") {
    const sessionId = requireSessionId(payload);
    const leafId = typeof payload.leafId === "string" ? payload.leafId : undefined;
    return ok({
      conversationView: await buildConversationView(orchestrator, sessionId, leafId)
    });
  }

  if (action === "brain.session.fork") {
    const sessionId = requireSessionId(payload);
    const leafId = String(payload.leafId || "").trim();
    if (!leafId) {
      return fail("brain.session.fork 需要 leafId");
    }
    const forked = await forkSessionFromLeaf(orchestrator, {
      sourceSessionId: sessionId,
      leafId,
      sourceEntryId: String(payload.sourceEntryId || ""),
      reason: String(payload.reason || "manual"),
      title: String(payload.title || "").trim() || undefined,
      targetSessionId: String(payload.targetSessionId || "").trim() || undefined
    });
    return ok(forked);
  }

  if (action === "brain.session.title.refresh") {
    const sessionId = requireSessionId(payload);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    if (!meta) {
      return fail(`session 不存在: ${sessionId}`);
    }
    const hasExplicitTitle = typeof payload.title === "string";
    if (hasExplicitTitle) {
      const manualTitle = normalizeSessionTitle(payload.title, "");
      if (!manualTitle) {
        return fail("title 不能为空");
      }
      const metadata = {
        ...toRecord(meta.header.metadata),
        titleSource: SESSION_TITLE_SOURCE_MANUAL
      };
      await writeSessionMeta(sessionId, {
        ...meta,
        header: {
          ...meta.header,
          title: manualTitle,
          metadata
        },
        updatedAt: nowIso()
      });
      return ok({
        sessionId,
        title: manualTitle,
        updated: manualTitle !== normalizeSessionTitle(meta.header.title, "")
      });
    }
    const currentTitle = normalizeSessionTitle(meta.header.title, "");
    const force = payload.force === true;
    const derivedTitle = await runtimeLoop.refreshSessionTitle(sessionId, { force });
    if (!derivedTitle) {
      const entries = await orchestrator.sessions.getEntries(sessionId);
      const fallbackTitle = currentTitle || deriveSessionTitleFromEntries(entries);
      const normalizedFallback = normalizeSessionTitle(fallbackTitle, "新对话");
      if (normalizedFallback && normalizedFallback !== currentTitle) {
        await writeSessionMeta(sessionId, {
          ...meta,
          header: {
            ...meta.header,
            title: normalizedFallback
          },
          updatedAt: nowIso()
        });
      }
      return ok({
        sessionId,
        title: normalizedFallback || currentTitle,
        updated: normalizedFallback !== currentTitle
      });
    }
    return ok({
      sessionId,
      title: derivedTitle,
      updated: derivedTitle !== currentTitle
    });
  }

  if (action === "brain.session.delete") {
    const sessionId = requireSessionId(payload);
    const metaKey = `session:${sessionId}:meta`;
    await removeSessionMeta(sessionId);
    const index = await removeSessionIndexEntry(sessionId, nowIso());
    orchestrator.stop(sessionId);
    return ok({
      sessionId,
      deleted: true,
      removedCount: 1,
      removedKeys: [metaKey],
      index
    });
  }

  return fail(`unsupported brain.session action: ${action}`);
}

async function handleStep(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const type = String(payload.type || "");
  if (type === "brain.step.stream") {
    const sessionId = requireSessionId(payload);
    const stream = await orchestrator.getStepStream(sessionId);
    const limited = clampStepStream(stream, {
      maxEvents: payload.maxEvents,
      maxBytes: payload.maxBytes
    });
    return ok({ sessionId, stream: limited.stream, streamMeta: limited.meta });
  }

  if (type === "brain.step.execute") {
    const sessionId = requireSessionId(payload);
    const modeRaw = String(payload.mode || "").trim();
    const mode = ["script", "cdp", "bridge"].includes(modeRaw) ? (modeRaw as "script" | "cdp" | "bridge") : undefined;
    const capability = String(payload.capability || "").trim() || undefined;
    const action = String(payload.action || "").trim();
    if (modeRaw && !mode) return fail("mode 必须是 script/cdp/bridge");
    if (!mode && !capability) return fail("mode 或 capability 至少需要一个");
    if (!action) return fail("action 不能为空");
    return ok(
      await runtimeLoop.executeStep({
        sessionId,
        mode,
        capability,
        action,
        args: toRecord(payload.args),
        verifyPolicy: payload.verifyPolicy as "off" | "on_critical" | "always" | undefined
      })
    );
  }

  return fail(`unsupported step action: ${type}`);
}

async function handleStorage(message: unknown): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  if (action === "brain.storage.reset") {
    return ok(await resetSessionStore(toRecord(payload.options)));
  }
  if (action === "brain.storage.init") {
    return ok(await initSessionIndex());
  }
  return fail(`unsupported storage action: ${action}`);
}

interface SkillDiscoverRootInput {
  root: string;
  source: string;
}

interface SkillDiscoverScanHit {
  root: string;
  source: string;
  path: string;
}

interface ParsedSkillFrontmatter {
  id?: string;
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  warnings: string[];
}

function sanitizeSkillDiscoverCell(input: unknown, field: string): string {
  const text = String(input || "").trim();
  if (!text) return "";
  if (/[\r\n\t]/.test(text)) {
    throw new Error(`brain.skill.discover: ${field} 不能包含换行或制表符`);
  }
  return text;
}

function normalizeSkillDiscoverRoots(payload: Record<string, unknown>): SkillDiscoverRootInput[] {
  const fallbackSource = String(payload.source || "").trim() || "browser";
  const rawRoots = Array.isArray(payload.roots) ? payload.roots : [];
  const out: SkillDiscoverRootInput[] = [];

  if (rawRoots.length > 0) {
    for (const item of rawRoots) {
      if (typeof item === "string") {
        const root = sanitizeSkillDiscoverCell(item, "root");
        if (!root) continue;
        if (!isVirtualUri(root)) {
          throw new Error("brain.skill.discover 仅支持 mem:// 或 vfs:// roots");
        }
        out.push({ root: normalizeSkillPath(root), source: fallbackSource });
        continue;
      }
      const row = toRecord(item);
      const root = sanitizeSkillDiscoverCell(row.root || row.path || "", "root");
      if (!root) continue;
      if (!isVirtualUri(root)) {
        throw new Error("brain.skill.discover 仅支持 mem:// 或 vfs:// roots");
      }
      const source = sanitizeSkillDiscoverCell(row.source || fallbackSource, "source") || fallbackSource;
      out.push({ root: normalizeSkillPath(root), source });
    }
  } else {
    out.push(
      ...DEFAULT_SKILL_DISCOVER_ROOTS.map((item) => ({
        root: normalizeSkillPath(item.root),
        source: item.source
      }))
    );
  }

  const dedup = new Set<string>();
  const normalized: SkillDiscoverRootInput[] = [];
  for (const item of out) {
    const key = item.root;
    if (dedup.has(key)) continue;
    dedup.add(key);
    normalized.push(item);
  }
  return normalized;
}

function normalizeSkillPath(input: unknown): string {
  const raw = String(input || "").trim().replace(/\\/g, "/");
  const uriMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(raw);
  if (uriMatch) {
    const scheme = String(uriMatch[1] || "").trim().toLowerCase();
    let rest = String(uriMatch[2] || "").replace(/^\/+/, "").replace(/\/+/g, "/");
    if (rest.length > 1) {
      rest = rest.replace(/\/+$/g, "");
    }
    return `${scheme}://${rest}`;
  }

  let text = raw.replace(/\/+/g, "/");
  if (text.length > 1) {
    text = text.replace(/\/+$/g, "");
  }
  return text;
}

function pathBaseName(path: string): string {
  const normalized = normalizeSkillPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return normalized;
  return normalized.slice(lastSlash + 1);
}

function pathParentBaseName(path: string): string {
  const normalized = normalizeSkillPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  const parent = normalized.slice(0, lastSlash);
  const parentSlash = parent.lastIndexOf("/");
  if (parentSlash < 0) return parent;
  return parent.slice(parentSlash + 1);
}

function shouldAcceptDiscoveredSkillPath(root: string, path: string): boolean {
  const normalizedRoot = normalizeSkillPath(root);
  const normalizedPath = normalizeSkillPath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  let relative = "";
  if (normalizedPath === normalizedRoot) {
    relative = "";
  } else if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    relative = normalizedPath.slice(normalizedRoot.length + 1);
  } else {
    return false;
  }
  if (!relative) return false;

  const parts = relative.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((item) => item === "node_modules" || item.startsWith("."))) return false;
  const base = parts[parts.length - 1] || "";
  if (parts.length === 1) {
    return /\.md$/i.test(base);
  }
  return base === "SKILL.md";
}

function trimQuotePair(text: string): string {
  const value = String(text || "").trim();
  if (!value) return value;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function parseFrontmatterBoolean(raw: string): boolean | undefined {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return undefined;
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  return undefined;
}

function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const out: ParsedSkillFrontmatter = { warnings: [] };
  const lines = String(content || "").split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return out;

  const fields: Record<string, string> = {};
  let endLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    if (line.trim() === "---") {
      endLine = i;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([a-zA-Z0-9._-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    fields[match[1].toLowerCase()] = trimQuotePair(match[2]);
  }
  if (endLine < 0) {
    out.warnings.push("frontmatter 未闭合");
    return out;
  }

  const id = String(fields.id || "").trim();
  const name = String(fields.name || "").trim();
  const description = String(fields.description || "").trim();
  const disableRaw = String(
    fields["disable-model-invocation"] || fields["disable_model_invocation"] || fields["disablemodelinvocation"] || ""
  ).trim();

  if (id) out.id = id;
  if (name) out.name = name;
  if (description) out.description = description;
  if (disableRaw) {
    const parsed = parseFrontmatterBoolean(disableRaw);
    if (parsed === undefined) {
      out.warnings.push("disable-model-invocation 不是布尔值");
    } else {
      out.disableModelInvocation = parsed;
    }
  }
  return out;
}

function deriveSkillNameFromLocation(location: string): string {
  const base = pathBaseName(location);
  const seed = base.toUpperCase() === "SKILL.MD" ? pathParentBaseName(location) : base.replace(/\.md$/i, "");
  const collapsed = String(seed || "")
    .trim()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || "skill";
}

function deriveSkillIdSeedFromLocation(location: string): string {
  const base = pathBaseName(location);
  if (base.toUpperCase() === "SKILL.MD") {
    return pathParentBaseName(location) || location;
  }
  return base.replace(/\.md$/i, "") || location;
}

function extractSkillReadContent(data: unknown): string {
  const root = toRecord(data);
  const rootData = toRecord(root.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates: unknown[] = [
    data,
    root.content,
    root.text,
    rootData.content,
    rootData.text,
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
  throw new Error("brain.skill.discover: 文件读取工具未返回文本");
}

function extractBashExecResult(data: unknown): { stdout: string; stderr: string; exitCode: number | null } {
  const root = toRecord(data);
  const rootData = toRecord(root.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates = [root, rootData, rootResponse, rootResponseData, rootResponseInnerData, rootResult];
  for (const item of candidates) {
    const stdout = item.stdout;
    if (typeof stdout !== "string") continue;
    const stderr = typeof item.stderr === "string" ? item.stderr : "";
    const exitCodeRaw = Number(item.exitCode);
    return {
      stdout,
      stderr,
      exitCode: Number.isFinite(exitCodeRaw) ? exitCodeRaw : null
    };
  }
  throw new Error("brain.skill.discover 未返回 stdout");
}

function parseSkillDiscoverFindOutput(input: { root: string; source: string; stdout: string }): SkillDiscoverScanHit[] {
  const rows = String(input.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: SkillDiscoverScanHit[] = [];
  for (const row of rows) {
    const path = normalizeSkillPath(row);
    if (!path) continue;
    if (!shouldAcceptDiscoveredSkillPath(input.root, path)) continue;
    out.push({
      root: input.root,
      source: input.source,
      path
    });
  }
  return out;
}

async function handleBrainSkill(
  orchestrator: BrainOrchestrator,
  runtimeLoop: ReturnType<typeof createRuntimeLoopController>,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.skill.list") {
    return ok({
      skills: await orchestrator.listSkills()
    });
  }

  if (action === "brain.skill.install") {
    const skillPayload = Object.keys(toRecord(payload.skill)).length > 0 ? toRecord(payload.skill) : payload;
    const location = normalizeSkillPath(skillPayload.location);
    if (!location) return fail("brain.skill.install 需要 location");
    if (!isVirtualUri(location)) {
      return fail("brain.skill.install location 仅支持 mem:// 或 vfs://");
    }

    const skill = await orchestrator.installSkill(
      {
        id: String(skillPayload.id || "").trim() || undefined,
        name: String(skillPayload.name || "").trim() || undefined,
        description: String(skillPayload.description || "").trim() || undefined,
        location,
        source: String(skillPayload.source || "").trim() || undefined,
        enabled: skillPayload.enabled === undefined ? undefined : skillPayload.enabled !== false,
        disableModelInvocation:
          skillPayload.disableModelInvocation === undefined ? undefined : skillPayload.disableModelInvocation === true
      },
      {
        replace: payload.replace === true || skillPayload.replace === true
      }
    );
    return ok({
      skillId: skill.id,
      skill
    });
  }

  if (action === "brain.skill.resolve") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.resolve 需要 skillId");
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) return fail("brain.skill.resolve 需要 sessionId");
    const capability = String(payload.capability || "fs.read").trim() || "fs.read";
    const resolved = await orchestrator.resolveSkillContent(skillId, {
      allowDisabled: payload.allowDisabled === true,
      sessionId,
      capability
    });
    return ok({
      skillId: resolved.skill.id,
      skill: resolved.skill,
      content: resolved.content,
      promptBlock: resolved.promptBlock
    });
  }

  if (action === "brain.skill.discover") {
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) return fail("brain.skill.discover 需要 sessionId");

    const roots = normalizeSkillDiscoverRoots(payload);
    if (!roots.length) return fail("brain.skill.discover 需要 roots");

    const discoverCapability = String(payload.discoverCapability || "process.exec").trim() || "process.exec";
    const readCapability = String(payload.readCapability || "fs.read").trim() || "fs.read";
    const maxFiles = normalizeIntInRange(
      payload.maxFiles,
      DEFAULT_SKILL_DISCOVER_MAX_FILES,
      1,
      MAX_SKILL_DISCOVER_MAX_FILES
    );
    const timeoutMs = normalizeIntInRange(payload.timeoutMs, 60_000, 5_000, 300_000);
    const autoInstall = payload.autoInstall !== false;
    const replace = payload.replace !== false;

    const hits: SkillDiscoverScanHit[] = [];
    let scanStdoutBytes = 0;
    const scanStderrChunks: string[] = [];
    let scanExitCode: number | null = 0;

    for (let i = 0; i < roots.length; i += 1) {
      if (hits.length >= maxFiles) break;
      const rootItem = roots[i];
      const root = normalizeSkillPath(rootItem.root);
      const source = String(rootItem.source || "").trim() || "browser";
      const quotedRoot = `'${root.replace(/'/g, "'\"'\"'")}'`;
      const command = `find ${quotedRoot} -name '*.md'`;
      const discoveredStep = await runtimeLoop.executeStep({
        sessionId,
        capability: discoverCapability,
        action: "invoke",
        args: {
          frame: {
            tool: "bash",
            args: {
              cmdId: "bash.exec",
              args: [command],
              runtime: "browser",
              timeoutMs
            }
          }
        },
        verifyPolicy: "off"
      });
      if (!discoveredStep.ok) {
        return fail(discoveredStep.error || `brain.skill.discover 扫描失败: ${root}`);
      }

      const scanResult = extractBashExecResult(discoveredStep.data);
      scanStdoutBytes += scanResult.stdout.length;
      if (scanResult.stderr) scanStderrChunks.push(scanResult.stderr);
      if (scanResult.exitCode !== null && scanResult.exitCode !== 0) {
        scanExitCode = scanResult.exitCode;
      }
      const foundInRoot = parseSkillDiscoverFindOutput({
        root,
        source,
        stdout: scanResult.stdout
      });
      for (const hit of foundInRoot) {
        hits.push(hit);
        if (hits.length >= maxFiles) break;
      }
    }

    const uniqueHits: SkillDiscoverScanHit[] = [];
    const seenPaths = new Set<string>();
    for (const hit of hits) {
      const normalizedPath = normalizeSkillPath(hit.path);
      if (!normalizedPath || seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);
      uniqueHits.push({
        ...hit,
        path: normalizedPath
      });
    }

    const skipped: Array<Record<string, unknown>> = [];
    const discovered: Array<Record<string, unknown>> = [];
    const installed: unknown[] = [];

    for (const hit of uniqueHits) {
      let content = "";
      try {
        const readOut = await runtimeLoop.executeStep({
          sessionId,
          capability: readCapability,
          action: "invoke",
          args: {
            path: hit.path,
            frame: {
              tool: "read",
              args: {
                path: hit.path,
                ...(isVirtualUri(hit.path) ? { runtime: "browser" } : {})
              }
            }
          },
          verifyPolicy: "off"
        });
        if (!readOut.ok) {
          skipped.push({
            location: hit.path,
            source: hit.source,
            reason: readOut.error || "文件读取失败"
          });
          continue;
        }
        content = extractSkillReadContent(readOut.data);
      } catch (error) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      const frontmatter = parseSkillFrontmatter(content);
      const name = frontmatter.name || deriveSkillNameFromLocation(hit.path);
      const description = String(frontmatter.description || "").trim();
      const idSeed = String(frontmatter.id || frontmatter.name || deriveSkillIdSeedFromLocation(hit.path)).trim();
      if (!description) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: "frontmatter.description 缺失，按 Pi 规则跳过",
          warnings: frontmatter.warnings
        });
        continue;
      }

      const candidate = {
        id: idSeed,
        name,
        description,
        location: hit.path,
        source: hit.source,
        enabled: true,
        disableModelInvocation: frontmatter.disableModelInvocation === true,
        warnings: frontmatter.warnings
      };
      discovered.push(candidate);

      if (!autoInstall) continue;
      try {
        const skill = await orchestrator.installSkill(
          {
            id: candidate.id,
            name: candidate.name,
            description: candidate.description,
            location: candidate.location,
            source: candidate.source,
            enabled: true,
            disableModelInvocation: candidate.disableModelInvocation
          },
          {
            replace
          }
        );
        installed.push(skill);
      } catch (error) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return ok({
      sessionId,
      roots,
      scan: {
        maxFiles,
        timeoutMs,
        discoverCapability,
        readCapability,
        stdoutBytes: scanStdoutBytes,
        stderr: scanStderrChunks.join("\n"),
        exitCode: scanExitCode
      },
      counts: {
        scanned: uniqueHits.length,
        discovered: discovered.length,
        installed: installed.length,
        skipped: skipped.length
      },
      discovered,
      installed,
      skipped,
      skills: autoInstall ? await orchestrator.listSkills() : undefined
    });
  }

  if (action === "brain.skill.enable") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.enable 需要 skillId");
    const skill = await orchestrator.enableSkill(skillId);
    return ok({
      skillId: skill.id,
      skill
    });
  }

  if (action === "brain.skill.disable") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.disable 需要 skillId");
    const skill = await orchestrator.disableSkill(skillId);
    return ok({
      skillId: skill.id,
      skill
    });
  }

  if (action === "brain.skill.uninstall") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.uninstall 需要 skillId");
    const removed = await orchestrator.uninstallSkill(skillId);
    if (!removed) return fail(`skill 不存在: ${skillId}`);
    return ok({
      skillId,
      removed
    });
  }

  return fail(`unsupported brain.skill action: ${action}`);
}

async function handleBrainDebug(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  infra: RuntimeInfraHandler,
  message: unknown
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.debug.dump") {
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId.trim() : "";
    if (sessionId) {
      const meta = await orchestrator.sessions.getMeta(sessionId);
      if (!meta) {
        return fail(`session 不存在: ${sessionId}`);
      }
      const entries = await orchestrator.sessions.getEntries(sessionId);
      const stream = await orchestrator.getStepStream(sessionId);
      const limited = clampStepStream(stream, {
        maxEvents: payload.maxEvents,
        maxBytes: payload.maxBytes
      });
      const conversationView = await buildConversationView(orchestrator, sessionId);
      return ok({
        sessionId,
        runtime: orchestrator.getRunState(sessionId),
        meta,
        entryCount: entries.length,
        conversationView,
        stepStream: limited.stream,
        stepStreamMeta: limited.meta,
        globalTail: limited.stream.slice(-80)
      });
    }

    const index = await orchestrator.sessions.listSessions();
    return ok({
      index,
      runningSessions: index.sessions.map((entry) => orchestrator.getRunState(entry.id)),
      globalTail: []
    });
  }

  if (action === "brain.debug.config") {
    const cfgResult = await infra.handleMessage({ type: "config.get" });
    if (!cfgResult || !cfgResult.ok) {
      return fail(cfgResult?.error || "config.get failed");
    }
    const cfg = toRecord(cfgResult.data);
    const profiles = Array.isArray(cfg.llmProfiles) ? cfg.llmProfiles : [];
    const hasAnyLlmApiKey = profiles.some((item) => {
      const row = toRecord(item);
      return !!String(row.llmApiKey || "").trim();
    });
    const systemPromptPreview = await runtimeLoop.getSystemPromptPreview();
    return ok({
      bridgeUrl: String(cfg.bridgeUrl || ""),
      llmDefaultProfile: String(cfg.llmDefaultProfile || "default"),
      llmProfilesCount: profiles.length,
      bridgeInvokeTimeoutMs: Number(cfg.bridgeInvokeTimeoutMs || 0),
      llmTimeoutMs: Number(cfg.llmTimeoutMs || 0),
      llmRetryMaxAttempts: Number(cfg.llmRetryMaxAttempts || 0),
      llmMaxRetryDelayMs: Number(cfg.llmMaxRetryDelayMs || 0),
      hasLlmApiKey: hasAnyLlmApiKey,
      systemPromptPreview
    });
  }

  if (action === "brain.debug.plugins") {
    return ok({
      plugins: orchestrator.listPlugins(),
      modeProviders: orchestrator.listToolProviders(),
      toolContracts: orchestrator.listToolContracts(),
      capabilityProviders: orchestrator.listCapabilityProviders(),
      capabilityPolicies: orchestrator.listCapabilityPolicies()
    });
  }

  return fail(`unsupported brain.debug action: ${action}`);
}

export function registerRuntimeRouter(orchestrator: BrainOrchestrator): void {
  const infra = createRuntimeInfraHandler();
  const runtimeLoop = createRuntimeLoopController(orchestrator, infra);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const run = async () => {
      const routeBefore = await orchestrator.runHook("runtime.route.before", {
        type: String(message?.type || ""),
        message
      });
      if (routeBefore.blocked) {
        return fail(`runtime.route.before blocked: ${routeBefore.reason || "blocked"}`);
      }
      const routeInput = routeBefore.value;
      const type = String(routeInput.type || "");
      const routeMessage = routeInput.message as unknown;
      const applyAfter = async (result: RuntimeResult): Promise<RuntimeResult> => {
        const afterHook = await orchestrator.runHook("runtime.route.after", {
          type,
          message: routeMessage,
          result
        });
        return afterHook.blocked ? result : (afterHook.value.result as RuntimeResult);
      };

      try {
        if (type === "ping") {
          return await applyAfter(ok({ source: "service-worker", version: "vnext" }));
        }

        const infraResult = await infra.handleMessage(routeMessage);
        if (infraResult) return await applyAfter(fromInfraResult(infraResult));

        if (type.startsWith("brain.run.")) {
          return await applyAfter(await handleBrainRun(orchestrator, runtimeLoop, infra, routeMessage));
        }

        if (type.startsWith("brain.session.")) {
          return await applyAfter(await handleSession(orchestrator, runtimeLoop, routeMessage));
        }

        if (type.startsWith("brain.step.")) {
          return await applyAfter(await handleStep(orchestrator, runtimeLoop, routeMessage));
        }

        if (type.startsWith("brain.storage.")) {
          return await applyAfter(await handleStorage(routeMessage));
        }

        if (type.startsWith("brain.skill.")) {
          return await applyAfter(await handleBrainSkill(orchestrator, runtimeLoop, routeMessage));
        }

        if (type.startsWith("brain.debug.")) {
          return await applyAfter(await handleBrainDebug(orchestrator, runtimeLoop, infra, routeMessage));
        }

        if (type === "brain.agent.run") {
          return await applyAfter(await handleBrainAgentRun(orchestrator, runtimeLoop, routeMessage));
        }

        if (type === "brain.agent.end") {
          const payload = toRecord(toRecord(routeMessage).payload);
          const sessionId = String(payload.sessionId || "").trim();
          if (!sessionId) return fail("brain.agent.end 需要 payload.sessionId");

          const rawError = toRecord(payload.error);
          const statusNumber = Number(rawError.status);
          const error =
            Object.keys(rawError).length === 0
              ? null
              : {
                  message: typeof rawError.message === "string" ? rawError.message : undefined,
                  code: typeof rawError.code === "string" ? rawError.code : undefined,
                  status: Number.isFinite(statusNumber) ? statusNumber : undefined
                };

          return await applyAfter(
            ok(
              await orchestrator.handleAgentEnd({
                sessionId,
                error,
                overflow: payload.overflow === true
              })
            )
          );
        }

        return await applyAfter(fail(`Unknown message type: ${type}`));
      } catch (error) {
        await orchestrator.runHook("runtime.route.error", {
          type,
          message: routeMessage,
          error: error instanceof Error ? error.message : String(error)
        });
        return await applyAfter(fail(error));
      }
    };

    void run().then((result) => sendResponse(result));
    return true;
  });
}
