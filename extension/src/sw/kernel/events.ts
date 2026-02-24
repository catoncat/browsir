import { nowIso } from "./types";

export type BrainEventType =
  | "input.user"
  | "input.shared_tabs"
  | "auto_retry_start"
  | "auto_retry_end"
  | "auto_compaction_start"
  | "auto_compaction_end"
  | "session_compact"
  | "input.regenerate"
  | "session_title_manual_refresh"
  | "session_title_auto_updated"
  | "session_title_auto_update_failed"
  | "llm.skipped"
  | "llm.request"
  | "llm.stream.start"
  | "llm.stream.delta"
  | "llm.stream.end"
  | "llm.response.raw"
  | "llm.response.parsed"
  | "loop_start"
  | "loop_error"
  | "loop_done"
  | "loop_skip_stopped"
  | "loop_internal_error"
  | "loop_restart"
  | "loop_enqueue_skipped"
  | "step_planned"
  | "step_finished"
  | "step_execute"
  | "step_execute_result";

export interface BrainEventEnvelope<TType extends BrainEventType = BrainEventType> {
  type: TType;
  sessionId: string;
  ts: string;
  payload: Record<string, unknown>;
}

export type BrainEventListener = (event: BrainEventEnvelope) => void;

export class BrainEventBus {
  private listeners = new Set<BrainEventListener>();

  subscribe(listener: BrainEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit<TType extends BrainEventType>(
    type: TType,
    sessionId: string,
    payload: Record<string, unknown>
  ): BrainEventEnvelope<TType> {
    const event: BrainEventEnvelope<TType> = {
      type,
      sessionId,
      ts: nowIso(),
      payload
    };
    for (const listener of this.listeners) {
      listener(event as BrainEventEnvelope);
    }
    return event;
  }
}
