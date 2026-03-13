<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown, ChevronRight, Webhook, Monitor } from "lucide-vue-next";

type HookCategory = "agent" | "tool" | "llm" | "route" | "compaction" | "ui-notice" | "ui-message" | "ui-input" | "ui-session" | "ui-layout";

interface HookEntry {
  name: string;
  trigger: string;
  payload: string;
  snippet: string;
}

interface HookGroup {
  category: HookCategory;
  label: string;
  icon: "sw" | "ui";
  hooks: HookEntry[];
}

const expandedCategory = ref<HookCategory | null>(null);
const expandedHook = ref<string | null>(null);
const activeTab = ref<"sw" | "ui">("sw");

function toggleCategory(cat: HookCategory) {
  expandedCategory.value = expandedCategory.value === cat ? null : cat;
  expandedHook.value = null;
}

function toggleHook(name: string) {
  expandedHook.value = expandedHook.value === name ? null : name;
}

function insertHook(hook: HookEntry) {
  emit("insert-snippet", hook.snippet);
}

const emit = defineEmits<{
  "insert-snippet": [snippet: string];
}>();

const swGroups: HookGroup[] = [
  {
    category: "agent",
    label: "Agent 生命周期",
    icon: "sw",
    hooks: [
      {
        name: "step.before_execute",
        trigger: "即将执行一个工具调用步骤",
        payload: "{ input: { sessionId, mode?, capability?, action, args?, verifyPolicy? } }",
        snippet: `pi.on("step.before_execute", (payload) => {\n  const action = String(payload.input?.action || "");\n  // 步骤即将执行\n  return { action: "continue" };\n});`
      },
      {
        name: "step.after_execute",
        trigger: "一个工具调用步骤执行完成",
        payload: "{ input: ExecuteStepInput, result: { ok, modeUsed, verified, data?, error? } }",
        snippet: `pi.on("step.after_execute", (payload) => {\n  const ok = payload.result?.ok;\n  const action = String(payload.input?.action || "");\n  // 步骤完成，ok 表示是否成功\n  return { action: "continue" };\n});`
      },
      {
        name: "agent_end.before",
        trigger: "Agent 即将结束运行",
        payload: "{ input: AgentEndInput, state: RuntimeView }",
        snippet: `pi.on("agent_end.before", (payload) => {\n  // Agent 即将结束\n  return { action: "continue" };\n});`
      },
      {
        name: "agent_end.after",
        trigger: "Agent 运行完全结束",
        payload: "{ input: AgentEndInput, decision: AgentEndDecision }",
        snippet: `pi.on("agent_end.after", (payload) => {\n  // Agent 已完全结束\n  chrome.runtime.sendMessage({\n    type: "bbloop.global.message",\n    payload: { kind: "success", message: "任务完成", source: "my-plugin" }\n  }).catch(() => {});\n});`
      }
    ]
  },
  {
    category: "tool",
    label: "工具执行",
    icon: "sw",
    hooks: [
      {
        name: "tool.before_call",
        trigger: "工具即将被调用（已确定 mode/capability）",
        payload: "{ mode, capability?, input: ExecuteStepInput }",
        snippet: `pi.on("tool.before_call", (payload) => {\n  const action = String(payload.input?.action || "");\n  // 可 block 阻止执行\n  return { action: "continue" };\n});`
      },
      {
        name: "tool.after_result",
        trigger: "工具调用返回结果",
        payload: "{ mode, capability?, providerId?, input, result }",
        snippet: `pi.on("tool.after_result", (payload) => {\n  // 处理工具调用结果\n  return { action: "continue" };\n});`
      }
    ]
  },
  {
    category: "llm",
    label: "LLM 通信",
    icon: "sw",
    hooks: [
      {
        name: "llm.before_request",
        trigger: "即将向 LLM 发送请求",
        payload: "{ request: { model, messages, tools, ... } }",
        snippet: `pi.on("llm.before_request", (payload) => {\n  // 可 patch 修改请求参数\n  return { action: "continue" };\n});`
      },
      {
        name: "llm.after_response",
        trigger: "收到 LLM 响应",
        payload: "{ request, response: { id, model, choices, usage } }",
        snippet: `pi.on("llm.after_response", (payload) => {\n  const usage = payload.response?.usage || {};\n  // 处理响应数据\n  return { action: "continue" };\n});`
      }
    ]
  },
  {
    category: "route",
    label: "消息路由",
    icon: "sw",
    hooks: [
      {
        name: "runtime.route.before",
        trigger: "收到 runtime 消息，即将分发",
        payload: "{ type: string, message: unknown }",
        snippet: `pi.on("runtime.route.before", (event) => {\n  const routeType = String(event?.type || "");\n  return { action: "continue" };\n});`
      },
      {
        name: "runtime.route.after",
        trigger: "runtime 消息处理完成（最通用）",
        payload: "{ type: string, message: unknown, result: unknown }",
        snippet: `pi.on("runtime.route.after", (event) => {\n  const routeType = String(event?.type || "");\n  if (routeType === "brain.run.start") {\n    // Agent 开始运行\n  }\n  return { action: "continue" };\n});`
      },
      {
        name: "runtime.route.error",
        trigger: "runtime 消息处理出错",
        payload: "{ type: string, message: unknown, error: string }",
        snippet: `pi.on("runtime.route.error", (event) => {\n  // 处理路由错误\n  return { action: "continue" };\n});`
      }
    ]
  },
  {
    category: "compaction",
    label: "上下文压缩",
    icon: "sw",
    hooks: [
      {
        name: "compaction.check.before",
        trigger: "准备检查是否需要压缩",
        payload: '{ sessionId, source: "pre_send" | "agent_end" }',
        snippet: `pi.on("compaction.check.before", (payload) => {\n  // 可控制是否压缩\n  return { action: "continue" };\n});`
      },
      {
        name: "compaction.summary",
        trigger: "压缩摘要已生成，可修改",
        payload: "{ sessionId, reason, mode, promptText, maxTokens, summary }",
        snippet: `pi.on("compaction.summary", (payload) => {\n  // 可 patch 修改 promptText 来调整压缩策略\n  return { action: "continue" };\n});`
      },
      {
        name: "compaction.before / .after / .error",
        trigger: "压缩开始/完成/失败",
        payload: "{ sessionId, reason, willRetry, errorMessage? }",
        snippet: `pi.on("compaction.after", (payload) => {\n  // 压缩完成\n  return { action: "continue" };\n});`
      }
    ]
  }
];

