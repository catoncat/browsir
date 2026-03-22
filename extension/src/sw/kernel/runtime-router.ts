import { BrainOrchestrator } from "./orchestrator.browser";
import {
  createRuntimeInfraHandler,
  type RuntimeInfraResult,
} from "./runtime-infra.browser";
import {
  createRuntimeLoopController,
} from "./runtime-loop.browser";
import {
  hasPluginExtensionEntry,
  materializeExtensionFactoryPluginSource,
  materializeInlinePluginSources,
  normalizePluginManifest,
  persistExtensionPluginRegistration,
} from "./plugin-materializer";
import { handleBrainAgentRun } from "./runtime-router/agent-run-controller";
import { handleBrainDebug } from "./runtime-router/debug-controller";
import { handleBrainMcp } from "./runtime-router/mcp-controller";
import { ensureBuiltinSkills } from "./builtin-skills";
import {
  handleBrainPlugin,
  rehydratePersistedPlugins,
  type PluginControllerDeps,
} from "./runtime-router/plugin-controller";
import {
  PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
  cleanupPluginVirtualArtifacts,
  emitPluginHookTrace as emitPluginHookTraceBridge,
  emitPluginRuntimeMessage as emitPluginRuntimeMessageBridge,
  invokePluginSandboxRunner,
  loadExtensionFactoryFromVirtualModule,
  previewJsonText,
  readVirtualJsonObject,
} from "./runtime-router/plugin-sandbox";
import {
  recordPluginHookTraceDebugEvent,
  recordPluginRuntimeMessageDebugEvent,
  recordRuntimeRouteDebugEvent,
} from "./runtime-router/runtime-debug-store";
import { handleBrainRun } from "./runtime-router/run-controller";
import { handleBrainSkill } from "./runtime-router/skill-controller";
import { handleSession } from "./runtime-router/session-controller";
import { handleStep } from "./runtime-router/step-controller";
import { handleStorage } from "./runtime-router/storage-controller";
import { handleBrainChannelWechat } from "./runtime-router/wechat-controller";
import { handleWebChatRuntimeMessage } from "./web-chat-executor.browser";

interface RuntimeOk<T = unknown> {
  ok: true;
  data: T;
}

interface RuntimeErr {
  ok: false;
  error: string;
}

type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

const BUILTIN_PLUGIN_ID_PREFIX = "runtime.builtin.plugin.";

function ok<T>(data: T): RuntimeResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): RuntimeResult {
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function fromInfraResult(result: RuntimeInfraResult): RuntimeResult {
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error || "infra error" };
}

function emitPluginRuntimeMessage(message: unknown): void {
  recordPluginRuntimeMessageDebugEvent(message);
  emitPluginRuntimeMessageBridge(message);
}

function emitPluginHookTrace(payload: Record<string, unknown>): void {
  recordPluginHookTraceDebugEvent(payload);
  emitPluginHookTraceBridge(payload);
}

const pluginControllerDeps: PluginControllerDeps = {
  builtinPluginIdPrefix: BUILTIN_PLUGIN_ID_PREFIX,
  pluginSandboxDefaultSessionId: PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
  cleanupPluginVirtualArtifacts,
  emitPluginHookTrace,
  emitPluginRuntimeMessage,
  hasPluginExtensionEntry,
  invokePluginSandboxRunner,
  loadExtensionFactoryFromVirtualModule,
  materializeExtensionFactoryPluginSource,
  materializeInlinePluginSources,
  normalizePluginManifest,
  persistExtensionPluginRegistration,
  previewJsonText,
  readVirtualJsonObject,
};

