# Plugin API Reference

> Browser Brain Loop 插件系统 API 参考手册  
> 版本：v0.1 · 日期：2026-03-13  
> 产品设计文档见 [plugin-system-product-design.md](plugin-system-product-design.md)

---

## 目录

1. [插件结构](#1-插件结构)
2. [SW 侧 Hook 参考（17 个）](#2-sw-侧-hook-参考)
3. [SW 侧 SDK（`pi` 对象）](#3-sw-侧-sdk)
4. [UI 侧 Hook 参考（13 个）](#4-ui-侧-hook-参考)
5. [UI 侧 SDK（`ui` 对象）](#5-ui-侧-sdk)
6. [Capability & Policy 速查](#6-capability--policy-速查)
7. [Permissions 机制](#7-permissions-机制)
8. [快速选择指南](#8-快速选择指南)

---

## 1. 插件结构

### 1.1 三文件模型

| 文件 | 运行环境 | 必需 | 作用 |
|------|---------|------|------|
| `plugin.json` | — | ✅ | 声明插件身份、权限、模块路径 |
| `index.js` | Service Worker 沙箱 | ✅ | 注册 Hook / Provider / Tool / Policy |
| `ui.js` | Panel（SidePanel） | ❌ | 拦截/修改 UI 渲染行为 |

### 1.2 plugin.json 结构

```jsonc
{
  "manifest": {
    "id": "plugin.user.my-plugin",         // 唯一 ID，推荐 plugin.<scope>.<name>
    "name": "my-plugin",                   // 人类可读名
    "version": "1.0.0",                    // semver
    "timeoutMs": 1500,                     // hook 超时 ms（范围 50~10000，默认 1500）
    "permissions": {
      "hooks": [],                         // 要监听的 hook 名称列表
      "runtimeMessages": [],               // 要发送的 SW→Panel 消息类型
      "brainEvents": [],                   // 要发出的事件总线事件类型
      "tools": [],                         // 要注册的工具名
      "llmProviders": [],                  // 要注册的 LLM provider ID
      "capabilities": [],                  // 要注册 policy 的能力名
      "modes": [],                         // 要注册 provider 的执行模式
      "replaceProviders": false,           // 是否允许覆盖已有 mode/capability provider
      "replaceToolContracts": false,       // 是否允许覆盖已有 tool contract
      "replaceLlmProviders": false         // 是否允许覆盖已有 LLM provider
    }
  },
  "modulePath": "plugins/my-plugin/index.js",  // 或 mem:// 虚拟路径
  "exportName": "default",
  "uiModulePath": "plugins/my-plugin/ui.js",   // 可选
  "uiExportName": "default"                     // 可选
}
```

### 1.3 入口函数签名

**index.js**（CommonJS）
```javascript
module.exports = function registerPlugin(pi) {
  // pi: ExtensionAPI — 见 §3
};
```

**ui.js**（CommonJS）
```javascript
module.exports = function registerPlugin(ui) {
  // ui: UiExtensionAPI — 见 §5
};
```

---

## 2. SW 侧 Hook 参考

### 2.1 Hook Handler 协议

```typescript
type HookHandler<TPayload> = (payload: TPayload) =>
  | void                                          // 等同 { action: "continue" }
  | { action: "continue" }                        // 放行
  | { action: "patch"; patch: Partial<TPayload> } // 修改 payload
  | { action: "block"; reason?: string }           // 阻止后续处理
  | Promise<...>;                                  // 支持 async

interface HookHandlerOptions {
  id?: string;       // handler 标识，用于卸载时精确匹配
  priority?: number; // 越大越先执行，默认 0
}
```

### 2.2 Agent 生命周期（4 个）

#### `step.before_execute`

**触发**：即将执行一个工具调用步骤。

```typescript
{
  input: {
    sessionId: string;
    mode?: "script" | "cdp" | "bridge";
    capability?: string;
    action: string;                    // 工具名，如 "click", "host_write_file"
    args?: Record<string, unknown>;
    verifyPolicy?: "off" | "on_critical" | "always";
  };
}
```

#### `step.after_execute`

**触发**：一个工具调用步骤执行完成。

```typescript
{
  input: ExecuteStepInput;              // 同上
  result: {
    ok: boolean;
    modeUsed: "script" | "cdp" | "bridge";
    capabilityUsed?: string;
    providerId?: string;
    fallbackFrom?: "script" | "cdp" | "bridge";
    verified: boolean;
    verifyReason?: string;
    data?: unknown;
    error?: string;
    errorCode?: string;
    errorDetails?: unknown;
    retryable?: boolean;
  };
}
```

#### `agent_end.before`

**触发**：Agent 即将结束运行。

```typescript
{
  input: AgentEndInput;    // sessionId, endReason 等
  state: RuntimeView;      // 当前 runtime 视图快照
}
```

#### `agent_end.after`

**触发**：Agent 运行完全结束。

```typescript
{
  input: AgentEndInput;
  decision: AgentEndDecision;  // AI 的最终决策
}
```

### 2.3 工具执行（2 个）

#### `tool.before_call`

**触发**：工具即将被调用（已确定 mode/capability）。

```typescript
{
  mode: "script" | "cdp" | "bridge";
  capability?: string;                 // 如 "browser.action", "fs.write"
  input: ExecuteStepInput;
}
```

#### `tool.after_result`

**触发**：工具调用返回结果。

```typescript
{
  mode: "script" | "cdp" | "bridge";
  capability?: string;
  providerId?: string;
  input: ExecuteStepInput;
  result: unknown;
}
```

### 2.4 LLM 通信（2 个）

#### `llm.before_request`

**触发**：即将向 LLM 发送请求。

```typescript
{
  request: Record<string, unknown>;   // OpenAI-compatible request body
  // 常见字段: model, messages, tools, temperature, max_tokens
}
```

#### `llm.after_response`

**触发**：收到 LLM 响应。

```typescript
{
  request: Record<string, unknown>;
  response: unknown;
  // response 常见字段: id, model, choices, usage { prompt_tokens, completion_tokens, total_tokens }
}
```

### 2.5 消息路由（3 个）

#### `runtime.route.before`

**触发**：收到一条 runtime 消息，即将分发处理。

```typescript
{
  type: string;       // 消息类型，如 "brain.run.start"
  message: unknown;   // 原始消息体
}
```

#### `runtime.route.after`

**触发**：runtime 消息处理完成。**最通用的全局监听 hook。**

```typescript
{
  type: string;       // 消息类型
  message: unknown;   // 原始消息体
  result: unknown;    // 处理结果
}
```

常见 type 值：`brain.run.start`, `brain.run.stop`, `brain.tool.result`, `brain.session.*`

#### `runtime.route.error`

**触发**：runtime 消息处理出错。

```typescript
{
  type: string;
  message: unknown;
  error: string;
}
```

### 2.6 上下文压缩（6 个）

#### `compaction.check.before`

```typescript
{ sessionId: string; source: "pre_send" | "agent_end"; }
```

#### `compaction.check.after`

```typescript
{ sessionId: string; source: "pre_send" | "agent_end"; shouldCompact: boolean; reason?: "overflow" | "threshold"; }
```

#### `compaction.before`

```typescript
{ sessionId: string; reason: "overflow" | "threshold"; willRetry: boolean; }
```

#### `compaction.summary`

```typescript
{ sessionId: string; reason: "overflow" | "threshold"; mode: "history" | "turn_prefix"; promptText: string; maxTokens: number; summary: string; }
```

#### `compaction.after`

```typescript
{ sessionId: string; reason: "overflow" | "threshold"; willRetry: boolean; }
```

#### `compaction.error`

```typescript
{ sessionId: string; reason: "overflow" | "threshold"; willRetry: boolean; errorMessage: string; }
```

---

## 3. SW 侧 SDK

插件 `index.js` 入口函数接收 `pi` 对象（`ExtensionAPI`）。

### 3.1 pi.on(hook, handler, options?)

注册 hook handler。

```javascript
pi.on("agent_end.after", (payload) => {
  console.log("Agent 结束", payload.decision);
});

pi.on("tool.before_call", (payload) => {
  return { action: "block", reason: "禁止执行" };
}, { priority: 100 });  // 高优先级
```

### 3.2 pi.registerProvider(id, adapter)

注册或替换 LLM Provider。

```javascript
pi.registerProvider("openai_compatible", {
  resolveRequestUrl(route) {
    // route: { profile, provider, llmBase, llmKey, llmModel, llmTimeoutMs, ... }
    return route.llmBase + "/chat/completions";
  },
  async send(input) {
    // input: { sessionId?, step?, route, payload, signal, requestUrl? }
    return await fetch(input.requestUrl || this.resolveRequestUrl(input.route), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + input.route.llmKey
      },
      body: JSON.stringify(input.payload),
      signal: input.signal
    });
    // 必须返回原生 Response 对象
  }
});
```

### 3.3 pi.registerTool(contract)

给 Agent 注册新工具（LLM 可调用）。

```javascript
pi.registerTool({
  name: "my_tool",
  description: "描述工具功能（LLM 读此描述决定是否调用）",
  parameters: {                    // JSON Schema
    type: "object",
    properties: {
      query: { type: "string", description: "查询内容" }
    },
    required: ["query"]
  },
  execution: {                     // 可选：执行规格
    capability: "process.exec",    // 关联的 capability
    mode: "script",                // 执行通道
    action: "my_tool",             // 工具动作名（默认同 name）
    verifyPolicy: "off"            // 验证策略
  }
});
```

### 3.4 pi.registerCapabilityPolicy(capability, policy)

修改能力执行策略。

```javascript
pi.registerCapabilityPolicy("browser.action", {
  defaultVerifyPolicy: "always",   // "off" | "on_critical" | "always"
  leasePolicy: "required"          // "auto" | "required" | "none"
});
```

### 3.5 pi.registerModeProvider(mode, provider)

替换工具执行通道（高级）。需要 `replaceProviders` 权限。

```javascript
pi.registerModeProvider("script", {
  id: "my-script-provider",
  async execute(input) { /* StepToolProvider 接口 */ }
});
```

### 3.6 pi.registerCapabilityProvider(capability, provider)

注册能力执行者（高级）。

```javascript
pi.registerCapabilityProvider("browser.action", {
  id: "my-browser-action",
  async execute(input) { /* StepToolProvider 接口 */ }
});
```

### 3.7 Runtime Message（SW → Panel 通信）

通过 `chrome.runtime.sendMessage` 向 Panel 发送消息。

```javascript
chrome.runtime.sendMessage({
  type: "bbloop.global.message",         // 需在 permissions.runtimeMessages 声明
  payload: {
    kind: "success",                     // "success" | "error" | "info" | "warning"
    message: "通知内容",
    source: "plugin.user.my-plugin"
  }
}).catch(() => {});
```

---

## 4. UI 侧 Hook 参考

### 4.1 Hook Handler 协议

与 SW 侧完全相同：`{ action: "continue" }` / `{ action: "patch", patch }` / `{ action: "block", reason? }`

### 4.2 通知（1 个）

#### `ui.notice.before_show`

**触发**：通知弹出前。

```typescript
{
  type: "success" | "error";
  message: string;
  source?: string;
  sessionId?: string;
  durationMs?: number;
  dedupeKey?: string;
  ts?: string;
}
```

### 4.3 消息渲染（4 个）

#### `ui.message.before_render`

**触发**：每条消息渲染前。可 block 隐藏消息。

```typescript
{
  role: string;           // "user" | "assistant" | "system" | "tool"
  content: string;
  entryId: string;
  toolName?: string;
  toolCallId?: string;
}
```

#### `ui.message.list.before_render`

**触发**：消息列表整体渲染前。可操作所有消息。

```typescript
{
  sessionId?: string;
  isRunning: boolean;
  messages: Array<{ role, content, entryId, toolName?, toolCallId? }>;
}
```

#### `ui.tool.call.before_render`

**触发**：工具调用部分渲染前。

```typescript
{ toolName: string; toolCallId: string; content: string; }
```

#### `ui.tool.result.before_render`

**触发**：工具结果部分渲染前。

```typescript
{ toolName: string; toolCallId: string; content: string; }
```

### 4.4 输入框（3 个）

#### `ui.chat_input.before_send`

**触发**：用户发送消息前。可 block 阻止发送。

```typescript
{
  text: string;
  tabIds: number[];
  skillIds: string[];
  contextRefs: Array<Record<string, unknown>>;
  mode: "normal" | "steer" | "followUp";
  sessionId?: string;
}
```

#### `ui.chat_input.after_send`

**触发**：消息成功发送后。Fire-and-forget。

```typescript
// 同 ui.chat_input.before_send
```

#### `ui.chat_input.before_render`

**触发**：输入框渲染状态重建时。

```typescript
{
  sessionId?: string;
  text: string;
  placeholder: string;
  disabled: boolean;
  isRunning: boolean;
  isCompacting: boolean;
  isStartingRun: boolean;
}
```

### 4.5 会话（2 个）

#### `ui.session.changed`

**触发**：活跃会话切换时。Fire-and-forget。

```typescript
{ sessionId: string; previousSessionId: string; reason?: string; }
```

#### `ui.session.list.before_render`

**触发**：会话列表渲染前。

```typescript
{
  sessions: Array<{ id, title, updatedAt?, parentSessionId?, forkedFromSessionId? }>;
  activeId: string;
  isOpen: boolean;
  loading?: boolean;
}
```

### 4.6 布局（3 个）

#### `ui.header.before_render`

**触发**：顶部 Header 渲染状态重建时。

```typescript
{ sessionId?: string; title: string; isRunning: boolean; isCompacting: boolean; forkedFromSessionId?: string; }
```

#### `ui.queue.before_render`

**触发**：队列区渲染前。

```typescript
{
  sessionId?: string;
  items: Array<{ id: string; behavior: "steer" | "followUp"; text: string; }>;
  state: { steer: number; followUp: number; total: number; };
}
```

#### `ui.runtime.event`

**触发**：每条 SW runtime 消息到达 Panel 时。**全局消息拦截器。**

```typescript
{ type: string; message: unknown; }
```

---

## 5. UI 侧 SDK

UI 插件 `ui.js` 入口函数接收 `ui` 对象。

### 5.1 ui.on(hook, handler, options?)

注册 UI hook handler。API 与 `pi.on` 相同。

```javascript
ui.on("ui.notice.before_show", (event) => {
  if (event.source === "plugin.user.my-plugin") {
    return {
      action: "patch",
      patch: { type: "success", durationMs: 3000 }
    };
  }
});

ui.on("ui.chat_input.before_send", (event) => {
  if (event.text.includes("危险")) {
    return { action: "block", reason: "包含敏感内容" };
  }
});
```

---

## 6. Capability & Policy 速查

### 6.1 内置 Capability 表

| Capability | 含义 | 默认 Verify | 默认 Lease |
|------------|------|------------|-----------|
| `process.exec` | 执行 shell 命令 | off | none |
| `fs.read` | 读取文件 | off | none |
| `fs.write` | 写入文件 | off | none |
| `fs.edit` | 编辑文件 | off | none |
| `browser.snapshot` | 获取页面快照 | off | none |
| `browser.action` | 浏览器操作（点击/填写/滚动等） | on_critical | auto |
| `browser.verify` | 验证操作结果 | always | none |

### 6.2 Policy 字段

```typescript
interface CapabilityExecutionPolicy {
  defaultVerifyPolicy?: "off" | "on_critical" | "always";
  leasePolicy?: "auto" | "required" | "none";
}
```

- **defaultVerifyPolicy**：`off` 不验证 / `on_critical` 关键步骤验证 / `always` 每步验证
- **leasePolicy**：`none` 无租约 / `auto` 自动获取 / `required` 必须持有租约

### 6.3 ExecuteMode

```typescript
type ExecuteMode = "script" | "cdp" | "bridge";
```

- `script`：浏览器侧脚本执行
- `cdp`：Chrome DevTools Protocol 执行
- `bridge`：通过本地 WS Bridge 执行

---

## 7. Permissions 机制

Permissions 是**声明式白名单**——只有声明了的能力才会生效。

| 字段 | 说明 | 不声明的后果 |
|------|------|------------|
| `hooks` | 要监听的 hook 名称 | `pi.on()` 注册的 handler 不会触发 |
| `runtimeMessages` | 要发送的 SW→Panel 消息类型 | `chrome.runtime.sendMessage()` 消息被静默丢弃 |
| `brainEvents` | 要发出的事件总线事件类型 | 元信息声明，当前不做强制拦截 |
| `tools` | 要注册的工具名 | 工具注册失败 |
| `llmProviders` | 要注册的 LLM provider ID | Provider 注册失败 |
| `capabilities` | 要注册 policy 的能力名 | Policy 注册失败 |
| `modes` | 要注册 provider 的执行模式 | Mode provider 注册失败 |
| `replaceProviders` | 是否允许覆盖已有 mode/capability provider | 默认 false — 重复注册会报错 |
| `replaceToolContracts` | 是否允许覆盖已有 tool contract | 默认 false |
| `replaceLlmProviders` | 是否允许覆盖已有 LLM provider | 默认 false |

> **最常见的坑**：忘记在 `permissions.hooks` 中声明 hook 名 → 插件注册成功但 hook 永远不触发。

---

## 8. 快速选择指南

### 8.1 SW Hook 选择

| 用户意图 | 推荐 Hook |
|---------|-----------|
| 任务完成时做某事 | `agent_end.after` |
| 每一步执行后做某事 | `step.after_execute` |
| 工具调用前检查/拦截 | `tool.before_call` |
| 修改发给 LLM 的请求 | `llm.before_request` |
| 处理 LLM 返回结果 | `llm.after_response` |
| 监听所有系统消息 | `runtime.route.after` |
| 在压缩前做处理 | `compaction.before` |
| 修改压缩摘要 | `compaction.summary` |

### 8.2 UI Hook 选择

| 用户意图 | 推荐 UI Hook |
|---------|-------------|
| 定制通知弹窗样式 | `ui.notice.before_show` |
| 拦截用户输入 | `ui.chat_input.before_send` |
| 监听所有 SW 消息 | `ui.runtime.event` |
| 隐藏某类消息 | `ui.message.before_render` |
| 修改消息显示 | `ui.message.before_render` |
| 修改工具调用显示 | `ui.tool.call.before_render` |
| 修改工具结果显示 | `ui.tool.result.before_render` |
| 自定义输入框状态 | `ui.chat_input.before_render` |
| 会话切换时执行逻辑 | `ui.session.changed` |

### 8.3 用途 → API 映射

| 用途 | 核心 API |
|------|---------|
| 在某个时机执行自定义逻辑 | `pi.on(hook, handler)` |
| 接入私有 LLM API | `pi.registerProvider(id, adapter)` |
| 给 Agent 增加新工具 | `pi.registerTool(contract)` |
| 修改校验/租约策略 | `pi.registerCapabilityPolicy(cap, policy)` |
| 定制 UI 通知/消息渲染 | `ui.on(uiHook, handler)` |
| SW → Panel 发消息 | `chrome.runtime.sendMessage({ type, payload })` |
