import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { kvRemove } from "../idb-storage";
import { SKILL_REGISTRY_META_KEY, SkillRegistry } from "../skill-registry";

describe("skill-registry.browser", () => {
  beforeEach(async () => {
    await kvRemove(SKILL_REGISTRY_META_KEY);
  });

  it("supports install/list/enable/disable/uninstall lifecycle", async () => {
    const registry = new SkillRegistry();

    const installed = await registry.install({
      id: "skill.pi.align",
      name: "PI Align",
      description: "align runtime behavior with PI",
      location: "mem://skills/pi-align/SKILL.md",
      source: "project",
      enabled: false,
      disableModelInvocation: true
    });

    expect(installed.id).toBe("skill.pi.align");
    expect(installed.enabled).toBe(false);
    expect(installed.disableModelInvocation).toBe(true);

    const listed = await registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("skill.pi.align");

    const enabled = await registry.enable("skill.pi.align");
    expect(enabled.enabled).toBe(true);

    const disabled = await registry.disable("skill.pi.align");
    expect(disabled.enabled).toBe(false);

    const removed = await registry.uninstall("skill.pi.align");
    expect(removed).toBe(true);
    expect(await registry.list()).toHaveLength(0);
  });

  it("supports replace and persists across registry instances", async () => {
    const registry = new SkillRegistry();
    const first = await registry.install({
      id: "skill.research",
      name: "Research",
      location: "mem://skills/research/SKILL.md"
    });

    await expect(
      registry.install({
        id: "skill.research",
        name: "Research Duplicate",
        location: "mem://skills/research/SKILL.md"
      })
    ).rejects.toThrow("skill already exists");

    const replaced = await registry.install(
      {
        id: "skill.research",
        name: "Research V2",
        description: "updated",
        location: "mem://skills/research/SKILL.md",
        enabled: false
      },
      {
        replace: true
      }
    );

    expect(replaced.id).toBe(first.id);
    expect(replaced.name).toBe("Research V2");
    expect(replaced.enabled).toBe(false);

    const registryReloaded = new SkillRegistry();
    const loaded = await registryReloaded.get("skill.research");
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("Research V2");
    expect(loaded?.enabled).toBe(false);
  });
});
