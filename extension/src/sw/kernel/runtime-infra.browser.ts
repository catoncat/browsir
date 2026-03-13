import { defaultPipeline as enrichmentPipeline } from "./snapshot-enricher";
import {
  createBridgeClient,
} from "./infra-bridge-client";
import { createCdpActionExecutor } from "./infra-cdp-action";
export type { BridgeConfig } from "./infra-bridge-client";
import {
  snapshotKey,
  summarizeSnapshotNode,
  formatNodeCompact,
  buildCompactSnapshot,
  readAxValue,
  readAxBooleanProperty,
  isInteractiveRole,
  collectFrameIdsFromTree,
  actionRequiresLease,
  normalizeActionKind,
  normalizeSnapshotOptions,
} from "./infra-snapshot-helpers";

const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 10_000;
const MAX_CDP_COMMAND_TIMEOUT_MS = 60_000;
const CDP_AUTO_DETACH_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export interface RuntimeOk<T = unknown> {
  ok: true;
  data?: T;
}

export interface RuntimeErr {
  ok: false;
  error: string;
  code?: string;
  details?: unknown;
  retryable?: boolean;
  status?: number;
}

export type RuntimeInfraResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

export interface RuntimeInfraHandler {
  handleMessage(message: unknown): Promise<RuntimeInfraResult | null>;
  disconnectBridge(): void;
  abortBridgeInvokesBySession(
    sessionId: string,
    reason?: "stop" | "steer_preempt",
  ): number;
}

