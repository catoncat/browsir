<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";
import {
  DEFAULT_PANEL_LLM_API_BASE,
  DEFAULT_PANEL_LLM_MODEL,
  DEFAULT_PANEL_LLM_PROVIDER,
  useConfigStore,
  type PanelLlmProfile,
} from "../stores/config-store";
import { ArrowLeft, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-vue-next";
import { normalizeProviderConnectionConfig } from "../../shared/llm-provider-config";

const emit = defineEmits(["close"]);
const store = useConfigStore();
const { config, savingConfig, error } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const localError = ref("");
const showApiKeys = ref<Record<string, boolean>>({});
const bindingLoading = ref<Record<string, boolean>>({});
const cursorHelpRuntimeByProfile = ref<Record<string, CursorHelpRuntimeState>>(
  {},
);

const defaultProfileId = "provider-default-profile";
const auxProfileId = "provider-aux-profile";
const fallbackProfileId = "provider-fallback-profile";
const CURSOR_WEB_PROFILE_ID = "cursor-web";
const CURSOR_HELP_URL = "https://cursor.com/help";
const CURSOR_TAB_PATTERNS = ["https://cursor.com/help*"] as const;
const CURSOR_HELP_CONTAINER_WIDTH = 1280;
const CURSOR_HELP_CONTAINER_HEIGHT = 900;
const CURSOR_HELP_CONNECT_TIMEOUT_MS = 20_000;
const CURSOR_HELP_CONNECT_POLL_MS = 250;
const builtinProviderOptions = [
  { value: "openai_compatible", label: "通用 API" },
  { value: "cursor_help_web", label: "Cursor" },
] as const;

const visibleError = computed(
  () => localError.value || String(error.value || ""),
);

interface CursorHelpRuntimeState {
  canExecute: boolean;
  pageHookReady: boolean;
  fetchHookReady: boolean;
  senderReady: boolean;
  selectedModel: string;
  availableModels: string[];
  senderKind: string;
  lastSenderError: string;
  url: string;
  targetTabId: number | null;
}

interface LocatedCursorHelpTab {
  tab: chrome.tabs.Tab;
  inspect: CursorHelpRuntimeState | null;
}

function emptyCursorHelpRuntimeState(): CursorHelpRuntimeState {
  return {
    canExecute: false,
    pageHookReady: false,
    fetchHookReady: false,
    senderReady: false,
    selectedModel: "",
    senderKind: "",
    lastSenderError: "",
    url: "",
    targetTabId: null,
  };
}

function runtimeState(profile: PanelLlmProfile): CursorHelpRuntimeState {
  const profileId = String(profile.id || "").trim();
  if (!profileId) return emptyCursorHelpRuntimeState();
  return (
    cursorHelpRuntimeByProfile.value[profileId] || emptyCursorHelpRuntimeState()
  );
}

function patchCursorHelpRuntimeState(
  profile: PanelLlmProfile,
  patch: Partial<CursorHelpRuntimeState>,
): void {
  const profileId = String(profile.id || "").trim();
  if (!profileId) return;
  cursorHelpRuntimeByProfile.value = {
    ...cursorHelpRuntimeByProfile.value,
    [profileId]: {
      ...runtimeState(profile),
      ...patch,
    },
  };
}
const secondaryProfileOptions = computed(() => {
  const defaultProfile = String(config.value.llmDefaultProfile || "").trim();
  return config.value.llmProfiles.filter(
    (profile) => String(profile.id || "").trim() !== defaultProfile,
  );
});

function normalizeProfileId(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createUniqueProfileId(seed: string, taken: Set<string>): string {
  const base = normalizeProfileId(seed) || "profile";
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function providerOptions(profile: PanelLlmProfile): Record<string, unknown> {
  if (!profile.providerOptions || typeof profile.providerOptions !== "object") {
    profile.providerOptions = {};
  }
  return profile.providerOptions;
}

function isCursorHelpWebProvider(profile: PanelLlmProfile): boolean {
  return (
    String(profile.provider || "")
      .trim()
      .toLowerCase() === "cursor_help_web"
  );
}

function findCursorWebProfile(): PanelLlmProfile | null {
  return (
    config.value.llmProfiles.find((profile) =>
      isCursorHelpWebProvider(profile),
    ) || null
  );
}

function getProviderSelectOptions(
  profile: PanelLlmProfile,
): Array<{ value: string; label: string }> {
  const current = String(profile.provider || "").trim();
  if (!current) return [...builtinProviderOptions];
  if (builtinProviderOptions.some((item) => item.value === current)) {
    return [...builtinProviderOptions];
  }
  return [
    { value: current, label: `自定义接入 (${current})` },
    ...builtinProviderOptions,
  ];
}

function isDefaultProfile(profile: PanelLlmProfile): boolean {
  return (
    String(profile.id || "").trim() ===
    String(config.value.llmDefaultProfile || "").trim()
  );
}

function isAuxProfile(profile: PanelLlmProfile): boolean {
  return (
    String(profile.id || "").trim() ===
    String(config.value.llmAuxProfile || "").trim()
  );
}

function isFallbackProfile(profile: PanelLlmProfile): boolean {
  return (
    String(profile.id || "").trim() ===
    String(config.value.llmFallbackProfile || "").trim()
  );
}

function getProviderLabel(profile: PanelLlmProfile): string {
  const provider = String(profile.provider || "")
    .trim()
    .toLowerCase();
  if (provider === "cursor_help_web") return "Cursor 宿主聊天";
  if (provider === "openai_compatible") return "通用 API";
  return String(profile.provider || "").trim() || "未设置接入方式";
}

function getProfileTitle(profile: PanelLlmProfile, index: number): string {
  return String(profile.id || "").trim() || `模型 ${index + 1}`;
}

function getProfileSummary(profile: PanelLlmProfile): string {
  if (isCursorHelpWebProvider(profile)) {
    const state = runtimeState(profile);
    if (state.canExecute) {
      return "已连接，沿用当前 Cursor 页面会话与登录状态。";
    }
    if (state.pageHookReady && state.fetchHookReady && !state.senderReady) {
      return "已绑定 Cursor 页面，正在等待聊天入口。";
    }
    if (state.targetTabId || state.pageHookReady || state.fetchHookReady) {
      return "已绑定 Cursor 页面，正在等待页面就绪。";
    }
    return "未连接到可用的 Cursor 聊天页。";
  }
  const model = String(profile.llmModel || "").trim() || "未设置模型";
  const base = String(profile.llmApiBase || "").trim() || "未设置接口地址";
  return `${model} · ${base}`;
}

function getProfileOptionLabel(profile: PanelLlmProfile): string {
  const id = String(profile.id || "").trim() || "未命名模型";
  const model = String(profile.llmModel || "").trim() || "未设置模型";
  return `${id} · ${getProviderLabel(profile)} · ${model}`;
}

function getCursorHelpTargetTabId(profile: PanelLlmProfile): number | "" {
  const raw = Number(providerOptions(profile).targetTabId);
  return Number.isInteger(raw) && raw > 0 ? raw : "";
}

function getCursorHelpConnectionLabel(profile: PanelLlmProfile): string {
  const state = runtimeState(profile);
  if (state.canExecute) return "已连接";
  if (state.pageHookReady && state.fetchHookReady && !state.senderReady) {
    return "等待聊天入口";
  }
  if (state.targetTabId || state.pageHookReady || state.fetchHookReady) {
    return "等待页面就绪";
  }
  return "未连接";
}

function getCursorWebConnectionLabel(): string {
  const profile = findCursorWebProfile();
  return profile ? getCursorHelpConnectionLabel(profile) : "未连接";
}

function getCursorHelpDetectedModel(profile: PanelLlmProfile): string {
  return runtimeState(profile).selectedModel;
}

function getCursorHelpAvailableModels(profile: PanelLlmProfile): string[] {
  return runtimeState(profile).availableModels;
}

function getCursorHelpModelOptions(profile: PanelLlmProfile): string[] {
  const out = new Set<string>(["auto"]);
  const detected = getCursorHelpDetectedModel(profile);
  if (detected) out.add(detected);
  for (const model of getCursorHelpAvailableModels(profile)) {
    out.add(model);
  }
  return Array.from(out);
}

function setCursorHelpTargetTabId(
  profile: PanelLlmProfile,
  value: unknown,
): void {
  const options = providerOptions(profile);
  const raw = Number(value);
  if (Number.isInteger(raw) && raw > 0) {
    options.targetTabId = raw;
    patchCursorHelpRuntimeState(profile, { targetTabId: raw });
  } else {
    delete options.targetTabId;
    patchCursorHelpRuntimeState(profile, { targetTabId: null });
  }
  options.targetSite = "cursor_help";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCursorHelpConnectionError(
  state: CursorHelpRuntimeState | null,
): string {
  if (!state) {
    return "已打开 Cursor 页面，但页面还没有完成加载。请稍后重试。";
  }
  if (!state.pageHookReady) {
    return "已打开 Cursor 页面，但页面脚本还没有准备好。请稍后重试。";
  }
  if (!state.fetchHookReady) {
    return "已连接到 Cursor 页面，但会话通道还没有准备好。请稍后重试。";
  }
  if (!state.senderReady) {
    const suffix = state.lastSenderError ? ` ${state.lastSenderError}` : "";
    return `已连接到 Cursor 页面，但聊天入口还没有准备好。请稍后重试。${suffix}`.trim();
  }
  return "Cursor 页面暂时不可用，请稍后重试。";
}

async function sendTabMessageWithRetry(
  tabId: number,
  message: Record<string, unknown>,
  retries = 12,
): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (errorValue) {
      lastError = errorValue;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || "标签页通信失败"));
}

async function inspectCursorTab(
  tabId: number,
): Promise<CursorHelpRuntimeState | null> {
  const response = await sendTabMessageWithRetry(tabId, {
    type: "webchat.inspect",
  }).catch(() => null);
  const row =
    response && typeof response === "object"
      ? (response as Record<string, unknown>)
      : null;
  if (!row || row.ok !== true) return null;
  return {
    canExecute: row.canExecute === true,
    pageHookReady: row.pageHookReady === true,
    fetchHookReady: row.fetchHookReady === true,
    senderReady: row.senderReady === true,
    selectedModel: String(row.selectedModel || "").trim(),
    availableModels: Array.isArray(row.availableModels)
      ? row.availableModels
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [],
    senderKind: String(row.senderKind || "").trim(),
    lastSenderError: String(row.lastSenderError || "").trim(),
    url: String(row.url || ""),
    targetTabId: tabId,
  };
}

async function locateCursorChatTab(
  active: boolean,
): Promise<LocatedCursorHelpTab | null> {
  const tabs = await chrome.tabs.query({ url: [...CURSOR_TAB_PATTERNS] });
  const sorted = [...tabs].sort((left, right) => {
    const leftHelp = String(left.url || "").startsWith(CURSOR_HELP_URL) ? 1 : 0;
    const rightHelp = String(right.url || "").startsWith(CURSOR_HELP_URL)
      ? 1
      : 0;
    return rightHelp - leftHelp;
  });
  let pending: LocatedCursorHelpTab | null = null;
  for (const tab of sorted) {
    if (!tab.id) continue;
    const inspected = await inspectCursorTab(tab.id);
    const located = { tab, inspect: inspected };
    if (inspected?.canExecute) {
      if (active) {
        await focusTab(tab);
      }
      return located;
    }
    if (!pending) {
      pending = located;
    }
  }
  if (pending && active) {
    await focusTab(pending.tab);
  }
  return pending;
}

async function openCursorFallbackTab(
  _active: boolean,
): Promise<chrome.tabs.Tab> {
  const createdWindow = await chrome.windows
    .create({
      url: CURSOR_HELP_URL,
      focused: false,
      type: "popup",
      width: CURSOR_HELP_CONTAINER_WIDTH,
      height: CURSOR_HELP_CONTAINER_HEIGHT,
    })
    .catch(async () => {
      return chrome.windows.create({
        url: CURSOR_HELP_URL,
        focused: false,
        width: CURSOR_HELP_CONTAINER_WIDTH,
        height: CURSOR_HELP_CONTAINER_HEIGHT,
      });
    });
  const createdTab = Array.isArray(createdWindow?.tabs)
    ? createdWindow.tabs[0]
    : null;
  if (!createdTab?.id) {
    throw new Error("未能打开 Cursor 页面");
  }
  await chrome.tabs.update(createdTab.id, { autoDiscardable: false }).catch(() => {
    // noop
  });
  if (typeof createdWindow?.id === "number") {
    await chrome.windows.update(createdWindow.id, { state: "minimized" }).catch(() => {
      // noop
    });
  }
  return createdTab;
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {
    // noop
  });
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
      // noop
    });
  }
}

