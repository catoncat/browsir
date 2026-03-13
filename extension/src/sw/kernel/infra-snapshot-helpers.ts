/**
 * Pure snapshot / AX-tree helper functions extracted from runtime-infra.browser.ts.
 * All functions are stateless and have zero closure dependencies.
 */

type JsonRecord = Record<string, unknown>;

// --- Snapshot key & summary ---

export function snapshotKey(options: JsonRecord): string {
  return [
    String(options.mode || "interactive"),
    String(options.filter || "interactive"),
    String(options.selector || "__root__"),
    String(options.depth ?? "-1"),
    String(options.maxTokens ?? "1200"),
    String(options.maxNodes ?? "120"),
  ].join(":");
}

export function summarizeSnapshotNode(node: JsonRecord): string {
  return `${String(node.role || "")}|${String(node.name || "")}|${String(node.selector || "")}|${String(node.value || "")}`;
}

// --- Compact formatting ---

export const ROLE_SHORTHAND: Record<string, string> = {
  button: "btn",
  link: "lnk",
  textbox: "txt",
  searchbox: "search",
  combobox: "combo",
  checkbox: "chk",
  radio: "radio",
  switch: "sw",
  menuitem: "item",
  option: "opt",
  slider: "sld",
  tab: "tab",
  spinbutton: "spin",
  listbox: "list",
  treeitem: "tree",
  textarea: "area",
};

export function formatNodeCompact(node: JsonRecord, depth = 0): string {
  const rawRole = String(node.role || "node").toLowerCase();
  const role = ROLE_SHORTHAND[rawRole] || rawRole;
  const name = String(node.name || "")
    .replace(/\s+/g, " ")
    .trim();
  const value = String(node.value || "")
    .replace(/\s+/g, " ")
    .trim();
  const placeholder = String(node.placeholder || "")
    .replace(/\s+/g, " ")
    .trim();

  let label = name;
  if (!label || (value && value !== name)) {
    if (label && value) {
      label = `${label} (${value})`;
    } else {
      label = value || placeholder || label;
    }
  }

  const showLabel = label ? ` "${label.slice(0, 80)}"` : "";
  const flags: string[] = [];
  if (node.disabled) flags.push("off");
  if (node.focused) flags.push("focus");
  if (node.required) flags.push("*");
  if (node.expanded === true) flags.push("open");
  if (node.expanded === false) flags.push("closed");
  if (node.checked === true) flags.push("on");
  if (node.checked === false) flags.push("off");
  if (node.selected === true) flags.push("sel");
  if (node.navType) flags.push(String(node.navType));
  if (Number(node.failureCount) > 0) flags.push(`failed:${node.failureCount}`);

  const flagText = flags.length > 0 ? ` [${flags.join(",")}]` : "";
  const indent = "  ".repeat(Math.max(0, depth));
  return `${indent}${String(node.ref || "")}:${role}${showLabel}${flagText}`;
}

export function buildCompactSnapshot(snapshot: JsonRecord): string {
  if (snapshot.mode === "text") {
    return `# ${String(snapshot.title || "")} | ${String(snapshot.url || "")}\n${String(snapshot.text || "")}`;
  }
  const lines = [
    `# ${String(snapshot.title || "")} | ${String(snapshot.url || "")} | ${Number(snapshot.count || 0)} nodes`,
  ];
  const nodes = Array.isArray(snapshot.nodes)
    ? (snapshot.nodes as JsonRecord[])
    : [];
  for (const node of nodes) {
    lines.push(formatNodeCompact(node, Number(node.depth || 0)));
  }
  return lines.join("\n");
}

// --- AX property readers ---

export function readAxValue(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const rec = asRecord(raw);
  if (typeof rec.value === "string") return rec.value;
  if (typeof rec.value === "number" || typeof rec.value === "boolean")
    return String(rec.value);
  return "";
}

export function readAxBooleanProperty(
  rawProperties: unknown,
  key: string,
): boolean | null {
  if (!Array.isArray(rawProperties)) return null;
  for (const item of rawProperties) {
    const entry = asRecord(item);
    if (String(entry.name || "").toLowerCase() !== key.toLowerCase()) continue;
    const value = asRecord(entry.value).value;
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

export function isInteractiveRole(roleRaw: unknown): boolean {
  const role = String(roleRaw || "")
    .trim()
    .toLowerCase();
  if (!role) return false;
  return [
    "button",
    "link",
    "textbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "menuitem",
    "option",
    "slider",
    "tab",
    "searchbox",
    "spinbutton",
    "listbox",
    "treeitem",
    "textarea",
  ].includes(role);
}

// --- Frame tree ---

export function collectFrameIdsFromTree(
  frameTree: unknown,
  out: string[] = [],
): string[] {
  const node = asRecord(frameTree);
  const frame = asRecord(node.frame);
  const frameId = String(frame.id || "").trim();
  if (frameId) out.push(frameId);
  const childFrames = Array.isArray(node.childFrames)
    ? (node.childFrames as unknown[])
    : [];
  for (const child of childFrames) {
    collectFrameIdsFromTree(child, out);
  }
  return out;
}

// --- Action helpers ---

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

export function normalizeActionKind(rawKind: unknown): string {
  const kind = typeof rawKind === "string" ? rawKind.trim() : "";
  if (!kind) throw new Error("action.kind is required");
  return kind;
}

// --- Snapshot options normalization ---

export function normalizeSnapshotOptions(
  raw: JsonRecord = {},
  toPositiveInt: (v: unknown, fallback: number) => number,
): JsonRecord {
  const modeRaw = String(raw.mode || "").trim();
  const mode =
    modeRaw === "text" || modeRaw === "full" || modeRaw === "interactive"
      ? modeRaw
      : "interactive";
  const filterRaw = String(raw.filter || "").trim();
  const filter =
    mode === "text" ? "all" : filterRaw === "all" ? "all" : "interactive";
  const format =
    String(raw.format || "json") === "compact" ? "compact" : "json";
  const selector = typeof raw.selector === "string" ? raw.selector.trim() : "";
  const diff = raw.diff !== false;
  const noAnimations = raw.noAnimations === true;
  const maxNodesFallback = mode === "full" ? 260 : 120;
  const maxTokensFallback = mode === "text" ? 1800 : 1200;
  const depthRaw = Number(raw.depth);
  const depth = Number.isInteger(depthRaw) && depthRaw >= 0 ? depthRaw : -1;
  return {
    mode,
    filter,
    format,
    selector,
    diff,
    noAnimations,
    depth,
    maxTokens: Math.max(
      120,
      Math.min(12_000, toPositiveInt(raw.maxTokens, maxTokensFallback)),
    ),
    maxNodes: Math.max(
      20,
      Math.min(1000, toPositiveInt(raw.maxNodes, maxNodesFallback)),
    ),
    maxChars: Math.max(
      200,
      Math.min(12_000, toPositiveInt(raw.maxChars, 4000)),
    ),
  };
}

// --- Internal helper (used by readAxValue/readAxBooleanProperty/collectFrameIdsFromTree) ---

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