export function registerRuntimeRouter(orchestrator: BrainOrchestrator): void {
  const infra = createRuntimeInfraHandler();
  const runtimeLoop = createRuntimeLoopController(orchestrator, infra);
  let runtimeReady: Promise<void> | null = null;
  const ensureRuntimeReady = (): Promise<void> => {
    if (!runtimeReady) {
      runtimeReady = (async () => {
        try {
          await rehydratePersistedPlugins(orchestrator, pluginControllerDeps);
          await ensureBuiltinSkills(orchestrator);
        } catch (error) {
          console.warn("[runtime-router] runtime rehydrate failed", error);
        }
      })();
    }
    return runtimeReady;
  };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const run = async () => {
      await ensureRuntimeReady();
      const routeBefore = await orchestrator.runHook("runtime.route.before", {
        type: String(message?.type || ""),
        message,
      });
      if (routeBefore.blocked) {
        return fail(
          `runtime.route.before blocked: ${routeBefore.reason || "blocked"}`,
        );
      }
      const routeInput = routeBefore.value;
      const type = String(routeInput.type || "");
      const routeMessage = routeInput.message as unknown;
      const applyAfter = async (
        result: RuntimeResult,
      ): Promise<RuntimeResult> => {
        const afterHook = await orchestrator.runHook("runtime.route.after", {
          type,
          message: routeMessage,
          result,
        });
        return afterHook.blocked
          ? result
          : (afterHook.value.result as RuntimeResult);
      };

      const runInstrumented = async (
        run: () => Promise<RuntimeResult>,
      ): Promise<RuntimeResult> => {
        const startedAt = Date.now();
        const result = await run();
        if (type.startsWith("brain.")) {
          const messageRow = toRecord(routeMessage);
          const resultData = result.ok ? toRecord(result.data) : {};
          const sessionId = String(
            messageRow.sessionId || messageRow.parentSessionId || "",
          ).trim();
          const pluginId = String(
            resultData.pluginId || messageRow.pluginId || "",
          ).trim();
          const skillId = String(
            resultData.skillId || messageRow.skillId || "",
          ).trim();
          const summary = result.ok
            ? previewJsonText(
                resultData.reason ||
                  resultData.status ||
                  resultData.location ||
                  resultData.removedPath ||
                  resultData.error ||
                  "",
                180,
              )
            : "";
          recordRuntimeRouteDebugEvent({
            ts: new Date().toISOString(),
            type,
            ok: result.ok === true,
            durationMs: Date.now() - startedAt,
            sessionId: sessionId || undefined,
            pluginId: pluginId || undefined,
            skillId: skillId || undefined,
            error: result.ok ? "" : String(result.error || ""),
            summary: summary || undefined,
          });
        }
        return result;
      };

      try {
        // 基础设施消息不走 applyAfter → runtime.route.after hook 链路：
        // - bbloop.*: plugin trace / UI mascot / global notice，仅面板侧消费
        // - sandbox-*: eval-bridge sandbox 执行，通过 sendMessage 中继到 sandbox relay
        // 否则沙箱插件的 emitPluginHookTrace / sandboxBash 会自回环触发死循环。
        if (type.startsWith("bbloop.") || type.startsWith("sandbox-")) {
          return ok({ passthrough: true });
        }

        if (type === "ping") {
          return await applyAfter(
            ok({ source: "service-worker", version: "vnext" }),
          );
        }

        const infraResult = await infra.handleMessage(routeMessage);
        if (infraResult) return await applyAfter(fromInfraResult(infraResult));

        if (type.startsWith("brain.run.")) {
          return await applyAfter(
            await handleBrainRun(
              orchestrator,
              runtimeLoop,
              infra,
              routeMessage,
            ),
          );
        }

        if (type.startsWith("brain.session.")) {
          return await applyAfter(
            await handleSession(orchestrator, runtimeLoop, routeMessage),
          );
        }

        if (type.startsWith("brain.step.")) {
          return await applyAfter(
            await handleStep(orchestrator, runtimeLoop, routeMessage),
          );
        }

        if (type.startsWith("brain.storage.")) {
          return await applyAfter(await handleStorage(orchestrator, routeMessage));
        }

        if (type.startsWith("brain.channel.wechat.")) {
          return await applyAfter(
            await handleBrainChannelWechat(
              orchestrator,
              runtimeLoop,
              routeMessage,
            ),
          );
        }

        if (type.startsWith("brain.mcp.")) {
          return await applyAfter(
            await runInstrumented(() =>
              handleBrainMcp(orchestrator, infra, routeMessage),
            ),
          );
        }

        if (type.startsWith("brain.skill.")) {
          return await applyAfter(
            await runInstrumented(() =>
              handleBrainSkill(orchestrator, runtimeLoop, routeMessage),
            ),
          );
        }

        if (type.startsWith("brain.plugin.")) {
          return await applyAfter(
            await runInstrumented(() =>
              handleBrainPlugin(
                orchestrator,
                routeMessage,
                pluginControllerDeps,
              ),
            ),
          );
        }

        if (type.startsWith("brain.debug.")) {
          return await applyAfter(
            await runInstrumented(() =>
              handleBrainDebug(
                orchestrator,
                runtimeLoop,
                infra,
                routeMessage,
              ),
            ),
          );
        }

        if (type === "webchat.transport") {
          const senderTabId = Number((_sender?.tab?.id ?? 0) || 0);
          const handled = await handleWebChatRuntimeMessage(
            routeMessage,
            Number.isInteger(senderTabId) && senderTabId > 0
              ? senderTabId
              : undefined,
          );
          return await applyAfter(
            handled
              ? ok({ handled: true })
              : fail(`Unknown message type: ${type}`),
          );
        }

        if (type === "brain.agent.run") {
          return await applyAfter(
            await handleBrainAgentRun(orchestrator, runtimeLoop, routeMessage),
          );
        }

        if (type === "brain.agent.end") {
          const payload = toRecord(toRecord(routeMessage).payload);
          const sessionId = String(payload.sessionId || "").trim();
          if (!sessionId) return fail("brain.agent.end 需要 payload.sessionId");

          const rawError = toRecord(payload.error);
          const statusNumber = Number(rawError.status);
          const error =
            Object.keys(rawError).length === 0
              ? null
              : {
                  message:
                    typeof rawError.message === "string"
                      ? rawError.message
                      : undefined,
                  code:
                    typeof rawError.code === "string"
                      ? rawError.code
                      : undefined,
                  status: Number.isFinite(statusNumber)
                    ? statusNumber
                    : undefined,
                };
          const failureReasonRaw = String(payload.failureReason || "").trim();
          const terminalStatusRaw = String(payload.status || "").trim();

          return await applyAfter(
            ok(
              await orchestrator.handleAgentEnd({
                sessionId,
                error,
                overflow: payload.overflow === true,
                failureReason: failureReasonRaw
                  ? (failureReasonRaw as "failed_execute" | "failed_verify" | "progress_uncertain")
                  : null,
                status: terminalStatusRaw
                  ? (terminalStatusRaw as
                      | "done"
                      | "failed_execute"
                      | "failed_verify"
                      | "progress_uncertain"
                      | "max_steps"
                      | "stopped"
                      | "timeout")
                  : undefined,
              }),
            ),
          );
        }

        return await applyAfter(fail(`Unknown message type: ${type}`));
      } catch (error) {
        await orchestrator.runHook("runtime.route.error", {
          type,
          message: routeMessage,
          error: error instanceof Error ? error.message : String(error),
        });
        return await applyAfter(fail(error));
      }
    };

    void run().then((result) => sendResponse(result));
    return true;
  });
}
