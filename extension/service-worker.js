const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8787/ws";
const DEFAULT_BRIDGE_TOKEN = "dev-token-change-me";

const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_LEASE_TTL_MS = 5 * 60_000;

let bridgeSocket = null;
let bridgeConnected = false;
let bridgeConnectPromise = null;
let bridgeConfigCache = null;
let devReloadTimer = null;
let devLastVersion = null;

const pendingInvokes = new Map();
const attachedTabs = new Set();
const telemetryByTab = new Map();
const snapshotStateByTab = new Map();
const leaseByTab = new Map();

async function ensureSidePanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashText(input) {
  const text = String(input ?? "");
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function getBridgeConfig() {
  if (bridgeConfigCache) return bridgeConfigCache;
  const data = await chrome.storage.local.get([
    "bridgeUrl",
    "bridgeToken",
    "llmApiBase",
    "llmApiKey",
    "llmModel",
    "devAutoReload",
    "devReloadIntervalMs"
  ]);

  bridgeConfigCache = {
    bridgeUrl: data.bridgeUrl || DEFAULT_BRIDGE_URL,
    bridgeToken: data.bridgeToken || DEFAULT_BRIDGE_TOKEN,
    llmApiBase: data.llmApiBase || "https://ai.chen.rs/v1",
    llmApiKey: data.llmApiKey || "",
    llmModel: data.llmModel || "gpt-5.3-codex",
    devAutoReload: data.devAutoReload !== false,
    devReloadIntervalMs: Number.isFinite(data.devReloadIntervalMs) ? data.devReloadIntervalMs : 1500
  };

  return bridgeConfigCache;
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function buildDevVersionUrl(config) {
  try {
    const ws = new URL(config.bridgeUrl);
    const protocol = ws.protocol === "wss:" ? "https:" : "http:";
    const url = new URL(`${protocol}//${ws.host}/dev/version`);
    url.searchParams.set("token", config.bridgeToken);
    return url.toString();
  } catch {
    return null;
  }
}

async function pollDevVersion() {
  const config = await getBridgeConfig();
  if (!config.devAutoReload) return;

  const url = buildDevVersionUrl(config);
  if (!url) return;

  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return;
    const data = await resp.json();
    const version = data?.version ? String(data.version) : "";
    if (!version) return;

    if (devLastVersion === null) {
      devLastVersion = version;
      return;
    }

    if (devLastVersion !== version) {
      broadcast({
        type: "dev.reload",
        from: devLastVersion,
        to: version,
        at: nowIso()
      });
      chrome.runtime.reload();
    }
  } catch {
    // dev polling failures should not affect runtime behavior
  }
}

async function restartDevReloadPolling() {
  if (devReloadTimer) {
    clearInterval(devReloadTimer);
    devReloadTimer = null;
  }

  devLastVersion = null;
  const config = await getBridgeConfig();
  if (!config.devAutoReload) return;

  const interval = Math.max(500, Math.min(10_000, Number(config.devReloadIntervalMs) || 1500));
  devReloadTimer = setInterval(() => {
    pollDevVersion().catch(() => {});
  }, interval);

  await pollDevVersion();
}

function resetBridgeSocket() {
  bridgeConnected = false;
  bridgeConnectPromise = null;
  if (bridgeSocket) {
    try {
      bridgeSocket.close();
    } catch {}
  }
  bridgeSocket = null;

  for (const [, pending] of pendingInvokes) {
    pending.reject(new Error("Bridge disconnected"));
  }
  pendingInvokes.clear();
}

function onBridgeMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.data);
  } catch {
    return;
  }

  if (msg && msg.type === "event") {
    broadcast({ type: "bridge.event", payload: msg });
    return;
  }

  if (!msg || typeof msg.id !== "string") return;

  const pending = pendingInvokes.get(msg.id);
  if (!pending) return;

  pendingInvokes.delete(msg.id);
  clearTimeout(pending.timeout);

  if (msg.ok === true) {
    pending.resolve(msg);
    return;
  }

  const err = new Error(msg?.error?.message || "Bridge invoke failed");
  err.code = msg?.error?.code;
  err.details = msg?.error?.details;
  pending.reject(err);
}

async function connectBridge(force = false) {
  if (bridgeConnected && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN && !force) {
    return bridgeSocket;
  }

  if (bridgeConnectPromise && !force) {
    return bridgeConnectPromise;
  }

  bridgeConnectPromise = (async () => {
    const config = await getBridgeConfig();
    const wsUrl = new URL(config.bridgeUrl);
    wsUrl.searchParams.set("token", config.bridgeToken);
    const wsHref = wsUrl.toString();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsHref);
      let settled = false;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };

      ws.onopen = () => {
        settled = true;
        bridgeSocket = ws;
        bridgeConnected = true;
        broadcast({ type: "bridge.status", status: "connected", at: nowIso() });
        resolve(ws);
      };

      ws.onmessage = onBridgeMessage;

      ws.onerror = (event) => {
        if (!bridgeConnected) {
          fail(`Bridge connection failed: ${event.type}; url=${wsHref}`);
        }
      };

      ws.onclose = (event) => {
        broadcast({ type: "bridge.status", status: "disconnected", at: nowIso() });
        if (!settled) {
          const reason = event?.reason ? ` reason=${event.reason}` : "";
          fail(`Bridge closed before ready: code=${event?.code ?? "unknown"}${reason}; url=${wsHref}`);
        }
        resetBridgeSocket();
      };
    });
  })();

  try {
    return await bridgeConnectPromise;
  } finally {
    bridgeConnectPromise = null;
  }
}

async function invokeBridge(frame) {
  const ws = await connectBridge();
  const id = frame.id || randomId("invoke");

  const payload = {
    id,
    type: "invoke",
    tool: frame.tool,
    args: frame.args || {},
    sessionId: frame.sessionId,
    parentSessionId: frame.parentSessionId,
    agentId: frame.agentId
  };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingInvokes.delete(id);
      reject(new Error("Bridge invoke timeout"));
    }, 60_000);

    pendingInvokes.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify(payload));
  });
}

function getTabTelemetry(tabId) {
  if (!telemetryByTab.has(tabId)) {
    telemetryByTab.set(tabId, {
      console: [],
      network: []
    });
  }
  return telemetryByTab.get(tabId);
}

function trimTelemetry(items, max = 120) {
  if (items.length > max) {
    items.splice(0, items.length - max);
  }
}

function toValidTabId(raw) {
  const tabId = Number(raw);
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  return tabId;
}

function toPositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeSnapshotMode(raw) {
  if (raw === "text" || raw === "interactive" || raw === "full") {
    return raw;
  }
  return "interactive";
}

function normalizeSnapshotFilter(raw, mode) {
  if (mode === "text") return "all";
  if (raw === "all") return "all";
  return "interactive";
}

function normalizeSnapshotOptions(raw = {}) {
  const mode = normalizeSnapshotMode(raw.mode);
  const filter = normalizeSnapshotFilter(raw.filter, mode);
  const format = raw.format === "compact" ? "compact" : "json";
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
    maxTokens: Math.max(120, Math.min(12_000, toPositiveInt(raw.maxTokens, maxTokensFallback))),
    maxNodes: Math.max(20, Math.min(1000, toPositiveInt(raw.maxNodes, maxNodesFallback))),
    maxChars: Math.max(200, Math.min(12_000, toPositiveInt(raw.maxChars, 4000)))
  };
}

function snapshotKey(options) {
  return `${options.mode}:${options.filter}:${options.selector || "__root__"}:${options.depth}:${options.maxTokens}`;
}

function summarizeNode(node) {
  return `${node.role || ""}|${node.name || ""}|${node.value || ""}|${node.backendNodeId || ""}|${node.disabled ? "1" : "0"}|${node.focused ? "1" : "0"}`;
}

function formatNodeCompact(node) {
  const role = node.role || "node";
  const label = String(node.name || node.value || "").replace(/\s+/g, " ").trim();
  const showLabel = label ? ` \"${label.slice(0, 80)}\"` : "";
  const flags = [];
  if (node.disabled) flags.push("disabled");
  if (node.focused) flags.push("focused");
  if (node.selector) flags.push(`sel=${node.selector.slice(0, 36)}`);
  const flagText = flags.length > 0 ? ` [${flags.join(",")}]` : "";
  return `${node.ref}:${role}${showLabel}${flagText}`;
}

function buildCompactSnapshot(snapshot) {
  if (snapshot.mode === "text") {
    return `# ${snapshot.title || ""} | ${snapshot.url || ""}\n${snapshot.text || ""}`;
  }

  const lines = [`# ${snapshot.title || ""} | ${snapshot.url || ""} | ${snapshot.count || 0} nodes`];
  for (const node of snapshot.nodes || []) {
    lines.push(formatNodeCompact(node));
  }
  return lines.join("\n");
}

function snapshotNodeIdentity(node) {
  return `${node.role || ""}:${node.name || ""}:${node.backendNodeId || ""}`;
}

function computeNodeDiff(prevNodes = [], nextNodes = []) {
  const prevByKey = new Map(prevNodes.map((node) => [snapshotNodeIdentity(node), node]));
  const nextByKey = new Map(nextNodes.map((node) => [snapshotNodeIdentity(node), node]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [identity, node] of nextByKey.entries()) {
    if (!prevByKey.has(identity)) {
      added.push(node);
      continue;
    }

    const prev = prevByKey.get(identity);
    if (summarizeNode(prev) !== summarizeNode(node)) {
      changed.push({
        identity,
        before: {
          role: prev.role,
          name: prev.name,
          disabled: prev.disabled,
          focused: prev.focused,
          value: prev.value
        },
        after: {
          role: node.role,
          name: node.name,
          disabled: node.disabled,
          focused: node.focused,
          value: node.value
        }
      });
    }
  }

  for (const [identity, node] of prevByKey.entries()) {
    if (!nextByKey.has(identity)) {
      removed.push(node);
    }
  }

  return {
    added,
    removed,
    changed,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      total: nextNodes.length
    }
  };
}

function computeSnapshotDiff(prev, next) {
  if (!prev) return null;

  if (next.mode === "text") {
    const prevHash = hashText(prev.text || "");
    const nextHash = hashText(next.text || "");
    const changed = prevHash !== nextHash;
    return {
      changed,
      counts: {
        changed: changed ? 1 : 0,
        total: next.textLength || 0
      },
      beforeHash: prevHash,
      afterHash: nextHash,
      beforeLength: prev.textLength || 0,
      afterLength: next.textLength || 0
    };
  }

  return computeNodeDiff(prev.nodes || [], next.nodes || []);
}

function getSnapshotState(tabId) {
  let state = snapshotStateByTab.get(tabId);
  if (state) return state;

  state = {
    byKey: new Map(),
    refMap: new Map(),
    lastSnapshotId: null
  };

  snapshotStateByTab.set(tabId, state);
  return state;
}

function clearSnapshotState(tabId) {
  snapshotStateByTab.delete(tabId);
}

function normalizeInlineText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function parseAxValue(rawValue) {
  if (rawValue == null) return "";
  if (typeof rawValue === "string") return rawValue;
  if (typeof rawValue === "number" || typeof rawValue === "boolean") return String(rawValue);
  if (typeof rawValue !== "object") return "";
  if (rawValue.value != null) return parseAxValue(rawValue.value);
  return "";
}

function hasAxFlag(rawNode, flagName) {
  const props = Array.isArray(rawNode?.properties) ? rawNode.properties : [];
  for (const prop of props) {
    if (prop?.name !== flagName) continue;
    const value = normalizeInlineText(parseAxValue(prop?.value));
    if (!value) return false;
    return value === "true" || value === "1";
  }
  return false;
}

const INTERACTIVE_AX_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem"
]);

function isInteractiveAxRole(role) {
  return INTERACTIVE_AX_ROLES.has(String(role || "").toLowerCase());
}

function estimateSnapshotNodeTokens(node, format) {
  const role = String(node.role || "");
  const name = String(node.name || "");
  const value = String(node.value || "");
  const meta = node.disabled || node.focused ? 12 : 4;
  const size = role.length + name.length + value.length + meta;
  if (format === "compact") return Math.max(1, Math.floor(size / 4));
  return Math.max(1, Math.floor((size + 40) / 3));
}

function truncateSnapshotNodesByTokens(nodes, maxTokens, format) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { nodes: [], truncated: false };
  let used = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    used += estimateSnapshotNodeTokens(nodes[i], format);
    if (used > maxTokens) {
      return {
        nodes: nodes.slice(0, i),
        truncated: true
      };
    }
  }
  return { nodes, truncated: false };
}

function buildDepthMap(axNodes = []) {
  const parentByNodeId = new Map();
  for (const node of axNodes) {
    const parentId = node?.nodeId;
    if (!parentId) continue;
    const children = Array.isArray(node?.childIds) ? node.childIds : [];
    for (const childId of children) {
      parentByNodeId.set(childId, parentId);
    }
  }

  const depthByNodeId = new Map();
  const resolveDepth = (nodeId) => {
    if (!nodeId) return 0;
    if (depthByNodeId.has(nodeId)) return depthByNodeId.get(nodeId);
    const parentId = parentByNodeId.get(nodeId);
    if (!parentId) {
      depthByNodeId.set(nodeId, 0);
      return 0;
    }
    const depth = resolveDepth(parentId) + 1;
    depthByNodeId.set(nodeId, depth);
    return depth;
  };

  for (const node of axNodes) {
    if (!node?.nodeId) continue;
    resolveDepth(node.nodeId);
  }
  return depthByNodeId;
}

