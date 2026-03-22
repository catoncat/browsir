export interface ParsedSkillFrontmatter {
  id?: string;
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  warnings: string[];
}

function normalizePath(input: unknown): string {
  const raw = String(input || "")
    .trim()
    .replace(/\\/g, "/");
  const uriMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(raw);
  if (uriMatch) {
    const scheme = String(uriMatch[1] || "")
      .trim()
      .toLowerCase();
    let rest = String(uriMatch[2] || "")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/");
    if (rest.length > 1) {
      rest = rest.replace(/\/+$/g, "");
    }
    return `${scheme}://${rest}`;
  }

  let text = raw.replace(/\/+/g, "/");
  if (text.length > 1) {
    text = text.replace(/\/+$/g, "");
  }
  return text;
}

export function normalizeSkillId(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function trimQuotePair(text: string): string {
  const value = String(text || "").trim();
  if (!value) return value;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function parseFrontmatterBoolean(raw: string): boolean | undefined {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return undefined;
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  return undefined;
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const out: ParsedSkillFrontmatter = { warnings: [] };
  const lines = String(content || "").split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return out;

  const fields: Record<string, string> = {};
  let endLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    if (line.trim() === "---") {
      endLine = i;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([a-zA-Z0-9._-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    fields[match[1].toLowerCase()] = trimQuotePair(match[2]);
  }
  if (endLine < 0) {
    out.warnings.push("frontmatter 未闭合");
    return out;
  }

  const id = String(fields.id || "").trim();
  const name = String(fields.name || "").trim();
  const description = String(fields.description || "").trim();
  const disableRaw = String(
    fields["disable-model-invocation"] ||
      fields["disable_model_invocation"] ||
      fields["disablemodelinvocation"] ||
      "",
  ).trim();

  if (id) out.id = id;
  if (name) out.name = name;
  if (description) out.description = description;
  if (disableRaw) {
    const parsed = parseFrontmatterBoolean(disableRaw);
    if (parsed === undefined) {
      out.warnings.push("disable-model-invocation 不是布尔值");
    } else {
      out.disableModelInvocation = parsed;
    }
  }
  return out;
}