async function bindCurrentTab(profile: PanelLlmProfile): Promise<void> {
  await ensureCursorHelpTab(profile, true);
}

async function waitForCursorHelpTabUsable(
  profile: PanelLlmProfile,
  tabId: number,
  timeoutMs = CURSOR_HELP_CONNECT_TIMEOUT_MS,
): Promise<CursorHelpRuntimeState | null> {
  const deadline = Date.now() + timeoutMs;
  let lastState: CursorHelpRuntimeState | null = null;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) break;
    if (String(tab.url || "").startsWith(CURSOR_HELP_URL)) {
      lastState = await inspectCursorTab(tabId).catch(() => lastState);
      patchCursorHelpRuntimeState(profile, {
        ...(lastState || emptyCursorHelpRuntimeState()),
        targetTabId: tabId,
      });
      if (lastState?.canExecute) {
        return lastState;
      }
    }
    await sleep(CURSOR_HELP_CONNECT_POLL_MS);
  }
  return lastState;
}

async function ensureCursorHelpTab(
  profile: PanelLlmProfile,
  active: boolean,
): Promise<void> {
  const profileId = String(profile.id || "").trim();
  if (!profileId) return;
  bindingLoading.value = {
    ...bindingLoading.value,
    [profileId]: true,
  };
  localError.value = "";
  try {
    const located = await locateCursorChatTab(active);
    let boundTab = located?.tab || null;
    let inspected = located?.inspect || null;
    const createdNewTab = !boundTab?.id;

    if (!boundTab?.id) {
      boundTab = await openCursorFallbackTab(active);
      inspected = null;
    }

    if (!boundTab?.id) {
      throw new Error("未能打开 Cursor 页面");
    }
    if (inspected) {
      patchCursorHelpRuntimeState(profile, inspected);
    }
    if (active) {
      await focusTab(boundTab);
    }
    setCursorHelpTargetTabId(profile, boundTab.id);
    if (!inspected?.canExecute) {
      inspected = await waitForCursorHelpTabUsable(profile, boundTab.id);
    } else {
      patchCursorHelpRuntimeState(profile, {
        ...inspected,
        targetTabId: boundTab.id,
      });
    }
    if (!active && typeof boundTab.windowId === "number") {
      await chrome.windows.update(boundTab.windowId, { state: "minimized" }).catch(() => {
        // noop
      });
    }
    if (!inspected?.canExecute) {
      localError.value = formatCursorHelpConnectionError(inspected);
    }
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  } finally {
    bindingLoading.value = {
      ...bindingLoading.value,
      [profileId]: false,
    };
  }
}

