import { compact, shouldCompact } from "./compaction.browser";
import { BrainEventBus, type BrainEventEnvelope } from "./events";
import { BrowserSessionManager } from "./session-manager.browser";
import { appendTraceChunk, readTraceChunk } from "./session-store.browser";
import { nowIso, randomId, type RunState, type StepTraceRecord } from "./types";

export interface OrchestratorOptions {
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  retryCapDelayMs?: number;
  thresholdTokens?: number;
  keepTail?: number;
  splitTurn?: boolean;
  traceChunkSize?: number;
}

export interface AgentEndInput {
  sessionId: string;
  error?: { message?: string; code?: string; status?: number } | null;
  overflow?: boolean;
}

export interface AgentEndDecision {
  action: "continue" | "retry" | "done";
  reason: string;
  delayMs?: number;
  sessionId: string;
}

export interface RuntimeView {
  sessionId: string;
  paused: boolean;
  stopped: boolean;
  retry: RunState["retry"];
}

export type ExecuteMode = "script" | "cdp" | "bridge";

export interface ExecuteStepInput {
  sessionId: string;
  mode: ExecuteMode;
  action: string;
  args?: Record<string, unknown>;
  verifyPolicy?: "off" | "on_critical" | "always";
}

export interface ExecuteStepResult {
  ok: boolean;
  modeUsed: ExecuteMode;
  fallbackFrom?: ExecuteMode;
  verified: boolean;
  verifyReason?: string;
  data?: unknown;
  error?: string;
}

export interface ExecutionAdapters {
  script?: (input: ExecuteStepInput) => Promise<unknown>;
  cdp?: (input: ExecuteStepInput) => Promise<unknown>;
  bridge?: (input: ExecuteStepInput) => Promise<unknown>;
  verify?: (input: ExecuteStepInput, result: unknown) => Promise<{ verified: boolean; reason?: string }>;
}

function isRetryableError(error: AgentEndInput["error"]): boolean {
  if (!error) return false;
  const status = Number(error.status ?? 0);
  if (status >= 500 || status === 429 || status === 408) return true;
  const code = String(error.code || "").toUpperCase();
  if (["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENETUNREACH"].includes(code)) return true;
  const text = `${error.message || ""} ${code}`.toLowerCase();
  return /timeout|temporar|unavailable|rate limit|network/.test(text);
}

function backoffDelay(attempt: number, base: number, cap: number): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

// 对照点：pi-mono/packages/coding-agent/src/core/agent-session.ts:1565 _checkCompaction
export class BrainOrchestrator {
  readonly sessions = new BrowserSessionManager();
  readonly events = new BrainEventBus();
  private readonly options: Required<OrchestratorOptions>;
  private readonly adapters: ExecutionAdapters;
  private readonly runStateBySession = new Map<string, RunState>();
  private readonly streamBySession = new Map<string, StepTraceRecord[]>();

  constructor(options: OrchestratorOptions = {}, adapters: ExecutionAdapters = {}) {
    this.options = {
      retryMaxAttempts: options.retryMaxAttempts ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
      retryCapDelayMs: options.retryCapDelayMs ?? 5000,
      thresholdTokens: options.thresholdTokens ?? 1800,
      keepTail: options.keepTail ?? 14,
      splitTurn: options.splitTurn ?? true,
      traceChunkSize: options.traceChunkSize ?? 80
    };
    this.adapters = adapters;

    this.events.subscribe((event) => {
      void this.persistEvent(event);
    });
  }

  private async persistEvent(event: BrainEventEnvelope): Promise<void> {
    const traceId = `session-${event.sessionId}`;
    const records = this.streamBySession.get(event.sessionId) ?? [];
    const record: StepTraceRecord = {
      id: randomId("trace"),
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.ts,
      payload: event.payload
    };
    records.push(record);
    if (records.length > 240) records.splice(0, records.length - 240);
    this.streamBySession.set(event.sessionId, records);

    const chunk = Math.floor((records.length - 1) / this.options.traceChunkSize);
    await appendTraceChunk(traceId, chunk, [record]);
  }

  async createSession(input?: Parameters<BrowserSessionManager["createSession"]>[0]): Promise<{ sessionId: string }> {
    const meta = await this.sessions.createSession(input);
    this.runStateBySession.set(meta.header.id, {
      sessionId: meta.header.id,
      paused: false,
      stopped: false,
      retry: {
        active: false,
        attempt: 0,
        maxAttempts: this.options.retryMaxAttempts,
        delayMs: 0
      }
    });
    return { sessionId: meta.header.id };
  }

