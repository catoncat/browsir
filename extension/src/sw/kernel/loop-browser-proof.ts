import type { CapabilityExecutionPolicy } from "./capability-policy";
import type { JsonRecord } from "./types";
import {
  normalizeFailureReasonValue,
} from "./loop-shared-types";
import { toRecord } from "./loop-shared-utils";


// ── Observe / Verify ────────────────────────────────────────────────

export function buildObserveProgressVerify(
  beforeObserve: unknown,
  afterObserve: unknown,
): JsonRecord {
  const beforePage = toRecord(toRecord(beforeObserve).page);
  const afterPage = toRecord(toRecord(afterObserve).page);

  const urlChanged =
    String(beforePage.url || "") !== String(afterPage.url || "");
  const titleChanged =
    String(beforePage.title || "") !== String(afterPage.title || "");
  const textDiff = Math.abs(
    Number(afterPage.textLength || 0) - Number(beforePage.textLength || 0),
  );
  const nodeDiff = Math.abs(
    Number(afterPage.nodeCount || 0) - Number(beforePage.nodeCount || 0),
  );

  const textLengthChanged = textDiff >= 1;
  const nodeCountChanged = nodeDiff > 10;

  const checks = [
    {
      name: "urlChanged",
      pass: urlChanged,
      before: beforePage.url || "",
      after: afterPage.url || "",
    },
    {
      name: "titleChanged",
      pass: titleChanged,
      before: beforePage.title || "",
      after: afterPage.title || "",
    },
    {
      name: "textLengthChanged",
      pass: textLengthChanged,
      before: Number(beforePage.textLength || 0),
      after: Number(afterPage.textLength || 0),
    },
    {
      name: "nodeCountChanged",
      pass: nodeCountChanged,
      before: Number(beforePage.nodeCount || 0),
      after: Number(afterPage.nodeCount || 0),
    },
  ];

  const ok =
    urlChanged || titleChanged || textLengthChanged || nodeCountChanged;

  return {
    ok,
    checks,
    observation: afterObserve,
  };
}

// ── Verify Policy ───────────────────────────────────────────────────

export function shouldVerifyStep(
  action: string,
  verifyPolicy: unknown,
): boolean {
  const policy = String(verifyPolicy || "off");
  if (policy === "off") return false;
  if (policy === "always") return true;
  const critical = [
    "click",
    "type",
    "fill",
    "press",
    "scroll",
    "select",
    "navigate",
    "action",
  ];
  return critical.includes(
    String(action || "")
      .trim()
      .toLowerCase(),
  );
}

// ── Lease Policy ────────────────────────────────────────────────────

export function actionRequiresLease(kind: string): boolean {
  return [
    "click",
    "type",
    "fill",
    "press",
    "scroll",
    "select",
    "navigate",
    "hover",
  ].includes(kind);
}

export function shouldAcquireLease(
  kind: string,
  policy: CapabilityExecutionPolicy,
): boolean {
  const leasePolicy = policy.leasePolicy || "auto";
  if (leasePolicy === "none") return false;
  if (leasePolicy === "required") return true;
  return actionRequiresLease(kind);
}

// ── Terminal Status Mapping ─────────────────────────────────────────

export function mapToolErrorReasonToTerminalStatus(
  rawReason: unknown,
): "failed_execute" | "failed_verify" | "progress_uncertain" {
  return normalizeFailureReasonValue(rawReason);
}