async function inspectCursorHelpTab(
  profile: PanelLlmProfile,
  tabId = Number(getCursorHelpTargetTabId(profile)),
): Promise<void> {
  if (!Number.isInteger(tabId) || tabId <= 0) return;
  const inspected = await inspectCursorTab(tabId);
  patchCursorHelpRuntimeState(profile, {
    ...(inspected || emptyCursorHelpRuntimeState()),
    targetTabId: tabId,
  });
  if (!String(profile.llmModel || "").trim()) {
    profile.llmModel = "auto";
  }
}

async function handleProviderChange(profile: PanelLlmProfile): Promise<void> {
  if (!isCursorHelpWebProvider(profile)) return;
  const options = providerOptions(profile);
  options.targetSite = "cursor_help";
  if (
    !String(profile.llmModel || "").trim() ||
    String(profile.llmModel || "").trim() === DEFAULT_PANEL_LLM_MODEL
  ) {
    profile.llmModel = "auto";
  }
  await ensureCursorHelpTab(profile, true);
}

async function enableCursorWebPreset(): Promise<void> {
  localError.value = "";
  ensureProfiles();
  let profile = findCursorWebProfile();
  if (!profile) {
    const connection = normalizeProviderConnectionConfig({
      provider: "cursor_help_web",
      llmApiBase: "",
      llmApiKey: "",
    });
    profile = {
      id: CURSOR_WEB_PROFILE_ID,
      provider: "cursor_help_web",
      llmApiBase: connection.llmApiBase,
      llmApiKey: connection.llmApiKey,
      llmModel: "auto",
      providerOptions: {
        targetSite: "cursor_help",
      },
      llmTimeoutMs: 120000,
      llmRetryMaxAttempts: 1,
      llmMaxRetryDelayMs: 60000,
    };
    config.value.llmProfiles.unshift(profile);
  }
  profile.provider = "cursor_help_web";
  const connection = normalizeProviderConnectionConfig({
    provider: profile.provider,
    llmApiBase: profile.llmApiBase,
    llmApiKey: profile.llmApiKey,
  });
  profile.llmApiBase = connection.llmApiBase;
  profile.llmApiKey = connection.llmApiKey;
  profile.llmModel = String(profile.llmModel || "auto").trim() || "auto";
  providerOptions(profile).targetSite = "cursor_help";
  config.value.llmDefaultProfile = profile.id;
  ensureProfiles();
  await ensureCursorHelpTab(profile, true);
}

