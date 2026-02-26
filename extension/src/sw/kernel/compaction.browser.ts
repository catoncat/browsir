import { approxTokenCount, type CompactionDraft, type SessionEntry } from "./types";

const DEFAULT_KEEP_TAIL = 30;
const DEFAULT_RESERVE_TOKENS = 16_384;

export interface ShouldCompactInput {
  overflow: boolean;
  entries: SessionEntry[];
  previousSummary: string;
  thresholdTokens: number;
}

export interface ShouldCompactResult {
  shouldCompact: boolean;
  reason: "overflow" | "threshold" | null;
  tokensBefore: number;
}

export interface FindCutPointInput {
  entries: SessionEntry[];
  keepTail?: number;
  splitTurn?: boolean;
}

export interface FindCutPointResult {
  cutIndex: number;
  firstKeptEntryId: string | null;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

export interface PrepareCompactionInput {
  reason: "overflow" | "threshold" | "manual";
  entries: SessionEntry[];
  previousSummary: string;
  keepTail?: number;
  splitTurn?: boolean;
  keepRecentTokens?: number;
  reserveTokens?: number;
}

interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface CompactionPreparation extends CompactionDraft {
  isSplitTurn: boolean;
  messagesToSummarize: ConversationMessage[];
  turnPrefixMessages: ConversationMessage[];
  keepRecentTokens: number;
  reserveTokens: number;
}

export interface CompactionSummaryRequest {
  mode: "history" | "turn_prefix";
  promptText: string;
  maxTokens: number;
}

export type CompactionSummaryGenerator = (input: CompactionSummaryRequest) => Promise<string>;

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

function normalizeSummary(text: string): string {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function entryToText(entry: SessionEntry): string {
  if (entry.type === "message") {
    return `[${entry.role}] ${entry.text}`;
  }
  if (entry.type === "compaction") {
    return `[compaction:${entry.reason}] ${entry.summary}`;
  }
  if (entry.type === "label") {
    return `[label] ${entry.label}`;
  }
  if (entry.type === "custom_message") {
    return `[${entry.level}] ${entry.text}`;
  }
  if (entry.type === "branch_summary") {
    return `[branch_summary] ${entry.summary}`;
  }
  return `[${entry.type}]`;
}

function estimateEntryTokens(entry: SessionEntry): number {
  return Math.max(1, approxTokenCount(entryToText(entry)));
}

function isTurnBoundaryMessage(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  return entry.role === "user" || entry.role === "system";
}

function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    const entry = entries[i];
    if (entry.type === "message") {
      if (entry.role === "tool") continue;
      cutPoints.push(i);
      continue;
    }
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i -= 1) {
    const entry = entries[i];
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      return i;
    }
    if (entry.type === "message" && entry.role === "user") {
      return i;
    }
  }
  return -1;
}

function findCutPointInRange(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
  splitTurn: boolean
): FindCutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    const firstKept = entries[startIndex];
    return {
      cutIndex: startIndex,
      firstKeptEntryId: firstKept?.id ?? null,
      turnStartIndex: -1,
      isSplitTurn: false
    };
  }

  let accumulated = 0;
  let cutIndex = cutPoints[0];

  for (let i = endIndex - 1; i >= startIndex; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    accumulated += estimateEntryTokens(entry);

    if (accumulated >= keepRecentTokens) {
      for (const candidate of cutPoints) {
        if (candidate >= i) {
          cutIndex = candidate;
          break;
        }
      }
      break;
    }
  }

  while (cutIndex > startIndex) {
    const prev = entries[cutIndex - 1];
    if (!prev) break;
    if (prev.type === "compaction" || prev.type === "message") break;
    cutIndex -= 1;
  }

  const cutEntry = entries[cutIndex];
  const boundary = cutEntry ? isTurnBoundaryMessage(cutEntry) : true;
  const turnStartIndex = boundary || !splitTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

  return {
    cutIndex,
    firstKeptEntryId: cutEntry?.id ?? null,
    turnStartIndex,
    isSplitTurn: !boundary && splitTurn && turnStartIndex !== -1
  };
}

function deriveKeepRecentTokens(entries: SessionEntry[], keepTail?: number, override?: number): number {
  const rawOverride = Number(override);
  if (Number.isFinite(rawOverride) && rawOverride > 0) {
    return Math.floor(rawOverride);
  }

  const tailSize = Math.max(1, Number(keepTail || DEFAULT_KEEP_TAIL));
  const tailEntries = entries.slice(Math.max(0, entries.length - tailSize));
  const estimated = tailEntries.reduce((sum, entry) => sum + estimateEntryTokens(entry), 0);
  return Math.max(1, estimated);
}

