import type { JsonRecord } from "./types";

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
