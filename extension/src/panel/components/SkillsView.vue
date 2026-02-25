<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRuntimeStore, type SkillMetadata } from "../stores/runtime";
import { ArrowLeft, Loader2, RefreshCcw, Play, Trash2 } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();

const dialogRef = ref<HTMLElement | null>(null);
const skills = ref<SkillMetadata[]>([]);
const loadingSkills = ref(false);
const discovering = ref(false);
const actionSkillId = ref("");
const runningSkillId = ref("");
const writingSkill = ref(false);
const loadingEditor = ref(false);
const pageError = ref("");

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
const editorSkillName = ref("New Skill");
const editorSkillDescription = ref("describe what this skill does");
const editorContent = ref("# SKILL\n1. 读取输入\n2. 执行步骤\n3. 输出结果\n");
const runArgs = ref("");

function setPageError(error: unknown) {
  pageError.value = error instanceof Error ? error.message : String(error || "未知错误");
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
  try {
    await store.discoverSkills({
      roots: [{ root, source: "browser" }],
      autoInstall: true,
      replace: true
    });
    await refreshSkills();
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
}

async function handleLoadEditor(skill: SkillMetadata) {
  loadingEditor.value = true;
  pageError.value = "";
  try {
    const markdown = await store.readVirtualFile(skill.location);
    applyEditorFromSkill(skill, markdown);
  } catch (error) {
    setPageError(error);
  } finally {
    loadingEditor.value = false;
  }
}

async function handleWriteAndInstall() {
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
  try {
    const markdown = composeSkillMarkdown({
      skillId,
      skillName,
      skillDescription,
      body: editorContent.value
    });
    await store.writeVirtualFile(location, markdown, "overwrite");
    await store.installSkill(
      {
        id: skillId,
        name: skillName,
        description: skillDescription,
        location,
        source: "browser",
        enabled: true
      },
      { replace: true }
    );
    editorLocation.value = location;
    await refreshSkills();
  } catch (error) {
    setPageError(error);
  } finally {
    writingSkill.value = false;
  }
}

async function handleToggle(skill: SkillMetadata) {
  actionSkillId.value = skill.id;
  pageError.value = "";
  try {
    if (skill.enabled) {
      await store.disableSkill(skill.id);
    } else {
      await store.enableSkill(skill.id);
    }
    await refreshSkills();
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
  try {
    await store.uninstallSkill(skill.id);
    await refreshSkills();
  } catch (error) {
    setPageError(error);
  } finally {
    actionSkillId.value = "";
  }
}

async function handleRun(skill: SkillMetadata) {
  runningSkillId.value = skill.id;
  pageError.value = "";
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
    aria-label="Skills 管理"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="关闭 Skills 管理"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" />
      </button>
      <h2 class="ml-2 font-bold text-[14px] text-ui-text tracking-tight">Skills 管理</h2>
      <button
        class="ml-auto p-2 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
        :disabled="loadingSkills"
        aria-label="刷新技能列表"
        @click="refreshSkills"
      >
        <RefreshCcw :size="16" :class="loadingSkills ? 'animate-spin' : ''" />
      </button>
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-6">
      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">Discover</h3>
        <div class="space-y-1.5">
          <label :for="discoverRootId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Virtual Root</label>
          <div class="flex items-center gap-2">
            <input
              :id="discoverRootId"
              v-model="discoverRoot"
              type="text"
              class="flex-1 bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              placeholder="mem://skills"
            />
            <button
              class="shrink-0 px-3 py-2 rounded-sm bg-ui-surface border border-ui-border text-[12px] font-semibold hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
              :disabled="discovering"
              aria-label="扫描并安装虚拟文件系统中的 skills"
              @click="handleDiscover"
            >
              <Loader2 v-if="discovering" :size="14" class="inline-block animate-spin mr-1" />
              扫描并安装
            </button>
          </div>
        </div>
      </section>

      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">Skill 编辑器（写入 VFS）</h3>
        <p class="text-[11px] text-ui-text-muted">
          这里会直接把内容写入浏览器虚拟文件系统（mem:// / vfs://），然后自动安装到技能注册表。
        </p>
        <div class="space-y-1.5">
          <label :for="editorLocationId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Location</label>
          <input
            :id="editorLocationId"
            v-model="editorLocation"
            type="text"
            class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            placeholder="mem://skills/my-skill/SKILL.md"
          />
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div class="space-y-1.5">
            <label :for="editorSkillIdId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Skill ID</label>
            <input
              :id="editorSkillIdId"
              v-model="editorSkillId"
              type="text"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            />
          </div>
          <div class="space-y-1.5">
            <label :for="editorSkillNameId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Name</label>
            <input
              :id="editorSkillNameId"
              v-model="editorSkillName"
              type="text"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            />
          </div>
          <div class="space-y-1.5">
            <label :for="editorSkillDescriptionId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Description</label>
            <input
              :id="editorSkillDescriptionId"
              v-model="editorSkillDescription"
              type="text"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            />
          </div>
        </div>
        <div class="space-y-1.5">
          <label :for="editorContentId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">SKILL Body</label>
          <textarea
            :id="editorContentId"
            v-model="editorContent"
            rows="10"
            class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] font-mono leading-5 resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            placeholder="# SKILL
1. step one
2. step two"
          />
        </div>
        <button
          class="w-full px-3 py-2 rounded-sm bg-ui-text text-ui-bg text-[13px] font-semibold hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
          :disabled="writingSkill"
          aria-label="写入虚拟文件并安装 skill"
          @click="handleWriteAndInstall"
        >
          <Loader2 v-if="writingSkill" :size="14" class="inline-block animate-spin mr-1" />
          写入并安装
        </button>
      </section>

      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">Run</h3>
        <div class="space-y-1.5">
          <label :for="runArgsId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">Skill Args（可选）</label>
          <input
            :id="runArgsId"
            v-model="runArgs"
            type="text"
            class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            placeholder="运行时附加参数"
          />
        </div>
      </section>

      <section class="space-y-3">
        <h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-ui-text-muted">Installed Skills</h3>
        <div v-if="loadingSkills" class="flex items-center justify-center py-8 text-ui-text-muted text-[12px]">
          <Loader2 :size="16" class="animate-spin mr-2" />
          读取中...
        </div>
        <p v-else-if="skills.length === 0" class="text-[12px] text-ui-text-muted">暂无已安装 skills。</p>
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
              <span
                class="text-[10px] px-2 py-0.5 rounded-full border"
                :class="skill.enabled ? 'text-emerald-600 border-emerald-300 bg-emerald-50' : 'text-ui-text-muted border-ui-border bg-ui-bg'"
              >
                {{ skill.enabled ? 'enabled' : 'disabled' }}
              </span>
            </div>
            <p v-if="skill.description" class="text-[12px] text-ui-text-muted">{{ skill.description }}</p>
            <p class="text-[11px] text-ui-text-muted break-all">{{ skill.location }}</p>
            <div class="flex items-center gap-2">
              <button
                class="px-2.5 py-1.5 rounded-sm border border-ui-border text-[12px] hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                :disabled="loadingEditor"
                :aria-label="`加载 ${skill.name || skill.id} 到编辑器`"
                @click="handleLoadEditor(skill)"
              >
                加载编辑
              </button>
              <button
                class="px-2.5 py-1.5 rounded-sm border border-ui-border text-[12px] hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50"
                :disabled="actionSkillId === skill.id"
                :aria-label="skill.enabled ? `禁用 ${skill.name || skill.id}` : `启用 ${skill.name || skill.id}`"
                @click="handleToggle(skill)"
              >
                {{ skill.enabled ? "禁用" : "启用" }}
              </button>
              <button
                class="px-2.5 py-1.5 rounded-sm border border-ui-border text-[12px] hover:bg-ui-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent disabled:opacity-50 inline-flex items-center gap-1"
                :disabled="runningSkillId === skill.id"
                :aria-label="`运行 ${skill.name || skill.id}`"
                @click="handleRun(skill)"
              >
                <Play :size="12" aria-hidden="true" />
                运行
              </button>
              <button
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
    </div>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="pageError" role="alert" class="text-[11px] text-red-500 px-1">{{ pageError }}</p>
    </footer>
  </div>
</template>
