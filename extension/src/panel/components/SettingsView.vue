<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, watch } from "vue";
import QRCode from "qrcode";
import { useConfigStore } from "../stores/config-store";
import { useWechatStore } from "../stores/wechat-store";
import { ShieldCheck, Cpu, Loader2, ArrowLeft, Eye, EyeOff } from "lucide-vue-next";

const emit = defineEmits(["close"]);
const store = useConfigStore();
const { config, savingConfig, error } = storeToRefs(store);
const wechatStore = useWechatStore();
const { state: wechatState, loading: wechatLoading, error: wechatError } =
  storeToRefs(wechatStore);

const dialogRef = ref<HTMLElement | null>(null);
const systemPromptCustomId = "settings-system-prompt-custom";
const maxStepsId = "settings-max-steps";
const autoTitleIntervalId = "settings-auto-title-interval";
const browserRuntimeStrategyId = "settings-browser-runtime-strategy";
const compactionEnabledId = "settings-compaction-enabled";
const compactionContextWindowId = "settings-compaction-context-window";
const compactionReserveId = "settings-compaction-reserve";
const compactionKeepRecentId = "settings-compaction-keep-recent";
const bridgeUrlId = "settings-bridge-url";
const bridgeTokenId = "settings-bridge-token";
const showBridgeToken = ref(false);
const wechatQrDataUrl = ref("");
const wechatQrRenderError = ref("");
const wechatLogin = computed(() => wechatState.value.login);

const wechatPrimaryActionLabel = computed(() => {
  if (!wechatState.value.enabled) return "启用微信通道";
  if (wechatState.value.login.status === "pending") return "刷新二维码";
  if (wechatState.value.login.status === "logged_in") return "重新登录";
  if (wechatState.value.login.status === "error") return "重新登录";
  return "开始登录";
});

const wechatSecondaryActionLabel = computed(() => {
  if (!wechatState.value.enabled) return "";
  if (wechatState.value.login.status === "logged_in") return "退出登录";
  return "停用通道";
});

async function handleWechatPrimaryAction() {
  if (!wechatState.value.enabled) {
    await wechatStore.enable();
    return;
  }
  await wechatStore.startLogin();
}

async function handleWechatSecondaryAction() {
  if (!wechatState.value.enabled) return;
  if (wechatState.value.login.status === "logged_in") {
    await wechatStore.logout();
    return;
  }
  await wechatStore.disable();
}

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
  void wechatStore.refresh();
});

