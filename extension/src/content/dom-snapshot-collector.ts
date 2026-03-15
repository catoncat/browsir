/**
 * DOM Snapshot Collector — Content Script
 *
 * Injected into pages via manifest content_scripts (or chrome.scripting.executeScript).
 * Listens for "brain:collect-dom-snapshot" messages from the service worker and responds
 * with a serialised DOM snapshot suitable for the LLM loop.
 *
 * No CDP / debugger dependency — this is the background-mode snapshot path.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_ID_ATTR = "data-brain-uid";
const STATIC_TEXT_ROLE = "StaticText";
const ROOT_ROLE = "RootWebArea";

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  "meta",
  "link",
]);

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "summary",
  "details",
  "select",
  "textarea",
  "input",
  "label",
  "video",
  "audio",
]);

const INPUT_TYPES_AS_ROLE: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  email: "textbox",
  search: "searchbox",
  url: "textbox",
  number: "spinbutton",
  password: "textbox",
  text: "textbox",
};

const LAYOUT_ROLES = new Set([
  "generic",
  "article",
  "section",
  "region",
  "group",
  "main",
  "complementary",
  "navigation",
  "banner",
  "contentinfo",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

// ---------------------------------------------------------------------------
// Types (serialised over the message-port boundary)
// ---------------------------------------------------------------------------

export interface DomSnapshotNode {
  id: string;
  role: string;
  name?: string;
  value?: string;
  children: DomSnapshotNode[];
  tagName?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean | "mixed";
  placeholder?: string;
  href?: string;
  title?: string;
  textContent?: string;
  inputType?: string;
}

export interface DomSnapshotFlatMap {
  [uid: string]: DomSnapshotNode;
}

export interface CollectorOptions {
  maxTextLength: number;
  includeHidden: boolean;
  captureTextNodes: boolean;
}

export interface SerializedDomSnapshot {
  root: DomSnapshotNode;
  idToNode: DomSnapshotFlatMap;
  totalNodes: number;
  timestamp: number;
  metadata: {
    title: string;
    url: string;
    collectedAt: string;
    options: Partial<CollectorOptions>;
  };
}

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: CollectorOptions = {
  maxTextLength: 160,
  includeHidden: false,
  captureTextNodes: true,
};

// ---------------------------------------------------------------------------
// UID helpers
// ---------------------------------------------------------------------------

function generateShortId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36).slice(-4);
  return `${time}${random}`;
}

function ensureElementUid(element: Element): string {
  const existing = element.getAttribute(NODE_ID_ATTR);
  if (existing) return existing;
  const uid = `dom_${generateShortId()}`;
  element.setAttribute(NODE_ID_ATTR, uid);
  return uid;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractVisibleText(element: Element): string {
  const parts: string[] = [];
  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.trim();
      if (t) parts.push(t);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (SKIP_TAGS.has((node as Element).tagName.toLowerCase())) return;
      for (const child of Array.from(node.childNodes)) walk(child);
    }
  }
  walk(element);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Visibility helpers
// ---------------------------------------------------------------------------

function isElementHidden(el: Element, doc: Document): boolean {
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hasAttribute("hidden")) return true;
  if (el.hasAttribute("inert")) return true;
  if (el instanceof HTMLElement) {
    const s = doc.defaultView?.getComputedStyle(el);
    if (s?.display === "none") return true;
  }
  return false;
}

function isVisibilityHidden(el: Element, doc: Document): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const s = doc.defaultView?.getComputedStyle(el);
  if (!s) return false;
  return s.visibility === "hidden" || s.visibility === "collapse";
}

function isElementVisible(el: Element, doc: Document): boolean {
  if (!(el instanceof HTMLElement)) return true;
  const s = doc.defaultView?.getComputedStyle(el);
  if (!s) return true;
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}

function hasCursorPointer(el: Element, doc: Document): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const s = doc.defaultView?.getComputedStyle(el);
  return s?.cursor === "pointer" || false;
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

function resolveRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return (el as HTMLAnchorElement).href ? "link" : "generic";
  if (tag === "button") return "button";
  if (tag === "img") return "image";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return INPUT_TYPES_AS_ROLE[type] || "textbox";
  }
  if (tag === "iframe") return "iframe";
  if (el instanceof HTMLElement && el.isContentEditable) return "textbox";
  return "generic";
}

// ---------------------------------------------------------------------------
// Accessible name
// ---------------------------------------------------------------------------

function resolveAccessibleName(el: Element, doc: Document): string | null {
  const ariaLabel = el.getAttribute("aria-label")?.trim();
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const texts = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim())
      .filter(Boolean) as string[];
    if (texts.length) return texts.join(" ");
  }

  if (el instanceof HTMLImageElement && el.alt) return el.alt.trim();

  if (el instanceof HTMLInputElement) {
    if (el.placeholder) return el.placeholder;
    if (el.type === "submit" || el.type === "button") return el.value || "Submit";
  }

  if (el instanceof HTMLButtonElement && el.textContent) {
    return normalizeText(el.textContent);
  }

  if (el instanceof HTMLAnchorElement) {
    const t = normalizeText(el.textContent || "");
    if (t) return t;
  }

  const role = el.getAttribute("role") || "";
  if (INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) {
    return extractVisibleText(el) || null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Element value
// ---------------------------------------------------------------------------

function resolveValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    return el.type === "password" ? "*".repeat(el.value.length) : el.value || undefined;
  }
  if (el instanceof HTMLTextAreaElement) return el.value || undefined;
  if (el instanceof HTMLSelectElement) {
    const sel = el.selectedOptions[0];
    return sel?.value || undefined;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return normalizeText(el.textContent || "") || undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// shouldInclude
// ---------------------------------------------------------------------------

function hasExplicitLabel(el: Element, doc: Document): boolean {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim().length > 1) return true;
  const lb = el.getAttribute("aria-labelledby");
  if (lb) {
    const txt = lb
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() || "")
      .filter(Boolean)
      .join(" ");
    if (txt.length > 1) return true;
  }
  return false;
}

function shouldInclude(el: Element, opts: CollectorOptions, doc: Document): boolean {
  if (!opts.includeHidden && !isElementVisible(el, doc)) return false;

  const role = resolveRole(el);
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (hasCursorPointer(el, doc)) return true;
  if (role === "image") return Boolean((el as HTMLImageElement).alt?.trim());
  if (hasExplicitLabel(el, doc)) return true;

  const name = resolveAccessibleName(el, doc);
  if (!LAYOUT_ROLES.has(role) && name && name.length > 1) return true;

  const nt = normalizeText(el.textContent || "");
  if (nt.length >= 2 && !LAYOUT_ROLES.has(role)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Node creation
// ---------------------------------------------------------------------------

function createNode(
  el: Element,
  opts: CollectorOptions,
  flat: DomSnapshotFlatMap,
  doc: Document,
): DomSnapshotNode {
  const id = ensureElementUid(el);
  const role = resolveRole(el);
  const name = resolveAccessibleName(el, doc);
  const value = resolveValue(el);

  const node: DomSnapshotNode = {
    id,
    role: role || "generic",
    name: name || undefined,
    children: [],
    tagName: el.tagName.toLowerCase(),
  };

  if (value) node.value = value;

  const isInteractive =
    INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(el.tagName.toLowerCase());
  if (isInteractive) {
    const tc = extractVisibleText(el);
    if (tc && tc !== node.name) node.textContent = tc.slice(0, opts.maxTextLength);
  }

  if (el instanceof HTMLInputElement) {
    node.inputType = el.type;
    if (el.placeholder) node.placeholder = el.placeholder;
    if (el.type === "checkbox" || el.type === "radio") {
      node.checked = el.indeterminate ? "mixed" : el.checked;
    }
    if (el.type === "submit" && !node.name) node.name = el.value || "Submit";
  }

  if (el instanceof HTMLTextAreaElement) {
    node.inputType = "textarea";
    if (!node.value && el.value) node.value = el.value;
    if (el.placeholder) node.placeholder = el.placeholder;
  }

  if (el instanceof HTMLSelectElement) {
    node.inputType = "select";
    const selected = Array.from(el.selectedOptions);
    if (selected.length) {
      node.value = selected.map((o) => o.value).join(", ");
      const text = selected.map((o) => o.label || o.textContent?.trim() || "").filter(Boolean).join(", ");
      if (text) node.name = text;
    }
  }

  if (el instanceof HTMLAnchorElement) node.href = el.href;
  if (el instanceof HTMLImageElement) node.name = el.alt || node.name;

  if (el instanceof HTMLElement) {
    if (el.title) node.title = el.title;
    if (el.hasAttribute("aria-disabled")) {
      node.disabled = el.getAttribute("aria-disabled") === "true";
    } else if ("disabled" in el) {
      node.disabled = Boolean((el as HTMLButtonElement).disabled);
    }
    if (el.hasAttribute("aria-pressed")) {
      const p = el.getAttribute("aria-pressed");
      node.pressed = p === "mixed" ? "mixed" : p === "true";
    }
    if (el.hasAttribute("aria-expanded")) {
      node.expanded = el.getAttribute("aria-expanded") === "true";
    }
    if (el.hasAttribute("aria-selected")) {
      node.selected = el.getAttribute("aria-selected") === "true";
    }
    if (doc.activeElement === el) node.focused = true;
  }

  flat[id] = node;
  return node;
}

// ---------------------------------------------------------------------------
// Text nodes
// ---------------------------------------------------------------------------

function extractTextChildren(
  el: Element,
  flat: DomSnapshotFlatMap,
): DomSnapshotNode[] {
  const out: DomSnapshotNode[] = [];
  Array.from(el.childNodes).forEach((child, i) => {
    if (child.nodeType !== Node.TEXT_NODE) return;
    const text = normalizeText(child.textContent || "");
    if (!text) return;
    const uid = `${ensureElementUid(el)}::text-${i}`;
    const tn: DomSnapshotNode = { id: uid, role: STATIC_TEXT_ROLE, name: text, children: [] };
    flat[uid] = tn;
    out.push(tn);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tree traversal
// ---------------------------------------------------------------------------

interface TraverseResult {
  nodes: DomSnapshotNode[];
  hasVisibilityVisible: boolean;
}

function traverseIframe(
  iframe: HTMLIFrameElement,
  opts: CollectorOptions,
  flat: DomSnapshotFlatMap,
  doc: Document,
): TraverseResult {
  if (!opts.includeHidden && isElementHidden(iframe, doc)) {
    return { nodes: [], hasVisibilityVisible: false };
  }

  let iframeDoc: Document | null = null;
  try {
    iframeDoc = iframe.contentDocument;
    if (!iframeDoc && iframe.contentWindow) {
      try { iframeDoc = iframe.contentWindow.document; } catch { /* cross-origin */ }
    }
  } catch { /* cross-origin */ }

  const iframeNode = createNode(iframe, opts, flat, doc);
  const children: DomSnapshotNode[] = [];
  let childVis = false;

  if (iframeDoc) {
    const body = iframeDoc.body || iframeDoc.documentElement;
    if (body) {
      const r = traverseElement(body, opts, flat, iframeDoc);
      children.push(...r.nodes);
      if (r.hasVisibilityVisible) childVis = true;
    }
  }

  iframeNode.children = children;
  const selfHidden = !opts.includeHidden && isVisibilityHidden(iframe, doc);
  if (selfHidden && !childVis) return { nodes: [], hasVisibilityVisible: false };
  return { nodes: [iframeNode], hasVisibilityVisible: !selfHidden || childVis };
}