const uiGroups: HookGroup[] = [
  {
    category: "ui-notice",
    label: "通知",
    icon: "ui",
    hooks: [
      {
        name: "ui.notice.before_show",
        trigger: "通知弹出前，可修改或阻止",
        payload: "{ type, message, source?, sessionId?, durationMs?, dedupeKey? }",
        snippet: `ui.on("ui.notice.before_show", (event) => {\n  // 修改通知样式\n  return {\n    action: "patch",\n    patch: { type: "success", durationMs: 3000 }\n  };\n});`
      }
    ]
  },
  {
    category: "ui-message",
    label: "消息渲染",
    icon: "ui",
    hooks: [
      {
        name: "ui.message.before_render",
        trigger: "每条消息渲染前，可隐藏或修改",
        payload: "{ role, content, entryId, toolName?, toolCallId? }",
        snippet: `ui.on("ui.message.before_render", (event) => {\n  // 可 block 隐藏，或 patch 修改 content\n  return { action: "continue" };\n});`
      },
      {
        name: "ui.message.list.before_render",
        trigger: "消息列表整体渲染前",
        payload: "{ sessionId?, isRunning, messages[] }",
        snippet: `ui.on("ui.message.list.before_render", (event) => {\n  return { action: "continue" };\n});`
      },
      {
        name: "ui.tool.call.before_render",
        trigger: "工具调用部分渲染前",
        payload: "{ toolName, toolCallId, content }",
        snippet: `ui.on("ui.tool.call.before_render", (event) => {\n  return { action: "continue" };\n});`
      },
      {
        name: "ui.tool.result.before_render",
        trigger: "工具结果部分渲染前",
        payload: "{ toolName, toolCallId, content }",
        snippet: `ui.on("ui.tool.result.before_render", (event) => {\n  return { action: "continue" };\n});`
      }
    ]
  },
  {
    category: "ui-input",
    label: "输入框",
    icon: "ui",
    hooks: [
      {
        name: "ui.chat_input.before_send",
        trigger: "用户发送消息前（可拦截）",
        payload: "{ text, tabIds, skillIds, contextRefs, mode, sessionId? }",
        snippet: `ui.on("ui.chat_input.before_send", (event) => {\n  // 可 block 阻止发送\n  return { action: "continue" };\n});`
      },
      {
        name: "ui.chat_input.after_send",
        trigger: "消息成功发送后",
        payload: "{ text, tabIds, skillIds, contextRefs, mode, sessionId? }",
        snippet: `ui.on("ui.chat_input.after_send", (event) => {\n  return { action: "continue" };\n});`
      },
      {
        name: "ui.chat_input.before_render",
        trigger: "输入框渲染状态重建时",
        payload: "{ text, placeholder, disabled, isRunning, isCompacting }",
        snippet: `ui.on("ui.chat_input.before_render", (event) => {\n  return { action: "continue" };\n});`
      }
    ]
  },
  {
    category: "ui-session",
    label: "会话",
    icon: "ui",
    hooks: [
      {
        name: "ui.session.changed",
        trigger: "活跃会话切换时",
        payload: "{ sessionId, previousSessionId, reason? }",
        snippet: `ui.on("ui.session.changed", (event) => {\n  // 会话切换\n  return { action: "continue" };\n});`
      },
      {
        name: "ui.session.list.before_render",
        trigger: "会话列表渲染前",
        payload: "{ sessions[], activeId, isOpen, loading? }",
        snippet: `ui.on("ui.session.list.before_render", (event) => {\n  return { action: "continue" };\n});`
      }
    ]
  },
  {
    category: "ui-layout",
    label: "布局 & 全局",
    icon: "ui",
    hooks: [
      {
        name: "ui.runtime.event",
        trigger: "每条 SW 消息到达 Panel（全局拦截器）",
        payload: "{ type: string, message: unknown }",
        snippet: `ui.on("ui.runtime.event", (event) => {\n  const msgType = String(event?.message?.type || "");\n  return { action: "continue" };\n});`
      },
      {
        name: "ui.header.before_render",
        trigger: "Header 渲染状态重建时",
        payload: "{ title, isRunning, isCompacting, forkedFromSessionId? }",
        snippet: `ui.on("ui.header.before_render", (event) => {\n  return { action: "continue" };\n});`
      },
      {
        name: "ui.queue.before_render",
        trigger: "队列区渲染前",
        payload: "{ items[], state: { steer, followUp, total } }",
        snippet: `ui.on("ui.queue.before_render", (event) => {\n  return { action: "continue" };\n});`
      }
    ]
  }
];

