<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRuntimeStore, type PluginMetadata } from "../stores/runtime";
import {
  RefreshCcw,
  Plus,
  Save,
  Download,
  Zap,
  Play,
  Pause,
  FileJson2,
  FileCode2,
  Radio,
  Cpu,
  History,
  Terminal,
  Settings,
  Sidebar,
  Layout,
  Activity
} from "lucide-vue-next";

interface StudioFiles {
  pluginJson: string;
  indexJs: string;
  uiJs: string;
}

interface StudioProject {
  id: string;
  name: string;
  category: "example" | "user";
  pluginId?: string;
  updatedAt: string;
  files: StudioFiles;
}

interface RuntimeLogItem {
  id: string;
  ts: string;
  type: string;
  title: string;
  text: string;
}

type StudioFileName = "plugin.json" | "index.js" | "ui.js";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();

const PROJECTS_STORAGE_KEY = "bbl.plugin_studio.projects.v1";
const SELECTED_STORAGE_KEY = "bbl.plugin_studio.selected.v1";
const MAX_LOG_ITEMS = 240;
const BUILTIN_PLUGIN_ID_PREFIX = "runtime.builtin.plugin.";
const EXAMPLE_PLUGIN_ID_PREFIX = "plugin.example.";
const PLUGIN_STUDIO_SESSION_ID = "plugin-studio";

const loading = ref(false);
const busy = ref(false);
const errorMessage = ref("");
const statusMessage = ref("");

const plugins = ref<PluginMetadata[]>([]);
const projects = ref<StudioProject[]>([]);
const selectedProjectId = ref("");
const selectedPluginId = ref("");
const activeFile = ref<StudioFileName>("plugin.json");
const activeLogTab = ref<"runtime" | "brain" | "trigger" | "hook">("trigger");

const pluginJsonCode = ref("");
const indexJsCode = ref("");
const uiJsCode = ref("");

const runtimeLogs = ref<RuntimeLogItem[]>([]);
const brainLogs = ref<RuntimeLogItem[]>([]);
const triggerLogs = ref<RuntimeLogItem[]>([]);
const hookTraceLogs = ref<RuntimeLogItem[]>([]);

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function summarize(value: unknown, max = 180): string {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value ?? "");
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(24, max - 1))}…`;
}

function pushLog(target: RuntimeLogItem[], item: Omit<RuntimeLogItem, "id" | "ts">): void {
  target.unshift({
    id: randomId("log"),
    ts: nowIso(),
    ...item
  });
  if (target.length > MAX_LOG_ITEMS) {
    target.length = MAX_LOG_ITEMS;
  }
}

function defaultPluginJson(): string {
  return JSON.stringify(
    {
      manifest: {
        id: "plugin.user.hello",
        name: "hello-plugin",
        version: "1.0.0",
        permissions: {
          hooks: ["runtime.route.after"],
          runtimeMessages: ["bbloop.global.message"],
          brainEvents: ["plugin.hello"]
        }
      }
    },
    null,
    2
  );
}

function defaultIndexJs(): string {
  return `module.exports = function registerHelloPlugin(pi) {
  pi.on("runtime.route.after", (event) => {
    const routeType = String(event?.type || "").trim();
    if (routeType !== "brain.run.start") return { action: "continue" };

    chrome.runtime.sendMessage({
      type: "bbloop.global.message",
      payload: {
        kind: "success",
        message: "Hello from Plugin Studio",
        source: "plugin.user.hello"
      }
    }).catch(() => {});

    return { action: "continue" };
  });
};`;
}

function defaultUiJs(): string {
  return `module.exports = function registerHelloUiPlugin(ui) {
  ui.on("ui.notice.before_show", (event) => {
    const source = String(event?.source || "").trim();
    if (source !== "plugin.user.hello") return { action: "continue" };
    return {
      action: "patch",
      patch: {
        type: "success",
        durationMs: 2200
      }
    };
  });
};`;
}

function normalizeProject(input: unknown): StudioProject | null {
  const row = toRecord(input);
  const id = String(row.id || "").trim();
  const name = String(row.name || "").trim();
  if (!id || !name) return null;
  const categoryRaw = String(row.category || "").trim().toLowerCase();
  const category: "example" | "user" = categoryRaw === "example" ? "example" : "user";
  const filesRow = toRecord(row.files);
  return {
    id,
    name,
    category,
    pluginId: String(row.pluginId || "").trim() || undefined,
    updatedAt: String(row.updatedAt || "").trim() || nowIso(),
    files: {
      pluginJson: String(filesRow.pluginJson || defaultPluginJson()),
      indexJs: String(filesRow.indexJs || defaultIndexJs()),
      uiJs: String(filesRow.uiJs || defaultUiJs())
    }
  };
}

function readProjectsFromStorage(): StudioProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StudioProject[] = [];
    const dedup = new Set<string>();
    for (const item of parsed) {
      const project = normalizeProject(item);
      if (!project) continue;
      if (dedup.has(project.id)) continue;
      dedup.add(project.id);
      out.push(project);
    }
    return out;
  } catch {
    return [];
  }
}

function writeProjectsToStorage(list: StudioProject[]): void {
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(list));
}

function readSelectedProjectFromStorage(): string {
  return String(localStorage.getItem(SELECTED_STORAGE_KEY) || "").trim();
}

function writeSelectedProjectToStorage(projectId: string): void {
  localStorage.setItem(SELECTED_STORAGE_KEY, String(projectId || "").trim());
}

async function readExtensionFile(path: string): Promise<string> {
  const url = chrome.runtime.getURL(path.replace(/^\//, ""));
  const response = await fetch(url, { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`读取示例文件失败: ${path}`);
  }
  return await response.text();
}

function rewriteExampleManifest(pluginJsonText: string, pluginId: string, name: string): string {
  try {
    const parsed = JSON.parse(String(pluginJsonText || "")) as Record<string, unknown>;
    const manifest = toRecord(parsed.manifest);
    parsed.manifest = {
      ...manifest,
      id: pluginId,
      name
    };
    return JSON.stringify(parsed, null, 2);
  } catch {
    return JSON.stringify(
      {
        manifest: {
          id: pluginId,
          name,
          version: "1.0.0"
        }
      },
      null,
      2
    );
  }
}

function missionHudDogPluginJson(): string {
  return JSON.stringify(
    {
      manifest: {
        id: "plugin.example.ui.mission-hud.dog",
        name: "example-mission-hud-dog",
        version: "1.0.0",
        permissions: {
          hooks: [
            "runtime.route.after",
            "tool.before_call",
            "step.after_execute",
            "agent_end.after"
          ],
          runtimeMessages: ["bbloop.ui.mascot"]
        }
      }
    },
    null,
    2
  );
}

function missionHudDogIndexJs(): string {
  return `const mascotSource = "plugin.ui.mission-hud";
let mascotSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

function toRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function toStringList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    const text = String(item || "").trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function fireRuntimeMessage(payload) {
  try {
    const maybePromise = chrome.runtime.sendMessage(payload);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {}
}

function emitMascot(phase, message, options = {}) {
  mascotSeq += 1;
  const sessionId = String(options.sessionId || "").trim();
  fireRuntimeMessage({
    type: "bbloop.ui.mascot",
    payload: {
      phase,
      message,
      source: mascotSource,
      sessionId,
      durationMs: options.durationMs,
      dedupeKey: \`\${mascotSource}:\${sessionId || "global"}:\${Date.now()}:\${mascotSeq}\`,
      ts: nowIso()
    }
  });
}

function clip(input, max = 48) {
  const text = String(input || "").trim();
  if (!text) return "";
  return text.length > max ? \`\${text.slice(0, max)}…\` : text;
}

function prettyAction(action) {
  const text = String(action || "").trim();
  if (!text) return "步骤";
  return text.replaceAll("_", " ");
}

module.exports = function registerMissionHudDog(pi) {
  pi.on("runtime.route.after", (event) => {
    const routeType = String(event?.type || "").trim();
    if (routeType !== "brain.run.start" && routeType !== "brain.run.stop") {
      return { action: "continue" };
    }
    const routeResult = toRecord(event?.result);
    const routeMessage = toRecord(event?.message);
    if (routeType === "brain.run.start") {
      if (routeResult.ok !== true) return { action: "continue" };
      const prompt = String(routeMessage.prompt || "").trim();
      const skillIds = toStringList(routeMessage.skillIds);
      if (!prompt && skillIds.length === 0) return { action: "continue" };
      const data = toRecord(routeResult.data);
      const sessionId = String(data.sessionId || routeMessage.sessionId || "").trim();
      emitMascot("thinking", "汪！我先闻闻线索，马上开始。", { sessionId, durationMs: 3000 });
    } else {
      const sessionId = String(routeMessage.sessionId || "").trim();
      emitMascot("done", "收到停止指令，我已经停下啦。", { sessionId, durationMs: 2200 });
    }
    return { action: "continue" };
  });

  pi.on("tool.before_call", (event) => {
    const input = toRecord(event?.input);
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) return { action: "continue" };
    emitMascot("tool", \`我去执行：\${prettyAction(String(input.action || ""))}\`, {
      sessionId,
      durationMs: 2200
    });
    return { action: "continue" };
  });

  pi.on("step.after_execute", (event) => {
    const input = toRecord(event?.input);
    const result = toRecord(event?.result);
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) return { action: "continue" };
    if (result.ok !== true) {
      const errorText = clip(String(result.error || ""));
      emitMascot("error", errorText ? \`唔，出错了：\${errorText}\` : "唔，这一步失败了。", {
        sessionId,
        durationMs: 3600
      });
      return { action: "continue" };
    }
    emitMascot("verify", result.verified === true ? "我核对过了，这一步通过。" : "步骤完成，我继续盯着变化。", {
      sessionId,
      durationMs: result.verified === true ? 1800 : 1500
    });
    return { action: "continue" };
  });

  pi.on("agent_end.after", (event) => {
    const input = toRecord(event?.input);
    const decision = toRecord(event?.decision);
    const sessionId = String(decision.sessionId || input.sessionId || "").trim();
    if (!sessionId) return { action: "continue" };
    const action = String(decision.action || "").trim();
    if (action === "retry") {
      emitMascot("thinking", "刚才有点小插曲，我再试一次。", { sessionId, durationMs: 2800 });
      return { action: "continue" };
    }
    if (action !== "done") return { action: "continue" };
    const errorText = clip(String(toRecord(input.error).message || ""));
    if (errorText) {
      emitMascot("error", \`这轮遇到问题：\${errorText}\`, { sessionId, durationMs: 3800 });
      return { action: "continue" };
    }
    emitMascot("done", "任务完成！我摇着尾巴汇报完毕。", { sessionId, durationMs: 2600 });
    return { action: "continue" };
  });
};`;
}

function missionHudDogUiJs(): string {
  return `// mission-hud-dog 主要通过 runtime message 驱动 UI（bbloop.ui.mascot）
// 当前不需要额外 ui hook。你可在这里加自定义渲染逻辑。
module.exports = function registerMissionHudDogUi(_ui) {
  return;
};`;
}

async function loadExampleProjects(): Promise<StudioProject[]> {
  const fallback: StudioProject = {
    id: "example.hello",
    name: "示例：Hello Plugin",
    category: "example",
    pluginId: "plugin.user.hello",
    updatedAt: nowIso(),
    files: {
      pluginJson: defaultPluginJson(),
      indexJs: defaultIndexJs(),
      uiJs: defaultUiJs()
    }
  };
  try {
    const [sendPluginJson, sendIndexJs, sendUiJs, mascotPluginJson, mascotIndexJs, mascotUiJs] = await Promise.all([
      readExtensionFile("plugins/example-send-success-global-message/plugin.json"),
      readExtensionFile("plugins/example-send-success-global-message/index.js"),
      readExtensionFile("plugins/example-send-success-global-message/ui.js"),
      readExtensionFile("plugins/example-mission-hud-dog/plugin.json"),
      readExtensionFile("plugins/example-mission-hud-dog/index.js"),
      readExtensionFile("plugins/example-mission-hud-dog/ui.js")
    ]);
    return [
      {
        id: "example.send-success",
        name: "示例：发送成功通知",
        category: "example",
        pluginId: "plugin.example.notice.send-success-global-message",
        updatedAt: nowIso(),
        files: {
          pluginJson: sendPluginJson,
          indexJs: sendIndexJs,
          uiJs: sendUiJs
        }
      },
      {
        id: "example.mission-hud-dog",
        name: "示例：Mission HUD Dog",
        category: "example",
        pluginId: "plugin.example.ui.mission-hud.dog",
        updatedAt: nowIso(),
        files: {
          pluginJson: mascotPluginJson,
          indexJs: mascotIndexJs,
          uiJs: mascotUiJs
        }
      },
      fallback
    ];
  } catch {
    return [
      {
        id: "example.mission-hud-dog",
        name: "示例：Mission HUD Dog",
        category: "example",
        pluginId: "plugin.example.ui.mission-hud.dog",
        updatedAt: nowIso(),
        files: {
          pluginJson: missionHudDogPluginJson(),
          indexJs: missionHudDogIndexJs(),
          uiJs: missionHudDogUiJs()
        }
      },
      fallback
    ];
  }
}

function applyEditorFiles(files: StudioFiles): void {
  pluginJsonCode.value = String(files.pluginJson || "");
  indexJsCode.value = String(files.indexJs || "");
  uiJsCode.value = String(files.uiJs || "");
}

function getSelectedProject(): StudioProject | null {
  const id = String(selectedProjectId.value || "").trim();
  if (!id) return null;
  return projects.value.find((item) => item.id === id) || null;
}

function selectProject(project: StudioProject): void {
  selectedProjectId.value = project.id;
  if (project.pluginId) {
    selectedPluginId.value = project.pluginId;
  }
  applyEditorFiles(project.files);
  writeSelectedProjectToStorage(project.id);
}

function parsePluginJson(): Record<string, unknown> {
  const source = String(pluginJsonCode.value || "").trim();
  if (!source) throw new Error("plugin.json 不能为空");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`plugin.json 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("plugin.json 必须是 JSON object");
  }
  return parsed as Record<string, unknown>;
}

function extractManifestId(pluginJson: Record<string, unknown>): string {
  const manifest = toRecord(pluginJson.manifest);
  return String(manifest.id || "").trim();
}

function toSafePluginPathSegment(input: string): string {
  const text = String(input || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return text || "plugin";
}

function buildInstallPackage(): Record<string, unknown> {
  const pluginJson = parsePluginJson();
  const manifestId = extractManifestId(pluginJson);
  if (!manifestId) {
    throw new Error("plugin.json 缺少 manifest.id");
  }
  const segment = toSafePluginPathSegment(manifestId);
  const indexJs = String(indexJsCode.value || "");
  const uiJs = String(uiJsCode.value || "");
  const hasIndexJs = indexJs.trim().length > 0;
  const hasUiJs = uiJs.trim().length > 0;
  const modulePath = `mem://plugins/${segment}/index.js`;
  const uiModulePath = `mem://plugins/${segment}/ui.js`;
  return {
    ...pluginJson,
    ...(hasIndexJs
      ? {
          modulePath,
          moduleSessionId: PLUGIN_STUDIO_SESSION_ID,
          indexJs
        }
      : {}),
    ...(hasUiJs
      ? {
          uiModulePath,
          uiModuleSessionId: PLUGIN_STUDIO_SESSION_ID,
          uiJs
        }
      : {})
  };
}

function summarizeValidationForStatus(report: {
  warnings: string[];
  checks: Array<{ name: string; ok: boolean }>;
}): string {
  const failed = report.checks.filter((item) => item.ok !== true).length;
  const warningCount = Array.isArray(report.warnings) ? report.warnings.length : 0;
  if (failed > 0) return `校验失败 ${failed} 项`;
  if (warningCount > 0) return `校验通过（${warningCount} 条提示）`;
  return "校验通过";
}

function summarizeValidationError(report: {
  checks: Array<{ name: string; ok: boolean; error?: string }>;
}): string {
  const failed = report.checks.filter((item) => item.ok !== true);
  if (failed.length === 0) return "插件校验失败";
  return failed
    .slice(0, 4)
    .map((item) => `${item.name}: ${String(item.error || "失败")}`)
    .join(" | ");
}

async function validatePayloadBeforeInstall(payload: Record<string, unknown>): Promise<void> {
  const report = await store.validatePluginPackage({
    package: payload,
    sessionId: PLUGIN_STUDIO_SESSION_ID
  });
  const checkSummary = summarizeValidationForStatus(report);
  pushLog(triggerLogs.value, {
    type: "validation",
    title: report.valid ? "校验通过" : "校验失败",
    text: `${checkSummary} · pluginId=${report.pluginId || "<unknown>"}`
  });
  if (!report.valid) {
    throw new Error(summarizeValidationError(report));
  }
  statusMessage.value = checkSummary;
}

function tryBuildInstallPackageForPlugin(pluginId: string): {
  payload: Record<string, unknown>;
  matched: boolean;
  reason?: string;
} {
  const targetId = String(pluginId || "").trim();
  if (!targetId) {
    return {
      payload: {},
      matched: false,
      reason: "pluginId 为空"
    };
  }
  try {
    const payload = buildInstallPackage();
    const manifestId = extractManifestId(toRecord(payload));
    if (!manifestId) {
      return {
        payload: {},
        matched: false,
        reason: "plugin.json 缺少 manifest.id"
      };
    }
    if (manifestId !== targetId) {
      return {
        payload: {},
        matched: false,
        reason: `编辑区 manifest.id=${manifestId} 与目标插件 ${targetId} 不一致`
      };
    }
    return { payload, matched: true };
  } catch (error) {
    return {
      payload: {},
      matched: false,
      reason: error instanceof Error ? error.message : String(error || "构建插件包失败")
    };
  }
}

function buildCurrentProject(
  options: {
    category?: "example" | "user";
    baseProject?: StudioProject | null;
  } = {}
): StudioProject {
  const baseProject = options.baseProject || null;
  const category = baseProject?.category || options.category || "user";
  let pluginId = "";
  try {
    pluginId = extractManifestId(parsePluginJson());
  } catch {
    pluginId = "";
  }
  const resolvedPluginId = pluginId || baseProject?.pluginId || "";
  const resolvedName = baseProject
    ? baseProject.name
    : (resolvedPluginId ? `项目: ${resolvedPluginId}` : "未命名项目");
  return {
    id: baseProject?.id || selectedProjectId.value || randomId("project"),
    name: resolvedName,
    category,
    pluginId: resolvedPluginId || undefined,
    updatedAt: nowIso(),
    files: {
      pluginJson: String(pluginJsonCode.value || ""),
      indexJs: String(indexJsCode.value || ""),
      uiJs: String(uiJsCode.value || "")
    }
  };
}

function upsertProject(project: StudioProject): void {
  const list = [...projects.value];
  const idx = list.findIndex((item) => item.id === project.id);
  if (idx >= 0) {
    list[idx] = project;
  } else {
    list.push(project);
  }
  projects.value = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  writeProjectsToStorage(projects.value);
}

function syncInstalledSelection(pluginId: string): void {
  if (!pluginId) return;
  selectedPluginId.value = pluginId;
}

function buildPluginJsonFromInstalledPlugin(plugin: PluginMetadata): string {
  const permissions: Record<string, unknown> = {};
  if (plugin.hooks.length > 0) permissions.hooks = plugin.hooks;
  if (plugin.modes.length > 0) permissions.modes = plugin.modes;
  if (plugin.capabilities.length > 0) permissions.capabilities = plugin.capabilities;
  if (plugin.tools.length > 0) permissions.tools = plugin.tools;
  if (plugin.llmProviders.length > 0) permissions.llmProviders = plugin.llmProviders;
  if (plugin.runtimeMessages.length > 0) permissions.runtimeMessages = plugin.runtimeMessages;
  if (plugin.brainEvents.length > 0) permissions.brainEvents = plugin.brainEvents;
  return JSON.stringify(
    {
      manifest: {
        id: plugin.id,
        name: plugin.name || plugin.id,
        version: plugin.version || "1.0.0",
        permissions
      }
    },
    null,
    2
  );
}

async function refreshPlugins(): Promise<void> {
  loading.value = true;
  errorMessage.value = "";
  try {
    const out = await store.listPlugins();
    plugins.value = out.plugins;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error || "刷新插件失败");
  } finally {
    loading.value = false;
  }
}

async function handleInstall(replace: boolean): Promise<void> {
  busy.value = true;
  errorMessage.value = "";
  statusMessage.value = "";
  try {
    const payload = buildInstallPackage();
    await validatePayloadBeforeInstall(payload);
    const result = await store.installPlugin(
      {
        package: payload,
        sessionId: PLUGIN_STUDIO_SESSION_ID
      },
      {
        replace,
        enable: true
      }
    );
    const pluginId = String(result.pluginId || "").trim();
    if (pluginId) {
      syncInstalledSelection(pluginId);
    }
    const baseProject = getSelectedProject();
    const nextProject = buildCurrentProject({
      category: baseProject?.category || "user",
      baseProject
    });
    if (pluginId) {
      nextProject.pluginId = pluginId;
      if (!baseProject || baseProject.category === "user") {
        nextProject.name = `项目: ${pluginId}`;
      }
    }
    selectedProjectId.value = nextProject.id;
    upsertProject(nextProject);
    await refreshPlugins();
    statusMessage.value = replace ? "热更新成功" : "安装成功";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error || "安装失败");
  } finally {
    busy.value = false;
  }
}

async function handleTogglePlugin(enable: boolean): Promise<void> {
  const pluginId = String(selectedPluginId.value || "").trim();
  if (!pluginId) {
    errorMessage.value = "请先在左侧选择一个已安装插件";
    return;
  }
  busy.value = true;
  errorMessage.value = "";
  statusMessage.value = "";
  try {
    if (enable) {
      // “重启插件”语义：优先按编辑区代码 replace 热更新，再启用。
      const fromEditor = tryBuildInstallPackageForPlugin(pluginId);
      if (fromEditor.matched) {
        await validatePayloadBeforeInstall(fromEditor.payload);
        await store.installPlugin(
          {
            package: fromEditor.payload,
            sessionId: PLUGIN_STUDIO_SESSION_ID
          },
          {
            replace: true,
            enable: true
          }
        );
        statusMessage.value = "插件已按当前代码重启";
      } else {
        await store.enablePlugin(pluginId);
        statusMessage.value = fromEditor.reason
          ? `插件已启用（未重载代码：${fromEditor.reason}）`
          : "插件已启用";
      }
    } else {
      await store.disablePlugin(pluginId);
      statusMessage.value = "插件已禁用";
    }
    await refreshPlugins();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error || "插件状态更新失败");
  } finally {
    busy.value = false;
  }
}

function handleSaveProject(): void {
  errorMessage.value = "";
  statusMessage.value = "";
  try {
    const baseProject = getSelectedProject();
    const nextProject = buildCurrentProject({
      category: baseProject?.category || "user",
      baseProject
    });
    selectedProjectId.value = nextProject.id;
    upsertProject(nextProject);
    statusMessage.value = "项目已保存";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error || "保存失败");
  }
}