function traverseElement(
  el: Element,
  opts: CollectorOptions,
  flat: DomSnapshotFlatMap,
  doc: Document,
): TraverseResult {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return { nodes: [], hasVisibilityVisible: false };
  if (!opts.includeHidden && isElementHidden(el, doc)) {
    return { nodes: [], hasVisibilityVisible: false };
  }

  const childNodes: DomSnapshotNode[] = [];
  let childVis = false;

  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() === "iframe") {
      const r = traverseIframe(child as HTMLIFrameElement, opts, flat, doc);
      childNodes.push(...r.nodes);
      if (r.hasVisibilityVisible) childVis = true;
    } else {
      const r = traverseElement(child, opts, flat, doc);
      childNodes.push(...r.nodes);
      if (r.hasVisibilityVisible) childVis = true;
    }
  }

  const selfHidden = !opts.includeHidden && isVisibilityHidden(el, doc);
  const vis = !selfHidden || childVis;

  if (selfHidden && !childVis) return { nodes: [], hasVisibilityVisible: false };

  if (opts.captureTextNodes) childNodes.push(...extractTextChildren(el, flat));

  const include = shouldInclude(el, opts, doc);
  if (!include) {
    if (childNodes.length === 1) return { nodes: childNodes, hasVisibilityVisible: vis };
    if (childNodes.length > 1) {
      const syn = createNode(el, opts, flat, doc);
      syn.children = childNodes;
      return { nodes: [syn], hasVisibilityVisible: vis };
    }
    return { nodes: [], hasVisibilityVisible: vis };
  }

  const node = createNode(el, opts, flat, doc);
  node.children = childNodes;
  return { nodes: [node], hasVisibilityVisible: vis };
}

