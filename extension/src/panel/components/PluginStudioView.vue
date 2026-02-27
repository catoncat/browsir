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
  Radio
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

const loading = ref(false);
const busy = ref(false);
const errorMessage = ref("");
const statusMessage = ref("");

const plugins = ref<PluginMetadata[]>([]);
const projects = ref<StudioProject[]>([]);
const selectedProjectId = ref("");
const selectedPluginId = ref("");
const activeFile = ref<StudioFileName>("plugin.json");

const pluginJsonCode = ref("");
const indexJsCode = ref("");
const uiJsCode = ref("");

const runtimeLogs = ref<RuntimeLogItem[]>([]);
const brainLogs = ref<RuntimeLogItem[]>([]);
const triggerLogs = ref<RuntimeLogItem[]>([]);

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
    const [pluginJson, indexJs, uiJs] = await Promise.all([
      readExtensionFile("plugins/send-success-global-message/plugin.json"),
      readExtensionFile("plugins/send-success-global-message/index.js"),
      readExtensionFile("plugins/send-success-global-message/ui.js")
    ]);
    return [
      {
        id: "example.send-success",
        name: "示例：发送成功通知",
        category: "example",
        pluginId: "plugin.global.message.send-success",
        updatedAt: nowIso(),
        files: {
          pluginJson,
          indexJs,
          uiJs
        }
      },
      fallback
    ];
  } catch {
    return [fallback];
  }
}

function applyEditorFiles(files: StudioFiles): void {
  pluginJsonCode.value = String(files.pluginJson || "");
  indexJsCode.value = String(files.indexJs || "");
  uiJsCode.value = String(files.uiJs || "");
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

function buildInstallPackage(): Record<string, unknown> {
  const pluginJson = parsePluginJson();
  const manifestId = extractManifestId(pluginJson);
  if (!manifestId) {
    throw new Error("plugin.json 缺少 manifest.id");
  }
  return {
    ...pluginJson,
    moduleSource: String(indexJsCode.value || ""),
    uiModuleSource: String(uiJsCode.value || "")
  };
}

function buildCurrentProject(category: "example" | "user"): StudioProject {
  let pluginId = "";
  try {
    pluginId = extractManifestId(parsePluginJson());
  } catch {
    pluginId = "";
  }
  return {
    id: selectedProjectId.value || randomId("project"),
    name: pluginId ? `项目: ${pluginId}` : "未命名项目",
    category,
    pluginId: pluginId || undefined,
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
  writeProjectsToStorage(projects.value.filter((item) => item.category === "user"));
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
    const result = await store.installPlugin(
      {
        package: payload,
        sessionId: String(store.activeSessionId || "").trim() || undefined
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
    const userProject = buildCurrentProject("user");
    if (pluginId) {
      userProject.pluginId = pluginId;
      userProject.name = `项目: ${pluginId}`;
    }
    selectedProjectId.value = userProject.id;
    upsertProject(userProject);
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
      await store.enablePlugin(pluginId);
      statusMessage.value = "插件已启用";
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
    const userProject = buildCurrentProject("user");
    selectedProjectId.value = userProject.id;
    upsertProject(userProject);
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

function handleLoadFromInstalled(plugin: PluginMetadata): void {
  selectedPluginId.value = plugin.id;
  pluginJsonCode.value = buildPluginJsonFromInstalledPlugin(plugin);
  statusMessage.value = `已载入 ${plugin.id} 的 manifest`;
  errorMessage.value = "";
}

function handleExportPackage(): void {
  errorMessage.value = "";
  statusMessage.value = "";
  try {
    const payload = buildInstallPackage();
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
  }
}

function clearLogs(): void {
  runtimeLogs.value = [];
  brainLogs.value = [];
  triggerLogs.value = [];
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
    const userList = readProjectsFromStorage();
    const merged = [...exampleList, ...userList].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
        <div class="editor-toolbar">
          <button
            class="file-tab"
            :class="{ active: activeFile === 'plugin.json' }"
            @click="activeFile = 'plugin.json'"
          >
            <FileJson2 :size="13" />
            plugin.json
          </button>
          <button
            class="file-tab"
            :class="{ active: activeFile === 'index.js' }"
            @click="activeFile = 'index.js'"
          >
            <FileCode2 :size="13" />
            index.js
          </button>
          <button
            class="file-tab"
            :class="{ active: activeFile === 'ui.js' }"
            @click="activeFile = 'ui.js'"
          >
            <Radio :size="13" />
            ui.js
          </button>
        </div>

        <textarea
          v-model="activeEditor"
          class="editor-area"
          :aria-label="`编辑 ${activeFile}`"
          spellcheck="false"
        />
      </section>

      <aside class="studio-right">
        <section class="studio-panel log-panel">
          <p class="panel-title">触发记录</p>
          <ul class="panel-list logs">
            <li v-for="item in triggerLogs" :key="item.id" class="panel-item log-item">
              <p class="item-title">{{ item.title }}</p>
              <p class="item-sub">{{ item.text }}</p>
            </li>
          </ul>
        </section>

        <section class="studio-panel log-panel">
          <p class="panel-title">Runtime 消息</p>
          <ul class="panel-list logs">
            <li v-for="item in runtimeLogs" :key="item.id" class="panel-item log-item">
              <p class="item-title">{{ item.title }}</p>
              <p class="item-sub">{{ item.text }}</p>
            </li>
          </ul>
        </section>

        <section class="studio-panel log-panel">
          <p class="panel-title">Brain 事件</p>
          <ul class="panel-list logs">
            <li v-for="item in brainLogs" :key="item.id" class="panel-item log-item">
              <p class="item-title">{{ item.title }}</p>
              <p class="item-sub">{{ item.text }}</p>
            </li>
          </ul>
        </section>
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

.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #e3dccf;
  background: #fbf7ee;
}

.file-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #d6cdbe;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  background: #fff;
  color: #413b31;
}

.file-tab.active {
  border-color: #7c5cff;
  background: #f2edff;
  color: #3a286f;
}

.editor-area {
  flex: 1;
  min-height: 0;
  resize: none;
  border: 0;
  outline: none;
  padding: 12px;
  font-size: 12px;
  line-height: 1.5;
  font-family: "IBM Plex Mono", "SF Mono", "Menlo", monospace;
  background: #fffdfa;
  color: #1f2937;
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
