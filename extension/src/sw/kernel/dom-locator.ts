/**
 * DomLocator — Pure-DOM action executor for background mode.
 *
 * Uses `chrome.scripting.executeScript` to inject a page-level function that
 * locates elements by `data-brain-uid` and dispatches synthetic DOM events.
 * No CDP / debugger dependency.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClickOptions {
  count?: number;
  highlight?: boolean;
  scroll?: boolean;
}

export interface FillOptions {
  value: string;
  commit?: boolean;
  highlight?: boolean;
  scroll?: boolean;
}

export interface HoverOptions {
  highlight?: boolean;
  scroll?: boolean;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomActionResponse<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

type DomActionPayload =
  | ({ action: "click"; uid: string } & ClickOptions)
  | ({ action: "fill"; uid: string } & FillOptions)
  | ({ action: "hover"; uid: string } & HoverOptions)
  | { action: "bounding-box"; uid: string }
  | { action: "value"; uid: string };

// ---------------------------------------------------------------------------
// DomLocator class (runs in Service Worker)
// ---------------------------------------------------------------------------

export class DomLocator {
  constructor(private tabId: number) {}

  async click(uid: string, options?: ClickOptions): Promise<DomActionResponse> {
    return this.executeInPage({ action: "click", uid, ...options });
  }

  async fill(uid: string, options: FillOptions): Promise<DomActionResponse> {
    return this.executeInPage({ action: "fill", uid, ...options });
  }

  async hover(uid: string, options?: HoverOptions): Promise<DomActionResponse> {
    return this.executeInPage({ action: "hover", uid, ...options });
  }

  async boundingBox(uid: string): Promise<DomActionResponse<BoundingBox | null>> {
    return this.executeInPage({ action: "bounding-box", uid });
  }

  async value(uid: string): Promise<DomActionResponse<string | null>> {
    return this.executeInPage({ action: "value", uid });
  }

  // ---------------------------------------------------------------------------
  // Internal: inject & execute the page-level helper
  // ---------------------------------------------------------------------------

  private async executeInPage<T = void>(
    payload: DomActionPayload,
  ): Promise<DomActionResponse<T>> {
    if (typeof chrome === "undefined" || !chrome.scripting?.executeScript) {
      return { success: false, error: "chrome.scripting API unavailable." };
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: runDomAction,
        args: [payload],
      });

      const response =
        (results[0]?.result as DomActionResponse<T> | undefined) ?? null;
      return response || { success: false, error: "No result from dom action." };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Injected page-level function
// ---------------------------------------------------------------------------
// Everything below is serialised and evaluated within the target page context.
// All helpers MUST be defined inside `runDomAction`.
// ---------------------------------------------------------------------------

function runDomAction(payload: DomActionPayload): DomActionResponse<any> {
  // --- CSS escape helper ---
  const cssEscape = (value: string): string => {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/"/g, '\\"');
  };

  // --- Query by UID (main document + shadow roots + same-origin iframes) ---
  const queryByUid = (uid: string): Element | null => {
    const sel = `[data-brain-uid="${cssEscape(uid)}"]`;

    const deepQuery = (root: Document | ShadowRoot): Element | null => {
      const hit = root.querySelector(sel);
      if (hit) return hit;

      for (const el of root.querySelectorAll("*")) {
        // Search inside open Shadow Roots
        if (el.shadowRoot) {
          const shadowHit = deepQuery(el.shadowRoot);
          if (shadowHit) return shadowHit;
        }
        // Search inside same-origin iframes
        if (el.tagName.toLowerCase() === "iframe") {
          try {
            const fd = (el as HTMLIFrameElement).contentDocument;
            if (fd) {
              const nested = deepQuery(fd);
              if (nested) return nested;
            }
          } catch { /* cross-origin */ }
        }
      }
      return null;
    };

    return deepQuery(document);
  };

  // --- Highlight effect (1.2 s fade-out) ---
  const applyHighlight = (el: HTMLElement): void => {
    const KEY = "__brainHighlightOrig";
    const TID = "__brainHighlightTid";
    const h = el as HTMLElement & {
      [KEY]?: { outline: string; outlineOffset: string; boxShadow: string; transition: string };
      [TID]?: number;
    };
    if (h[TID]) window.clearTimeout(h[TID]);
    if (!h[KEY]) {
      h[KEY] = {
        outline: h.style.outline,
        outlineOffset: h.style.outlineOffset,
        boxShadow: h.style.boxShadow,
        transition: h.style.transition,
      };
    }
    h.style.outline = "3px solid #3b82f6";
    h.style.outlineOffset = "2px";
    h.style.boxShadow = "0 0 0 4px rgba(59,130,246,0.2), 0 0 20px rgba(59,130,246,0.4)";
    h.style.transition = "all 0.2s ease-in-out";
    h[TID] = window.setTimeout(() => {
      const orig = h[KEY];
      if (orig) {
        h.style.outline = orig.outline;
        h.style.outlineOffset = orig.outlineOffset;
        h.style.boxShadow = orig.boxShadow;
        h.style.transition = orig.transition;
        delete h[KEY];
      }
      delete h[TID];
    }, 1200);
  };

  // --- Type guards (duck-typed for cross-iframe safety) ---
  const isHTML = (el: Element): el is HTMLElement =>
    el && typeof (el as HTMLElement).style !== "undefined" && typeof (el as HTMLElement).click === "function";

  const isInput = (el: Element): el is HTMLInputElement =>
    el?.tagName?.toLowerCase() === "input" && "value" in el;

  const isTextArea = (el: Element): el is HTMLTextAreaElement =>
    el?.tagName?.toLowerCase() === "textarea" && "value" in el;

  const isContentEditable = (el: Element): boolean =>
    isHTML(el) && el.isContentEditable === true;

  // --- Prepare (scroll + highlight) ---
  const prepare = (el: Element, opts?: { highlight?: boolean; scroll?: boolean }): void => {
    if (!isHTML(el)) return;
    if (opts?.scroll !== false) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }
    if (opts?.highlight !== false) applyHighlight(el);
  };

  // -----------------------------------------------------------------------
  // Action implementations
  // -----------------------------------------------------------------------

  const doClick = (el: Element, opts: ClickOptions): DomActionResponse => {
    if (!isHTML(el)) return { success: false, error: "Target is not an HTMLElement." };
    prepare(el, opts);
    const count = opts.count ?? 1;
    for (let i = 0; i < count; i++) {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    return { success: true };
  };

  const doFill = (el: Element, opts: FillOptions): DomActionResponse => {
    if (isContentEditable(el)) {
      prepare(el, opts);
      (el as HTMLElement).focus();
      el.textContent = opts.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { success: true };
    }
    if (!isInput(el) && !isTextArea(el)) {
      return { success: false, error: "Element is not an input, textarea, or contenteditable." };
    }
    prepare(el, opts);
    el.value = "";
    el.dispatchEvent(new Event("focus", { bubbles: true }));
    el.value = opts.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (opts.commit !== false) {
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }
    return { success: true };
  };

  const doHover = (el: Element, opts: HoverOptions): DomActionResponse => {
    if (!isHTML(el)) return { success: false, error: "Target is not an HTMLElement." };
    prepare(el, opts);
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true }));
    return { success: true };
  };

  const doBoundingBox = (el: Element): DomActionResponse<BoundingBox> => {
    if (!isHTML(el)) return { success: false, error: "Target is not an HTMLElement." };
    const r = el.getBoundingClientRect();
    return { success: true, data: { x: r.x, y: r.y, width: r.width, height: r.height } };
  };

  const doValue = (el: Element): DomActionResponse<string> => {
    if (isInput(el) || isTextArea(el)) return { success: true, data: el.value };
    if (isContentEditable(el)) return { success: true, data: el.textContent || "" };
    return { success: false, error: "Element does not have a value property." };
  };

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  const element = queryByUid(payload.uid);
  if (!element) return { success: false, error: `Element not found: uid="${payload.uid}"` };

  switch (payload.action) {
    case "click":
      return doClick(element, payload);
    case "fill":
      return doFill(element, payload);
    case "hover":
      return doHover(element, payload);
    case "bounding-box":
      return doBoundingBox(element);
    case "value":
      return doValue(element);
    default:
      return { success: false, error: `Unknown action: ${(payload as any).action}` };
  }
}
