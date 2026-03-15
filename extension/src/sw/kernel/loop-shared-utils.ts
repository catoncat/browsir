/**
 * Pure utility functions shared across the runtime-loop module family.
 * Extracted from runtime-loop.browser.ts to break circular dependencies.
 */
import type { ToolContract } from "./orchestrator.browser";
import type { CapabilityExecutionPolicy, StepVerifyPolicy } from "./capability-policy";
import type { ExecuteMode } from "./orchestrator.browser";
import type { RuntimeInfraHandler } from "./runtime-infra.browser";
import {
  MAX_DEBUG_CHARS,
  CANONICAL_BROWSER_TOOL_NAMES,
  type RuntimeErrorWithMeta,
  type ToolCallItem,
  type BashExecOutcome,
} from "./loop-shared-types";
import type { JsonRecord } from "./types";

// ── JSON helpers ────────────────────────────────────────────────────

export function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

export function safeJsonParse(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
}

export function isPlainJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── Text / stringify / hash ─────────────────────────────────────────

export function clipText(input: unknown, maxChars = MAX_DEBUG_CHARS): string {
  const text = String(input || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...<truncated:${text.length - maxChars}>`;
}

export function safeStringify(input: unknown, maxChars = 9000): string {
  let text = "";
  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return clipText(text, maxChars);
}

export function stableHash(input: unknown): string {
  const text = String(input || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Number helpers ──────────────────────────────────────────────────

export function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function normalizeIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

// ── Error helpers ───────────────────────────────────────────────────

export function asRuntimeErrorWithMeta(error: unknown): RuntimeErrorWithMeta {
  if (error instanceof Error) return error as RuntimeErrorWithMeta;
  return new Error(String(error)) as RuntimeErrorWithMeta;
}

export function normalizeErrorCode(code: unknown): string {
  return String(code || "")
    .trim()
    .toUpperCase();
}

// ── Schema normalization ────────────────────────────────────────────

const FORBIDDEN_TOP_LEVEL_TOOL_SCHEMA_KEYS = [
  "oneOf",
  "anyOf",
  "allOf",
  "enum",
  "not",
] as const;

export function normalizeSchemaRequiredList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const value = String(item || "").trim();
    if (!value || dedup.has(value)) continue;
    dedup.add(value);
    out.push(value);
  }
  return out;
}

function normalizeTopLevelSchemaCombiner(raw: unknown): JsonRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => toRecord(item))
    .filter((item) => Object.keys(item).length > 0);
}

export function readTopLevelConstraintRequiredSets(raw: unknown): string[][] {
  const clauses = normalizeTopLevelSchemaCombiner(raw);
  const out: string[][] = [];
  for (const clause of clauses) {
    const required = normalizeSchemaRequiredList(clause.required);
    if (required.length > 0) out.push(required);
  }
  return out;
}

function formatConstraintRequiredSet(input: string[]): string {
  if (input.length === 1) return input[0];
  return input.join(" + ");
}

function buildTopLevelSchemaConstraintHint(
  parameters: unknown,
  providerId: string,
): string {
  const provider = String(providerId || "")
    .trim()
    .toLowerCase();
  if (provider !== "openai_compatible") return "";
  const schema = toRecord(parameters);
  const fragments: string[] = [];
  const topLevelRequired = normalizeSchemaRequiredList(schema.required);
  if (topLevelRequired.length > 0) {
    fragments.push(`required: ${topLevelRequired.join(", ")}`);
  }
  const combinators: Array<"anyOf" | "oneOf" | "allOf"> = [
    "anyOf",
    "oneOf",
    "allOf",
  ];
  for (const key of combinators) {
    const requiredSets = readTopLevelConstraintRequiredSets(schema[key]);
    if (requiredSets.length === 0) continue;
    const formatted = requiredSets
      .map((set) => `(${formatConstraintRequiredSet(set)})`)
      .join(" | ");
    fragments.push(`${key}: ${formatted}`);
  }
  if (fragments.length === 0) return "";
  return `Schema constraint hints: ${fragments.join("; ")}.`;
}

function appendConstraintHintToDescription(
  description: string,
  hint: string,
): string {
  const base = String(description || "").trim();
  const extra = String(hint || "").trim();
  if (!extra) return base;
  if (!base) return extra;
  return `${base}\n${extra}`;
}

function sanitizeTopLevelToolSchemaForProvider(
  parameters: unknown,
  providerId: string,
): JsonRecord {
  const schema = toRecord(parameters);
  const provider = String(providerId || "")
    .trim()
    .toLowerCase();
  if (provider !== "openai_compatible") {
    return {
      ...schema,
    };
  }

  const sanitized: JsonRecord = {
    ...schema,
    type: "object",
    properties: toRecord(schema.properties),
    required: normalizeSchemaRequiredList(schema.required),
  };

  for (const key of FORBIDDEN_TOP_LEVEL_TOOL_SCHEMA_KEYS) {
    delete sanitized[key];
  }

  sanitizeNestedSchemas(sanitized);

  return sanitized;
}

function sanitizeNestedSchemas(schema: JsonRecord): void {
  const props = toRecord(schema.properties);
  for (const key of Object.keys(props)) {
    const prop = toRecord(props[key]);
    if (!prop || typeof prop !== "object") continue;

    if (prop.type === "array" && prop.items) {
      const items = toRecord(prop.items);
      for (const fk of FORBIDDEN_TOP_LEVEL_TOOL_SCHEMA_KEYS) {
        delete items[fk];
      }
      sanitizeNestedSchemas(items);
      prop.items = items;
    }

    if (prop.type === "object") {
      for (const fk of FORBIDDEN_TOP_LEVEL_TOOL_SCHEMA_KEYS) {
        delete prop[fk];
      }
      sanitizeNestedSchemas(prop);
    }

    props[key] = prop;
  }
  schema.properties = props;
}

export function sanitizeLlmToolDefinitionForProvider(
  definition: unknown,
  providerId: string,
): JsonRecord {
  const def = toRecord(definition);
  const fn = toRecord(def.function);
  const constraintHint = buildTopLevelSchemaConstraintHint(
    fn.parameters,
    providerId,
  );
  return {
    ...def,
    type: "function",
    function: {
      ...fn,
      name: String(fn.name || "").trim(),
      description: appendConstraintHintToDescription(
        String(fn.description || ""),
        constraintHint,
      ),
      parameters: sanitizeTopLevelToolSchemaForProvider(
        fn.parameters,
        providerId,
      ),
    },
  };
}

// ── Contract reading ────────────────────────────────────────────────

export function readContractExecution(contract: ToolContract | null): {
  capability: string;
  mode?: ExecuteMode;
  action?: string;
  verifyPolicy?: StepVerifyPolicy;
} | null {
  if (!contract?.execution) return null;
  const capability = String(contract.execution.capability || "").trim();
  if (!capability) return null;
  const modeRaw = String(contract.execution.mode || "").trim();
  const mode =
    modeRaw === "script" || modeRaw === "cdp" || modeRaw === "bridge"
      ? modeRaw
      : undefined;
  const action = String(contract.execution.action || "").trim() || undefined;
  const verifyRaw = String(contract.execution.verifyPolicy || "").trim();
  const verifyPolicy =
    verifyRaw === "off" || verifyRaw === "on_critical" || verifyRaw === "always"
      ? (verifyRaw as StepVerifyPolicy)
      : undefined;
  return {
    capability,
    ...(mode ? { mode } : {}),
    ...(action ? { action } : {}),
    ...(verifyPolicy ? { verifyPolicy } : {}),
  };
}

// ── Tool call normalization ─────────────────────────────────────────

export function normalizeToolCalls(rawToolCalls: unknown): ToolCallItem[] {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls
    .map((item, index) => {
      const row = toRecord(item);
      const fn = toRecord(row.function);
      const name = String(fn.name || "").trim();
      if (!name) return null;
      const argsText =
        typeof fn.arguments === "string"
          ? fn.arguments
          : safeStringify(fn.arguments || {});
      return {
        id: String(row.id || `toolcall-${index + 1}`),
        type: "function" as const,
        function: {
          name,
          arguments: argsText,
        },
      };
    })
    .filter((item): item is ToolCallItem => item !== null);
}

function sortJsonForSignature(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) => sortJsonForSignature(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    out[key] = sortJsonForSignature(source[key]);
  }
  return out;
}

export function normalizeToolArgsForSignature(rawArgs: unknown): string {
  const text = String(rawArgs || "").trim();
  if (!text) return "{}";
  const parsed = safeJsonParse(text);
  if (parsed !== null) {
    return clipText(safeStringify(sortJsonForSignature(parsed), 1200), 1200);
  }
  return clipText(text.replace(/\s+/g, " "), 1200);
}

// ── Verify helpers ──────────────────────────────────────────────────

export function normalizeVerifyExpect(raw: unknown): JsonRecord | null {
  const source = toRecord(raw);
  const out: JsonRecord = {};
  if (typeof source.urlContains === "string" && source.urlContains.trim())
    out.urlContains = source.urlContains.trim();
  if (typeof source.titleContains === "string" && source.titleContains.trim())
    out.titleContains = source.titleContains.trim();
  if (typeof source.textIncludes === "string" && source.textIncludes.trim())
    out.textIncludes = source.textIncludes.trim();
  if (typeof source.selectorExists === "string" && source.selectorExists.trim())
    out.selectorExists = source.selectorExists.trim();
  if (source.urlChanged === true) out.urlChanged = true;
  if (typeof source.previousUrl === "string" && source.previousUrl.trim())
    out.previousUrl = source.previousUrl.trim();
  return Object.keys(out).length > 0 ? out : null;
}

// ── Search element helpers ──────────────────────────────────────────

const SEARCH_ELEMENTS_INTERACTIVE_INTENT_TOKENS = [
  "input",
  "textarea",
  "textbox",
  "searchbox",
  "combobox",
  "editable",
  "contenteditable",
  "type",
  "fill",
  "write",
  "prompt",
  "compose",
  "composer",
  "send",
  "输入",
  "输入框",
  "键入",
  "可编辑",
  "发送",
];

export function inferSearchElementsFilter(
  queryRaw: string,
): "all" | "interactive" {
  const needles = String(queryRaw || "")
    .trim()
    .toLowerCase()
    .split("|")
    .flatMap((group) => group.trim().split(/\s+/))
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    needles.some((needle) =>
      SEARCH_ELEMENTS_INTERACTIVE_INTENT_TOKENS.some(
        (token) => needle.includes(token) || token.includes(needle),
      ),
    )
  ) {
    return "interactive";
  }
  return "all";
}

export function scoreSearchNode(
  node: JsonRecord,
  needles: string[],
): { score: number; matchedNeedles: number } {
  if (needles.length === 0) return { score: 0, matchedNeedles: 0 };
  const role = String(node.role || "").toLowerCase();
  const tag = String(node.tag || "").toLowerCase();
  const name = String(node.name || "").toLowerCase();
  const value = String(node.value || "").toLowerCase();
  const placeholder = String(node.placeholder || "").toLowerCase();
  const ariaLabel = String(node.ariaLabel || "").toLowerCase();
  const selector = String(node.selector || "").toLowerCase();
  const haystack = [
    role,
    tag,
    name,
    value,
    placeholder,
    ariaLabel,
    selector,
  ].join(" ");

  let score = 0;
  let matchedNeedles = 0;
  for (const needle of needles) {
    if (!needle) continue;
    let hit = false;

    const exactInPrimary = [placeholder, ariaLabel, name].some(
      (item) => item === needle,
    );
    if (exactInPrimary) {
      score += 42;
      hit = true;
    }

    const startsInPrimary = [placeholder, ariaLabel, name].some((item) =>
      item.startsWith(needle),
    );
    if (startsInPrimary) {
      score += 24;
      hit = true;
    }

    const containsInPrimary = [placeholder, ariaLabel, name].some((item) =>
      item.includes(needle),
    );
    if (containsInPrimary) {
      score += 16;
      hit = true;
    }

    if (selector.includes(needle)) {
      score += 12;
      hit = true;
    }

    if (role === needle || tag === needle) {
      score += 16;
      hit = true;
    } else if (role.includes(needle) || tag.includes(needle)) {
      score += 8;
      hit = true;
    }

    if (value.includes(needle)) {
      score += 6;
      hit = true;
    }

    if (!hit && haystack.includes(needle)) {
      score += 3;
      hit = true;
    }

    if (hit) matchedNeedles += 1;
  }

  if (["input", "textarea", "button", "a", "select"].includes(tag)) score += 6;
  if (["textbox", "searchbox", "button", "link", "combobox"].includes(role))
    score += 6;
  if (node.focused === true) score += 2;
  if (node.disabled === true) score -= 20;
  if (
    selector.includes("[data-testid=") ||
    selector.includes("[aria-label=") ||
    selector.includes("[placeholder=")
  ) {
    score += 2;
  }
  const editable = node.editable === true;
  const typingIntent = needles.some((needle) =>
    [
      "input",
      "textarea",
      "textbox",
      "text",
      "type",
      "fill",
      "write",
      "compose",
      "edit",
      "输入",
      "文本",
      "回复",
      "comment",
    ].some((token) => needle.includes(token) || token.includes(needle)),
  );
  if (typingIntent) {
    const looksTypable =
      editable ||
      ["input", "textarea"].includes(tag) ||
      ["textbox", "searchbox", "combobox"].includes(role) ||
      selector.includes("contenteditable");
    if (looksTypable) score += 28;
    if ((role === "div" || !role) && tag === "div") score -= 18;
    if (selector.includes("_label") || selector.includes("label")) score -= 18;
    if (role === "button") score -= 12;
  }
  return { score, matchedNeedles };
}

/**
 * Parse a search query with `|` OR groups.
 * "Login | Sign in | 登录" → [["login"], ["sign", "in"], ["登录"]]
 * Each inner array is an AND group of needles.
 */
export function parseSearchQuery(query: string): string[][] {
  return query
    .split("|")
    .map((group) =>
      group
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    )
    .filter((group) => group.length > 0);
}

/**
 * Score a node against OR groups. Returns the best score across all groups.
 */
export function scoreSearchNodeWithOrGroups(
  node: JsonRecord,
  orGroups: string[][],
): { score: number; matchedNeedles: number } {
  if (orGroups.length === 0) return { score: 0, matchedNeedles: 0 };
  let bestScore = 0;
  let bestMatched = 0;
  for (const group of orGroups) {
    const result = scoreSearchNode(node, group);
    if (result.score > bestScore) {
      bestScore = result.score;
      bestMatched = result.matchedNeedles;
    }
  }
  return { score: bestScore, matchedNeedles: bestMatched };
}

// ── Tab / infra helpers ─────────────────────────────────────────────

export async function queryAllTabsForRuntime(): Promise<
  Array<{
    id: number;
    windowId: number;
    index: number;
    active: boolean;
    pinned: boolean;
    title: string;
    url: string;
  }>
> {
  const tabs = await chrome.tabs.query({});
  return (tabs || [])
    .filter((tab) => Number.isInteger(tab?.id))
    .map((tab) => ({
      id: Number(tab.id),
      windowId: Number(tab.windowId || 0),
      index: Number(tab.index || 0),
      active: tab.active === true,
      pinned: tab.pinned === true,
      title: String(tab.title || ""),
      url: String(tab.url || tab.pendingUrl || ""),
    }));
}

export async function getActiveTabIdForRuntime(): Promise<number | null> {
  const isRestricted = (url: string) => {
    const u = url.toLowerCase();
    return (
      u.startsWith("chrome://") ||
      u.startsWith("about:") ||
      u.startsWith("edge://") ||
      u.startsWith("chrome-extension://") ||
      u.includes("chrome.google.com/webstore")
    );
  };

  const focused = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const active = focused.find((tab) => Number.isInteger(tab?.id));
  if (active?.id && active.url && !isRestricted(active.url))
    return Number(active.id);

  const all = await chrome.tabs.query({}).catch(() => []);
  const valid = all.find(
    (tab) => Number.isInteger(tab.id) && tab.url && !isRestricted(tab.url),
  );
  if (valid?.id) return Number(valid.id);

  return active?.id ? Number(active.id) : all[0]?.id ? Number(all[0].id) : null;
}

export function readSharedTabIds(sharedTabs: unknown): number[] {
  if (!Array.isArray(sharedTabs)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of sharedTabs) {
    const id = parsePositiveInt(toRecord(item).id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function callInfra(
  infra: RuntimeInfraHandler,
  message: JsonRecord,
): Promise<JsonRecord> {
  const result = await infra.handleMessage(message);
  if (!result) {
    const error = new Error(
      `unsupported infra message: ${String(message.type || "")}`,
    ) as RuntimeErrorWithMeta;
    error.code = "E_INFRA_UNSUPPORTED";
    throw error;
  }
  if (!result.ok) {
    const error = new Error(
      String(result.error || "infra call failed"),
    ) as RuntimeErrorWithMeta;
    const resultWithMeta = result as {
      code?: unknown;
      details?: unknown;
      retryable?: unknown;
      status?: unknown;
    };
    if (typeof resultWithMeta.code === "string" && resultWithMeta.code.trim()) {
      error.code = resultWithMeta.code.trim();
    }
    if (resultWithMeta.details !== undefined) {
      error.details = resultWithMeta.details;
    }
    if (typeof resultWithMeta.retryable === "boolean") {
      error.retryable = resultWithMeta.retryable;
    }
    if (Number.isFinite(Number(resultWithMeta.status))) {
      error.status = Number(resultWithMeta.status);
    }
    throw error;
  }
  return toRecord(result.data);
}

// ── LLM config extraction ───────────────────────────────────────────

import {
  normalizeBrowserRuntimeStrategy,
} from "./browser-runtime-strategy";
import { normalizeCompactionSettings } from "../../shared/compaction";
import type { BridgeConfig } from "./runtime-infra.browser";
import {
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  MIN_LLM_TIMEOUT_MS,
  MAX_LLM_TIMEOUT_MS,
  DEFAULT_LLM_MAX_RETRY_DELAY_MS,
  MIN_LLM_MAX_RETRY_DELAY_MS,
  MAX_LLM_MAX_RETRY_DELAY_MS,
  MAX_LLM_RETRIES,
} from "./loop-shared-types";

export function extractLlmConfig(raw: JsonRecord): BridgeConfig {
  return {
    bridgeUrl: String(raw.bridgeUrl || ""),
    bridgeToken: String(raw.bridgeToken || ""),
    browserRuntimeStrategy: normalizeBrowserRuntimeStrategy(
      raw.browserRuntimeStrategy,
      "browser-first",
    ),
    compaction: normalizeCompactionSettings(raw.compaction),
    llmDefaultProfile: String(raw.llmDefaultProfile || "default"),
    llmAuxProfile: String(raw.llmAuxProfile || ""),
    llmFallbackProfile: String(raw.llmFallbackProfile || ""),
    llmProfiles: raw.llmProfiles,
    llmSystemPromptCustom: String(raw.llmSystemPromptCustom || ""),
    maxSteps: normalizeIntInRange(raw.maxSteps, 100, 1, 500),
    autoTitleInterval: normalizeIntInRange(raw.autoTitleInterval, 10, 0, 100),
    bridgeInvokeTimeoutMs: normalizeIntInRange(
      raw.bridgeInvokeTimeoutMs,
      DEFAULT_BASH_TIMEOUT_MS,
      1_000,
      MAX_BASH_TIMEOUT_MS,
    ),
    llmTimeoutMs: normalizeIntInRange(
      raw.llmTimeoutMs,
      DEFAULT_LLM_TIMEOUT_MS,
      MIN_LLM_TIMEOUT_MS,
      MAX_LLM_TIMEOUT_MS,
    ),
    llmRetryMaxAttempts: normalizeIntInRange(
      raw.llmRetryMaxAttempts,
      MAX_LLM_RETRIES,
      0,
      6,
    ),
    llmMaxRetryDelayMs: normalizeIntInRange(
      raw.llmMaxRetryDelayMs,
      DEFAULT_LLM_MAX_RETRY_DELAY_MS,
      MIN_LLM_MAX_RETRY_DELAY_MS,
      MAX_LLM_MAX_RETRY_DELAY_MS,
    ),
    devAutoReload: raw.devAutoReload === true,
    devReloadIntervalMs: Number(raw.devReloadIntervalMs || 1500),
  };
}

// ── Misc ────────────────────────────────────────────────────────────

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