// ---------------------------------------------------------------------------
// Main entry — collectDomSnapshot
// ---------------------------------------------------------------------------

export function collectDomSnapshot(
  rootDocument: Document = document,
  options?: Partial<CollectorOptions>,
): SerializedDomSnapshot {
  const filtered = options
    ? Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined))
    : {};
  const config: CollectorOptions = { ...DEFAULT_OPTIONS, ...filtered };
  const idToNode: DomSnapshotFlatMap = Object.create(null);

  const body = rootDocument.body || rootDocument.documentElement;
  const rootNode: DomSnapshotNode = {
    id: ensureElementUid(body ?? rootDocument.createElement("div")),
    role: ROOT_ROLE,
    name: rootDocument.title || rootDocument.URL || "document",
    children: [],
    tagName: body?.tagName.toLowerCase(),
  };

  if (body) {
    const result = traverseElement(body, config, idToNode, rootDocument);
    if (result.nodes.length) rootNode.children.push(...result.nodes);
  }

  idToNode[rootNode.id] = rootNode;

  return {
    root: rootNode,
    idToNode,
    totalNodes: Object.keys(idToNode).length,
    timestamp: Date.now(),
    metadata: {
      title: rootDocument.title || "",
      url: rootDocument.URL || "",
      collectedAt: new Date().toISOString(),
      options: config,
    },
  };
}

/** Convenience wrapper for in-page injection (no arguments). */
export function collectDomSnapshotInPage(
  options?: Partial<CollectorOptions>,
): SerializedDomSnapshot {
  return collectDomSnapshot(document, options);
}

// ---------------------------------------------------------------------------
// Message listener — service worker ↔ content script protocol
// ---------------------------------------------------------------------------

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      if (
        !message ||
        typeof message !== "object" ||
        (message as Record<string, unknown>).type !== "brain:collect-dom-snapshot"
      ) {
        return false; // not our message
      }

      try {
        const opts = (message as Record<string, unknown>).options as
          | Partial<CollectorOptions>
          | undefined;
        const snapshot = collectDomSnapshot(document, opts);
        sendResponse({ success: true, data: snapshot });
      } catch (err) {
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true; // will respond asynchronously
    },
  );
}
