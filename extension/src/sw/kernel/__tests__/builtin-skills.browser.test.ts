import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_SKILL_SEED_SESSION_ID } from "../builtin-skill-policy";
import { resetLifoAdapterForTest, invokeLifoFrame } from "../browser-unix-runtime/lifo-adapter";
import { ensureBuiltinSkills } from "../builtin-skills";
import { getDB } from "../idb-storage";
import { BrainOrchestrator } from "../orchestrator.browser";

async function resetBuiltinSkillTestState(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["sessions", "entries", "traces", "kv"], "readwrite");
  await tx.objectStore("sessions").clear();
  await tx.objectStore("entries").clear();
  await tx.objectStore("traces").clear();
  await tx.objectStore("kv").clear();
  await tx.done;
  await resetLifoAdapterForTest();
}

beforeEach(async () => {
  await resetBuiltinSkillTestState();
});

describe("builtin-skills.browser", () => {
  it("seeds builtin skills into dedicated namespace and registry", async () => {
    const orchestrator = new BrainOrchestrator();

    await ensureBuiltinSkills(orchestrator);

    const installed = await orchestrator.getSkill("skill-authoring");
    expect(installed).not.toBeNull();
    expect(installed?.source).toBe("builtin");
    expect(installed?.location).toBe("mem://builtin-skills/skill-authoring/SKILL.md");

    const read = await invokeLifoFrame({
      sessionId: "builtin-skill-check",
      tool: "read",
      args: {
        path: "mem://builtin-skills/skill-authoring/SKILL.md",
        runtime: "sandbox",
      },
    });
    expect(String(read.content || "")).toContain("id: skill-authoring");
    expect(String(read.content || "")).toContain("不要把产品内 skill 写到宿主机");
  });

  it("rewrites builtin skill files from code source of truth", async () => {
    await invokeLifoFrame({
      sessionId: BUILTIN_SKILL_SEED_SESSION_ID,
      tool: "write",
      args: {
        path: "mem://builtin-skills/skill-authoring/SKILL.md",
        content: `---
id: skill-authoring
name: 自定义技能编写
description: 保留现有文件内容
---

# SKILL
保留我的内容
`,
        mode: "overwrite",
        runtime: "sandbox",
      },
    });

    const orchestrator = new BrainOrchestrator();
    await ensureBuiltinSkills(orchestrator);

    const installed = await orchestrator.getSkill("skill-authoring");
    expect(installed?.source).toBe("builtin");
    expect(installed?.name).toBe("技能编写");
    expect(installed?.description).toContain("设计、创建和维护 browser 内 skill package");
    expect(installed?.enabled).toBe(true);

    const read = await invokeLifoFrame({
      sessionId: "builtin-skill-check",
      tool: "read",
      args: {
        path: "mem://builtin-skills/skill-authoring/SKILL.md",
        runtime: "sandbox",
      },
    });
    expect(String(read.content || "")).not.toContain("保留我的内容");
    expect(String(read.content || "")).toContain("不要把产品内 skill 写到宿主机");
  });

  it("migrates conflicting user skill id before seeding builtin skill", async () => {
    await invokeLifoFrame({
      sessionId: "user-skill",
      tool: "write",
      args: {
        path: "mem://skills/skill-authoring/SKILL.md",
        content: `---
id: skill-authoring
name: 用户技能
description: 用户自定义版本
---

# SKILL
用户自己的技能内容
`,
        mode: "overwrite",
        runtime: "sandbox",
      },
    });

    const orchestrator = new BrainOrchestrator();
    await orchestrator.installSkill({
      id: "skill-authoring",
      name: "用户技能",
      description: "用户自定义版本",
      location: "mem://skills/skill-authoring/SKILL.md",
      source: "browser",
      enabled: true,
    });

    await ensureBuiltinSkills(orchestrator);

    const builtin = await orchestrator.getSkill("skill-authoring");
    expect(builtin?.source).toBe("builtin");
    expect(builtin?.location).toBe("mem://builtin-skills/skill-authoring/SKILL.md");

    const migrated = await orchestrator.getSkill("user.skill-authoring");
    expect(migrated?.source).toBe("browser");
    expect(migrated?.location).toBe("mem://skills/skill-authoring/SKILL.md");

    const userRead = await invokeLifoFrame({
      sessionId: "builtin-skill-check",
      tool: "read",
      args: {
        path: "mem://skills/skill-authoring/SKILL.md",
        runtime: "sandbox",
      },
    });
    expect(String(userRead.content || "")).toContain('id: "user.skill-authoring"');
    expect(String(userRead.content || "")).toContain("用户自己的技能内容");
  });
});
