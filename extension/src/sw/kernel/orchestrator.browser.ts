import { compact, prepareCompaction, shouldCompact } from "./compaction.browser";
import { BrainEventBus, type BrainEventEnvelope } from "./events";
import { HookRunner, type HookHandler, type HookHandlerOptions } from "./hook-runner";
import type { OrchestratorHookMap } from "./orchestrator-hooks";
import { BrowserSessionManager } from "./session-manager.browser";
import { appendTraceChunk, readTraceChunk } from "./session-store.browser";
import {
  CapabilityPolicyRegistry,
  type CapabilityExecutionPolicy,
  type RegisterCapabilityPolicyOptions
} from "./capability-policy";
import {
  type ExecuteCapability,
  nowIso,
  randomId,
  type QueueDequeueMode,
  type ExecuteMode,
  type ExecuteStepInput,
  type ExecuteStepResult,
  type QueuedRuntimePrompt,
  type RunState,
  type StreamingBehavior,
  type StepTraceRecord
} from "./types";
import { ToolProviderRegistry, type RegisterProviderOptions, type StepToolProvider } from "./tool-provider-registry";
import { PluginRuntime, type AgentPluginDefinition, type PluginRuntimeView } from "./plugin-runtime";
import {
  SkillContentResolver,
  type ResolveSkillContentOptions,
  type ResolvedSkillContent,
  type SkillContentReader
} from "./skill-content-resolver";
import { SkillRegistry, type SkillInstallInput, type SkillMetadata } from "./skill-registry";
import {
  ToolContractRegistry,
  type RegisterToolContractOptions,
  type ToolContract,
  type ToolContractView,
  type ToolDefinition
} from "./tool-contract-registry";
import { createOpenAiCompatibleLlmProvider } from "./llm-openai-compatible-provider";
import { DEFAULT_LLM_PROVIDER_ID, type LlmProviderAdapter } from "./llm-provider";
import { LlmProviderRegistry, type RegisterLlmProviderOptions } from "./llm-provider-registry";

export type { ExecuteCapability, ExecuteMode, ExecuteStepInput, ExecuteStepResult } from "./types";
export type { CapabilityExecutionPolicy, RegisterCapabilityPolicyOptions } from "./capability-policy";
export type { RegisterToolContractOptions, ToolContract, ToolContractView, ToolDefinition } from "./tool-contract-registry";
export type { SkillMetadata, SkillInstallInput } from "./skill-registry";
export type { SkillContentReader, ResolvedSkillContent, ResolveSkillContentOptions } from "./skill-content-resolver";

export interface OrchestratorOptions {
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
  retryCapDelayMs?: number;
  thresholdTokens?: number;
  keepTail?: number;
  splitTurn?: boolean;
  traceChunkSize?: number;
  verifyAdapter?: (input: ExecuteStepInput, result: unknown) => Promise<{ verified: boolean; reason?: string }>;
  skillRegistry?: SkillRegistry;
  skillContentReader?: SkillContentReader;
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
  running: boolean;
  compacting: boolean;
  paused: boolean;
  stopped: boolean;
  retry: RunState["retry"];
  queue: {
    dequeueMode: RunState["queue"]["dequeueMode"];
    steer: number;
    followUp: number;
    total: number;
    items: QueuedRuntimePrompt[];
  };
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
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

function toExecuteModeOrNull(value: unknown): ExecuteMode | null {
  const mode = String(value || "").trim();
  if (mode === "script" || mode === "cdp" || mode === "bridge") {
    return mode as ExecuteMode;
  }
  return null;
}

class HookBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookBlockError";
  }
}

