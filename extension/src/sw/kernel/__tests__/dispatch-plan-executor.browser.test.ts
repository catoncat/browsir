import "./test-setup";

import { describe, expect, it, vi } from "vitest";
import { createDispatchExecutor } from "../dispatch-plan-executor";
import type { ExecuteStepResult } from "../orchestrator.browser";
import type { ToolPlan } from "../loop-tool-dispatch";

describe("dispatch-plan-executor", () => {
  it("passes semantic action and forces verify when step.element_action carries expect", async () => {
    const executeStep = vi.fn(
      async (): Promise<ExecuteStepResult> => ({
        ok: true,
        data: {
          ok: true,
          url: "https://movie.douban.com/subject/36154920/",
        },
        verified: true,
        verifyReason: "verified",
        modeUsed: "script",
      }),
    );

    const { dispatchToolPlan } = createDispatchExecutor({
      orchestrator: {} as any,
      infra: {} as any,
      executeStep,
    });

    const expectPayload = {
      urlContains: "movie.douban.com/subject/36154920",
    };

    await dispatchToolPlan("session-verify-action", {
      kind: "step.element_action",
      toolName: "navigate_tab",
      capability: "browser.action",
      tabId: 42,
      kindValue: "navigate",
      action: {
        kind: "navigate",
        url: "https://movie.douban.com/subject/36154920/",
        expect: expectPayload,
      },
      expect: expectPayload,
    } as ToolPlan);

    expect(executeStep).toHaveBeenCalledWith({
      sessionId: "session-verify-action",
      capability: "browser.action",
      action: "navigate",
      verifyPolicy: "always",
      args: {
        tabId: 42,
        action: {
          kind: "navigate",
          url: "https://movie.douban.com/subject/36154920/",
          expect: expectPayload,
        },
        expect: expectPayload,
      },
    });
  });

  it("passes semantic action even when step.element_action has no explicit expect", async () => {
    const executeStep = vi.fn(
      async (): Promise<ExecuteStepResult> => ({
        ok: true,
        data: {
          ok: true,
        },
        verified: false,
        verifyReason: "verify_policy_off",
        modeUsed: "script",
      }),
    );

    const { dispatchToolPlan } = createDispatchExecutor({
      orchestrator: {} as any,
      infra: {} as any,
      executeStep,
    });

    await dispatchToolPlan("session-semantic-action", {
      kind: "step.element_action",
      toolName: "navigate_tab",
      capability: "browser.action",
      tabId: 7,
      kindValue: "navigate",
      action: {
        kind: "navigate",
        url: "https://movie.douban.com/subject/36154920/",
      },
      expect: {},
    } as ToolPlan);

    expect(executeStep).toHaveBeenCalledWith({
      sessionId: "session-semantic-action",
      capability: "browser.action",
      action: "navigate",
      args: {
        tabId: 7,
        action: {
          kind: "navigate",
          url: "https://movie.douban.com/subject/36154920/",
        },
      },
    });
  });
});