function toConversationMessage(entry: SessionEntry): ConversationMessage | null {
  if (entry.type === "message") {
    return {
      role: entry.role,
      content: String(entry.text || ""),
      toolName: entry.toolName
    };
  }
  if (entry.type === "custom_message") {
    return {
      role: "user",
      content: `[${entry.level}] ${entry.text}`
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "user",
      content: String(entry.summary || "")
    };
  }
  return null;
}

function serializeConversation(messages: ConversationMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const content = String(message.content || "").trim();
    if (!content) continue;
    if (message.role === "user") {
      parts.push(`[User]: ${content}`);
      continue;
    }
    if (message.role === "assistant") {
      parts.push(`[Assistant]: ${content}`);
      continue;
    }
    if (message.role === "tool") {
      parts.push(`[Tool result]: ${content}`);
      continue;
    }
    parts.push(`[System]: ${content}`);
  }
  return parts.join("\n\n");
}

function createFileOps(): FileOperations {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>()
  };
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractPathFromPayload(record: Record<string, unknown>): string {
  const args = record.args && typeof record.args === "object" && !Array.isArray(record.args) ? (record.args as Record<string, unknown>) : {};
  const path = String(args.path || record.path || "").trim();
  if (path) return path;

  const target = String(record.target || "");
  const m = target.match(/路径[：:]\s*([^\n]+)/);
  return m ? String(m[1] || "").trim() : "";
}

function extractFileOpsFromMessage(message: ConversationMessage, fileOps: FileOperations): void {
  if (message.role !== "tool") return;
  const payload = safeJsonParse(message.content);
  if (!payload) return;

  const toolName = String(payload.tool || message.toolName || "").trim().toLowerCase();
  if (!toolName) return;
  const path = extractPathFromPayload(payload);
  if (!path) return;

  if (toolName === "read" || toolName === "host_read_file" || toolName === "browser_read_file") {
    fileOps.read.add(path);
    return;
  }
  if (toolName === "write" || toolName === "host_write_file" || toolName === "browser_write_file") {
    fileOps.written.add(path);
    return;
  }
  if (toolName === "edit" || toolName === "host_edit_file" || toolName === "browser_edit_file") {
    fileOps.edited.add(path);
  }
}

