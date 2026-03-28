import {
  BrainOrchestrator,
  attachChannelObserver,
  initSessionIndex,
  registerRuntimeRouter,
} from "../sw/kernel";

const orchestrator = new BrainOrchestrator();
registerRuntimeRouter(orchestrator);
attachChannelObserver(orchestrator);

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8787/ws";
const DEFAULT_BRIDGE_TOKEN = "";
const DEV_RELOAD_DEFAULT_INTERVAL_MS = 1500;
const DEV_RELOAD_IDLE_INTERVAL_MS = 1500;
const DEV_RELOAD_MIN_INTERVAL_MS = 500;
const DEV_RELOAD_MAX_INTERVAL_MS = 30_000;
const DEV_RELOAD_STORAGE_VERSION_KEY = "devBridgeSeenVersion";
const WECHAT_RESUME_ALARM_NAME = "bbl.wechat.resume";
const WECHAT_RESUME_ALARM_PERIOD_MINUTES = 1;

let devReloadTimer: ReturnType<typeof setTimeout> | null = null;
let devReloadInFlight = false;
let devReloadVersionReady = false;
let devReloadSeenVersion = "";

function broadcast(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // sidepanel may be closed
  });
}

async function bootstrapSessionStore(): Promise<void> {
  await initSessionIndex();
  const syncResult = await chrome.runtime
    .sendMessage({
      type: "brain.mcp.sync-config",
    })
    .catch((error) => {
      console.warn("[mcp] startup sync failed", error);
      return null;
    });
  if (syncResult && syncResult.ok !== true) {
    console.warn("[mcp] startup sync failed", syncResult.error);
  }
}

async function scheduleWechatResumeAlarm(): Promise<void> {
  await chrome.alarms.create(WECHAT_RESUME_ALARM_NAME, {
    periodInMinutes: WECHAT_RESUME_ALARM_PERIOD_MINUTES,
  });
}

async function requestWechatResume(reason: string): Promise<void> {
  const response = await chrome.runtime
    .sendMessage({
      type: "brain.channel.wechat.resume",
      reason,
    })
    .catch((error) => {
      console.warn("[wechat] resume failed", error);
      return null;
    });
  if (response && response.ok !== true) {
    console.warn("[wechat] resume rejected", response.error);
  }
}

async function bootstrapWechatLifecycle(reason: string): Promise<void> {
  await scheduleWechatResumeAlarm().catch((error) => {
    console.warn("[wechat] alarm setup failed", error);
  });
  await requestWechatResume(reason);
}

function toIntInRange(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function resolveBridgeHttpBase(bridgeUrlRaw: unknown): string {
  const fallback = "http://127.0.0.1:8787";
  const raw = String(bridgeUrlRaw || "").trim() || DEFAULT_BRIDGE_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "ws:") {
      return `http://${parsed.host}`;
    }
    if (parsed.protocol === "wss:") {
      return `https://${parsed.host}`;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

async function loadDevReloadConfig(): Promise<{
  enabled: boolean;
  intervalMs: number;
  versionUrl: string;
}> {
  const data = await chrome.storage.local.get([
    "devAutoReload",
    "devReloadIntervalMs",
    "bridgeUrl",
    "bridgeToken"
  ]);
  const enabled = data.devAutoReload === true;
  const intervalMs = toIntInRange(
    data.devReloadIntervalMs,
    DEV_RELOAD_DEFAULT_INTERVAL_MS,
    DEV_RELOAD_MIN_INTERVAL_MS,
    DEV_RELOAD_MAX_INTERVAL_MS
  );
  const bridgeBase = resolveBridgeHttpBase(data.bridgeUrl);
  const token = String(data.bridgeToken || DEFAULT_BRIDGE_TOKEN);
  const versionUrl = token
    ? `${bridgeBase}/dev/version?token=${encodeURIComponent(token)}`
    : `${bridgeBase}/dev/version`;
  return { enabled, intervalMs, versionUrl };
}

async function loadSeenDevVersion(): Promise<void> {
  if (devReloadVersionReady) return;
  const data = await chrome.storage.local.get([DEV_RELOAD_STORAGE_VERSION_KEY]);
  devReloadSeenVersion = String(data[DEV_RELOAD_STORAGE_VERSION_KEY] || "").trim();
  devReloadVersionReady = true;
}

async function saveSeenDevVersion(version: string): Promise<void> {
  const next = String(version || "").trim();
  if (!next) return;
  devReloadSeenVersion = next;
  devReloadVersionReady = true;
  await chrome.storage.local.set({
    [DEV_RELOAD_STORAGE_VERSION_KEY]: next
  });
}

async function pollDevVersionAndMaybeReload(): Promise<{ intervalMs: number }> {
  const config = await loadDevReloadConfig();
  if (!config.enabled) {
    return { intervalMs: DEV_RELOAD_IDLE_INTERVAL_MS };
  }
  await loadSeenDevVersion();

  try {
    const response = await fetch(config.versionUrl, { method: "GET", cache: "no-store" });
    if (!response.ok) {
      return { intervalMs: config.intervalMs };
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const latestVersion = String(payload.version || "").trim();
    if (!latestVersion) {
      return { intervalMs: config.intervalMs };
    }

    if (!devReloadSeenVersion) {
      await saveSeenDevVersion(latestVersion);
      return { intervalMs: config.intervalMs };
    }

    if (latestVersion !== devReloadSeenVersion) {
      await saveSeenDevVersion(latestVersion);
      chrome.runtime.reload();
      return { intervalMs: config.intervalMs };
    }
  } catch {
    // bridge 未启动/401/网络异常时保持静默，等待下轮轮询
  }

  return { intervalMs: config.intervalMs };
}

function scheduleDevReloadPoll(delayMs: number): void {
  if (devReloadTimer) {
    clearTimeout(devReloadTimer);
  }
  devReloadTimer = setTimeout(() => {
    void runDevReloadPollLoop();
  }, delayMs);
}

async function runDevReloadPollLoop(): Promise<void> {
  if (devReloadInFlight) return;
  devReloadInFlight = true;
  try {
    const { intervalMs } = await pollDevVersionAndMaybeReload();
    scheduleDevReloadPoll(intervalMs);
  } finally {
    devReloadInFlight = false;
  }
}

function startDevAutoReloadLoop(): void {
  scheduleDevReloadPoll(250);
}

orchestrator.events.subscribe((event) => {
  broadcast({ type: "brain.event", event });
});

chrome.runtime.onInstalled.addListener(() => {
  void bootstrapSessionStore();
  void bootstrapWechatLifecycle("install");
});

chrome.runtime.onStartup?.addListener(() => {
  void bootstrapSessionStore();
  void bootstrapWechatLifecycle("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WECHAT_RESUME_ALARM_NAME) return;
  void requestWechatResume("alarm");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (
    !("devAutoReload" in changes) &&
    !("devReloadIntervalMs" in changes) &&
    !("bridgeUrl" in changes) &&
    !("bridgeToken" in changes)
  ) {
    return;
  }
  scheduleDevReloadPoll(50);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});

startDevAutoReloadLoop();
void bootstrapWechatLifecycle("service_worker");