function filterAxNodesByScope(axNodes = [], scopeBackendNodeId) {
  if (!scopeBackendNodeId) return axNodes;
  const scopeNode = axNodes.find((node) => Number(node?.backendDOMNodeId || 0) === scopeBackendNodeId);
  if (!scopeNode?.nodeId) return axNodes;

  const include = new Set([scopeNode.nodeId]);
  const childrenByNodeId = new Map();
  for (const node of axNodes) {
    if (!node?.nodeId) continue;
    const children = Array.isArray(node?.childIds) ? node.childIds : [];
    childrenByNodeId.set(node.nodeId, children);
  }

  const queue = [scopeNode.nodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = childrenByNodeId.get(current) || [];
    for (const child of children) {
      if (include.has(child)) continue;
      include.add(child);
      queue.push(child);
    }
  }

  return axNodes.filter((node) => include.has(node?.nodeId));
}

function buildSnapshotNodesFromAxTree(axNodes = [], options = {}) {
  const depthByNodeId = buildDepthMap(axNodes);
  const out = [];

  for (const rawNode of axNodes) {
    if (!rawNode || rawNode.ignored === true) continue;

    const role = normalizeInlineText(parseAxValue(rawNode.role));
    if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;
    if (options.filter === "interactive" && !isInteractiveAxRole(role)) continue;

    const depth = depthByNodeId.get(rawNode.nodeId) || 0;
    if (options.depth >= 0 && depth > options.depth) continue;

    const name = normalizeInlineText(parseAxValue(rawNode.name));
    const value = normalizeInlineText(parseAxValue(rawNode.value));
    if (options.filter === "all" && !name && !value && role === "StaticText") continue;

    const backendNodeId = Number(rawNode.backendDOMNodeId || rawNode.backendNodeId || 0) || null;
    const entry = {
      role,
      name,
      depth
    };

    if (value) entry.value = value;
    if (hasAxFlag(rawNode, "disabled")) entry.disabled = true;
    if (hasAxFlag(rawNode, "focused")) entry.focused = true;
    if (backendNodeId) entry.backendNodeId = backendNodeId;

    out.push(entry);
  }

  let truncated = false;
  let nodes = out;

  if (options.maxTokens > 0) {
    const tokenCut = truncateSnapshotNodesByTokens(nodes, options.maxTokens, options.format);
    nodes = tokenCut.nodes;
    truncated = tokenCut.truncated;
  }

  if (nodes.length > options.maxNodes) {
    nodes = nodes.slice(0, options.maxNodes);
    truncated = true;
  }

  return { nodes, truncated, total: out.length };
}

async function disableAnimationsOnce(target) {
  const expression = `(() => {
    const id = "__brain_loop_disable_anim__";
    if (!document.getElementById(id)) {
      const style = document.createElement("style");
      style.id = id;
      style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}";
      document.documentElement.appendChild(style);
    }
    return true;
  })()`;
  await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
}

async function resolveScopeBackendNodeId(target, selector) {
  if (!selector) return null;
  const rootNodeId = await getDocumentNodeId(target);
  if (!rootNodeId) return null;
  const queried = await chrome.debugger.sendCommand(target, "DOM.querySelector", {
    nodeId: rootNodeId,
    selector
  });
  const nodeId = queried?.nodeId;
  if (!nodeId) return null;
  const described = await chrome.debugger.sendCommand(target, "DOM.describeNode", {
    nodeId,
    depth: 0
  });
  return Number(described?.node?.backendNodeId || 0) || null;
}

function buildIdSelector(inputId) {
  const id = String(inputId || "").trim();
  if (!id) return "";
  if (/^[A-Za-z_][A-Za-z0-9_:\-\.]*$/.test(id)) return `#${id}`;
  return "";
}

function pickAttrMap(attributes = []) {
  const map = {};
  if (!Array.isArray(attributes)) return map;
  for (let i = 0; i < attributes.length; i += 2) {
    const key = String(attributes[i] || "");
    if (!key) continue;
    map[key] = String(attributes[i + 1] || "");
  }
  return map;
}

async function enrichSnapshotNodesWithDomMetadata(target, nodes = []) {
  return mapWithConcurrency(nodes, 10, async (node) => {
    if (!node?.backendNodeId) return node;
    try {
      const described = await chrome.debugger.sendCommand(target, "DOM.describeNode", {
        backendNodeId: node.backendNodeId,
        depth: 0
      });
      const domNode = described?.node;
      const attrs = pickAttrMap(domNode?.attributes || []);
      const selector = buildIdSelector(attrs.id);
      const tag = String(domNode?.localName || domNode?.nodeName || "").toLowerCase();
      const enriched = {
        ...node,
        nodeId: Number(domNode?.nodeId || 0) || undefined,
        selector: selector || undefined,
        tag: tag || undefined,
        href: attrs.href || undefined,
        inputType: attrs.type || undefined
      };
      return enriched;
    } catch {
      return node;
    }
  });
}

async function ensureDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  attachedTabs.add(tabId);

  await chrome.debugger.sendCommand(target, "Network.enable");
  await chrome.debugger.sendCommand(target, "Runtime.enable");
  await chrome.debugger.sendCommand(target, "DOM.enable");
  await chrome.debugger.sendCommand(target, "Page.enable");
  await chrome.debugger.sendCommand(target, "Log.enable");
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || typeof source.tabId !== "number") return;
  const tabId = source.tabId;
  const t = getTabTelemetry(tabId);

  if (method === "Runtime.consoleAPICalled") {
    const args = (params?.args || []).map((x) => x?.value ?? x?.description ?? "");
    t.console.push({
      ts: nowIso(),
      type: params?.type,
      args
    });
    trimTelemetry(t.console);
    return;
  }

  if (method === "Network.responseReceived") {
    t.network.push({
      ts: nowIso(),
      requestId: params?.requestId,
      url: params?.response?.url,
      status: params?.response?.status,
      mimeType: params?.response?.mimeType
    });
    trimTelemetry(t.network);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (!source || typeof source.tabId !== "number") return;
  attachedTabs.delete(source.tabId);
  telemetryByTab.delete(source.tabId);
  clearSnapshotState(source.tabId);
  leaseByTab.delete(source.tabId);
});

async function observeByCDP(tabId) {
  await ensureDebugger(tabId);

  const target = { tabId };
  const evalResult = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: `(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      textLength: document.body?.innerText?.length ?? 0,
      nodeCount: document.querySelectorAll('*').length
    }))()`,
    returnByValue: true
  });

  const telemetry = getTabTelemetry(tabId);

  return {
    ts: nowIso(),
    tabId,
    page: evalResult?.result?.value || {},
    console: telemetry.console.slice(-20),
    network: telemetry.network.slice(-20)
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      out[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function getDocumentNodeId(target) {
  try {
    const doc = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: 0 });
    return doc?.root?.nodeId || null;
  } catch {
    return null;
  }
}

async function resolveSelectorNodeHandles(target, selector, rootNodeId) {
  if (!selector) return null;

  try {
    const rootId = rootNodeId || (await getDocumentNodeId(target));
    if (!rootId) return null;

    const queried = await chrome.debugger.sendCommand(target, "DOM.querySelector", {
      nodeId: rootId,
      selector
    });
    const nodeId = queried?.nodeId;
    if (!nodeId) return null;

    const described = await chrome.debugger.sendCommand(target, "DOM.describeNode", {
      nodeId,
      depth: 0
    });
    const backendNodeId = described?.node?.backendNodeId || null;

    return {
      nodeId,
      backendNodeId
    };
  } catch {
    return null;
  }
}

async function takeSnapshot(tabId, rawOptions = {}) {
  await ensureDebugger(tabId);

  const options = normalizeSnapshotOptions(rawOptions);
  const key = snapshotKey(options);
  const state = getSnapshotState(tabId);
  const previous = state.byKey.get(key) || null;

  const target = { tabId };
  if (options.noAnimations) {
    await disableAnimationsOnce(target);
  }

  const snapshotId = randomId("snap");
  const base = {
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
    format: options.format
  };

  let snapshot;
  if (options.mode === "text") {
    const textChars = Math.max(options.maxChars, Math.min(48_000, options.maxTokens * 4));
    const expression = `(() => {
      const selector = ${JSON.stringify(options.selector || "")};
      const scope = selector ? document.querySelector(selector) : document.body;
      if (!scope) return { ok: false, error: "selector not found" };
      const preferred = scope.matches?.("main,article,[role='main']") ? scope : (scope.querySelector?.("main,article,[role='main']") || scope);
      const text = String(preferred?.innerText || scope.innerText || "");
      const clipped = text.length > ${textChars} ? text.slice(0, ${textChars}) + "…" : text;
      return {
        ok: true,
        text: clipped,
        textLength: text.length,
        url: location.href,
        title: document.title
      };
    })()`;
    const evalResult = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    const value = evalResult?.result?.value;
    if (!value || value.ok !== true) {
      const reason = value?.error || "snapshot text evaluate failed";
      throw new Error(`cdp.snapshot failed: ${reason}`);
    }
    const text = normalizeInlineText(value.text || "");
    snapshot = {
      ...base,
      url: String(value.url || ""),
      title: String(value.title || ""),
      text,
      textLength: Number(value.textLength || text.length) || text.length,
      hash: hashText(text),
      truncated: Number(value.textLength || text.length) > text.length
    };
  } else {
    const pageInfo = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: "(() => ({ url: location.href, title: document.title }))()",
      returnByValue: true,
      awaitPromise: true
    });
    const page = pageInfo?.result?.value || {};

    const axTree = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree");
    let axNodes = Array.isArray(axTree?.nodes) ? axTree.nodes : [];
    if (options.selector) {
      const scopeBackendNodeId = await resolveScopeBackendNodeId(target, options.selector);
      if (!scopeBackendNodeId) {
        throw new Error(`cdp.snapshot selector not found: ${options.selector}`);
      }
      axNodes = filterAxNodesByScope(axNodes, scopeBackendNodeId);
    }

    const built = buildSnapshotNodesFromAxTree(axNodes, options);
    const enrichedNodes = await enrichSnapshotNodesWithDomMetadata(target, built.nodes);
    state.refMap = new Map();
    const nodesWithRef = enrichedNodes.map((node, index) => {
      const ref = `e${index}`;
      const enriched = {
        ...node,
        ref,
        key,
        snapshotId
      };
      state.refMap.set(ref, enriched);
      return enriched;
    });

    snapshot = {
      ...base,
      url: String(page.url || ""),
      title: String(page.title || ""),
      count: nodesWithRef.length,
      nodes: nodesWithRef,
      truncated: built.truncated,
      hash: hashText(nodesWithRef.map((node) => summarizeNode(node)).join("\n"))
    };
  }

  let diff = null;
  if (options.diff) {
    diff = computeSnapshotDiff(previous, snapshot);
  }

  state.byKey.set(key, snapshot);
  state.lastSnapshotId = snapshotId;

  const compact = buildCompactSnapshot(snapshot);
  return {
    ...snapshot,
    diff,
    compact,
    stats: {
      key,
      hasPrevious: !!previous
    }
  };
}

function getLease(tabId) {
  const lease = leaseByTab.get(tabId);
  if (!lease) return null;

  if (lease.expiresAt <= Date.now()) {
    leaseByTab.delete(tabId);
    return null;
  }

  return lease;
}

function leaseStatus(tabId) {
  const lease = getLease(tabId);
  if (!lease) {
    return {
      tabId,
      locked: false
    };
  }

  return {
    tabId,
    locked: true,
    owner: lease.owner,
    leaseId: lease.leaseId,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    heartbeatAt: new Date(lease.heartbeatAt).toISOString()
  };
}

function normalizeLeaseTtl(rawTtl) {
  const ttl = toPositiveInt(rawTtl, DEFAULT_LEASE_TTL_MS);
  return Math.max(2000, Math.min(MAX_LEASE_TTL_MS, ttl));
}

function normalizeOwner(raw) {
  const owner = typeof raw === "string" ? raw.trim() : "";
  if (!owner) {
    throw new Error("owner is required for lease/cdp.action");
  }
  return owner;
}

function acquireLease(tabId, rawOwner, rawTtlMs) {
  const owner = normalizeOwner(rawOwner);
  const ttlMs = normalizeLeaseTtl(rawTtlMs);
  const current = getLease(tabId);

  if (current && current.owner !== owner) {
    return {
      ok: false,
      reason: "locked_by_other",
      lease: leaseStatus(tabId)
    };
  }

  const next = {
    tabId,
    owner,
    leaseId: current?.leaseId || randomId("lease"),
    createdAt: current?.createdAt || Date.now(),
    heartbeatAt: Date.now(),
    expiresAt: Date.now() + ttlMs
  };

  leaseByTab.set(tabId, next);
  return {
    ok: true,
    lease: leaseStatus(tabId)
  };
}

function heartbeatLease(tabId, rawOwner, rawTtlMs) {
  const owner = normalizeOwner(rawOwner);
  const ttlMs = normalizeLeaseTtl(rawTtlMs);
  const lease = getLease(tabId);

  if (!lease) {
    return {
      ok: false,
      reason: "not_locked"
    };
  }

  if (lease.owner !== owner) {
    return {
      ok: false,
      reason: "locked_by_other",
      lease: leaseStatus(tabId)
    };
  }

  lease.heartbeatAt = Date.now();
  lease.expiresAt = Date.now() + ttlMs;
  leaseByTab.set(tabId, lease);

  return {
    ok: true,
    lease: leaseStatus(tabId)
  };
}

