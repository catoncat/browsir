<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import { useSkillStore, type SkillMetadata } from "../stores/skill-store";
import { ArrowLeft, Loader2, RefreshCcw, Play, Trash2 } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useSkillStore();

const dialogRef = ref<HTMLElement | null>(null);
const contentScrollRef = ref<HTMLElement | null>(null);
const createSkillButtonRef = ref<HTMLButtonElement | null>(null);
const discoverRootInputRef = ref<HTMLInputElement | null>(null);
const editorSectionRef = ref<HTMLElement | null>(null);
const editorNameInputRef = ref<HTMLInputElement | null>(null);
const editorContentTextareaRef = ref<HTMLTextAreaElement | null>(null);
const skills = ref<SkillMetadata[]>([]);
const loadingSkills = ref(false);
const discovering = ref(false);
const actionSkillId = ref("");
const runningSkillId = ref("");
const writingSkill = ref(false);
const loadingEditorSkillId = ref("");
const pageError = ref("");
const pageStatus = ref("");
const viewMode = ref<"manage" | "edit">("manage");
const editorMode = ref<"create" | "edit">("create");
const editorReadonly = ref(false);
const editorSkillLabel = ref("");
const editorSourceSkillId = ref("");
const editorSkillSource = ref("browser");
const editorSkillEnabled = ref(true);
const showDiscoverPanel = ref(false);
const skillEditButtonRefs = new Map<string, HTMLButtonElement>();

const discoverRootId = "skills-discover-root";
const editorLocationId = "skills-editor-location";
const editorSkillIdId = "skills-editor-id";
const editorSkillNameId = "skills-editor-name";
const editorSkillDescriptionId = "skills-editor-description";
const editorContentId = "skills-editor-content";
const runArgsId = "skills-run-args";

const discoverRoot = ref("mem://skills");
const editorLocation = ref("mem://skills/new-skill/SKILL.md");
const editorSkillId = ref("skill.new");
const editorSkillName = ref("新技能");
const editorSkillDescription = ref("描述这个技能要解决什么问题");
const editorContent = ref("# SKILL\n1. 读取输入\n2. 执行步骤\n3. 输出结果\n");
const runArgs = ref("");

function setPageError(error: unknown) {
  pageStatus.value = "";
  pageError.value = error instanceof Error ? error.message : String(error || "未知错误");
}

function setPageStatus(message: string) {
  pageError.value = "";
  pageStatus.value = String(message || "").trim();
}

