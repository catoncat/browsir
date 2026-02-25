import "./test-setup";

import { beforeEach, describe, expect, it } from "vitest";
import { kvRemove } from "../idb-storage";
import { SkillContentResolver } from "../skill-content-resolver";
import { SKILL_REGISTRY_META_KEY, SkillRegistry } from "../skill-registry";

describe("skill-content-resolver.browser", () => {
  beforeEach(async () => {
    await kvRemove(SKILL_REGISTRY_META_KEY);
  });

  it("resolves content and builds <skill> prompt block", async () => {
    const registry = new SkillRegistry();
    await registry.install({
      id: "skill.write-doc",
      name: "Write Doc",
      description: "write docs with template",
      location: "mem://skills/write-doc/SKILL.md",
      source: "global"
    });

    const resolver = new SkillContentResolver(registry, {
      readText: async ({ location }) => {
        expect(location).toBe("mem://skills/write-doc/SKILL.md");
        return "# SKILL\nFollow workflow.";
      }
    });

    const resolved = await resolver.resolveById("skill.write-doc");
    expect(resolved.skill.id).toBe("skill.write-doc");
    expect(resolved.content).toContain("Follow workflow");
    expect(resolved.promptBlock).toContain('<skill id="skill.write-doc"');
    expect(resolved.promptBlock).toContain('location="mem://skills/write-doc/SKILL.md"');
    expect(resolved.promptBlock).toContain("# SKILL");
  });

  it("blocks disabled skill by default, allowDisabled=true can resolve", async () => {
    const registry = new SkillRegistry();
    await registry.install({
      id: "skill.disabled",
      name: "Disabled Skill",
      location: "mem://skills/disabled/SKILL.md",
      enabled: false
    });

    const resolver = new SkillContentResolver(registry, {
      readText: async () => "disabled-skill-content"
    });

    await expect(resolver.resolveById("skill.disabled")).rejects.toThrow("skill 未启用");

    const resolved = await resolver.resolveById("skill.disabled", {
      allowDisabled: true
    });
    expect(resolved.content).toBe("disabled-skill-content");
  });
});
