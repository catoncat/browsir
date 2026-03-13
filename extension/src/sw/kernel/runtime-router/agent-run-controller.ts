import type { BrainOrchestrator } from "../orchestrator.browser";
import type { RuntimeLoopController } from "../runtime-loop.browser";
import { randomId } from "../types";

type RuntimeOk<T = unknown> = { ok: true; data: T };
type RuntimeErr = { ok: false; error: string };
type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

const MAX_SUBAGENT_PARALLEL_TASKS = 8;
const MAX_SUBAGENT_PARALLEL_CONCURRENCY = 4;
const MAX_SUBAGENT_CHAIN_TASKS = 8;
const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 60_000;
const MAX_SUBAGENT_WAIT_TIMEOUT_MS = 300_000;
const SUBAGENT_IDLE_GRACE_MS = 150;
const CHAIN_PREVIOUS_TOKEN = "{previous}";

interface AgentRunTaskInput {
  agent: string;
  role: string;
  task: string;
  profile?: string;
  sessionId?: string;
  sessionOptions: Record<string, unknown>;
  autoRun: boolean;
}

interface StartedSubagentTask extends Record<string, unknown> {
  index: number;
  agent: string;
  role: string;
  profile: string;
  sessionId: string;
  task: string;
  templateTask: string;
  autoRun: boolean;
}

function ok<T>(data: T): RuntimeOk<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeErr {
  return { ok: false, error };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function parseAgentRunTask(
  raw: unknown,
  defaultAutoRun: boolean,
): { ok: true; task: AgentRunTaskInput } | { ok: false; error: string } {
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
  const sessionOptions = source.sessionOptions
    ? toRecord(source.sessionOptions)
    : {};
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
      autoRun,
    },
  };
}