function releaseLease(tabId, rawOwner) {
  const owner = normalizeOwner(rawOwner);
  const lease = getLease(tabId);

  if (!lease) {
    return {
      ok: true,
      released: false,
      reason: "not_locked"
    };
  }

  if (lease.owner !== owner) {
    return {
      ok: false,
      reason: "locked_by_other",
      lease: leaseStatus(tabId)
    };
  }

  leaseByTab.delete(tabId);
  return {
    ok: true,
    released: true
  };
}

function ensureLeaseForWrite(tabId, rawOwner) {
  const owner = normalizeOwner(rawOwner);
  const lease = getLease(tabId);
  if (!lease) {
    throw new Error("tab is not leased");
  }
  if (lease.owner !== owner) {
    throw new Error(`tab leased by ${lease.owner}`);
  }
}

function resolveRefEntry(tabId, ref) {
  const state = getSnapshotState(tabId);
  const node = state.refMap.get(ref);
  if (!node) {
    throw new Error(`ref ${ref} not found, take /cdp.snapshot first`);
  }
  return node;
}

function normalizeActionKind(rawKind) {
  const kind = typeof rawKind === "string" ? rawKind.trim() : "";
  if (!kind) {
    throw new Error("action.kind is required");
  }
  return kind;
}

function actionRequiresLease(kind) {
  return ["click", "type", "fill", "press", "scroll", "select", "navigate"].includes(kind);
}

async function resolveNodeObjectId(target, nodeRef) {
  if (!nodeRef) return null;

  if (nodeRef.backendNodeId) {
    try {
      const resolved = await chrome.debugger.sendCommand(target, "DOM.resolveNode", {
        backendNodeId: nodeRef.backendNodeId
      });
      const objectId = resolved?.object?.objectId;
      if (objectId) return objectId;
    } catch {}
  }

  if (nodeRef.nodeId) {
    try {
      const resolved = await chrome.debugger.sendCommand(target, "DOM.resolveNode", {
        nodeId: nodeRef.nodeId
      });
      const objectId = resolved?.object?.objectId;
      if (objectId) return objectId;
    } catch {}
  }

  return null;
}

async function callFunctionOnNode(target, objectId, functionDeclaration, args = []) {
  const out = await chrome.debugger.sendCommand(target, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true
  });
  return out?.result?.value || null;
}

async function resolveActionNodeRef(tabId, target, rawAction) {
  const ref = typeof rawAction?.ref === "string" ? rawAction.ref : "";
  const explicitSelector = typeof rawAction?.selector === "string" ? rawAction.selector : "";

  if (ref) {
    const fromRef = resolveRefEntry(tabId, ref);
    if (fromRef.backendNodeId || fromRef.nodeId) {
      return {
        ref,
        selector: explicitSelector || fromRef.selector || "",
        backendNodeId: fromRef.backendNodeId || null,
        nodeId: fromRef.nodeId || null
      };
    }
    const fallbackSelector = explicitSelector || fromRef.selector || "";
    if (fallbackSelector) {
      const resolved = await resolveSelectorNodeHandles(target, fallbackSelector);
      if (resolved) {
        return {
          ref,
          selector: fallbackSelector,
          backendNodeId: resolved.backendNodeId || null,
          nodeId: resolved.nodeId || null
        };
      }
    }
  }

  if (explicitSelector) {
    const resolved = await resolveSelectorNodeHandles(target, explicitSelector);
    if (resolved) {
      return {
        ref: ref || "",
        selector: explicitSelector,
        backendNodeId: resolved.backendNodeId || null,
        nodeId: resolved.nodeId || null
      };
    }
  }

  return {
    ref: ref || "",
    selector: explicitSelector || "",
    backendNodeId: null,
    nodeId: null
  };
}

async function executeRefActionByCDP(tabId, rawAction) {
  await ensureDebugger(tabId);
  const target = { tabId };

  const kind = normalizeActionKind(rawAction?.kind);
  const key = typeof rawAction?.key === "string"
    ? rawAction.key.trim()
    : (typeof rawAction?.value === "string" ? rawAction.value.trim() : "");
  const value = String(rawAction?.value ?? rawAction?.text ?? "");

  if (kind === "navigate") {
    const url = String(rawAction?.url || "").trim();
    if (!url) {
      throw new Error("url required for navigate");
    }
    const nav = await chrome.debugger.sendCommand(target, "Page.navigate", { url });
    return {
      tabId,
      kind,
      result: {
        ok: true,
        navigated: true,
        to: url,
        frameId: nav?.frameId || null
      }
    };
  }

  if (kind === "press") {
    if (!key) throw new Error("key required for press");
    const expression = `(() => {
      const k = ${JSON.stringify(key)};
      const t = document.activeElement || document.body;
      t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      t.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
      return { ok: true, pressed: k, url: location.href, title: document.title };
    })()`;
    const out = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return {
      tabId,
      kind,
      result: out?.result?.value || null
    };
  }

  if (kind === "scroll" && !rawAction?.ref && !rawAction?.selector) {
    const x = Number(rawAction?.scrollX || 0);
    const y = Number(rawAction?.scrollY || 800);
    const expression = `(() => {
      window.scrollBy(${JSON.stringify(x)}, ${JSON.stringify(y)});
      return { ok: true, scrolled: true, x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)}, url: location.href, title: document.title };
    })()`;
    const out = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return {
      tabId,
      kind,
      result: out?.result?.value || null
    };
  }

  const nodeRef = await resolveActionNodeRef(tabId, target, rawAction);
  if (!nodeRef.backendNodeId && !nodeRef.nodeId) {
    throw new Error("action target not found by ref/selector");
  }

  let objectId = await resolveNodeObjectId(target, nodeRef);
  if (!objectId && nodeRef.selector) {
    const refreshed = await resolveSelectorNodeHandles(target, nodeRef.selector);
    objectId = await resolveNodeObjectId(target, refreshed);
    if (refreshed) {
      nodeRef.backendNodeId = refreshed.backendNodeId || nodeRef.backendNodeId;
      nodeRef.nodeId = refreshed.nodeId || nodeRef.nodeId;
    }
  }
  if (!objectId) {
    throw new Error("failed to resolve target node object");
  }

  let result = null;
  if (kind === "click") {
    result = await callFunctionOnNode(
      target,
      objectId,
      "function(){ this.scrollIntoView({block:'center', inline:'nearest'}); this.click(); return {ok:true, clicked:true, url:location.href, title:document.title}; }"
    );
  } else if (kind === "type" || kind === "fill") {
    result = await callFunctionOnNode(
      target,
      objectId,
      "function(text, mode){ this.scrollIntoView({block:'center', inline:'nearest'}); if (this.focus) this.focus(); if ('value' in this){ this.value = text; this.dispatchEvent(new Event('input',{bubbles:true})); if (mode === 'fill') this.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true, typed:text.length, mode, url:location.href, title:document.title}; } if (this.isContentEditable){ this.textContent = text; this.dispatchEvent(new Event('input',{bubbles:true})); return {ok:true, typed:text.length, mode, contentEditable:true, url:location.href, title:document.title}; } return {ok:false, error:'element is not typable', mode}; }",
      [value, kind]
    );
  } else if (kind === "select") {
    result = await callFunctionOnNode(
      target,
      objectId,
      "function(val){ this.scrollIntoView({block:'center', inline:'nearest'}); if (!('value' in this)) return {ok:false, error:'element is not selectable'}; this.value = val; this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true, selected:val, url:location.href, title:document.title}; }",
      [value]
    );
  } else if (kind === "scroll") {
    result = await callFunctionOnNode(
      target,
      objectId,
      "function(){ this.scrollIntoView({block:'center', inline:'nearest'}); return {ok:true, scrolled:true, url:location.href, title:document.title}; }"
    );
  } else {
    throw new Error(`unsupported action kind: ${kind}`);
  }

  return {
    tabId,
    kind,
    ref: nodeRef.ref || undefined,
    selector: nodeRef.selector || undefined,
    backendNodeId: nodeRef.backendNodeId || undefined,
    nodeId: nodeRef.nodeId || undefined,
    result
  };
}

async function executeByCDP(tabId, action) {
  await ensureDebugger(tabId);
  const target = { tabId };

  if (action?.type === "runtime.evaluate") {
    return chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: action.expression,
      returnByValue: action.returnByValue !== false
    });
  }

  if (action?.type === "navigate") {
    return chrome.debugger.sendCommand(target, "Page.navigate", {
      url: action.url
    });
  }

  if (action?.domain && action?.method) {
    return chrome.debugger.sendCommand(target, `${action.domain}.${action.method}`, action.params || {});
  }

  throw new Error("Unsupported CDP action");
}

async function verifyByCDP(tabId, action, result) {
  const observation = await observeByCDP(tabId);
  const checks = [];
  let ok = true;

  const expect = action?.expect && typeof action.expect === "object" ? action.expect : action;

  if (expect?.expectUrlContains || expect?.urlContains) {
    const expected = expect.expectUrlContains || expect.urlContains;
    const pass = String(observation.page?.url || "").includes(expected);
    checks.push({ name: "expectUrlContains", pass, expected });
    if (!pass) ok = false;
  }

  if (expect?.expectTitleContains || expect?.titleContains) {
    const expected = expect.expectTitleContains || expect.titleContains;
    const pass = String(observation.page?.title || "").includes(expected);
    checks.push({ name: "expectTitleContains", pass, expected });
    if (!pass) ok = false;
  }

  if (expect?.urlChanged === true) {
    const previousUrl = String(expect.previousUrl || result?.url || "");
    const currentUrl = String(observation.page?.url || "");
    const pass = !!previousUrl && previousUrl !== currentUrl;
    checks.push({ name: "urlChanged", pass, previousUrl, currentUrl });
    if (!pass) ok = false;
  }

  if (expect?.textIncludes) {
    const target = { tabId };
    const evalOut = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => document.body?.innerText || "")()`,
      returnByValue: true
    });
    const text = String(evalOut?.result?.value || "");
    const pass = text.includes(String(expect.textIncludes));
    checks.push({ name: "textIncludes", pass, expected: expect.textIncludes });
    if (!pass) ok = false;
  }

  if (expect?.selectorExists) {
    const target = { tabId };
    const selector = String(expect.selectorExists);
    const evalOut = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => !!document.querySelector(${JSON.stringify(selector)}))()`,
      returnByValue: true
    });
    const pass = evalOut?.result?.value === true;
    checks.push({ name: "selectorExists", pass, expected: selector });
    if (!pass) ok = false;
  }

  if (result && result.ok === false) {
    checks.push({ name: "invokeResult", pass: false, expected: "ok=true" });
    ok = false;
  }

  const invokeResponseFailed = result?.type === "invoke" && result?.response?.ok === false;
  if (invokeResponseFailed) {
    checks.push({
      name: "invokeResponse",
      pass: false,
      expected: "response.ok=true",
      got: result?.response?.error?.code || "unknown"
    });
    ok = false;
  }

  return {
    ok,
    checks,
    observation
  };
}

async function detachCDP(tabId) {
  if (!attachedTabs.has(tabId)) return;
  await chrome.debugger.detach({ tabId });
  attachedTabs.delete(tabId);
}

function resolveOwnerFromMessage(msg) {
  return msg?.owner || msg?.sessionId || msg?.agentId || "";
}

const BRAIN_SESSION_INDEX_KEY = "session:index";
const BRAIN_ARCHIVE_PREFIX = "archive:legacy";
const BRAIN_ARCHIVE_INDEX_KEY = "archive:legacy:index";
const BRAIN_LEGACY_CHAT_KEY = "chatState.v2";
const BRAIN_DEFAULT_CHUNK_SIZE = 64;
const BRAIN_TRACE_CHUNK_SIZE = 80;
const BRAIN_MAX_STREAM_CACHE = 240;
const BRAIN_MAX_DEBUG_CHARS = 24_000;
const BRAIN_SESSION_TITLE_MAX = 28;
const BRAIN_SESSION_TITLE_MIN = 2;

const brainRunStateBySession = new Map();
const brainEventStreamBySession = new Map();
const brainGlobalDebugLog = [];

function buildBrainSessionMetaKey(sessionId) {
  return `session:${sessionId}:meta`;
}

function buildBrainSessionEntriesChunkKey(sessionId, chunk) {
  return `session:${sessionId}:entries:${chunk}`;
}

function buildBrainTraceChunkKey(traceId, chunk) {
  return `trace:${traceId}:${chunk}`;
}

function isBrainSessionStoreKey(key) {
  return (
    key === BRAIN_SESSION_INDEX_KEY ||
    /^session:[^:]+:meta$/.test(key) ||
    /^session:[^:]+:entries:\d+$/.test(key) ||
    /^trace:[^:]+:\d+$/.test(key)
  );
}

function normalizeIso(value, fallback = nowIso()) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return fallback;
  return new Date(ts).toISOString();
}

