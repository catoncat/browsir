import type { BrainOrchestrator } from "../orchestrator.browser";
import type { RuntimeLoopController } from "../runtime-loop.browser";
import { clampStepStream } from "./step-stream-utils";

type RuntimeOk<T = unknown> = { ok: true; data: T };
type RuntimeErr = { ok: false; error: string };
type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

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

function requireSessionId(message: unknown): string {
  const payload = toRecord(message);
  const sessionId = String(payload.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId 不能为空");
  return sessionId;
}

export async function handleStep(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const type = String(payload.type || "");
  if (type === "brain.step.stream") {
    const sessionId = requireSessionId(payload);
    const stream = await orchestrator.getStepStream(sessionId);
    const limited = clampStepStream(stream, {
      maxEvents: payload.maxEvents,
      maxBytes: payload.maxBytes,
    });
    return ok({ sessionId, stream: limited.stream, streamMeta: limited.meta });
  }

  if (type === "brain.step.execute") {
    const sessionId = requireSessionId(payload);
    const modeRaw = String(payload.mode || "").trim();
    const mode = ["script", "cdp", "bridge"].includes(modeRaw)
      ? (modeRaw as "script" | "cdp" | "bridge")
      : undefined;
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
        verifyPolicy: payload.verifyPolicy as
          | "off"
          | "on_critical"
          | "always"
          | undefined,
      }),
    );
  }

  return fail(`unsupported step action: ${type}`);
}
