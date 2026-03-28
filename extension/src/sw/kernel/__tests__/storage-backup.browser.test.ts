import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "@lifo-sh/core";
import { clearIdbStores } from "../idb-storage";
import { BrainOrchestrator } from "../orchestrator.browser";
import { createRuntimeInfraHandler } from "../runtime-infra.browser";
import { handleStorage } from "../runtime-router/storage-controller";
import { _setTestBashExecutor } from "../browser-unix-runtime/lifo-adapter";
import { invokeVirtualFrame } from "../virtual-fs.browser";
import { normalizePanelConfig } from "../../../shared/panel-config";
import {
  EXTENSION_DATA_BACKUP_SCHEMA_VERSION,
  type ExtensionDataBackup,
} from "../../../shared/data-backup";

async function writeMem(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  await invokeVirtualFrame({
    sessionId,
    tool: "write",
    args: {
      path,
      content,
      mode: "overwrite",
      runtime: "sandbox",
    },
  });
}

async function readMem(sessionId: string, path: string): Promise<string> {
  const result = await invokeVirtualFrame({
    sessionId,
    tool: "read",
    args: {
      path,
      runtime: "sandbox",
    },
  });
  return String((result as Record<string, unknown>).content || "");
}

async function statMem(
  sessionId: string,
  path: string,
): Promise<Record<string, unknown>> {
  return (await invokeVirtualFrame({
    sessionId,
    tool: "stat",
    args: {
      path,
      runtime: "sandbox",
    },
  })) as Record<string, unknown>;
}

async function runSandboxCommandForTest(
  sandbox: Sandbox,
  command: string,
  cwd: string | undefined,
  timeoutMs?: number,
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  vfsDiff: [];
}> {
  const processRegistry = sandbox.shell.getProcessRegistry();
  const baselinePids = new Set(processRegistry.getAllPIDs());
  let timeoutHit = false;

  const options = cwd != null ? { cwd } : {};
  const pending = sandbox.commands.run(command, options);
  const timer =
    timeoutMs == null
      ? null
      : setTimeout(() => {
          timeoutHit = true;
          for (const row of processRegistry.getAll()) {
            if (baselinePids.has(row.pid)) continue;
            processRegistry.kill(row.pid, "SIGTERM");
          }
        }, timeoutMs);

  try {
    const result = await pending;
    if (timer != null) clearTimeout(timer);

    if (timeoutHit) {
      const stderr = String(result.stderr || "").trim();
      const msg = "sandbox bash timed out";
      return {
        ok: false,
        stdout: String(result.stdout || ""),
        stderr: stderr ? `${stderr}\n${msg}` : msg,
        exitCode: 124,
        vfsDiff: [],
      };
    }

    return {
      ok: Number(result.exitCode ?? 0) === 0,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      exitCode: Number(result.exitCode ?? 0),
      vfsDiff: [],
    };
  } catch (err) {
    if (timer != null) clearTimeout(timer);
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
      vfsDiff: [],
    };
  }
}