function normalizeSkillIdSeed(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensureSkillLocationForId(skillId: string): string {
  const normalizedId = normalizeSkillIdSeed(skillId);
  if (!normalizedId) return "mem://skills/new-skill/SKILL.md";
  return `mem://skills/${normalizedId}/SKILL.md`;
}

function isBuiltinSkill(skill: SkillMetadata): boolean {
  return String(skill.source || "").trim() === "builtin";
}

function resetEditorDraft() {
  editorLocation.value = "mem://skills/new-skill/SKILL.md";
  editorSkillId.value = "skill.new";
  editorSkillName.value = "新技能";
  editorSkillDescription.value = "描述这个技能要解决什么问题";
  editorContent.value = "# SKILL\n1. 读取输入\n2. 执行步骤\n3. 输出结果\n";
  editorSkillSource.value = "browser";
  editorSkillEnabled.value = true;
  editorReadonly.value = false;
}

async function scrollElementIntoView(element: HTMLElement | null, block: ScrollLogicalPosition = "start") {
  await nextTick();
  element?.scrollIntoView({ behavior: "smooth", block });
}

function setSkillEditButtonRef(skillId: string, element: Element | null) {
  if (element instanceof HTMLButtonElement) {
    skillEditButtonRefs.set(skillId, element);
    return;
  }
  skillEditButtonRefs.delete(skillId);
}

async function focusViewTop() {
  await nextTick();
  contentScrollRef.value?.scrollTo({ top: 0, behavior: "smooth" });
}

async function focusManageSurface(skillId = "") {
  await nextTick();
  const targetButton = (skillId ? skillEditButtonRefs.get(skillId) : null) || createSkillButtonRef.value;
  if (targetButton) {
    targetButton.scrollIntoView({ behavior: "smooth", block: "center" });
    targetButton.focus();
    return;
  }
  await focusViewTop();
}

async function focusEditorSurface(target: "name" | "content") {
  await scrollElementIntoView(editorSectionRef.value, "start");
  const targetElement = target === "content"
    ? (editorContentTextareaRef.value || editorNameInputRef.value)
    : (editorNameInputRef.value || editorContentTextareaRef.value);
  targetElement?.focus();
  if (target === "name" && targetElement instanceof HTMLInputElement) {
    targetElement.select();
  }
}

function openCreateMode() {
  resetEditorDraft();
  editorMode.value = "create";
  editorReadonly.value = false;
  editorSkillLabel.value = "";
  editorSourceSkillId.value = "";
  viewMode.value = "edit";
  pageError.value = "";
  pageStatus.value = "";
  void focusEditorSurface("name");
}

function returnToManageView() {
  const focusSkillId = editorMode.value === "edit"
    ? (editorSourceSkillId.value || normalizeSkillIdSeed(editorSkillId.value))
    : "";
  viewMode.value = "manage";
  pageError.value = "";
  void focusManageSurface(focusSkillId);
}

async function openDiscoverPanelAndFocus() {
  showDiscoverPanel.value = true;
  await scrollElementIntoView(discoverRootInputRef.value, "center");
  discoverRootInputRef.value?.focus();
  discoverRootInputRef.value?.select();
}

function toggleDiscoverPanel() {
  if (showDiscoverPanel.value) {
    showDiscoverPanel.value = false;
    return;
  }
  void openDiscoverPanelAndFocus();
}

function composeSkillMarkdown(input: {
  skillId: string;
  skillName: string;
  skillDescription: string;
  body: string;
}): string {
  const skillId = String(input.skillId || "").trim();
  const skillName = String(input.skillName || "").trim();
  const skillDescription = String(input.skillDescription || "").trim();
  const body = String(input.body || "").trim();
  return [
    "---",
    `id: ${skillId}`,
    `name: ${skillName}`,
    `description: ${skillDescription}`,
    "---",
    body || "# SKILL"
  ].join("\n");
}

function parseSkillMarkdown(content: string): {
  skillId: string;
  skillName: string;
  skillDescription: string;
  body: string;
} {
  const text = String(content || "");
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") {
    return {
      skillId: "",
      skillName: "",
      skillDescription: "",
      body: text
    };
  }
  let endLine = -1;
  const map: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    if (line.trim() === "---") {
      endLine = i;
      break;
    }
    const match = /^([a-zA-Z0-9._-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    map[String(match[1] || "").toLowerCase()] = String(match[2] || "").trim().replace(/^['"]|['"]$/g, "");
  }
  if (endLine < 0) {
    return {
      skillId: "",
      skillName: "",
      skillDescription: "",
      body: text
    };
  }
  return {
    skillId: String(map.id || "").trim(),
    skillName: String(map.name || "").trim(),
    skillDescription: String(map.description || "").trim(),
    body: lines.slice(endLine + 1).join("\n").trim()
  };
}

async function refreshSkills() {
  loadingSkills.value = true;
  pageError.value = "";
  try {
    skills.value = await store.listSkills();
  } catch (error) {
    setPageError(error);
  } finally {
    loadingSkills.value = false;
  }
}

async function handleDiscover() {
  const root = String(discoverRoot.value || "").trim() || "mem://skills";
  discovering.value = true;
  pageError.value = "";
  pageStatus.value = "";
  try {
    const result = await store.discoverSkills({
      roots: [{ root, source: "browser" }],
      autoInstall: true,
      replace: true
    });
    await refreshSkills();
    setPageStatus(
      `扫描 ${result.counts.scanned} 个，发现 ${result.counts.discovered} 个，安装 ${result.counts.installed} 个，跳过 ${result.counts.skipped} 个`,
    );
    void focusManageSurface();
  } catch (error) {
    setPageError(error);
  } finally {
    discovering.value = false;
  }
}

function applyEditorFromSkill(skill: SkillMetadata, markdown: string) {
  const parsed = parseSkillMarkdown(markdown);
  editorLocation.value = skill.location;
  editorSkillId.value = parsed.skillId || skill.id;
  editorSkillName.value = parsed.skillName || skill.name || skill.id;
  editorSkillDescription.value = parsed.skillDescription || skill.description || "";
  editorContent.value = parsed.body || markdown || "# SKILL";
  editorSkillSource.value = String(skill.source || "").trim() || "browser";
  editorSkillEnabled.value = skill.enabled !== false;
}

async function handleLoadEditor(skill: SkillMetadata) {
  loadingEditorSkillId.value = skill.id;
  pageError.value = "";
  pageStatus.value = "";
  try {
    const markdown = await store.readVirtualFile(skill.location);
    applyEditorFromSkill(skill, markdown);
    editorMode.value = "edit";
    editorReadonly.value = isBuiltinSkill(skill);
    editorSkillLabel.value = skill.name || skill.id;
    editorSourceSkillId.value = skill.id;
    viewMode.value = "edit";
    setPageStatus(
      editorReadonly.value
        ? "这是内置技能，当前仅供查看；如需定制，请新建自定义技能。"
        : `已载入 ${skill.name || skill.id}，现在可直接编辑`,
    );
    void focusEditorSurface("content");
  } catch (error) {
    setPageError(error);
  } finally {
    loadingEditorSkillId.value = "";
  }
}

async function handleWriteAndInstall() {
  if (editorReadonly.value) {
    pageError.value = "内置技能仅供查看，不能直接改写";
    return;
  }
  const skillId = normalizeSkillIdSeed(editorSkillId.value);
  const skillName = String(editorSkillName.value || "").trim();
  const skillDescription = String(editorSkillDescription.value || "").trim();
  if (!skillId) {
    pageError.value = "skill id 不能为空";
    return;
  }
  if (!skillName) {
    pageError.value = "skill name 不能为空";
    return;
  }
  if (!skillDescription) {
    pageError.value = "skill description 不能为空";
    return;
  }

  let location = String(editorLocation.value || "").trim();
  if (!location) {
    location = ensureSkillLocationForId(skillId);
  }

  writingSkill.value = true;
  pageError.value = "";
  pageStatus.value = "";
  try {
    const markdown = composeSkillMarkdown({
      skillId,
      skillName,
      skillDescription,
      body: editorContent.value
    });
    await store.saveSkill({
      location,
      content: markdown,
      source: editorSkillSource.value || "browser",
      enabled: editorSkillEnabled.value,
    });
    editorLocation.value = location;
    editorMode.value = "edit";
    editorSkillLabel.value = skillName;
    editorSourceSkillId.value = skillId;
    await refreshSkills();
    viewMode.value = "manage";
    setPageStatus(`已保存并安装 ${skillName}`);
    void focusManageSurface(skillId);
  } catch (error) {
    setPageError(error);
  } finally {
    writingSkill.value = false;
  }
}

async function handleToggle(skill: SkillMetadata) {
  actionSkillId.value = skill.id;
  pageError.value = "";
  pageStatus.value = "";
  try {
    if (skill.enabled) {
      await store.disableSkill(skill.id);
    } else {
      await store.enableSkill(skill.id);
    }
    await refreshSkills();
    setPageStatus(`${skill.name || skill.id} 已${skill.enabled ? "禁用" : "启用"}`);
    void focusManageSurface(skill.id);
  } catch (error) {
    setPageError(error);
  } finally {
    actionSkillId.value = "";
  }
}

async function handleUninstall(skill: SkillMetadata) {
  const confirmed = globalThis.confirm(`确认卸载技能 ${skill.name || skill.id} ?`);
  if (!confirmed) return;
  actionSkillId.value = skill.id;
  pageError.value = "";
  pageStatus.value = "";
  try {
    await store.uninstallSkill(skill.id);
    await refreshSkills();
    setPageStatus(`${skill.name || skill.id} 已卸载`);
    void focusManageSurface();
  } catch (error) {
    setPageError(error);
  } finally {
    actionSkillId.value = "";
  }
}

async function handleRun(skill: SkillMetadata) {
  runningSkillId.value = skill.id;
  pageError.value = "";
  pageStatus.value = "";
  try {
    await store.runSkill(skill.id, runArgs.value);
    emit("close");
  } catch (error) {
    setPageError(error);
  } finally {
    runningSkillId.value = "";
  }
}

onMounted(async () => {
  dialogRef.value?.focus();
  await refreshSkills();
});
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="技能管理"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="关闭技能管理"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" />
      </button>
      <div class="ml-2 min-w-0">
        <h2 class="font-bold text-[14px] text-ui-text tracking-tight">技能管理</h2>
        <p v-if="viewMode === 'edit'" class="text-[10px] text-ui-text-muted truncate">
          {{ editorMode === 'create' ? '正在创建新技能' : `正在编辑：${editorSkillLabel || editorSkillName || editorSkillId}` }}
        </p>
      </div>
      <button
        v-if="viewMode === 'edit'"
        class="ml-3 px-2.5 py-1.5 rounded-sm border border-ui-border text-[12px] text-ui-text hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="返回技能管理列表"
        @click="returnToManageView"
      >
        返回管理
      </button>
      <button
        class="ml-auto p-2 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
        :disabled="loadingSkills"
        aria-label="刷新技能列表"
        @click="refreshSkills"
      >
        <RefreshCcw :size="16" :class="loadingSkills ? 'animate-spin' : ''" />
      </button>
    </header>

    <div ref="contentScrollRef" class="flex-1 overflow-y-auto p-4 space-y-6">
      <template v-if="viewMode === 'manage'">
        <section class="space-y-3 rounded-md border border-ui-border bg-ui-surface/20 px-3 py-3">
          <div class="space-y-1">
            <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">技能管理</h3>
            <p class="text-[12px] leading-5 text-ui-text-muted">
              先管理已有技能；需要新建或修改时，再进入编辑界面。
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              ref="createSkillButtonRef"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ui-text text-ui-bg text-[12px] font-semibold hover:opacity-90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              aria-label="新建技能"
              @click="openCreateMode"
            >
              新建技能
            </button>
            <button
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-ui-border bg-ui-bg text-[12px] font-semibold text-ui-text hover:bg-ui-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              :aria-expanded="showDiscoverPanel ? 'true' : 'false'"
              aria-controls="skills-discover-panel"
              @click="toggleDiscoverPanel"
            >
              {{ showDiscoverPanel ? '收起导入面板' : '导入已有技能' }}
            </button>
          </div>
        </section>

        <section class="space-y-3">
          <div class="space-y-1">
            <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">已安装技能 · {{ skills.length }}</h3>
            <p class="text-[11px] text-ui-text-muted">这里填写的参数会附加到下方任一技能的运行命令。</p>
          </div>
          <div class="space-y-1.5">
            <label :for="runArgsId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">运行参数（可选）</label>
            <input
              :id="runArgsId"
              v-model="runArgs"
              type="text"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              placeholder="会附加到下面任一技能的运行命令中"
            />
          </div>
          <div v-if="loadingSkills" class="flex items-center justify-center py-8 text-ui-text-muted text-[12px]">
            <Loader2 :size="16" class="animate-spin mr-2" />
            读取中...
          </div>
          <div v-else-if="skills.length === 0" class="rounded-md border border-ui-border bg-ui-surface/20 px-4 py-4 space-y-3">
            <div class="space-y-1">
              <p class="text-[13px] font-semibold text-ui-text">还没有已安装技能</p>
              <p class="text-[12px] text-ui-text-muted">你可以先创建一个新技能，或从 <code>mem://skills</code> 目录发现并导入已有技能。</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                class="px-3 py-1.5 rounded-md bg-ui-text text-ui-bg text-[12px] font-semibold hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                @click="openCreateMode"
              >
                创建第一个技能
              </button>
              <button
                class="px-3 py-1.5 rounded-md border border-ui-border bg-ui-bg text-[12px] font-semibold hover:bg-ui-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                @click="openDiscoverPanelAndFocus"
              >
                从目录导入已有技能
              </button>
            </div>
          </div>
          <ul v-else class="space-y-2" role="list">
            <li
              v-for="skill in skills"
              :key="skill.id"
              role="listitem"
              class="border border-ui-border rounded-sm bg-ui-surface/50 p-3 space-y-2"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-[13px] font-semibold text-ui-text truncate">{{ skill.name || skill.id }}</p>
                  <p class="text-[11px] text-ui-text-muted truncate">{{ skill.id }}</p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <span
                    v-if="isBuiltinSkill(skill)"
                    class="text-[10px] px-2 py-0.5 rounded-full border border-ui-border bg-ui-bg text-ui-text-muted"
                  >
                    内置
                  </span>
                  <span
                    v-if="!isBuiltinSkill(skill)"
                    class="text-[10px] px-2 py-0.5 rounded-full border"
                    :class="skill.enabled ? 'text-emerald-600 border-emerald-300 bg-emerald-50' : 'text-ui-text-muted border-ui-border bg-ui-bg'"
                  >
                    {{ skill.enabled ? '已启用' : '已禁用' }}
                  </span>
                </div>
              </div>
              <p v-if="skill.description" class="text-[12px] text-ui-text-muted">{{ skill.description }}</p>
              <details class="rounded border border-ui-border/70 bg-ui-bg px-2.5 py-2 text-[11px] text-ui-text-muted">
                <summary class="cursor-pointer select-none font-semibold text-ui-text-muted">查看高级信息</summary>
                <p class="mt-2 break-all">{{ skill.location }}</p>
              </details>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  :ref="(element) => setSkillEditButtonRef(skill.id, element)"
                  class="px-2.5 py-1.5 rounded-sm border border-ui-border text-[12px] hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                  :disabled="loadingEditorSkillId === skill.id"
                  :aria-label="`${isBuiltinSkill(skill) ? '查看' : '编辑'} ${skill.name || skill.id}`"
                  @click="handleLoadEditor(skill)"
                >
                  <Loader2 v-if="loadingEditorSkillId === skill.id" :size="12" class="inline-block animate-spin mr-1" />
                  {{ loadingEditorSkillId === skill.id ? '载入中' : (isBuiltinSkill(skill) ? '查看' : '编辑') }}
                </button>
                <button
                  v-if="!isBuiltinSkill(skill)"
                  class="px-2.5 py-1.5 rounded-sm border border-ui-border text-[12px] hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                  :disabled="actionSkillId === skill.id"
                  :aria-label="skill.enabled ? `禁用 ${skill.name || skill.id}` : `启用 ${skill.name || skill.id}`"
                  @click="handleToggle(skill)"
                >
                  {{ skill.enabled ? '禁用' : '启用' }}
                </button>
                <button
                  class="px-2.5 py-1.5 rounded-sm border border-ui-border text-[12px] hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50 inline-flex items-center gap-1"
                  :disabled="runningSkillId === skill.id || !skill.enabled"
                  :aria-label="skill.enabled ? `运行 ${skill.name || skill.id}` : `${skill.name || skill.id} 已禁用，需先启用`"
                  :title="skill.enabled ? '将该技能发送到当前对话运行' : '请先启用该技能后再运行'"
                  @click="handleRun(skill)"
                >
                  <Play :size="12" aria-hidden="true" />
                  运行
                </button>
                <button
                  v-if="!isBuiltinSkill(skill)"
                  class="ml-auto px-2.5 py-1.5 rounded-sm border border-rose-300 text-rose-600 text-[12px] hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50 inline-flex items-center gap-1"
                  :disabled="actionSkillId === skill.id"
                  :aria-label="`卸载 ${skill.name || skill.id}`"
                  @click="handleUninstall(skill)"
                >
                  <Trash2 :size="12" aria-hidden="true" />
                  卸载
                </button>
              </div>
            </li>
          </ul>
        </section>

        <section
          v-if="showDiscoverPanel"
          id="skills-discover-panel"
          class="space-y-3 rounded-md border border-ui-border bg-ui-surface/20 px-3 py-3"
        >
          <div class="space-y-1">
            <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">发现 / 导入</h3>
            <p class="text-[12px] text-ui-text-muted">从指定目录扫描并安装技能；若存在同 ID 项，会直接用最新内容覆盖。</p>
          </div>
          <div class="space-y-1.5">
            <label :for="discoverRootId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">扫描目录</label>
            <div class="flex items-center gap-2">
              <input
                ref="discoverRootInputRef"
                :id="discoverRootId"
                v-model="discoverRoot"
                type="text"
                class="flex-1 bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="mem://skills"
              />
              <button
                class="shrink-0 px-3 py-2 rounded-sm bg-ui-surface border border-ui-border text-[12px] font-semibold hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                :disabled="discovering"
                aria-label="扫描并导入目录中的技能"
                @click="handleDiscover"
              >
                <Loader2 v-if="discovering" :size="14" class="inline-block animate-spin mr-1" />
                扫描并导入
              </button>
            </div>
          </div>
        </section>
      </template>

      <template v-else>
        <section ref="editorSectionRef" class="space-y-3 rounded-md border border-ui-border bg-ui-surface/20 px-3 py-3">
          <div class="space-y-1">
            <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">
              {{ editorReadonly ? '内置技能' : (editorMode === 'create' ? '新建技能' : '编辑技能') }}
            </h3>
            <p class="text-[12px] text-ui-text-muted">
              {{ editorReadonly
                ? '这是随产品版本提供的内置能力，支持查看，不支持直接改写。'
                : editorMode === 'create'
                ? '先填写基本信息，再补全 SKILL 正文；保存后会自动安装到当前列表。'
                : '修改完成后保存并安装，列表中的同 ID 技能会更新为最新内容。'}}
            </p>
          </div>
          <div
            v-if="editorReadonly"
            class="rounded-md border border-ui-border bg-ui-bg px-3 py-2 text-[12px] leading-5 text-ui-text-muted"
          >
            内置技能会随版本更新。如果你想改成自己的工作流，建议新建一个自定义技能再继续调整。
          </div>
          <div class="grid grid-cols-1 gap-2">
            <div class="space-y-1.5">
              <label :for="editorSkillNameId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">名称</label>
              <input
                ref="editorNameInputRef"
                :id="editorSkillNameId"
                v-model="editorSkillName"
                type="text"
                :disabled="editorReadonly"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </div>
            <div class="space-y-1.5">
              <label :for="editorSkillDescriptionId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">描述</label>
              <input
                :id="editorSkillDescriptionId"
                v-model="editorSkillDescription"
                type="text"
                :disabled="editorReadonly"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </div>
            <div class="space-y-1.5">
              <label :for="editorSkillIdId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">技能 ID</label>
              <input
                :id="editorSkillIdId"
                v-model="editorSkillId"
                type="text"
                :disabled="editorMode === 'edit' || editorReadonly"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </div>
          </div>
          <details class="rounded border border-ui-border bg-ui-bg px-3 py-2">
            <summary class="cursor-pointer select-none text-[12px] font-semibold text-ui-text-muted">高级设置</summary>
            <div class="mt-3 space-y-1.5">
              <label :for="editorLocationId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">文件位置</label>
              <input
                :id="editorLocationId"
                v-model="editorLocation"
                type="text"
                :disabled="editorMode === 'edit' || editorReadonly"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                placeholder="mem://skills/my-skill/SKILL.md"
              />
            </div>
          </details>
          <div class="space-y-1.5">
            <label :for="editorContentId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">SKILL 正文</label>
            <textarea
              ref="editorContentTextareaRef"
              :id="editorContentId"
              v-model="editorContent"
              :readonly="editorReadonly"
              rows="12"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] font-mono leading-5 resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              placeholder="# SKILL
1. 描述输入
2. 描述步骤
3. 描述输出"
            />
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              class="px-3 py-2 rounded-sm border border-ui-border text-[13px] font-semibold hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              aria-label="取消编辑并返回管理"
              @click="returnToManageView"
            >
              {{ editorReadonly ? '返回列表' : '取消' }}
            </button>
            <button
              v-if="!editorReadonly"
              class="px-3 py-2 rounded-sm bg-ui-text text-ui-bg text-[13px] font-semibold hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
              :disabled="writingSkill"
              aria-label="保存到技能目录并安装"
              @click="handleWriteAndInstall"
            >
              <Loader2 v-if="writingSkill" :size="14" class="inline-block animate-spin mr-1" />
              保存并安装
            </button>
          </div>
        </section>
      </template>
    </div>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="pageStatus" role="status" class="text-[11px] text-emerald-600 px-1 mb-1">{{ pageStatus }}</p>
      <p v-if="pageError" role="alert" class="text-[11px] text-red-500 px-1">{{ pageError }}</p>
    </footer>
  </div>
</template>