function handleCreateProject(): void {
  const project: StudioProject = {
    id: randomId("project"),
    name: "新建项目",
    category: "user",
    updatedAt: nowIso(),
    files: {
      pluginJson: defaultPluginJson(),
      indexJs: defaultIndexJs(),
      uiJs: defaultUiJs()
    }
  };
  selectedProjectId.value = project.id;
  upsertProject(project);
  applyEditorFiles(project.files);
  statusMessage.value = "已创建新项目";
  errorMessage.value = "";
}

function findProjectByPluginId(pluginId: string): StudioProject | null {
  const id = String(pluginId || "").trim();
  if (!id) return null;
  return projects.value.find((item) => String(item.pluginId || "").trim() === id) || null;
}

function fallbackIndexJs(pluginId: string): string {
  return `// 当前插件没有可恢复的 index.js 源码快照
// pluginId: ${pluginId}
// 你可以在这里编写后点击“热更新”覆盖当前插件
module.exports = function registerPlugin(_pi) {
  return;
};`;
}

function fallbackUiJs(pluginId: string): string {
  return `// 当前插件没有可恢复的 ui.js 源码快照
// pluginId: ${pluginId}
module.exports = function registerUiPlugin(_ui) {
  return;
};`;
}

function handleLoadFromInstalled(plugin: PluginMetadata): void {
  const pluginId = String(plugin.id || "").trim();
  selectedPluginId.value = pluginId;
  const linkedProject = findProjectByPluginId(pluginId);
  if (linkedProject) {
    selectedProjectId.value = linkedProject.id;
    applyEditorFiles(linkedProject.files);
    writeSelectedProjectToStorage(linkedProject.id);
    statusMessage.value = `已载入 ${plugin.id} 的完整项目代码`;
    errorMessage.value = "";
    return;
  }
  selectedProjectId.value = "";
  pluginJsonCode.value = buildPluginJsonFromInstalledPlugin(plugin);
  indexJsCode.value = fallbackIndexJs(pluginId);
  uiJsCode.value = fallbackUiJs(pluginId);
  statusMessage.value = `已载入 ${plugin.id}（仅 manifest 有快照）`;
  errorMessage.value = "";
}

