type JsonRecord = Record<string, unknown>;

export interface NativeSender {
  senderKind: string;
  submit: (text: string, requestedModel?: string) => Promise<void>;
}

export interface NativeModelCatalog {
  selectedModel: string;
  availableModels: string[];
  probeCount: number;
}

interface SenderActionCandidate {
  displayName: string;
  propName: string;
  invoke: (text: string, requestedModel?: string) => Promise<void>;
  senderKind: string;
  score: number;
}

export type NativeSenderInvocationMode = "submit_text" | "sender_action";

const EDITABLE_SELECTOR = [
  "textarea",
  "input[type='text']",
  "input:not([type])",
  "[contenteditable='true']",
  "[role='textbox']"
].join(",");

const SUBMIT_PROP_SCORE: Array<{ pattern: RegExp; base: number }> = [
  { pattern: /^onSubmit$/i, base: 100 },
  { pattern: /^(submitMessage|sendMessage)$/i, base: 96 },
  { pattern: /^(handleSubmit|onSend)$/i, base: 92 },
  { pattern: /^(submit|send)$/i, base: 84 },
  { pattern: /(submit|send|commit|dispatch)/i, base: 72 }
];
const MODEL_NAME_PATTERN =
  /\b(?:claude|sonnet|opus|haiku|gpt|gemini|cursor|o1|o3|o4)(?:[\s/_-]*(?:\d+(?:\.\d+)?|mini|nano|pro|flash|max|thinking|fast|preview|turbo|reasoning|auto|sonnet|opus|haiku))*\b/i;
const MODEL_SELECTED_KEY_PATTERN = /(selected|current|active|default).*model|^(selected|current|active|default)$|^model(?:Id|Name)?$/i;
const MODEL_COLLECTION_KEY_PATTERN = /(available)?models?|model(?:Options|List|Catalog|Choices)|options/i;
const MODEL_OPTION_TEXT_KEYS = ["label", "name", "title", "model", "modelName", "id", "value", "slug"] as const;
const MODEL_OPTION_SELECTED_KEYS = ["selected", "isSelected", "active", "isActive", "checked", "default", "isDefault"] as const;

export function resolveNativeSenderInputText(latestUserPrompt: unknown, compiledPrompt: unknown): string {
  const latest = String(latestUserPrompt || "").trim();
  if (latest) return latest;
  const compiled = String(compiledPrompt || "").trim();
  if (compiled) return compiled;
  return "Continue";
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function normalizeModelText(text: unknown): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isLikelyModelText(text: unknown): boolean {
  const normalized = normalizeModelText(text);
  if (!normalized || normalized.length < 2 || normalized.length > 80) return false;
  if (!MODEL_NAME_PATTERN.test(normalized)) return false;
  return !/[{}[\]<>]/.test(normalized);
}

function isSelectedModelOption(value: unknown): boolean {
  const row = toRecord(value);
  return MODEL_OPTION_SELECTED_KEYS.some((key) => row[key] === true);
}

function readModelTextFromObject(value: unknown): string {
  const row = toRecord(value);
  for (const key of MODEL_OPTION_TEXT_KEYS) {
    const candidate = row[key];
    if (isLikelyModelText(candidate)) {
      return normalizeModelText(candidate);
    }
  }
  return "";
}

function collectModelCatalogFromValue(
  value: unknown,
  state: { selectedModel: string; availableModels: Set<string> },
  options: {
    keyHint?: string;
    selectedHint?: boolean;
    collectionHint?: boolean;
    depth: number;
    visited: WeakSet<object>;
    budget: { remaining: number };
  },
): void {
  if (options.budget.remaining <= 0 || value === null || value === undefined) return;
  options.budget.remaining -= 1;

  if (typeof value === "string") {
    if (!isLikelyModelText(value)) return;
    const normalized = normalizeModelText(value);
    state.availableModels.add(normalized);
    if (!state.selectedModel && options.selectedHint) {
      state.selectedModel = normalized;
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 24)) {
      collectModelCatalogFromValue(item, state, {
        ...options,
        collectionHint: true,
        depth: options.depth + 1,
      });
    }
    return;
  }

  if (typeof value !== "object") return;
  if (options.depth >= 5) return;
  if (typeof Element !== "undefined" && value instanceof Element) return;
  if (typeof Document !== "undefined" && value instanceof Document) return;
  if (typeof Window !== "undefined" && value instanceof Window) return;
  if (options.visited.has(value as object)) return;
  options.visited.add(value as object);

  const objectModelText = readModelTextFromObject(value);
  if (objectModelText && (options.collectionHint || options.selectedHint || isSelectedModelOption(value))) {
    state.availableModels.add(objectModelText);
    if (!state.selectedModel && (options.selectedHint || isSelectedModelOption(value))) {
      state.selectedModel = objectModelText;
    }
  }

  const row = toRecord(value);
  const entries = Object.entries(row).slice(0, 24);
  for (const [key, nested] of entries) {
    const modelKey = /model/i.test(key);
    const selectedHint = options.selectedHint || MODEL_SELECTED_KEY_PATTERN.test(key);
    const collectionHint = options.collectionHint || MODEL_COLLECTION_KEY_PATTERN.test(key) || modelKey;
    const shouldTraverseGenericObject =
      !modelKey &&
      !collectionHint &&
      !selectedHint &&
      typeof nested === "object" &&
      nested !== null &&
      options.depth < 2;
    if (!shouldTraverseGenericObject && !modelKey && !collectionHint && !selectedHint && typeof nested !== "string" && !Array.isArray(nested)) {
      continue;
    }
    collectModelCatalogFromValue(nested, state, {
      keyHint: key,
      selectedHint,
      collectionHint,
      depth: options.depth + 1,
      visited: options.visited,
      budget: options.budget,
    });
  }
}

