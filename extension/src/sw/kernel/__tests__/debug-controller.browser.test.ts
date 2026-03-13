import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { kvRemove } from "../idb-storage";
import { BrainOrchestrator } from "../orchestrator.browser";
import { handleBrainDebug } from "../runtime-router/debug-controller";
import { upsertPersistedPluginRecord } from "../runtime-router/plugin-persistence";
import { upsertUiExtensionDescriptor } from "../runtime-router/plugin-ui-extensions";
import {
  recordPluginHookTraceDebugEvent,
  recordPluginRuntimeMessageDebugEvent,
  recordRuntimeInternalDebugEvent,
  recordRuntimeRouteDebugEvent,
  resetRuntimeDebugStoreForTest,
} from "../runtime-router/runtime-debug-store";

const runtimeLoopStub = {
  getSystemPromptPreview: async () => "test system prompt",
} as any;

const infraStub = {
  handleMessage: async () => null,
} as any;

beforeEach(async () => {
  resetRuntimeDebugStoreForTest();
  await kvRemove("brain.plugin.registry:v1");
  await kvRemove("brain.plugin.seed.examples:v1");
});

describe("debug-controller.browser", () => {
  it("exposes runtime debug surface for external AI inspection", async () => {
    const orchestrator = new BrainOrchestrator();
    const { sessionId } = await orchestrator.createSession();
    await orchestrator.installSkill({
      id: "debug.skill",
      name: "Debug Skill",
      description: "for runtime debug",
      location: "mem://skills/debug-skill/SKILL.md",
    });

    await upsertPersistedPluginRecord({
      pluginId: "plugin.debug.demo",
      kind: "extension",
      enabled: true,
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-13T00:00:00.000Z",
      source: {
        manifest: {
          id: "plugin.debug.demo",
          name: "Plugin Debug Demo",
          version: "1.0.0",
        },
      },
    });
    await upsertUiExtensionDescriptor({
      pluginId: "plugin.debug.demo",
      moduleUrl: "mem://plugins/plugin-debug-demo/ui.js",
      exportName: "default",
      enabled: true,
      updatedAt: "2026-03-13T00:00:00.000Z",
      sessionId,
    });

    recordRuntimeRouteDebugEvent({
      ts: "2026-03-13T00:00:01.000Z",
      type: "brain.skill.install",
      ok: true,
      durationMs: 4,
      sessionId,
      skillId: "debug.skill",
      summary: "installed",
    });
    recordPluginRuntimeMessageDebugEvent({
      type: "bbloop.global.message",
      pluginId: "plugin.debug.demo",
      message: "hello runtime",
    });
    recordPluginHookTraceDebugEvent({
      traceType: "ui_hook",
      pluginId: "plugin.debug.demo",
      hook: "render",
      durationMs: 9,
      sessionId,
      responsePreview: "{\"action\":\"continue\"}",
    });
    recordRuntimeInternalDebugEvent({
      ts: "2026-03-13T00:00:02.000Z",
      type: "plugin.rehydrate.failed",
      ok: false,
      pluginId: "plugin.debug.demo",
      detail: "boom",
    });

    const result = await handleBrainDebug(
      orchestrator,
      runtimeLoopStub,
      infraStub,
      {
        type: "brain.debug.runtime",
        sessionId,
      },
    );

    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: Record<string, unknown> }).data;
    expect(String(data.schemaVersion || "")).toBe("bbl.debug.runtime.v1");

    const root = (data.data || {}) as Record<string, unknown>;
    const runtime = (root.runtime || {}) as Record<string, unknown>;
    const activity = ((runtime.activity || {}) as Record<string, unknown>);
    const activitySummary = (activity.summary || {}) as Record<string, unknown>;
    const plugins = (root.plugins || {}) as Record<string, unknown>;
    const skills = (root.skills || {}) as Record<string, unknown>;

    expect(Array.isArray(runtime.sessions)).toBe(true);
    expect(Number(activitySummary.routeCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(activitySummary.pluginMessageCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(activitySummary.pluginHookCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Number(activitySummary.internalEventCount || 0)).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(plugins.persisted)).toBe(true);
    expect(Array.isArray(plugins.uiExtensions)).toBe(true);
    expect(
      ((skills.skills as unknown[]) || []).some(
        (item) => String((item as Record<string, unknown>).id || "") === "debug.skill",
      ),
    ).toBe(true);
    expect(((skills.resolver || {}) as Record<string, unknown>).summary).toBeTruthy();
  });
});