function handleExportPackage(): void {
  errorMessage.value = "";
  statusMessage.value = "";
  busy.value = true;
  void (async () => {
    try {
    const payload = buildInstallPackage();
    await validatePayloadBeforeInstall(payload);
    const pluginId = extractManifestId(toRecord(payload));
    const fileName = `${pluginId || "plugin"}.package.json`;
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    statusMessage.value = "导出成功";
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error || "导出失败");
    } finally {
      busy.value = false;
    }
  })();
}

function clearLogs(): void {
  runtimeLogs.value = [];
  brainLogs.value = [];
  triggerLogs.value = [];
  hookTraceLogs.value = [];
}

function isBuiltinPlugin(plugin: PluginMetadata): boolean {
  return String(plugin.id || "").trim().startsWith(BUILTIN_PLUGIN_ID_PREFIX);
}

function isExamplePlugin(plugin: PluginMetadata): boolean {
  return String(plugin.id || "").trim().startsWith(EXAMPLE_PLUGIN_ID_PREFIX);
}

const installedBuiltinPlugins = computed(() =>
  plugins.value.filter((item) => isBuiltinPlugin(item))
);

const installedExamplePlugins = computed(() =>
  plugins.value.filter((item) => !isBuiltinPlugin(item) && isExamplePlugin(item))
);