describe("storage backup", () => {
  beforeEach(async () => {
    await clearIdbStores();
    await chrome.storage.local.clear();
  });

  it("exports and imports config + custom skill packages", async () => {
    const sessionId = "backup-roundtrip";
    const orchestrator = new BrainOrchestrator();
    const infra = createRuntimeInfraHandler();

    const originalConfig = normalizePanelConfig({
      bridgeUrl: "ws://127.0.0.1:8787/ws",
      bridgeToken: "token-original",
      llmProviders: [
        {
          id: "rs",
          name: "rs",
          type: "model_llm",
          apiConfig: {
            apiBase: "https://ai.chen.rs/v1",
            apiKey: "sk-original",
            supportedModels: ["gpt-5-codex"],
          },
          builtin: false,
        },
      ],
      llmProfiles: [
        {
          id: "route-primary",
          providerId: "rs",
          modelId: "gpt-5-codex",
          timeoutMs: 120000,
          retryMaxAttempts: 2,
          maxRetryDelayMs: 60000,
          builtin: false,
        },
      ],
      llmDefaultProfile: "route-primary",
      llmSystemPromptCustom: "Original prompt",
      maxSteps: 77,
      autoTitleInterval: 9,
    });

    const saved = await infra.handleMessage({
      type: "config.save",
      payload: originalConfig,
    });
    expect(saved?.ok).toBe(true);

    await writeMem(
      sessionId,
      "mem://skills/demo/SKILL.md",
      "---\nid: skill.demo\nname: Demo Skill\ndescription: Demo description\n---\nmain body\n",
    );
    await writeMem(
      sessionId,
      "mem://skills/demo/references/guide.md",
      "# guide\n",
    );
    await orchestrator.installSkill(
      {
        id: "skill.demo",
        name: "Demo Skill",
        description: "Demo description",
        location: "mem://skills/demo/SKILL.md",
        source: "browser",
        enabled: true,
        disableModelInvocation: false,
      },
      { replace: true },
    );

    const exported = await handleStorage(orchestrator, infra, {
      type: "brain.storage.backup.export",
      sessionId,
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const backup = exported.data as ExtensionDataBackup;
    expect(backup.schemaVersion).toBe(EXTENSION_DATA_BACKUP_SCHEMA_VERSION);
    expect(backup.payload.config.bridgeToken).toBe("token-original");
    expect(backup.payload.skills).toHaveLength(1);
    expect(backup.payload.skills[0]?.files.map((item) => item.path)).toEqual([
      "references/guide.md",
      "SKILL.md",
    ]);

    await infra.handleMessage({
      type: "config.save",
      payload: normalizePanelConfig({
        bridgeToken: "token-mutated",
        llmProviders: [
          {
            id: "mutated",
            name: "mutated",
            type: "model_llm",
            apiConfig: {
              apiBase: "https://example.ai/v1",
              apiKey: "sk-mutated",
              supportedModels: ["gpt-4.1"],
            },
            builtin: false,
          },
        ],
        llmProfiles: [
          {
            id: "route-mutated",
            providerId: "mutated",
            modelId: "gpt-4.1",
            timeoutMs: 120000,
            retryMaxAttempts: 2,
            maxRetryDelayMs: 60000,
            builtin: false,
          },
        ],
        llmDefaultProfile: "route-mutated",
      }),
    });
    await writeMem(
      sessionId,
      "mem://skills/demo/SKILL.md",
      "---\nid: skill.demo\nname: Demo Skill\ndescription: Demo description\n---\nmutated body\n",
    );
    await writeMem(
      sessionId,
      "mem://skills/temp/SKILL.md",
      "---\nid: skill.temp\nname: Temp Skill\ndescription: Temp description\n---\ntemp\n",
    );
    await orchestrator.installSkill(
      {
        id: "skill.temp",
        name: "Temp Skill",
        description: "Temp description",
        location: "mem://skills/temp/SKILL.md",
        source: "browser",
        enabled: true,
        disableModelInvocation: false,
      },
      { replace: true },
    );

    const imported = await handleStorage(orchestrator, infra, {
      type: "brain.storage.backup.import",
      sessionId,
      backup,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect((imported.data as Record<string, unknown>).importedSkillIds).toEqual([
      "skill.demo",
    ]);
    expect((imported.data as Record<string, unknown>).removedSkillIds).toEqual([
      "skill.temp",
    ]);

    const cfg = await infra.handleMessage({ type: "config.get" });
    expect(cfg?.ok).toBe(true);
    if (!cfg || !cfg.ok) return;
    const config = cfg.data as Record<string, unknown>;
    expect(config.bridgeToken).toBe("token-original");
    expect(config.llmDefaultProfile).toBe("route-primary");

    const skills = await orchestrator.listSkills();
    expect(skills.map((item) => item.id)).toEqual(["skill.demo"]);
    expect(await readMem(sessionId, "mem://skills/demo/SKILL.md")).toContain(
      "main body",
    );
    expect(
      await readMem(sessionId, "mem://skills/demo/references/guide.md"),
    ).toBe("# guide\n");
    expect((await statMem(sessionId, "mem://skills/temp")).exists).toBe(false);
  });

  it("imports backup even if backing up the current skill package hits a missing-source race", async () => {
    const sessionId = "backup-missing-source-race";
    const orchestrator = new BrainOrchestrator();
    const infra = createRuntimeInfraHandler();

    await infra.handleMessage({
      type: "config.save",
      payload: normalizePanelConfig({
        bridgeToken: "token-original",
        llmProviders: [],
        llmProfiles: [],
      }),
    });

    await writeMem(
      sessionId,
      "mem://skills/demo/SKILL.md",
      "---\nid: skill.demo\nname: Demo Skill\ndescription: Demo description\n---\nmain body\n",
    );
    await orchestrator.installSkill(
      {
        id: "skill.demo",
        name: "Demo Skill",
        description: "Demo description",
        location: "mem://skills/demo/SKILL.md",
        source: "browser",
        enabled: true,
        disableModelInvocation: false,
      },
      { replace: true },
    );

    const exported = await handleStorage(orchestrator, infra, {
      type: "brain.storage.backup.export",
      sessionId,
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    await writeMem(
      sessionId,
      "mem://skills/demo/SKILL.md",
      "---\nid: skill.demo\nname: Demo Skill\ndescription: Demo description\n---\nmutated body\n",
    );

    let injectedMissingSource = false;
    _setTestBashExecutor(async (sandbox, command, cwd, timeoutMs) => {
      if (
        !injectedMissingSource &&
        command.includes("mv '/globals/skills/mem/demo'") &&
        command.includes("skill_backup")
      ) {
        injectedMissingSource = true;
        return {
          ok: false,
          stdout: "",
          stderr:
            "mv: ENOENT: '/globals/skills/mem/demo': no such file or directory",
          exitCode: 1,
          vfsDiff: [],
        };
      }
      return await runSandboxCommandForTest(sandbox, command, cwd, timeoutMs);
    });

    const imported = await handleStorage(orchestrator, infra, {
      type: "brain.storage.backup.import",
      sessionId,
      backup: exported.data as ExtensionDataBackup,
    });
    expect(imported.ok).toBe(true);
    expect(injectedMissingSource).toBe(true);

    const cfg = await infra.handleMessage({ type: "config.get" });
    expect(cfg?.ok).toBe(true);
    if (!cfg || !cfg.ok) return;
    expect((cfg.data as Record<string, unknown>).bridgeToken).toBe("token-original");
    expect(await readMem(sessionId, "mem://skills/demo/SKILL.md")).toContain(
      "main body",
    );
  });

  it("imports backup even when current registry contains a dangling custom skill", async () => {
    const sessionId = "backup-dangling-skill";
    const orchestrator = new BrainOrchestrator();
    const infra = createRuntimeInfraHandler();

    await infra.handleMessage({
      type: "config.save",
      payload: normalizePanelConfig({
        bridgeToken: "token-original",
        llmProviders: [],
        llmProfiles: [],
      }),
    });

    await writeMem(
      sessionId,
      "mem://skills/demo/SKILL.md",
      "---\nid: skill.demo\nname: Demo Skill\ndescription: Demo description\n---\nmain body\n",
    );
    await orchestrator.installSkill(
      {
        id: "skill.demo",
        name: "Demo Skill",
        description: "Demo description",
        location: "mem://skills/demo/SKILL.md",
        source: "browser",
        enabled: true,
        disableModelInvocation: false,
      },
      { replace: true },
    );

    const exported = await handleStorage(orchestrator, infra, {
      type: "brain.storage.backup.export",
      sessionId,
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    await infra.handleMessage({
      type: "config.save",
      payload: normalizePanelConfig({
        bridgeToken: "token-mutated",
        llmProviders: [],
        llmProfiles: [],
      }),
    });
    await orchestrator.installSkill(
      {
        id: "axcli",
        name: "axcli",
        description: "dangling skill",
        location: "mem://skills/axcli/SKILL.md",
        source: "browser",
        enabled: true,
        disableModelInvocation: false,
      },
      { replace: true },
    );

    const imported = await handleStorage(orchestrator, infra, {
      type: "brain.storage.backup.import",
      sessionId,
      backup: exported.data as ExtensionDataBackup,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const skills = await orchestrator.listSkills();
    expect(skills.map((item) => item.id)).toEqual(["skill.demo"]);
    expect(await readMem(sessionId, "mem://skills/demo/SKILL.md")).toContain(
      "main body",
    );
    expect((await statMem(sessionId, "mem://skills/axcli")).exists).toBe(false);
  });
});
