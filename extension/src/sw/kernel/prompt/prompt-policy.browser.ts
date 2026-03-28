import { convertSessionContextMessagesToLlm, type SessionContextMessageLike } from "../llm-message-model.browser";
import type { SkillMetadata } from "../skill-registry";
import type { SessionMeta } from "../types";
import type {
  FilesystemInspectRuntime,
  FilesystemStatResult,
} from "../context-ref/filesystem-inspect.browser";
import type { ToolDefinition } from "../orchestrator.browser";

type JsonRecord = Record<string, unknown>;

const MAX_PROMPT_SKILL_ITEMS = 64;
const MAX_PROMPT_SKILL_DESCRIPTION_CHARS = 160;
const MAX_PROMPT_AVAILABLE_SKILLS_CHARS = 6000;
const PROMPT_SKILL_DESCRIPTION_MIN_CHARS = 24;
const PROMPT_SKILL_OVERFLOW_FOOTER_RESERVE_CHARS = 96;
const PROMPT_SKILL_QUERY_TERM_LIMIT = 24;
const PROMPT_SKILL_QUERY_TERM_MIN_CHARS = 2;
const PROMPT_SKILL_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "help",
  "how",
  "i",
  "in",
  "into",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "skill",
  "skills",
  "the",
  "to",
  "use",
  "with",
  "一个",
  "一些",
  "使用",
  "技能",
  "帮我",
  "查看",
  "继续",
  "以及",
  "还有",
  "需要",
  "相关",
  "这个",
  "那个",
]);