interface LeaseState {
  tabId: number;
  owner: string;
  leaseId: string;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

interface PendingCdpCommand {
  method: string;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SnapshotState {
  byKey: Map<string, JsonRecord>;
  refMap: Map<string, JsonRecord>;
  lastSnapshotId: string | null;
  failureCounts: Map<string, number>;
}

interface TelemetryState {
  console: JsonRecord[];
  network: JsonRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix = "id"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashText(input: unknown): string {
  const text = String(input ?? "");
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function buildStableRef(node: JsonRecord, sourcePrefix: string): string {
  const backendNodeId = toPositiveInteger(node.backendNodeId);
  if (backendNodeId) return `bn-${backendNodeId}`;
  const fingerprint = [
    String(node.selector || ""),
    String(node.tag || ""),
    String(node.role || ""),
    String(node.name || ""),
    String(node.placeholder || ""),
    String(node.ariaLabel || ""),
  ].join("|");
  const hash = hashText(fingerprint || JSON.stringify(node));
  return `${sourcePrefix}-${hash}`;
}

function enrichSnapshotNodes(
  state: SnapshotState,
  nodes: JsonRecord[],
  key: string,
  snapshotId: string,
  sourcePrefix: string,
): JsonRecord[] {
  const nextRefMap = new Map(state.refMap);
  const seen = new Map<string, number>();
  const enrichedNodes = nodes.map((node) => {
    const baseRef = buildStableRef(node, sourcePrefix);
    const nextCount = (seen.get(baseRef) || 0) + 1;
    seen.set(baseRef, nextCount);
    const ref = nextCount > 1 ? `${baseRef}-${nextCount}` : baseRef;
    const enriched: JsonRecord = {
      ...node,
      uid: ref,
      ref,
      key,
      snapshotId,
    };
    nextRefMap.set(ref, enriched);
    return enriched;
  });
  state.refMap = nextRefMap;
  return enrichedNodes;
}

function toValidTabId(raw: unknown): number | null {
  const tabId = Number(raw);
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  return tabId;
}

function toPositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
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

function toPositiveInteger(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function normalizeOwner(raw: unknown): string {
  const owner = typeof raw === "string" ? raw.trim() : "";
  if (!owner) {
    throw new Error("owner is required for lease/cdp.action");
  }
  return owner;
}

function normalizeLeaseTtl(rawTtl: unknown): number {
  const ttl = toPositiveInt(rawTtl, DEFAULT_LEASE_TTL_MS);
  return Math.max(2000, Math.min(MAX_LEASE_TTL_MS, ttl));
}

function resolveOwnerFromMessage(message: unknown): string {
  const msg = asRecord(message);
  return String(msg.owner || msg.sessionId || msg.agentId || "");
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function ok<T>(data?: T): RuntimeInfraResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): RuntimeInfraResult {
  if (error instanceof Error) {
    const enriched = error as Error & {
      code?: unknown;
      details?: unknown;
      retryable?: unknown;
      status?: unknown;
    };
    const out: RuntimeErr = {
      ok: false,
      error: error.message,
    };
    if (typeof enriched.code === "string" && enriched.code.trim())
      out.code = enriched.code.trim();
    if (enriched.details !== undefined) out.details = enriched.details;
    if (typeof enriched.retryable === "boolean")
      out.retryable = enriched.retryable;
    if (Number.isFinite(Number(enriched.status)))
      out.status = Number(enriched.status);
    return out;
  }
  return { ok: false, error: String(error) };
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

export function createRuntimeInfraHandler(): RuntimeInfraHandler {
  const bridge = createBridgeClient();

  const leaseByTab = new Map<number, LeaseState>();
  const attachedTabs = new Set<number>();
  const attachLocksByTab = new Map<number, Promise<void>>();
  const enabledDomainsByTab = new Map<number, Set<string>>();
  const pendingCdpByTab = new Map<number, Set<PendingCdpCommand>>();
  const cdpAutoDetachTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const telemetryByTab = new Map<number, TelemetryState>();
  const snapshotStateByTab = new Map<number, SnapshotState>();
  let debuggerHooksInstalled = false;

  function getLease(tabId: number): LeaseState | null {
    const lease = leaseByTab.get(tabId);
    if (!lease) return null;
    if (lease.expiresAt <= Date.now()) {
      leaseByTab.delete(tabId);
      return null;
    }
    return lease;
  }

  function leaseStatus(tabId: number): JsonRecord {
    const lease = getLease(tabId);
    if (!lease) return { tabId, locked: false };
    return {
      tabId,
      locked: true,
      owner: lease.owner,
      leaseId: lease.leaseId,
      expiresAt: new Date(lease.expiresAt).toISOString(),
      heartbeatAt: new Date(lease.heartbeatAt).toISOString(),
    };
  }

  function acquireLease(
    tabId: number,
    rawOwner: unknown,
    rawTtlMs: unknown,
  ): JsonRecord {
    const owner = normalizeOwner(rawOwner);
    const ttlMs = normalizeLeaseTtl(rawTtlMs);
    const current = getLease(tabId);
    if (current && current.owner !== owner) {
      return {
        ok: false,
        reason: "locked_by_other",
        lease: leaseStatus(tabId),
      };
    }
    const next: LeaseState = {
      tabId,
      owner,
      leaseId: current?.leaseId || randomId("lease"),
      createdAt: current?.createdAt || Date.now(),
      heartbeatAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    leaseByTab.set(tabId, next);
    return { ok: true, lease: leaseStatus(tabId) };
  }

  function heartbeatLease(
    tabId: number,
    rawOwner: unknown,
    rawTtlMs: unknown,
  ): JsonRecord {
    const owner = normalizeOwner(rawOwner);
    const ttlMs = normalizeLeaseTtl(rawTtlMs);
    const lease = getLease(tabId);
    if (!lease) return { ok: false, reason: "not_locked" };
    if (lease.owner !== owner)
      return {
        ok: false,
        reason: "locked_by_other",
        lease: leaseStatus(tabId),
      };
    lease.heartbeatAt = Date.now();
    lease.expiresAt = Date.now() + ttlMs;
    leaseByTab.set(tabId, lease);
    return { ok: true, lease: leaseStatus(tabId) };
  }

  function releaseLease(tabId: number, rawOwner: unknown): JsonRecord {
    const owner = normalizeOwner(rawOwner);
    const lease = getLease(tabId);
    if (!lease) return { ok: true, released: false, reason: "not_locked" };
    if (lease.owner !== owner)
      return {
        ok: false,
        reason: "locked_by_other",
        lease: leaseStatus(tabId),
      };
    leaseByTab.delete(tabId);
    return { ok: true, released: true };
  }

  function ensureLeaseForWrite(tabId: number, rawOwner: unknown): void {
    const owner = normalizeOwner(rawOwner);
    const lease = getLease(tabId);
    if (!lease) throw new Error("tab is not leased");
    if (lease.owner !== owner) throw new Error(`tab leased by ${lease.owner}`);
  }

  function getTabTelemetry(tabId: number): TelemetryState {
    if (!telemetryByTab.has(tabId)) {
      telemetryByTab.set(tabId, { console: [], network: [] });
    }
    return telemetryByTab.get(tabId)!;
  }

  function trimTelemetry(items: JsonRecord[], max = 120): void {
    if (items.length > max) {
      items.splice(0, items.length - max);
    }
  }

  function getSnapshotState(tabId: number): SnapshotState {
    const state = snapshotStateByTab.get(tabId);
    if (state) return state;
    const created: SnapshotState = {
      byKey: new Map(),
      refMap: new Map(),
      lastSnapshotId: null,
      failureCounts: new Map(),
    };
    snapshotStateByTab.set(tabId, created);
    return created;
  }

  function clearSnapshotState(tabId: number): void {
    snapshotStateByTab.delete(tabId);
  }

  function clearCdpAutoDetach(tabId: number): void {
    const timer = cdpAutoDetachTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      cdpAutoDetachTimers.delete(tabId);
    }
  }

  function scheduleCdpAutoDetach(tabId: number): void {
    clearCdpAutoDetach(tabId);
    cdpAutoDetachTimers.set(
      tabId,
      setTimeout(() => {
        detachCDP(tabId).catch(() => {
          // best-effort auto cleanup
        });
      }, CDP_AUTO_DETACH_MS),
    );
  }

  function touchCdpSession(tabId: number): void {
    if (!attachedTabs.has(tabId)) return;
    scheduleCdpAutoDetach(tabId);
  }

  function rejectPendingCdpCommands(tabId: number, reason: string): void {
    const pending = pendingCdpByTab.get(tabId);
    if (!pending) return;
    pendingCdpByTab.delete(tabId);
    for (const item of pending) {
      clearTimeout(item.timeout);
      item.reject(
        toRuntimeError(`CDP command '${item.method}' aborted: ${reason}`, {
          code: "E_CDP_ABORTED",
          retryable: true,
          details: { tabId, method: item.method, reason },
        }),
      );
    }
  }

  async function sendCdpCommand<T = JsonRecord>(
    tabId: number,
    method: string,
    params: unknown = {},
    rawOptions: { timeoutMs?: unknown } = {},
  ): Promise<T> {
    const timeoutMs = toIntInRange(
      rawOptions.timeoutMs,
      DEFAULT_CDP_COMMAND_TIMEOUT_MS,
      200,
      MAX_CDP_COMMAND_TIMEOUT_MS,
    );
    touchCdpSession(tabId);
    return await new Promise<T>((resolve, reject) => {
      const pendingSet =
        pendingCdpByTab.get(tabId) || new Set<PendingCdpCommand>();
      if (!pendingCdpByTab.has(tabId)) pendingCdpByTab.set(tabId, pendingSet);

      let finished = false;
      const finish = (error: unknown, value?: T): void => {
        if (finished) return;
        finished = true;
        pendingSet.delete(entry);
        clearTimeout(entry.timeout);
        if (pendingSet.size === 0) pendingCdpByTab.delete(tabId);
        if (error) {
          reject(
            error instanceof Error
              ? error
              : toRuntimeError(
                  String(error || `CDP command failed: ${method}`),
                  {
                    code: "E_CDP_COMMAND",
                    retryable: true,
                    details: { tabId, method },
                  },
                ),
          );
          return;
        }
        resolve(value as T);
      };

      const entry: PendingCdpCommand = {
        method,
        reject: (error: Error) => finish(error),
        timeout: setTimeout(() => {
          finish(
            toRuntimeError(
              `CDP command '${method}' timed out after ${timeoutMs}ms`,
              {
                code: "E_CDP_TIMEOUT",
                retryable: true,
                details: { tabId, method, timeoutMs },
              },
            ),
          );
        }, timeoutMs),
      };
      pendingSet.add(entry);

      Promise.resolve()
        .then(() =>
          chrome.debugger.sendCommand({ tabId }, method, asRecord(params)),
        )
        .then((value) => {
          finish(null, value as T);
        })
        .catch((error) => finish(error));
    });
  }

  async function ensureCdpDomains(
    tabId: number,
    domains: string[],
  ): Promise<void> {
    const enabled = enabledDomainsByTab.get(tabId) || new Set<string>();
    if (!enabledDomainsByTab.has(tabId))
      enabledDomainsByTab.set(tabId, enabled);
    for (const domain of domains) {
      if (enabled.has(domain)) continue;
      try {
        await sendCdpCommand(tabId, `${domain}.enable`, {});
        enabled.add(domain);
      } catch (error) {
        if (domain === "Accessibility") continue;
        throw error;
      }
    }
  }

  function installDebuggerHooks(): void {
    if (debuggerHooksInstalled) return;
    debuggerHooksInstalled = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (!source || typeof source.tabId !== "number") return;
      const tabId = source.tabId;
      const telemetry = getTabTelemetry(tabId);

      if (method === "Runtime.consoleAPICalled") {
        const args = Array.isArray((params as JsonRecord)?.args)
          ? ((params as JsonRecord).args as JsonRecord[])
          : [];
        telemetry.console.push({
          ts: nowIso(),
          type: String((params as JsonRecord)?.type || ""),
          args: args.map((item) => item.value ?? item.description ?? ""),
        });
        trimTelemetry(telemetry.console);
        return;
      }

      if (method === "Network.responseReceived") {
        const response = asRecord((params as JsonRecord).response);
        telemetry.network.push({
          ts: nowIso(),
          requestId: (params as JsonRecord).requestId,
          url: response.url,
          status: response.status,
          mimeType: response.mimeType,
        });
        trimTelemetry(telemetry.network);
      }
    });

    chrome.debugger.onDetach.addListener((source) => {
      if (!source || typeof source.tabId !== "number") return;
      const tabId = source.tabId;
      attachedTabs.delete(tabId);
      attachLocksByTab.delete(tabId);
      enabledDomainsByTab.delete(tabId);
      clearCdpAutoDetach(tabId);
      rejectPendingCdpCommands(tabId, "debugger detached");
      telemetryByTab.delete(tabId);
      clearSnapshotState(tabId);
      leaseByTab.delete(tabId);
    });

    if (chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId) => {
        attachedTabs.delete(tabId);
        attachLocksByTab.delete(tabId);
        enabledDomainsByTab.delete(tabId);
        clearCdpAutoDetach(tabId);
        rejectPendingCdpCommands(tabId, "tab closed");
        telemetryByTab.delete(tabId);
        clearSnapshotState(tabId);
        leaseByTab.delete(tabId);
      });
    }
  }