function normalizeBrainSessionTitle(value, fallback = "") {
  const compact = String(value || "")
    .replace(/[`*_>#\[\]\(\)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= BRAIN_SESSION_TITLE_MAX) return compact;
  return `${compact.slice(0, BRAIN_SESSION_TITLE_MAX)}…`;
}

function deriveBrainSessionTitle(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const messages = list.filter((entry) => entry?.type === "message");
  const firstUser = messages.find((entry) => String(entry.role || "").toLowerCase() === "user" && String(entry.text || "").trim());
  const firstAssistant = messages.find(
    (entry) => String(entry.role || "").toLowerCase() === "assistant" && String(entry.text || "").trim()
  );

  const candidates = [firstUser?.text, firstAssistant?.text]
    .map((item) => String(item || ""))
    .map((item) => item.split("\n").find((line) => String(line || "").trim()) || item)
    .map((item) => item.replace(/^(请(你)?(帮我)?|帮我|请|麻烦你)\s*/u, ""))
    .map((item) => normalizeBrainSessionTitle(item, ""))
    .filter((item) => item.length >= BRAIN_SESSION_TITLE_MIN);

  return candidates[0] || "";
}

function normalizeBrainSessionId(input) {
  const id = String(input || "").trim();
  if (!id) throw new Error("sessionId 不能为空");
  if (id.includes(":")) throw new Error("sessionId 不能包含冒号");
  return id;
}

function normalizeBrainChunk(input) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0) throw new Error(`chunk 非法: ${String(input)}`);
  return n;
}

function toBrainRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeBrainTabIds(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const id = Number(raw);
    if (!Number.isInteger(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function buildBrainSharedTabsContextMessage(sharedTabs) {
  if (!Array.isArray(sharedTabs) || sharedTabs.length === 0) return "";
  const lines = [];
  for (let i = 0; i < sharedTabs.length; i += 1) {
    const item = sharedTabs[i] || {};
    const title = String(item.title || "").trim() || "(untitled)";
    const url = String(item.url || "").trim() || "";
    const id = Number(item.id);
    const tabIdPart = Number.isInteger(id) ? ` [id=${id}]` : "";
    lines.push(`${i + 1}. ${title}${tabIdPart}${url ? `\n   URL: ${url}` : ""}`);
  }
  return [
    "Shared tabs context (user-selected):",
    ...lines,
    "Use this context directly before deciding whether to call list_tabs/open_tab."
  ].join("\n");
}

function readBrainForkedFrom(meta) {
  const metadata = toBrainRecord(meta?.header?.metadata);
  const raw = toBrainRecord(metadata.forkedFrom);
  const sessionId = String(raw.sessionId || "").trim();
  const leafId = String(raw.leafId || "").trim();
  const sourceEntryId = String(raw.sourceEntryId || "").trim();
  const reason = String(raw.reason || "").trim();
  if (!sessionId && !leafId && !sourceEntryId && !reason) return null;
  return {
    sessionId,
    leafId,
    sourceEntryId,
    reason
  };
}

function findPreviousUserEntryByChain(byId, startEntry) {
  let cursor = startEntry || null;
  let guard = byId.size + 2;
  while (cursor && guard > 0) {
    guard -= 1;
    const isUserMessage = cursor.type === "message" && String(cursor.role || "") === "user";
    if (isUserMessage && String(cursor.id || "").trim()) {
      return cursor;
    }
    const parentId = String(cursor.parentId || "").trim();
    cursor = parentId ? byId.get(parentId) || null : null;
  }
  return null;
}

function defaultBrainRunState(sessionId) {
  return {
    sessionId,
    running: false,
    paused: false,
    stopped: false,
    retry: {
      active: false,
      attempt: 0,
      maxAttempts: 2,
      delayMs: 0
    }
  };
}

function ensureBrainRunState(sessionId) {
  const normalized = normalizeBrainSessionId(sessionId);
  const cached = brainRunStateBySession.get(normalized);
  if (cached) return cached;
  const created = defaultBrainRunState(normalized);
  brainRunStateBySession.set(normalized, created);
  return created;
}

function getBrainRunState(sessionId) {
  const state = ensureBrainRunState(sessionId);
  return {
    sessionId: state.sessionId,
    running: !!state.running,
    paused: !!state.paused,
    stopped: !!state.stopped,
    retry: {
      active: !!state.retry?.active,
      attempt: Number(state.retry?.attempt || 0),
      maxAttempts: Number(state.retry?.maxAttempts || 0),
      delayMs: Number(state.retry?.delayMs || 0)
    }
  };
}

function clipBrainText(input, maxChars = BRAIN_MAX_DEBUG_CHARS) {
  const text = String(input || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...<truncated:${text.length - maxChars}>`;
}

function pushBrainGlobalDebug(entry) {
  brainGlobalDebugLog.push(entry);
  if (brainGlobalDebugLog.length > 300) {
    brainGlobalDebugLog.splice(0, brainGlobalDebugLog.length - 300);
  }
}

const BRAIN_MAX_LOOP_STEPS = 14;
const BRAIN_MAX_LLM_RETRIES = 2;

const BRAIN_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a shell command via bash.exec.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file's content",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["overwrite", "append", "create"] }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Apply edits to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old: { type: "string" },
                new: { type: "string" }
              },
              required: ["old", "new"]
            }
          }
        },
        required: ["path", "edits"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "snapshot",
      description: "Take an accessibility-first snapshot of the current browser tab",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number" },
          mode: { type: "string", enum: ["text", "interactive", "full"] },
          selector: { type: "string" },
          filter: { type: "string", enum: ["interactive", "all"] },
          format: { type: "string", enum: ["compact", "json"] },
          diff: { type: "boolean" },
          maxTokens: { type: "number" },
          depth: { type: "number" },
          noAnimations: { type: "boolean" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_action",
      description: "Perform a browser action (click, type, fill, press, scroll, select, navigate)",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number" },
          kind: { type: "string", enum: ["click", "type", "fill", "press", "scroll", "select", "navigate"] },
          ref: { type: "string" },
          selector: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          url: { type: "string" },
          expect: { type: "object" }
        },
        required: ["kind"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_verify",
      description: "Verify current browser state after action",
      parameters: {
        type: "object",
        properties: {
          tabId: { type: "number" },
          expect: { type: "object" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "List available browser tabs",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "open_tab",
      description: "Open a new browser tab",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          active: { type: "boolean" }
        },
        required: ["url"]
      }
    }
  }
];

function brainDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeStringifyForBrain(input, maxChars = 9000) {
  let text = "";
  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return clipBrainText(text, maxChars);
}

function parsePositiveIntForBrain(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseLlmContent(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (part.type === "text" && typeof part.value === "string") return part.value;
        return "";
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  if (message.content && typeof message.content === "object" && typeof message.content.text === "string") {
    return message.content.text;
  }
  return "";
}

function normalizeBrainVerifyExpect(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  if (typeof raw.urlContains === "string" && raw.urlContains.trim()) out.urlContains = raw.urlContains.trim();
  if (typeof raw.titleContains === "string" && raw.titleContains.trim()) out.titleContains = raw.titleContains.trim();
  if (typeof raw.textIncludes === "string" && raw.textIncludes.trim()) out.textIncludes = raw.textIncludes.trim();
  if (typeof raw.selectorExists === "string" && raw.selectorExists.trim()) out.selectorExists = raw.selectorExists.trim();
  if (raw.urlChanged === true) out.urlChanged = true;
  if (typeof raw.previousUrl === "string" && raw.previousUrl.trim()) out.previousUrl = raw.previousUrl.trim();
  return Object.keys(out).length > 0 ? out : null;
}

function buildBrainObserveProgressVerify(beforeObserve, afterObserve) {
  const beforePage = beforeObserve?.page || {};
  const afterPage = afterObserve?.page || {};
  const checks = [
    {
      name: "urlChanged",
      pass: String(beforePage.url || "") !== String(afterPage.url || ""),
      before: beforePage.url || "",
      after: afterPage.url || ""
    },
    {
      name: "titleChanged",
      pass: String(beforePage.title || "") !== String(afterPage.title || ""),
      before: beforePage.title || "",
      after: afterPage.title || ""
    },
    {
      name: "textLengthChanged",
      pass: Number(beforePage.textLength || 0) !== Number(afterPage.textLength || 0),
      before: Number(beforePage.textLength || 0),
      after: Number(afterPage.textLength || 0)
    },
    {
      name: "nodeCountChanged",
      pass: Number(beforePage.nodeCount || 0) !== Number(afterPage.nodeCount || 0),
      before: Number(beforePage.nodeCount || 0),
      after: Number(afterPage.nodeCount || 0)
    }
  ];
  return {
    ok: checks.some((item) => item.pass),
    checks,
    observation: afterObserve
  };
}

async function queryAllTabsForBrain() {
  const tabs = await chrome.tabs.query({});
  return (tabs || []).filter((tab) => Number.isInteger(tab?.id)).map((tab) => ({
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active === true,
    pinned: tab.pinned === true,
    title: tab.title || "",
    url: tab.url || tab.pendingUrl || ""
  }));
}

async function getActiveTabIdForBrain() {
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const active = focused.find((tab) => Number.isInteger(tab?.id));
  if (active?.id) return active.id;
  const all = await queryAllTabsForBrain();
  const first = all.find((tab) => Number.isInteger(tab.id));
  return first?.id || null;
}

function normalizeBrainToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls
    .map((item, index) => {
      const fn = item?.function || {};
      const name = String(fn.name || "").trim();
      if (!name) return null;
      const args = typeof fn.arguments === "string" ? fn.arguments : safeStringifyForBrain(fn.arguments || {});
      return {
        id: String(item.id || `toolcall-${index + 1}`),
        type: "function",
        function: {
          name,
          arguments: args
        }
      };
    })
    .filter(Boolean);
}

function parseLlmMessageFromSse(rawBody) {
  const lines = String(rawBody || "").split(/\r?\n/);
  const toolByIndex = new Map();
  let text = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = safeJsonParse(data);
    if (!parsed || typeof parsed !== "object") continue;
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    for (const choice of choices) {
      const delta = choice?.delta || choice?.message || {};
      if (typeof delta.content === "string") {
        text += delta.content;
      }
      const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of tcs) {
        const idx = Number.isInteger(tc?.index) ? tc.index : 0;
        const prev = toolByIndex.get(idx) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" }
        };
        if (typeof tc?.id === "string" && tc.id) prev.id = tc.id;
        const fn = tc?.function || {};
        if (typeof fn.name === "string" && fn.name) {
          prev.function.name = prev.function.name ? `${prev.function.name}${fn.name}` : fn.name;
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          prev.function.arguments = `${prev.function.arguments || ""}${fn.arguments}`;
        }
        toolByIndex.set(idx, prev);
      }
    }
  }
  return {
    content: text,
    tool_calls: Array.from(toolByIndex.keys())
      .sort((a, b) => a - b)
      .map((idx) => toolByIndex.get(idx))
      .filter(Boolean)
  };
}

function parseLlmMessageFromBody(rawBody, contentType) {
  const body = String(rawBody || "");
  const lowerType = String(contentType || "").toLowerCase();
  if (lowerType.includes("text/event-stream") || body.trim().startsWith("data:")) {
    return parseLlmMessageFromSse(body);
  }
  const parsed = safeJsonParse(body);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("LLM 响应不是合法 JSON");
  }
  return parsed?.choices?.[0]?.message || null;
}

function buildLlmPayloadFromSessionView(view, model, tools = []) {
  const messages = [];
  const sharedTabs = Array.isArray(view?.meta?.header?.metadata?.sharedTabs)
    ? view.meta.header.metadata.sharedTabs
    : [];
  const sharedTabsContext = buildBrainSharedTabsContextMessage(sharedTabs);
  if (sharedTabsContext) {
    messages.push({
      role: "system",
      content: sharedTabsContext
    });
  }
  for (const item of view?.conversationView?.messages || []) {
    const rawRole = String(item?.role || "assistant").toLowerCase();
    let role = rawRole;
    let content = String(item?.content || "");
    if (!content.trim()) continue;
    // 历史重放阶段不要发送 role=tool（需要 tool_call_id，会触发 LLM 400）。
    // 将工具结果转成 assistant 文本证据，既保留上下文，又符合 chat/completions 约束。
    if (rawRole === "tool") {
      role = "assistant";
      content = `工具执行结果（历史）:\n${content}`;
    } else if (!["system", "user", "assistant"].includes(rawRole)) {
      role = "assistant";
    }
    messages.push({ role, content });
  }
  if (messages.length === 0) {
    messages.push({ role: "user", content: "继续当前任务。" });
  }
  const payload = {
    model,
    messages,
    temperature: 0.2,
    stream: false
  };
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }
  return payload;
}

function toBrainToolResponseEnvelope(type, data, extra = {}) {
  return {
    type,
    response: { ok: true, data },
    ...extra
  };
}

async function appendBrainMessageEntry(sessionId, role, text) {
  const id = normalizeBrainSessionId(sessionId);
  const content = String(text || "");
  const meta = await readBrainSessionMeta(id);
  const entry = {
    id: randomId("entry"),
    type: "message",
    parentId: meta?.leafId || null,
    timestamp: nowIso(),
    role: String(role || "assistant"),
    text: content
  };
  await appendBrainEntry(id, entry);
  return entry;
}

async function withBrainTabLease(tabId, sessionId, run, ttlMs = 30_000) {
  const owner = `brain:${sessionId}`;
  const acquired = acquireLease(tabId, owner, ttlMs);
  if (!acquired?.ok) {
    throw new Error(`lease.acquire 失败: ${acquired?.reason || "unknown"}`);
  }
  try {
    return await run(owner);
  } finally {
    releaseLease(tabId, owner);
  }
}

function shouldVerifyBrainStep(action, verifyPolicy) {
  const policy = String(verifyPolicy || "on_critical");
  if (policy === "off") return false;
  if (policy === "always") return true;
  const critical = ["click", "type", "fill", "press", "scroll", "select", "navigate", "browser_action", "action"];
  return critical.includes(String(action || "").trim().toLowerCase());
}