const currentGroups = ref<HookGroup[]>(swGroups);

function switchTab(tab: "sw" | "ui") {
  activeTab.value = tab;
  currentGroups.value = tab === "sw" ? swGroups : uiGroups;
  expandedCategory.value = null;
  expandedHook.value = null;
}
</script>

<template>
  <div class="hook-ref">
    <div class="hook-ref-tabs">
      <button
        :class="['hook-tab-btn', activeTab === 'sw' ? 'active' : '']"
        @click="switchTab('sw')"
        aria-label="SW 侧 Hook"
      >
        <Webhook :size="13" aria-hidden="true" />
        SW (17)
      </button>
      <button
        :class="['hook-tab-btn', activeTab === 'ui' ? 'active' : '']"
        @click="switchTab('ui')"
        aria-label="UI 侧 Hook"
      >
        <Monitor :size="13" aria-hidden="true" />
        UI (13)
      </button>
    </div>

    <div class="hook-ref-body">
      <div
        v-for="group in currentGroups"
        :key="group.category"
        class="hook-group"
      >
        <button
          class="hook-group-header"
          @click="toggleCategory(group.category)"
          :aria-expanded="expandedCategory === group.category"
        >
          <component :is="expandedCategory === group.category ? ChevronDown : ChevronRight" :size="12" aria-hidden="true" />
          <span class="group-label">{{ group.label }}</span>
          <span class="group-count">{{ group.hooks.length }}</span>
        </button>

        <div v-if="expandedCategory === group.category" class="hook-list">
          <div
            v-for="hook in group.hooks"
            :key="hook.name"
            class="hook-item"
          >
            <button
              class="hook-name-btn"
              @click="toggleHook(hook.name)"
              :aria-expanded="expandedHook === hook.name"
            >
              <code class="hook-name">{{ hook.name }}</code>
            </button>
            <p class="hook-trigger">{{ hook.trigger }}</p>

            <div v-if="expandedHook === hook.name" class="hook-detail">
              <div class="detail-section">
                <p class="detail-label">Payload</p>
                <code class="detail-payload">{{ hook.payload }}</code>
              </div>
              <div class="detail-section">
                <p class="detail-label">代码片段</p>
                <pre class="detail-snippet">{{ hook.snippet }}</pre>
                <button
                  class="insert-btn"
                  @click="insertHook(hook)"
                  title="插入到编辑器"
                >
                  插入代码
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hook-ref {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.hook-ref-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.hook-tab-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
}