  async function ensureDebugger(tabId: number): Promise<void> {
    installDebuggerHooks();
    if (attachedTabs.has(tabId)) {
      touchCdpSession(tabId);
      await ensureCdpDomains(tabId, [
        "Network",
        "Runtime",
        "DOM",
        "Page",
        "Log",
        "Accessibility",
      ]);
      return;
    }
    const existing = attachLocksByTab.get(tabId);
    if (existing) {
      await existing;
      touchCdpSession(tabId);
      await ensureCdpDomains(tabId, [
        "Network",
        "Runtime",
        "DOM",
        "Page",
        "Log",
        "Accessibility",
      ]);
      return;
    }

    const attachTask = (async () => {
      try {
        if (
          typeof chrome !== "undefined" &&
          chrome.tabs &&
          typeof chrome.tabs.get === "function"
        ) {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (tab?.url) {
            const url = tab.url.toLowerCase();
            if (
              url.startsWith("chrome://") ||
              url.startsWith("about:") ||
              url.startsWith("edge://") ||
              url.startsWith("chrome-extension://") ||
              url.includes("chrome.google.com/webstore")
            ) {
              throw new Error(
                `Chrome restricts debugger access to this URL (${tab.url}). Please navigate to a standard website or call 'create_new_tab' first.`,
              );
            }
          }
        }
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedTabs.add(tabId);
        enabledDomainsByTab.delete(tabId);
        touchCdpSession(tabId);
      } catch (error) {
        throw toRuntimeError(
          `attach debugger failed for tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`,
          {
            code: "E_CDP_ATTACH",
            retryable: true,
            details: { tabId },
          },
        );
      }
    })();
    attachLocksByTab.set(tabId, attachTask);
    try {
      await attachTask;
    } finally {
      attachLocksByTab.delete(tabId);
    }
    await ensureCdpDomains(tabId, [
      "Network",
      "Runtime",
      "DOM",
      "Page",
      "Log",
      "Accessibility",
    ]);
  }