// 对照点：pi-mono/packages/coding-agent/src/core/agent-session.ts:1565 _checkCompaction
export class BrainOrchestrator {
  readonly sessions = new BrowserSessionManager();
  readonly events = new BrainEventBus();
  private readonly options: {
    retryMaxAttempts: number;
    retryBaseDelayMs: number;
    retryCapDelayMs: number;
    thresholdTokens: number;
    keepTail: number;
    splitTurn: boolean;
    traceChunkSize: number;
  };
  private readonly verifyAdapter?: (input: ExecuteStepInput, result: unknown) => Promise<{ verified: boolean; reason?: string }>;
  private readonly hooks = new HookRunner<OrchestratorHookMap>();
  private readonly toolProviders = new ToolProviderRegistry();
  private readonly toolContracts = new ToolContractRegistry();
  private readonly capabilityPolicies = new CapabilityPolicyRegistry();
  private readonly llmProviders = new LlmProviderRegistry();
  private readonly skills: SkillRegistry;
  private readonly skillResolver: SkillContentResolver;
  private readonly plugins = new PluginRuntime({
    onHook: (hook, handler, options) => this.onHook(hook, handler, options),
    registerToolProvider: (mode, provider, options) => this.registerToolProvider(mode, provider, options),
    unregisterToolProvider: (mode, expectedProviderId) => this.unregisterToolProvider(mode, expectedProviderId),
    getToolProvider: (mode) => this.getToolProvider(mode),
    registerCapabilityProvider: (capability, provider, options) =>
      this.registerCapabilityProvider(capability, provider, options),
    unregisterCapabilityProvider: (capability, expectedProviderId) =>
      this.unregisterCapabilityProvider(capability, expectedProviderId),
    getCapabilityProvider: (capability) => this.getCapabilityProvider(capability),
    getCapabilityProviders: (capability) => this.getCapabilityProviders(capability),
    registerCapabilityPolicy: (capability, policy, options) =>
      this.registerCapabilityPolicy(capability, policy, options),
    unregisterCapabilityPolicy: (capability, expectedPolicyId) =>
      this.unregisterCapabilityPolicy(capability, expectedPolicyId),
    getCapabilityPolicy: (capability) => this.getCapabilityPolicy(capability),
    registerToolContract: (contract, options) => this.registerToolContract(contract, options),
    unregisterToolContract: (name) => this.unregisterToolContract(name),
    resolveToolContract: (name) => this.resolveToolContract(name),
    listToolContracts: () => this.listToolContracts(),
    registerLlmProvider: (provider, options) => this.registerLlmProvider(provider, options),
    unregisterLlmProvider: (id) => this.unregisterLlmProvider(id),
    getLlmProvider: (id) => this.getLlmProvider(id)
  });
  private readonly runStateBySession = new Map<string, RunState>();
  private readonly streamBySession = new Map<string, StepTraceRecord[]>();
  private readonly traceWriteTailBySession = new Map<string, Promise<void>>();

  private createEmptyQueueState(): RunState["queue"] {
    return {
      dequeueMode: "one-at-a-time",
      steer: [],
      followUp: []
    };
  }

  private createRunState(sessionId: string): RunState {
    return {
      sessionId,
      running: false,
      compacting: false,
      paused: false,
      stopped: false,
      retry: {
        active: false,
        attempt: 0,
        maxAttempts: this.options.retryMaxAttempts,
        delayMs: 0
      },
      queue: this.createEmptyQueueState()
    };
  }

  constructor(options: OrchestratorOptions = {}) {
    this.options = {
      retryMaxAttempts: options.retryMaxAttempts ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
      retryCapDelayMs: options.retryCapDelayMs ?? 5000,
      thresholdTokens: options.thresholdTokens ?? 1800,
      keepTail: options.keepTail ?? 30,
      splitTurn: options.splitTurn ?? true,
      traceChunkSize: toPositiveInt(options.traceChunkSize, 80)
    };
    this.verifyAdapter = options.verifyAdapter;
    this.skills = options.skillRegistry ?? new SkillRegistry();
    this.skillResolver = new SkillContentResolver(this.skills, {
      readText: options.skillContentReader
    });
    this.llmProviders.register(createOpenAiCompatibleLlmProvider(DEFAULT_LLM_PROVIDER_ID), {
      replace: true
    });

    this.events.subscribe((event) => {
      this.schedulePersistEvent(event);
    });
  }

  registerToolProvider(mode: ExecuteMode, provider: StepToolProvider, options: RegisterProviderOptions = {}): void {
    this.toolProviders.register(mode, provider, options);
  }

  unregisterToolProvider(mode: ExecuteMode, expectedProviderId?: string): boolean {
    return this.toolProviders.unregister(mode, expectedProviderId);
  }

  listToolProviders(): Array<{ mode: ExecuteMode; id: string }> {
    return this.toolProviders.list();
  }

