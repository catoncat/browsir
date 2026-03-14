<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRuntimeStore, type PluginMetadata } from "../stores/runtime";
import ShikiCodeEditor from "./ShikiCodeEditor.vue";
import HookReference from "./HookReference.vue";
import { publishDebugLinkToBridge, type DebugExportChannel } from "../utils/debug-link";
import {
  RefreshCcw,
  Plus,
  Save,
  Download,
  Zap,
  Play,
  Pause,
  Trash2,
  FileJson2,
  FileCode2,
  Radio,
  Cpu,
  History,
  Terminal,
  Activity,
  BookOpen,
  ExternalLink,
  Check
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
  channel: "runtime" | "brain" | "trigger" | "hook";
  type: string;
  title: string;
  text: string;
  pluginId?: string;
  hook?: string;
  hasError: boolean;
  tags: string[];
  searchText: string;
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
const LOG_CHANNEL_OPTIONS = ["trigger", "hook", "brain", "runtime"] as const;

const loading = ref(false);
const busy = ref(false);
const errorMessage = ref("");
const statusMessage = ref("");

const plugins = ref<PluginMetadata[]>([]);
const projects = ref<StudioProject[]>([]);
const selectedProjectId = ref("");
const selectedPluginId = ref("");
const activeFile = ref<StudioFileName>("plugin.json");
const rightPanelMode = ref<"logs" | "docs">("docs");
const showBuiltinPlugins = ref(false);
const logScope = ref<"selected" | "all">("selected");
const logKeyword = ref("");
const logErrorsOnly = ref(false);
const selectedLogTags = ref<string[]>([]);
const selectedLogChannels = ref<Array<RuntimeLogItem["channel"]>>([
  ...LOG_CHANNEL_OPTIONS,
]);
const publishingDebugLink = ref(false);
const debugLinkCopied = ref(false);

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

function normalizeLogTag(input: unknown): string {
  return String(input || "").trim();
}

function buildLogSearchText(item: {
  type: string;
  title: string;
  text: string;
  pluginId?: string;
  hook?: string;
  tags?: string[];
}): string {
  return [
    item.type,
    item.title,
    item.text,
    item.pluginId,
    item.hook,
    ...(item.tags || [])
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join("\n");
}

function pushLog(
  target: RuntimeLogItem[],
  item: Omit<RuntimeLogItem, "id" | "ts" | "searchText">,
): void {
  const tags = Array.from(
    new Set((item.tags || []).map((value) => normalizeLogTag(value)).filter(Boolean))
  );
  target.unshift({
    id: randomId("log"),
    ts: nowIso(),
    ...item,
    tags,
    searchText: buildLogSearchText({
      ...item,
      tags,
    }),
  });
  if (target.length > MAX_LOG_ITEMS) {
    target.length = MAX_LOG_ITEMS;
  }
}

function defaultPluginJson(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return JSON.stringify(
    {
      manifest: {
        id: `plugin.user.my-plugin-${suffix}`,
        name: "my-plugin",
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
  const userProjects = list.filter((item) => item.category === "user");
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(userProjects));
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

async function readExampleProjectFiles(
  projectId: string,
  name: string,
  pluginId: string,
  basePath: string
): Promise<StudioProject> {
  try {
    const [pluginJson, indexJs, uiJs] = await Promise.all([
      readExtensionFile(`${basePath}/plugin.json`),
      readExtensionFile(`${basePath}/index.js`),
      readExtensionFile(`${basePath}/ui.js`)
    ]);
    return {
      id: projectId,
      name,
      category: "example",
      pluginId,
      updatedAt: nowIso(),
      files: {
        pluginJson,
        indexJs,
        uiJs
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "读取示例失败");
    throw new Error(`${name} 资源缺失：${message}`);
  }
}

async function loadExampleProjects(): Promise<{ projects: StudioProject[]; warnings: string[] }> {
  const fallback: StudioProject = {
    id: "example.hello",
    name: "示例：Hello Plugin",
    category: "example",
    updatedAt: nowIso(),
    files: {
      pluginJson: defaultPluginJson(),
      indexJs: defaultIndexJs(),
      uiJs: defaultUiJs()
    }
  };
  const projects: StudioProject[] = [fallback];
  const warnings: string[] = [];
  const examples = await Promise.allSettled([
    readExampleProjectFiles(
      "example.send-success",
      "示例：发送成功通知",
      "plugin.example.notice.send-success-global-message",
      "plugins/example-send-success-global-message"
    ),
    readExampleProjectFiles(
      "example.mission-hud-dog",
      "示例：Mission HUD Dog",
      "plugin.example.ui.mission-hud.dog",
      "plugins/example-mission-hud-dog"
    )
  ]);
  for (const result of examples) {
    if (result.status === "fulfilled") {
      projects.unshift(result.value);
      continue;
    }
    warnings.push(result.reason instanceof Error ? result.reason.message : String(result.reason || "读取示例失败"));
  }
  return { projects, warnings };
}

function applyEditorFiles(files: StudioFiles): void {
  pluginJsonCode.value = String(files.pluginJson || "");
  indexJsCode.value = String(files.indexJs || "");
  uiJsCode.value = String(files.uiJs || "");
}

function applyDefaultDraftFiles(): void {
  applyEditorFiles({
    pluginJson: defaultPluginJson(),
    indexJs: defaultIndexJs(),
    uiJs: defaultUiJs()
  });
}

function getSelectedProject(): StudioProject | null {
  const id = String(selectedProjectId.value || "").trim();
  if (!id) return null;
  return projects.value.find((item) => item.id === id) || null;
}

function findInstalledPluginById(pluginId: string): PluginMetadata | null {
  const id = String(pluginId || "").trim();
  if (!id) return null;
  return plugins.value.find((item) => item.id === id) || null;
}

function syncSelectedPluginForProject(project: StudioProject | null): void {
  const pluginId = String(project?.pluginId || "").trim();
  selectedPluginId.value = findInstalledPluginById(pluginId)?.id || "";
}

function syncSelectionAfterPluginRefresh(): void {
  const project = getSelectedProject();
  if (project) {
    syncSelectedPluginForProject(project);
    return;
  }
  if (!selectedPluginId.value) return;
  if (!findInstalledPluginById(selectedPluginId.value)) {
    selectedPluginId.value = "";
  }
}

function selectProject(project: StudioProject): void {
  selectedProjectId.value = project.id;
  syncSelectedPluginForProject(project);
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
    channel: "trigger",
    type: "validation",
    title: report.valid ? "校验通过" : "校验失败",
    text: `${checkSummary} · pluginId=${report.pluginId || "<unknown>"}`,
    pluginId: String(report.pluginId || "").trim() || undefined,
    hasError: report.valid !== true,
    tags: ["validation", String(report.pluginId || "").trim()]
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
    syncSelectionAfterPluginRefresh();
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
  const plugin = selectedInstalledPlugin.value;
  const pluginId = String(plugin?.id || "").trim();
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
  const currentSelectedProjectId = selectedProjectId.value;
  try {
    const baseProject = getSelectedProject();
    const savingExampleProject = baseProject?.category === "example";
    if (savingExampleProject) {
      selectedProjectId.value = "";
    }
    const nextProject = buildCurrentProject({
      category: savingExampleProject ? "user" : (baseProject?.category || "user"),
      baseProject: savingExampleProject ? null : baseProject
    });
    selectedProjectId.value = nextProject.id;
    upsertProject(nextProject);
    statusMessage.value = savingExampleProject ? "已保存为用户项目" : "项目已保存";
  } catch (error) {
    selectedProjectId.value = currentSelectedProjectId;
    errorMessage.value = error instanceof Error ? error.message : String(error || "保存失败");
  }
}

function handleDeleteProject(project: StudioProject): void {
  if (project.category !== "user") return;
  const confirmed = globalThis.confirm(`确认删除项目 ${project.name}？`);
  if (!confirmed) return;
  const nextProjects = projects.value.filter((item) => item.id !== project.id);
  projects.value = nextProjects;
  writeProjectsToStorage(nextProjects);
  errorMessage.value = "";
  statusMessage.value = "项目已删除";
  if (selectedProjectId.value !== project.id) {
    return;
  }
  const nextSelected = nextProjects[0] || null;
  if (nextSelected) {
    selectProject(nextSelected);
    return;
  }
  selectedProjectId.value = "";
  selectedPluginId.value = "";
  writeSelectedProjectToStorage("");
  applyDefaultDraftFiles();
}

async function handleUnregisterPlugin(targetPlugin?: PluginMetadata | null): Promise<void> {
  const plugin = targetPlugin || selectedInstalledPlugin.value;
  if (!plugin) {
    errorMessage.value = "请先选择一个已安装插件";
    return;
  }
  const pluginId = plugin.id;
  if (pluginId.startsWith(BUILTIN_PLUGIN_ID_PREFIX)) {
    errorMessage.value = "内置插件不允许卸载";
    return;
  }
  const confirmed = globalThis.confirm(`确认卸载插件 ${pluginId}？`);
  if (!confirmed) return;
  busy.value = true;
  errorMessage.value = "";
  statusMessage.value = "";
  try {
    await store.unregisterPlugin(pluginId);
    await refreshPlugins();
    if (selectedPluginId.value === pluginId) {
      selectedPluginId.value = "";
    }
    statusMessage.value = `插件 ${plugin.name || plugin.id} 已卸载`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error || "卸载失败");
  } finally {
    busy.value = false;
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

function handleInsertSnippet(snippet: string): void {
  const target = activeFile.value === "plugin.json" ? "plugin.json" : activeFile.value === "ui.js" ? "ui.js" : "index.js";
  if (target === "plugin.json") return;
  if (target === "ui.js") {
    uiJsCode.value = uiJsCode.value ? uiJsCode.value + "\n\n" + snippet : snippet;
    activeFile.value = "ui.js";
  } else {
    indexJsCode.value = indexJsCode.value ? indexJsCode.value + "\n\n" + snippet : snippet;
    activeFile.value = "index.js";
  }
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
  findInstalledPluginById(selectedPluginId.value) || null
);

const selectedInstalledPluginEnabled = computed(() => selectedInstalledPlugin.value?.enabled === true);
const hasSelectedInstalledPlugin = computed(() => Boolean(selectedInstalledPlugin.value));
const logSelectedPluginId = computed(() => {
  if (logScope.value === "all") return "";
  const installedId = String(selectedInstalledPlugin.value?.id || "").trim();
  if (installedId) return installedId;
  const projectId = String(getSelectedProject()?.pluginId || "").trim();
  return projectId;
});

function isLogChannelEnabled(channel: RuntimeLogItem["channel"]): boolean {
  return selectedLogChannels.value.includes(channel);
}

function toggleLogChannel(channel: RuntimeLogItem["channel"]): void {
  if (isLogChannelEnabled(channel)) {
    if (selectedLogChannels.value.length === 1) return;
    selectedLogChannels.value = selectedLogChannels.value.filter((item) => item !== channel);
    return;
  }
  selectedLogChannels.value = [...selectedLogChannels.value, channel];
}

function toggleLogTag(tag: string): void {
  const normalized = normalizeLogTag(tag);
  if (!normalized) return;
  if (selectedLogTags.value.includes(normalized)) {
    selectedLogTags.value = selectedLogTags.value.filter((item) => item !== normalized);
    return;
  }
  selectedLogTags.value = [...selectedLogTags.value, normalized];
}

function clearLogFilters(): void {
  logScope.value = "selected";
  logKeyword.value = "";
  logErrorsOnly.value = false;
  selectedLogTags.value = [];
  selectedLogChannels.value = [...LOG_CHANNEL_OPTIONS];
}

function matchesSelectedPluginLog(item: RuntimeLogItem): boolean {
  const pluginId = String(logSelectedPluginId.value || "").trim();
  if (!pluginId) return true;
  const direct = String(item.pluginId || "").trim();
  if (direct) return direct === pluginId;
  return item.searchText.includes(pluginId.toLowerCase());
}

function matchesLogFilters(item: RuntimeLogItem): boolean {
  if (!isLogChannelEnabled(item.channel)) return false;
  if (!matchesSelectedPluginLog(item)) return false;
  if (logErrorsOnly.value && item.hasError !== true) return false;
  if (selectedLogTags.value.length > 0) {
    const tagSet = new Set(item.tags);
    if (!selectedLogTags.value.every((tag) => tagSet.has(tag))) return false;
  }
  const keyword = String(logKeyword.value || "").trim().toLowerCase();
  if (keyword && !item.searchText.includes(keyword)) return false;
  return true;
}

function filterLogs(list: RuntimeLogItem[], channel: RuntimeLogItem["channel"]): RuntimeLogItem[] {
  return list.filter((item) => item.channel === channel && matchesLogFilters(item));
}

const filteredTriggerLogs = computed(() => filterLogs(triggerLogs.value, "trigger"));
const filteredHookTraceLogs = computed(() => filterLogs(hookTraceLogs.value, "hook"));
const filteredBrainLogs = computed(() => filterLogs(brainLogs.value, "brain"));
const filteredRuntimeLogs = computed(() => filterLogs(runtimeLogs.value, "runtime"));
const filteredLogCount = computed(
  () =>
    filteredTriggerLogs.value.length
    + filteredHookTraceLogs.value.length
    + filteredBrainLogs.value.length
    + filteredRuntimeLogs.value.length
);

const logHotTags = computed(() => {
  const counts = new Map<string, number>();
  const keyword = String(logKeyword.value || "").trim().toLowerCase();
  const all = [
    ...runtimeLogs.value,
    ...brainLogs.value,
    ...triggerLogs.value,
    ...hookTraceLogs.value,
  ];
  for (const item of all) {
    if (!isLogChannelEnabled(item.channel)) continue;
    if (!matchesSelectedPluginLog(item)) continue;
    if (logErrorsOnly.value && item.hasError !== true) continue;
    if (keyword && !item.searchText.includes(keyword)) continue;
    for (const tag of item.tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => {
      const countDiff = b[1] - a[1];
      if (countDiff !== 0) return countDiff;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));
});

function buildStudioLogExportPayload(): Record<string, unknown> {
  return {
    studioSessionId: PLUGIN_STUDIO_SESSION_ID,
    selectedPluginId: String(selectedInstalledPlugin.value?.id || "").trim() || undefined,
    selectedProjectId: String(selectedProjectId.value || "").trim() || undefined,
    filters: {
      scope: logScope.value,
      keyword: String(logKeyword.value || "").trim() || undefined,
      errorsOnly: logErrorsOnly.value,
      tags: [...selectedLogTags.value],
      channels: [...selectedLogChannels.value],
    },
    logs: {
      trigger: filteredTriggerLogs.value,
      hook: filteredHookTraceLogs.value,
      brain: filteredBrainLogs.value,
      runtime: filteredRuntimeLogs.value,
    }
  };
}

function mapStudioChannelsToDebugExportChannels(): DebugExportChannel[] {
  const out = new Set<DebugExportChannel>();
  for (const channel of selectedLogChannels.value) {
    if (channel === "runtime") out.add("pluginRuntimeMessages");
    if (channel === "hook") out.add("pluginHookTrace");
    if (channel === "brain") {
      out.add("routes");
      out.add("internalEvents");
    }
    if (channel === "trigger") {
      out.add("routes");
      out.add("pluginRuntimeMessages");
      out.add("pluginHookTrace");
      out.add("internalEvents");
    }
  }
  return Array.from(out.values());
}

async function readBridgeExportConfig(): Promise<{ bridgeUrl: string; bridgeToken: string }> {
  const response = await chrome.runtime.sendMessage({ type: "config.get" }) as {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: string;
  };
  if (!response?.ok) {
    throw new Error(String(response?.error || "config.get failed"));
  }
  const data = toRecord(response.data);
  return {
    bridgeUrl: String(data.bridgeUrl || "").trim(),
    bridgeToken: String(data.bridgeToken || "").trim(),
  };
}

async function handleCopyDebugLink(): Promise<void> {
  const pluginId = String(logSelectedPluginId.value || "").trim();
  if (!pluginId) {
    errorMessage.value = "请先选择一个插件，再复制调试链接";
    return;
  }
  publishingDebugLink.value = true;
  errorMessage.value = "";
  try {
    const { bridgeUrl, bridgeToken } = await readBridgeExportConfig();
    const { downloadUrl } = await publishDebugLinkToBridge({
      bridgeUrl,
      bridgeToken,
      title: `插件调试 ${pluginId}`,
      target: {
        kind: "plugin",
        sessionId: PLUGIN_STUDIO_SESSION_ID,
        pluginId,
      },
      filters: {
        channels: mapStudioChannelsToDebugExportChannels(),
        eventTypes: selectedLogTags.value,
        text: String(logKeyword.value || "").trim() || undefined,
        errorsOnly: logErrorsOnly.value,
        limit: 80,
      },
      clientPayload: buildStudioLogExportPayload(),
    });
    await navigator.clipboard.writeText(downloadUrl);
    debugLinkCopied.value = true;
    statusMessage.value = "插件调试链接已复制";
    setTimeout(() => {
      debugLinkCopied.value = false;
    }, 1800);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error || "复制调试链接失败");
  } finally {
    publishingDebugLink.value = false;
  }
}

function handleRuntimeMessage(message: unknown): void {
  const payload = toRecord(message);
  const type = String(payload.type || "").trim() || "unknown";
  const payloadRow = toRecord(payload.payload);
  const pluginId =
    String(payload.pluginId || payloadRow.pluginId || "").trim()
    || undefined;
  const hasError =
    String(payload.error || payloadRow.error || "").trim().length > 0
    || type.includes("error")
    || type.includes("failed");
  pushLog(runtimeLogs.value, {
    channel: "runtime",
    type,
    title: type,
    text: summarize(payload),
    pluginId,
    hasError,
    tags: [type, pluginId || ""]
  });

  if (type === "brain.event") {
    const event = toRecord(payload.event);
    const eventType = String(event.type || "").trim() || "brain.event";
    const eventPayload = toRecord(event.payload);
    const eventPluginId =
      String(event.pluginId || eventPayload.pluginId || pluginId || "").trim()
      || undefined;
    pushLog(brainLogs.value, {
      channel: "brain",
      type: eventType,
      title: eventType,
      text: summarize(event.payload),
      pluginId: eventPluginId,
      hasError:
        String(event.error || eventPayload.error || "").trim().length > 0
        || eventType.includes("error")
        || eventType.includes("failed"),
      tags: [eventType, eventPluginId || ""]
    });
    if (eventType.includes("plugin") || eventType.startsWith("tool.") || eventType.startsWith("step.")) {
      pushLog(triggerLogs.value, {
        channel: "trigger",
        type: eventType,
        title: eventType,
        text: summarize(event.payload),
        pluginId: eventPluginId,
        hasError:
          String(event.error || eventPayload.error || "").trim().length > 0
          || eventType.includes("error")
          || eventType.includes("failed"),
        tags: [eventType, eventPluginId || ""]
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
      channel: "hook",
      type,
      title: `${traceType} · ${hook}`,
      text: textParts.join(" · "),
      pluginId,
      hook,
      hasError: String(trace.error || "").trim().length > 0,
      tags: [traceType, hook, pluginId]
    });
    pushLog(triggerLogs.value, {
      channel: "trigger",
      type,
      title: `${traceType} · ${pluginId}`,
      text: textParts.join(" · "),
      pluginId,
      hook,
      hasError: String(trace.error || "").trim().length > 0,
      tags: [traceType, hook, pluginId]
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
      channel: "trigger",
      type,
      title: type,
      text: summarize(payload.payload ?? payload.event ?? payload),
      pluginId,
      hasError,
      tags: [type, pluginId || ""]
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
    const [{ projects: exampleList, warnings }] = await Promise.all([
      loadExampleProjects(),
      refreshPlugins()
    ]);
    const exampleIds = new Set(exampleList.map((item) => item.id));
    const savedList = readProjectsFromStorage().filter(
      (item) =>
        item.category === "user"
        && !exampleIds.has(item.id)
        && !String(item.id || "").trim().startsWith("example.")
    );
    const mergedById = new Map<string, StudioProject>();
    for (const item of exampleList) {
      mergedById.set(item.id, item);
    }
    for (const item of savedList) {
      mergedById.set(item.id, item);
    }
    const merged = Array.from(mergedById.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    projects.value = merged;
    writeProjectsToStorage(merged);
    if (warnings.length > 0) {
      errorMessage.value = warnings.join(" | ");
    }

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
          <div class="panel-header">
            <p class="panel-title">项目</p>
            <button class="panel-action-btn" title="新建项目" :disabled="busy" @click="handleCreateProject">
              <Plus :size="13" />
            </button>
          </div>
          <ul class="panel-list">
            <li
              v-for="project in exampleProjects"
              :key="project.id"
              :class="['panel-item', selectedProjectId === project.id ? 'active' : '']"
              @click="selectProject(project)"
            >
              <div class="panel-item-main">
                <p class="item-title">{{ project.name }}</p>
                <p class="item-sub">{{ project.pluginId || "示例" }}</p>
              </div>
            </li>
            <li
              v-for="project in userProjects"
              :key="project.id"
              :class="['panel-item', selectedProjectId === project.id ? 'active' : '']"
              @click="selectProject(project)"
            >
              <div class="panel-item-main">
                <p class="item-title">{{ project.name }}</p>
                <p class="item-sub">{{ project.pluginId || "未绑定 pluginId" }}</p>
              </div>
              <button
                class="panel-item-icon-btn danger"
                :disabled="busy"
                :aria-label="`删除项目 ${project.name}`"
                title="删除项目"
                @click.stop="handleDeleteProject(project)"
              >
                <Trash2 :size="13" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </section>

        <section class="studio-panel flex-1">
          <p class="panel-title">已安装</p>
          <ul class="panel-list">
            <li
              v-for="plugin in installedExamplePlugins"
              :key="plugin.id"
              :class="['panel-item', selectedPluginId === plugin.id ? 'active' : '']"
              @click="handleLoadFromInstalled(plugin)"
            >
              <div class="panel-item-main">
                <p class="item-title">{{ plugin.name || plugin.id }}</p>
                <p class="item-sub">{{ plugin.id }}</p>
              </div>
              <button
                class="panel-item-icon-btn danger"
                :disabled="busy"
                :aria-label="`卸载插件 ${plugin.name || plugin.id}`"
                title="卸载插件"
                @click.stop="handleUnregisterPlugin(plugin)"
              >
                <Trash2 :size="13" aria-hidden="true" />
              </button>
            </li>
            <li
              v-for="plugin in installedUserPlugins"
              :key="plugin.id"
              :class="['panel-item', selectedPluginId === plugin.id ? 'active' : '']"
              @click="handleLoadFromInstalled(plugin)"
            >
              <div class="panel-item-main">
                <p class="item-title">{{ plugin.name || plugin.id }}</p>
                <p class="item-sub">{{ plugin.id }}</p>
              </div>
              <button
                class="panel-item-icon-btn danger"
                :disabled="busy"
                :aria-label="`卸载插件 ${plugin.name || plugin.id}`"
                title="卸载插件"
                @click.stop="handleUnregisterPlugin(plugin)"
              >
                <Trash2 :size="13" aria-hidden="true" />
              </button>
            </li>
            <li v-if="installedExamplePlugins.length === 0 && installedUserPlugins.length === 0" class="panel-empty">
              暂无已安装插件
            </li>
          </ul>
          <button
            class="builtin-toggle"
            @click="showBuiltinPlugins = !showBuiltinPlugins"
          >
            {{ showBuiltinPlugins ? '隐藏内置' : `显示内置 (${installedBuiltinPlugins.length})` }}
          </button>
          <ul v-if="showBuiltinPlugins" class="panel-list builtin-list">
            <li
              v-for="plugin in installedBuiltinPlugins"
              :key="plugin.id"
              class="panel-item builtin"
            >
              <div class="panel-item-main">
                <p class="item-title">{{ plugin.name || plugin.id }}</p>
                <p class="item-sub">{{ plugin.id }}</p>
              </div>
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
          <ShikiCodeEditor
            :modelValue="activeEditor"
            :language="activeFile === 'plugin.json' ? 'json' : 'javascript'"
            :aria-label="`编辑 ${activeFile}`"
            placeholder="在此编写代码..."
            @update:modelValue="(v: string) => (activeEditor = v)"
          />
        </div>
      </section>

      <aside class="studio-right">
        <div class="right-panel-mode-toggle">
          <button
            :class="['mode-toggle-btn', rightPanelMode === 'docs' ? 'active' : '']"
            @click="rightPanelMode = 'docs'"
            aria-label="Hook 参考文档"
          >
            <BookOpen :size="13" aria-hidden="true" />
            Hook 参考
          </button>
          <button
            :class="['mode-toggle-btn', rightPanelMode === 'logs' ? 'active' : '']"
            @click="rightPanelMode = 'logs'"
            aria-label="运行日志"
          >
            <Terminal :size="13" aria-hidden="true" />
            日志
          </button>
        </div>

        <HookReference
          v-if="rightPanelMode === 'docs'"
          @insert-snippet="handleInsertSnippet"
        />

        <div v-else class="log-sections">
          <div class="log-sections-header">
            <div class="log-sections-header-main">
              <span class="log-sections-title">运行日志</span>
              <span v-if="logSelectedPluginId" class="log-target-pill">
                当前插件 · {{ logSelectedPluginId }}
              </span>
            </div>
            <div class="log-sections-actions">
              <button
                class="log-export-btn"
                :disabled="publishingDebugLink"
                :title="debugLinkCopied ? '链接已复制' : '复制调试链接'"
                @click="handleCopyDebugLink"
              >
                <Check v-if="debugLinkCopied" :size="13" aria-hidden="true" />
                <ExternalLink v-else :size="13" aria-hidden="true" />
              </button>
              <button class="log-clear-btn" title="清空日志" @click="clearLogs">
                <History :size="13" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div class="log-filters">
            <div class="log-filter-row">
              <button
                class="log-chip"
                :class="{ active: logScope === 'selected' }"
                @click="logScope = 'selected'"
              >
                当前插件
              </button>
              <button
                class="log-chip"
                :class="{ active: logScope === 'all' }"
                @click="logScope = 'all'"
              >
                全部插件
              </button>
              <button
                class="log-chip"
                :class="{ active: logErrorsOnly }"
                @click="logErrorsOnly = !logErrorsOnly"
              >
                仅错误
              </button>
              <button class="log-chip subtle" @click="clearLogFilters">
                重置筛选
              </button>
            </div>
            <div class="log-filter-row">
              <input
                v-model="logKeyword"
                class="log-search-input"
                type="text"
                placeholder="按类型、hook、pluginId、文本筛选"
                aria-label="筛选日志关键词"
              />
            </div>
            <div class="log-filter-row channel-row">
              <button
                v-for="channel in LOG_CHANNEL_OPTIONS"
                :key="channel"
                class="log-chip"
                :class="{ active: selectedLogChannels.includes(channel) }"
                @click="toggleLogChannel(channel)"
              >
                {{ channel }}
              </button>
            </div>
            <div v-if="logHotTags.length > 0" class="log-filter-row hot-tags-row">
              <button
                v-for="entry in logHotTags"
                :key="entry.tag"
                class="log-chip"
                :class="{ active: selectedLogTags.includes(entry.tag) }"
                @click="toggleLogTag(entry.tag)"
              >
                {{ entry.tag }} · {{ entry.count }}
              </button>
            </div>
            <div class="log-filter-summary">
              <span>命中 {{ filteredLogCount }} 条</span>
              <span v-if="logScope === 'selected' && !logSelectedPluginId">未选中插件，显示全部</span>
            </div>
          </div>
          <div class="log-sections-body">
            <section class="log-section">
              <h4 class="log-section-heading"><Zap :size="11" aria-hidden="true" /> 触发记录</h4>
              <ul v-if="filteredTriggerLogs.length > 0" class="log-list" role="log" aria-live="polite">
                <li v-for="item in filteredTriggerLogs" :key="item.id" class="log-row">
                  <span class="log-time">{{ (item.ts.split('T')[1] || '').slice(0, 8) }}</span>
                  <span class="log-title">{{ item.title }}</span>
                  <p class="log-msg">{{ item.text }}</p>
                </li>
              </ul>
              <div v-else class="log-empty-inline">暂无</div>
            </section>

            <section class="log-section">
              <h4 class="log-section-heading"><Activity :size="11" aria-hidden="true" /> Hook 时间线</h4>
              <ul v-if="filteredHookTraceLogs.length > 0" class="log-list" role="log" aria-live="polite">
                <li v-for="item in filteredHookTraceLogs" :key="item.id" class="log-row">
                  <span class="log-time">{{ (item.ts.split('T')[1] || '').slice(0, 8) }}</span>
                  <span class="log-title">{{ item.title }}</span>
                  <p class="log-msg">{{ item.text }}</p>
                </li>
              </ul>
              <div v-else class="log-empty-inline">暂无</div>
            </section>

            <section class="log-section">
              <h4 class="log-section-heading"><Cpu :size="11" aria-hidden="true" /> Brain 事件</h4>
              <ul v-if="filteredBrainLogs.length > 0" class="log-list" role="log" aria-live="polite">
                <li v-for="item in filteredBrainLogs" :key="item.id" class="log-row">
                  <span class="log-time">{{ (item.ts.split('T')[1] || '').slice(0, 8) }}</span>
                  <span class="log-title">{{ item.title }}</span>
                  <p class="log-msg">{{ item.text }}</p>
                </li>
              </ul>
              <div v-else class="log-empty-inline">暂无</div>
            </section>

            <section class="log-section">
              <h4 class="log-section-heading"><Terminal :size="11" aria-hidden="true" /> Runtime 消息</h4>
              <ul v-if="filteredRuntimeLogs.length > 0" class="log-list" role="log" aria-live="polite">
                <li v-for="item in filteredRuntimeLogs" :key="item.id" class="log-row">
                  <span class="log-time">{{ (item.ts.split('T')[1] || '').slice(0, 8) }}</span>
                  <span class="log-title">{{ item.title }}</span>
                  <p class="log-msg">{{ item.text }}</p>
                </li>
              </ul>
              <div v-else class="log-empty-inline">暂无</div>
            </section>
          </div>
        </div>
      </aside>
    </main>

    <footer class="studio-footer">
      <div class="footer-actions">
        <div class="action-group">
          <button class="studio-btn" :disabled="busy" @click="handleSaveProject">
            <Save :size="14" />
            保存
          </button>
          <button class="studio-btn primary" :disabled="busy" @click="handleInstall(hasSelectedInstalledPlugin)">
            <Zap :size="14" />
            {{ hasSelectedInstalledPlugin ? '热更新' : '安装' }}
          </button>
          <button
            v-if="hasSelectedInstalledPlugin"
            class="studio-btn"
            :disabled="busy"
            @click="handleTogglePlugin(!selectedInstalledPluginEnabled)"
          >
            <component :is="selectedInstalledPluginEnabled ? Pause : Play" :size="14" />
            {{ selectedInstalledPluginEnabled ? '禁用' : '启用' }}
          </button>
          <button
            v-if="selectedInstalledPlugin && !selectedInstalledPlugin.id.startsWith('runtime.builtin.plugin.')"
            class="studio-btn danger"
            :disabled="busy"
            @click="handleUnregisterPlugin"
          >
            <Trash2 :size="14" />
            卸载
          </button>
        </div>

        <div class="action-group secondary">
          <button class="studio-btn" :disabled="busy" @click="handleExportPackage" title="导出插件包">
            <Download :size="14" />
          </button>
        </div>
      </div>

      <div class="footer-status">
        <span v-if="selectedInstalledPlugin" class="status-pill">
          {{ selectedInstalledPlugin.id }} · {{ selectedInstalledPluginEnabled ? "enabled" : "disabled" }}
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
  color: var(--text);
  background: var(--surface);
}

.studio-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--bg) 60%, transparent);
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
  color: var(--text-muted);
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
  overflow-y: auto;
  overflow-x: hidden;
}

.studio-center {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  overflow: hidden;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  height: 40px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
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
  color: var(--text-muted);
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  transition: all 0.2s;
}

.file-tab:hover {
  background: color-mix(in oklab, var(--bg) 50%, transparent);
}

.file-tab.active {
  background: var(--bg);
  border-color: var(--border);
  color: var(--accent);
}

.file-path-hint {
  font-size: 11px;
  color: var(--text-muted);
  font-family: monospace;
}

.editor-container {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--bg);
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
  color: var(--text);
}

.right-panel-mode-toggle {
  display: flex;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
}

.mode-toggle-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 11px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  font-weight: 500;
}

.mode-toggle-btn.active {
  background: var(--bg);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06);
}

.mode-toggle-btn:hover:not(.active) {
  background: color-mix(in oklab, var(--bg) 50%, transparent);
}

.log-sections {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  overflow: hidden;
}

.log-sections-header {
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.log-sections-header-main,
.log-sections-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.log-sections-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.log-target-pill {
  display: inline-flex;
  align-items: center;
  max-width: 190px;
  padding: 2px 6px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--accent) 12%, var(--bg));
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-export-btn,
.log-clear-btn {
  padding: 4px;
  color: var(--text-muted);
  border-radius: 4px;
}

.log-export-btn:hover:not(:disabled),
.log-clear-btn:hover {
  background: color-mix(in oklab, var(--text) 5%, transparent);
}

.log-export-btn:hover:not(:disabled) {
  color: var(--accent);
}

.log-clear-btn:hover {
  color: #ef4444;
}

.log-export-btn:disabled,
.log-clear-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.log-filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--surface) 70%, transparent);
}

.log-filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.log-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.log-chip.active {
  border-color: color-mix(in oklab, var(--accent) 60%, var(--border));
  background: color-mix(in oklab, var(--accent) 12%, var(--bg));
  color: var(--accent);
}

.log-chip.subtle {
  color: var(--text-muted);
}

.log-search-input {
  width: 100%;
  min-width: 0;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  padding: 0 10px;
  font-size: 12px;
}

.channel-row,
.hot-tags-row {
  gap: 5px;
}

.log-filter-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
}

.log-sections-body {
  flex: 1;
  overflow: auto;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.log-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-section-heading {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 0;
  border-bottom: 1px solid var(--border);
}

.log-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0;
}

.log-time {
  font-size: 10px;
  font-family: monospace;
  color: var(--text-muted);
}

.log-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
}

.log-msg {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
  word-break: break-all;
}

.log-empty-inline {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.5;
  padding: 2px 0;
}

.studio-panel {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  padding: 8px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.studio-panel.flex-1 {
  flex: 1;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 6px;
}

.panel-header .panel-title {
  margin: 0;
}

.panel-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.panel-action-btn:hover {
  background: color-mix(in oklab, var(--accent) 10%, var(--bg));
  color: var(--accent);
  border-color: var(--accent);
}

.panel-action-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.panel-empty {
  padding: 8px;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.6;
  text-align: center;
}

.builtin-toggle {
  margin-top: 4px;
  padding: 4px 8px;
  font-size: 10px;
  color: var(--text-muted);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.builtin-toggle:hover {
  opacity: 1;
}

.builtin-list {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--border);
}

.panel-title {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
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
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  padding: 8px;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.panel-item.builtin {
  cursor: default;
  opacity: 0.82;
}

.panel-item-main {
  min-width: 0;
  flex: 1;
}

.panel-item.active {
  border-color: var(--accent);
  background: color-mix(in oklab, var(--accent) 8%, var(--bg));
}

.panel-item-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
}

.panel-item-icon-btn:hover:not(:disabled) {
  border-color: #d5a7a7;
  background: #fff0f0;
  color: #7f2222;
}

.panel-item-icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.item-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}

.item-sub {
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-muted);
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
  border-top: 1px solid var(--border);
  padding: 10px 12px;
  background: color-mix(in oklab, var(--bg) 60%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.footer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.action-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.action-group.secondary {
  opacity: 0.7;
}

.action-group.secondary:hover {
  opacity: 1;
}

.studio-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-weight: 700;
}

.studio-btn:disabled {
  opacity: 0.58;
}

.studio-btn.primary {
  border-color: var(--accent);
  background: color-mix(in oklab, var(--accent) 8%, var(--bg));
  color: var(--accent);
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
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-muted);
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
