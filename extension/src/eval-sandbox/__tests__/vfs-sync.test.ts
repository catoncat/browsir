import { describe, expect, it } from "vitest";
import { collectSandboxFiles, computeVfsDiff } from "../vfs-sync";

describe("eval sandbox vfs sync", () => {
  it("collects files when readdir returns structured entries", async () => {
    const directories = new Map<string, Array<{ name: string; type: "file" | "directory" }>>([
      ["/", [{ name: "globals", type: "directory" }]],
      ["/globals", [{ name: "skills", type: "directory" }]],
      ["/globals/skills", [{ name: "mem", type: "directory" }]],
      [
        "/globals/skills/mem",
        [{ name: "wechat-chat-automation", type: "directory" }],
      ],
      [
        "/globals/skills/mem/wechat-chat-automation",
        [{ name: "SKILL.md", type: "file" }],
      ],
    ]);
    const files = new Map<string, string>([
      [
        "/globals/skills/mem/wechat-chat-automation/SKILL.md",
        "---\nid: wechat-chat-automation\n---\nbody\n",
      ],
    ]);

    const snapshot = await collectSandboxFiles(
      {
        async readdir(dir: string) {
          return directories.get(dir) || [];
        },
        async stat(path: string) {
          if (directories.has(path)) return { type: "directory" };
          if (files.has(path)) return { type: "file" };
          throw new Error(`missing: ${path}`);
        },
        async readFile(path: string) {
          if (!files.has(path)) throw new Error(`missing file: ${path}`);
          return files.get(path) || "";
        },
      },
      "/",
    );

    expect(snapshot.get("/globals/skills/mem/wechat-chat-automation/SKILL.md")).toContain(
      "wechat-chat-automation",
    );
  });

  it("reports moved skill files as delete plus add", () => {
    const before = new Map<string, string>([
      [
        "/globals/skills/mem/.__staging__/skill_restore_1/SKILL.md",
        "old content",
      ],
    ]);
    const after = new Map<string, string>([
      [
        "/globals/skills/mem/wechat-chat-automation/SKILL.md",
        "old content",
      ],
    ]);

    expect(computeVfsDiff(before, after)).toEqual([
      {
        op: "add",
        path: "/globals/skills/mem/wechat-chat-automation/SKILL.md",
        content: "old content",
      },
      {
        op: "delete",
        path: "/globals/skills/mem/.__staging__/skill_restore_1/SKILL.md",
      },
    ]);
  });
});
