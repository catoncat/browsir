# Content Blocks 统一消息模型改造方案

> 日期：2026-03-25  
> 状态：方案设计  
> 前置文档：[tool-call-streaming-ux-research-2026-03-25.md](../tool-call-streaming-ux-research-2026-03-25.md)

## 问题本质

当前 BBL 的消息存储用了 `text: string` 的扁平结构，但 LLM 返回的 assistant 消息是有序的 content blocks（text + toolCall 混合数组）。在 tool_call turn 中，kernel 故意丢弃 assistantText 不入库，导致：

1. 流式打出的"我先去找输入框"随即被前端清空 — 用户感知像撤回消息
2. 刷新页面/切换会话后，tool_call turn 的思考文本永久丢失
3. Panel 侧被迫用临时 ref 打补丁（freeze/run-timeline），增加了复杂度但仍不持久

## 业界标准

| 系统 | assistant message content 类型 | 持久化 | UI 渲染 |
|------|-------------------------------|--------|---------|
| **Pi mono** | `(TextContent \| ThinkingContent \| ToolCall)[]` | 完整入 IndexedDB | 遍历 `message.content[]`，text/thinking/toolCall 按序渲染 |
| **Vercel AI SDK** | `message.parts[]`：text/tool-invocation/tool-result/reasoning/source/file | 完整持久化 | 推荐用 `parts` 替代 `content` 渲染 |
| **OpenAI API** | `content: string \| null` + `tool_calls[]` 同一条 assistant message | 一条消息承载两者 | — |
| **Anthropic API** | `content: (TextBlock \| ToolUseBlock)[]` | 一条消息承载两者 | — |

**共识**：一条 assistant 消息 = 有序 content blocks 数组，text 和 tool_call 共存，全链路不做信息损失。

## 改造目标

1. **tool_call turn 的 assistantText 入库** — 刷新/回看历史能看到
2. **消息存储支持 content blocks** — assistant message 可以 carry text + toolCall blocks
3. **UI 忠实渲染 blocks** — 一条 assistant 消息内 text 块和 tool 块按序展示
4. **删除 Panel 侧补丁** — freeze/run-timeline 临时机制可移除
5. **向后兼容** — 旧 session 数据（纯 `text: string`）正常工作

## 数据模型改造

### 层 1：存储层 — MessageEntry

**文件**：`extension/src/sw/kernel/types.ts` (L72-80)

```typescript
// 现状
export interface MessageEntry extends SessionEntryBase {
  type: "message";
  role: SessionMessageRole;
  text: string;               // ← 唯一内容字段
  toolName?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

// 目标
export interface MessageEntry extends SessionEntryBase {
  type: "message";
  role: SessionMessageRole;
  text: string;               // 保留：向后兼容 + 快速文本访问
  contentBlocks?: ContentBlock[];  // 新增：有序 content blocks
  toolName?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}
```

`ContentBlock` 类型定义（推荐放在 `types.ts`）：

```typescript
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: string };
```

设计要点：
- `contentBlocks` 是 **optional**，旧数据没有此字段仍然正常工作
- `text` 字段保留，用于快速文本访问（compaction、搜索、preview）和向后兼容
- `contentBlocks` 只在 assistant 消息（且有 toolCalls）时才有值
- 纯文本 assistant 消息不需要 `contentBlocks`，`text` 就够了

### 层 2：写入层 — AppendMessageInput

**文件**：`extension/src/sw/kernel/session-manager.browser.ts` (L34-43)

```typescript
// 现状
export interface AppendMessageInput {
  sessionId: string;
  role: SessionMessageRole;
  text: string;
  // ...
}

// 目标
export interface AppendMessageInput {
  sessionId: string;
  role: SessionMessageRole;
  text: string;
  contentBlocks?: ContentBlock[];  // 新增
  // ...
}
```

`appendMessage` 方法（L147-166）：将 `input.contentBlocks` 写入 `entry.contentBlocks`。

### 层 3：核心改造 — runtime-loop 写入 tool_call turn

**文件**：`extension/src/sw/kernel/runtime-loop.browser.ts` (L2310-2345)