function getReactFiber(node: Element): JsonRecord | null {
  const ownKeys = Object.getOwnPropertyNames(node);
  const fiberKey = ownKeys.find((key) => key.startsWith("__reactFiber"));
  const fiber = fiberKey ? (node as Element & Record<string, unknown>)[fiberKey] : null;
  return fiber && typeof fiber === "object" ? (fiber as JsonRecord) : null;
}

function getFiberDisplayName(fiber: JsonRecord): string {
  const type = fiber.type;
  if (typeof type === "string") return type;
  const row = toRecord(type);
  return String(row.displayName || row.name || "").trim();
}

function getFiberMemoizedProps(fiber: JsonRecord): JsonRecord {
  return toRecord(fiber.memoizedProps);
}

function isVisibleEditableElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function describeEditableElement(element: HTMLElement | null | undefined): string {
  if (!element) return "none";
  const parts = [element.tagName.toLowerCase()];
  const role = String(element.getAttribute("role") || "").trim();
  const ariaLabel = String(element.getAttribute("aria-label") || "").trim();
  const placeholder = String(element.getAttribute("placeholder") || "").trim();
  const testId = String(element.getAttribute("data-testid") || "").trim();
  const contentEditable = String(element.getAttribute("contenteditable") || "").trim();
  if (role) parts.push(`role=${role}`);
  if (ariaLabel) parts.push(`aria=${ariaLabel}`);
  if (placeholder) parts.push(`placeholder=${placeholder}`);
  if (testId) parts.push(`testid=${testId}`);
  if (contentEditable) parts.push(`contenteditable=${contentEditable}`);
  return parts.join("|");
}

function listEditableElements(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll(EDITABLE_SELECTOR)).filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );
}