  registerToolContract(contract: ToolContract, options: RegisterToolContractOptions = {}): void {
    this.toolContracts.register(contract, options);
  }

  unregisterToolContract(name: string): boolean {
    return this.toolContracts.unregister(name);
  }

  resolveToolContract(name: string): ToolContract | null {
    return this.toolContracts.resolve(name);
  }

  listToolContracts(): ToolContractView[] {
    return this.toolContracts.listContracts();
  }

  listLlmToolDefinitions(): ToolDefinition[] {
    return this.toolContracts.listLlmToolDefinitions();
  }

  registerLlmProvider(provider: LlmProviderAdapter, options: RegisterLlmProviderOptions = {}): void {
    this.llmProviders.register(provider, options);
  }

  unregisterLlmProvider(id: string): boolean {
    return this.llmProviders.unregister(id);
  }

  getLlmProvider(id: string): LlmProviderAdapter | undefined {
    return this.llmProviders.get(id);
  }

  listLlmProviders(): Array<{ id: string }> {
    return this.llmProviders.list();
  }

  getLlmProviderRegistry(): LlmProviderRegistry {
    return this.llmProviders;
  }

  getToolProvider(mode: ExecuteMode): StepToolProvider | undefined {
    return this.toolProviders.get(mode);
  }

  registerCapabilityProvider(
    capability: ExecuteCapability,
    provider: StepToolProvider,
    options: RegisterProviderOptions = {}
  ): void {
    this.toolProviders.registerCapability(capability, provider, options);
  }

  unregisterCapabilityProvider(capability: ExecuteCapability, expectedProviderId?: string): boolean {
    return this.toolProviders.unregisterCapability(capability, expectedProviderId);
  }

  listCapabilityProviders(): Array<{ capability: ExecuteCapability; id: string; mode?: ExecuteMode }> {
    return this.toolProviders.listCapabilities();
  }

  getCapabilityProvider(capability: ExecuteCapability): StepToolProvider | undefined {
    return this.toolProviders.getCapability(capability);
  }

  getCapabilityProviders(capability: ExecuteCapability): StepToolProvider[] {
    return this.toolProviders.getCapabilities(capability);
  }

  registerCapabilityPolicy(
    capability: ExecuteCapability,
    policy: CapabilityExecutionPolicy,
    options: RegisterCapabilityPolicyOptions = {}
  ): string {
    return this.capabilityPolicies.register(capability, policy, options);
  }

  unregisterCapabilityPolicy(capability: ExecuteCapability, expectedPolicyId?: string): boolean {
    return this.capabilityPolicies.unregister(capability, expectedPolicyId);
  }

  getCapabilityPolicy(capability: ExecuteCapability): {
    capability: ExecuteCapability;
    source: "builtin" | "override";
    id: string;
    policy: CapabilityExecutionPolicy;
  } | null {
    return this.capabilityPolicies.get(capability);
  }

  resolveCapabilityPolicy(capability?: ExecuteCapability): CapabilityExecutionPolicy {
    return this.capabilityPolicies.resolve(capability);
  }

  listCapabilityPolicies(): Array<{
    capability: ExecuteCapability;
    source: "builtin" | "override";
    id: string;
    policy: CapabilityExecutionPolicy;
  }> {
    return this.capabilityPolicies.list();
  }

  hasCapabilityProvider(capability: ExecuteCapability): boolean {
    return this.toolProviders.hasCapability(capability);
  }

  resolveModeForCapability(capability: ExecuteCapability): ExecuteMode | null {
    const provider = this.toolProviders.getCapability(capability);
    return provider?.mode || null;
  }

  registerPlugin(definition: AgentPluginDefinition, options: { enable?: boolean; replace?: boolean } = {}): void {
    this.plugins.register(definition, options);
  }

  unregisterPlugin(pluginId: string): boolean {
    return this.plugins.unregister(pluginId);
  }

  enablePlugin(pluginId: string): void {
    this.plugins.enable(pluginId);
  }

  disablePlugin(pluginId: string): void {
    this.plugins.disable(pluginId);
  }

  listPlugins(): PluginRuntimeView[] {
    return this.plugins.list();
  }

  setSkillContentReader(readText: SkillContentReader): void {
    this.skillResolver.setReader(readText);
  }

