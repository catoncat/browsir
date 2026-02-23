import { archiveLegacyState, initSessionIndex, resetSessionStore } from "./storage-reset.browser";
import { BrainOrchestrator } from "./orchestrator.browser";

interface RuntimeOk<T = unknown> {
  ok: true;
  data: T;
}

interface RuntimeErr {
  ok: false;
  error: string;
}

type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

function ok<T>(data: T): RuntimeResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): RuntimeResult {
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

function requireSessionId(message: any): string {
  const sessionId = String(message?.sessionId || "").trim();
  if (!sessionId) throw new Error("sessionId 不能为空");
  return sessionId;
}

async function handleBrainRun(orchestrator: BrainOrchestrator, message: any): Promise<RuntimeResult> {
  const action = String(message?.type || "");
  if (action === "brain.run.start") {
    let sessionId = typeof message?.sessionId === "string" ? message.sessionId : "";
    if (!sessionId) {
      const created = await orchestrator.createSession(message?.sessionOptions ?? {});
      sessionId = created.sessionId;
    }

    if (typeof message?.prompt === "string" && message.prompt.trim()) {
      await orchestrator.appendUserMessage(sessionId, message.prompt.trim());
      await orchestrator.preSendCompactionCheck(sessionId);
    }

    return ok({
      sessionId,
      runtime: orchestrator.getRunState(sessionId)
    });
  }

  if (action === "brain.run.pause") {
    return ok(orchestrator.pause(requireSessionId(message)));
  }

  if (action === "brain.run.resume") {
    return ok(orchestrator.resume(requireSessionId(message)));
  }

  if (action === "brain.run.stop") {
    return ok(orchestrator.stop(requireSessionId(message)));
  }

  return fail(`unsupported brain.run action: ${action}`);
}

async function handleSession(orchestrator: BrainOrchestrator, message: any): Promise<RuntimeResult> {
  const action = String(message?.type || "");

  if (action === "brain.session.list") {
    return ok(await orchestrator.sessions.listSessions());
  }

  if (action === "brain.session.get") {
    const sessionId = requireSessionId(message);
    const meta = await orchestrator.sessions.getMeta(sessionId);
    const entries = await orchestrator.sessions.getEntries(sessionId);
    return ok({ meta, entries });
  }

  if (action === "brain.session.view") {
    const sessionId = requireSessionId(message);
    const context = await orchestrator.sessions.buildSessionContext(sessionId, message?.leafId ?? undefined);
    return ok({
      conversationView: {
        sessionId,
        messageCount: context.messages.length,
        messages: context.messages,
        lastStatus: orchestrator.getRunState(sessionId),
        updatedAt: new Date().toISOString()
      }
    });
  }

  return fail(`unsupported brain.session action: ${action}`);
}

async function handleStep(orchestrator: BrainOrchestrator, message: any): Promise<RuntimeResult> {
  const type = String(message?.type || "");
  if (type === "brain.step.stream") {
    const sessionId = requireSessionId(message);
    const stream = await orchestrator.getStepStream(sessionId);
    return ok({ sessionId, stream });
  }

  if (type === "brain.step.execute") {
    const sessionId = requireSessionId(message);
    const mode = String(message?.mode || "").trim() as "script" | "cdp" | "bridge";
    const action = String(message?.action || "").trim();
    if (!mode || !["script", "cdp", "bridge"].includes(mode)) return fail("mode 必须是 script/cdp/bridge");
    if (!action) return fail("action 不能为空");
    return ok(
      await orchestrator.executeStep({
        sessionId,
        mode,
        action,
        args: message?.args ?? {},
        verifyPolicy: message?.verifyPolicy
      })
    );
  }

  return fail(`unsupported step action: ${type}`);
}

async function handleStorage(message: any): Promise<RuntimeResult> {
  const action = String(message?.type || "");
  if (action === "brain.storage.archive") {
    return ok(await archiveLegacyState(message?.options ?? {}));
  }
  if (action === "brain.storage.reset") {
    return ok(await resetSessionStore(message?.options ?? { archiveLegacyBeforeReset: true }));
  }
  if (action === "brain.storage.init") {
    return ok(await initSessionIndex());
  }
  return fail(`unsupported storage action: ${action}`);
}

export function registerRuntimeRouter(orchestrator: BrainOrchestrator): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = String(message?.type || "");

    const run = async () => {
      try {
        if (type === "ping") {
          return ok({ source: "service-worker", version: "vnext" });
        }

        if (type.startsWith("brain.run.")) {
          return await handleBrainRun(orchestrator, message);
        }

        if (type.startsWith("brain.session.")) {
          return await handleSession(orchestrator, message);
        }

        if (type.startsWith("brain.step.")) {
          return await handleStep(orchestrator, message);
        }

        if (type.startsWith("brain.storage.")) {
          return await handleStorage(message);
        }

        if (type === "brain.agent.end") {
          return ok(await orchestrator.handleAgentEnd(message?.payload ?? {}));
        }

        return fail(`unsupported runtime message: ${type}`);
      } catch (error) {
        return fail(error);
      }
    };

    void run().then((result) => sendResponse(result));
    return true;
  });
}