function formatEditableDiscoverySummary(
  root: ParentNode,
  scoredCandidates: HTMLElement[],
): string {
  const allEditable = listEditableElements(root);
  const visibleEditable = allEditable.filter(isVisibleEditableElement).filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true",
  );
  const topSignals = visibleEditable
    .slice(0, 3)
    .map((element) => `${describeEditableElement(element)}#score=${scoreEditableElement(element)}`)
    .join(" || ");
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? describeEditableElement(document.activeElement)
      : String(document.activeElement?.nodeName || "none").toLowerCase();
  return [
    `editable=${allEditable.length}`,
    `visible=${visibleEditable.length}`,
    `scored=${scoredCandidates.length}`,
    `active=${activeElement}`,
    `visibility=${document.visibilityState}`,
    `focus=${document.hasFocus() ? "1" : "0"}`,
    topSignals ? `top=${topSignals}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function scoreEditableElement(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const text = [
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("name"),
    element.getAttribute("data-testid")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  let score = Math.max(0, Math.round(rect.top));
  if (element instanceof HTMLTextAreaElement) score += 80;
  if (element.matches("[contenteditable='true']")) score += 60;
  if (element.closest("form")) score += 24;
  if (/chat message|how can i help|chat|message|prompt|composer|agent/.test(text)) score += 160;
  if (/search/.test(text)) score -= 160;
  return score;
}

function listEditableCandidates(root: ParentNode = document): HTMLElement[] {
  const nodes = listEditableElements(root)
    .filter(isVisibleEditableElement)
    .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true");
  const unique = Array.from(new Set(nodes));
  return unique.sort((left, right) => scoreEditableElement(right) - scoreEditableElement(left));
}

function resolveSubmitPropScore(propName: string): number {
  for (const rule of SUBMIT_PROP_SCORE) {
    if (rule.pattern.test(propName)) return rule.base;
  }
  return -1;
}

export function resolveNativeSenderInvocationMode(
  displayName: string,
  propName: string,
  functionLength: number
): NativeSenderInvocationMode | null {
  if (resolveSubmitPropScore(propName) < 0) return null;
  const loweredDisplayName = displayName.toLowerCase();
  const looksLikeChatSender = /chatinput|composer|prompt|message/.test(loweredDisplayName);
  if (propName === "onSubmit") {
    return looksLikeChatSender ? "submit_text" : null;
  }
  if (!looksLikeChatSender || functionLength <= 0) return null;
  return "sender_action";
}

function buildSenderActionCandidate(
  _element: HTMLElement,
  fiber: JsonRecord,
  propName: string,
  handler: (...args: unknown[]) => unknown
): SenderActionCandidate | null {
  const score = resolveSubmitPropScore(propName);
  if (score < 0) return null;

  const displayName = getFiberDisplayName(fiber);
  const loweredDisplayName = displayName.toLowerCase();
  const senderKindBase = `${displayName || "anonymous"}:${propName}`;
  const invocationMode = resolveNativeSenderInvocationMode(displayName, propName, handler.length);
  if (invocationMode === "submit_text") {
    return {
      displayName,
      propName,
      senderKind: `react_submit_text:${senderKindBase}`,
      score: score + (/chatinput/.test(loweredDisplayName) ? 32 : 16),
      invoke(text: string, requestedModel?: string) {
        return Promise.resolve(
          handler(
            String(text || ""),
            undefined,
            requestedModel && requestedModel.toLowerCase() !== "auto" ? requestedModel : undefined
          )
        ).then(() => undefined);
      }
    };
  }

  return {
    displayName,
    propName,
    senderKind: `react_sender_action:${senderKindBase}`,
    score: score + (/chat|composer|prompt|message/.test(loweredDisplayName) ? 10 : 0),
    invoke(text: string, requestedModel?: string) {
      if (handler.length >= 2) {
        return Promise.resolve(
          handler(String(text || ""), requestedModel && requestedModel.toLowerCase() !== "auto" ? requestedModel : undefined)
        ).then(() => undefined);
      }
      if (handler.length === 1) {
        return Promise.resolve(handler(String(text || ""))).then(() => undefined);
      }
      return Promise.resolve(handler()).then(() => undefined);
    }
  };
}

function findBestSenderAction(element: HTMLElement): SenderActionCandidate | null {
  let fiber = getReactFiber(element);
  let depth = 0;
  let best: SenderActionCandidate | null = null;

  while (fiber && depth < 40) {
    const props = getFiberMemoizedProps(fiber);
    for (const [propName, value] of Object.entries(props)) {
      if (typeof value !== "function") continue;
      const candidate = buildSenderActionCandidate(element, fiber, propName, value as (...args: unknown[]) => unknown);
      if (!candidate) continue;
      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }
    const parent = fiber.return;
    fiber = parent && typeof parent === "object" ? (parent as JsonRecord) : null;
    depth += 1;
  }

  return best;
}

function inspectModelCatalogAroundElement(element: HTMLElement): NativeModelCatalog {
  let fiber = getReactFiber(element);
  let depth = 0;
  const state = {
    selectedModel: "",
    availableModels: new Set<string>(),
  };

  while (fiber && depth < 40) {
    collectModelCatalogFromValue(getFiberMemoizedProps(fiber), state, {
      keyHint: "memoizedProps",
      selectedHint: false,
      collectionHint: false,
      depth: 0,
      visited: new WeakSet<object>(),
      budget: { remaining: 200 },
    });
    collectModelCatalogFromValue(fiber.memoizedState, state, {
      keyHint: "memoizedState",
      selectedHint: false,
      collectionHint: false,
      depth: 0,
      visited: new WeakSet<object>(),
      budget: { remaining: 200 },
    });
    const parent = fiber.return;
    fiber = parent && typeof parent === "object" ? (parent as JsonRecord) : null;
    depth += 1;
  }

  const availableModels = Array.from(state.availableModels).slice(0, 8);
  return {
    selectedModel: state.selectedModel || availableModels[0] || "",
    availableModels,
    probeCount: depth,
  };
}

export function inspectCursorHelpNativeModelCatalog(root: ParentNode = document): NativeModelCatalog {
  const candidates = listEditableElements(root);
  let best: NativeModelCatalog | null = null;

  for (const element of candidates) {
    const catalog = inspectModelCatalogAroundElement(element);
    if (catalog.availableModels.length <= 0) continue;
    if (
      !best ||
      catalog.availableModels.length > best.availableModels.length ||
      (catalog.selectedModel && !best.selectedModel)
    ) {
      best = catalog;
    }
  }

  return best || {
    selectedModel: "",
    availableModels: [],
    probeCount: candidates.length,
  };
}

export function locateCursorHelpNativeSender(
  root: ParentNode = document
): { sender: NativeSender | null; error: string; probeCount: number } {
  const candidates = listEditableCandidates(root).filter((element) => scoreEditableElement(element) >= 100);
  const discoverySummary = formatEditableDiscoverySummary(root, candidates);
  if (candidates.length <= 0) {
    return {
      sender: null,
      error: `未找到 Cursor Help 聊天输入组件（${discoverySummary}）`,
      probeCount: 0
    };
  }

  for (const element of candidates) {
    const action = findBestSenderAction(element);
    if (!action) continue;
    return {
      sender: {
        senderKind: action.senderKind,
        submit(text: string, requestedModel?: string) {
          return action.invoke(text, requestedModel);
        }
      },
      error: "",
      probeCount: candidates.length
    };
  }

  return {
    sender: null,
    error: `Cursor Help 内部发送入口未定位（已探测 ${candidates.length} 个输入组件；${discoverySummary}）`,
    probeCount: candidates.length
  };
}
