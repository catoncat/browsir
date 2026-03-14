import "./test-setup";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetLifoAdapterForTest } from "../browser-unix-runtime/lifo-adapter";
import { createDispatchExecutor } from "../dispatch-plan-executor";
import type { ExecuteStepResult } from "../orchestrator.browser";
import type { ToolPlan } from "../loop-tool-dispatch";
import { invokeVirtualFrame } from "../virtual-fs.browser";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

async function writeVirtualTextFile(
  path: string,
  content: string,
  sessionId = "skill-script-test",
): Promise<void> {
  await invokeVirtualFrame({
    tool: "write",
    args: {
      path,
      content,
      mode: "overwrite",
      runtime: "sandbox",
    },
    sessionId,
  });
}

function createDeps(sessionId = "skill-script-test") {
  const skill = {
    id: "demo-skill",
    name: "Demo Skill",
    description: "test skill",
    location: "mem://skills/demo-skill/SKILL.md",
    source: "project",
    enabled: true,
    disableModelInvocation: false,
    createdAt: "2026-03-14T00:00:00.000Z",
    updatedAt: "2026-03-14T00:00:00.000Z",
  };
  const executeStep = vi.fn(
    async (input: {
      sessionId: string;
      capability?: string;
      action: string;
      args?: JsonRecord;
    }): Promise<ExecuteStepResult> => {
      const frame = toRecord(input.args?.frame);
      const data = await invokeVirtualFrame({
        ...frame,
        sessionId: input.sessionId || sessionId,
      });
      return {
        ok: true,
        data,
        verified: true,
        modeUsed: "bridge",
      } as ExecuteStepResult;
    },
  );

  const { dispatchToolPlan } = createDispatchExecutor({
    orchestrator: {
      getSkill: vi.fn(async (name: string) =>
        name === skill.id || name === skill.name ? skill : null,
      ),
      listSkills: vi.fn(async () => [skill]),
    } as any,
    infra: {} as any,
    executeStep,
  });

  return { dispatchToolPlan, executeStep, skill };
}

function processExecCallCount(executeStep: ReturnType<typeof vi.fn>): number {
  return executeStep.mock.calls.filter(
    ([input]) => String(input?.capability || "") === "process.exec",
  ).length;
}

describe("execute-skill-script.browser", () => {
  beforeEach(async () => {
    await resetLifoAdapterForTest();
  });

  it("executes browser scope js skill script through inline runner", async () => {
    const sessionId = "skill-script-success";
    const { dispatchToolPlan, skill } = createDeps(sessionId);

    await writeVirtualTextFile(
      "mem://skills/demo-skill/scripts/echo.js",
      [
        'const payload = JSON.parse(process.argv[2] || "{}");',
        "console.log(JSON.stringify({ ok: true, name: payload.name, argv: process.argv.slice(1) }));",
      ].join("\n"),
      sessionId,
    );

    const result = await dispatchToolPlan(sessionId, {
      kind: "local.execute_skill_script",
      sessionId,
      skillName: skill.name,
      scriptPath: "echo.js",
      scriptArgs: { name: "browser" },
    } as ToolPlan);

    const payload = toRecord(toRecord(result.response).data);
    const bashResult = toRecord(payload.result);
    expect(toRecord(result.response).ok).toBe(true);
    expect(payload.runtime).toBe("browser");
    expect(String(payload.location || "")).toBe(
      "mem://skills/demo-skill/scripts/echo.js",
    );
    expect(String(payload.command || "")).toContain(
      "mem://__bbl/skill-script-runner.cjs",
    );
    expect(String(bashResult.stdout || "")).toContain('"name":"browser"');
    expect(String(bashResult.stdout || "")).toContain(
      '"argv":["mem://skills/demo-skill/scripts/echo.js","{\\"name\\":\\"browser\\"}"]',
    );
  });

  it("returns unsupported for browser scope ts skill script", async () => {
    const sessionId = "skill-script-ts";
    const { dispatchToolPlan, executeStep, skill } = createDeps(sessionId);

    await writeVirtualTextFile(
      "mem://skills/demo-skill/scripts/echo.ts",
      "console.log('hello from ts');",
      sessionId,
    );

    const result = await dispatchToolPlan(sessionId, {
      kind: "local.execute_skill_script",
      sessionId,
      skillName: skill.id,
      scriptPath: "echo.ts",
    } as ToolPlan);

    expect(String(result.errorCode || "")).toBe("E_TOOL_UNSUPPORTED");
    expect(String(result.error || "")).toContain("不支持技能脚本类型: .ts");
    expect(processExecCallCount(executeStep)).toBe(0);
  });

  it("returns unsupported when browser scope js script contains top-level import/export", async () => {
    const sessionId = "skill-script-esm";
    const { dispatchToolPlan, executeStep, skill } = createDeps(sessionId);

    await writeVirtualTextFile(
      "mem://skills/demo-skill/scripts/esm.js",
      'import fs from "fs";\nconsole.log(fs);',
      sessionId,
    );

    const result = await dispatchToolPlan(sessionId, {
      kind: "local.execute_skill_script",
      sessionId,
      skillName: skill.id,
      scriptPath: "esm.js",
    } as ToolPlan);

    expect(String(result.errorCode || "")).toBe("E_TOOL_UNSUPPORTED");
    expect(String(result.error || "")).toContain("顶层 import/export");
    expect(processExecCallCount(executeStep)).toBe(0);
  });
});