function buildDefaultProfile(idSeed: string): PanelLlmProfile {
  const id = normalizeProfileId(idSeed) || "profile-default";
  return {
    id,
    provider: DEFAULT_PANEL_LLM_PROVIDER,
    llmApiBase: DEFAULT_PANEL_LLM_API_BASE,
    llmApiKey: "",
    llmModel: DEFAULT_PANEL_LLM_MODEL,
    providerOptions: {},
    llmTimeoutMs: Number(config.value.llmTimeoutMs || 120000),
    llmRetryMaxAttempts: Number(config.value.llmRetryMaxAttempts || 2),
    llmMaxRetryDelayMs: Number(config.value.llmMaxRetryDelayMs || 60000),
  };
}

function nextProfileId(): string {
  const existing = new Set(
    config.value.llmProfiles.map((item) => String(item.id || "").trim()),
  );
  let index = config.value.llmProfiles.length + 1;
  while (existing.has(`profile-${index}`)) {
    index += 1;
  }
  return `profile-${index}`;
}

function sanitizeSelectedProfiles(): void {
  const validIds = new Set(
    config.value.llmProfiles
      .map((item) => String(item.id || "").trim())
      .filter(Boolean),
  );
  const firstId = String(config.value.llmProfiles[0]?.id || "").trim();
  const currentDefault = String(config.value.llmDefaultProfile || "").trim();
  const nextDefault = validIds.has(currentDefault)
    ? currentDefault
    : firstId || "default";
  config.value.llmDefaultProfile = nextDefault;

  const auxProfile = String(config.value.llmAuxProfile || "").trim();
  config.value.llmAuxProfile =
    auxProfile && auxProfile !== nextDefault && validIds.has(auxProfile)
      ? auxProfile
      : "";

  const fallbackProfile = String(config.value.llmFallbackProfile || "").trim();
  config.value.llmFallbackProfile =
    fallbackProfile &&
    fallbackProfile !== nextDefault &&
    validIds.has(fallbackProfile)
      ? fallbackProfile
      : "";
}

function ensureProfiles(): void {
  if (
    !Array.isArray(config.value.llmProfiles) ||
    config.value.llmProfiles.length === 0
  ) {
    config.value.llmProfiles = [buildDefaultProfile("default")];
  }
  sanitizeSelectedProfiles();
}

function toggleApiKey(profileId: string): void {
  const id = String(profileId || "").trim();
  if (!id) return;
  showApiKeys.value = {
    ...showApiKeys.value,
    [id]: !showApiKeys.value[id],
  };
}

function addProfile(): void {
  localError.value = "";
  ensureProfiles();
  config.value.llmProfiles.push(buildDefaultProfile(nextProfileId()));
}

function removeProfile(profileId: string): void {
  if (config.value.llmProfiles.length <= 1) {
    localError.value = "至少保留一个模型";
    return;
  }
  const id = String(profileId || "").trim();
  config.value.llmProfiles = config.value.llmProfiles.filter(
    (item) => String(item.id || "").trim() !== id,
  );
  ensureProfiles();
}

