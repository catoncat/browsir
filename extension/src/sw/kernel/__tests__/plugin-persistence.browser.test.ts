import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { kvGet, kvRemove, kvSet } from "../idb-storage";
import {
  readPersistedPluginRecords,
  seedDefaultExamplePluginRecords,
  upsertPersistedPluginRecord
} from "../runtime-router/plugin-persistence";

const PLUGIN_REGISTRY_STORAGE_KEY = "brain.plugin.registry:v1";
const PLUGIN_EXAMPLE_SEED_STORAGE_KEY = "brain.plugin.seed.examples:v1";
const LEGACY_MISSION_HUD_DOG_UI_JS = `// mission-hud-dog 主要通过 runtime message 驱动 UI（bbloop.ui.mascot）
// 当前不需要额外 ui hook。你可在这里加自定义渲染逻辑。
module.exports = function registerMissionHudDogUi(_ui) {
  return;
};`;

beforeEach(async () => {
  await kvRemove(PLUGIN_REGISTRY_STORAGE_KEY);
  await kvRemove(PLUGIN_EXAMPLE_SEED_STORAGE_KEY);
});

describe("plugin-persistence.browser", () => {
  it("migrates legacy mission-hud-dog studio source to builtin package source with inline JS", async () => {
    await upsertPersistedPluginRecord({
      pluginId: "plugin.example.ui.mission-hud.dog",
      kind: "extension",
      enabled: true,
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
      source: {
        manifest: {
          id: "plugin.example.ui.mission-hud.dog",
          name: "example-mission-hud-dog",
          version: "1.0.0"
        },
        modulePath: "mem://plugins/plugin.example.ui.mission-hud.dog/index.js",
        uiModulePath: "mem://plugins/plugin.example.ui.mission-hud.dog/ui.js",
        moduleSessionId: "plugin-studio",
        uiModuleSessionId: "plugin-studio",
        indexJs: "module.exports = function registerMissionHudDog() {};",
        uiJs: LEGACY_MISSION_HUD_DOG_UI_JS
      }
    });
    await kvSet(PLUGIN_EXAMPLE_SEED_STORAGE_KEY, {
      version: 1,
      seededAt: "2026-03-14T00:00:00.000Z"
    });

    await seedDefaultExamplePluginRecords();

    const records = await readPersistedPluginRecords();
    const record = records.find((item) => item.pluginId === "plugin.example.ui.mission-hud.dog");
    expect(record).toBeTruthy();
    // After v1→v3 migration: legacy record is first replaced by builtin package
    // (which strips indexJs), then v3 migration injects inline sources.
    expect(String(record?.source?.indexJs || "")).toBeTruthy();
    expect(String(record?.source?.uiJs || "")).toBeTruthy();
    // modulePath is kept as fallback for environments without virtual FS
    expect(String(record?.source?.modulePath || "")).toBe("plugins/example-mission-hud-dog/index.js");

    const seedInfo = await kvGet(PLUGIN_EXAMPLE_SEED_STORAGE_KEY);
    expect(Number(seedInfo?.version || 0)).toBe(3);
  });

  it("keeps customized mission-hud-dog studio source intact during seed migration", async () => {
    await upsertPersistedPluginRecord({
      pluginId: "plugin.example.ui.mission-hud.dog",
      kind: "extension",
      enabled: true,
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
      source: {
        manifest: {
          id: "plugin.example.ui.mission-hud.dog",
          name: "example-mission-hud-dog",
          version: "1.0.0"
        },
        modulePath: "mem://plugins/plugin.example.ui.mission-hud.dog/index.js",
        uiModulePath: "mem://plugins/plugin.example.ui.mission-hud.dog/ui.js",
        moduleSessionId: "plugin-studio",
        uiModuleSessionId: "plugin-studio",
        indexJs: "module.exports = function registerMissionHudDog() {};",
        uiJs: "module.exports = function registerMissionHudDogUi(ui) { ui.on('ui.notice.before_show', () => ({ action: 'continue' })); };"
      }
    });
    await kvSet(PLUGIN_EXAMPLE_SEED_STORAGE_KEY, {
      version: 1,
      seededAt: "2026-03-14T00:00:00.000Z"
    });

    await seedDefaultExamplePluginRecords();

    const records = await readPersistedPluginRecords();
    const record = records.find((item) => item.pluginId === "plugin.example.ui.mission-hud.dog");
    // Custom source already has indexJs → v3 migration skips it, preserving user edits
    expect(String(record?.source?.uiJs || "")).toContain("ui.notice.before_show");
    expect(String(record?.source?.uiModulePath || "")).toBe("mem://plugins/plugin.example.ui.mission-hud.dog/ui.js");
  });

  it("re-seeds missing example plugins after seed version has already been written", async () => {
    await kvSet(PLUGIN_EXAMPLE_SEED_STORAGE_KEY, {
      version: 3,
      seededAt: "2026-03-14T00:00:00.000Z"
    });

    await seedDefaultExamplePluginRecords();

    const records = await readPersistedPluginRecords();
    const missionHudDog = records.find((item) => item.pluginId === "plugin.example.ui.mission-hud.dog");
    const sendSuccess = records.find(
      (item) => item.pluginId === "plugin.example.notice.send-success-global-message"
    );
    expect(missionHudDog?.kind).toBe("extension");
    expect(missionHudDog?.enabled).toBe(true);
    // Newly seeded records have inline sources, with modulePath kept as fallback
    expect(String(missionHudDog?.source?.indexJs || "")).toBeTruthy();
    expect(String(missionHudDog?.source?.modulePath || "")).toBe("plugins/example-mission-hud-dog/index.js");
    expect(sendSuccess?.kind).toBe("extension");
    expect(sendSuccess?.enabled).toBe(true);
  });
});