async function executeBrainStep(sessionId, mode, action, args = {}, verifyPolicy = "on_critical") {
  const id = normalizeBrainSessionId(sessionId);
  const normalizedMode = ["script", "cdp", "bridge"].includes(String(mode || "").trim()) ? String(mode || "").trim() : "";
  const normalizedAction = String(action || "").trim();
  const payload = args && typeof args === "object" ? args : {};
  const actionPayload = payload?.action && typeof payload.action === "object" ? payload.action : payload;
  const tabId = toValidTabId(payload.tabId || actionPayload?.tabId);

  if (!normalizedMode) {
    return { ok: false, modeUsed: "cdp", verified: false, error: "mode 必须是 script/cdp/bridge" };
  }
  if (!normalizedAction) {
    return { ok: false, modeUsed: normalizedMode, verified: false, error: "action 不能为空" };
  }

  const runMode = async (targetMode) => {
    if (targetMode === "bridge") {
      const frame =
        payload?.frame && typeof payload.frame === "object"
          ? { ...payload.frame }
          : {
              tool: String(payload.tool || normalizedAction || "").trim(),
              args: payload.invokeArgs && typeof payload.invokeArgs === "object" ? payload.invokeArgs : payload.args || {}
            };
      if (!frame.tool) throw new Error("bridge 执行缺少 tool");
      if (!frame.sessionId) frame.sessionId = id;
      return {
        type: "invoke",
        response: await invokeBridge(frame)
      };
    }

    if (!tabId) throw new Error(`${targetMode} 执行需要有效 tabId`);
    if (normalizedAction === "snapshot" || normalizedAction === "cdp.snapshot") {
      return await takeSnapshot(tabId, payload.options || payload);
    }
    if (normalizedAction === "observe" || normalizedAction === "cdp.observe") {
      return await observeByCDP(tabId);
    }
    if (normalizedAction === "verify" || normalizedAction === "cdp.verify") {
      const verifyAction =
        payload.action && typeof payload.action === "object"
          ? payload.action
          : {
              expect: payload.expect && typeof payload.expect === "object" ? payload.expect : payload
            };
      return await verifyByCDP(tabId, verifyAction, payload.result || null);
    }
    if (targetMode === "script") {
      const expression = String(payload.expression || payload.script || "").trim();
      if (!expression) {
        throw new Error("script 模式缺少 expression");
      }
      return await executeByCDP(tabId, {
        type: "runtime.evaluate",
        expression,
        returnByValue: payload.returnByValue !== false
      });
    }

    const cdpAction =
      payload.action && typeof payload.action === "object"
        ? { ...payload.action }
        : {
            ...payload
          };
    if (!cdpAction.kind && normalizedAction && !normalizedAction.startsWith("cdp.")) {
      cdpAction.kind = normalizedAction;
    }
    const kind = String(cdpAction.kind || "").trim();
    if (!kind) throw new Error("cdp.action 缺少 kind");

    if (actionRequiresLease(kind)) {
      return await withBrainTabLease(tabId, id, async () => executeRefActionByCDP(tabId, cdpAction));
    }
    return await executeRefActionByCDP(tabId, cdpAction);
  };

  let modeUsed = normalizedMode;
  let fallbackFrom;
  let data;
  let preObserve = null;
  const verifyEnabled = shouldVerifyBrainStep(actionPayload?.kind || normalizedAction, verifyPolicy);
  if (verifyEnabled && tabId && normalizedMode !== "bridge" && normalizedAction !== "verify" && normalizedAction !== "cdp.verify") {
    preObserve = await observeByCDP(tabId).catch(() => null);
  }

  try {
    data = await runMode(normalizedMode);
  } catch (error) {
    if (normalizedMode !== "script") {
      return {
        ok: false,
        modeUsed,
        verified: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    fallbackFrom = "script";
    modeUsed = "cdp";
    try {
      data = await runMode("cdp");
    } catch (fallbackError) {
      return {
        ok: false,
        modeUsed,
        fallbackFrom,
        verified: false,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      };
    }
  }

  let verified = false;
  let verifyReason = "verify_policy_off";
  if (verifyEnabled) {
    if (modeUsed === "bridge") {
      verifyReason = "verify_not_supported_for_bridge";
    } else if (!tabId) {
      verifyReason = "verify_missing_tab_id";
    } else if (normalizedAction === "verify" || normalizedAction === "cdp.verify") {
      verified = data?.ok === true;
      verifyReason = verified ? "verified" : "verify_failed";
    } else {
      const explicitExpect = normalizeBrainVerifyExpect(payload.expect || actionPayload?.expect || null);
      let verifyData = null;
      if (explicitExpect) {
        if (explicitExpect.urlChanged === true && preObserve?.page?.url) {
          explicitExpect.previousUrl = String(preObserve.page.url);
        }
        verifyData = await verifyByCDP(tabId, { expect: explicitExpect }, data?.result || data);
      } else if (preObserve) {
        const afterObserve = await observeByCDP(tabId);
        verifyData = buildBrainObserveProgressVerify(preObserve, afterObserve);
      }
      verified = verifyData?.ok === true;
      verifyReason = verifyData ? (verified ? "verified" : "verify_failed") : "verify_skipped";
      if (verifyData && data && typeof data === "object") {
        data = {
          ...data,
          verify: verifyData
        };
      }
    }
  }

  return {
    ok: true,
    modeUsed,
    fallbackFrom,
    verified,
    verifyReason,
    data
  };
}

function buildBrainToolMessageForLLM(_toolName, result) {
  const payload = result?.response?.data ?? result?.data ?? result;
  return safeStringifyForBrain(payload, 12_000);
}

async function executeBrainToolCall(sessionId, toolCall) {
  const id = normalizeBrainSessionId(sessionId);
  const name = String(toolCall?.function?.name || "").trim();
  const argsRaw = String(toolCall?.function?.arguments || "").trim();
  let args = {};
  if (argsRaw) {
    try {
      args = JSON.parse(argsRaw);
    } catch (error) {
      return { error: `参数解析失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  switch (name) {
    case "bash": {
      const command = String(args.command || "").trim();
      if (!command) return { error: "bash 需要 command" };
      const invoke = await executeBrainStep(id, "bridge", "invoke", {
        frame: {
          tool: "bash",
          args: { cmdId: "bash.exec", args: [command] }
        }
      });
      if (!invoke.ok) return { error: invoke.error || "bash 执行失败" };
      return toBrainToolResponseEnvelope("invoke", invoke.data);
    }
    case "read_file": {
      const path = String(args.path || "").trim();
      if (!path) return { error: "read_file 需要 path" };
      const invokeArgs = { path };
      if (args.offset != null) invokeArgs.offset = args.offset;
      if (args.limit != null) invokeArgs.limit = args.limit;
      const invoke = await executeBrainStep(id, "bridge", "invoke", {
        frame: {
          tool: "read",
          args: invokeArgs
        }
      });
      if (!invoke.ok) return { error: invoke.error || "read_file 执行失败" };
      return toBrainToolResponseEnvelope("invoke", invoke.data);
    }
    case "write_file": {
      const path = String(args.path || "").trim();
      if (!path) return { error: "write_file 需要 path" };
      const invoke = await executeBrainStep(id, "bridge", "invoke", {
        frame: {
          tool: "write",
          args: {
            path,
            content: String(args.content || ""),
            mode: String(args.mode || "overwrite")
          }
        }
      });
      if (!invoke.ok) return { error: invoke.error || "write_file 执行失败" };
      return toBrainToolResponseEnvelope("invoke", invoke.data);
    }
    case "edit_file": {
      const path = String(args.path || "").trim();
      if (!path) return { error: "edit_file 需要 path" };
      const invoke = await executeBrainStep(id, "bridge", "invoke", {
        frame: {
          tool: "edit",
          args: {
            path,
            edits: Array.isArray(args.edits) ? args.edits : []
          }
        }
      });
      if (!invoke.ok) return { error: invoke.error || "edit_file 执行失败" };
      return toBrainToolResponseEnvelope("invoke", invoke.data);
    }
    case "list_tabs": {
      const tabs = await queryAllTabsForBrain();
      const activeTabId = await getActiveTabIdForBrain();
      return toBrainToolResponseEnvelope("tabs", {
        count: tabs.length,
        activeTabId,
        tabs
      });
    }
    case "open_tab": {
      const rawUrl = String(args.url || "").trim();
      if (!rawUrl) return { error: "open_tab 需要 url" };
      const created = await chrome.tabs.create({
        url: rawUrl,
        active: args.active !== false
      });
      return toBrainToolResponseEnvelope("tabs", {
        opened: true,
        tab: {
          id: created?.id || null,
          windowId: created?.windowId || null,
          active: created?.active === true,
          title: created?.title || "",
          url: created?.url || created?.pendingUrl || ""
        }
      });
    }
    case "snapshot": {
      const tabId = parsePositiveIntForBrain(args.tabId) || (await getActiveTabIdForBrain());
      if (!tabId) return { error: "snapshot 需要 tabId，当前无可用 tab" };
      const out = await executeBrainStep(id, "cdp", "snapshot", {
        tabId,
        options: {
          mode: args.mode || "interactive",
          selector: args.selector || "",
          filter: args.filter || "interactive",
          format: args.format === "json" ? "json" : "compact",
          diff: args.diff !== false,
          maxTokens: args.maxTokens,
          depth: args.depth,
          noAnimations: args.noAnimations === true
        }
      });
      if (!out.ok) return { error: out.error || "snapshot 执行失败" };
      return toBrainToolResponseEnvelope("snapshot", out.data);
    }
    case "browser_action": {
      const tabId = parsePositiveIntForBrain(args.tabId) || (await getActiveTabIdForBrain());
      if (!tabId) return { error: "browser_action 需要 tabId，当前无可用 tab" };
      const actionPayload = {
        kind: args.kind,
        ref: args.ref,
        selector: args.selector,
        key: args.key || (String(args.kind || "") === "press" ? args.value : undefined),
        value: args.value,
        url: args.url || (String(args.kind || "") === "navigate" ? args.value : undefined),
        expect: args.expect
      };
      const out = await executeBrainStep(id, "cdp", "action", {
        tabId,
        action: actionPayload,
        expect: args.expect
      });
      if (!out.ok) return { error: out.error || "browser_action 执行失败" };
      const explicitExpect = normalizeBrainVerifyExpect(args.expect || null);
      const hardFail = !!explicitExpect || String(args.kind || "").trim() === "navigate";
      if (!out.verified && hardFail) {
        return {
          error: "browser_action 执行成功但未通过验证",
          errorReason: "failed_verify",
          details: {
            verifyReason: out.verifyReason,
            data: out.data
          }
        };
      }
      return toBrainToolResponseEnvelope("cdp_action", out.data, {
        verifyReason: out.verifyReason,
        verified: out.verified
      });
    }
    case "browser_verify": {
      const tabId = parsePositiveIntForBrain(args.tabId) || (await getActiveTabIdForBrain());
      if (!tabId) return { error: "browser_verify 需要 tabId，当前无可用 tab" };
      const out = await executeBrainStep(
        id,
        "cdp",
        "verify",
        {
          tabId,
          action: {
            expect: normalizeBrainVerifyExpect(args.expect || args) || {}
          }
        },
        "always"
      );
      if (!out.ok) return { error: out.error || "browser_verify 执行失败" };
      if (!out.verified) {
        return {
          error: "browser_verify 未通过",
          errorReason: "failed_verify",
          details: out.data
        };
      }
      return toBrainToolResponseEnvelope("cdp", out.data);
    }
    default:
      return { error: `未知工具: ${name}` };
  }
}

function isRetryableLlmStatus(status) {
  return [408, 409, 429, 500, 502, 503, 504].includes(Number(status || 0));
}

function computeRetryDelayMs(attempt) {
  const base = 500;
  const cap = 4000;
  const next = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(cap, next);
}

async function requestBrainLlmWithRetry(sessionId, step, request) {
  const id = normalizeBrainSessionId(sessionId);
  const state = ensureBrainRunState(id);
  let lastError = null;

  for (let attempt = 1; attempt <= BRAIN_MAX_LLM_RETRIES + 1; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("llm-timeout"), 60_000);
    let status = 0;
    let ok = false;
    let rawBody = "";
    let contentType = "";
    try {
      const resp = await fetch(request.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.llmKey}`
        },
        body: JSON.stringify(request.payload),
        signal: ctrl.signal
      });
      status = resp.status;
      ok = resp.ok;
      contentType = String(resp.headers.get("content-type") || "");
      rawBody = await resp.text();

      await appendBrainTraceEvent(id, "llm.response.raw", {
        step,
        attempt,
        status,
        ok,
        body: clipBrainText(rawBody)
      });

      if (!ok) {
        const err = new Error(`LLM HTTP ${status}`);
        err.status = status;
        throw err;
      }

      const message = parseLlmMessageFromBody(rawBody, contentType);
      if (state.retry.active) {
        state.retry.active = false;
        state.retry.attempt = 0;
        state.retry.delayMs = 0;
        await appendBrainTraceEvent(id, "auto_retry_end", {
          success: true,
          attempt: attempt - 1,
          maxAttempts: state.retry.maxAttempts
        });
      }
      return message;
    } catch (error) {
      lastError = error;
      const statusCode = Number(error?.status || status || 0);
      const retryable = isRetryableLlmStatus(statusCode) || /timeout|network|temporar|unavailable|rate limit/i.test(String(error?.message || ""));
      const canRetry = retryable && attempt <= BRAIN_MAX_LLM_RETRIES;
      if (!canRetry) {
        if (state.retry.active) {
          await appendBrainTraceEvent(id, "auto_retry_end", {
            success: false,
            attempt: state.retry.attempt,
            maxAttempts: state.retry.maxAttempts,
            finalError: error instanceof Error ? error.message : String(error)
          });
        }
        state.retry.active = false;
        state.retry.delayMs = 0;
        throw error;
      }

      const delayMs = computeRetryDelayMs(attempt);
      state.retry.active = true;
      state.retry.attempt = attempt;
      state.retry.delayMs = delayMs;
      await appendBrainTraceEvent(id, "auto_retry_start", {
        attempt,
        maxAttempts: state.retry.maxAttempts,
        delayMs,
        status: statusCode || null,
        reason: error instanceof Error ? error.message : String(error)
      });
      await brainDelay(delayMs);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("LLM request failed");
}

async function runBrainAgentLoop(sessionId, prompt) {
  const id = normalizeBrainSessionId(sessionId);
  const state = ensureBrainRunState(id);
  if (state.stopped) {
    await appendBrainTraceEvent(id, "loop_skip_stopped", { reason: "stopped_before_run" });
    return;
  }

  const config = await getBridgeConfig();
  const llmBase = String(config?.llmApiBase || "").trim();
  const llmKey = String(config?.llmApiKey || "").trim();
  const llmModel = String(config?.llmModel || "gpt-5.3-codex").trim();

  await appendBrainTraceEvent(id, "loop_start", {
    prompt: clipBrainText(prompt, 3000)
  });

  if (!llmBase || !llmKey) {
    const text = "当前未配置可用 LLM（llmApiBase/llmApiKey），已记录你的输入。";
    await appendBrainTraceEvent(id, "llm.skipped", {
      reason: "missing_llm_config",
      hasBase: !!llmBase,
      hasKey: !!llmKey
    });
    await appendBrainMessageEntry(id, "assistant", text);
    await appendBrainTraceEvent(id, "loop_done", {
      status: "done",
      llmSteps: 0,
      toolSteps: 0
    });
    return;
  }

  const view = await buildBrainSessionView(id);
  const messages = buildLlmPayloadFromSessionView(view, llmModel).messages.slice();
  let llmStep = 0;
  let toolStep = 0;
  let finalStatus = "done";

  try {
    while (llmStep < BRAIN_MAX_LOOP_STEPS) {
      if (state.stopped) {
        finalStatus = "stopped";
        break;
      }
      while (state.paused && !state.stopped) {
        await brainDelay(120);
      }
      if (state.stopped) {
        finalStatus = "stopped";
        break;
      }

      llmStep += 1;
      const payload = {
        model: llmModel,
        messages,
        tools: BRAIN_TOOL_DEFS,
        tool_choice: "auto",
        temperature: 0.2,
        stream: false
      };
      const url = `${llmBase.replace(/\/$/, "")}/chat/completions`;
      await appendBrainTraceEvent(id, "llm.request", {
        step: llmStep,
        url,
        model: llmModel,
        messageCount: payload.messages.length,
        payload
      });

      const message = await requestBrainLlmWithRetry(id, llmStep, {
        url,
        llmKey,
        payload
      });
      const assistantText = parseLlmContent(message).trim();
      const toolCalls = normalizeBrainToolCalls(message?.tool_calls);
      await appendBrainTraceEvent(id, "llm.response.parsed", {
        step: llmStep,
        toolCalls: toolCalls.length,
        hasText: !!assistantText
      });

      messages.push({
        role: "assistant",
        content: assistantText,
        tool_calls: toolCalls
      });
      if (assistantText || toolCalls.length === 0) {
        await appendBrainMessageEntry(id, "assistant", assistantText || "LLM 返回空内容。");
      } else {
        await appendBrainMessageEntry(id, "assistant", `调用工具: ${toolCalls.map((tc) => tc.function.name).join(", ")}`);
      }

      if (toolCalls.length === 0) {
        await appendBrainTraceEvent(id, "step_finished", {
          step: llmStep,
          ok: true,
          mode: "llm",
          preview: clipBrainText(assistantText, 1200)
        });
        break;
      }

      for (const tc of toolCalls) {
        toolStep += 1;
        await appendBrainTraceEvent(id, "step_planned", {
          step: toolStep,
          mode: "tool_call",
          action: tc.function.name,
          arguments: clipBrainText(tc.function.arguments, 500)
        });

        const result = await executeBrainToolCall(id, tc);
        if (result?.error) {
          const failureText = `工具 ${tc.function.name} 失败: ${result.error}`;
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: safeStringifyForBrain({ error: result.error, details: result.details || null }, 6000)
          });
          await appendBrainMessageEntry(id, "tool", safeStringifyForBrain({ error: result.error }, 4000));
          await appendBrainTraceEvent(id, "step_finished", {
            step: toolStep,
            ok: false,
            mode: "tool_call",
            action: tc.function.name,
            error: result.error
          });
          await appendBrainMessageEntry(id, "assistant", failureText);
          finalStatus = result.errorReason === "failed_verify" ? "failed_verify" : "failed_execute";
          throw new Error(failureText);
        }

        const toolContent = buildBrainToolMessageForLLM(tc.function.name, result);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolContent
        });
        await appendBrainMessageEntry(id, "tool", clipBrainText(toolContent, 10_000));
        await appendBrainTraceEvent(id, "step_finished", {
          step: toolStep,
          ok: true,
          mode: "tool_call",
          action: tc.function.name,
          preview: clipBrainText(toolContent, 800)
        });
      }
    }
    if (llmStep >= BRAIN_MAX_LOOP_STEPS) {
      finalStatus = "max_steps";
      await appendBrainMessageEntry(id, "assistant", `已达到最大步数 ${BRAIN_MAX_LOOP_STEPS}，结束本轮执行。`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!String(message || "").includes("工具")) {
      await appendBrainMessageEntry(id, "assistant", `执行失败：${message}`);
      finalStatus = "failed_execute";
    }
    await appendBrainTraceEvent(id, "loop_error", {
      message
    });
  } finally {
    try {
      const titleUpdate = await refreshBrainSessionTitle(id, {
        force: false,
        onlyIfEmpty: true,
        source: "auto_first_round"
      });
      if (titleUpdate?.updated) {
        await appendBrainTraceEvent(id, "session_title_auto_updated", {
          title: titleUpdate.title
        });
      }
    } catch (titleError) {
      await appendBrainTraceEvent(id, "session_title_auto_update_failed", {
        error: titleError instanceof Error ? titleError.message : String(titleError)
      });
    }

    await appendBrainTraceEvent(id, "loop_done", {
      status: finalStatus,
      llmSteps: llmStep,
      toolSteps: toolStep
    });
  }
}

