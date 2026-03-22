import type { BrainOrchestrator } from "./orchestrator.browser";
import {
  BUILTIN_SKILL_SEED_SESSION_ID,
  isBuiltinSkillId,
} from "./builtin-skill-policy";
import { parseSkillFrontmatter } from "./skill-package";
import type { SkillInstallInput, SkillMetadata } from "./skill-registry";
import { invokeVirtualFrame } from "./virtual-fs.browser";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function normalizeVirtualPath(input: unknown): string {
  let text = String(input || "").trim();
  if (!text || text === "." || text === "/") {
    text = "mem://";
  }
  const direct = /^mem:\/\/(.*)$/i.exec(text);
  const mounted = /^\/mem(?:\/(.*))?$/i.exec(text);
  let rest = "";
  if (direct) {
    rest = String(direct[1] || "");
  } else if (mounted) {
    rest = String(mounted[1] || "");
  } else {
    rest = text;
  }
  rest = rest.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (rest.length > 1) {
    rest = rest.replace(/\/+$/g, "");
  }
  return `mem://${rest}`;
}

async function statVirtualPath(
  path: string,
): Promise<{ exists: boolean; type: string }> {
  const result = await invokeVirtualFrame({
    sessionId: BUILTIN_SKILL_SEED_SESSION_ID,
    tool: "stat",
    args: {
      path: normalizeVirtualPath(path),
      runtime: "sandbox",
    },
  });
  const row = toRecord(result);
  return {
    exists: row.exists === true,
    type: String(row.type || "missing"),
  };
}

async function readVirtualTextFile(path: string): Promise<string> {
  const result = await invokeVirtualFrame({
    sessionId: BUILTIN_SKILL_SEED_SESSION_ID,
    tool: "read",
    args: {
      path: normalizeVirtualPath(path),
      runtime: "sandbox",
    },
  });
  const row = toRecord(result);
  return String(row.content || "");
}

async function writeVirtualTextFile(path: string, content: string): Promise<void> {
  await invokeVirtualFrame({
    sessionId: BUILTIN_SKILL_SEED_SESSION_ID,
    tool: "write",
    args: {
      path: normalizeVirtualPath(path),
      content: String(content || ""),
      mode: "overwrite",
      runtime: "sandbox",
    },
  });
}

function quoteYaml(value: string): string {
  const escaped = String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

function buildBuiltinInstallInput(
  definition: BuiltinSkillDefinition,
): SkillInstallInput {
  const frontmatter = parseSkillFrontmatter(definition.content);
  return {
    id: definition.id,
    name: String(frontmatter.name || "").trim() || definition.name,
    description:
      String(frontmatter.description || "").trim() || definition.description,
    location: definition.location,
    source: "builtin",
    enabled: definition.enabled,
    disableModelInvocation:
      frontmatter.disableModelInvocation ?? definition.disableModelInvocation,
  };
}

function buildMigratedUserSkillId(
  builtinSkillId: string,
  takenIds: Set<string>,
): string {
  const base = `user.${builtinSkillId}`;
  if (!takenIds.has(base) && !isBuiltinSkillId(base)) {
    return base;
  }
  let index = 2;
  while (index < 10_000) {
    const candidate = `${base}-${index}`;
    if (!takenIds.has(candidate) && !isBuiltinSkillId(candidate)) {
      return candidate;
    }
    index += 1;
  }
  throw new Error(`无法为 builtin skill 冲突生成迁移 ID: ${builtinSkillId}`);
}

function rewriteSkillMarkdownId(
  content: string,
  nextId: string,
  fallback: {
    name: string;
    description: string;
    disableModelInvocation: boolean;
  },
): string {
  const lines = String(content || "").split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    let endLine = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (String(lines[i] || "").trim() === "---") {
        endLine = i;
        break;
      }
    }
    if (endLine > 0) {
      let replaced = false;
      for (let i = 1; i < endLine; i += 1) {
        if (/^id\s*:/i.test(String(lines[i] || "").trim())) {
          lines[i] = `id: ${quoteYaml(nextId)}`;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        lines.splice(1, 0, `id: ${quoteYaml(nextId)}`);
      }
      return lines.join("\n");
    }
  }

  const header = [
    "---",
    `id: ${quoteYaml(nextId)}`,
    `name: ${quoteYaml(fallback.name || nextId)}`,
    `description: ${quoteYaml(fallback.description || "")}`,
  ];
  if (fallback.disableModelInvocation) {
    header.push("disable-model-invocation: true");
  }
  header.push("---", "");
  const body = String(content || "").trimStart();
  return body ? `${header.join("\n")}${body}` : `${header.join("\n")}# SKILL\n`;
}