```typescript
// 现状（L2328-2340）
if (toolCalls.length === 0) {
  await orchestrator.sessions.appendMessage({
    sessionId, role: "assistant",
    text: assistantText || "LLM 返回空内容。",
  });
  // ...
  break;
}
// → toolCalls > 0 时不写 assistant 消息

// 目标
// 无论 toolCalls 长度，都写 assistant 消息
const contentBlocks = buildAssistantContentBlocks(assistantText, toolCalls);
await orchestrator.sessions.appendMessage({
  sessionId,
  role: "assistant",
  text: assistantText,  // 纯文本部分，用于 compaction/preview
  contentBlocks: toolCalls.length > 0 ? serializeContentBlocks(contentBlocks) : undefined,
});

if (toolCalls.length === 0) {
  // ... break
}
// toolCalls > 0 时继续执行工具
```

其中 `serializeContentBlocks` 将 `LlmAssistantContentBlock[]` 转为 `ContentBlock[]`（两者结构几乎一致，只是 `LlmToolCallBlock.arguments` 可能是 object 需要 stringify）。

### 层 4：hosted chat transport 修复

**文件**：`extension/src/sw/kernel/loop-llm-stream.ts` (L262-270)

```typescript
// 现状
content: result.finishReason === "tool_calls" ? "" : result.assistantText,

// 目标
content: result.assistantText,  // 不再因为 finishReason 丢弃 text
```

### 层 5：Session Context 重建

**文件**：`extension/src/sw/kernel/session-manager.browser.ts` `buildSessionContext()` (L240-296)

```typescript
// 现状
messages.push({
  role: entry.role,
  content: entry.text,        // ← 只读 text
  llmContent: ...,
  // ...
});

// 目标
messages.push({
  role: entry.role,
  content: entry.text,
  contentBlocks: entry.contentBlocks,  // 传递 blocks
  llmContent: ...,
  // ...
});
```

**文件**：`extension/src/sw/kernel/types.ts` `SessionContextMessage`

```typescript
// 新增
export interface SessionContextMessage {
  // ... 现有字段
  contentBlocks?: ContentBlock[];  // 新增
}
```

### 层 6：LLM 消息重建

**文件**：`extension/src/sw/kernel/llm-message-model.browser.ts` `convertSessionContextMessagesToLlm()` (L514-564)

```typescript
// 现状
if (role === "user" || role === "assistant" || role === "system") {
  out.push({ role, content });  // ← 纯 string，无 tool_calls
}

// 目标
if (role === "assistant" && item.contentBlocks?.length) {
  // 有 content blocks → 恢复为完整的 assistant message with blocks
  out.push({
    role: "assistant",
    content: buildAssistantContentBlocks(
      content,
      item.contentBlocks.filter(b => b.type === "toolCall")
    ),
  });
} else if (role === "user" || role === "assistant" || role === "system") {
  out.push({ role, content });
}
```

这样 `insertSyntheticAssistantForOrphanToolResults` 就不需要再为 BBL 自身产生的消息做修补了（但保留它兼容旧数据和外部消息）。

### 层 7：Panel API

**文件**：`extension/src/sw/kernel/runtime-router/session-utils.ts` `buildConversationView()` (L153-215)

```typescript
// 现状
.map((entry) => ({
  role: entry.role,
  content: entry.text,
  // ...
}))

// 目标
.map((entry) => ({
  role: entry.role,
  content: entry.text,
  contentBlocks: entry.contentBlocks,  // 传递给 panel
  // ...
}))
```

### 层 8：Panel 类型

**文件**：`extension/src/panel/stores/chat-store.ts` `ConversationMessage`

```typescript
// 新增
contentBlocks?: ContentBlock[];
```

**文件**：`extension/src/panel/types.ts` `PanelMessageLike`

```typescript
// 新增
contentBlocks?: ContentBlock[];
```

### 层 9：Compaction

**文件**：`extension/src/sw/kernel/compaction.browser.ts` `entryToText()` (L174)