async function readBrainSessionIndex() {
  const bag = await chrome.storage.local.get(BRAIN_SESSION_INDEX_KEY);
  const raw = bag?.[BRAIN_SESSION_INDEX_KEY];
  const at = nowIso();
  const sessions = Array.isArray(raw?.sessions)
    ? raw.sessions
        .filter((item) => item && typeof item.id === "string")
        .map((item) => {
          const id = String(item.id || "").trim();
          if (!id || id.includes(":")) return null;
          const createdAt = normalizeIso(item.createdAt, at);
          const updatedAt = normalizeIso(item.updatedAt, createdAt);
          const title = normalizeBrainSessionTitle(item.title, "");
          return { id, createdAt, updatedAt, title };
        })
        .filter(Boolean)
    : [];
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    version: 1,
    sessions,
    updatedAt: normalizeIso(raw?.updatedAt, at)
  };
}

async function writeBrainSessionIndex(index) {
  await chrome.storage.local.set({
    [BRAIN_SESSION_INDEX_KEY]: index
  });
  return index;
}

async function initBrainSessionIndex() {
  const index = await readBrainSessionIndex();
  await writeBrainSessionIndex(index);
  return index;
}

async function upsertBrainSessionIndex(sessionId, at = nowIso(), patch = {}) {
  const id = normalizeBrainSessionId(sessionId);
  const index = await readBrainSessionIndex();
  const nextSessions = index.sessions.filter((item) => item.id !== id);
  const existing = index.sessions.find((item) => item.id === id);
  const title = normalizeBrainSessionTitle(patch?.title, normalizeBrainSessionTitle(existing?.title, ""));
  nextSessions.push({
    id,
    createdAt: existing?.createdAt || at,
    updatedAt: at,
    title
  });
  nextSessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return writeBrainSessionIndex({
    version: 1,
    sessions: nextSessions,
    updatedAt: at
  });
}

async function removeBrainSessionIndexEntry(sessionId, at = nowIso()) {
  const id = normalizeBrainSessionId(sessionId);
  const index = await readBrainSessionIndex();
  const nextSessions = index.sessions.filter((item) => item.id !== id);
  return writeBrainSessionIndex({
    version: 1,
    sessions: nextSessions,
    updatedAt: at
  });
}

async function readBrainSessionMeta(sessionId) {
  const id = normalizeBrainSessionId(sessionId);
  const key = buildBrainSessionMetaKey(id);
  const bag = await chrome.storage.local.get(key);
  const meta = bag?.[key];
  if (!meta || typeof meta !== "object") return null;
  return meta;
}

async function writeBrainSessionMeta(sessionId, meta) {
  const id = normalizeBrainSessionId(sessionId);
  const key = buildBrainSessionMetaKey(id);
  const header = meta?.header && typeof meta.header === "object" ? meta.header : {};
  const normalizedTitle = normalizeBrainSessionTitle(header.title, "");
  const next = {
    ...meta,
    header: {
      ...header,
      title: normalizedTitle
    },
    updatedAt: nowIso()
  };
  await chrome.storage.local.set({ [key]: next });
  await upsertBrainSessionIndex(id, next.updatedAt, { title: normalizedTitle });
  return next;
}

async function ensureBrainSession(sessionId, options = {}) {
  const id = normalizeBrainSessionId(sessionId);
  const existing = await readBrainSessionMeta(id);
  if (existing) return existing;

  const header = {
    type: "session",
    version: 1,
    id,
    parentSessionId: options.parentSessionId || null,
    timestamp: nowIso(),
    title: options.title || "",
    model: options.model || "",
    metadata: options.metadata || {}
  };

  const created = {
    header,
    leafId: null,
    entryCount: 0,
    chunkCount: 0,
    chunkSize: BRAIN_DEFAULT_CHUNK_SIZE,
    updatedAt: nowIso()
  };
  return writeBrainSessionMeta(id, created);
}

async function readBrainEntriesChunk(sessionId, chunk) {
  const id = normalizeBrainSessionId(sessionId);
  const c = normalizeBrainChunk(chunk);
  const key = buildBrainSessionEntriesChunkKey(id, c);
  const bag = await chrome.storage.local.get(key);
  return Array.isArray(bag?.[key]) ? bag[key] : [];
}

async function appendBrainEntry(sessionId, entry) {
  const id = normalizeBrainSessionId(sessionId);
  const meta = await ensureBrainSession(id);
  const chunkSize = Number(meta.chunkSize || BRAIN_DEFAULT_CHUNK_SIZE);
  const chunk = Math.floor(Number(meta.entryCount || 0) / chunkSize);
  const key = buildBrainSessionEntriesChunkKey(id, chunk);
  const current = await readBrainEntriesChunk(id, chunk);
  const merged = current.concat([entry]);
  await chrome.storage.local.set({ [key]: merged });

  await writeBrainSessionMeta(id, {
    ...meta,
    leafId: entry.id,
    entryCount: Number(meta.entryCount || 0) + 1,
    chunkCount: Math.max(Number(meta.chunkCount || 0), chunk + 1),
    chunkSize
  });
}

async function readAllBrainEntries(sessionId) {
  const id = normalizeBrainSessionId(sessionId);
  const meta = await readBrainSessionMeta(id);
  if (!meta || !Number(meta.chunkCount || 0)) return [];
  const entries = [];
  for (let chunk = 0; chunk < Number(meta.chunkCount || 0); chunk += 1) {
    const items = await readBrainEntriesChunk(id, chunk);
    entries.push(...items);
  }
  return entries.slice(0, Number(meta.entryCount || entries.length));
}

async function refreshBrainSessionTitle(sessionId, options = {}) {
  const id = normalizeBrainSessionId(sessionId);
  const meta = await ensureBrainSession(id);
  const currentTitle = normalizeBrainSessionTitle(meta?.header?.title, "");
  if (options.onlyIfEmpty && currentTitle) {
    return {
      sessionId: id,
      title: currentTitle,
      updated: false
    };
  }

  const entries = await readAllBrainEntries(id);
  const derivedTitle = normalizeBrainSessionTitle(options.title || deriveBrainSessionTitle(entries), "");
  if (!derivedTitle) {
    return {
      sessionId: id,
      title: currentTitle,
      updated: false
    };
  }

  if (!options.force && derivedTitle === currentTitle) {
    await upsertBrainSessionIndex(id, nowIso(), { title: currentTitle });
    return {
      sessionId: id,
      title: currentTitle,
      updated: false
    };
  }

  const nextMeta = await writeBrainSessionMeta(id, {
    ...meta,
    header: {
      ...(meta.header || {}),
      title: derivedTitle,
      titleSource: String(options.source || (options.force ? "manual" : "auto")),
      titleUpdatedAt: nowIso()
    }
  });

  return {
    sessionId: id,
    title: normalizeBrainSessionTitle(nextMeta?.header?.title, derivedTitle),
    updated: true
  };
}