function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.written, ...fileOps.edited]);
  const readOnly = [...fileOps.read].filter((path) => !modified.has(path)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

function buildSummaryPrompt(input: {
  messages: ConversationMessage[];
  previousSummary?: string;
  customInstructions?: string;
}): string {
  let basePrompt = input.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (input.customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${input.customInstructions}`;
  }

  const conversationText = serializeConversation(input.messages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (input.previousSummary) {
    promptText += `<previous-summary>\n${input.previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;
  return promptText;
}

function buildTurnPrefixPrompt(messages: ConversationMessage[]): string {
  const conversationText = serializeConversation(messages);
  return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}

export function shouldCompact(input: ShouldCompactInput): ShouldCompactResult {
  const body = input.entries.map((entry) => entryToText(entry)).join("\n");
  const tokensBefore = approxTokenCount(input.previousSummary) + approxTokenCount(body);

  if (input.overflow) {
    return {
      shouldCompact: true,
      reason: "overflow",
      tokensBefore
    };
  }

  if (tokensBefore >= input.thresholdTokens) {
    return {
      shouldCompact: true,
      reason: "threshold",
      tokensBefore
    };
  }

  return {
    shouldCompact: false,
    reason: null,
    tokensBefore
  };
}

export function findCutPoint(input: FindCutPointInput): FindCutPointResult {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  if (entries.length === 0) {
    return {
      cutIndex: 0,
      firstKeptEntryId: null,
      turnStartIndex: -1,
      isSplitTurn: false
    };
  }
  const keepRecentTokens = deriveKeepRecentTokens(entries, input.keepTail);
  return findCutPointInRange(entries, 0, entries.length, keepRecentTokens, input.splitTurn !== false);
}

export function prepareCompaction(input: PrepareCompactionInput): CompactionPreparation {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const previousSummary = normalizeSummary(input.previousSummary);
  const reserveTokens = Math.max(128, Math.floor(Number(input.reserveTokens || DEFAULT_RESERVE_TOKENS)));

  const tokensBefore = approxTokenCount(previousSummary) + approxTokenCount(entries.map((entry) => entryToText(entry)).join("\n"));
  if (entries.length === 0) {
    return {
      summary: previousSummary,
      firstKeptEntryId: null,
      previousSummary,
      keptEntries: [],
      droppedEntries: [],
      tokensBefore,
      tokensAfter: approxTokenCount(previousSummary),
      isSplitTurn: false,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      keepRecentTokens: deriveKeepRecentTokens(entries, input.keepTail, input.keepRecentTokens),
      reserveTokens
    };
  }

  let prevCompactionIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  const boundaryStart = prevCompactionIndex + 1;
  const boundaryEnd = entries.length;
  const keepRecentTokens = deriveKeepRecentTokens(entries.slice(boundaryStart, boundaryEnd), input.keepTail, input.keepRecentTokens);
  const cut = findCutPointInRange(entries, boundaryStart, boundaryEnd, keepRecentTokens, input.splitTurn !== false);

  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.cutIndex;

  const messagesToSummarize: ConversationMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i += 1) {
    const message = toConversationMessage(entries[i]);
    if (message) messagesToSummarize.push(message);
  }

  const turnPrefixMessages: ConversationMessage[] = [];
  if (cut.isSplitTurn) {
    for (let i = cut.turnStartIndex; i < cut.cutIndex; i += 1) {
      const message = toConversationMessage(entries[i]);
      if (message) turnPrefixMessages.push(message);
    }
  }

  const droppedEntries = entries.slice(0, cut.cutIndex);
  const keptEntries = entries.slice(cut.cutIndex);

  return {
    summary: previousSummary,
    firstKeptEntryId: cut.firstKeptEntryId,
    previousSummary,
    keptEntries,
    droppedEntries,
    tokensBefore,
    tokensAfter: approxTokenCount(previousSummary) + approxTokenCount(keptEntries.map((entry) => entryToText(entry)).join("\n")),
    isSplitTurn: cut.isSplitTurn,
    messagesToSummarize,
    turnPrefixMessages,
    keepRecentTokens,
    reserveTokens
  };
}

export async function compact(
  preparation: CompactionPreparation,
  generateSummary: CompactionSummaryGenerator,
  customInstructions?: string
): Promise<CompactionDraft> {
  const reserveTokens = Math.max(128, Math.floor(Number(preparation.reserveTokens || DEFAULT_RESERVE_TOKENS)));

  let summary = "";
  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    const [historyResult, turnPrefixResult] = await Promise.all([
      preparation.messagesToSummarize.length > 0
        ? generateSummary({
            mode: "history",
            promptText: buildSummaryPrompt({
              messages: preparation.messagesToSummarize,
              previousSummary: preparation.previousSummary,
              customInstructions
            }),
            maxTokens: Math.floor(0.8 * reserveTokens)
          })
        : Promise.resolve("No prior history."),
      generateSummary({
        mode: "turn_prefix",
        promptText: buildTurnPrefixPrompt(preparation.turnPrefixMessages),
        maxTokens: Math.floor(0.5 * reserveTokens)
      })
    ]);
    summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
  } else {
    summary = await generateSummary({
      mode: "history",
      promptText: buildSummaryPrompt({
        messages: preparation.messagesToSummarize,
        previousSummary: preparation.previousSummary,
        customInstructions
      }),
      maxTokens: Math.floor(0.8 * reserveTokens)
    });
  }

  const fileOps = createFileOps();
  for (const message of preparation.messagesToSummarize) {
    extractFileOpsFromMessage(message, fileOps);
  }
  for (const message of preparation.turnPrefixMessages) {
    extractFileOpsFromMessage(message, fileOps);
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  const withFileOps = `${String(summary || "")}${formatFileOperations(readFiles, modifiedFiles)}`;
  const normalized = normalizeSummary(withFileOps);

  const tokensAfter = approxTokenCount(normalized) + approxTokenCount(preparation.keptEntries.map((entry) => entryToText(entry)).join("\n"));

  return {
    summary: normalized,
    firstKeptEntryId: preparation.firstKeptEntryId,
    previousSummary: preparation.previousSummary,
    keptEntries: preparation.keptEntries,
    droppedEntries: preparation.droppedEntries,
    tokensBefore: preparation.tokensBefore,
    tokensAfter
  };
}