const installedUserPlugins = computed(() =>
  plugins.value.filter((item) => !isBuiltinPlugin(item) && !isExamplePlugin(item))
);

const exampleProjects = computed(() => projects.value.filter((item) => item.category === "example"));
const userProjects = computed(() => projects.value.filter((item) => item.category === "user"));

const activeEditor = computed({
  get(): string {
    if (activeFile.value === "plugin.json") return pluginJsonCode.value;
    if (activeFile.value === "index.js") return indexJsCode.value;
    return uiJsCode.value;
  },
  set(value: string) {
    if (activeFile.value === "plugin.json") pluginJsonCode.value = value;
    else if (activeFile.value === "index.js") indexJsCode.value = value;
    else uiJsCode.value = value;
  }
});

const selectedInstalledPlugin = computed(() =>
  plugins.value.find((item) => item.id === selectedPluginId.value) || null
);

const selectedInstalledPluginEnabled = computed(() => selectedInstalledPlugin.value?.enabled === true);

function handleRuntimeMessage(message: unknown): void {
  const payload = toRecord(message);
  const type = String(payload.type || "").trim() || "unknown";
  pushLog(runtimeLogs.value, {
    type,
    title: type,
    text: summarize(payload)
  });

  if (type === "brain.event") {
    const event = toRecord(payload.event);
    const eventType = String(event.type || "").trim() || "brain.event";
    pushLog(brainLogs.value, {
      type: eventType,
      title: eventType,
      text: summarize(event.payload)
    });
    if (eventType.includes("plugin") || eventType.startsWith("tool.") || eventType.startsWith("step.")) {
      pushLog(triggerLogs.value, {
        type: eventType,
        title: eventType,
        text: summarize(event.payload)
      });
    }
    return;
  }

  if (type === "bbloop.plugin.trace") {
    const trace = toRecord(payload.payload);
    const traceType = String(trace.traceType || "hook").trim();
    const pluginId = String(trace.pluginId || "").trim() || "<plugin>";
    const hook = String(trace.hook || "").trim() || "<hook>";
    const durationMs = Number(trace.durationMs);
    const durationText = Number.isFinite(durationMs) ? `${Math.max(0, Math.floor(durationMs))}ms` : "n/a";
    const textParts = [
      `type=${traceType}`,
      `plugin=${pluginId}`,
      `hook=${hook}`,
      `duration=${durationText}`,
      String(trace.error || "").trim() ? `error=${String(trace.error || "").trim()}` : "",
      String(trace.responsePreview || "").trim() ? `resp=${String(trace.responsePreview || "").trim()}` : ""
    ].filter(Boolean);
    pushLog(hookTraceLogs.value, {
      type,
      title: `${traceType} · ${hook}`,
      text: textParts.join(" · ")
    });
    pushLog(triggerLogs.value, {
      type,
      title: `${traceType} · ${pluginId}`,
      text: textParts.join(" · ")
    });
    return;
  }

  if (
    type.startsWith("brain.plugin.")
    || type.startsWith("bbloop.")
    || type.includes("plugin")
    || type.startsWith("tool.")
    || type.startsWith("step.")
  ) {
    pushLog(triggerLogs.value, {
      type,
      title: type,
      text: summarize(payload.payload ?? payload.event ?? payload)
    });
  }
}