async function startAgentRunTask(
  runtimeLoop: RuntimeLoopController,
  task: AgentRunTaskInput,
  resolvedTask: string,
  parentSessionId?: string,
): Promise<Record<string, unknown>> {
  const sessionOptions = {
    ...toRecord(task.sessionOptions),
  };
  const metadata = {
    ...toRecord(sessionOptions.metadata),
    agent: task.agent,
    agentRole: task.role,
    llmRole: task.role,
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
    autoRun: task.autoRun,
  });
  return {
    agent: task.agent,
    role: task.role,
    profile: task.profile || "",
    task: resolvedTask,
    templateTask: task.task,
    sessionId: started.sessionId,
    runtime: started.runtime,
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
  timeoutMs: number,
): Promise<{ status: string; timeout: boolean }> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let idleSince = 0;
  while (Date.now() < deadline) {
    const stream = await orchestrator.getStepStream(sessionId);
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const item = stream[i];
      if (String(item.type || "") !== "loop_done") continue;
      const payload = toRecord(item.payload);
      return {
        status: String(payload.status || "").trim() || "done",
        timeout: false,
      };
    }
    const state = orchestrator.getRunState(sessionId);
    if (!state.running && !state.paused) {
      if (!state.stopped) {
        if (!idleSince) {
          idleSince = Date.now();
        } else if (Date.now() - idleSince >= SUBAGENT_IDLE_GRACE_MS) {
          return {
            status: "done",
            timeout: false,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        continue;
      }
      return {
        status: state.stopped ? "stopped" : "unknown",
        timeout: false,
      };
    }
    idleSince = 0;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return {
    status: "timeout",
    timeout: true,
  };
}

async function readLatestAssistantMessage(
  orchestrator: BrainOrchestrator,
  sessionId: string,
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

function buildChainFanInSummary(
  results: Array<Record<string, unknown>>,
): string {
  const lines = results.map((item, index) => {
    const agent = String(item.agent || "").trim() || `agent-${index + 1}`;
    const status = String(item.status || "").trim() || "unknown";
    const output = String(item.output || "")
      .trim()
      .replace(/\s+/g, " ");
    const clipped = output.length > 140 ? `${output.slice(0, 140)}…` : output;
    return `${index + 1}. ${agent} [${status}] ${clipped}`;
  });
  return lines.join("\n");
}

function resolveSubagentRunSessionId(
  source: Record<string, unknown>,
  parentSessionId: string,
): string {
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
  if (timeoutCount > 0) {
    return { status: "timeout", failCount, timeoutCount, notStartedCount };
  }
  if (failCount > 0) {
    return {
      status: "partial_failed",
      failCount,
      timeoutCount,
      notStartedCount,
    };
  }
  if (notStartedCount > 0) {
    return { status: "not_started", failCount, timeoutCount, notStartedCount };
  }
  return { status: "done", failCount, timeoutCount, notStartedCount };
}

async function completeStartedSubagentTask(
  orchestrator: BrainOrchestrator,
  runSessionId: string,
  task: StartedSubagentTask,
  waitTimeoutMs: number,
): Promise<Record<string, unknown>> {
  if (!task.autoRun) {
    const completed = {
      ...task,
      status: "not_started",
      timeout: false,
      output: "",
    };
    orchestrator.events.emit("subagent.task.end", runSessionId, completed);
    return completed;
  }
  const done = await waitForLoopDoneBySession(
    orchestrator,
    task.sessionId,
    waitTimeoutMs,
  );
  const output = await readLatestAssistantMessage(orchestrator, task.sessionId);
  const completed = {
    ...task,
    status: done.status,
    timeout: done.timeout,
    output,
  };
  orchestrator.events.emit("subagent.task.end", runSessionId, completed);
  return completed;
}

function scheduleSubagentRunCompletion(
  orchestrator: BrainOrchestrator,
  runSessionId: string,
  mode: "single" | "parallel",
  tasks: StartedSubagentTask[],
  waitTimeoutMs: number,
): void {
  void Promise.all(
    tasks.map((task) =>
      completeStartedSubagentTask(
        orchestrator,
        runSessionId,
        task,
        waitTimeoutMs,
      ),
    ),
  )
    .then((results) => {
      const summary = classifySubagentRunStatus(results);
      orchestrator.events.emit("subagent.run.end", runSessionId, {
        mode,
        ...summary,
        taskCount: tasks.length,
        completedCount: results.length,
        results,
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
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export async function handleBrainAgentRun(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const source = payload.payload ? toRecord(payload.payload) : payload;
  const modeRaw = String(source.mode || "")
    .trim()
    .toLowerCase();
  if (modeRaw !== "single" && modeRaw !== "parallel" && modeRaw !== "chain") {
    return fail("brain.agent.run 需要显式 mode（single|parallel|chain）");
  }
  const mode = modeRaw;
  const parentSessionId = String(
    source.parentSessionId || source.sessionId || "",
  ).trim();
  const defaultAutoRun = source.autoRun === false ? false : true;
  const waitTimeoutMs = normalizeIntInRange(
    source.waitTimeoutMs,
    DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS,
    1_000,
    MAX_SUBAGENT_WAIT_TIMEOUT_MS,
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
      waitTimeoutMs,
    });
    const started = await startAgentRunTask(
      runtimeLoop,
      parsed.task,
      parsed.task.task,
      parentSessionId || undefined,
    );
    const startedTask: StartedSubagentTask = {
      index: 1,
      agent: String(started.agent || ""),
      role: String(started.role || ""),
      profile: String(started.profile || ""),
      sessionId: String(started.sessionId || ""),
      task: String(started.task || ""),
      templateTask: String(started.templateTask || ""),
      autoRun: parsed.task.autoRun,
    };
    orchestrator.events.emit("subagent.task.start", runSessionId, startedTask);
    scheduleSubagentRunCompletion(
      orchestrator,
      runSessionId,
      "single",
      [startedTask],
      waitTimeoutMs,
    );
    return ok({
      mode: "single",
      runSessionId,
      result: started,
    });
  }

  if (mode === "parallel") {
    const rawTasks = Array.isArray(source.tasks) ? source.tasks : [];
    if (rawTasks.length === 0) {
      return fail("brain.agent.run parallel 需要非空 tasks");
    }
    if (rawTasks.length > MAX_SUBAGENT_PARALLEL_TASKS) {
      return fail(
        `brain.agent.run parallel tasks 不能超过 ${MAX_SUBAGENT_PARALLEL_TASKS}`,
      );
    }
    const concurrency = normalizeIntInRange(
      source.concurrency,
      Math.min(MAX_SUBAGENT_PARALLEL_CONCURRENCY, rawTasks.length),
      1,
      MAX_SUBAGENT_PARALLEL_CONCURRENCY,
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
      waitTimeoutMs,
    });

    const results: Array<Record<string, unknown>> = new Array(
      parsedTasks.length,
    );
    const startedTasks: StartedSubagentTask[] = new Array(parsedTasks.length);
    let cursor = 0;
    const workerCount = Math.min(concurrency, parsedTasks.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= parsedTasks.length) break;
          const started = await startAgentRunTask(
            runtimeLoop,
            parsedTasks[index],
            parsedTasks[index].task,
            parentSessionId || undefined,
          );
          results[index] = started;
          const startedTask: StartedSubagentTask = {
            index: index + 1,
            agent: String(started.agent || ""),
            role: String(started.role || ""),
            profile: String(started.profile || ""),
            sessionId: String(started.sessionId || ""),
            task: String(started.task || ""),
            templateTask: String(started.templateTask || ""),
            autoRun: parsedTasks[index].autoRun,
          };
          startedTasks[index] = startedTask;
          orchestrator.events.emit(
            "subagent.task.start",
            runSessionId,
            startedTask,
          );
        }
      }),
    );
    scheduleSubagentRunCompletion(
      orchestrator,
      runSessionId,
      "parallel",
      startedTasks,
      waitTimeoutMs,
    );

    return ok({
      mode: "parallel",
      runSessionId,
      concurrency: workerCount,
      results,
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
      return fail(
        `brain.agent.run chain tasks 不能超过 ${MAX_SUBAGENT_CHAIN_TASKS}`,
      );
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
      failFast,
    });

    const results: Array<Record<string, unknown>> = [];
    let previousOutput = String(source.previous || "").trim();
    let halted = false;
    let haltedStatus = "";
    let haltedStep = 0;

    for (let i = 0; i < parsedChain.length; i += 1) {
      const task = parsedChain[i];
      const resolvedTask = injectChainPrevious(task.task, previousOutput);
      const started = await startAgentRunTask(
        runtimeLoop,
        task,
        resolvedTask,
        parentSessionId || undefined,
      );
      const startedTask: StartedSubagentTask = {
        index: i + 1,
        agent: String(started.agent || ""),
        role: String(started.role || ""),
        profile: String(started.profile || ""),
        sessionId: String(started.sessionId || ""),
        task: String(started.task || ""),
        templateTask: String(started.templateTask || ""),
        autoRun: true,
      };
      orchestrator.events.emit(
        "subagent.task.start",
        runSessionId,
        startedTask,
      );
      const completed = await completeStartedSubagentTask(
        orchestrator,
        runSessionId,
        startedTask,
        waitTimeoutMs,
      );
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
      summary: buildChainFanInSummary(results),
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
      results,
    });

    return ok({
      mode: "chain",
      runSessionId,
      failFast,
      results,
      halted,
      haltedStep: halted ? haltedStep : null,
      haltedStatus: halted ? haltedStatus : "",
      fanIn,
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
    error: "unsupported_mode",
  });
  return fail("brain.agent.run 仅支持 mode=single|parallel|chain");
}
