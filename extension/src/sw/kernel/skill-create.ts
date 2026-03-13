import type { SkillInstallInput } from "./skill-registry";

type JsonRecord = Record<string, unknown>;

const DEFAULT_SKILL_ROOT = "mem://skills";

export interface SkillCreateWriteFile {
  path: string;
  content: string;
}

export interface NormalizedSkillCreateRequest {
  skill: SkillInstallInput;
  replace: boolean;
  root: string;
  skillDir: string;
  writes: SkillCreateWriteFile[];
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function normalizeSkillId(value: unknown): string {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text;
}

function toNameFallback(id: string): string {
  return id
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .trim();
}

function quoteYaml(value: string): string {
  const escaped = String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

function normalizeMemRoot(raw: unknown): string {
  const text = String(raw || DEFAULT_SKILL_ROOT)
    .trim()
    .replace(/\\/g, "/");
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (!match) {
    throw new Error("brain.skill.create root 必须是 mem:// 路径");
  }
  const scheme = String(match[1] || "").toLowerCase();
  if (scheme !== "mem") {
    throw new Error("brain.skill.create root 仅支持 mem://");
  }
  let rest = String(match[2] || "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/g, "");
  if (!rest) rest = "skills";
  const parts = rest.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("brain.skill.create root 非法");
  }
  return `mem://${parts.join("/")}`;
}

function normalizeRelativePath(raw: unknown, field: string): string {
  const text = String(raw || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (!text) throw new Error(`${field} 不能为空`);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    throw new Error(`${field} 不能是 URI`);
  }
  const parts = text.split("/").filter(Boolean);
  if (!parts.length) throw new Error(`${field} 不能为空`);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`${field} 不能包含 ..`);
  }
  return parts.join("/");
}

function normalizeBody(raw: unknown, name: string): string {
  const text = String(raw || "").trim();
  if (text) return text.endsWith("\n") ? text : `${text}\n`;
  return `# ${name}\n\n## Usage\nDescribe what this skill does and how to use it.\n`;
}

function collectGroupFiles(
  input: unknown,
  groupName: "scripts" | "references" | "assets" | "files"
): Array<{ relativePath: string; content: string }> {
  const out: Array<{ relativePath: string; content: string }> = [];
  if (input === undefined || input === null) return out;

  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i += 1) {
      const row = toRecord(input[i]);
      const path = normalizeRelativePath(row.path || row.file || row.name || "", `${groupName}[${i}].path`);
      const content = String(row.content ?? "");
      out.push({
        relativePath: groupName === "files" ? path : `${groupName}/${path}`,
        content
      });
    }
    return out;
  }

  const record = toRecord(input);
  const keys = Object.keys(record);
  if (!keys.length) return out;
  for (const key of keys) {
    const path = normalizeRelativePath(key, `${groupName}.${key}`);
    const content = String(record[key] ?? "");
    out.push({
      relativePath: groupName === "files" ? path : `${groupName}/${path}`,
      content
    });
  }
  return out;
}

function buildSkillMarkdown(input: {
  id: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
  body: string;
}): string {
  const lines = [
    "---",
    `id: ${quoteYaml(input.id)}`,
    `name: ${quoteYaml(input.name)}`,
    `description: ${quoteYaml(input.description)}`
  ];
  if (input.disableModelInvocation) {
    lines.push("disable-model-invocation: true");
  }
  lines.push("---", "", input.body);
  return lines.join("\n");
}

export function normalizeSkillCreateRequest(payload: Record<string, unknown>): NormalizedSkillCreateRequest {
  const row = toRecord(payload);
  const root = normalizeMemRoot(row.root || row.base || DEFAULT_SKILL_ROOT);
  const idSeed = String(row.id || "").trim() || String(row.name || "").trim();
  const id = normalizeSkillId(idSeed);
  if (!id) throw new Error("brain.skill.create 需要 id 或 name");

  const name = String(row.name || "").trim() || toNameFallback(id) || id;
  const description = String(row.description || "").trim();
  if (!description) throw new Error("brain.skill.create 需要 description");

  const body = normalizeBody(row.content ?? row.body ?? row.instructions, name);
  const source = String(row.source || "project").trim() || "project";
  const enabled = row.enabled !== false;
  const disableModelInvocation = row.disableModelInvocation === true;
  const replace = row.replace !== false;

  const skillDir = `${root}/${id}`;
  const location = `${skillDir}/SKILL.md`;
  const writes: SkillCreateWriteFile[] = [
    {
      path: location,
      content: buildSkillMarkdown({
        id,
        name,
        description,
        disableModelInvocation,
        body
      })
    }
  ];

  const extra = [
    ...collectGroupFiles(row.scripts, "scripts"),
    ...collectGroupFiles(row.references, "references"),
    ...collectGroupFiles(row.assets, "assets"),
    ...collectGroupFiles(row.files, "files")
  ];
  const seen = new Set<string>(["SKILL.md"]);
  for (const file of extra) {
    const rel = normalizeRelativePath(file.relativePath, "files.path");
    if (String(rel || "").toUpperCase() === "SKILL.MD") {
      throw new Error("brain.skill.create files 不允许覆盖 SKILL.md");
    }
    if (seen.has(rel)) {
      throw new Error(`brain.skill.create 文件重复: ${rel}`);
    }
    seen.add(rel);
    writes.push({
      path: `${skillDir}/${rel}`,
      content: file.content
    });
  }

  return {
    skill: {
      id,
      name,
      description,
      location,
      source,
      enabled,
      disableModelInvocation
    },
    replace,
    root,
    skillDir,
    writes
  };
}