function normalizeProfilesBeforeSave(): void {
  const taken = new Set<string>();
  const normalized: PanelLlmProfile[] = [];
  const idMap = new Map<string, string>();

  for (const raw of config.value.llmProfiles) {
    const sourceId = String(raw.id || "").trim();
    const normalizedId = createUniqueProfileId(
      sourceId || nextProfileId(),
      taken,
    );
    taken.add(normalizedId);
    if (sourceId) {
      idMap.set(sourceId, normalizedId);
    }
    const provider =
      String(raw.provider || DEFAULT_PANEL_LLM_PROVIDER).trim() ||
      DEFAULT_PANEL_LLM_PROVIDER;
    const nextProviderOptions =
      raw.providerOptions && typeof raw.providerOptions === "object"
        ? { ...raw.providerOptions }
        : {};
    if (provider.toLowerCase() === "cursor_help_web") {
      delete nextProviderOptions.detectedModel;
      delete nextProviderOptions.availableModels;
      delete nextProviderOptions.lastSenderError;
      delete nextProviderOptions.senderKind;
      delete nextProviderOptions.pageHookReady;
      delete nextProviderOptions.fetchHookReady;
      delete nextProviderOptions.senderReady;
      delete nextProviderOptions.canExecute;
      delete nextProviderOptions.url;
      nextProviderOptions.targetSite = "cursor_help";
    }
    const connection = normalizeProviderConnectionConfig({
      provider,
      llmApiBase: raw.llmApiBase,
      llmApiKey: raw.llmApiKey,
    });
    normalized.push({
      id: normalizedId,
      provider,
      llmApiBase: connection.llmApiBase,
      llmApiKey: connection.llmApiKey,
      llmModel:
        String(raw.llmModel || DEFAULT_PANEL_LLM_MODEL).trim() ||
        DEFAULT_PANEL_LLM_MODEL,
      providerOptions: nextProviderOptions,
      llmTimeoutMs: Math.max(1000, Number(raw.llmTimeoutMs || 120000)),
      llmRetryMaxAttempts: Math.max(
        0,
        Math.min(6, Number(raw.llmRetryMaxAttempts || 2)),
      ),
      llmMaxRetryDelayMs: Math.max(0, Number(raw.llmMaxRetryDelayMs || 60000)),
    });
  }

  config.value.llmProfiles =
    normalized.length > 0 ? normalized : [buildDefaultProfile("default")];

  const remapSelection = (value: string): string => {
    const id = String(value || "").trim();
    if (!id) return "";
    return idMap.get(id) || id;
  };

  config.value.llmDefaultProfile = remapSelection(
    config.value.llmDefaultProfile,
  );
  config.value.llmAuxProfile = remapSelection(config.value.llmAuxProfile);
  config.value.llmFallbackProfile = remapSelection(
    config.value.llmFallbackProfile,
  );
  ensureProfiles();
}

async function handleSave(): Promise<void> {
  localError.value = "";
  try {
    normalizeProfilesBeforeSave();
    for (const profile of config.value.llmProfiles) {
      if (isCursorHelpWebProvider(profile) && !runtimeState(profile).canExecute) {
        await ensureCursorHelpTab(profile, false);
      }
    }
    await store.saveConfig();
    emit("close");
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  }
}

const cursorHelpPoolState = ref<Record<string, unknown> | null>(null);
const cursorHelpPoolLoading = ref(false);

async function sendBrainMessage(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (result && typeof result === "object") return result as Record<string, unknown>;
  } catch {
    // extension context may be unavailable
  }
  return null;
}

async function refreshCursorHelpPool(): Promise<void> {
  cursorHelpPoolLoading.value = true;
  try {
    const result = await sendBrainMessage({ type: "brain.debug.cursor_help_pool", action: "heartbeat" });
    if (result?.ok && result.data) {
      cursorHelpPoolState.value = result.data as Record<string, unknown>;
    }
  } finally {
    cursorHelpPoolLoading.value = false;
  }
}

async function rebuildCursorHelpPoolFromUI(): Promise<void> {
  cursorHelpPoolLoading.value = true;
  localError.value = "";
  try {
    const result = await sendBrainMessage({
      type: "brain.debug.cursor_help_pool",
      action: "rebuild",
    });
    if (result?.ok && result.data) {
      cursorHelpPoolState.value = result.data as Record<string, unknown>;
    } else {
      localError.value = String((result as Record<string, unknown>)?.error || "重建运行池失败");
    }
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  } finally {
    cursorHelpPoolLoading.value = false;
  }
}

function poolSummary(): Record<string, unknown> {
  const pool = cursorHelpPoolState.value;
  if (!pool || typeof pool !== "object") return {};
  const summary = (pool as Record<string, unknown>).summary;
  return summary && typeof summary === "object" ? summary as Record<string, unknown> : {};
}

function poolSlots(): Array<Record<string, unknown>> {
  const pool = cursorHelpPoolState.value;
  if (!pool || typeof pool !== "object") return [];
  const slots = (pool as Record<string, unknown>).slots;
  return Array.isArray(slots) ? slots as Array<Record<string, unknown>> : [];
}

function slotStatusColor(status: unknown): string {
  const s = String(status || "").trim();
  if (s === "idle") return "text-emerald-500";
  if (s === "busy") return "text-amber-500";
  if (s === "recovering") return "text-violet-400";
  if (s === "warming") return "text-sky-400";
  if (s === "error" || s === "stale") return "text-red-500";
  return "text-ui-text-muted";
}

function slotStatusLabel(status: unknown): string {
  const s = String(status || "").trim();
  if (s === "idle") return "就绪";
  if (s === "busy") return "执行中";
  if (s === "recovering") return "恢复中";
  if (s === "warming") return "预热中";
  if (s === "error") return "异常";
  if (s === "stale") return "过期";
  if (s === "cold") return "冷启动";
  return s || "未知";
}

function poolWindowStatusLabel(status: unknown): string {
  const s = String(status || "").trim();
  if (s === "external-tabs") return "外部标签页";
  if (s === "minimized") return "后台最小化";
  if (s === "normal") return "前台可见";
  if (s === "missing") return "窗口缺失";
  if (s === "none") return "未建立";
  return s || "未知";
}

function poolWindowStatusColor(status: unknown): string {
  const s = String(status || "").trim();
  if (s === "external-tabs" || s === "minimized") return "text-emerald-500";
  if (s === "normal") return "text-amber-500";
  if (s === "missing") return "text-red-500";
  return "text-ui-text-muted";
}

function poolWindowEventLabel(event: unknown): string {
  const s = String(event || "").trim();
  if (s === "adopt_existing_tabs") return "接管现有标签页";
  if (s === "reuse_external_tabs") return "复用现有标签页";
  if (s === "create_pool_window") return "创建专用窗口";
  if (s === "pool_window_removed") return "专用窗口已关闭";
  if (s === "skip_window_backgrounding") return "跳过后台最小化";
  if (s === "await_manual_rebuild") return "等待手动重建";
  return s || "无";
}

