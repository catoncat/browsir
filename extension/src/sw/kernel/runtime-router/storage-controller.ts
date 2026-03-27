import { initSessionIndex, resetSessionStore } from "../storage-reset.browser";
import type { BrainOrchestrator } from "../orchestrator.browser";
import type { RuntimeInfraHandler } from "../runtime-infra.browser";
import {
  exportExtensionDataBackup,
  importExtensionDataBackup,
} from "./storage-backup";

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

export async function handleStorage(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  if (action === "brain.storage.reset") {
    const result = await resetSessionStore(toRecord(payload.options));
    await orchestrator.resetRuntimeState();
    return ok(result);
  }
  if (action === "brain.storage.init") {
    return ok(await initSessionIndex());
  }
  if (action === "brain.storage.backup.export") {
    return ok(
      await exportExtensionDataBackup(orchestrator, infra, payload.sessionId),
    );
  }
  if (action === "brain.storage.backup.import") {
    return ok(
      await importExtensionDataBackup(
        orchestrator,
        infra,
        payload.backup,
        payload.sessionId,
      ),
    );
  }
  return fail(`unsupported storage action: ${action}`);
}
