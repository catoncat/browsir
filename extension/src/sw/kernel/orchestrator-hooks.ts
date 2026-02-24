import type { ExecuteCapability, ExecuteMode, ExecuteStepInput, ExecuteStepResult } from "./types";
import type { AgentEndDecision, AgentEndInput, RuntimeView } from "./orchestrator.browser";

export interface OrchestratorHookMap {
  "runtime.route.before": {
    type: string;
    message: unknown;
  };
  "runtime.route.after": {
    type: string;
    message: unknown;
    result: unknown;
  };
  "runtime.route.error": {
    type: string;
    message: unknown;
    error: string;
  };
  "step.before_execute": {
    input: ExecuteStepInput;
  };
  "step.after_execute": {
    input: ExecuteStepInput;
    result: ExecuteStepResult;
  };
  "tool.before_call": {
    mode: ExecuteMode;
    capability?: ExecuteCapability;
    input: ExecuteStepInput;
  };
  "tool.after_result": {
    mode: ExecuteMode;
    capability?: ExecuteCapability;
    input: ExecuteStepInput;
    result: unknown;
  };
  "llm.before_request": {
    request: Record<string, unknown>;
  };
  "llm.after_response": {
    request: Record<string, unknown>;
    response: unknown;
  };
  "agent_end.before": {
    input: AgentEndInput;
    state: RuntimeView;
  };
  "agent_end.after": {
    input: AgentEndInput;
    decision: AgentEndDecision;
  };
  "compaction.check.before": {
    sessionId: string;
    source: "pre_send" | "agent_end";
  };
  "compaction.check.after": {
    sessionId: string;
    source: "pre_send" | "agent_end";
    shouldCompact: boolean;
    reason?: "overflow" | "threshold";
  };
  "compaction.before": {
    sessionId: string;
    reason: "overflow" | "threshold";
    willRetry: boolean;
  };
  "compaction.after": {
    sessionId: string;
    reason: "overflow" | "threshold";
    willRetry: boolean;
  };
  "compaction.error": {
    sessionId: string;
    reason: "overflow" | "threshold";
    willRetry: boolean;
    errorMessage: string;
  };
}