  async listSkills(): Promise<SkillMetadata[]> {
    return this.skills.list();
  }

  async getSkill(skillId: string): Promise<SkillMetadata | null> {
    return this.skills.get(skillId);
  }

  async installSkill(input: SkillInstallInput, options: { replace?: boolean } = {}): Promise<SkillMetadata> {
    return this.skills.install(input, options);
  }

  async enableSkill(skillId: string): Promise<SkillMetadata> {
    return this.skills.enable(skillId);
  }

  async disableSkill(skillId: string): Promise<SkillMetadata> {
    return this.skills.disable(skillId);
  }

  async uninstallSkill(skillId: string): Promise<boolean> {
    return this.skills.uninstall(skillId);
  }

  async resolveSkillContent(skillId: string, options: ResolveSkillContentOptions = {}): Promise<ResolvedSkillContent> {
    return this.skillResolver.resolveById(skillId, options);
  }

  onHook<K extends keyof OrchestratorHookMap & string>(
    hook: K,
    handler: HookHandler<OrchestratorHookMap[K]>,
    options: HookHandlerOptions = {}
  ): () => void {
    return this.hooks.on(hook, handler, options);
  }

  runHook<K extends keyof OrchestratorHookMap & string>(hook: K, payload: OrchestratorHookMap[K]) {
    return this.hooks.run(hook, payload);
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

  private schedulePersistEvent(event: BrainEventEnvelope): void {
    const key = String(event.sessionId || "").trim();
    const previous = this.traceWriteTailBySession.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.persistEvent(event));
    const nextTail = run.then(
      () => undefined,
      () => undefined
    );
    this.traceWriteTailBySession.set(key, nextTail);
    void run.catch(() => undefined).finally(() => {
      if (this.traceWriteTailBySession.get(key) === nextTail) {
        this.traceWriteTailBySession.delete(key);
      }
    });
  }

  async createSession(input?: Parameters<BrowserSessionManager["createSession"]>[0]): Promise<{ sessionId: string }> {
    const meta = await this.sessions.createSession(input);
    this.runStateBySession.set(meta.header.id, this.createRunState(meta.header.id));
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
      const queueItems = [...current.queue.steer, ...current.queue.followUp].sort((a, b) =>
        String(a.timestamp || "").localeCompare(String(b.timestamp || ""))
      );
        return {
          sessionId,
          running: current.running,
          compacting: current.compacting,
          paused: current.paused,
          stopped: current.stopped,
          retry: { ...current.retry },
          queue: {
            dequeueMode: current.queue.dequeueMode,
            steer: current.queue.steer.length,
            followUp: current.queue.followUp.length,
            total: current.queue.steer.length + current.queue.followUp.length,
            items: queueItems.map((item) => ({ ...item }))
          }
      };
    }
    return {
      sessionId,
      running: false,
      compacting: false,
      paused: false,
      stopped: false,
      retry: {
        active: false,
        attempt: 0,
        maxAttempts: this.options.retryMaxAttempts,
        delayMs: 0
      },
      queue: {
        dequeueMode: "one-at-a-time",
        steer: 0,
        followUp: 0,
        total: 0,
        items: []
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
    state.queue.steer = [];
    state.queue.followUp = [];
    return this.getRunState(sessionId);
  }

  restart(sessionId: string): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.stopped = false;
    state.paused = false;
    return this.getRunState(sessionId);
  }