  async function observeByCDP(tabId: number): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const evalResult = (await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression: `(() => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        textLength: document.body?.innerText?.length ?? 0,
        nodeCount: document.querySelectorAll('*').length
      }))()`,
      returnByValue: true,
    })) as JsonRecord;
    const page = asRecord(asRecord(evalResult.result).value);
    const telemetry = getTabTelemetry(tabId);
    return {
      ts: nowIso(),
      tabId,
      page,
      console: telemetry.console.slice(-20),
      network: telemetry.network.slice(-20),
    };
  }

  async function listFrameIdsForSnapshot(tabId: number): Promise<string[]> {
    try {
      const frameTreeResult = (await sendCdpCommand(
        tabId,
        "Page.getFrameTree",
        {},
        { timeoutMs: 4_000 },
      )) as JsonRecord;
      const frameIds = collectFrameIdsFromTree(
        frameTreeResult.frameTree,
      ).filter(Boolean);
      return Array.from(new Set(frameIds));
    } catch {
      return [];
    }
  }

  async function resolveElementMetaByBackendNode(
    tabId: number,
    backendNodeId: number,
    scopeSelector: string,
  ): Promise<JsonRecord | null> {
    let objectId = "";
    try {
      const resolved = (await sendCdpCommand(tabId, "DOM.resolveNode", {
        backendNodeId,
      })) as JsonRecord;
      objectId = String(asRecord(resolved.object).objectId || "");
      if (!objectId) return null;
      const expression = `function() {
        if (!this || this.nodeType !== 1) return null;
        const scopeSelector = ${JSON.stringify(scopeSelector)};
        const isValidIdent = (v) => /^[A-Za-z_][A-Za-z0-9_:\\-\\.]*$/.test(v || "");
        const safeAttr = (v) => String(v || "").split("\\\\").join("\\\\\\\\").replace(/"/g, '\\"');
        const fallbackPath = (el) => {
          const parts = [];
          let cur = el;
          let depth = 0;
          while (cur && cur.nodeType === 1 && depth < 5) {
            const tag = (cur.tagName || "div").toLowerCase();
            if (cur.id && isValidIdent(cur.id)) {
              parts.unshift("#" + cur.id);
              break;
            }
            let part = tag;
            const cls = String(cur.className || "")
              .split(/\\s+/)
              .map((x) => x.trim())
              .filter(Boolean)
              .find((x) => isValidIdent(x));
            if (cls) part += "." + cls;
            const parent = cur.parentElement;
            if (parent) {
              const sameTag = Array.from(parent.children).filter((child) => child.tagName === cur.tagName);
              if (sameTag.length > 1) {
                part += ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")";
              }
            }
            parts.unshift(part);
            cur = cur.parentElement;
            depth += 1;
          }
          return parts.join(" > ");
        };
        const makeSelector = (el) => {
          if (el.id && isValidIdent(el.id)) return "#" + el.id;
          const name = (el.getAttribute("name") || "").trim();
          if (name) return el.tagName.toLowerCase() + '[name="' + safeAttr(name) + '"]';
          const testId = (el.getAttribute("data-testid") || el.getAttribute("data-test") || "").trim();
          if (testId) return el.tagName.toLowerCase() + '[data-testid="' + safeAttr(testId) + '"]';
          const ariaLabel = (el.getAttribute("aria-label") || "").trim();
          if (ariaLabel) return el.tagName.toLowerCase() + '[aria-label="' + safeAttr(ariaLabel) + '"]';
          const placeholder = (el.getAttribute("placeholder") || "").trim();
          if (placeholder) return el.tagName.toLowerCase() + '[placeholder="' + safeAttr(placeholder) + '"]';
          return fallbackPath(el);
        };
        let matchesScope = true;
        if (scopeSelector) {
          try {
            matchesScope = this.matches(scopeSelector) || !!this.closest(scopeSelector);
          } catch {
            matchesScope = false;
          }
        }
        const role =
          String(this.getAttribute("role") || "")
            .trim()
            .toLowerCase() || String(this.tagName || "node").toLowerCase();
        const editable =
          this.isContentEditable === true ||
          ("value" in this) ||
          role === "textbox" ||
          role === "searchbox" ||
          role === "combobox";
        const text = String(this.textContent || "").replace(/\\s+/g, " ").trim();
        const value = "value" in this ? String(this.value || "") : "";
        const href = String(this.getAttribute?.("href") || "").trim();
        let navType = "";
        if (href) {
          try {
            const url = new URL(href, location.href);
            const isSameOrigin = url.origin === location.origin;
            const isLikelyDetail = /[\\/](status|p|item|detail|post|article)[\\/]/i.test(url.pathname);
            navType = isSameOrigin || isLikelyDetail ? "nav" : "ext";
          } catch {
            navType = "ext";
          }
        }

        const brainUid = "brain-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
        if (!this.getAttribute("data-brain-uid")) {
          this.setAttribute("data-brain-uid", brainUid);
        }
        const effectiveUid = this.getAttribute("data-brain-uid");

        const checkVisible = (el) => {
          if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
          const rect = el.getBoundingClientRect();
          return !!(rect.width && rect.height && rect.top < window.innerHeight && rect.left < window.innerWidth && rect.bottom > 0 && rect.right > 0);
        };
        const getAriaBool = (name) => {
          const v = this.getAttribute(name);
          if (v === "true") return true;
          if (v === "false") return false;
          return undefined;
        };
        return {
          ok: true,
          matchesScope,
          tag: String(this.tagName || "").toLowerCase(),
          role,
          name: text.slice(0, 180),
          value: value.slice(0, 180),
          placeholder: String(this.getAttribute("placeholder") || "").slice(0, 180),
          ariaLabel: String(this.getAttribute("aria-label") || "").slice(0, 180),
          editable,
          selector: makeSelector(this),
          disabled: !!this.disabled || getAriaBool("aria-disabled") === true,
          focused: document.activeElement === this,
          visible: checkVisible(this),
          expanded: getAriaBool("aria-expanded"),
          checked: getAriaBool("aria-checked") ?? (typeof this.checked === "boolean" ? this.checked : undefined),
          selected: getAriaBool("aria-selected") ?? (typeof this.selected === "boolean" ? this.selected : undefined),
          required: !!this.required || getAriaBool("aria-required") === true,
          brainUid: effectiveUid,
          navType: navType || undefined
        };
      }`;
      const result = (await sendCdpCommand(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: expression,
        returnByValue: true,
        awaitPromise: true,
      })) as JsonRecord;
      const value = asRecord(asRecord(result.result).value);
      return value.ok === true ? value : null;
    } catch {
      return null;
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

  async function takeInteractiveSnapshotByAX(
    tabId: number,
    options: JsonRecord,
    base: JsonRecord,
    state: SnapshotState,
    key: string,
    snapshotId: string,
  ): Promise<JsonRecord> {
    const pageResult = (await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression: `(() => ({ url: location.href, title: document.title }))()`,
      returnByValue: true,
    })) as JsonRecord;
    const page = asRecord(asRecord(pageResult.result).value);

    const frameIds = await listFrameIdsForSnapshot(tabId);
    const treeBuckets: Array<{ frameId: string; nodes: JsonRecord[] }> = [];
    for (const frameId of frameIds) {
      try {
        const tree = (await sendCdpCommand(
          tabId,
          "Accessibility.getFullAXTree",
          { frameId },
        )) as JsonRecord;
        const nodes = Array.isArray(tree.nodes)
          ? (tree.nodes as JsonRecord[])
          : [];
        if (nodes.length > 0) treeBuckets.push({ frameId, nodes });
      } catch {
        // ignore inaccessible frame tree and keep others
      }
    }
    if (treeBuckets.length === 0) {
      const fallbackTree = (await sendCdpCommand(
        tabId,
        "Accessibility.getFullAXTree",
        {},
      )) as JsonRecord;
      const nodes = Array.isArray(fallbackTree.nodes)
        ? (fallbackTree.nodes as JsonRecord[])
        : [];
      if (nodes.length > 0) treeBuckets.push({ frameId: "", nodes });
    }
    if (treeBuckets.length === 0) {
      throw toRuntimeError("Accessibility.getFullAXTree returned empty tree", {
        code: "E_CDP_AXTREE_EMPTY",
        retryable: true,
        details: { tabId, frameIds },
      });
    }

    const maxNodes = Number(options.maxNodes || 120);
    const scopeSelector = String(options.selector || "");
    const mode = String(options.mode || "interactive");
    const filter = String(options.filter || "interactive");
    const allowAll = mode === "full" || filter === "all";

    const candidates: JsonRecord[] = [];
    for (const bucket of treeBuckets) {
      for (const rawNode of bucket.nodes) {
        const node = asRecord(rawNode);
        if (node.ignored === true) continue;
        const backendNodeId = toPositiveInteger(node.backendDOMNodeId);
        if (!backendNodeId) continue;
        const role = readAxValue(node.role).trim().toLowerCase();
        const name = readAxValue(node.name).trim();
        const value = readAxValue(node.value).trim();
        const focusable = readAxBooleanProperty(node.properties, "focusable");
        const focused = readAxBooleanProperty(node.properties, "focused");
        const disabled = readAxBooleanProperty(node.properties, "disabled");
        const interactive = isInteractiveRole(role) || focusable === true;
        if (!allowAll && !interactive) continue;
        candidates.push({
          backendNodeId,
          frameId: bucket.frameId,
          axNodeId: String(node.nodeId || ""),
          parentId: node.parentId ? String(node.parentId) : undefined,
          childIds: Array.isArray(node.childIds)
            ? node.childIds.map(String)
            : [],
          role: role || "node",
          name: name.slice(0, 180),
          value: value.slice(0, 180),
          focused: focused === true,
          disabled: disabled === true,
        });
        if (candidates.length >= Math.max(maxNodes * 3, 240)) break;
      }
      if (candidates.length >= Math.max(maxNodes * 3, 240)) break;
    }

    const enrichedNodes: JsonRecord[] = [];
    const seenBackendNodeIds = new Set<number>();
    for (const item of candidates) {
      const backendNodeId = toPositiveInteger(item.backendNodeId);
      if (!backendNodeId) continue;
      if (seenBackendNodeIds.has(backendNodeId)) continue;
      const meta = await resolveElementMetaByBackendNode(
        tabId,
        backendNodeId,
        scopeSelector,
      );
      if (!meta) continue;
      if (scopeSelector && meta.matchesScope !== true) continue;

      const hasMeaningfulLabel = !!(
        meta.name ||
        meta.value ||
        meta.ariaLabel ||
        meta.placeholder ||
        item.name ||
        item.value
      );
      if (
        !allowAll &&
        meta.visible === false &&
        !hasMeaningfulLabel &&
        !meta.focused
      ) {
        continue;
      }

      seenBackendNodeIds.add(backendNodeId);
      enrichedNodes.push({
        ...item,
        ...meta,
      });
      if (enrichedNodes.length >= Math.max(maxNodes * 1.5, 180)) break;
    }

    const finalEnriched = enrichedNodes
      .sort((a, b) => {
        if (a.focused !== b.focused) return a.focused ? -1 : 1;
        if (a.visible !== b.visible) return a.visible ? -1 : 1;
        const aHasLabel = !!(a.name || a.value || a.ariaLabel || a.placeholder);
        const bHasLabel = !!(b.name || b.value || b.ariaLabel || b.placeholder);
        if (aHasLabel !== bHasLabel) return aHasLabel ? -1 : 1;
        return 0;
      })
      .slice(0, maxNodes);

    if (finalEnriched.length === 0) {
      throw toRuntimeError("AXTree produced no actionable nodes", {
        code: "E_CDP_AXTREE_NO_NODES",
        retryable: true,
        details: {
          tabId,
          scopeSelector,
          candidateCount: candidates.length,
        },
      });
    }

    const nodes = (await enrichmentPipeline.run(
      enrichSnapshotNodes(state, finalEnriched, key, snapshotId, "ax"),
      {
        sessionId: String(base.sessionId || ""),
        origin: String(page.url || ""),
        location: String(page.url || ""),
        failureCounts: state.failureCounts,
      },
    )) as JsonRecord[];

    return {
      ...base,
      url: String(page.url || ""),
      title: String(page.title || ""),
      count: nodes.length,
      nodes,
      truncated: candidates.length > nodes.length,
      source: "ax",
      hash: hashText(
        nodes.map((node) => summarizeSnapshotNode(node)).join("\n"),
      ),
    };
  }

  async function takeInteractiveSnapshotByDomEvaluate(
    tabId: number,
    options: JsonRecord,
    base: JsonRecord,
    state: SnapshotState,
    key: string,
    snapshotId: string,
  ): Promise<JsonRecord> {
    const evalResult = (await sendCdpCommand(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const selector = ${JSON.stringify(String(options.selector || ""))};
        const filter = ${JSON.stringify(String(options.filter || "interactive"))};
        const maxNodes = ${Number(options.maxNodes || 120)};
        const scope = selector ? document.querySelector(selector) : document;
        if (!scope) return { ok: false, error: "selector not found" };
        const interactive = "a,button,input,textarea,select,[role='button'],[role='link'],[role='textbox'],[contenteditable='true'],[tabindex]";
        const all = Array.from((scope === document ? document : scope).querySelectorAll("*"));
        const list = filter === "all" ? all : all.filter((el) => el.matches(interactive));
        const safeAttr = (v) => String(v || "").split("\\\\").join("\\\\\\\\").replace(/"/g, '\\"');
        const isValidIdent = (v) => /^[A-Za-z_][A-Za-z0-9_:\\-\\.]*$/.test(v || "");
        const fallbackPath = (el) => {
          const parts = [];
          let cur = el;
          let depth = 0;
          while (cur && cur.nodeType === 1 && depth < 5) {
            const tag = (cur.tagName || "div").toLowerCase();
            if (cur.id && isValidIdent(cur.id)) {
              parts.unshift("#" + cur.id);
              break;
            }
            let part = tag;
            const cls = String(cur.className || "")
              .split(/\\s+/)
              .map((x) => x.trim())
              .filter(Boolean)
              .find((x) => isValidIdent(x));
            if (cls) part += "." + cls;
            const parent = cur.parentElement;
            if (parent) {
              const sameTag = Array.from(parent.children).filter((child) => child.tagName === cur.tagName);
              if (sameTag.length > 1) {
                part += ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")";
              }
            }
            parts.unshift(part);
            cur = cur.parentElement;
            depth += 1;
          }
          return parts.join(" > ");
        };
        const makeSelector = (el) => {
          if (el.id && isValidIdent(el.id)) return "#" + el.id;
          const name = (el.getAttribute("name") || "").trim();
          if (name) return el.tagName.toLowerCase() + '[name="' + safeAttr(name) + '"]';
          const testId = (el.getAttribute("data-testid") || el.getAttribute("data-test") || "").trim();
          if (testId) return el.tagName.toLowerCase() + '[data-testid="' + safeAttr(testId) + '"]';
          const ariaLabel = (el.getAttribute("aria-label") || "").trim();
          if (ariaLabel) return el.tagName.toLowerCase() + '[aria-label="' + safeAttr(ariaLabel) + '"]';
          const placeholder = (el.getAttribute("placeholder") || "").trim();
          if (placeholder) return el.tagName.toLowerCase() + '[placeholder="' + safeAttr(placeholder) + '"]';
          return fallbackPath(el);
        };
        const nodes = list.slice(0, maxNodes).map((el) => {
          const role = (el.getAttribute("role") || el.tagName || "node").toLowerCase();
          const text = String(el.textContent || "").replace(/\\s+/g, " ").trim();
          const value = "value" in el ? String(el.value || "") : "";
          const placeholder = String(el.getAttribute("placeholder") || "");
          const ariaLabel = String(el.getAttribute("aria-label") || "");
          const editable =
            el.isContentEditable === true ||
            ("value" in el) ||
            role === "textbox" ||
            role === "searchbox" ||
            role === "combobox";

          const brainUid = "brain-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
          if (!el.getAttribute("data-brain-uid")) {
            el.setAttribute("data-brain-uid", brainUid);
          }
          const effectiveUid = el.getAttribute("data-brain-uid");

          const checkVisible = (node) => {
            if (typeof node.checkVisibility === "function") return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            const rect = node.getBoundingClientRect();
            return !!(rect.width && rect.height && rect.top < window.innerHeight && rect.left < window.innerWidth && rect.bottom > 0 && rect.right > 0);
          };

          const getAriaBool = (name) => {
            const v = el.getAttribute(name);
            if (v === "true") return true;
            if (v === "false") return false;
            return undefined;
          };

          return {
            role,
            name: text.slice(0, 180),
            value: value.slice(0, 180),
            placeholder: placeholder.slice(0, 180),
            ariaLabel: ariaLabel.slice(0, 180),
            editable,
            selector: makeSelector(el),
            disabled: !!el.disabled || getAriaBool("aria-disabled") === true,
            focused: document.activeElement === el,
            tag: el.tagName.toLowerCase(),
            visible: checkVisible(el),
            expanded: getAriaBool("aria-expanded"),
            checked: getAriaBool("aria-checked") ?? (typeof el.checked === "boolean" ? el.checked : undefined),
            selected: getAriaBool("aria-selected") ?? (typeof el.selected === "boolean" ? el.selected : undefined),
            required: !!el.required || getAriaBool("aria-required") === true,
            brainUid: effectiveUid
          };
        });
        return {
          ok: true,
          url: location.href,
          title: document.title,
          nodes
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    })) as JsonRecord;
    const interactiveEvalException = asRecord(evalResult.exceptionDetails);
    if (Object.keys(interactiveEvalException).length > 0) {
      const exceptionObj = asRecord(interactiveEvalException.exception);
      throw new Error(
        `cdp.snapshot interactive eval exception: ${String(
          interactiveEvalException.text ||
            exceptionObj.description ||
            exceptionObj.value ||
            "unknown",
        )}`,
      );
    }
    const value = asRecord(asRecord(evalResult.result).value);
    if (value.ok !== true) {
      throw new Error(
        `cdp.snapshot failed: ${String(value.error || "interactive evaluate failed")}`,
      );
    }
    const rawNodes = Array.isArray(value.nodes)
      ? (value.nodes as JsonRecord[])
      : [];
    const nodes = (await enrichmentPipeline.run(
      enrichSnapshotNodes(state, rawNodes, key, snapshotId, "dom"),
      {
        sessionId: String(base.sessionId || ""),
        origin: String(value.url || ""),
        location: String(value.url || ""),
        failureCounts: state.failureCounts,
      },
    )) as JsonRecord[];
    return {
      ...base,
      url: String(value.url || ""),
      title: String(value.title || ""),
      count: nodes.length,
      nodes,
      truncated: false,
      source: "dom",
      hash: hashText(
        nodes.map((node) => summarizeSnapshotNode(node)).join("\n"),
      ),
    };
  }

  async function takeSnapshot(
    tabId: number,
    rawOptions: JsonRecord = {},
  ): Promise<JsonRecord> {
    await ensureDebugger(tabId);
    const options = normalizeSnapshotOptions(rawOptions, toPositiveInt);
    const key = snapshotKey(options);
    const state = getSnapshotState(tabId);
    const previous = state.byKey.get(key) || null;

    if (options.noAnimations === true) {
      await sendCdpCommand(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const id = "__brain_loop_disable_anim__";
          if (!document.getElementById(id)) {
            const style = document.createElement("style");
            style.id = id;
            style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}";
            document.documentElement.appendChild(style);
          }
          return true;
        })()`,
        returnByValue: true,
        awaitPromise: true,
      });
    }

    const snapshotId = randomId("snap");
    const base: JsonRecord = {
      snapshotId,
      ts: nowIso(),
      tabId,
      mode: options.mode,
      filter: options.filter,
      selector: options.selector,
      depth: options.depth,
      maxTokens: options.maxTokens,
      url: "",
      title: "",
      format: options.format,
    };

    let snapshot: JsonRecord;
    if (options.mode === "text") {
      const textChars = Math.max(
        Number(options.maxChars || 4000),
        Math.min(48_000, Number(options.maxTokens || 1200) * 4),
      );
      const evalResult = (await sendCdpCommand(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const selector = ${JSON.stringify(String(options.selector || ""))};
          const scope = selector ? document.querySelector(selector) : document.body;
          if (!scope) return { ok: false, error: "selector not found" };
          const text = String(scope.innerText || "");
          const clipped = text.length > ${textChars} ? text.slice(0, ${textChars}) + "…" : text;
          return { ok: true, text: clipped, textLength: text.length, url: location.href, title: document.title };
        })()`,
        returnByValue: true,
        awaitPromise: true,
      })) as JsonRecord;
      const textEvalException = asRecord(evalResult.exceptionDetails);
      if (Object.keys(textEvalException).length > 0) {
        const exceptionObj = asRecord(textEvalException.exception);
        throw new Error(
          `cdp.snapshot text eval exception: ${String(
            textEvalException.text ||
              exceptionObj.description ||
              exceptionObj.value ||
              "unknown",
          )}`,
        );
      }
      const value = asRecord(asRecord(evalResult.result).value);
      if (value.ok !== true) {
        throw new Error(
          `cdp.snapshot failed: ${String(value.error || "text evaluate failed")}`,
        );
      }
      const text = String(value.text || "");
      snapshot = {
        ...base,
        url: String(value.url || ""),
        title: String(value.title || ""),
        text,
        textLength: Number(value.textLength || text.length),
        hash: hashText(text),
        truncated: Number(value.textLength || text.length) > text.length,
      };
    } else {
      try {
        snapshot = await takeInteractiveSnapshotByAX(
          tabId,
          options,
          base,
          state,
          key,
          snapshotId,
        );
      } catch (error) {
        const fallback = await takeInteractiveSnapshotByDomEvaluate(
          tabId,
          options,
          base,
          state,
          key,
          snapshotId,
        );
        snapshot = {
          ...fallback,
          source: "dom-fallback",
          axError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    state.byKey.set(key, snapshot);
    state.lastSnapshotId = snapshotId;
    const diff = options.diff === true ? { hasPrevious: !!previous } : null;
    return {
      ...snapshot,
      diff,
      compact: buildCompactSnapshot(snapshot),
      stats: {
        key,
        hasPrevious: !!previous,
      },
    };
  }

  const cdpAction = createCdpActionExecutor({
    sendCdpCommand,
    ensureDebugger,
    getSnapshotState,
    observeByCDP,
  });

  async function detachCDP(tabId: number): Promise<void> {
    clearCdpAutoDetach(tabId);
    rejectPendingCdpCommands(tabId, "detach requested");
    if (attachedTabs.has(tabId)) {
      await chrome.debugger.detach({ tabId });
    }
    attachedTabs.delete(tabId);
    attachLocksByTab.delete(tabId);
    enabledDomainsByTab.delete(tabId);
  }

  async function focusTabBeforeAction(tabId: number): Promise<void> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (Number.isInteger(tab?.windowId) && Number(tab.windowId) > 0) {
        await chrome.windows
          .update(Number(tab.windowId), { focused: true })
          .catch(() => {});
      }
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    } catch {
      // best-effort focus; do not fail action pipeline on focus hint failure
    }
  }

  return {
    disconnectBridge: bridge.disconnectBridge,
    abortBridgeInvokesBySession: bridge.abortBridgeInvokesBySession,
    async handleMessage(message: unknown): Promise<RuntimeInfraResult | null> {
      const msg = asRecord(message);
      const type = String(msg.type || "");
      if (!type) return null;

      if (type === "config.get") {
        return ok(await bridge.getBridgeConfig());
      }
      if (type === "config.save") {
        const payload = asRecord(msg.payload);
        const config = await bridge.saveBridgeConfig(payload);
        return ok(config);
      }
      if (type === "bridge.connect") {
        await bridge.connectBridge(msg.force !== false);
        return ok({ connected: true, at: nowIso() });
      }
      if (type === "bridge.invoke") {
        return ok(await bridge.invokeBridge(msg.payload));
      }
      if (type === "lease.acquire") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("lease.acquire 需要有效 tabId");
        return ok(acquireLease(tabId, resolveOwnerFromMessage(msg), msg.ttlMs));
      }
      if (type === "lease.heartbeat") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("lease.heartbeat 需要有效 tabId");
        return ok(
          heartbeatLease(tabId, resolveOwnerFromMessage(msg), msg.ttlMs),
        );
      }
      if (type === "lease.release") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("lease.release 需要有效 tabId");
        return ok(releaseLease(tabId, resolveOwnerFromMessage(msg)));
      }
      if (type === "lease.status") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("lease.status 需要有效 tabId");
        return ok(leaseStatus(tabId));
      }
      if (type === "cdp.observe") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.observe 需要有效 tabId");
        return ok(await observeByCDP(tabId));
      }
      if (type === "cdp.snapshot") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.snapshot 需要有效 tabId");
        return ok(await takeSnapshot(tabId, asRecord(msg.options)));
      }
      if (type === "cdp.action") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.action 需要有效 tabId");
        const action = asRecord(msg.action);
        if (action.requireFocus === true && action.forceFocus !== true) {
          return fail(
            toRuntimeError("action requires focused tab", {
              code: "E_CDP_FOCUS_REQUIRED",
              retryable: true,
              details: { tabId },
            }),
          );
        }
        if (action.forceFocus === true) {
          await focusTabBeforeAction(tabId);
        }
        const kind = normalizeActionKind(action.kind);
        if (actionRequiresLease(kind)) {
          ensureLeaseForWrite(tabId, resolveOwnerFromMessage(msg));
        }
        return ok(await cdpAction.executeRefActionByCDP(tabId, action));
      }
      if (type === "cdp.execute") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.execute 需要有效 tabId");
        return ok(await cdpAction.executeByCDP(tabId, asRecord(msg.action)));
      }
      if (type === "cdp.verify") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.verify 需要有效 tabId");
        return ok(
          await cdpAction.verifyByCDP(
            tabId,
            asRecord(msg.action),
            asRecord(msg.result),
          ),
        );
      }
      if (type === "cdp.detach") {
        const tabId = toValidTabId(msg.tabId);
        if (!tabId) return fail("cdp.detach 需要有效 tabId");
        await detachCDP(tabId);
        return ok({ detached: true, tabId });
      }

      return null;
    },
  };
}