function poolBooleanLabel(value: unknown): string {
  return value ? "是" : "否";
}

onMounted(() => {
  ensureProfiles();
  for (const profile of config.value.llmProfiles) {
    if (!isCursorHelpWebProvider(profile)) continue;
    const targetTabId = getCursorHelpTargetTabId(profile);
    if (targetTabId) {
      void inspectCursorHelpTab(profile);
      continue;
    }
    void locateCursorChatTab(false).then((located) => {
      if (located?.tab.id) {
        void inspectCursorHelpTab(profile, located.tab.id);
      }
    });
  }
  void refreshCursorHelpPool();
  dialogRef.value?.focus();
});
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="模型设置"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header
      class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0"
    >
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="返回"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" aria-hidden="true" />
      </button>
      <h2 class="ml-2 text-[13px] font-bold tracking-tight">模型设置</h2>
    </header>

    <main class="flex-1 overflow-y-auto p-4 space-y-4">
      <section
        class="border border-ui-border bg-ui-surface/30 p-4 rounded-sm space-y-3"
      >
        <div class="space-y-1">
          <p class="text-[16px] font-semibold tracking-tight text-ui-text">
            模型
          </p>
          <p class="text-[12px] text-ui-text-muted leading-relaxed">
            默认模型必选，其余按需设置。
          </p>
        </div>

        <div class="grid grid-cols-1 gap-3">
          <label class="space-y-1.5">
            <span
              class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
              >默认模型</span
            >
            <select
              :id="defaultProfileId"
              v-model="config.llmDefaultProfile"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <option
                v-for="profile in config.llmProfiles"
                :key="profile.id"
                :value="profile.id"
              >
                {{ getProfileOptionLabel(profile) }}
              </option>
            </select>
            <p class="text-[11px] text-ui-text-muted/75">用于对话回复</p>
          </label>

          <label class="space-y-1.5">
            <span
              class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
              >标题与摘要</span
            >
            <select
              :id="auxProfileId"
              v-model="config.llmAuxProfile"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <option value="">使用默认模型</option>
              <option
                v-for="profile in secondaryProfileOptions"
                :key="profile.id"
                :value="profile.id"
              >
                {{ getProfileOptionLabel(profile) }}
              </option>
            </select>
            <p class="text-[11px] text-ui-text-muted/75">
              可选，用于自动生成标题和摘要
            </p>
          </label>

          <label class="space-y-1.5">
            <span
              class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
              >备用模型</span
            >
            <select
              :id="fallbackProfileId"
              v-model="config.llmFallbackProfile"
              class="w-full bg-ui-bg border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <option value="">不使用备用模型</option>
              <option
                v-for="profile in secondaryProfileOptions"
                :key="profile.id"
                :value="profile.id"
              >
                {{ getProfileOptionLabel(profile) }}
              </option>
            </select>
            <p class="text-[11px] text-ui-text-muted/75">
              可选，默认模型不可用时使用
            </p>
          </label>
        </div>
      </section>

      <section
        class="border border-ui-border bg-ui-surface/30 p-3 rounded-sm space-y-3"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-1">
            <h3
              class="text-[12px] font-bold uppercase tracking-tighter text-ui-text-muted/80"
            >
              Cursor
            </h3>
            <p class="text-[12px] text-ui-text-muted leading-relaxed">
              通过已打开的 Cursor 页面发起宿主聊天。
            </p>
            <p class="text-[11px] text-ui-text-muted/80">
              {{
                findCursorWebProfile()
                  ? getCursorWebConnectionLabel()
                  : "未连接 Cursor"
              }}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
            :disabled="Boolean(bindingLoading[CURSOR_WEB_PROFILE_ID])"
            @click="enableCursorWebPreset"
          >
            <Loader2
              v-if="bindingLoading[CURSOR_WEB_PROFILE_ID]"
              class="animate-spin"
              :size="12"
              aria-hidden="true"
            />
            <span>{{
              findCursorWebProfile() ? "重新连接" : "连接 Cursor"
            }}</span>
          </button>
        </div>
        <div
          v-if="cursorHelpPoolState"
          class="border-t border-ui-border pt-2 space-y-2"
        >
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-ui-text-muted font-medium">
              Help 运行池
              <span class="ml-1 tabular-nums">
                {{ poolSummary().readyCount || 0 }}就绪
                /{{ poolSummary().busyCount || 0 }}执行中
                /{{ poolSummary().errorCount || 0 }}异常
              </span>
            </span>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="text-[11px] text-ui-text-muted hover:text-ui-text px-1.5 py-0.5 border border-ui-border rounded-sm"
                :disabled="cursorHelpPoolLoading"
                @click="refreshCursorHelpPool"
                aria-label="刷新运行池状态"
              >
                刷新
              </button>
              <button
                type="button"
                class="text-[11px] text-ui-text-muted hover:text-ui-text px-1.5 py-0.5 border border-ui-border rounded-sm"
                :disabled="cursorHelpPoolLoading"
                @click="rebuildCursorHelpPoolFromUI"
                aria-label="重建运行池"
              >
                <Loader2
                  v-if="cursorHelpPoolLoading"
                  class="animate-spin inline-block"
                  :size="10"
                  aria-hidden="true"
                />
                重建
              </button>
            </div>
          </div>
          <div class="px-1 space-y-1.5 text-[11px] text-ui-text-muted">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                窗口状态
                <span
                  :class="poolWindowStatusColor(poolSummary().windowStatus)"
                  class="ml-1 font-medium"
                >
                  {{ poolWindowStatusLabel(poolSummary().windowStatus) }}
                </span>
              </span>
              <span>模式 {{ String(poolSummary().windowMode || 'none') }}</span>
              <span>允许后台化 {{ poolBooleanLabel(poolSummary().allowBackgrounding) }}</span>
              <span>需重建 {{ poolBooleanLabel(poolSummary().shouldRebuildWindow) }}</span>
              <span>需关注 {{ poolBooleanLabel(poolSummary().requiresAttention) }}</span>
            </div>
            <p class="truncate" :title="String(poolSummary().lastWindowEventReason || '')">
              最近事件：{{ poolWindowEventLabel(poolSummary().lastWindowEvent) }}
              <template v-if="poolSummary().lastWindowEventReason">
                · {{ String(poolSummary().lastWindowEventReason) }}
              </template>
            </p>
            <p class="truncate">
              心跳：{{ String(poolSummary().lastHeartbeatReason || '尚未运行') }}
              <template v-if="poolSummary().lastHeartbeatDelayMs">
                · 下次约 {{ Math.round(Number(poolSummary().lastHeartbeatDelayMs || 0) / 1000) }}s
              </template>
            </p>
            <p
              v-if="String(poolSummary().lastWindowEvent || '') === 'await_manual_rebuild'"
              class="text-amber-500"
            >
              检测到专用窗口已被关闭；当前不会被动自动重建，如需恢复请手动点击“重建”。
            </p>
          </div>
          <div
            v-for="slot in poolSlots()"
            :key="String(slot.slotId || '')"
            class="flex items-center gap-2 text-[11px] px-1"
          >
            <span
              :class="slotStatusColor(slot.status)"
              class="font-medium w-[3.5em] shrink-0"
            >
              {{ slotStatusLabel(slot.status) }}
            </span>
            <span class="text-ui-text-muted/70 truncate">
              {{ slot.lanePreference === 'primary' ? '主' : '辅' }}
              tab={{ slot.tabId }}
              <template v-if="slot.activeLane">
                lane={{ slot.activeLane }}
              </template>
            </span>
            <span
              v-if="slot.lastError"
              class="text-red-400 truncate"
              :title="String(slot.lastError)"
            >
              {{ String(slot.lastError).slice(0, 40) }}
            </span>
          </div>
        </div>
      </section>

      <section
        class="border border-ui-border bg-ui-surface/30 p-3 rounded-sm space-y-3"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="space-y-1">
            <h3
              class="text-[12px] font-bold uppercase tracking-tighter text-ui-text-muted/80"
            >
              已保存的模型
            </h3>
            <p class="text-[12px] text-ui-text-muted">管理可用模型。</p>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            aria-label="新增模型"
            @click="addProfile"
          >
            <Plus :size="14" aria-hidden="true" />
            新增模型
          </button>
        </div>

        <article
          v-for="(profile, index) in config.llmProfiles"
          :key="profile.id || `${index}`"
          class="border border-ui-border rounded-sm p-3 space-y-3 bg-ui-bg"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="space-y-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <h4 class="text-[13px] font-semibold text-ui-text">
                  {{ getProfileTitle(profile, index) }}
                </h4>
                <span
                  v-if="isDefaultProfile(profile)"
                  class="inline-flex items-center rounded-full border border-ui-accent/30 bg-ui-accent/10 px-2 py-0.5 text-[10px] font-semibold text-ui-accent"
                >
                  默认
                </span>
                <span
                  v-if="isAuxProfile(profile)"
                  class="inline-flex items-center rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10px] font-semibold text-sky-500"
                >
                  标题/摘要
                </span>
                <span
                  v-if="isFallbackProfile(profile)"
                  class="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600"
                >
                  备用
                </span>
                <span
                  class="inline-flex items-center rounded-full border border-ui-border bg-ui-surface px-2 py-0.5 text-[10px] text-ui-text-muted"
                >
                  {{ getProviderLabel(profile) }}
                </span>
              </div>
              <p class="text-[11px] text-ui-text-muted leading-relaxed">
                {{ getProfileSummary(profile) }}
              </p>
            </div>
            <button
              type="button"
              class="p-1.5 rounded-sm border border-ui-border hover:bg-ui-surface disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :disabled="config.llmProfiles.length <= 1"
              :aria-label="`删除模型 ${getProfileTitle(profile, index)}`"
              @click="removeProfile(profile.id)"
            >
              <Trash2 :size="14" aria-hidden="true" />
            </button>
          </div>

          <div class="grid grid-cols-1 gap-2">
            <label class="space-y-1 block">
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >模型标识</span
              >
              <input
                v-model="profile.id"
                type="text"
                :readonly="isCursorHelpWebProvider(profile)"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="fast-main"
              />
            </label>

            <label class="space-y-1 block">
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >接入方式</span
              >
              <select
                v-model="profile.provider"
                :disabled="isCursorHelpWebProvider(profile)"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                @change="void handleProviderChange(profile)"
              >
                <option
                  v-for="option in getProviderSelectOptions(profile)"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </select>
            </label>

            <template v-if="isCursorHelpWebProvider(profile)">
              <label class="space-y-1 block">
                <span
                  class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                  >连接状态</span
                >
                <div class="flex items-center gap-2">
                  <div
                    class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] text-ui-text-muted"
                  >
                    {{
                      getCursorHelpConnectionLabel(profile)
                    }}
                  </div>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                    :disabled="bindingLoading[profile.id]"
                    @click="bindCurrentTab(profile)"
                  >
                    <Loader2
                      v-if="bindingLoading[profile.id]"
                      class="animate-spin"
                      :size="12"
                      aria-hidden="true"
                    />
                    <span>重新连接</span>
                  </button>
                </div>
              </label>

              <label class="space-y-1 block">
                <span
                  class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                  >页面中的模型</span
                >
                <div class="flex items-center gap-2">
                  <div
                    class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] text-ui-text-muted"
                  >
                    {{
                      getCursorHelpDetectedModel(profile)
                        ? `当前检测到：${getCursorHelpDetectedModel(profile)}`
                        : runtimeState(profile).lastSenderError
                          ? getCursorHelpConnectionLabel(profile)
                          : "暂未识别，默认跟随当前页面模型"
                    }}
                  </div>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 text-[12px] border border-ui-border rounded-sm hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                    :disabled="bindingLoading[profile.id]"
                    @click="bindCurrentTab(profile)"
                  >
                    <Loader2
                      v-if="bindingLoading[profile.id]"
                      class="animate-spin"
                      :size="12"
                      aria-hidden="true"
                    />
                    <span>刷新状态</span>
                  </button>
                </div>
              </label>

              <label
                v-if="getCursorHelpModelOptions(profile).length > 1"
                class="space-y-1 block"
              >
                <span
                  class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                  >发送时使用</span
                >
                <select
                  v-model="profile.llmModel"
                  class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                >
                  <option value="auto">跟随页面当前模型</option>
                  <option
                    v-for="model in getCursorHelpModelOptions(profile).filter(
                      (item) => item !== 'auto',
                    )"
                    :key="model"
                    :value="model"
                  >
                    {{ model }}
                  </option>
                </select>
              </label>

              <label v-else class="space-y-1 block">
                <span
                  class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                  >发送时使用</span
                >
                <input
                  v-model="profile.llmModel"
                  type="text"
                  class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  placeholder="auto 或具体模型名"
                />
              </label>
            </template>

            <label
              v-if="!isCursorHelpWebProvider(profile)"
              class="space-y-1 block"
            >
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >接口地址</span
              >
              <input
                v-model="profile.llmApiBase"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="https://api.example.com/v1"
              />
            </label>

            <label
              v-if="!isCursorHelpWebProvider(profile)"
              class="space-y-1 block"
            >
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >访问密钥</span
              >
              <div class="relative">
                <input
                  v-model="profile.llmApiKey"
                  :type="showApiKeys[profile.id] ? 'text' : 'password'"
                  autocomplete="off"
                  class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 pr-10 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                />
                <button
                  type="button"
                  class="absolute inset-y-0 right-0 px-2 text-ui-text-muted hover:text-ui-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  :aria-label="
                    showApiKeys[profile.id] ? '隐藏 API Key' : '显示 API Key'
                  "
                  :aria-pressed="Boolean(showApiKeys[profile.id])"
                  @click="toggleApiKey(profile.id)"
                >
                  <EyeOff
                    v-if="showApiKeys[profile.id]"
                    :size="14"
                    aria-hidden="true"
                  />
                  <Eye v-else :size="14" aria-hidden="true" />
                </button>
              </div>
            </label>

            <label
              v-if="!isCursorHelpWebProvider(profile)"
              class="space-y-1 block"
            >
              <span
                class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                >模型</span
              >
              <input
                v-model="profile.llmModel"
                type="text"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="gpt-5.3-codex"
              />
            </label>

            <details
              v-if="!isCursorHelpWebProvider(profile)"
              class="sm:col-span-2 rounded-sm border border-ui-border bg-ui-surface/40 px-3 py-2 group"
            >
              <summary
                class="cursor-pointer list-none flex items-center justify-between gap-2"
              >
                <span
                  class="text-[11px] font-bold uppercase tracking-tighter text-ui-text-muted/80"
                  >高级设置</span
                >
                <span class="text-[11px] text-ui-text-muted group-open:hidden"
                  >展开</span
                >
                <span
                  class="text-[11px] text-ui-text-muted hidden group-open:inline"
                  >收起</span
                >
              </summary>
              <div class="grid grid-cols-1 gap-2 pt-3">
                <label class="space-y-1 block">
                  <span
                    class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                    >请求超时 (ms)</span
                  >
                  <input
                    v-model.number="profile.llmTimeoutMs"
                    type="number"
                    min="1000"
                    step="1000"
                    class="w-full bg-ui-bg border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  />
                </label>

                <label class="space-y-1 block">
                  <span
                    class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                    >失败重试次数</span
                  >
                  <input
                    v-model.number="profile.llmRetryMaxAttempts"
                    type="number"
                    min="0"
                    max="6"
                    class="w-full bg-ui-bg border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  />
                </label>

                <label class="space-y-1 block">
                  <span
                    class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter"
                    >最大重试等待 (ms)</span
                  >
                  <input
                    v-model.number="profile.llmMaxRetryDelayMs"
                    type="number"
                    min="0"
                    step="1000"
                    class="w-full bg-ui-bg border border-ui-border rounded-sm px-2.5 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                  />
                </label>
              </div>
            </details>
          </div>
        </article>
      </section>
    </main>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="visibleError" class="text-[11px] text-red-500 mb-3 px-1">
        {{ visibleError }}
      </p>
      <button
        class="w-full bg-ui-text text-ui-bg py-2.5 rounded-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :disabled="savingConfig"
        @click="handleSave"
      >
        <Loader2 v-if="savingConfig" class="animate-spin" :size="16" />
        {{ savingConfig ? "保存中..." : "保存并生效" }}
      </button>
    </footer>
  </div>
</template>