const onRuntimeMessage = (message: unknown) => {
  try {
    handleRuntimeMessage(message);
  } catch {
    // ignore log failure
  }
};

async function bootstrap(): Promise<void> {
  loading.value = true;
  errorMessage.value = "";
  try {
    const [exampleList] = await Promise.all([
      loadExampleProjects(),
      refreshPlugins()
    ]);
    const savedList = readProjectsFromStorage();
    const mergedById = new Map<string, StudioProject>();
    for (const item of exampleList) {
      mergedById.set(item.id, item);
    }
    for (const item of savedList) {
      mergedById.set(item.id, item);
    }
    const merged = Array.from(mergedById.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    projects.value = merged;

    const selectedFromStorage = readSelectedProjectFromStorage();
    const selected =
      merged.find((item) => item.id === selectedFromStorage)
      || merged[0]
      || {
        id: "fallback",
        name: "默认项目",
        category: "user" as const,
        updatedAt: nowIso(),
        files: {
          pluginJson: defaultPluginJson(),
          indexJs: defaultIndexJs(),
          uiJs: defaultUiJs()
        }
      };
    selectProject(selected);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error || "Plugin Studio 初始化失败");
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  void bootstrap();
});

onUnmounted(() => {
  chrome.runtime.onMessage.removeListener(onRuntimeMessage);
});
</script>