async function deleteBrainSession(sessionId) {
  const id = normalizeBrainSessionId(sessionId);
  const metaKey = buildBrainSessionMetaKey(id);
  const entriesPrefix = `session:${id}:entries:`;
  const tracePrefix = `trace:session-${id}:`;
  const all = await chrome.storage.local.get(null);
  const removableKeys = [];

  for (const key of Object.keys(all || {})) {
    if (key === metaKey || key.startsWith(entriesPrefix) || key.startsWith(tracePrefix)) {
      removableKeys.push(key);
    }
  }

  if (removableKeys.length > 0) {
    await chrome.storage.local.remove(removableKeys);
  }

  const state = brainRunStateBySession.get(id);
  if (state) {
    state.running = false;
    state.paused = false;
    state.stopped = true;
  }
  brainRunStateBySession.delete(id);
  brainEventStreamBySession.delete(id);

  const index = await removeBrainSessionIndexEntry(id, nowIso());
  return {
    sessionId: id,
    deleted: true,
    removedCount: removableKeys.length,
    removedKeys: removableKeys,
    index
  };
}

function findLatestBrainCompaction(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "compaction") continue;
    return entry;
  }
  return null;
}

async function getBrainBranchEntries(sessionId, leafId = undefined) {
  const id = normalizeBrainSessionId(sessionId);
  const meta = await ensureBrainSession(id);
  const all = await readAllBrainEntries(id);
  if (all.length === 0) {
    return {
      meta,
      all,
      branch: []
    };
  }

  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const targetLeafId = leafId === undefined ? meta.leafId : leafId;
  let branch = all;

  if (targetLeafId && byId.has(targetLeafId)) {
    const chain = [];
    let cursor = byId.get(targetLeafId);
    let guard = all.length + 2;
    while (cursor && guard > 0) {
      chain.push(cursor);
      guard -= 1;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
    if (chain.length > 0) {
      branch = chain.reverse();
    }
  }

  return {
    meta,
    all,
    branch
  };
}

async function buildBrainSessionView(sessionId, leafId = undefined) {
  const id = normalizeBrainSessionId(sessionId);
  const { meta, all, branch } = await getBrainBranchEntries(id, leafId);
  const parentSessionId = String(meta?.header?.parentSessionId || "");
  const forkedFrom = readBrainForkedFrom(meta);

  const compact = findLatestBrainCompaction(branch);
  const previousSummary = String(compact?.summary || "");
  const firstKeptEntryId = compact?.firstKeptEntryId || null;
  const post = (() => {
    if (!firstKeptEntryId) return branch;
    const idx = branch.findIndex((entry) => entry.id === firstKeptEntryId);
    if (idx < 0) return [];
    return branch.slice(idx);
  })();

  const messages = [];
  if (previousSummary) {
    messages.push({
      role: "system",
      content: `Previous summary:\n${previousSummary}`,
      entryId: `summary:${id}`
    });
  }

  for (const entry of post) {
    if (entry?.type !== "message") continue;
    messages.push({
      role: String(entry.role || "assistant"),
      content: String(entry.text || ""),
      entryId: String(entry.id || "")
    });
  }

  return {
    sessionId: id,
    meta,
    entries: all,
    conversationView: {
      sessionId: id,
      messageCount: messages.length,
      messages,
      parentSessionId,
      forkedFrom,
      lastStatus: getBrainRunState(id),
      updatedAt: nowIso()
    }
  };
}

async function appendBrainTraceEvent(sessionId, type, payload = {}) {
  const id = normalizeBrainSessionId(sessionId);
  const event = {
    type,
    sessionId: id,
    ts: nowIso(),
    payload
  };
  const current = brainEventStreamBySession.get(id) || [];
  current.push(event);
  if (current.length > BRAIN_MAX_STREAM_CACHE) {
    current.splice(0, current.length - BRAIN_MAX_STREAM_CACHE);
  }
  brainEventStreamBySession.set(id, current);
  broadcast({ type: "brain.event", event });
  pushBrainGlobalDebug({
    ts: event.ts,
    sessionId: id,
    type,
    payload
  });

  const traceId = `session-${id}`;
  const chunk = Math.floor((current.length - 1) / BRAIN_TRACE_CHUNK_SIZE);
  const key = buildBrainTraceChunkKey(traceId, chunk);
  const bag = await chrome.storage.local.get(key);
  const records = Array.isArray(bag?.[key]) ? bag[key] : [];
  records.push({
    id: randomId("trace"),
    sessionId: id,
    type,
    timestamp: event.ts,
    payload
  });
  await chrome.storage.local.set({ [key]: records });

  return event;
}

async function readBrainStepStream(sessionId) {
  const id = normalizeBrainSessionId(sessionId);
  const cache = brainEventStreamBySession.get(id);
  if (Array.isArray(cache) && cache.length > 0) {
    return cache;
  }

  const traceId = `session-${id}`;
  const loaded = [];
  for (let chunk = 0; chunk < 128; chunk += 1) {
    const key = buildBrainTraceChunkKey(traceId, chunk);
    const bag = await chrome.storage.local.get(key);
    const items = Array.isArray(bag?.[key]) ? bag[key] : [];
    if (items.length === 0) break;
    loaded.push(...items);
  }
  return loaded;
}

function shouldArchiveBrainLegacyKey(key, matchers, excluded) {
  if (excluded.has(key)) return false;
  if (isBrainSessionStoreKey(key)) return false;
  if (key === BRAIN_ARCHIVE_INDEX_KEY) return false;
  if (key.startsWith(`${BRAIN_ARCHIVE_PREFIX}:`)) return false;

  return matchers.some((matcher) => {
    if (typeof matcher === "string") return key === matcher || key.startsWith(`${matcher}:`);
    return matcher.test(key);
  });
}

async function archiveBrainLegacyState(options = {}) {
  const all = await chrome.storage.local.get(null);
  const matchers = Array.isArray(options.legacyMatchers) && options.legacyMatchers.length > 0
    ? options.legacyMatchers
    : [
        "chatState",
        "chatState.v1",
        "chatState.v2",
        /^session:meta:/,
        /^session:entries:/,
        /^trace:[^:]+$/,
        /^trace:[^:]+:events$/,
        /^loop:/,
        /^planner:/,
        /^runtime:/,
        /^memory:/,
        /^brain-loop:/
      ];
  const excluded = new Set(Array.isArray(options.excludeKeys) ? options.excludeKeys : []);

  const keys = Object.keys(all).filter((key) => shouldArchiveBrainLegacyKey(key, matchers, excluded));
  const archiveIndexRaw = Array.isArray(all?.[BRAIN_ARCHIVE_INDEX_KEY]) ? all[BRAIN_ARCHIVE_INDEX_KEY] : [];
  const archiveIndex = archiveIndexRaw.filter((item) => typeof item === "string" && item);

  if (keys.length === 0) {
    return {
      archiveKey: null,
      archivedKeys: [],
      archivedCount: 0,
      archiveIndexSize: archiveIndex.length
    };
  }

  const archiveKey = `${BRAIN_ARCHIVE_PREFIX}:${Date.now()}`;
  const archivedData = {};
  for (const key of keys) {
    archivedData[key] = all[key];
  }

  const nextArchiveIndex = archiveIndex.concat(archiveKey);
  await chrome.storage.local.set({
    [archiveKey]: {
      archivedAt: nowIso(),
      source: "service-worker-compat",
      keys,
      data: archivedData
    },
    [BRAIN_ARCHIVE_INDEX_KEY]: nextArchiveIndex
  });
  await chrome.storage.local.remove(keys);

  return {
    archiveKey,
    archivedKeys: keys,
    archivedCount: keys.length,
    archiveIndexSize: nextArchiveIndex.length
  };
}

async function resetBrainSessionStore(options = {}) {
  const includeTrace = options.includeTrace !== false;
  const preserveArchive = options.preserveArchive !== false;
  const archived = options.archiveLegacyBeforeReset ? await archiveBrainLegacyState(options.archiveLegacyOptions || {}) : undefined;

  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all);
  const removable = [];

  for (const key of keys) {
    if (key === BRAIN_SESSION_INDEX_KEY) {
      removable.push(key);
      continue;
    }
    if (!isBrainSessionStoreKey(key)) continue;
    if (!includeTrace && key.startsWith("trace:")) continue;
    removable.push(key);
  }

  if (!preserveArchive) {
    for (const key of keys) {
      if (key === BRAIN_ARCHIVE_INDEX_KEY || key.startsWith(`${BRAIN_ARCHIVE_PREFIX}:`)) {
        removable.push(key);
      }
    }
  }

  const uniqueRemovable = Array.from(new Set(removable));
  if (uniqueRemovable.length > 0) {
    await chrome.storage.local.remove(uniqueRemovable);
  }

  const index = await initBrainSessionIndex();
  return {
    removedKeys: uniqueRemovable,
    removedCount: uniqueRemovable.length,
    archived,
    index
  };
}

async function bootstrapBrainSessionStore() {
  const bag = await chrome.storage.local.get(BRAIN_LEGACY_CHAT_KEY);
  if (bag?.[BRAIN_LEGACY_CHAT_KEY]) {
    const result = await resetBrainSessionStore({
      includeTrace: true,
      preserveArchive: true,
      archiveLegacyBeforeReset: true
    });
    broadcast({
      type: "brain.bootstrap",
      mode: "legacy-reset",
      result
    });
    return result;
  }

  return initBrainSessionIndex();
}

async function handleBrainRunMessage(msg) {
  if (msg.type === "brain.run.start") {
    let sessionId = typeof msg.sessionId === "string" ? msg.sessionId.trim() : "";
    if (!sessionId) sessionId = randomId("session");
    await ensureBrainSession(sessionId, msg.sessionOptions || {});
    const runState = ensureBrainRunState(sessionId);

    if (Array.isArray(msg.tabIds)) {
      const tabIds = normalizeBrainTabIds(msg.tabIds);
      const allTabs = await queryAllTabsForBrain();
      const tabById = new Map(allTabs.map((tab) => [Number(tab.id), tab]));
      const sharedTabs = tabIds
        .map((id) => tabById.get(id))
        .filter(Boolean)
        .map((tab) => ({
          id: Number(tab.id),
          title: String(tab.title || ""),
          url: String(tab.url || "")
        }));
      const meta = await readBrainSessionMeta(sessionId);
      if (meta) {
        const header = toBrainRecord(meta.header);
        const metadata = toBrainRecord(header.metadata);
        if (sharedTabs.length > 0) {
          metadata.sharedTabs = sharedTabs;
        } else {
          delete metadata.sharedTabs;
        }
        await writeBrainSessionMeta(sessionId, {
          ...meta,
          header: {
            ...header,
            metadata
          }
        });
      }
      await appendBrainTraceEvent(sessionId, "input.shared_tabs", {
        providedTabIds: tabIds,
        resolvedCount: sharedTabs.length
      });
    }

    const prompt = String(msg.prompt || "").trim();
    if (prompt) {
      const meta = await readBrainSessionMeta(sessionId);
      const entry = {
        id: randomId("entry"),
        type: "message",
        parentId: meta?.leafId || null,
        timestamp: nowIso(),
        role: "user",
        text: prompt
      };
      await appendBrainEntry(sessionId, entry);
      await appendBrainTraceEvent(sessionId, "input.user", {
        text: clipBrainText(prompt, 3000)
      });

      // stop/pause 只影响“当前运行中的 loop”，新的启动请求应允许重新进入执行。
      if (msg.autoRun !== false && runState.stopped) {
        runState.stopped = false;
        runState.paused = false;
        await appendBrainTraceEvent(sessionId, "loop_restart", {
          reason: "restart_after_stop"
        });
      }

      if (!runState.running && msg.autoRun !== false) {
        runState.running = true;
        void runBrainAgentLoop(sessionId, prompt)
          .catch(async (err) => {
            await appendBrainTraceEvent(sessionId, "loop_internal_error", {
              error: err instanceof Error ? err.message : String(err)
            });
          })
          .finally(() => {
            const latest = ensureBrainRunState(sessionId);
            latest.running = false;
          });
      } else if (runState.running && msg.autoRun !== false) {
        await appendBrainTraceEvent(sessionId, "loop_enqueue_skipped", {
          reason: "already_running"
        });
      }
    }

    return {
      ok: true,
      data: {
        sessionId,
        runtime: getBrainRunState(sessionId)
      }
    };
  }

  if (msg.type === "brain.run.regenerate") {
    const sessionId = normalizeBrainSessionId(msg.sessionId);
    const sourceEntryId = String(msg.sourceEntryId || "").trim();
    if (!sourceEntryId) {
      return { ok: false, error: "brain.run.regenerate 需要 sourceEntryId" };
    }

    const meta = await readBrainSessionMeta(sessionId);
    if (!meta) {
      return { ok: false, error: `session 不存在: ${sessionId}` };
    }

    const entries = await readAllBrainEntries(sessionId);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const source = byId.get(sourceEntryId);
    if (!source) {
      return { ok: false, error: `regenerate sourceEntry 不存在: ${sourceEntryId}` };
    }
    if (source.type !== "message" || source.role !== "assistant") {
      return { ok: false, error: "regenerate sourceEntry 必须是 assistant 消息" };
    }

    const requireSourceIsLeaf = msg.requireSourceIsLeaf === true;
    const rebaseLeafToPreviousUser = msg.rebaseLeafToPreviousUser === true;
    const currentLeafId = String(meta?.leafId || "");
    if (requireSourceIsLeaf && currentLeafId !== sourceEntryId) {
      return { ok: false, error: "仅最后一条 assistant 支持当前会话重试" };
    }

    const previousSeed = String(source.parentId || "").trim();
    const previousEntry = previousSeed ? byId.get(previousSeed) : null;
    const previousUser = findPreviousUserEntryByChain(byId, previousEntry);
    if (!previousUser) {
      return { ok: false, error: "未找到前序 user 消息，无法重试" };
    }

    const prompt = String(previousUser.text || "").trim();
    if (!prompt) {
      return { ok: false, error: "前序 user 消息为空，无法重试" };
    }

    if (rebaseLeafToPreviousUser && currentLeafId !== previousUser.id) {
      await writeBrainSessionMeta(sessionId, {
        ...meta,
        leafId: previousUser.id
      });
    }

    const runState = ensureBrainRunState(sessionId);
    await appendBrainTraceEvent(sessionId, "input.regenerate", {
      sourceEntryId,
      previousUserEntryId: previousUser.id,
      text: clipBrainText(prompt, 3000)
    });

    if (runState.stopped) {
      runState.stopped = false;
      runState.paused = false;
      await appendBrainTraceEvent(sessionId, "loop_restart", {
        reason: "restart_after_regenerate"
      });
    }

    if (!runState.running) {
      runState.running = true;
      void runBrainAgentLoop(sessionId, prompt)
        .catch(async (err) => {
          await appendBrainTraceEvent(sessionId, "loop_internal_error", {
            error: err instanceof Error ? err.message : String(err)
          });
        })
        .finally(() => {
          const latest = ensureBrainRunState(sessionId);
          latest.running = false;
        });
    } else {
      await appendBrainTraceEvent(sessionId, "loop_enqueue_skipped", {
        reason: "already_running"
      });
    }

    return {
      ok: true,
      data: {
        sessionId,
        runtime: getBrainRunState(sessionId)
      }
    };
  }

  const sessionId = normalizeBrainSessionId(msg.sessionId);
  const state = ensureBrainRunState(sessionId);

  if (msg.type === "brain.run.pause") {
    state.paused = true;
    return { ok: true, data: getBrainRunState(sessionId) };
  }
  if (msg.type === "brain.run.resume") {
    state.paused = false;
    return { ok: true, data: getBrainRunState(sessionId) };
  }
  if (msg.type === "brain.run.stop") {
    state.stopped = true;
    state.running = false;
    return { ok: true, data: getBrainRunState(sessionId) };
  }

  return { ok: false, error: `unsupported brain.run action: ${msg.type}` };
}

