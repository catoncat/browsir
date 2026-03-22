export const BUILTIN_SKILL_SEED_SESSION_ID = "__builtin_skill_seed__";
export const BUILTIN_SKILL_RESERVED_ERROR =
  "内置 skill 为系统保留，如需修改请复制为自定义 skill";

const BUILTIN_SKILL_ID_LIST = ["skill-authoring"] as const;
const BUILTIN_SKILL_ID_SET = new Set<string>(BUILTIN_SKILL_ID_LIST);

function normalizeSkillId(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeMemPath(input: unknown): string {
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

export function listBuiltinSkillIds(): string[] {
  return [...BUILTIN_SKILL_ID_LIST];
}

export function isBuiltinSkillId(value: unknown): boolean {
  const normalized = normalizeSkillId(value);
  return normalized ? BUILTIN_SKILL_ID_SET.has(normalized) : false;
}

export function isBuiltinSkillLocation(value: unknown): boolean {
  const normalized = normalizeMemPath(value);
  return (
    normalized === "mem://builtin-skills" ||
    normalized.startsWith("mem://builtin-skills/")
  );
}

export function isBuiltinSkillSeedSession(value: unknown): boolean {
  return String(value || "").trim() === BUILTIN_SKILL_SEED_SESSION_ID;
}
