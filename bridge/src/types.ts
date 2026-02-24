export type ToolName = string;

export interface InvokeRequest {
  id: string;
  type: "invoke";
  tool: ToolName;
  canonicalTool: string;
  args: Record<string, unknown>;
  sessionId?: string;
  parentSessionId?: string;
  agentId?: string;
}

export interface InvokeSuccess {
  id: string;
  ok: true;
  data: Record<string, unknown>;
  sessionId?: string;
  agentId?: string;
}

export interface InvokeFailure {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  sessionId?: string;
  agentId?: string;
}

export interface EventFrame {
  type: "event";
  event:
    | "invoke.started"
    | "invoke.stdout"
    | "invoke.stderr"
    | "invoke.finished"
    | "loop.step"
    | "loop.halt";
  id?: string;
  ts: string;
  sessionId?: string;
  parentSessionId?: string;
  agentId?: string;
  data?: Record<string, unknown>;
}

export type ServerFrame = InvokeSuccess | InvokeFailure | EventFrame;

export interface BridgeContext {
  sessionId: string;
  origin?: string;
  clientAddress?: string;
}

export interface BashStreamChunk {
  stream: "stdout" | "stderr";
  chunk: string;
}