  async appendUserMessage(sessionId: string, text: string): Promise<void> {
    await this.sessions.appendMessage({
      sessionId,
      role: "user",
      text
    });
  }

  getRunState(sessionId: string): RuntimeView {
    const current = this.runStateBySession.get(sessionId);
    if (current) {
      return {
        sessionId,
        paused: current.paused,
        stopped: current.stopped,
        retry: { ...current.retry }
      };
    }
    return {
      sessionId,
      paused: false,
      stopped: false,
      retry: {
        active: false,
        attempt: 0,
        maxAttempts: this.options.retryMaxAttempts,
        delayMs: 0
      }
    };
  }

  pause(sessionId: string): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.paused = true;
    return this.getRunState(sessionId);
  }

  resume(sessionId: string): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.paused = false;
    return this.getRunState(sessionId);
  }

  stop(sessionId: string): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.stopped = true;
    return this.getRunState(sessionId);
  }

  private ensureRunState(sessionId: string): RunState {
    const cached = this.runStateBySession.get(sessionId);
    if (cached) return cached;
    const created: RunState = {
      sessionId,
      paused: false,
      stopped: false,
      retry: {
        active: false,
        attempt: 0,
        maxAttempts: this.options.retryMaxAttempts,
        delayMs: 0
      }
    };
    this.runStateBySession.set(sessionId, created);
    return created;
  }

  private isCriticalAction(action: string): boolean {
    const value = action.toLowerCase();
    return (
      value.includes("navigate") ||
      value.includes("click") ||
      value.includes("type") ||
      value.includes("fill") ||
      value.includes("select") ||
      value.includes("write")
    );
  }

  private shouldVerify(input: ExecuteStepInput): boolean {
    const policy = input.verifyPolicy ?? "on_critical";
    if (policy === "off") return false;
    if (policy === "always") return true;
    return this.isCriticalAction(input.action);
  }

  // 对照点：执行策略 PR-6 script 优先，失败降级 cdp
  async executeStep(input: ExecuteStepInput): Promise<ExecuteStepResult> {
    const tryInvoke = async (mode: ExecuteMode, payload: ExecuteStepInput) => {
      if (mode === "script" && this.adapters.script) return this.adapters.script(payload);
      if (mode === "cdp" && this.adapters.cdp) return this.adapters.cdp(payload);
      if (mode === "bridge" && this.adapters.bridge) return this.adapters.bridge(payload);
      throw new Error(`${mode} adapter 未配置`);
    };

    let modeUsed: ExecuteMode = input.mode;
    let fallbackFrom: ExecuteMode | undefined;
    let data: unknown;

    try {
      data = await tryInvoke(input.mode, input);
    } catch (error) {
      if (input.mode !== "script") {
        return {
          ok: false,
          modeUsed,
          error: error instanceof Error ? error.message : String(error),
          verified: false
        };
      }

      fallbackFrom = "script";
      modeUsed = "cdp";
      data = await tryInvoke("cdp", { ...input, mode: "cdp" });
    }

    let verified = false;
    let verifyReason = "verify_skipped";
    if (this.shouldVerify(input) && this.adapters.verify) {
      const verifyResult = await this.adapters.verify({ ...input, mode: modeUsed }, data);
      verified = verifyResult.verified;
      verifyReason = verifyResult.reason || (verified ? "verified" : "verify_failed");
    } else if (!this.shouldVerify(input)) {
      verifyReason = "verify_policy_off";
    } else {
      verifyReason = "verify_adapter_missing";
    }

    return {
      ok: true,
      modeUsed,
      fallbackFrom,
      verified,
      verifyReason,
      data
    };
  }

  // 对照点：pi-mono/packages/coding-agent/src/core/agent-session.ts:1591 overflow/threshold 分支
  async preSendCompactionCheck(sessionId: string): Promise<boolean> {
    const context = await this.sessions.buildSessionContext(sessionId);
    const decision = shouldCompact({
      overflow: false,
      entries: context.entries,
      previousSummary: context.previousSummary,
      thresholdTokens: this.options.thresholdTokens
    });

    if (!decision.shouldCompact || decision.reason !== "threshold") return false;
    await this.runCompaction(sessionId, "threshold", false);
    return true;
  }

  // 对照点：pi-mono/packages/coding-agent/src/core/agent-session.ts:2083 retry 判定优先于 compaction
  async handleAgentEnd(input: AgentEndInput): Promise<AgentEndDecision> {
    const sessionId = input.sessionId;
    const state = this.ensureRunState(sessionId);

    if (state.stopped) {
      return { action: "done", reason: "stopped", sessionId };
    }

    const retryable = isRetryableError(input.error) && !input.overflow;
    if (retryable) {
      if (state.retry.attempt < state.retry.maxAttempts) {
        state.retry.attempt += 1;
        state.retry.active = true;
        state.retry.delayMs = backoffDelay(state.retry.attempt, this.options.retryBaseDelayMs, this.options.retryCapDelayMs);
        this.events.emit("auto_retry_start", sessionId, {
          attempt: state.retry.attempt,
          maxAttempts: state.retry.maxAttempts,
          delayMs: state.retry.delayMs,
          reason: input.error?.message || "retryable-error"
        });
        return {
          action: "retry",
          reason: "retryable_error",
          delayMs: state.retry.delayMs,
          sessionId
        };
      }

      this.events.emit("auto_retry_end", sessionId, {
        success: false,
        attempt: state.retry.attempt,
        maxAttempts: state.retry.maxAttempts,
        finalError: input.error?.message || "retry-limit"
      });
      state.retry.active = false;
      state.retry.delayMs = 0;
    } else if (state.retry.active) {
      this.events.emit("auto_retry_end", sessionId, {
        success: true,
        attempt: state.retry.attempt,
        maxAttempts: state.retry.maxAttempts
      });
      state.retry.active = false;
      state.retry.delayMs = 0;
      state.retry.attempt = 0;
    }

    const context = await this.sessions.buildSessionContext(sessionId);
    const compactDecision = shouldCompact({
      overflow: Boolean(input.overflow),
      entries: context.entries,
      previousSummary: context.previousSummary,
      thresholdTokens: this.options.thresholdTokens
    });

    if (compactDecision.shouldCompact && compactDecision.reason) {
      const willRetry = compactDecision.reason === "overflow";
      await this.runCompaction(sessionId, compactDecision.reason, willRetry);
      return {
        action: "continue",
        reason: `compaction_${compactDecision.reason}`,
        sessionId
      };
    }

    return {
      action: "done",
      reason: input.error ? "error" : "completed",
      sessionId
    };
  }

  async getStepStream(sessionId: string): Promise<StepTraceRecord[]> {
    const cache = this.streamBySession.get(sessionId);
    if (cache) return cache.slice();

    const traceId = `session-${sessionId}`;
    const loaded: StepTraceRecord[] = [];
    for (let chunk = 0; chunk < 64; chunk += 1) {
      const records = await readTraceChunk<StepTraceRecord>(traceId, chunk);
      if (records.length === 0) break;
      loaded.push(...records);
    }

    this.streamBySession.set(sessionId, loaded);
    return loaded.slice();
  }

  private async runCompaction(sessionId: string, reason: "overflow" | "threshold", willRetry: boolean): Promise<void> {
    this.events.emit("auto_compaction_start", sessionId, {
      reason,
      willRetry
    });

    try {
      const context = await this.sessions.buildSessionContext(sessionId);
      const draft = compact({
        reason,
        entries: context.entries,
        previousSummary: context.previousSummary,
        keepTail: this.options.keepTail,
        splitTurn: this.options.splitTurn
      });
      const compactionEntry = await this.sessions.appendCompaction(sessionId, reason, draft, {
        source: "browser-orchestrator",
        generatedAt: nowIso()
      });

      this.events.emit("session_compact", sessionId, {
        reason,
        willRetry,
        entryId: compactionEntry.id,
        firstKeptEntryId: draft.firstKeptEntryId,
        tokensBefore: draft.tokensBefore,
        tokensAfter: draft.tokensAfter
      });

      this.events.emit("auto_compaction_end", sessionId, {
        reason,
        success: true,
        willRetry,
        firstKeptEntryId: draft.firstKeptEntryId,
        tokensBefore: draft.tokensBefore,
        tokensAfter: draft.tokensAfter
      });
    } catch (error) {
      this.events.emit("auto_compaction_end", sessionId, {
        reason,
        success: false,
        willRetry,
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