  setRunning(sessionId: string, running: boolean): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.running = running;
    if (!running) {
      state.compacting = false;
    }
    return this.getRunState(sessionId);
  }

  setCompacting(sessionId: string, compacting: boolean): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.compacting = compacting;
    return this.getRunState(sessionId);
  }

  setQueueDequeueMode(sessionId: string, mode: QueueDequeueMode): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.queue.dequeueMode = mode;
    return this.getRunState(sessionId);
  }

  enqueueQueuedPrompt(
    sessionId: string,
    behavior: StreamingBehavior,
    text: string,
    options: { skillIds?: string[] } = {}
  ): RuntimeView {
    const normalizedText = String(text || "").trim();
    const skillIds = Array.isArray(options.skillIds)
      ? Array.from(new Set(options.skillIds.map((id) => String(id || "").trim()).filter((id) => id.length > 0)))
      : [];
    if (!normalizedText && skillIds.length === 0) return this.getRunState(sessionId);
    const state = this.ensureRunState(sessionId);
    const item: QueuedRuntimePrompt = {
      id: randomId("queued_prompt"),
      behavior,
      text: normalizedText,
      ...(skillIds.length > 0 ? { skillIds } : {}),
      timestamp: nowIso()
    };
    if (behavior === "steer") {
      state.queue.steer.push(item);
    } else {
      state.queue.followUp.push(item);
    }
    return this.getRunState(sessionId);
  }

  promoteQueuedPrompt(
    sessionId: string,
    queuedPromptId: string,
    targetBehavior: StreamingBehavior = "steer"
  ): RuntimeView {
    const state = this.ensureRunState(sessionId);
    const id = String(queuedPromptId || "").trim();
    if (!id) return this.getRunState(sessionId);

    const pickFromQueue = (queue: QueuedRuntimePrompt[]): QueuedRuntimePrompt | null => {
      const idx = queue.findIndex((item) => String(item.id || "") === id);
      if (idx < 0) return null;
      const [picked] = queue.splice(idx, 1);
      return picked || null;
    };

    const item = pickFromQueue(state.queue.followUp) || pickFromQueue(state.queue.steer);
    if (!item) return this.getRunState(sessionId);

    const nextBehavior: StreamingBehavior = targetBehavior === "followUp" ? "followUp" : "steer";
    const nextItem: QueuedRuntimePrompt = {
      ...item,
      behavior: nextBehavior,
      timestamp: nowIso()
    };

    if (nextBehavior === "steer") {
      // “直接插入”语义：优先于既有 steer 队列。
      state.queue.steer.unshift(nextItem);
    } else {
      state.queue.followUp.push(nextItem);
    }
    return this.getRunState(sessionId);
  }

  hasQueuedPrompt(sessionId: string, behavior?: StreamingBehavior): boolean {
    const state = this.ensureRunState(sessionId);
    if (behavior === "steer") return state.queue.steer.length > 0;
    if (behavior === "followUp") return state.queue.followUp.length > 0;
    return state.queue.steer.length > 0 || state.queue.followUp.length > 0;
  }

  dequeueQueuedPrompts(
    sessionId: string,
    behavior: StreamingBehavior,
    mode?: QueueDequeueMode
  ): QueuedRuntimePrompt[] {
    const state = this.ensureRunState(sessionId);
    const queue = behavior === "steer" ? state.queue.steer : state.queue.followUp;
    if (queue.length === 0) return [];
    const dequeueMode = mode || state.queue.dequeueMode;
    if (dequeueMode === "all") {
      const drained = queue.splice(0, queue.length);
      return drained.map((item) => ({ ...item }));
    }
    const first = queue.shift();
    return first ? [{ ...first }] : [];
  }

  clearQueuedPrompts(sessionId: string): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.queue.steer = [];
    state.queue.followUp = [];
    return this.getRunState(sessionId);
  }

  updateRetryState(
    sessionId: string,
    patch: Partial<Pick<RunState["retry"], "active" | "attempt" | "delayMs" | "maxAttempts">>
  ): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.retry = {
      ...state.retry,
      ...patch
    };
    return this.getRunState(sessionId);
  }

  resetRetryState(sessionId: string): RuntimeView {
    const state = this.ensureRunState(sessionId);
    state.retry = {
      active: false,
      attempt: 0,
      maxAttempts: this.options.retryMaxAttempts,
      delayMs: 0
    };
    return this.getRunState(sessionId);
  }

  private ensureRunState(sessionId: string): RunState {
    const cached = this.runStateBySession.get(sessionId);
    if (cached) return cached;
    const created: RunState = this.createRunState(sessionId);
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

  private async invokeProviderWithHooks(
    mode: ExecuteMode,
    input: ExecuteStepInput
  ): Promise<{ modeUsed: ExecuteMode; inputUsed: ExecuteStepInput; data: unknown; capabilityUsed?: ExecuteCapability }> {
    const beforeTool = await this.hooks.run("tool.before_call", { mode, capability: input.capability, input });
    if (beforeTool.blocked) {
      throw new HookBlockError(`tool.before_call blocked: ${beforeTool.reason || "blocked"}`);
    }

    const invokeMode = beforeTool.value.mode;
    const invokeInput = beforeTool.value.input;
    const rawInvoke = await this.toolProviders.invoke(invokeMode, invokeInput);

    const afterTool = await this.hooks.run("tool.after_result", {
      mode: rawInvoke.modeUsed,
      capability: rawInvoke.capabilityUsed,
      input: invokeInput,
      result: rawInvoke.data
    });
    if (afterTool.blocked) {
      throw new HookBlockError(`tool.after_result blocked: ${afterTool.reason || "blocked"}`);
    }

    return {
      modeUsed: afterTool.value.mode,
      capabilityUsed: afterTool.value.capability,
      inputUsed: afterTool.value.input,
      data: afterTool.value.result
    };
  }

  private async applyAfterExecuteHook(input: ExecuteStepInput, result: ExecuteStepResult): Promise<ExecuteStepResult> {
    const afterStep = await this.hooks.run("step.after_execute", { input, result });
    if (afterStep.blocked) {
      return {
        ...result,
        ok: false,
        error: `step.after_execute blocked: ${afterStep.reason || "blocked"}`
      };
    }
    return afterStep.value.result;
  }

  // 对照点：执行策略 PR-6 script 优先，失败降级 cdp
  async executeStep(input: ExecuteStepInput): Promise<ExecuteStepResult> {
    const beforeStep = await this.hooks.run("step.before_execute", { input });
    if (beforeStep.blocked) {
      return {
        ok: false,
        modeUsed: input.mode || "bridge",
        verified: false,
        error: `step.before_execute blocked: ${beforeStep.reason || "blocked"}`
      };
    }

    const nextInput = beforeStep.value.input;
    const initialMode = this.toolProviders.resolveMode(nextInput);
    if (!initialMode) {
      return this.applyAfterExecuteHook(nextInput, {
        ok: false,
        modeUsed: nextInput.mode || "bridge",
        verified: false,
        error: nextInput.capability
          ? `未找到 capability provider: ${nextInput.capability}`
          : "mode 必须是 script/cdp/bridge"
      });
    }

    let modeUsed: ExecuteMode = initialMode;
    let verifyInput: ExecuteStepInput = nextInput;
    let capabilityUsed: ExecuteCapability | undefined;
    let fallbackFrom: ExecuteMode | undefined;
    let data: unknown;

    try {
      const invoked = await this.invokeProviderWithHooks(initialMode, nextInput);
      modeUsed = invoked.modeUsed;
      if (modeUsed !== initialMode) {
        fallbackFrom = initialMode;
      }
      verifyInput = invoked.inputUsed;
      capabilityUsed = invoked.capabilityUsed;
      data = invoked.data;
    } catch (error) {
      if (error instanceof HookBlockError) {
        return this.applyAfterExecuteHook(nextInput, {
          ok: false,
          modeUsed,
          fallbackFrom,
          error: error.message,
          verified: false
        });
      }

      const err = error as Error & {
        code?: unknown;
        details?: unknown;
        retryable?: unknown;
        modeUsed?: unknown;
        capabilityUsed?: unknown;
      };
      const modeFromError = toExecuteModeOrNull(err.modeUsed);
      if (modeFromError) {
        modeUsed = modeFromError;
      }
      if (!fallbackFrom && modeUsed !== initialMode) {
        fallbackFrom = initialMode;
      }
      const capabilityFromError = typeof err.capabilityUsed === "string" ? err.capabilityUsed.trim() : "";
      if (capabilityFromError) {
        capabilityUsed = capabilityFromError;
      }

      return this.applyAfterExecuteHook(nextInput, {
        ok: false,
        modeUsed,
        capabilityUsed,
        fallbackFrom,
        error: error instanceof Error ? error.message : String(error),
        errorCode: typeof err.code === "string" && err.code.trim() ? err.code.trim() : undefined,
        errorDetails: err.details,
        retryable: typeof err.retryable === "boolean" ? err.retryable : undefined,
        verified: false
      });
    }

    let verified = false;
    let verifyReason = "verify_skipped";
    if (this.shouldVerify(verifyInput) && this.verifyAdapter) {
      const verifyResult = await this.verifyAdapter({ ...verifyInput, mode: modeUsed }, data);
      verified = verifyResult.verified;
      verifyReason = verifyResult.reason || (verified ? "verified" : "verify_failed");
    } else if (!this.shouldVerify(verifyInput)) {
      verifyReason = "verify_policy_off";
    } else {
      verifyReason = "verify_adapter_missing";
    }

    return this.applyAfterExecuteHook(nextInput, {
      ok: true,
      modeUsed,
      capabilityUsed,
      fallbackFrom,
      verified,
      verifyReason,
      data
    });
  }

  // 对照点：pi-mono/packages/coding-agent/src/core/agent-session.ts:1591 overflow/threshold 分支
  async preSendCompactionCheck(sessionId: string): Promise<boolean> {
    const beforeCheck = await this.hooks.run("compaction.check.before", {
      sessionId,
      source: "pre_send"
    });
    if (beforeCheck.blocked) return false;

    const context = await this.sessions.buildSessionContext(sessionId);
    const decision = shouldCompact({
      overflow: false,
      entries: context.entries,
      previousSummary: context.previousSummary,
      thresholdTokens: this.options.thresholdTokens
    });

    const afterCheck = await this.hooks.run("compaction.check.after", {
      sessionId,
      source: "pre_send",
      shouldCompact: decision.shouldCompact,
      reason: decision.reason ?? undefined
    });
    if (afterCheck.blocked) return false;
    const finalCheck = afterCheck.value;

    if (!finalCheck.shouldCompact || finalCheck.reason !== "threshold") return false;
    await this.runCompaction(sessionId, "threshold", false);
    return true;
  }

  // 对照点：pi-mono/packages/coding-agent/src/core/agent-session.ts:2083 retry 判定优先于 compaction
  async handleAgentEnd(input: AgentEndInput): Promise<AgentEndDecision> {
    const beforeHook = await this.hooks.run("agent_end.before", {
      input,
      state: this.getRunState(input.sessionId)
    });
    if (beforeHook.blocked) {
      return {
        action: "done",
        reason: `agent_end_blocked:${beforeHook.reason || "blocked"}`,
        sessionId: input.sessionId
      };
    }

    const nextInput = beforeHook.value.input;
    const sessionId = nextInput.sessionId;
    const state = this.ensureRunState(sessionId);

    if (state.stopped) {
      const decision: AgentEndDecision = { action: "done", reason: "stopped", sessionId };
      const afterHook = await this.hooks.run("agent_end.after", { input: nextInput, decision });
      return afterHook.blocked ? decision : afterHook.value.decision;
    }

    const retryable = isRetryableError(nextInput.error) && !nextInput.overflow;
    if (retryable) {
      if (state.retry.attempt < state.retry.maxAttempts) {
        state.retry.attempt += 1;
        state.retry.active = true;
        state.retry.delayMs = backoffDelay(state.retry.attempt, this.options.retryBaseDelayMs, this.options.retryCapDelayMs);
        this.events.emit("auto_retry_start", sessionId, {
          attempt: state.retry.attempt,
          maxAttempts: state.retry.maxAttempts,
          delayMs: state.retry.delayMs,
          reason: nextInput.error?.message || "retryable-error"
        });
        const decision: AgentEndDecision = {
          action: "retry",
          reason: "retryable_error",
          delayMs: state.retry.delayMs,
          sessionId
        };
        const afterHook = await this.hooks.run("agent_end.after", { input: nextInput, decision });
        return afterHook.blocked ? decision : afterHook.value.decision;
      }

      this.events.emit("auto_retry_end", sessionId, {
        success: false,
        attempt: state.retry.attempt,
        maxAttempts: state.retry.maxAttempts,
        finalError: nextInput.error?.message || "retry-limit"
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

    const beforeCheck = await this.hooks.run("compaction.check.before", {
      sessionId,
      source: "agent_end"
    });
    if (beforeCheck.blocked) {
      const decision: AgentEndDecision = {
        action: "done",
        reason: "compaction_check_blocked",
        sessionId
      };
      const afterHook = await this.hooks.run("agent_end.after", { input: nextInput, decision });
      return afterHook.blocked ? decision : afterHook.value.decision;
    }

    const context = await this.sessions.buildSessionContext(sessionId);
    const compactDecision = shouldCompact({
      overflow: Boolean(nextInput.overflow),
      entries: context.entries,
      previousSummary: context.previousSummary,
      thresholdTokens: this.options.thresholdTokens
    });

    const afterCheck = await this.hooks.run("compaction.check.after", {
      sessionId,
      source: "agent_end",
      shouldCompact: compactDecision.shouldCompact,
      reason: compactDecision.reason ?? undefined
    });
    if (afterCheck.blocked) {
      const decision: AgentEndDecision = {
        action: "done",
        reason: "compaction_check_blocked",
        sessionId
      };
      const afterHook = await this.hooks.run("agent_end.after", { input: nextInput, decision });
      return afterHook.blocked ? decision : afterHook.value.decision;
    }
    const finalCompact = afterCheck.value;

    if (finalCompact.shouldCompact && finalCompact.reason) {
      const willRetry = finalCompact.reason === "overflow";
      await this.runCompaction(sessionId, finalCompact.reason, willRetry);
      const decision: AgentEndDecision = {
        action: "continue",
        reason: `compaction_${finalCompact.reason}`,
        sessionId
      };
      const afterHook = await this.hooks.run("agent_end.after", { input: nextInput, decision });
      return afterHook.blocked ? decision : afterHook.value.decision;
    }

    const decision: AgentEndDecision = {
      action: "done",
      reason: nextInput.error ? "error" : "completed",
      sessionId
    };
    const afterHook = await this.hooks.run("agent_end.after", { input: nextInput, decision });
    return afterHook.blocked ? decision : afterHook.value.decision;
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
    const beforeHook = await this.hooks.run("compaction.before", {
      sessionId,
      reason,
      willRetry
    });
    if (beforeHook.blocked) return;
    const nextReason = beforeHook.value.reason;
    const nextWillRetry = beforeHook.value.willRetry;
    this.setCompacting(sessionId, true);

    this.events.emit("auto_compaction_start", sessionId, {
      reason: nextReason,
      willRetry: nextWillRetry
    });

    try {
      const context = await this.sessions.buildSessionContext(sessionId);
      const preparation = prepareCompaction({
        reason: nextReason,
        entries: context.entries,
        previousSummary: context.previousSummary,
        keepTail: this.options.keepTail,
        splitTurn: this.options.splitTurn
      });
      const draft = await compact(preparation, async (summaryRequest) => {
        const summaryHook = await this.hooks.run("compaction.summary", {
          sessionId,
          reason: nextReason,
          mode: summaryRequest.mode,
          promptText: summaryRequest.promptText,
          maxTokens: summaryRequest.maxTokens,
          summary: ""
        });
        if (summaryHook.blocked) {
          throw new Error(`compaction.summary blocked: ${summaryHook.reason || "blocked"}`);
        }
        const summary = String(summaryHook.value.summary || "").trim();
        if (!summary) {
          throw new Error("compaction.summary 返回为空");
        }
        return summary;
      });
      const compactionEntry = await this.sessions.appendCompaction(sessionId, nextReason, draft, {
        source: "browser-orchestrator",
        generatedAt: nowIso()
      });

      this.events.emit("session_compact", sessionId, {
        reason: nextReason,
        willRetry: nextWillRetry,
        entryId: compactionEntry.id,
        firstKeptEntryId: draft.firstKeptEntryId,
        tokensBefore: draft.tokensBefore,
        tokensAfter: draft.tokensAfter
      });

      this.events.emit("auto_compaction_end", sessionId, {
        reason: nextReason,
        success: true,
        willRetry: nextWillRetry,
        firstKeptEntryId: draft.firstKeptEntryId,
        tokensBefore: draft.tokensBefore,
        tokensAfter: draft.tokensAfter
      });
      await this.hooks.run("compaction.after", {
        sessionId,
        reason: nextReason,
        willRetry: nextWillRetry
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.events.emit("auto_compaction_end", sessionId, {
        reason: nextReason,
        success: false,
        willRetry: nextWillRetry,
        errorMessage
      });
      await this.hooks.run("compaction.error", {
        sessionId,
        reason: nextReason,
        willRetry: nextWillRetry,
        errorMessage
      });
      throw error;
    } finally {
      this.setCompacting(sessionId, false);
    }
  }
}
