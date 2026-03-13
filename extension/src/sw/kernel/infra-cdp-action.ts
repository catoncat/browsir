/**
 * CDP action execution: ref resolution, backend-node actions, selector-based actions, and verification.
 * Extracted from runtime-infra.browser.ts to isolate action execution concerns.
 */
import { normalizeActionKind } from "./infra-snapshot-helpers";

type JsonRecord = Record<string, unknown>;

interface SnapshotState {
  byKey: Map<string, JsonRecord>;
  refMap: Map<string, JsonRecord>;
  lastSnapshotId: string | null;
  failureCounts: Map<string, number>;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toPositiveInteger(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function toIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function toRuntimeError(
  message: string,
  meta: {
    code?: string;
    details?: unknown;
    retryable?: boolean;
    status?: number;
  } = {},
): Error & {
  code?: string;
  details?: unknown;
  retryable?: boolean;
  status?: number;
} {
  const err = new Error(message) as Error & {
    code?: string;
    details?: unknown;
    retryable?: boolean;
    status?: number;
  };
  if (meta.code) err.code = meta.code;
  if (meta.details !== undefined) err.details = meta.details;
  if (typeof meta.retryable === "boolean") err.retryable = meta.retryable;
  if (typeof meta.status === "number") err.status = meta.status;
  return err;
}

// ──────────────── factory ────────────────

export interface CdpActionDeps {
  sendCdpCommand<T = JsonRecord>(
    tabId: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  ensureDebugger(tabId: number): Promise<void>;
  getSnapshotState(tabId: number): SnapshotState;
  observeByCDP(tabId: number): Promise<JsonRecord>;
}

export interface CdpActionExecutor {
  resolveRefEntry(tabId: number, ref: string): JsonRecord;
  executeActionByBackendNode(
    tabId: number,
    input: {
      backendNodeId: number;
      kind: string;
      value: string;
      waitForMs: number;
      brainUid?: string;
    },
  ): Promise<JsonRecord>;
  executeRefActionByCDP(
    tabId: number,
    rawAction: JsonRecord,
  ): Promise<JsonRecord>;
  executeByCDP(tabId: number, action: JsonRecord): Promise<unknown>;
  verifyByCDP(
    tabId: number,
    action: JsonRecord,
    result: JsonRecord | null,
  ): Promise<JsonRecord>;
}

export function createCdpActionExecutor(deps: CdpActionDeps): CdpActionExecutor {
  const { sendCdpCommand, ensureDebugger, getSnapshotState, observeByCDP } = deps;

  function resolveRefEntry(tabId: number, ref: string): JsonRecord {
    const state = getSnapshotState(tabId);
    const node = state.refMap.get(ref);
    if (node) return node;

    const legacyMatch = /^e(\d+)$/i.exec(ref);
    if (legacyMatch) {
      const index = Number(legacyMatch[1]);
      if (Number.isInteger(index) && index >= 0) {
        const snapshots = Array.from(state.byKey.values());
        if (state.lastSnapshotId) {
          const exact = snapshots.find(
            (snapshot) =>
              String(snapshot.snapshotId || "") === state.lastSnapshotId,
          );
          if (exact) {
            const nodes = Array.isArray(exact.nodes)
              ? (exact.nodes as JsonRecord[])
              : [];
            const picked = nodes[index];
            if (picked && typeof picked === "object") return picked;
          }
        }
        for (let i = snapshots.length - 1; i >= 0; i -= 1) {
          const snapshot = snapshots[i];
          const nodes = Array.isArray(snapshot.nodes)
            ? (snapshot.nodes as JsonRecord[])
            : [];
          const picked = nodes[index];
          if (picked && typeof picked === "object") return picked;
        }
      }
    }

    const backendRefMatch = /^bn-(\d+)$/i.exec(ref);
    if (backendRefMatch) {
      const backendNodeId = Number(backendRefMatch[1]);
      if (Number.isInteger(backendNodeId) && backendNodeId > 0) {
        return {
          uid: ref,
          ref,
          backendNodeId,
        };
      }
    }

    throw new Error(`ref ${ref} not found, take /cdp.snapshot first`);
  }

  async function executeActionByBackendNode(
    tabId: number,
    input: {
      backendNodeId: number;
      kind: string;
      value: string;
      waitForMs: number;
      brainUid?: string;
    },
  ): Promise<JsonRecord> {
    const kind = input.kind;
    const waitForMs = Math.max(
      0,
      Math.min(10_000, Number(input.waitForMs || 0)),
    );
    const started = Date.now();
    let objectId = "";

    const resolveObject = async (): Promise<string> => {
      try {
        const resolved = (await sendCdpCommand(tabId, "DOM.resolveNode", {
          backendNodeId: input.backendNodeId,
        })) as JsonRecord;
        const nextObjectId = String(asRecord(resolved.object).objectId || "");
        if (nextObjectId) return nextObjectId;
      } catch {
        // fallback to UID lookup
      }

      if (input.brainUid) {
        const uidEval = (await sendCdpCommand(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const uid = ${JSON.stringify(String(input.brainUid))};
            if (!uid) return null;
            const all = document.querySelectorAll("[data-brain-uid]");
            for (const node of all) {
              if (node?.getAttribute?.("data-brain-uid") === uid) return node;
            }
            return null;
          })()`,
          includeCommandLineAPI: true,
        })) as JsonRecord;
        const nextObjectId = String(asRecord(uidEval.result).objectId || "");
        if (nextObjectId) return nextObjectId;
      }

      throw toRuntimeError(
        `backendNodeId ${input.backendNodeId} resolve failed`,
        {
          code: "E_CDP_RESOLVE_NODE",
          retryable: true,
          details: {
            tabId,
            backendNodeId: input.backendNodeId,
            brainUid: input.brainUid,
          },
        },
      );
    };

    while (true) {
      try {
        objectId = await resolveObject();
        break;
      } catch (error) {
        if (Date.now() - started >= waitForMs) throw error;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }

    try {
      const expression = `function() {
        const kind = ${JSON.stringify(kind)};
        const value = ${JSON.stringify(input.value)};
        if (!this || this.nodeType !== 1) return { ok: false, error: "backend node is not element" };
        const el = this;
        const dispatchInputLikeEvents = (target, text, mode) => {
          try {
            target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
          } catch {
            // ignore unsupported InputEvent ctor
          }
          let inputSent = false;
          try {
            target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
            inputSent = true;
          } catch {
            // fallback below
          }
          if (!inputSent) target.dispatchEvent(new Event("input", { bubbles: true }));
          if (mode === "fill") target.dispatchEvent(new Event("change", { bubbles: true }));
          target.dispatchEvent(new Event("keyup", { bubbles: true }));
        };
        const tryMonacoModelSet = (target, text, mode) => {
          try {
            const root =
              target.closest?.(".monaco-editor")
              || (target.classList?.contains?.("monaco-editor") ? target : null);
            if (!root) return null;
            const monaco = globalThis.monaco || window.monaco;
            const editor = monaco?.editor;
            if (!editor) return null;
            const uriRaw = String(
              target.getAttribute?.("data-monaco-uri")
              || root.getAttribute?.("data-monaco-uri")
              || ""
            ).trim();
            let model = null;
            if (uriRaw && monaco?.Uri?.parse && typeof editor.getModel === "function") {
              try {
                model = editor.getModel(monaco.Uri.parse(uriRaw));
              } catch {
                // keep fallback
              }
            }
            if (!model && typeof editor.getModels === "function") {
              const models = editor.getModels();
              if (Array.isArray(models) && models.length > 0) model = models[0];
            }
            if (!model || typeof model.setValue !== "function") return null;
            model.setValue(text);
            if ("value" in target) target.value = text;
            dispatchInputLikeEvents(target, text, mode);
            return { ok: true, typed: text.length, mode, via: "backend-node-monaco", url: location.href, title: document.title };
          } catch {
            return null;
          }
        };
        const applyTextToElement = (target, text, mode) => {
          if ("disabled" in target && !!target.disabled) return { ok: false, error: "element is disabled" };
          if ("readOnly" in target && !!target.readOnly) return { ok: false, error: "element is readonly" };
          
          if ("focus" in target) {
            try { target.focus({ preventScroll: true }); } catch { target.focus(); }
          }
          // Aggressive activation: click and keydown to wake up React listeners
          try {
            target.click?.();
            target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
          } catch {}

          const monacoApplied = tryMonacoModelSet(target, text, mode);
          if (monacoApplied) return monacoApplied;
          if ("value" in target) {
            let setter = null;
            try {
              const proto = Object.getPrototypeOf(target);
              setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
                || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
                || null;
            } catch {}
            if (setter) setter.call(target, text);
            else target.value = text;
            dispatchInputLikeEvents(target, text, mode);
            return { ok: true, typed: text.length, mode, via: "backend-node-value", url: location.href, title: document.title };
          }
          if (target.isContentEditable) {
            let usedInsertText = false;
            try {
              if (typeof document.execCommand === "function") {
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(target);
                selection.removeAllRanges();
                selection.addRange(range);
                
                if (mode === "fill") {
                  try { document.execCommand("selectAll", false); } catch {}
                  try { document.execCommand("delete", false); } catch {}
                }
                usedInsertText = document.execCommand("insertText", false, text) === true;
              }
            } catch {
              usedInsertText = false;
            }
            if (!usedInsertText) {
              target.textContent = text;
            }
            dispatchInputLikeEvents(target, text, mode);
            return {
              ok: true,
              typed: text.length,
              mode,
              via: usedInsertText ? "backend-node-contenteditable-inserttext" : "backend-node-contenteditable-fallback",
              url: location.href,
              title: document.title
            };
          }
          return { ok: false, error: "element is not typable" };
        };
        const TYPABLE_SELECTOR = "input,textarea,[contenteditable='true'],[role='textbox'],[role='searchbox'],[role='combobox']";
        const isTypableElement = (target) => {
          if (!target || target.nodeType !== 1) return false;
          if ("disabled" in target && !!target.disabled) return false;
          if ("readOnly" in target && !!target.readOnly) return false;
          if ("value" in target) return true;
          if (target.isContentEditable === true) return true;
          const role = String(target.getAttribute?.("role") || "").trim().toLowerCase();
          return role === "textbox" || role === "searchbox" || role === "combobox";
        };
        const findTypableNear = (origin) => {
          if (!origin || origin.nodeType !== 1) return null;
          const resolveByIdAttr = (attrValue) => {
            const id = String(attrValue || "").trim();
            if (!id) return null;
            const el = document.getElementById(id);
            return isTypableElement(el) ? el : null;
          };
          const byAriaControls = resolveByIdAttr(origin.getAttribute?.("aria-controls"));
          if (byAriaControls) return byAriaControls;
          const byFor = resolveByIdAttr(origin.getAttribute?.("for"));
          if (byFor) return byFor;
          const directDesc = origin.querySelector?.(TYPABLE_SELECTOR);
          if (isTypableElement(directDesc)) return directDesc;
          const labelDesc = origin.closest?.("label")?.querySelector?.(TYPABLE_SELECTOR);
          if (isTypableElement(labelDesc)) return labelDesc;
          let cur = origin;
          for (let i = 0; i < 3 && cur; i += 1) {
            const inParent = cur.parentElement?.querySelector?.(TYPABLE_SELECTOR);
            if (isTypableElement(inParent)) return inParent;
            cur = cur.parentElement;
          }
          const active = document.activeElement;
          if (isTypableElement(active)) return active;
          return null;
        };
        el.scrollIntoView?.({ block: "center", inline: "nearest" });
        if (kind === "hover") {
          try {
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
          } catch {
            // ignore
          }
          return { ok: true, hovered: true, via: "backend-node", url: location.href, title: document.title };
        }
        const getFrameOffsets = () => {
          let x = 0;
          let y = 0;
          let reliable = true;
          let cur = window;
          try {
            while (cur && cur !== window.top) {
              const frameEl = cur.frameElement;
              if (!frameEl) break;
              const rect = frameEl.getBoundingClientRect();
              x += rect.left;
              y += rect.top;
              cur = cur.parent;
            }
          } catch {
            // ignore cross-origin access issues, coords will be best-effort
            reliable = false;
          }
          if (!Number.isFinite(x) || !Number.isFinite(y)) reliable = false;
          return { x, y, reliable };
        };
        if (kind === "click") {
          const rect = el.getBoundingClientRect();
          const offsets = getFrameOffsets();
          const localCenterX = rect.left + rect.width / 2;
          const localCenterY = rect.top + rect.height / 2;
          const hasValidRect =
            Number.isFinite(rect.width) &&
            Number.isFinite(rect.height) &&
            rect.width > 0 &&
            rect.height > 0 &&
            Number.isFinite(localCenterX) &&
            Number.isFinite(localCenterY);
          let trustedHit = false;
          if (hasValidRect) {
            try {
              const hit = document.elementFromPoint(localCenterX, localCenterY);
              trustedHit = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
            } catch {
              trustedHit = false;
            }
          }
          const centerX = offsets.x + localCenterX;
          const centerY = offsets.y + localCenterY;
          const shouldNativeClick =
            offsets.reliable === true &&
            hasValidRect &&
            trustedHit &&
            Number.isFinite(centerX) &&
            Number.isFinite(centerY);
          const nativeReason =
            shouldNativeClick
              ? "trusted-hit"
              : offsets.reliable !== true
                ? "frame-offset-unreliable"
                : hasValidRect !== true
                  ? "invalid-target-rect"
                  : "hit-untrusted";
          return {
            ok: true,
            shouldNativeClick,
            nativeReason,
            x: centerX,
            y: centerY,
            url: location.href,
            title: document.title
          };
        }
        if (kind === "type" || kind === "fill") {
          const target = isTypableElement(el) ? el : findTypableNear(el);
          if (!target) return { ok: false, error: "element is not typable" };
          return applyTextToElement(target, value, kind);
        }
        if (kind === "select") {
          if (!("value" in el)) return { ok: false, error: "element is not selectable" };
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, selected: value, via: "backend-node", url: location.href, title: document.title };
        }
        if (kind === "read") {
          const target = isTypableElement(el) ? el : findTypableNear(el) || el;
          if ("value" in target) {
            const val = String(target.value ?? "");
            return { ok: true, value: val, length: val.length, via: target === el ? "backend-node-value" : "backend-node-associated-value", url: location.href, title: document.title };
          }
          if (target.isContentEditable) {
            const text = String(target.textContent || "");
            return { ok: true, value: text, length: text.length, via: target === el ? "backend-node-contenteditable" : "backend-node-associated-contenteditable", url: location.href, title: document.title };
          }
          const text = String(target.textContent || "");
          return { ok: true, value: text, length: text.length, via: "backend-node-text", url: location.href, title: document.title };
        }
        return { ok: false, error: "unsupported backend action", kind };
      }`;
      const out = (await sendCdpCommand(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: expression,
        returnByValue: true,
        awaitPromise: true,
      })) as JsonRecord;
      const value = asRecord(asRecord(out.result).value);
      if (value.ok === false) {
        throw toRuntimeError(String(value.error || "backend action failed"), {
          code: "E_CDP_BACKEND_ACTION",
          retryable: true,
          details: { tabId, backendNodeId: input.backendNodeId, kind },
        });
      }
      if (value.shouldNativeClick === true) {
        try {
          const x = Number(value.x);
          const y = Number(value.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error("native click coordinates are not finite");
          }
          await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button: "left",
            clickCount: 1,
          });
          await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button: "left",
            clickCount: 1,
          });
          return {
            ok: true,
            clicked: true,
            via: "cdp-native",
            url: value.url,
            title: value.title,
            objectId,
          };
        } catch {
          // fallback to JS click via callFunctionOn
          await sendCdpCommand(tabId, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: "function() { this.click?.(); }",
            awaitPromise: true,
          });
          return {
            ok: true,
            clicked: true,
            via: "cdp-js-fallback",
            url: value.url,
            title: value.title,
            objectId,
          };
        }
      }
      if (kind === "click" && value.shouldNativeClick === false) {
        await sendCdpCommand(tabId, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function() { this.click?.(); }",
          awaitPromise: true,
        });
        return {
          ok: true,
          clicked: true,
          via: "cdp-js-fallback",
          nativeReason: value.nativeReason,
          url: value.url,
          title: value.title,
          objectId,
        };
      }
      return { ...value, objectId };
    } finally {
      if (objectId) {
        await sendCdpCommand(tabId, "Runtime.releaseObject", {
          objectId,
        }).catch(() => {
          // ignore stale object release
        });
      }
    }
  }

  async function executeRefActionByCDP(
    tabId: number,
    rawAction: JsonRecord,
  ): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const kind = normalizeActionKind(rawAction.kind);
    const key =
      typeof rawAction.key === "string"
        ? rawAction.key.trim()
        : typeof rawAction.value === "string"
          ? rawAction.value.trim()
          : "";
    const value = String(rawAction.value ?? rawAction.text ?? "");

    if (kind === "navigate") {
      const url = String(rawAction.url || "").trim();
      if (!url) throw new Error("url required for navigate");
      const nav = (await sendCdpCommand(tabId, "Page.navigate", {
        url,
      })) as JsonRecord;
      return {
        tabId,
        kind,
        result: {
          ok: true,
          navigated: true,
          to: url,
          frameId: nav.frameId || null,
        },
      };
    }

    if (kind === "press") {
      if (!key) throw new Error("key required for press");
      const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const k = ${JSON.stringify(key)};
          const t = document.activeElement || document.body;
          t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
          t.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
          return { ok: true, pressed: k, url: location.href, title: document.title };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      })) as JsonRecord;
      return {
        tabId,
        kind,
        result: asRecord(asRecord(out.result).value),
      };
    }

    const refRaw =
      typeof rawAction.ref === "string"
        ? rawAction.ref
        : typeof rawAction.uid === "string"
          ? rawAction.uid
          : "";
    const ref = String(refRaw || "").trim();
    const explicitSelector =
      typeof rawAction.selector === "string" ? rawAction.selector.trim() : "";
    const fromRef = ref ? resolveRefEntry(tabId, ref) : {};
    const selector = String(explicitSelector || fromRef.selector || "").trim();
    const brainUid = String(fromRef.brainUid || "").trim();
    const backendNodeId =
      toPositiveInteger(rawAction.backendNodeId) ||
      toPositiveInteger(fromRef.backendNodeId) ||
      toPositiveInteger(fromRef.nodeId);
    const waitForMsRaw = Number(rawAction.waitForMs);
    const waitForMs = Number.isFinite(waitForMsRaw)
      ? Math.max(0, Math.min(10_000, Math.floor(waitForMsRaw)))
      : kind === "click" ||
          kind === "type" ||
          kind === "fill" ||
          kind === "select"
        ? 1_500
        : 0;

    if (
      backendNodeId &&
      (kind === "click" ||
        kind === "type" ||
        kind === "fill" ||
        kind === "select" ||
        kind === "hover" ||
        kind === "read")
    ) {
      try {
        // For type/fill, we need to focus first to make Input commands work reliably
        if (kind === "type" || kind === "fill") {
          await sendCdpCommand(tabId, "DOM.focus", { backendNodeId });
        }

        const backendResult = await executeActionByBackendNode(tabId, {
          backendNodeId,
          kind,
          value,
          waitForMs: selector ? 0 : waitForMs,
          brainUid: brainUid || undefined,
        });

        if (kind === "type" || kind === "fill") {
          return {
            tabId,
            kind,
            uid: ref || undefined,
            ref: ref || undefined,
            selector: selector || undefined,
            backendNodeId,
            result: backendResult,
          };
        }
        return {
          tabId,
          kind,
          uid: ref || undefined,
          ref: ref || undefined,
          selector: selector || undefined,
          backendNodeId,
          result: backendResult,
        };
      } catch {
        // fallback to selector flow below
      }
    }

    if (!selector && kind === "scroll") {
      const delta = Number(rawAction.value ?? rawAction.y ?? 0);
      const top = Number.isFinite(delta) ? delta : 0;
      const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const top = Number(${JSON.stringify(top)});
          window.scrollBy({ top: Number.isFinite(top) ? top : 0, left: 0, behavior: "auto" });
          return { ok: true, scrolled: true, top: Number.isFinite(top) ? top : 0, url: location.href, title: document.title };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      })) as JsonRecord;
      return {
        tabId,
        kind,
        result: asRecord(asRecord(out.result).value),
      };
    }

    if (!selector)
      throw new Error("action target not found by ref/selector/backendNodeId");

    const expression = `(async () => {
      const selector = ${JSON.stringify(selector)};
      const kind = ${JSON.stringify(kind)};
      const value = ${JSON.stringify(value)};
      const waitForMs = ${waitForMs};
      const hint = ${JSON.stringify({
        tag: String(fromRef.tag || ""),
        role: String(fromRef.role || ""),
        name: String(fromRef.name || ""),
        placeholder: String(fromRef.placeholder || ""),
        ariaLabel: String(fromRef.ariaLabel || ""),
      })};
      const TYPABLE_SELECTOR = "input,textarea,[contenteditable='true'],[role='textbox'],[role='searchbox'],[role='combobox']";
      const allTypables = () => Array.from(
        document.querySelectorAll(TYPABLE_SELECTOR)
      ).filter((cand) => {
        if (!cand) return false;
        if ("disabled" in cand && !!cand.disabled) return false;
        if ("readOnly" in cand && !!cand.readOnly) return false;
        const rect = cand.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
      });
      const isTypableElement = (el) => {
        if (!el || el.nodeType !== 1) return false;
        if ("disabled" in el && !!el.disabled) return false;
        if ("readOnly" in el && !!el.readOnly) return false;
        if ("value" in el) return true;
        if (el.isContentEditable === true) return true;
        const role = String(el.getAttribute?.("role") || "").trim().toLowerCase();
        return role === "textbox" || role === "searchbox" || role === "combobox";
      };
      const findTypableNear = (origin) => {
        if (!origin || origin.nodeType !== 1) return null;
        const resolveByIdAttr = (attrValue) => {
          const id = String(attrValue || "").trim();
          if (!id) return null;
          const found = document.getElementById(id);
          return isTypableElement(found) ? found : null;
        };
        const byAriaControls = resolveByIdAttr(origin.getAttribute?.("aria-controls"));
        if (byAriaControls) return byAriaControls;
        const byFor = resolveByIdAttr(origin.getAttribute?.("for"));
        if (byFor) return byFor;
        const directDesc = origin.querySelector?.(TYPABLE_SELECTOR);
        if (isTypableElement(directDesc)) return directDesc;
        const labelDesc = origin.closest?.("label")?.querySelector?.(TYPABLE_SELECTOR);
        if (isTypableElement(labelDesc)) return labelDesc;
        let cur = origin;
        for (let i = 0; i < 3 && cur; i += 1) {
          const inParent = cur.parentElement?.querySelector?.(TYPABLE_SELECTOR);
          if (isTypableElement(inParent)) return inParent;
          cur = cur.parentElement;
        }
        const hinted = pickByHint();
        if (isTypableElement(hinted)) return hinted;
        const active = document.activeElement;
        if (isTypableElement(active)) return active;
        return null;
      };
      const pickByHint = () => {
        const candidates = allTypables();
        if (candidates.length === 1) return candidates[0];
        const nameNeedle = String(hint.name || "").trim().toLowerCase();
        const placeholderNeedle = String(hint.placeholder || "").trim().toLowerCase();
        const ariaNeedle = String(hint.ariaLabel || "").trim().toLowerCase();
        const tagNeedle = String(hint.tag || "").trim().toLowerCase();
        for (const cand of candidates) {
          if (tagNeedle && String(cand.tagName || "").toLowerCase() !== tagNeedle) continue;
          const cText = String(cand.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
          const cPlaceholder = String(cand.getAttribute?.("placeholder") || "").trim().toLowerCase();
          const cAria = String(cand.getAttribute?.("aria-label") || "").trim().toLowerCase();
          if (placeholderNeedle && cPlaceholder && cPlaceholder === placeholderNeedle) return cand;
          if (ariaNeedle && cAria && cAria === ariaNeedle) return cand;
          if (nameNeedle && cText && cText.includes(nameNeedle)) return cand;
        }
        return null;
      };
      const dispatchInputLikeEvents = (target, text, mode) => {
        try {
          target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
        } catch {
          // ignore unsupported InputEvent ctor
        }
        let inputSent = false;
        try {
          target.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          inputSent = true;
        } catch {
          // fallback below
        }
        if (!inputSent) target.dispatchEvent(new Event("input", { bubbles: true }));
        if (mode === "fill") target.dispatchEvent(new Event("change", { bubbles: true }));
        target.dispatchEvent(new Event("keyup", { bubbles: true }));
      };
      const tryMonacoModelSet = (target, text, mode) => {
        try {
          const root =
            target.closest?.(".monaco-editor")
            || (target.classList?.contains?.("monaco-editor") ? target : null);
          if (!root) return null;
          const monaco = globalThis.monaco || window.monaco;
          const editor = monaco?.editor;
          if (!editor) return null;
          const uriRaw = String(
            target.getAttribute?.("data-monaco-uri")
            || root.getAttribute?.("data-monaco-uri")
            || ""
          ).trim();
          let model = null;
          if (uriRaw && monaco?.Uri?.parse && typeof editor.getModel === "function") {
            try {
              model = editor.getModel(monaco.Uri.parse(uriRaw));
            } catch {
              // keep fallback
            }
          }
          if (!model && typeof editor.getModels === "function") {
            const models = editor.getModels();
            if (Array.isArray(models) && models.length > 0) model = models[0];
          }
          if (!model || typeof model.setValue !== "function") return null;
          model.setValue(text);
          if ("value" in target) target.value = text;
          dispatchInputLikeEvents(target, text, mode);
          return { ok: true, typed: text.length, mode, via: "monaco-model", url: location.href, title: document.title };
        } catch {
          return null;
        }
      };
      const applyTextToElement = (el, text, mode) => {
        if (!el) return { ok: false, error: "element missing" };
        if ("disabled" in el && !!el.disabled) return { ok: false, error: "element is disabled" };
        if ("readOnly" in el && !!el.readOnly) return { ok: false, error: "element is readonly" };
        if ("focus" in el) {
          try { el.focus({ preventScroll: true }); } catch { el.focus(); }
        }
        const monacoApplied = tryMonacoModelSet(el, text, mode);
        if (monacoApplied) return monacoApplied;
        if ("value" in el) {
          let setter = null;
          try {
            const proto = Object.getPrototypeOf(el);
            setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
              || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
              || null;
          } catch {}
          if (setter) {
            setter.call(el, text);
          } else {
            el.value = text;
          }
          dispatchInputLikeEvents(el, text, mode);
          return { ok: true, typed: text.length, mode, via: "value-setter", url: location.href, title: document.title };
        }
        if (el.isContentEditable) {
          try {
            if (typeof document.execCommand === "function") {
              document.execCommand("selectAll", false);
              document.execCommand("insertText", false, text);
            } else {
              el.textContent = text;
            }
          } catch {
            el.textContent = text;
          }
          dispatchInputLikeEvents(el, text, mode);
          return { ok: true, typed: text.length, mode, via: "contenteditable", url: location.href, title: document.title };
        }
        return { ok: false, error: "element is not typable", mode };
      };
      const resolveElement = () => {
        const fromSelector = selector ? document.querySelector(selector) : null;
        if (fromSelector) {
          if (kind === "type" || kind === "fill" || kind === "read") {
            const typedTarget = isTypableElement(fromSelector) ? fromSelector : findTypableNear(fromSelector);
            if (typedTarget) return typedTarget;
          }
          return fromSelector;
        }
        if (kind === "type" || kind === "fill") return pickByHint();
        return null;
      };
      const waitForElement = async () => {
        const started = Date.now();
        while (true) {
          const found = resolveElement();
          if (found) return found;
          if (Date.now() - started >= waitForMs) return null;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      };
      let el = await waitForElement();
      if (!el) return { ok: false, error: "selector not found", selector };
      el.scrollIntoView?.({ block: "center", inline: "nearest" });
      if (kind === "hover") {
        try {
          el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
        } catch {
          // ignore
        }
        return { ok: true, hovered: true, url: location.href, title: document.title };
      }
      if (kind === "click") {
        el.click?.();
        return { ok: true, clicked: true, url: location.href, title: document.title };
      }
      if (kind === "type" || kind === "fill") {
        return applyTextToElement(el, value, kind);
      }
      if (kind === "select") {
        if (!("value" in el)) return { ok: false, error: "element is not selectable" };
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selected: value, url: location.href, title: document.title };
      }
      if (kind === "read") {
        const readTarget = isTypableElement(el) ? el : findTypableNear(el) || el;
        if ("value" in readTarget) {
          const val = String(readTarget.value ?? "");
          return { ok: true, value: val, length: val.length, url: location.href, title: document.title, via: readTarget === el ? "selector-value" : "selector-associated-value" };
        }
        if (readTarget.isContentEditable) {
          const text = String(readTarget.textContent || "");
          return { ok: true, value: text, length: text.length, url: location.href, title: document.title, via: readTarget === el ? "selector-contenteditable" : "selector-associated-contenteditable" };
        }
        const text = String(readTarget.textContent || "");
        return { ok: true, value: text, length: text.length, url: location.href, title: document.title, via: "selector-text" };
      }
      if (kind === "scroll") {
        return { ok: true, scrolled: true, url: location.href, title: document.title };
      }
      return { ok: false, error: "unsupported action kind", kind };
    })()`;

    const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as JsonRecord;

    const resultValue = asRecord(asRecord(out.result).value);
    if (resultValue.ok === false) {
      throw new Error(String(resultValue.error || "cdp.action failed"));
    }

    return {
      tabId,
      kind,
      uid: ref || undefined,
      ref: ref || undefined,
      selector,
      backendNodeId: backendNodeId || undefined,
      result: resultValue,
    };
  }

  async function executeByCDP(
    tabId: number,
    action: JsonRecord,
  ): Promise<unknown> {
    await ensureDebugger(tabId);

    if (action.type === "runtime.evaluate") {
      return await sendCdpCommand(tabId, "Runtime.evaluate", {
        expression: action.expression,
        returnByValue: action.returnByValue !== false,
      });
    }
    if (action.type === "navigate") {
      return await sendCdpCommand(tabId, "Page.navigate", { url: action.url });
    }
    if (action.domain && action.method) {
      return await sendCdpCommand(
        tabId,
        `${String(action.domain)}.${String(action.method)}`,
        asRecord(action.params),
      );
    }
    throw new Error("Unsupported CDP action");
  }

  async function verifyByCDP(
    tabId: number,
    action: JsonRecord,
    result: JsonRecord | null,
  ): Promise<JsonRecord> {
    const expect =
      action.expect && typeof action.expect === "object"
        ? asRecord(action.expect)
        : action;
    const defaultWaitMs =
      expect.urlChanged === true ||
      Boolean(expect.selectorExists) ||
      Boolean(expect.textIncludes)
        ? 1_500
        : 0;
    const waitForMs = toIntInRange(expect.waitForMs, defaultWaitMs, 0, 15_000);
    const pollIntervalMs = toIntInRange(expect.pollIntervalMs, 120, 50, 1_000);
    const started = Date.now();

    let attempts = 0;
    let finalChecks: JsonRecord[] = [];
    let finalObservation: JsonRecord = {};
    let finalVerified = false;

    while (true) {
      attempts += 1;
      const observation = await observeByCDP(tabId);
      const checks: JsonRecord[] = [];
      let verified = true;

      if (expect.expectUrlContains || expect.urlContains) {
        const expected = String(
          expect.expectUrlContains || expect.urlContains || "",
        );
        const pass = String(asRecord(observation.page).url || "").includes(
          expected,
        );
        checks.push({ name: "expectUrlContains", pass, expected });
        if (!pass) verified = false;
      }
      if (expect.expectTitleContains || expect.titleContains) {
        const expected = String(
          expect.expectTitleContains || expect.titleContains || "",
        );
        const pass = String(asRecord(observation.page).title || "").includes(
          expected,
        );
        checks.push({ name: "expectTitleContains", pass, expected });
        if (!pass) verified = false;
      }
      if (expect.urlChanged === true) {
        const previousUrl = String(
          expect.previousUrl || asRecord(result).url || "",
        );
        const currentUrl = String(asRecord(observation.page).url || "");
        const pass = !!previousUrl && previousUrl !== currentUrl;
        checks.push({ name: "urlChanged", pass, previousUrl, currentUrl });
        if (!pass) verified = false;
      }
      if (expect.textIncludes) {
        const expected = String(expect.textIncludes);
        const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const readText = (doc) => {
              let text = String(doc?.body?.innerText || "");
              const frames = Array.from(doc?.querySelectorAll?.("iframe") || []);
              for (const frame of frames) {
                try {
                  const childDoc = frame.contentDocument;
                  if (!childDoc) continue;
                  text += "\\n" + readText(childDoc);
                } catch {
                  // cross-origin frame
                }
              }
              return text;
            };
            return readText(document);
          })()`,
          returnByValue: true,
        })) as JsonRecord;
        const text = String(asRecord(out.result).value || "");
        const pass = text.includes(expected);
        checks.push({ name: "textIncludes", pass, expected });
        if (!pass) verified = false;
      }
      if (expect.selectorExists) {
        const selector = String(expect.selectorExists);
        const out = (await sendCdpCommand(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const selector = ${JSON.stringify(selector)};
            const existsIn = (doc) => {
              if (doc?.querySelector?.(selector)) return true;
              const frames = Array.from(doc?.querySelectorAll?.("iframe") || []);
              for (const frame of frames) {
                try {
                  const childDoc = frame.contentDocument;
                  if (!childDoc) continue;
                  if (existsIn(childDoc)) return true;
                } catch {
                  // cross-origin frame
                }
              }
              return false;
            };
            return existsIn(document);
          })()`,
          returnByValue: true,
        })) as JsonRecord;
        const pass = asRecord(out.result).value === true;
        checks.push({ name: "selectorExists", pass, expected: selector });
        if (!pass) verified = false;
      }
      if (result && result.ok === false) {
        checks.push({ name: "invokeResult", pass: false, expected: "ok=true" });
        verified = false;
      }

      finalChecks = checks;
      finalObservation = observation;
      finalVerified = verified;

      if (verified) break;
      if (Date.now() - started >= waitForMs) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return {
      ok: finalVerified,
      checks: finalChecks,
      observation: finalObservation,
      attempts,
      elapsedMs: Date.now() - started,
    };
  }

  return {
    resolveRefEntry,
    executeActionByBackendNode,
    executeRefActionByCDP,
    executeByCDP,
    verifyByCDP,
  };
}
