import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";
import { registerRuntimeRouter } from "../runtime-router";

type RuntimeListener = (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => boolean | void;

let runtimeListeners: RuntimeListener[] = [];

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

interface TestLlmProfileInput {
  id: string;
  role?: string;
  provider?: string;
  llmApiBase?: string;
  llmApiKey?: string;
  llmModel?: string;
}

function createTestLlmProfile(input: TestLlmProfileInput): Record<string, unknown> {
  return {
    id: input.id,
    provider: input.provider || "openai_compatible",
    llmApiBase: input.llmApiBase || "https://example.ai/v1",
    llmApiKey: input.llmApiKey ?? "sk-demo",
    llmModel: input.llmModel || "gpt-test",
    role: input.role || "worker"
  };
}

function buildLlmProfileConfig(
  profiles: TestLlmProfileInput[],
  options?: {
    defaultProfile?: string;
    auxProfile?: string;
    fallbackProfile?: string;
  }
): Record<string, unknown> {
  const normalizedProfiles = profiles.map((item) => createTestLlmProfile(item));
  const firstProfileId = String(normalizedProfiles[0]?.id || "default");
  const defaultProfileId = String(options?.defaultProfile || firstProfileId || "default");
  const auxProfileId = String(options?.auxProfile || "").trim();
  const fallbackProfileId = String(options?.fallbackProfile || "").trim();
  return {
    llmDefaultProfile: defaultProfileId,
    llmAuxProfile: auxProfileId && auxProfileId !== defaultProfileId ? auxProfileId : "",
    llmFallbackProfile: fallbackProfileId && fallbackProfileId !== defaultProfileId ? fallbackProfileId : "",
    llmProfiles: normalizedProfiles
  };
}

function buildWorkerLlmConfig(options?: { id?: string; model?: string; apiKey?: string; role?: string }): Record<string, unknown> {
  const id = String(options?.id || "default");
  const role = String(options?.role || "worker");
  return buildLlmProfileConfig(
    [
      {
        id,
        role,
        llmModel: options?.model || "gpt-test",
        llmApiKey: options?.apiKey ?? "sk-demo"
      }
    ],
    {
      defaultProfile: id
    }
  );
}

function resetRuntimeOnMessageMock(): void {
  const onMessage = chrome.runtime.onMessage as unknown as {
    addListener: (cb: RuntimeListener) => void;
    removeListener: (cb: RuntimeListener) => void;
    hasListener: (cb: RuntimeListener) => boolean;
  };
  onMessage.addListener = (cb) => {
    runtimeListeners.push(cb);
  };
  onMessage.removeListener = (cb) => {
    runtimeListeners = runtimeListeners.filter((item) => item !== cb);
  };
  onMessage.hasListener = (cb) => runtimeListeners.includes(cb);
}

function invokeRuntime(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!runtimeListeners.length) {
      reject(new Error("runtime listener not registered"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`runtime response timeout: ${String(message.type || "")}`));
    }, 2500);

    try {
      for (const listener of runtimeListeners) {
        listener(message, {}, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve((response || {}) as Record<string, unknown>);
        });
        if (settled) break;
      }
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function waitForLoopDone(sessionId: string, timeoutMs = 6_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const out = await invokeRuntime({
      type: "brain.step.stream",
      sessionId,
      fromIdx: 0
    });
    const data = toRecord(out.data);
    const items = Array.isArray(data.stream) ? (data.stream as Array<Record<string, unknown>>) : [];
    const done = items.some((item) => String(item.type || "") === "loop_done");
    if (done) return items;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitForLoopDone timeout");
}

describe("browser_bash whoami MVP", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runtimeListeners = [];
    resetRuntimeOnMessageMock();
  });

  it("MVP: browser_bash whoami 在被错误 process.exec provider 截走时会报 window is not defined", async () => {
    const orchestrator = new BrainOrchestrator();
    registerRuntimeRouter(orchestrator);

    let hijackInvoked = 0;
    let observedCommand = "";
    orchestrator.registerCapabilityProvider(
      "process.exec",
      {
        id: "mvp.hijack.process.exec",
        mode: "script",
        priority: 10_000,
        canHandle: (input) => {
          const frame = toRecord(toRecord(input.args).frame);
          const args = toRecord(frame.args);
          const cmd = Array.isArray(args.args) ? String(args.args[0] || "") : "";
          observedCommand = cmd;
          return String(frame.tool || "") === "bash"
            && String(args.cmdId || "") === "bash.exec"
            && String(input.action || "") === "invoke";
        },
        invoke: async () => {
          hijackInvoked += 1;
          return {
            type: "invoke",
            response: {
              ok: true,
              data: {
                cmdId: "bash.exec",
                argv: ["bash", "-lc", "whoami"],
                exitCode: 2,
                stdout: "",
                stderr: "window is not defined\n"
              }
            }
          };
        }
      },
      { replace: true }
    );

    const capturedBodies: Array<Record<string, unknown>> = [];
    let llmCall = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      llmCall += 1;
      capturedBodies.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      if (llmCall === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "call_mvp_browser_bash_whoami",
                      type: "function",
                      function: {
                        name: "browser_bash",
                        arguments: JSON.stringify({ command: "whoami" })
                      }
                    }
                  ]
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "done" }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });

    const saved = await invokeRuntime({
      type: "config.save",
      payload: {
        ...buildWorkerLlmConfig({ model: "gpt-test" }),
        autoTitleInterval: 0
      }
    });
    expect(saved.ok).toBe(true);

    const started = await invokeRuntime({
      type: "brain.run.start",
      prompt: "运行 browser_bash whoami"
    });
    expect(started.ok).toBe(true);

    const sessionId = String(toRecord(started.data).sessionId || "");
    expect(sessionId).not.toBe("");

    const streamItems = await waitForLoopDone(sessionId);
    expect(hijackInvoked).toBe(1);
    expect(observedCommand).toContain("whoami");

    const toolStep = streamItems.find((item) => {
      if (String(item.type || "") !== "step_finished") return false;
      const payload = toRecord(item.payload);
      return String(payload.action || "") === "browser_bash";
    });
    expect(toolStep).toBeDefined();

    const payload = toRecord(toRecord(toolStep).payload);
    expect(payload.ok).toBe(false);
    expect(String(payload.providerId || "")).toBe("mvp.hijack.process.exec");

    expect(capturedBodies.length).toBeGreaterThanOrEqual(2);
    const secondBody = toRecord(capturedBodies[1]);
    const secondMessages = Array.isArray(secondBody.messages)
      ? (secondBody.messages as Array<Record<string, unknown>>)
      : [];
    const toolMessage = secondMessages.find(
      (entry) => String(entry.role || "") === "tool" && String(entry.tool_call_id || "") === "call_mvp_browser_bash_whoami"
    );
    expect(toolMessage).toBeDefined();
    const content = JSON.parse(String(toRecord(toolMessage).content || "{}")) as Record<string, unknown>;
    expect(String(content.errorCode || "")).toBe("E_BASH_EXIT_NON_ZERO");
    expect(String(content.error || "")).toContain("window/document");
    expect(String(toRecord(content.details).stderr || "")).toContain("window is not defined");
  });
});