.hook-tab-btn.active {
  background: color-mix(in oklab, var(--accent) 12%, var(--bg));
  color: var(--text);
  font-weight: 600;
}

.hook-ref-body {
  overflow-y: auto;
  flex: 1;
  padding: 4px 0;
}

.hook-group {
  border-bottom: 1px solid color-mix(in oklab, var(--border) 50%, transparent);
}

.hook-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  border: none;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.hook-group-header:hover {
  background: var(--surface);
}

.group-count {
  margin-left: auto;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted);
  background: var(--surface);
  padding: 1px 5px;
  border-radius: 8px;
}

.hook-list {
  padding: 0 8px 4px;
}

.hook-item {
  padding: 4px 6px;
  border-radius: 4px;
}

.hook-item:hover {
  background: var(--surface);
}

.hook-name-btn {
  display: block;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
  width: 100%;
}

.hook-name {
  font-size: 11px;
  font-family: "SF Mono", "Menlo", monospace;
  color: var(--accent);
  font-weight: 500;
}

.hook-trigger {
  font-size: 10.5px;
  color: var(--text-muted);
  margin: 1px 0 0;
  line-height: 1.3;
}

.hook-detail {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--surface);
  border-radius: 4px;
  border: 1px solid var(--border);
}

.detail-section {
  margin-bottom: 6px;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 2px;
}

.detail-payload {
  display: block;
  font-size: 10.5px;
  font-family: "SF Mono", "Menlo", monospace;
  color: var(--text-muted);
  word-break: break-all;
  line-height: 1.4;
}

.detail-snippet {
  font-size: 10.5px;
  font-family: "SF Mono", "Menlo", monospace;
  line-height: 1.5;
  margin: 4px 0;
  padding: 6px;
  background: var(--bg);
  border-radius: 3px;
  border: 1px solid var(--border);
  overflow-x: auto;
  white-space: pre;
}

.insert-btn {
  font-size: 10px;
  padding: 3px 10px;
  border: 1px solid var(--accent);
  color: var(--accent);
  background: transparent;
  border-radius: 3px;
  cursor: pointer;
  margin-top: 4px;
}

.insert-btn:hover {
  background: var(--accent);
  color: var(--bg);
}
</style>