<template>
  <div class="plugin-studio-root">
    <header class="studio-header">
      <div class="studio-title-wrap">
        <h1 class="studio-title">Plugin Studio</h1>
        <p class="studio-subtitle">在线编辑 + 一键热更新 + 触发日志</p>
      </div>
      <div class="studio-header-actions">
        <button
          class="studio-btn"
          :disabled="loading || busy"
          @click="refreshPlugins"
        >
          <RefreshCcw :size="14" :class="loading ? 'animate-spin' : ''" />
          刷新
        </button>
        <button class="studio-btn danger" @click="emit('close')">关闭</button>
      </div>
    </header>

    <main class="studio-main">
      <aside class="studio-left">
        <section class="studio-panel">
          <p class="panel-title">示例项目</p>
          <ul class="panel-list">
            <li
              v-for="project in exampleProjects"
              :key="project.id"
              :class="['panel-item', selectedProjectId === project.id ? 'active' : '']"
              @click="selectProject(project)"
            >
              <p class="item-title">{{ project.name }}</p>
              <p class="item-sub">{{ project.pluginId || "未绑定 pluginId" }}</p>
            </li>
          </ul>
        </section>

        <section class="studio-panel">
          <p class="panel-title">用户项目</p>
          <ul class="panel-list">
            <li
              v-for="project in userProjects"
              :key="project.id"
              :class="['panel-item', selectedProjectId === project.id ? 'active' : '']"
              @click="selectProject(project)"
            >
              <p class="item-title">{{ project.name }}</p>
              <p class="item-sub">{{ project.pluginId || "未绑定 pluginId" }}</p>
            </li>
          </ul>
        </section>

        <section class="studio-panel">
          <p class="panel-title">已安装插件（示例）</p>
          <ul class="panel-list">
            <li
              v-for="plugin in installedExamplePlugins"
              :key="plugin.id"
              :class="['panel-item', selectedPluginId === plugin.id ? 'active' : '']"
              @click="handleLoadFromInstalled(plugin)"
            >
              <p class="item-title">{{ plugin.name || plugin.id }}</p>
              <p class="item-sub">{{ plugin.id }}</p>
            </li>
          </ul>
        </section>

        <section class="studio-panel">
          <p class="panel-title">已安装插件（用户）</p>
          <ul class="panel-list">
            <li
              v-for="plugin in installedUserPlugins"
              :key="plugin.id"
              :class="['panel-item', selectedPluginId === plugin.id ? 'active' : '']"
              @click="handleLoadFromInstalled(plugin)"
            >
              <p class="item-title">{{ plugin.name || plugin.id }}</p>
              <p class="item-sub">{{ plugin.id }}</p>
            </li>
          </ul>
        </section>

        <section class="studio-panel">
          <p class="panel-title">已安装插件（内置）</p>
          <ul class="panel-list">
            <li
              v-for="plugin in installedBuiltinPlugins"
              :key="plugin.id"
              class="panel-item builtin"
            >
              <p class="item-title">{{ plugin.name || plugin.id }}</p>
              <p class="item-sub">{{ plugin.id }}</p>
            </li>
          </ul>
        </section>
      </aside>

      <section class="studio-center">
        <div class="editor-header">
          <div class="editor-tabs">
            <button
              class="file-tab"
              :class="{ active: activeFile === 'plugin.json' }"
              @click="activeFile = 'plugin.json'"
            >
              <FileJson2 :size="14" />
              <span>plugin.json</span>
            </button>
            <button
              class="file-tab"
              :class="{ active: activeFile === 'index.js' }"
              @click="activeFile = 'index.js'"
            >
              <FileCode2 :size="14" />
              <span>index.js</span>
            </button>
            <button
              class="file-tab"
              :class="{ active: activeFile === 'ui.js' }"
              @click="activeFile = 'ui.js'"
            >
              <Radio :size="14" />
              <span>ui.js</span>
            </button>
          </div>
          <div class="editor-actions">
             <span class="file-path-hint">{{ activeFile }}</span>
          </div>
        </div>

        <div class="editor-container">
          <textarea
            v-model="activeEditor"
            class="editor-area"
            :aria-label="`编辑 ${activeFile}`"
            spellcheck="false"
            placeholder="在此编写代码..."
          />
        </div>
      </section>

      <aside class="studio-right">
        <div class="log-container">
          <div class="log-header">
            <div class="log-tabs">
              <button :class="['log-tab-btn', activeLogTab === 'trigger' ? 'active' : '']" @click="activeLogTab = 'trigger'">
                <Zap :size="13" /> Triggers
              </button>
              <button :class="['log-tab-btn', activeLogTab === 'hook' ? 'active' : '']" @click="activeLogTab = 'hook'">
                <Activity :size="13" /> Hooks
              </button>
              <button :class="['log-tab-btn', activeLogTab === 'brain' ? 'active' : '']" @click="activeLogTab = 'brain'">
                <Cpu :size="13" /> Brain
              </button>
              <button :class="['log-tab-btn', activeLogTab === 'runtime' ? 'active' : '']" @click="activeLogTab = 'runtime'">
                <Terminal :size="13" /> Runtime
              </button>
            </div>
            <button class="log-clear-btn" title="清空当前日志" @click="clearLogs">
              <History :size="13" />
            </button>
          </div>
          
          <div class="log-content">
            <ul v-if="activeLogTab === 'trigger'" class="log-list">
              <li v-for="item in triggerLogs" :key="item.id" class="log-row">
                <span class="log-time">{{ item.ts.split('T')[1].slice(0, 8) }}</span>
                <span class="log-title">{{ item.title }}</span>
                <p class="log-msg">{{ item.text }}</p>
              </li>
            </ul>
            <ul v-else-if="activeLogTab === 'hook'" class="log-list">
              <li v-for="item in hookTraceLogs" :key="item.id" class="log-row">
                <span class="log-time">{{ item.ts.split('T')[1].slice(0, 8) }}</span>
                <span class="log-title">{{ item.title }}</span>
                <p class="log-msg">{{ item.text }}</p>
              </li>
            </ul>
            <ul v-else-if="activeLogTab === 'brain'" class="log-list">
              <li v-for="item in brainLogs" :key="item.id" class="log-row">
                <span class="log-time">{{ item.ts.split('T')[1].slice(0, 8) }}</span>
                <span class="log-title">{{ item.title }}</span>
                <p class="log-msg">{{ item.text }}</p>
              </li>
            </ul>
            <ul v-else class="log-list">
              <li v-for="item in runtimeLogs" :key="item.id" class="log-row">
                <span class="log-time">{{ item.ts.split('T')[1].slice(0, 8) }}</span>
                <span class="log-title">{{ item.title }}</span>
                <p class="log-msg">{{ item.text }}</p>
              </li>
            </ul>
            <div v-if="((activeLogTab === 'trigger' ? triggerLogs : activeLogTab === 'hook' ? hookTraceLogs : activeLogTab === 'brain' ? brainLogs : runtimeLogs).length === 0)" class="log-empty">
              暂无日志数据
            </div>
          </div>
        </div>
      </aside>
    </main>

    <footer class="studio-footer">
      <div class="footer-actions">
        <button class="studio-btn" :disabled="busy" @click="handleCreateProject">
          <Plus :size="14" />
          新建
        </button>
        <button class="studio-btn" :disabled="busy" @click="handleSaveProject">
          <Save :size="14" />
          保存项目
        </button>
        <button class="studio-btn primary" :disabled="busy" @click="handleInstall(false)">
          <Play :size="14" />
          安装
        </button>
        <button class="studio-btn primary" :disabled="busy" @click="handleInstall(true)">
          <Zap :size="14" />
          热更新
        </button>
        <button class="studio-btn" :disabled="busy || !selectedPluginId" @click="handleTogglePlugin(true)">
          <Play :size="14" />
          启用
        </button>
        <button class="studio-btn" :disabled="busy || !selectedPluginId" @click="handleTogglePlugin(false)">
          <Pause :size="14" />
          禁用
        </button>
        <button class="studio-btn" :disabled="busy" @click="handleExportPackage">
          <Download :size="14" />
          导出
        </button>
        <button class="studio-btn" @click="clearLogs">清空日志</button>
      </div>

      <div class="footer-status">
        <span v-if="selectedInstalledPlugin" class="status-pill">
          当前插件: {{ selectedInstalledPlugin.id }} · {{ selectedInstalledPluginEnabled ? "enabled" : "disabled" }}
        </span>
        <span v-if="statusMessage" class="status-pill success">{{ statusMessage }}</span>
        <span v-if="errorMessage" class="status-pill error">{{ errorMessage }}</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.plugin-studio-root {
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  color: #111827;
  background: linear-gradient(180deg, #f7f4ee 0%, #efe8dc 100%);
}

.studio-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid #d8cfc0;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(6px);
}