export interface PromptPolicyFilesystemInspect {
  stat(params: {
    sessionId: string;
    runtime: FilesystemInspectRuntime;
    path: string;
    cwd?: string;
  }): Promise<FilesystemStatResult>;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function buildSharedTabsContextMessage(sharedTabs: unknown): string {
  if (!Array.isArray(sharedTabs) || sharedTabs.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < sharedTabs.length; i += 1) {
    const item = toRecord(sharedTabs[i]);
    const title = String(item.title || "").trim() || "(untitled)";
    const url = String(item.url || "").trim() || "";
    const id = Number(item.id);
    const tabIdPart = Number.isInteger(id) ? ` [id=${id}]` : "";
    lines.push(
      `${i + 1}. ${title}${tabIdPart}${url ? `\n   URL: ${url}` : ""}`,
    );
  }
  return [
    "Shared tabs context (user-selected):",
    ...lines,
    "Use this context directly before deciding whether to call get_all_tabs/create_new_tab.",
    "For browser tasks, do not claim done until browser actions are verified.",
  ].join("\n");
}

function normalizePromptText(input: unknown): string {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function escapeXmlAttributeForPrompt(input: unknown): string {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clipPromptText(input: unknown, maxChars: number): string {
  const text = normalizePromptText(input);
  if (!text) return "";
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(maxChars);
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function clipPromptSkillDescription(
  input: unknown,
  maxChars = MAX_PROMPT_SKILL_DESCRIPTION_CHARS,
): string {
  return clipPromptText(input, maxChars);
}

function extractPromptQueryTerms(input: unknown): string[] {
  const text = normalizePromptText(input).toLowerCase();
  if (!text) return [];
  const matches = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const term = raw.trim();
    if (!term) continue;
    const isAsciiLike = /^[a-z0-9_-]+$/i.test(term);
    if (isAsciiLike && term.length < PROMPT_SKILL_QUERY_TERM_MIN_CHARS) continue;
    if (PROMPT_SKILL_STOP_WORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= PROMPT_SKILL_QUERY_TERM_LIMIT) break;
  }
  return out;
}

function scoreSkillForPrompt(
  skill: SkillMetadata,
  queryText: string,
  queryTerms: string[],
): number {
  const id = normalizePromptText(skill.id).toLowerCase();
  const name = normalizePromptText(skill.name).toLowerCase();
  const description = normalizePromptText(skill.description).toLowerCase();
  const location = normalizePromptText(skill.location).toLowerCase();
  const source = normalizePromptText(skill.source).toLowerCase();
  const searchCorpus = [id, name, description, location, source]
    .filter(Boolean)
    .join("\n");

  let score = 0;
  if (queryText) {
    if (id && queryText.includes(id)) score += 800;
    if (name && queryText.includes(name)) score += 900;
  }

  for (const term of queryTerms) {
    if (!term) continue;
    if (name.includes(term)) {
      score += 120;
      continue;
    }
    if (id.includes(term)) {
      score += 90;
      continue;
    }
    if (description.includes(term)) {
      score += 40;
      continue;
    }
    if (
      location.includes(term) ||
      source.includes(term) ||
      searchCorpus.includes(term)
    ) {
      score += 12;
    }
  }

  if (skill.source === "builtin") score += 8;
  if (skill.source === "project") score += 4;
  if (description) score += Math.max(0, 12 - Math.floor(description.length / 80));
  return score;
}

function rankSkillsForPrompt(
  skills: SkillMetadata[],
  queryText: string,
): SkillMetadata[] {
  const normalizedQueryText = normalizePromptText(queryText).toLowerCase();
  const queryTerms = extractPromptQueryTerms(normalizedQueryText);
  return [...skills].sort((a, b) => {
    const scoreDiff =
      scoreSkillForPrompt(b, normalizedQueryText, queryTerms) -
      scoreSkillForPrompt(a, normalizedQueryText, queryTerms);
    if (scoreDiff !== 0) return scoreDiff;
    const updatedAtDiff = String(b.updatedAt || "").localeCompare(
      String(a.updatedAt || ""),
    );
    if (updatedAtDiff !== 0) return updatedAtDiff;
    const byName = String(a.name || "").localeCompare(String(b.name || ""));
    if (byName !== 0) return byName;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

function buildPromptSkillLine(
  skill: SkillMetadata,
  descriptionChars: number,
): string {
  const attrs = [
    `id="${escapeXmlAttributeForPrompt(skill.id)}"`,
    `name="${escapeXmlAttributeForPrompt(skill.name)}"`,
  ];
  const description = clipPromptSkillDescription(
    skill.description,
    descriptionChars,
  );
  if (description) {
    attrs.push(`desc="${escapeXmlAttributeForPrompt(description)}"`);
  }
  if (skill.location) {
    attrs.push(`loc="${escapeXmlAttributeForPrompt(skill.location)}"`);
  }
  if (skill.source && skill.source !== "project") {
    attrs.push(`src="${escapeXmlAttributeForPrompt(skill.source)}"`);
  }
  return `  <skill ${attrs.join(" ")} />`;
}

export function buildAvailableSkillsSystemMessage(
  skills: SkillMetadata[],
  options?: { queryText?: string },
): string {
  const visible = (Array.isArray(skills) ? skills : []).filter(
    (item) => item && item.enabled && item.disableModelInvocation !== true,
  );
  if (!visible.length) return "";

  const ranked = rankSkillsForPrompt(visible, String(options?.queryText || ""));
  const candidates = ranked.slice(0, MAX_PROMPT_SKILL_ITEMS);
  const lines: string[] = [];
  let usedChars = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    const remainingCandidates = candidates.length - i;
    const remainingBudget = MAX_PROMPT_AVAILABLE_SKILLS_CHARS - usedChars;
    if (remainingBudget <= 0) break;
    const reserveForFooter =
      i < candidates.length - 1
        ? PROMPT_SKILL_OVERFLOW_FOOTER_RESERVE_CHARS
        : 0;
    const lineBudget = remainingBudget - reserveForFooter;
    if (lineBudget <= 0) break;

    const dynamicDescriptionBudget = Math.max(
      PROMPT_SKILL_DESCRIPTION_MIN_CHARS,
      Math.min(
        MAX_PROMPT_SKILL_DESCRIPTION_CHARS,
        Math.floor(lineBudget / Math.max(1, remainingCandidates)) - 72,
      ),
    );

    let line = buildPromptSkillLine(candidates[i], dynamicDescriptionBudget);
    if (line.length > lineBudget) {
      const overflow = line.length - lineBudget;
      const reducedDescriptionBudget = Math.max(
        0,
        dynamicDescriptionBudget - overflow - 8,
      );
      line = buildPromptSkillLine(candidates[i], reducedDescriptionBudget);
    }
    if (line.length > lineBudget) {
      if (lines.length > 0) break;
      line = buildPromptSkillLine(candidates[i], 0);
      if (line.length > lineBudget) break;
    }

    lines.push(line);
    usedChars += line.length + 1;
  }

  const omittedCount = ranked.length - lines.length;
  if (omittedCount > 0) {
    lines.push(`  <!-- truncated ${omittedCount} more skills -->`);
  }

  return [
    "Available skills are instruction resources (not executable sandboxes).",
    "When a skill is relevant, use browser_read_file (mem://) or host_read_file (host path) to load SKILL.md.",
    'Prompt schema: <available_skills schema="compact-v1"> with attrs id/name/desc/loc/src; src defaults to project when omitted.',
    '<available_skills schema="compact-v1">',
    ...lines,
    "</available_skills>",
  ].join("\n");
}

const EXTENSION_AGENT_PROMPT_TOOL_ORDER = [
  "browser_read_file",
  "browser_write_file",
  "browser_edit_file",
  "browser_bash",
  "host_read_file",
  "host_write_file",
  "host_edit_file",
  "host_bash",
  "get_all_tabs",
  "get_current_tab",
  "create_new_tab",
  "get_tab_info",
  "close_tab",
  "ungroup_tabs",
  "search_elements",
  "click",
  "fill_element_by_uid",
  "select_option_by_uid",
  "hover_element_by_uid",
  "get_editor_value",
  "press_key",
  "scroll_page",
  "navigate_tab",
  "fill_form",
  "computer",
  "get_page_metadata",
  "scroll_to_element",
  "highlight_element",
  "highlight_text_inline",
  "capture_screenshot",
  "capture_tab_screenshot",
  "capture_screenshot_with_highlight",
  "download_image",
  "download_chat_images",
  "list_interventions",
  "get_intervention_info",
  "request_intervention",
  "cancel_intervention",
  "create_skill",
  "load_skill",
  "execute_skill_script",
  "read_skill_reference",
  "get_skill_asset",
  "list_skills",
  "get_skill_info",
] as const;

const EXTENSION_AGENT_PROMPT_TOOL_DESCRIPTIONS: Record<string, string> = {
  browser_read_file:
    "Read file contents from browser sandbox FS (mem://). Use for virtual filesystem operations.",
  browser_write_file: "Create or overwrite files on browser sandbox FS.",
  browser_edit_file:
    "Patch browser sandbox files with exact replacements.",
  browser_bash:
    "Execute shell commands in browser sandbox runtime. Sandboxed Linux-like shell with 60+ commands (ls, grep, sed, awk, sort, find, tree, diff, tar, base64, bc). Supports pipes, redirects, variables, globs. No real network access, no host filesystem — use host_bash for system-level operations.",
  host_read_file: "Read file contents from host filesystem.",
  host_write_file: "Create or overwrite files on host filesystem.",
  host_edit_file:
    "Patch host files with exact replacements (and unified patch where supported).",
  host_bash: "Execute shell commands on host runtime via bridge. Use for npm/pip/git, real network access, and system-level operations.",
  get_all_tabs: "List currently open browser tabs.",
  get_current_tab: "Get the active browser tab context.",
  create_new_tab: "Open a new browser tab when task flow requires it.",
  get_tab_info: "Get detailed tab metadata by tabId.",
  close_tab: "Close a specific tab or current tab.",
  ungroup_tabs: "Ungroup tab groups in current window.",
  search_elements:
    "Capture accessibility-first page snapshot to discover actionable targets. Query should describe user-visible semantics (placeholder/aria/name/text).",
  click: "Click a specific page element by uid/ref/backendNodeId.",
  fill_element_by_uid:
    "Type/fill a specific page element by uid/ref/backendNodeId.",
  select_option_by_uid:
    "Select/set value on a selectable page element by uid/ref/backendNodeId.",
  hover_element_by_uid: "Hover a target element by uid/ref/backendNodeId.",
  get_editor_value:
    "Read full value from input/textarea/contenteditable/editor target.",
  press_key:
    "Press a keyboard key on active element (e.g. Enter/Escape/ArrowDown).",
  scroll_page: "Scroll page by deltaY pixels (positive=down, negative=up).",
  navigate_tab: "Navigate tab to target URL.",
  fill_form: "Fill multiple form fields in one structured call.",
  computer:
    "Coordinate-based browser interaction (click/hover/scroll/key/type/wait/drag).",
  get_page_metadata:
    "Read page metadata (title/url/description/keywords/author/og).",
  scroll_to_element:
    "Scroll target element into view by uid/ref/backendNodeId (selector is metadata fallback only).",
  highlight_element: "Highlight element for visual confirmation.",
  highlight_text_inline: "Highlight matched text under selector scope.",
  capture_screenshot: "Capture screenshot and return base64 data URL.",
  capture_tab_screenshot: "Capture screenshot for a specific tab id.",
  capture_screenshot_with_highlight:
    "Capture screenshot with optional highlight selector.",
  download_image: "Download data:image URL to local browser downloads.",
  download_chat_images: "Batch-download image parts from message payload.",
  list_interventions: "List available human intervention types.",
  get_intervention_info: "Read intervention schema/details by type.",
  request_intervention: "Request a human intervention task.",
  cancel_intervention: "Cancel a pending intervention request.",
  create_skill:
    "Create or update a skill package in mem://skills and register it atomically.",
  load_skill: "Load skill main content (SKILL.md).",
  execute_skill_script: "Execute script under a skill package.",
  read_skill_reference: "Read skill reference doc under references/.",
  get_skill_asset: "Read skill asset under assets/.",
  list_skills: "List installed skills.",
  get_skill_info: "Get detailed skill metadata.",
};

const BROWSER_AUTOMATION_DECISION_TREE = [
  "## Browser Automation Priority",
  "P1 search_elements: ALWAYS try first. Use semantic user-visible query (placeholder/label/text). Supports | for OR (e.g. 'Login | Sign in'). Change query strategy before blind repeat.",
  "P2 UID-based tools: Use uid/ref from latest search_elements for click/fill/hover/select/scroll_to. Never use selector as sole target. For typing, target editable elements only (input/textarea/contenteditable/role=textbox).",
  "P3 capture_screenshot + computer: ONLY after 2 failed search_elements with different queries, or for pixel-level interaction (canvas/drag/slider).",
  "Verify: For state-changing actions, verify with explicit expect (url/title/text/selector). Never claim done when verify failed/skipped/empty.",
  "Anti-patterns: No blind repeat (same query+selector). No blind click on toggles (read current state first). No invented selectors/URLs/tab state (re-observe when uncertain). If not typable, re-search with typing intent and switch target.",
  "Escalation: If search_elements returns no match, try broader query or different wording (2 attempts minimum). Only escalate to computer after exhausting P1+P2. If computer action fails verification, fall back to search_elements with fresh query.",
].join("\n");

const EXTENSION_AGENT_PROMPT_BASE_GUIDELINES = [
  "Use tools instead of guessing. Ground decisions in tool outputs.",
  "Default to browser sandbox (browser_*) for file/shell. Use host_* only when host-side access is explicitly needed.",
  "browser_bash paths MUST use mem:// protocol URIs (e.g. `ls mem://mydir`). Never use Unix paths like /mem or /tmp.",
  "Read before edit. Prefer *_edit_file for surgical changes; *_write_file for new files or full rewrites.",
  BROWSER_AUTOMATION_DECISION_TREE,
  "When tab context is ambiguous, query get_current_tab/get_all_tabs before acting.",
  "Be concise. Show key file paths, tab context, and blockers clearly.",
];

export function buildBrowserAgentSystemPromptBase(
  toolDefinitions: ToolDefinition[] = [],
  options?: { skipToolListing?: boolean },
): string {
  const guidelines = EXTENSION_AGENT_PROMPT_BASE_GUIDELINES.map(
    (line) => `- ${line}`,
  ).join("\n");

  if (options?.skipToolListing) {
    return [
      "You are an expert coding assistant operating inside Snowy (白雪), an open-source AI browser assistant.",
      "You help users by reading files, executing commands, editing code, writing files, and operating browser tabs.",
      "",
      "Environment:",
      "- Primary runtime is the browser sandbox (mem:// filesystem + browser_bash shell). Use browser_* tools for virtual file and shell operations.",
      "- Host filesystem and shell are available via host_* tools for system-level tasks (npm/pip/git, real network, host filesystem access).",
      "- Local WebSocket bridge is execution-only (file/shell proxy), not task planner.",
      "- You can operate live browser tabs via browser tools.",
      "",
      "Guidelines:",
      guidelines,
      "",
      "Runtime: Browser extension agent (Chrome MV3).",
    ].join("\n");
  }

  const dynamicToolLines = (
    Array.isArray(toolDefinitions) ? toolDefinitions : []
  )
    .map((def) => {
      const fn = toRecord(def.function);
      const name = String(fn.name || "").trim();
      if (!name) return "";
      const description =
        String(fn.description || "").trim() || "Use when needed.";
      return `- ${name}: ${description}`;
    })
    .filter(Boolean);
  const tools =
    dynamicToolLines.length > 0
      ? dynamicToolLines.join("\n")
      : EXTENSION_AGENT_PROMPT_TOOL_ORDER.map(
          (name) =>
            `- ${name}: ${EXTENSION_AGENT_PROMPT_TOOL_DESCRIPTIONS[name] || "Use when needed."}`,
        ).join("\n");
  return [
    "You are an expert coding assistant operating inside Snowy (白雪), an open-source AI browser assistant.",
    "You help users by reading files, executing commands, editing code, writing files, and operating browser tabs.",
    "",
    "Environment:",
    "- Primary runtime is the browser sandbox (mem:// filesystem + browser_bash shell). Use browser_* tools for virtual file and shell operations.",
    "- Host filesystem and shell are available via host_* tools for system-level tasks (npm/pip/git, real network, host filesystem access).",
    "- Local WebSocket bridge is execution-only (file/shell proxy), not task planner.",
    "- You can operate live browser tabs via browser tools.",
    "",
    "Available tools:",
    tools,
    "",
    "Guidelines:",
    guidelines,
    "",
    "Runtime: Browser extension agent (Chrome MV3).",
  ].join("\n");
}

export function buildTaskProgressSystemMessage(input: {
  llmStep: number;
  maxLoopSteps: number;
  toolStep: number;
  retryAttempt: number;
  retryMaxAttempts: number;
}): string {
  const llmStep = Math.max(1, Number(input.llmStep || 1));
  const maxLoopSteps = Math.max(1, Number(input.maxLoopSteps || 1));
  const toolStep = Math.max(0, Number(input.toolStep || 0));
  const retryAttempt = Math.max(0, Number(input.retryAttempt || 0));
  const retryMaxAttempts = Math.max(0, Number(input.retryMaxAttempts || 0));
  return [
    "Task progress (brief):",
    `- loop_step: ${llmStep}/${maxLoopSteps}`,
    `- tool_steps_done: ${toolStep}`,
    `- retry_state: ${retryAttempt}/${retryMaxAttempts}`,
    "- Keep moving toward the same user goal; avoid repeating already completed steps.",
  ].join("\n");
}

async function buildWorkingContextSystemMessage(input: {
  sessionId: string;
  meta: SessionMeta | null;
  filesystemInspect: PromptPolicyFilesystemInspect;
}): Promise<string> {
  const workingContext = input.meta?.header?.workingContext;
  const browserUserMount =
    String(workingContext?.browserUserMount || "/mem").trim() || "/mem";
  const browserCwd =
    String(workingContext?.browserCwd || "mem://").trim() || "mem://";
  const lines = [
    "Working context:",
    `- browser sandbox mount: ${browserUserMount} (canonical ${browserCwd})`,
  ];

  const hostCwd = String(workingContext?.hostCwd || "").trim();
  if (!hostCwd) {
    lines.push("- host relative paths: unavailable (current session has no hostCwd)");
    return lines.join("\n");
  }

  try {
    const stat = await input.filesystemInspect.stat({
      sessionId: input.sessionId,
      runtime: "host",
      path: hostCwd,
    });
    if (stat.exists && stat.type === "directory") {
      lines.push(`- host cwd: ${stat.path} (resolve ./ and ../ against this directory)`);
      return lines.join("\n");
    }
    if (!stat.exists) {
      lines.push(`- host relative paths: unavailable (${hostCwd} does not exist)`);
      return lines.join("\n");
    }
    lines.push(`- host relative paths: unavailable (${stat.path} is ${stat.type}, not a directory)`);
    return lines.join("\n");
  } catch {
    lines.push(`- host relative paths: unavailable (failed to inspect configured hostCwd: ${hostCwd})`);
    return lines.join("\n");
  }
}

export async function buildLlmMessagesFromContext(
  systemPrompt: string,
  meta: SessionMeta | null,
  contextMessages: SessionContextMessageLike[],
  availableSkillsPrompt = "",
  options: {
    sessionId: string;
    filesystemInspect?: PromptPolicyFilesystemInspect;
    actionFailures?: Map<string, number>;
  },
): Promise<JsonRecord[]> {
  const out: JsonRecord[] = [];
  const toolRetryPolicy = [
    "",
    "Tool retry policy:",
    "1) For transient tool errors (retryable=true), retry the same goal with adjusted parameters.",
    "2) host_bash/browser_bash support optional timeoutMs (milliseconds). Increase timeoutMs when timeout-related failures happen.",
    "3) For non-retryable errors, stop retrying and explain the blocker clearly.",
    "4) A short task progress note will be provided each round via system message.",
    "5) For browser tasks, prefer actions grounded in observed page state and tool results.",
    "6) Do not invent site selectors/URLs; re-observe when uncertain.",
    "7) Default to browser_* (sandbox) tools. Use host_* tools only when host-side access is explicitly required.",
    "8) Temporary policy: do NOT run tests (e.g., bun test/pnpm test/npm test/pytest/go test) unless the user explicitly requests tests.",
  ].join("\n");
  out.push({
    role: "system",
    content: `${systemPrompt}\n${toolRetryPolicy}`,
  });
  const metadata = toRecord(meta?.header?.metadata);
  const sharedTabsContext = buildSharedTabsContextMessage(metadata.sharedTabs);
  if (sharedTabsContext) {
    out.push({
      role: "system",
      content: sharedTabsContext,
    });
  }
  if (availableSkillsPrompt) {
    out.push({
      role: "system",
      content: availableSkillsPrompt,
    });
  }
  if (options.filesystemInspect) {
    const workingContextMessage = await buildWorkingContextSystemMessage({
      sessionId: options.sessionId,
      meta,
      filesystemInspect: options.filesystemInspect,
    });
    if (workingContextMessage) {
      out.push({
        role: "system",
        content: workingContextMessage,
      });
    }
  }

  const failures = options.actionFailures || new Map<string, number>();
  if (failures.size > 0) {
    const lines = ["Detected repetitive interaction failures for:"];
    for (const entry of Array.from(failures.entries())) {
      const [uid, count] = entry;
      if (count >= 2) {
        lines.push(
          `- element ${uid}: ${count} failures (verification failed).`,
        );
      }
    }
    if (lines.length > 1) {
      lines.push(
        "STRATEGY HINT: The current interaction path for these elements is not progressing the page state. DO NOT repeat the same action on these UIDs. Try a different anchor (child/parent), or use coordinate-based 'computer' tool, or re-search with a different query.",
      );
      out.push({
        role: "system",
        content: lines.join("\n"),
      });
    }
  }

  out.push(...convertSessionContextMessagesToLlm(contextMessages));

  if (out.filter((item) => String(item.role || "") !== "system").length === 0) {
    out.push({ role: "user", content: "继续当前任务。" });
  }

  return out;
}
