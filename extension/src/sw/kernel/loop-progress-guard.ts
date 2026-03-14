import type { JsonRecord } from "./types";
import type { NoProgressReason } from "./loop-shared-types";
import { NO_PROGRESS_CONTINUE_BUDGET } from "./loop-shared-types";
import { clipText, safeStringify } from "./loop-shared-utils";

export interface LoopProgressSignature {
  actionSignature: string;
  evidenceHash: string;
  timestamp: string;
}

export interface LoopProgressState {
  signatures: LoopProgressSignature[];
  budget: number;
  maxBudget: number;
}

export function calculateActionSignature(action: string, args: JsonRecord): string {
  const parts = [action.trim().toLowerCase()];
  const sortedArgs = Object.keys(args).sort().map(k => `${k}:${JSON.stringify(args[k])}`);
  return [...parts, ...sortedArgs].join("|");
}

export function isNoProgress(signatures: LoopProgressSignature[], current: LoopProgressSignature): boolean {
  if (signatures.length === 0) return false;
  const last = signatures[signatures.length - 1];
  return last.actionSignature === current.actionSignature && last.evidenceHash === current.evidenceHash;
}

export function updateProgressBudget(currentBudget: number, isNoProgress: boolean): number {
  if (isNoProgress) return Math.max(0, currentBudget - 1);
  return currentBudget;
}

// ── Volatile evidence normalization ─────────────────────────────────

const NO_PROGRESS_VOLATILE_EVIDENCE_KEYS = new Set([
  "backendNodeId",
  "cmdId",
  "contentRuntimeVersion",
  "fallbackFrom",
  "lastSenderError",
  "leaseId",
  "modeUsed",
  "pageRuntimeVersion",
  "providerId",
  "ref",
  "requestId",
  "resolvedTool",
  "rpcId",
  "runtimeExpectedVersion",
  "runtimeVersion",
  "sessionId",
  "snapshotId",
  "stepRef",
  "tabId",
  "targetTabId",
  "toolCallId",
  "uid",
]);

export function normalizeNoProgressEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const limit = 8;
    const items = value
      .slice(0, limit)
      .map((item) => normalizeNoProgressEvidenceValue(item));
    if (value.length > limit) items.push(`__truncated__:${value.length}`);
    return items;
  }
  if (typeof value === "string") return clipText(value, 240);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (NO_PROGRESS_VOLATILE_EVIDENCE_KEYS.has(key)) continue;
    const normalized = normalizeNoProgressEvidenceValue(source[key]);
    if (normalized === undefined) continue;
    out[key] = normalized;
  }
  return out;
}

export function buildNoProgressEvidenceFingerprint(value: unknown): string {
  return safeStringify(normalizeNoProgressEvidenceValue(value), 1200);
}

// ── No-progress scope / budget ──────────────────────────────────────

export function buildNoProgressScopeKey(
  reason: NoProgressReason,
  scopeKey: string,
): string {
  return `${reason}:${scopeKey || "(default)"}`;
}

export function resolveNoProgressDecision(
  noProgressHits: Map<string, number>,
  reason: NoProgressReason,
  scopeKey: string,
): {
  hit: number;
  continueBudget: number;
  remainingContinueBudget: number;
  decision: "continue" | "stop";
} {
  const bucketKey = buildNoProgressScopeKey(reason, scopeKey);
  const hit = (noProgressHits.get(bucketKey) || 0) + 1;
  noProgressHits.set(bucketKey, hit);
  const continueBudget = NO_PROGRESS_CONTINUE_BUDGET[reason] ?? 0;
  const remainingContinueBudget = Math.max(0, continueBudget - hit);
  const decision: "continue" | "stop" =
    hit <= continueBudget ? "continue" : "stop";
  return {
    hit,
    continueBudget,
    remainingContinueBudget,
    decision,
  };
}