```typescript
// 现状
if (entry.type === "message") {
  return `[${entry.role}] ${entry.text}`;
}

// 目标
if (entry.type === "message") {
  if (entry.contentBlocks?.length) {
    // 包含 tool calls 的 assistant turn：展开为可读摘要
    const parts = entry.contentBlocks.map(b => {
      if (b.type === "text") return b.text;
      if (b.type === "toolCall") return `[调用工具: ${b.name}]`;
      return "";
    });
    return `[${entry.role}] ${parts.join(" ")}`;
  }
  return `[${entry.role}] ${entry.text}`;
}
```

## UI 渲染改造

### ChatMessage.vue — assistant 消息渲染 content blocks

当 `contentBlocks` 存在时，不再渲染单一 `content` string，而是遍历 blocks：

```vue
<!-- assistant 消息体 -->
<template v-if="msg.contentBlocks?.length">
  <template v-for="(block, i) in msg.contentBlocks" :key="i">
    <!-- text block -->
    <div v-if="block.type === 'text' && block.text.trim()" class="mb-2">
      <IncremarkContent :content="block.text" />
    </div>
    <!-- toolCall block: 精简内联卡片 -->
    <div v-else-if="block.type === 'toolCall'" class="mb-2">
      <InlineToolCallCard
        :tool-name="block.name"
        :tool-call-id="block.id"
        :tool-result="findToolResult(block.id)"
      />
    </div>
  </template>
</template>
<!-- 向后兼容：无 contentBlocks 时用 content string -->
<template v-else>
  <IncremarkContent :content="msg.content" />
</template>
```

其中 `InlineToolCallCard` 是新的精简组件，展示：
- 工具名
- 执行状态（通过 `findToolResult` 从后续 role="tool" 消息中匹配）
- 可展开查看完整参数和结果

`findToolResult(toolCallId)` 在消息列表中查找对应的 `role="tool"` 消息。

### 工具结果消息的渲染调整

当 tool_call 在 assistant 消息的 `InlineToolCallCard` 中已经内联展示时（配对了 tool result），独立的 `role="tool"` 消息可以：

**方案 A**：隐藏（因为信息已在 InlineToolCallCard 中展示）  
**方案 B**：保留但折叠（点击展开看完整内容）

推荐 **方案 A**（隐藏已配对的 tool 消息），与 Pi mono 的做法一致。

### 实时流式渲染

流式阶段仍然使用 `StreamingDraftContainer`，但行为更简单：

1. LLM 流式输出 text → `StreamingDraftContainer` 展示
2. 检测到 tool_call → **不再清空** text，而是等这个 turn 完成
3. turn 完成后，kernel 写入完整的 assistant 消息（含 contentBlocks）
4. Panel 通过 `loadConversation()` 拉到新消息 → `ChatMessage` 用 blocks 渲染
5. `StreamingDraftContainer` 消失（因为消息已入库、stableMessages 中已有）

去重逻辑（`shouldShowStreamingDraft` 的 dedup）自然生效。

## 可移除的 Panel 补丁代码

改造完成后，以下临时机制可以移除：

| 文件 | 移除内容 |
|------|---------|
| `use-llm-streaming.ts` | `frozenPreToolTexts` ref、`freezeAndResetStreaming()`、`clearFrozenPreToolText()`、`shouldShowFrozenPreToolText` |
| `use-tool-run-tracking.ts` | `liveRunTimelineItems` 相关逻辑、`upsertLiveRunTimelineToolStep()` |
| `ChatView.vue` | live run timeline 渲染块、`completedRunTimelineItems`、`shouldShowLiveRunTimeline`、`shouldHideInlineToolMessages` |
| `utils/run-timeline.ts` | 整个文件可删除 |
| `ChatMessage.vue` | `executionTimelineItems` prop 和 popup 弹层 |

## 改造顺序

### Phase 1：存储层扩展（不改 UI，纯后端）

1. `types.ts` 新增 `ContentBlock` 类型和 `MessageEntry.contentBlocks`
2. `session-manager.browser.ts` 扩展 `AppendMessageInput` 和 `appendMessage()`
3. `runtime-loop.browser.ts` 改为 tool_call turn 也写 assistant 消息（带 contentBlocks）
4. `loop-llm-stream.ts` 不再在 finishReason=tool_calls 时丢弃 assistantText
5. `session-manager.browser.ts` `buildSessionContext()` 传递 contentBlocks
6. `llm-message-model.browser.ts` `convertSessionContextMessagesToLlm()` 利用 contentBlocks 恢复完整 assistant
7. `compaction.browser.ts` `entryToText()` 处理 contentBlocks
8. `session-utils.ts` `buildConversationView()` 传递 contentBlocks 给 panel

