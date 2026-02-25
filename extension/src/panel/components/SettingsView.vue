<script setup lang="ts">
import { storeToRefs } from "pinia";
import { ref, onMounted } from "vue";
import { useRuntimeStore } from "../stores/runtime";
import { ShieldCheck, Cpu, Loader2, ArrowLeft, Eye, EyeOff } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useRuntimeStore();
const { config, savingConfig, error } = storeToRefs(store);

const dialogRef = ref<HTMLElement | null>(null);
const apiBaseId = "settings-api-base";
const apiKeyId = "settings-api-key";
const modelNameId = "settings-model-name";
const systemPromptCustomId = "settings-system-prompt-custom";
const maxStepsId = "settings-max-steps";
const autoTitleIntervalId = "settings-auto-title-interval";
const bridgeUrlId = "settings-bridge-url";
const bridgeTokenId = "settings-bridge-token";
const showApiKey = ref(false);
const showBridgeToken = ref(false);

async function handleSave() {
  try {
    await store.saveConfig();
    emit("close");
  } catch {
    // error message is stored in runtime store and rendered in footer.
  }
}

onMounted(() => {
  dialogRef.value?.focus();
});
</script>

<template>
  <div
    ref="dialogRef"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    aria-label="系统设置"
    class="fixed inset-0 z-[60] bg-ui-bg flex flex-col animate-in fade-in duration-200 focus:outline-none"
    @keydown.esc="$emit('close')"
  >
    <header class="h-12 flex items-center px-2 border-b border-ui-border bg-ui-bg shrink-0">
      <button
        class="p-2.5 hover:bg-ui-surface rounded-sm transition-colors text-ui-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        aria-label="关闭设置"
        @click="$emit('close')"
      >
        <ArrowLeft :size="18" />
      </button>
      <h2 class="ml-2 font-bold text-[14px] text-ui-text tracking-tight">系统设置</h2>
    </header>

    <div class="flex-1 overflow-y-auto p-4 space-y-8">
      <section class="space-y-4">
        <div class="flex items-center gap-2 text-ui-text-muted opacity-60">
          <Cpu :size="14" />
          <h3 class="text-[10px] font-bold uppercase tracking-[0.1em]">Engine Configuration</h3>
        </div>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <label :for="apiBaseId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">API Base</label>
            <input
              :id="apiBaseId"
              v-model="config.llmApiBase"
              type="text"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            />
          </div>
          <div class="space-y-1.5">
            <label :for="apiKeyId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">API Key</label>
            <div class="relative">
              <input
                :id="apiKeyId"
                v-model="config.llmApiKey"
                :type="showApiKey ? 'text' : 'password'"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 pr-10 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
              <button
                type="button"
                class="absolute inset-y-0 right-0 px-2.5 text-ui-text-muted hover:text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
                :aria-pressed="showApiKey"
                @click="showApiKey = !showApiKey"
              >
                <EyeOff v-if="showApiKey" :size="15" aria-hidden="true" />
                <Eye v-else :size="15" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div class="space-y-1.5">
            <label :for="modelNameId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">Model Name</label>
            <input
              :id="modelNameId"
              v-model="config.llmModel"
              type="text"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            />
          </div>
          <div class="space-y-1.5">
            <label :for="systemPromptCustomId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">System Prompt（可编辑）</label>
            <textarea
              :id="systemPromptCustomId"
              v-model="config.llmSystemPromptCustom"
              rows="6"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent resize-y"
              placeholder="这里展示当前生效的 System Prompt，可直接编辑"
            />
            <p class="text-[10px] text-ui-text-muted/60 px-0.5">这里展示当前生效的 System Prompt，可直接修改并保存。</p>
          </div>
          <div class="space-y-1.5">
            <label :for="maxStepsId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">Max Steps</label>
            <input
              :id="maxStepsId"
              v-model.number="config.maxSteps"
              type="number"
              min="1"
              max="500"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            />
          </div>
          <div class="space-y-1.5">
            <label :for="autoTitleIntervalId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">Title Auto-Summarize Interval (msgs)</label>
            <input
              :id="autoTitleIntervalId"
              v-model.number="config.autoTitleInterval"
              type="number"
              min="0"
              max="100"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            />
            <p class="text-[10px] text-ui-text-muted/60 px-0.5">每隔多少条消息重刷标题。0 表示禁用自动重总结。</p>
          </div>
        </div>
      </section>

      <section class="space-y-4">
        <div class="flex items-center gap-2 text-ui-text-muted opacity-60">
          <ShieldCheck :size="14" />
          <h3 class="text-[10px] font-bold uppercase tracking-[0.1em]">Bridge Protocol</h3>
        </div>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <label :for="bridgeUrlId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">WebSocket URL</label>
            <input
              :id="bridgeUrlId"
              v-model="config.bridgeUrl"
              type="text"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            />
          </div>
          <div class="space-y-1.5">
            <label :for="bridgeTokenId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">Bridge Token</label>
            <div class="relative">
              <input
                :id="bridgeTokenId"
                v-model="config.bridgeToken"
                :type="showBridgeToken ? 'text' : 'password'"
                autocomplete="off"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 pr-10 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
              <button
                type="button"
                class="absolute inset-y-0 right-0 px-2.5 text-ui-text-muted hover:text-ui-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                :aria-label="showBridgeToken ? '隐藏 Bridge Token' : '显示 Bridge Token'"
                :aria-pressed="showBridgeToken"
                @click="showBridgeToken = !showBridgeToken"
              >
                <EyeOff v-if="showBridgeToken" :size="15" aria-hidden="true" />
                <Eye v-else :size="15" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <footer class="p-4 border-t border-ui-border bg-ui-surface/20">
      <p v-if="error" class="text-[11px] text-red-500 mb-3 px-1">{{ error }}</p>
      <button
        class="w-full bg-ui-text text-ui-bg py-2.5 rounded-sm font-bold flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        :disabled="savingConfig"
        @click="handleSave"
      >
        <Loader2 v-if="savingConfig" class="animate-spin" :size="16" />
        {{ savingConfig ? 'Saving...' : 'Apply & Restart System' }}
      </button>
    </footer>
  </div>
</template>