watch(
  () => wechatState.value.login.qrImageUrl,
  async (value) => {
    const payload = String(value || "").trim();
    wechatQrDataUrl.value = "";
    wechatQrRenderError.value = "";
    if (!payload) return;
    try {
      wechatQrDataUrl.value = await QRCode.toDataURL(payload, {
        width: 288,
        margin: 1,
      });
    } catch (error) {
      wechatQrRenderError.value =
        error instanceof Error ? error.message : String(error);
    }
  },
  { immediate: true },
);
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
          <h3 class="text-[10px] font-bold uppercase tracking-[0.1em]">运行策略</h3>
        </div>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <label :for="systemPromptCustomId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">系统提示词</label>
            <textarea
              :id="systemPromptCustomId"
              v-model="config.llmSystemPromptCustom"
              rows="6"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent resize-y"
              placeholder="这里展示当前生效的系统提示词，可直接编辑"
            />
            <p class="text-[10px] text-ui-text-muted/60 px-0.5">这里展示当前生效的系统提示词，可直接修改并保存。</p>
          </div>
          <div class="space-y-1.5">
            <label :for="maxStepsId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">单次最大步数</label>
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
            <label :for="autoTitleIntervalId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">标题自动刷新间隔（消息数）</label>
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
          <div class="space-y-1.5">
            <label :for="browserRuntimeStrategyId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">默认执行位置</label>
            <select
              :id="browserRuntimeStrategyId"
              v-model="config.browserRuntimeStrategy"
              class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              <option value="browser-first">browser-first（默认走浏览器沙箱）</option>
              <option value="host-first">host-first（默认走本地 bridge）</option>
            </select>
            <p class="text-[10px] text-ui-text-muted/60 px-0.5">仅影响 browser_* 工具未显式指定 runtime 时的默认路由。</p>
          </div>
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-3 rounded-sm border border-ui-border bg-ui-surface px-3 py-2.5">
              <div class="space-y-0.5">
                <label :for="compactionEnabledId" class="block text-[11px] font-bold text-ui-text-muted/80 uppercase tracking-tighter">上下文压缩</label>
                <p class="text-[10px] text-ui-text-muted/60">控制长对话的上下文压缩。</p>
              </div>
              <input
                :id="compactionEnabledId"
                v-model="config.compaction.enabled"
                type="checkbox"
                class="h-4 w-4 rounded border-ui-border bg-ui-bg text-ui-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </div>
            <div class="space-y-1.5">
              <label :for="compactionContextWindowId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">上下文窗口 Token</label>
              <input
                :id="compactionContextWindowId"
                v-model.number="config.compaction.contextWindowTokens"
                type="number"
                min="1"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </div>
            <div class="space-y-1.5">
              <label :for="compactionReserveId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">预留 Token</label>
              <input
                :id="compactionReserveId"
                v-model.number="config.compaction.reserveTokens"
                type="number"
                min="1"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
            </div>
            <div class="space-y-1.5">
              <label :for="compactionKeepRecentId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">保留最近 Token</label>
              <input
                :id="compactionKeepRecentId"
                v-model.number="config.compaction.keepRecentTokens"
                type="number"
                min="1"
                class="w-full bg-ui-surface border border-ui-border rounded-sm px-3 py-2 text-[13px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
              />
              <p class="text-[10px] text-ui-text-muted/60 px-0.5">保留最近工作区间，其余部分合并进摘要。</p>
            </div>
          </div>
        </div>
      </section>

      <section class="space-y-4">
        <div class="flex items-center gap-2 text-ui-text-muted opacity-60">
          <ShieldCheck :size="14" />
          <h3 class="text-[10px] font-bold uppercase tracking-[0.1em]">微信通道</h3>
        </div>
        <div class="space-y-3 rounded-sm border border-ui-border bg-ui-surface px-3 py-3">
          <div class="flex items-center justify-between gap-3">
            <div class="space-y-0.5 min-w-0">
              <p class="text-[13px] font-semibold text-ui-text">通道状态</p>
              <p class="text-[11px] text-ui-text-muted truncate">
                {{
                  !wechatState.enabled
                    ? '已停用'
                    : wechatLogin.status === 'pending'
                      ? '正在等待微信登录完成'
                      : wechatLogin.status === 'logged_in'
                        ? '已登录'
                        : wechatLogin.status === 'error'
                          ? '登录异常'
                          : '未登录'
                }}
              </p>
            </div>
            <span
              class="inline-flex shrink-0 items-center rounded-full px-2 py-1 text-[10px] font-semibold"
              :class="
                !wechatState.enabled
                  ? 'bg-ui-bg text-ui-text-muted'
                  : wechatLogin.status === 'logged_in'
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : wechatLogin.status === 'pending'
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : wechatLogin.status === 'error'
                      ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                      : 'bg-ui-bg text-ui-text-muted'
              "
            >
              {{ wechatState.enabled ? wechatLogin.status : 'disabled' }}
            </span>
          </div>
          <p class="text-[10px] text-ui-text-muted/70">
            当前 host epoch：{{ wechatState.hostEpoch || '未初始化' }}
          </p>
          <p v-if="wechatError" class="text-[10px] text-rose-500">{{ wechatError }}</p>
          <p
            v-else-if="wechatLogin.lastError"
            class="text-[10px] text-rose-500"
          >
            {{ wechatLogin.lastError }}
          </p>
          <div
            v-if="wechatLogin.status === 'pending' && wechatLogin.qrImageUrl"
            class="flex flex-col items-center gap-2 rounded-sm border border-ui-border bg-ui-bg/60 px-3 py-3"
          >
            <img
              v-if="wechatQrDataUrl"
              :src="wechatQrDataUrl"
              alt="微信登录二维码"
              class="h-36 w-36 rounded-sm border border-ui-border bg-white object-contain"
            />
            <div
              v-else
              class="flex h-36 w-36 items-center justify-center rounded-sm border border-ui-border bg-white px-3 text-center text-[11px] text-ui-text-muted"
            >
              正在生成二维码…
            </div>
            <p class="text-[10px] text-ui-text-muted/70">
              使用微信扫码完成登录
            </p>
            <p
              v-if="wechatQrRenderError"
              class="max-w-[18rem] break-all text-[10px] text-rose-500"
            >
              二维码生成失败：{{ wechatQrRenderError }}
            </p>
            <p class="max-w-[18rem] break-all text-[10px] text-ui-text-muted/60">
              {{ wechatState.login.qrImageUrl }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-sm bg-ui-text px-3 py-2 text-[12px] font-semibold text-ui-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              :disabled="wechatLoading"
              @click="handleWechatPrimaryAction"
            >
              {{ wechatLoading ? '处理中...' : wechatPrimaryActionLabel }}
            </button>
            <button
              v-if="wechatSecondaryActionLabel"
              type="button"
              class="rounded-sm border border-ui-border bg-ui-bg px-3 py-2 text-[12px] font-semibold text-ui-text transition-colors hover:bg-ui-surface disabled:opacity-50"
              :disabled="wechatLoading"
              @click="handleWechatSecondaryAction"
            >
              {{ wechatSecondaryActionLabel }}
            </button>
          </div>
        </div>
      </section>

      <section class="space-y-4">
        <div class="flex items-center gap-2 text-ui-text-muted opacity-60">
          <ShieldCheck :size="14" />
          <h3 class="text-[10px] font-bold uppercase tracking-[0.1em]">桥接连接</h3>
        </div>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <label :for="bridgeUrlId" class="block text-[11px] font-bold text-ui-text-muted/80 ml-0.5 uppercase tracking-tighter">WebSocket 地址</label>
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
        {{ savingConfig ? '保存中...' : '保存并应用' }}
      </button>
    </footer>
  </div>
</template>
