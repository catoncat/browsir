import { approxTokenCount, type CompactionDraft, type SessionEntry } from "./types";

const DEFAULT_KEEP_TAIL = 14;
const DEFAULT_SUMMARY_MAX_CHARS = 1800;

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
}

export interface PrepareCompactionInput {
  reason: "overflow" | "threshold" | "manual";
  entries: SessionEntry[];
  previousSummary: string;
  keepTail?: number;
  splitTurn?: boolean;
  maxSummaryChars?: number;
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
  return `[${entry.type}]`;
}

function joinForSummary(entries: SessionEntry[], limit = DEFAULT_SUMMARY_MAX_CHARS): string {
  const lines: string[] = [];
  let current = 0;
  for (const entry of entries) {
    const line = entryToText(entry);
    if (current + line.length > limit && lines.length > 0) break;
    lines.push(line);
    current += line.length;
  }
  return lines.join("\n").trim();
}

function normalizeSummary(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
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

// 对照点：pi-mono/packages/coding-agent/src/core/compaction/compaction.ts:597 findCutPoint
export function findCutPoint(input: FindCutPointInput): FindCutPointResult {
  const entries = input.entries;
  if (entries.length === 0) {
    return { cutIndex: 0, firstKeptEntryId: null };
  }

  const keepTail = Math.max(1, input.keepTail ?? DEFAULT_KEEP_TAIL);
  let cutIndex = Math.max(0, entries.length - keepTail);

  if (input.splitTurn !== false && cutIndex > 0) {
    while (cutIndex > 0) {
      const current = entries[cutIndex];
      if (current.type !== "message") break;
      if (current.role === "user" || current.role === "system") break;
      cutIndex -= 1;
    }
  }

  return {
    cutIndex,
    firstKeptEntryId: entries[cutIndex]?.id ?? null
  };
}

// 对照点：pi-mono/packages/coding-agent/src/core/compaction/compaction.ts prepareCompaction/compact
export function prepareCompaction(input: PrepareCompactionInput): CompactionDraft {
  const entries = input.entries;
  const previousSummary = normalizeSummary(input.previousSummary);
  const tokensBefore = approxTokenCount(previousSummary) + approxTokenCount(entries.map((entry) => entryToText(entry)).join("\n"));

  if (entries.length === 0) {
    return {
      summary: previousSummary,
      firstKeptEntryId: null,
      previousSummary,
      keptEntries: [],
      droppedEntries: [],
      tokensBefore,
      tokensAfter: approxTokenCount(previousSummary)
    };
  }

  const cut = findCutPoint({
    entries,
    keepTail: input.keepTail,
    splitTurn: input.splitTurn
  });

  const droppedEntries = entries.slice(0, cut.cutIndex);
  const keptEntries = entries.slice(cut.cutIndex);
  const droppedSummary = joinForSummary(droppedEntries, input.maxSummaryChars ?? DEFAULT_SUMMARY_MAX_CHARS);

  const summaryParts = [previousSummary, droppedSummary].filter(Boolean);
  const summary = normalizeSummary(summaryParts.join("\n\n"));

  const tokensAfter = approxTokenCount(summary) + approxTokenCount(keptEntries.map((entry) => entryToText(entry)).join("\n"));

  return {
    summary,
    firstKeptEntryId: cut.firstKeptEntryId,
    previousSummary,
    keptEntries,
    droppedEntries,
    tokensBefore,
    tokensAfter
  };
}

export function compact(input: PrepareCompactionInput): CompactionDraft {
  return prepareCompaction(input);
}