**验证**：`bun run test` 通过 + kernel 能正确持久化和重建 tool_call turn assistant message

### Phase 2：Panel 渲染改造

1. `chat-store.ts` / `types.ts` 扩展 `ConversationMessage` / `PanelMessageLike`
2. `ChatMessage.vue` 支持 content blocks 渲染
3. 新增 `InlineToolCallCard.vue` 组件
4. 调整 tool 消息隐藏逻辑（已配对的 tool 消息隐藏）
5. 简化流式渲染（不再 freeze，依赖 turn 完成后入库 + dedup）

**验证**：手动测试 tool_call 场景 + 历史回看

### Phase 3：清理补丁代码

1. 移除 freeze/run-timeline 临时机制
2. 更新/移除相关测试
3. 更新 `tool-call-streaming-ux-research` 文档标记为已解决

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 旧 session 数据无 contentBlocks | optional 字段，fallback 到 `text` 渲染 |
| tool_call turn assistant 文本为空（模型未输出思考文本） | `text` 为空时 contentBlocks 只有 toolCall block，text block 不渲染 |
| 多工具场景中多次 text-toolCall 交替 | content blocks 的有序数组天然支持 |
| compaction 后旧消息被替换为摘要 | compaction entry 是 `type: "compaction_summary"`，不受影响 |
| 消息列表膨胀（tool_call turn 新增 assistant 消息） | 实际只多了"本来就该有的消息"，数量增加有限 |
| `insertSyntheticAssistantForOrphanToolResults` 与新消息冲突 | 新消息有显式 tool_call 声明，不再触发合成逻辑 |

## 涉及文件完整清单

### 必须改动

| 文件 | 改动类型 |
|------|---------|
| `extension/src/sw/kernel/types.ts` | 新增 `ContentBlock`，扩展 `MessageEntry`、`SessionContextMessage` |
| `extension/src/sw/kernel/session-manager.browser.ts` | 扩展 `AppendMessageInput`、`appendMessage()`、`buildSessionContext()` |
| `extension/src/sw/kernel/runtime-loop.browser.ts` | tool_call turn 写 assistant 消息 |
| `extension/src/sw/kernel/loop-llm-stream.ts` | 不丢弃 tool_calls turn 的 assistantText |
| `extension/src/sw/kernel/llm-message-model.browser.ts` | `convertSessionContextMessagesToLlm()` 恢复 contentBlocks |
| `extension/src/sw/kernel/compaction.browser.ts` | `entryToText()` 处理 contentBlocks |
| `extension/src/sw/kernel/runtime-router/session-utils.ts` | `buildConversationView()` 传递 contentBlocks |
| `extension/src/panel/stores/chat-store.ts` | `ConversationMessage` 扩展 |
| `extension/src/panel/types.ts` | `PanelMessageLike` 扩展 |
| `extension/src/panel/components/ChatMessage.vue` | content blocks 渲染 |
| `extension/src/panel/ChatView.vue` | 调整 tool 消息过滤逻辑 |

### 新增

| 文件 | 说明 |
|------|------|
| `extension/src/panel/components/InlineToolCallCard.vue` | 精简内联工具调用卡片 |

### 可删除（Phase 3）

| 文件 | 说明 |
|------|------|
| `extension/src/panel/utils/run-timeline.ts` | 临时 run timeline 工具 |
| run-timeline 相关 composable 代码 | freeze/liveRunTimeline/completedRunTimeline |

### 测试更新

| 文件 | 说明 |
|------|------|
| `extension/src/sw/kernel/__tests__/web-chat-executor.browser.test.ts` | "withholds provisional text" 测试需改为验证 text 被保留 |
| 新增：content blocks 持久化 round-trip 测试 | 验证 write → read → LLM rebuild 全链路 |