.studio-title {
  margin: 0;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.01em;
}

.studio-subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: #60584a;
}

.studio-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.studio-main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr) 360px;
  gap: 12px;
  padding: 12px;
}

.studio-left,
.studio-right {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}

.studio-center {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #d8cfc0;
  border-radius: 10px;
  background: #fdfbf6;
  overflow: hidden;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  height: 40px;
  border-bottom: 1px solid #e3dccf;
  background: #fbf7ee;
}

.editor-tabs {
  display: flex;
  gap: 4px;
  height: 100%;
  align-items: flex-end;
}

.file-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: #6b6254;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  transition: all 0.2s;
}

.file-tab:hover {
  background: rgba(255, 255, 255, 0.5);
}

.file-tab.active {
  background: #fffdfa;
  border-color: #d8cfc0;
  color: #7c5cff;
}

.file-path-hint {
  font-size: 11px;
  color: #a39b8f;
  font-family: monospace;
}

.editor-container {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  background: #fffdfa;
}

.editor-area {
  flex: 1;
  width: 100%;
  height: 100%;
  resize: none;
  border: 0;
  outline: none !important;
  padding: 16px;
  font-size: 13px;
  line-height: 1.6;
  font-family: "JetBrains Mono", "IBM Plex Mono", "SF Mono", monospace;
  background: transparent;
  color: #1f2937;
}

.log-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid #d8cfc0;
  border-radius: 10px;
  background: #fffdfa;
  overflow: hidden;
}

.log-header {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  background: #fbf7ee;
  border-bottom: 1px solid #e3dccf;
}

.log-tabs {
  display: flex;
  gap: 2px;
}

.log-tab-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  color: #8b7d6b;
  border-radius: 4px;
}

.log-tab-btn:hover {
  background: rgba(0, 0, 0, 0.05);
}

.log-tab-btn.active {
  background: #7c5cff;
  color: white;
}

.log-clear-btn {
  padding: 4px;
  color: #8b7d6b;
  border-radius: 4px;
}

.log-clear-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #ef4444;
}

.log-content {
  flex: 1;
  overflow: auto;
  padding: 8px;
  background: #fffdfa;
}

.log-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px dashed #efe8dc;
}

.log-row:last-child {
  border-bottom: 0;
}

.log-time {
  font-size: 10px;
  font-family: monospace;
  color: #a39b8f;
}

.log-title {
  font-size: 11px;
  font-weight: 700;
  color: #4b5563;
}

.log-msg {
  font-size: 11px;
  color: #6b7280;
  line-height: 1.4;
  word-break: break-all;
}

.log-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #a39b8f;
}

.studio-panel {
  border: 1px solid #d8cfc0;
  border-radius: 10px;
  background: #fffaf1;
  padding: 8px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel-title {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #6b6254;
}

.panel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}

.panel-item {
  border: 1px solid #ddd3c2;
  border-radius: 8px;
  background: #fff;
  padding: 8px;
  cursor: pointer;
}

.panel-item.builtin {
  cursor: default;
  opacity: 0.82;
}

.panel-item.active {
  border-color: #7c5cff;
  background: #f3efff;
}

.item-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: #1f2937;
}

.item-sub {
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.35;
  color: #6b7280;
  word-break: break-all;
}

.log-panel {
  flex: 1;
}

.panel-list.logs {
  max-height: 100%;
}

.log-item {
  cursor: default;
}

.studio-footer {
  border-top: 1px solid #d8cfc0;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.6);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.studio-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #ccbfa8;
  border-radius: 8px;
  background: #fffdf8;
  color: #3f372b;
  font-size: 12px;
  font-weight: 700;
}

.studio-btn:disabled {
  opacity: 0.58;
}

.studio-btn.primary {
  border-color: #7c5cff;
  background: #f2edff;
  color: #3a286f;
}

.studio-btn.danger {
  border-color: #d5a7a7;
  background: #fff0f0;
  color: #7f2222;
}

.footer-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #d7cfbf;
  background: #fff;
  color: #5b5345;
  font-size: 11px;
}

.status-pill.success {
  border-color: #9fd8b1;
  background: #f1fff5;
  color: #21653a;
}

.status-pill.error {
  border-color: #efb4b4;
  background: #fff4f4;
  color: #8a2323;
}

@media (max-width: 1320px) {
  .studio-main {
    grid-template-columns: 260px minmax(0, 1fr) 320px;
  }
}

@media (max-width: 1024px) {
  .studio-main {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(380px, 1fr) auto;
  }
}
</style>
