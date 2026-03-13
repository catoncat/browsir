type JsonRecord = Record<string, unknown>;

export type ContextRefSource =
  | "composer_mention"
  | "prompt_parser"
  | "system_prompt"
  | "skill_reference";

export type ContextRefSyntax =
  | "host_absolute"
  | "host_home"
  | "host_relative"
  | "browser_mount"
  | "browser_canonical_invalid";

export interface PromptContextRefInput {
  id: string;
  raw: string;
  displayPath: string;
  source: ContextRefSource;
  syntax: ContextRefSyntax;
  runtimeHint: "host" | "browser" | "invalid";
  locator: string;
  error?: string;
}

export type ContextRefTarget =
  | { runtime: "host"; path: string }
  | { runtime: "browser"; uri: string };

export interface ResolvedContextRef {
  id: string;
  raw: string;
  displayPath: string;
  source: ContextRefSource;
  target: ContextRefTarget | null;
  kind: "file" | "directory" | "binary" | "missing" | "invalid";
  sizeBytes?: number;
  mtimeMs?: number;
  error?: string;
}

export interface MaterializedContextRef {
  refId: string;
  mode: "full" | "excerpt" | "index" | "metadata_only" | "error";
  summary?: string;
  content?: string;
  truncated?: boolean;
}

export interface ExtractPromptContextRefsResult {
  refs: PromptContextRefInput[];
  cleanedText: string;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function hashFNV1a(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function buildContextRefId(seed: string, index: number): string {
  return `ctx_${hashFNV1a(`${seed}:${index}`)}`;
}

function trimTrailingContextRefPunctuation(input: string): {
  token: string;
  trailing: string;
} {
  const source = String(input || "");
  const match = /^(.*?)([,\.;:!\?\)\]\}，。；：！？）】》」』]+)?$/.exec(source);
  if (!match) return { token: source, trailing: "" };
  return {
    token: String(match[1] || ""),
    trailing: String(match[2] || ""),
  };
}

function normalizeSpacingAroundRemovedRefs(input: string): string {
  return String(input || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function classifyContextRefToken(
  rawToken: string,
  source: ContextRefSource,
  index: number,
): PromptContextRefInput | null {
  const token = String(rawToken || "").trim();
  if (!token.startsWith("@")) return null;
  const pathText = token.slice(1);
  if (!pathText) return null;

  if (/^mem:\/\//i.test(pathText)) {
    return {
      id: buildContextRefId(token, index),
      raw: token,
      displayPath: pathText,
      source,
      syntax: "browser_canonical_invalid",
      runtimeHint: "invalid",
      locator: pathText,
      error: "浏览器沙盒路径请使用 @/mem/..., 不要使用 @mem://...",
    };
  }

  if (pathText.startsWith("/mem/")) {
    return {
      id: buildContextRefId(token, index),
      raw: token,
      displayPath: pathText,
      source,
      syntax: "browser_mount",
      runtimeHint: "browser",
      locator: `mem://${pathText.slice("/mem/".length)}`,
    };
  }

  if (pathText.startsWith("/")) {
    return {
      id: buildContextRefId(token, index),
      raw: token,
      displayPath: pathText,
      source,
      syntax: "host_absolute",
      runtimeHint: "host",
      locator: pathText,
    };
  }

  if (pathText === "~" || pathText.startsWith("~/")) {
    return {
      id: buildContextRefId(token, index),
      raw: token,
      displayPath: pathText,
      source,
      syntax: "host_home",
      runtimeHint: "host",
      locator: pathText,
    };
  }

  if (pathText.startsWith("./") || pathText.startsWith("../")) {
    return {
      id: buildContextRefId(token, index),
      raw: token,
      displayPath: pathText,
      source,
      syntax: "host_relative",
      runtimeHint: "host",
      locator: pathText,
    };
  }

  return null;
}

export function isPathLikeMentionQuery(input: string): boolean {
  const text = String(input || "").trim();
  return (
    text.startsWith("/") ||
    text.startsWith("./") ||
    text.startsWith("../") ||
    text.startsWith("~") ||
    /^mem:\/\//i.test(text)
  );
}

export function extractPromptContextRefs(
  text: string,
  source: ContextRefSource = "prompt_parser",
): ExtractPromptContextRefsResult {
  const original = String(text || "");
  const refs: PromptContextRefInput[] = [];
  const out: string[] = [];
  const tokenPattern =
    /@mem:\/\/[^\s,，。；：！？!?\)\]\}]+|@[^\s,，。；：！？!?:;\)\]\}]+/g;
  let cursor = 0;
  let matchIndex = 0;

  for (const match of original.matchAll(tokenPattern)) {
    const rawCandidate = String(match[0] || "");
    const start = Number(match.index || 0);
    const prevChar = start > 0 ? original[start - 1] : "";
    if (prevChar && !/\s/.test(prevChar)) continue;

    const { token, trailing } = trimTrailingContextRefPunctuation(rawCandidate);
    const parsed = classifyContextRefToken(token, source, matchIndex + 1);
    if (!parsed) continue;
    out.push(original.slice(cursor, start));
    if (
      trailing &&
      out.length > 0 &&
      /[ \t]$/.test(out[out.length - 1])
    ) {
      out[out.length - 1] = out[out.length - 1].replace(/[ \t]+$/, "");
    }
    if (trailing) out.push(trailing);
    cursor = start + rawCandidate.length;
    refs.push(parsed);
    matchIndex += 1;
  }

  out.push(original.slice(cursor));

  return {
    refs: dedupePromptContextRefs(refs),
    cleanedText: normalizeSpacingAroundRemovedRefs(out.join("")),
  };
}