async function migrateBuiltinIdConflict(
  orchestrator: BrainOrchestrator,
  conflict: SkillMetadata,
  definition: BuiltinSkillDefinition,
): Promise<void> {
  const skills = await orchestrator.listSkills();
  const takenIds = new Set(skills.map((item) => String(item.id || "").trim()));
  takenIds.delete(conflict.id);
  const migratedId = buildMigratedUserSkillId(definition.id, takenIds);
  const normalizedLocation = normalizeVirtualPath(conflict.location);
  const stat = await statVirtualPath(normalizedLocation);
  const previousContent =
    stat.exists && stat.type === "file"
      ? await readVirtualTextFile(normalizedLocation)
      : null;
  const nextContent =
    previousContent == null
      ? null
      : rewriteSkillMarkdownId(previousContent, migratedId, {
          name: conflict.name,
          description: conflict.description,
          disableModelInvocation: conflict.disableModelInvocation === true,
        });

  try {
    if (nextContent !== null) {
      await writeVirtualTextFile(normalizedLocation, nextContent);
    }
    await orchestrator.installSkill(
      {
        id: migratedId,
        name: conflict.name,
        description: conflict.description,
        location: normalizedLocation,
        source: conflict.source,
        enabled: conflict.enabled,
        disableModelInvocation: conflict.disableModelInvocation,
      },
      { replace: false },
    );
    const removed = await orchestrator.uninstallSkill(conflict.id);
    if (!removed) {
      throw new Error(`builtin skill 冲突迁移失败，旧 skill 不存在: ${conflict.id}`);
    }
  } catch (error) {
    await orchestrator.uninstallSkill(migratedId).catch(() => undefined);
    if (previousContent !== null) {
      await writeVirtualTextFile(normalizedLocation, previousContent).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

export interface BuiltinSkillDefinition {
  id: string;
  name: string;
  description: string;
  location: string;
  enabled: boolean;
  disableModelInvocation: boolean;
  content: string;
}

const SKILL_AUTHORING_CONTENT = `---
id: skill-authoring
name: 技能编写
description: 设计、创建和维护 browser 内 skill package；把 skill 当作文件包而不是受管配置。
---

# 技能编写

## 核心心智

- skill 是一个 package，不是一条配置。
- 主文档是 \`SKILL.md\`；旁边可以有 \`references/\`、\`scripts/\`、\`assets/\` 等子文件。
- 用户自定义 skill 写在 \`mem://skills/<skill-id>/\` 下。
- 不要把产品内 skill 写到宿主机 \`.agents/skills\` 或其他开发者目录。
- 不要把 skill authoring 限制成“必须走某个专用 tool call”；直接写文件包也是合法路径。

## 创建流程

1. 先明确这个 skill 的任务、输入、输出、边界。
2. 选稳定的 \`id\`，再确定目录：\`mem://skills/<id>/SKILL.md\`。
3. 在 \`SKILL.md\` frontmatter 里至少写清：
   - \`id\`
   - \`name\`
   - \`description\`
4. 正文只写真正帮助模型完成任务的流程，不要把调试对话、实现碎念、UI 注释塞进去。
5. 如果需要长参考资料，放到 \`references/\`；如果需要脚本，放到 \`scripts/\`；如果需要静态资源，放到 \`assets/\`。
6. 创建或修改后，确认主文档路径、frontmatter 和正文目标一致。

## 修改流程

- 优先原地修改已有 package，不随意改 \`id\`。
- 变更说明、流程、示例时，先保持主任务稳定，再补充引用资料或脚本。
- 如果只是补充参考，不要把所有内容都堆回 \`SKILL.md\`。

## 主文档模板

\`\`\`md
---
id: my-skill
name: 我的技能
description: 用一句话说明它解决什么问题。
---

# SKILL

## 目标

说明这个 skill 负责什么，不负责什么。

## 输入

说明需要哪些上下文。

## 步骤

1. 先做什么。
2. 再做什么。
3. 最后产出什么。

## 输出

说明交付物格式和完成标准。
\`\`\`
`;

export const BUILTIN_SKILLS: BuiltinSkillDefinition[] = [
  {
    id: "skill-authoring",
    name: "技能编写",
    description:
      "设计、创建和维护 browser 内 skill package；把 skill 当作文件包而不是受管配置。",
    location: "mem://builtin-skills/skill-authoring/SKILL.md",
    enabled: true,
    disableModelInvocation: false,
    content: SKILL_AUTHORING_CONTENT,
  },
];

async function ensureBuiltinSkill(
  orchestrator: BrainOrchestrator,
  definition: BuiltinSkillDefinition,
): Promise<void> {
  const current = await orchestrator.getSkill(definition.id);
  if (current && current.source !== "builtin") {
    await migrateBuiltinIdConflict(orchestrator, current, definition);
  }

  await writeVirtualTextFile(definition.location, definition.content);
  await orchestrator.installSkill(buildBuiltinInstallInput(definition), {
    replace: true,
  });
}

export async function ensureBuiltinSkills(
  orchestrator: BrainOrchestrator,
): Promise<void> {
  for (const definition of BUILTIN_SKILLS) {
    await ensureBuiltinSkill(orchestrator, definition);
  }
}