async function handleBrainSessionMessage(msg) {
  if (msg.type === "brain.session.list") {
    const index = await readBrainSessionIndex();
    const sessions = await Promise.all(
      index.sessions.map(async (entry) => {
        const meta = await readBrainSessionMeta(entry.id);
        return {
          ...entry,
          title: normalizeBrainSessionTitle(entry.title, normalizeBrainSessionTitle(meta?.header?.title, "")),
          parentSessionId: String(meta?.header?.parentSessionId || ""),
          forkedFrom: readBrainForkedFrom(meta)
        };
      })
    );

    return {
      ok: true,
      data: {
        ...index,
        sessions
      }
    };
  }

  if (msg.type === "brain.session.get") {
    const sessionId = normalizeBrainSessionId(msg.sessionId);
    const view = await buildBrainSessionView(sessionId, msg.leafId);
    return {
      ok: true,
      data: {
        meta: view.meta,
        entries: view.entries
      }
    };
  }

  if (msg.type === "brain.session.view") {
    const sessionId = normalizeBrainSessionId(msg.sessionId);
    const view = await buildBrainSessionView(sessionId, msg.leafId);
    return {
      ok: true,
      data: {
        conversationView: view.conversationView
      }
    };
  }

  if (msg.type === "brain.session.fork") {
    const sessionId = normalizeBrainSessionId(msg.sessionId);
    const leafId = String(msg.leafId || "").trim();
    if (!leafId) {
      return { ok: false, error: "brain.session.fork 需要 leafId" };
    }

    const sourceMeta = await readBrainSessionMeta(sessionId);
    if (!sourceMeta) {
      return { ok: false, error: `session 不存在: ${sessionId}` };
    }

    const sourceEntries = await readAllBrainEntries(sessionId);
    const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    if (!byId.has(leafId)) {
      return { ok: false, error: `fork leaf 不存在: ${leafId}` };
    }

    const sourceTitle = String(sourceMeta?.header?.title || "").trim();
    const forkTitle = String(msg.title || "").trim() || (sourceTitle ? `${sourceTitle} · 重答分支` : "重答分支");
    const sourceMetadata = toBrainRecord(sourceMeta?.header?.metadata);
    const forkReason = String(msg.reason || "manual");
    const sourceEntryId = String(msg.sourceEntryId || "");
    const targetSessionId = String(msg.targetSessionId || "").trim() || randomId("session");

    if (String(msg.targetSessionId || "").trim()) {
      const existing = await readBrainSessionMeta(targetSessionId);
      if (existing) {
        return { ok: false, error: `targetSessionId 已存在: ${targetSessionId}` };
      }
    }

    await ensureBrainSession(targetSessionId, {
      parentSessionId: sessionId,
      title: forkTitle,
      model: sourceMeta?.header?.model || "",
      metadata: {
        ...sourceMetadata,
        forkedFrom: {
          sessionId,
          leafId,
          sourceEntryId,
          reason: forkReason
        }
      }
    });

    const { branch } = await getBrainBranchEntries(sessionId, leafId);
    const oldToNew = new Map();
    for (const sourceEntry of branch) {
      const cloned = {
        ...sourceEntry,
        id: randomId("entry"),
        parentId: sourceEntry.parentId ? oldToNew.get(sourceEntry.parentId) || null : null,
        timestamp: nowIso()
      };
      if (cloned.type === "compaction") {
        const oldFirstKept = String(cloned.firstKeptEntryId || "").trim();
        cloned.firstKeptEntryId = oldFirstKept ? oldToNew.get(oldFirstKept) || null : null;
      }
      await appendBrainEntry(targetSessionId, cloned);
      oldToNew.set(sourceEntry.id, cloned.id);
    }

    return {
      ok: true,
      data: {
        sessionId: targetSessionId,
        sourceSessionId: sessionId,
        sourceLeafId: leafId,
        leafId: oldToNew.get(leafId) || null,
        copiedEntryCount: branch.length
      }
    };
  }

  if (msg.type === "brain.session.title.refresh") {
    const sessionId = normalizeBrainSessionId(msg.sessionId);
    const out = await refreshBrainSessionTitle(sessionId, {
      force: true,
      source: "manual_refresh"
    });
    await appendBrainTraceEvent(sessionId, "session_title_manual_refresh", {
      title: out.title,
      updated: !!out.updated
    });
    return {
      ok: true,
      data: out
    };
  }

  if (msg.type === "brain.session.delete") {
    const sessionId = normalizeBrainSessionId(msg.sessionId);
    const out = await deleteBrainSession(sessionId);
    return {
      ok: true,
      data: out
    };
  }

  return { ok: false, error: `unsupported brain.session action: ${msg.type}` };
}

async function handleBrainStepMessage(msg) {
  if (msg.type === "brain.step.stream") {
    const sessionId = normalizeBrainSessionId(msg.sessionId);
    const stream = await readBrainStepStream(sessionId);
    return { ok: true, data: { sessionId, stream } };
  }

  if (msg.type === "brain.step.execute") {
    const sessionId = normalizeBrainSessionId(msg.sessionId);
    const mode = String(msg.mode || "").trim();
    const action = String(msg.action || "").trim();
    if (!mode || !action) {
      return { ok: false, error: "brain.step.execute 需要 mode + action" };
    }

    await appendBrainTraceEvent(sessionId, "step_execute", {
      mode,
      action,
      args: msg.args || {},
      verifyPolicy: msg.verifyPolicy || "on_critical"
    });

    const out = await executeBrainStep(sessionId, mode, action, msg.args || {}, msg.verifyPolicy || "on_critical");
    await appendBrainTraceEvent(sessionId, "step_execute_result", {
      mode,
      action,
      ok: out?.ok === true,
      modeUsed: out?.modeUsed || mode,
      verified: out?.verified === true,
      verifyReason: out?.verifyReason || ""
    });
    return {
      ok: true,
      data: out
    };
  }

  return { ok: false, error: `unsupported brain.step action: ${msg.type}` };
}

async function handleBrainStorageMessage(msg) {
  if (msg.type === "brain.storage.archive") {
    return { ok: true, data: await archiveBrainLegacyState(msg.options || {}) };
  }
  if (msg.type === "brain.storage.reset") {
    return { ok: true, data: await resetBrainSessionStore(msg.options || { archiveLegacyBeforeReset: true }) };
  }
  if (msg.type === "brain.storage.init") {
    return { ok: true, data: await initBrainSessionIndex() };
  }
  return { ok: false, error: `unsupported brain.storage action: ${msg.type}` };
}

async function handleBrainDebugMessage(msg) {
  if (msg.type === "brain.debug.dump") {
    const sessionId = typeof msg.sessionId === "string" && msg.sessionId.trim() ? normalizeBrainSessionId(msg.sessionId) : "";
    if (sessionId) {
      const view = await buildBrainSessionView(sessionId);
      const stream = await readBrainStepStream(sessionId);
      return {
        ok: true,
        data: {
          sessionId,
          runtime: getBrainRunState(sessionId),
          meta: view.meta,
          entryCount: Array.isArray(view.entries) ? view.entries.length : 0,
          conversationView: view.conversationView,
          stepStream: stream,
          globalTail: brainGlobalDebugLog.slice(-80)
        }
      };
    }

    return {
      ok: true,
      data: {
        index: await readBrainSessionIndex(),
        runningSessions: Array.from(brainRunStateBySession.values()).map((item) => getBrainRunState(item.sessionId)),
        globalTail: brainGlobalDebugLog.slice(-120)
      }
    };
  }

  if (msg.type === "brain.debug.config") {
    const cfg = await getBridgeConfig();
    return {
      ok: true,
      data: {
        bridgeUrl: cfg.bridgeUrl,
        llmApiBase: cfg.llmApiBase,
        llmModel: cfg.llmModel,
        hasLlmApiKey: !!String(cfg.llmApiKey || "").trim()
      }
    };
  }

  return { ok: false, error: `unsupported brain.debug action: ${msg.type}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== "string") {
      sendResponse({ ok: false, error: "Invalid message" });
      return;
    }

    if (msg.type === "config.save") {
      await chrome.storage.local.set(msg.payload || {});
      bridgeConfigCache = null;
      await restartDevReloadPolling();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "config.get") {
      const config = await getBridgeConfig();
      sendResponse({ ok: true, data: config });
      return;
    }

    if (msg.type === "bridge.connect") {
      await connectBridge(true);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "bridge.invoke") {
      const resp = await invokeBridge(msg.payload || {});
      sendResponse({ ok: true, data: resp });
      return;
    }

    if (msg.type === "cdp.observe") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "cdp.observe 需要有效 tabId" });
        return;
      }
      const data = await observeByCDP(tabId);
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "cdp.snapshot") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "cdp.snapshot 需要有效 tabId" });
        return;
      }
      const data = await takeSnapshot(tabId, msg.options || {});
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "cdp.action") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "cdp.action 需要有效 tabId" });
        return;
      }

      const action = msg.action || {};
      const kind = normalizeActionKind(action.kind);
      const owner = resolveOwnerFromMessage(msg);

      if (actionRequiresLease(kind)) {
        ensureLeaseForWrite(tabId, owner);
      }

      const data = await executeRefActionByCDP(tabId, action);
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "cdp.execute") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "cdp.execute 需要有效 tabId" });
        return;
      }
      const data = await executeByCDP(tabId, msg.action || {});
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "cdp.verify") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "cdp.verify 需要有效 tabId" });
        return;
      }
      const data = await verifyByCDP(tabId, msg.action || {}, msg.result || null);
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "cdp.detach") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "cdp.detach 需要有效 tabId" });
        return;
      }
      await detachCDP(tabId);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "lease.acquire") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "lease.acquire 需要有效 tabId" });
        return;
      }
      const data = acquireLease(tabId, resolveOwnerFromMessage(msg), msg.ttlMs);
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "lease.heartbeat") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "lease.heartbeat 需要有效 tabId" });
        return;
      }
      const data = heartbeatLease(tabId, resolveOwnerFromMessage(msg), msg.ttlMs);
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "lease.release") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "lease.release 需要有效 tabId" });
        return;
      }
      const data = releaseLease(tabId, resolveOwnerFromMessage(msg));
      sendResponse({ ok: true, data });
      return;
    }

    if (msg.type === "lease.status") {
      const tabId = toValidTabId(msg.tabId);
      if (!tabId) {
        sendResponse({ ok: false, error: "lease.status 需要有效 tabId" });
        return;
      }
      sendResponse({ ok: true, data: leaseStatus(tabId) });
      return;
    }

    if (msg.type.startsWith("brain.run.")) {
      const out = await handleBrainRunMessage(msg);
      sendResponse(out);
      return;
    }

    if (msg.type.startsWith("brain.session.")) {
      const out = await handleBrainSessionMessage(msg);
      sendResponse(out);
      return;
    }

    if (msg.type.startsWith("brain.step.")) {
      const out = await handleBrainStepMessage(msg);
      sendResponse(out);
      return;
    }

    if (msg.type.startsWith("brain.storage.")) {
      const out = await handleBrainStorageMessage(msg);
      sendResponse(out);
      return;
    }

    if (msg.type.startsWith("brain.debug.")) {
      const out = await handleBrainDebugMessage(msg);
      sendResponse(out);
      return;
    }

    sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
  })().catch((err) => {
    sendResponse({
      ok: false,
      error: err?.message || String(err)
    });
  });

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureSidePanelBehavior().catch(() => {});
  bootstrapBrainSessionStore().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureSidePanelBehavior().catch(() => {});
  bootstrapBrainSessionStore().catch(() => {});
});

ensureSidePanelBehavior().catch(() => {});
bootstrapBrainSessionStore().catch(() => {});
restartDevReloadPolling().catch(() => {});
