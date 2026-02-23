import { nowIso } from "./types";

export type BrainEventType =
  | "auto_retry_start"
  | "auto_retry_end"
  | "auto_compaction_start"
  | "auto_compaction_end"
  | "session_compact";

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