export function normalizePromptContextRefs(input: unknown): PromptContextRefInput[] {
  if (!Array.isArray(input)) return [];
  const out: PromptContextRefInput[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const row = toRecord(input[i]);
    const raw = String(row.raw || "").trim();
    const displayPath = String(row.displayPath || "").trim();
    const locator = String(row.locator || "").trim();
    const sourceRaw = String(row.source || "").trim();
    const source: ContextRefSource =
      sourceRaw === "composer_mention" ||
      sourceRaw === "prompt_parser" ||
      sourceRaw === "system_prompt" ||
      sourceRaw === "skill_reference"
        ? sourceRaw
        : "prompt_parser";
    const syntaxRaw = String(row.syntax || "").trim();
    const syntax: ContextRefSyntax =
      syntaxRaw === "host_absolute" ||
      syntaxRaw === "host_home" ||
      syntaxRaw === "host_relative" ||
      syntaxRaw === "browser_mount" ||
      syntaxRaw === "browser_canonical_invalid"
        ? syntaxRaw
        : "host_absolute";
    const runtimeHintRaw = String(row.runtimeHint || "").trim();
    const runtimeHint: "host" | "browser" | "invalid" =
      runtimeHintRaw === "browser"
        ? "browser"
        : runtimeHintRaw === "invalid"
          ? "invalid"
          : "host";
    if (!raw || !displayPath || !locator) continue;
    out.push({
      id: String(row.id || buildContextRefId(raw, i + 1)).trim(),
      raw,
      displayPath,
      source,
      syntax,
      runtimeHint,
      locator,
      error: String(row.error || "").trim() || undefined,
    });
  }
  return dedupePromptContextRefs(out);
}

export function dedupePromptContextRefs(
  refs: PromptContextRefInput[],
): PromptContextRefInput[] {
  const out: PromptContextRefInput[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = [
      ref.source,
      ref.raw,
      ref.displayPath,
      ref.runtimeHint,
      ref.locator,
      ref.syntax,
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export function rewritePromptWithContextRefPlaceholders(
  prompt: string,
  refs: Array<Pick<PromptContextRefInput, "raw" | "id">>,
): string {
  let next = String(prompt || "");
  for (const ref of refs) {
    const raw = String(ref.raw || "").trim();
    if (!raw) continue;
    next = next.split(raw).join(`[ref:${String(ref.id || "").trim()}]`);
  }
  return normalizeSpacingAroundRemovedRefs(next);
}

export function formatPromptContextRefSummary(
  refs: Array<Pick<PromptContextRefInput, "displayPath">>,
): string {
  const displayPaths = refs
    .map((ref) => String(ref.displayPath || "").trim())
    .filter((item) => item.length > 0);
  if (displayPaths.length === 0) return "";
  return displayPaths.map((item) => `@${item}`).join(" ");
}
