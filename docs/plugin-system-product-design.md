# 插件系统产品设计文档

> 版本：v0.1 · 日期：2026-03-13

## 1. 核心主张

Browser Brain Loop 的插件系统拥有**完整的内核扩展能力**——17 个 hook 点、3 种执行模式（script/cdp/bridge）、7 个内置 capability、Provider/Policy 替换、自定义工具契约、LLM 路由——这些能力本身没有问题。

**问题不是能力太多，而是能力缺少清晰的定义和传达路径。**

小狗 HUD 插件（`example-mission-hud-dog`）是最好的证据：它同时使用了 4 个 hook（`runtime.route.after`、`tool.before_call`、`step.after_execute`、`agent_end.after`）+ runtime message + UI 模块，是一个有表达力的真实插件。问题是——除了作者本人，没有人知道怎么从零做出类似的东西。

### 设计目标

**让用户能用自然语言向 AI 描述"我想要什么插件"，AI 能准确生成可运行的插件代码。**

这要求：

1. 插件系统的概念层次和 API 有清晰、无歧义的文档
2. AI（ChatGPT/Copilot/Claude/Brain Loop 自身）能基于文档产出正确的插件包
3. Plugin Studio 提供足够的反馈闭环（注册→运行→日志→修改）

---

## 2. 现状诊断

### 2.1 能力全景（保留不动）

| 能力层 | 内容 | 数量 |
|--------|------|------|
| Hook | 拦截内核生命周期 | 17 个 hook 点 |
| Mode Provider | 替换工具执行通道 | 3 个（script/cdp/bridge） |
| Capability Provider | 扩展能力执行者 | 7 个内置 capability |
| Capability Policy | 控制校验/租约策略 | 7 个内置 policy |
| Tool Contract | 注册新工具给 LLM | 46 个内置 + 自定义 |
| LLM Provider | 自定义 LLM API 路由 | 1 个内置（openai_compatible）+ 自定义 |
| UI Extension | Panel 侧 UI 模块 | 通过 uiModulePath 声明 |
| Runtime Message | SW ↔ Panel 消息 | 开放字符串 |
| Brain Event | 内部事件总线 | 开放字符串 |

### 2.2 核心痛点

| # | 问题 | 影响 |
|---|------|------|
| 1 | **无 API 参考文档**：17 个 hook 的触发时机、payload 结构、返回值语义只能读源码获取 | AI 无法生成正确代码；人类更无从下手 |
| 2 | **概念缺少分层解释**：permissions / hooks / providers / modes / capabilities / policies 对新用户是平铺概念洪水 | 不知道从哪开始 |
| 3 | **示例太少且无注释**：3 个示例插件缺少"为什么这样写"的教学叙事 | 无法通过示例学习 |
| 4 | **Plugin Studio 编辑体验弱**：textarea 无高亮/补全/类型提示 | 不如在 VSCode 写完粘贴 |
| 5 | **Plugin vs Skill 边界模糊**：用户不知道该用哪个 | 产品认知混乱 |

---

## 3. 产品定位

### 3.1 Plugin vs Skill：明确边界

| 维度 | Plugin（插件） | Skill（技能） |
|------|---------------|---------------|
| **一句话** | 改变系统的行为方式 | 教 Agent 新的知识和能力 |
| **面向** | 开发者（人类或 AI 辅助） | 用户和 AI Agent |
| **触发** | 内核事件自动触发 | LLM 在对话中主动调用 |
| **典型场景** | Hook 执行流程、替换 LLM 路由、修改校验策略、注册新工具、自定义 UI 反馈 | 操作特定网站的步骤、特定领域知识、可复用的脚本 |
| **类比** | Chrome Extension / VSCode Extension | ChatGPT Custom GPT 的 Instructions + Actions |
| **创建方式** | JSON + JS 编程 | 自然语言 + `create_skill` |

**判断规则**：如果需求是"让 Agent 在某个场景下做得更好"→ Skill；如果需求是"改变系统底层行为（路由/校验/通知/工具）"→ Plugin。

### 3.2 插件的 5 类用途

基于现有能力，插件的核心用途归纳为 5 类：

| 类别 | 说明 | 涉及 API | 示例 |
|------|------|----------|------|
| **🪝 行为钩子** | 在内核流程的关键节点注入自定义逻辑 | `pi.on(hook, handler)` | 小狗 HUD、操作日志、自定义通知 |
| **🔌 LLM 路由** | 接入私有 LLM API 或代理 | `pi.registerProvider(id, adapter)` | 企业代理、多模型路由 |
| **🛠️ 自定义工具** | 给 Agent 注册新工具，LLM 可调用 | `pi.registerTool(contract)` | 自定义 API 调用、数据查询 |
| **⚙️ 策略控制** | 修改能力执行的校验和租约策略 | `pi.registerCapabilityPolicy(cap, policy)` | 严格校验、跳过校验、必须租约 |
| **🎨 UI 扩展** | 在 SidePanel 中渲染自定义 UI | `uiModulePath` + `ui.on(hook, handler)` | HUD 面板、自定义通知样式 |

---

## 4. 信息架构重设计

### 4.1 分层概念模型

将现有概念从"平铺 10 个"重组为 **3 层渐进式**：

```
Layer 1 — 基础（5 分钟上手）
├── plugin.json         → 插件是谁：id, name, version
├── index.js            → 插件做什么：module.exports = function(pi) { ... }
└── pi.on(hook, fn)     → 最基本的能力：监听事件

Layer 2 — 进阶（有目标查文档）
├── permissions         → 声明要用哪些 hook / 消息 / 事件
├── pi.registerProvider → 自定义 LLM 路由
├── pi.registerTool     → 给 Agent 新工具
├── pi.registerCapabilityPolicy → 调整校验策略
└── runtimeMessages / brainEvents → SW ↔ Panel 通信

Layer 3 — 高级（内核级扩展）
├── pi.registerModeProvider       → 替换执行通道
├── pi.registerCapabilityProvider → 替换能力执行者
├── replace* 权限                 → 覆盖系统默认
├── ui.js + uiModulePath         → Panel UI 扩展
└── 沙箱执行模型                   → CommonJS in Service Worker sandbox
```

### 4.2 Plugin JSON 的结构化说明

```jsonc
{
  // Layer 1：插件身份
  "manifest": {
    "id": "plugin.user.my-first-plugin",    // 唯一 ID，推荐 plugin.<scope>.<name>
    "name": "my-first-plugin",              // 人类可读名
    "version": "1.0.0",                     // semver
    "timeoutMs": 1500,                      // hook 超时（50~10000ms），可选
    "permissions": {
      // Layer 2：能力声明（只有声明了的 hook/消息/事件才会生效）
      "hooks": ["agent_end.after"],                   // 要监听的 hook
      "runtimeMessages": ["bbloop.global.message"],   // 要发送的 SW→Panel 消息类型
      "brainEvents": ["my.custom.event"],             // 要发送的事件总线事件

      // Layer 2：Provider 能力
      "llmProviders": ["my.proxy"],                   // 要注册的 LLM provider ID
      "tools": ["my_custom_tool"],                    // 要注册的工具名
      "capabilities": ["browser.action"],             // 要注册 policy 的能力名

      // Layer 3：替换权限（默认 false）
      "replaceProviders": false,
      "replaceToolContracts": false,
      "replaceLlmProviders": false,

      // Layer 3：执行模式扩展
      "modes": ["script"]
    }
  },

  // 模块加载
  "modulePath": "plugins/my-plugin/index.js",   // 或 mem:// 虚拟路径
  "exportName": "default",                      // 导出名，默认 "default"

  // UI 扩展（可选）
  "uiModulePath": "plugins/my-plugin/ui.js",
  "uiExportName": "default"
}
```

---

## 5. Hook 参考手册

### 5.1 Hook 分类

**Agent 生命周期（4 个）** — Agent 会话运行的关键节点

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `agent_end.before` | Agent 即将结束运行（结论已出、准备收尾） | 最后一刻注入操作 |
| `agent_end.after` | Agent 运行完全结束 | ✅ **通知/记录/统计** |
| `step.before_execute` | 即将执行一个工具调用步骤 | 步骤级拦截/审计 |
| `step.after_execute` | 一个工具调用步骤执行完成 | ✅ **步骤结果处理/UI 反馈** |

**工具执行（2 个）** — 工具调用的前后

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `tool.before_call` | 工具即将被调用（已确定 mode/capability） | 参数修改/拦截/日志 |
| `tool.after_result` | 工具调用返回结果 | 结果后处理/审计 |

**LLM 通信（2 个）** — 与 LLM API 的交互

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `llm.before_request` | 即将向 LLM 发送请求 | 请求修改/日志/指标 |
| `llm.after_response` | 收到 LLM 响应 | 响应后处理/指标/审计 |

**消息路由（3 个）** — runtime-router 消息分发

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `runtime.route.before` | 收到一条 runtime 消息、即将分发处理 | 消息拦截/修改 |
| `runtime.route.after` | runtime 消息处理完成 | ✅ **全局事件监听（最常用 hook）** |
| `runtime.route.error` | runtime 消息处理出错 | 错误处理/报告 |

**Compaction（6 个）** — 上下文压缩流程

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `compaction.check.before` | 准备检查是否需要压缩 | 自定义压缩条件 |
| `compaction.check.after` | 压缩检查完成 | 观测/统计 |
| `compaction.before` | 即将开始压缩 | 预处理 |
| `compaction.summary` | 压缩摘要已生成 | 摘要修改 |
| `compaction.after` | 压缩完成 | 后处理/通知 |
| `compaction.error` | 压缩失败 | 错误处理 |

### 5.2 Hook Handler 协议

每个 hook handler 接收 payload 对象，返回一个决策：

```javascript
// 简单用法：返回 void 或 { action: "continue" }
pi.on("agent_end.after", (payload) => {
  console.log("Agent 运行结束", payload.decision);
  // 不返回 或 return { action: "continue" }
});

// 修改 payload：返回 { action: "patch", patch: {...} }
pi.on("llm.before_request", (payload) => {
  return {
    action: "patch",
    patch: {
      request: {
        ...payload.request,
        temperature: 0.5
      }
    }
  };
});

// 阻止后续处理：返回 { action: "block", reason: "..." }
pi.on("tool.before_call", (payload) => {
  if (payload.action === "dangerous_tool") {
    return { action: "block", reason: "该工具已被插件禁用" };
  }
});
```

### 5.3 Payload 结构速查

#### step.after_execute

```typescript
{
  input: {
    sessionId: string;
    mode?: "script" | "cdp" | "bridge";
    capability?: string;          // 如 "browser.action", "fs.write"
    action: string;               // 工具名，如 "click", "host_write_file"
    args?: Record<string, unknown>;
    verifyPolicy?: "off" | "on_critical" | "always";
  };
  result: {
    ok: boolean;
    modeUsed: "script" | "cdp" | "bridge";
    capabilityUsed?: string;
    providerId?: string;
    verified: boolean;
    verifyReason?: string;
    data?: unknown;
    error?: string;
    errorCode?: string;
    retryable?: boolean;
  };
}
```

#### agent_end.after

```typescript
{
  input: AgentEndInput;     // 包含 sessionId、endReason 等
  decision: AgentEndDecision; // AI 的最终决策
}
```

#### runtime.route.after

```typescript
{
  type: string;       // 消息类型，如 "brain.run.start", "brain.tool.result"
  message: unknown;   // 原始消息体
  result: unknown;    // 处理结果
}
```

#### tool.before_call

```typescript
{
  mode: "script" | "cdp" | "bridge";
  capability?: string;
  input: ExecuteStepInput;   // 同 step.before_execute.input
}
```

---

## 6. 插件 SDK 参考（index.js 中的 `pi` 对象）

插件入口函数接收 `pi` 对象，提供以下 API：

### 6.1 事件监听

```javascript
// 注册 hook handler
pi.on(hookName, handler, options?)

// hookName: 上述 17 个 hook 之一
// handler: (payload) => void | { action, ... }
// options: { id?: string, priority?: number }
//   priority 越大越先执行，默认 0
```

### 6.2 LLM Provider

```javascript
// 注册/替换 LLM 路由
pi.registerProvider(providerId, {
  resolveRequestUrl(route) {
    // route 包含 llmBase, llmKey, llmModel 等
    return route.llmBase + "/chat/completions";
  },
  async send(input) {
    // input 包含 payload, signal, route, requestUrl
    return await fetch(input.requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + input.route.llmKey
      },
      body: JSON.stringify(input.payload),
      signal: input.signal
    });
  }
});
```

### 6.3 Tool Contract

```javascript
// 注册新工具给 LLM
pi.registerTool({
  name: "my_custom_tool",
  description: "描述这个工具做什么（LLM 会读这段描述来决定是否调用）",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "查询内容" }
    },
    required: ["query"]
  },
  execution: {
    capability: "process.exec",
    mode: "script",
    verifyPolicy: "off"
  }
});
```

### 6.4 Capability Policy

```javascript
// 修改能力执行策略
pi.registerCapabilityPolicy("browser.action", {
  defaultVerifyPolicy: "always",   // "off" | "on_critical" | "always"
  leasePolicy: "required"          // "auto" | "required" | "none"
});
```

### 6.5 Runtime Message（SW → Panel 通信）

```javascript
// 从插件向 Panel 发送消息
chrome.runtime.sendMessage({
  type: "bbloop.global.message",      // 需在 permissions.runtimeMessages 声明
  payload: {
    kind: "success",                  // "success" | "error" | "info" | "warning"
    message: "操作完成！",
    source: "plugin.user.my-plugin"
  }
}).catch(() => {});
```

### 6.6 Mode / Capability Provider（高级）

```javascript
// 替换工具执行通道（需要 replaceProviders 权限）
pi.registerModeProvider("script", {
  id: "my-script-provider",
  async execute(input) { /* ... */ }
});

// 注册能力执行者
pi.registerCapabilityProvider("browser.action", {
  id: "my-browser-action",
  async execute(input) { /* ... */ }
});
```

---

## 7. 内置 Capability 与 Policy 速查

| Capability | 含义 | 默认 Verify | 默认 Lease |
|------------|------|------------|-----------|
| `process.exec` | 执行 shell 命令 | off | none |
| `fs.read` | 读取文件 | off | none |
| `fs.write` | 写入文件 | off | none |
| `fs.edit` | 编辑文件 | off | none |
| `browser.snapshot` | 获取页面快照 | off | none |
| `browser.action` | 浏览器操作（点击/填写/滚动等） | on_critical | auto |
| `browser.verify` | 验证操作结果 | always | none |

---

## 8. 教程式示例

### 8.1 最简插件：运行完成时发通知

**需求**：每次 Agent 完成任务后，在 SidePanel 弹出一个成功通知。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.complete-notify",
    "name": "complete-notify",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["agent_end.after"],
      "runtimeMessages": ["bbloop.global.message"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  pi.on("agent_end.after", (payload) => {
    chrome.runtime.sendMessage({
      type: "bbloop.global.message",
      payload: {
        kind: "success",
        message: "✅ Agent 任务完成",
        source: "plugin.user.complete-notify"
      }
    }).catch(() => {});
  });
};
```

**为什么这样写？**
- `agent_end.after` 在 Agent 完全结束后触发，是发通知的最佳时机
- `bbloop.global.message` 是系统内置的通知消息类型，Panel 会自动渲染
- `permissions.hooks` 必须声明 `agent_end.after`，否则 hook 不会注册
- `permissions.runtimeMessages` 必须声明 `bbloop.global.message`，否则消息会被静默丢弃

---

### 8.2 进阶：步骤级反馈 HUD（小狗 HUD 的简化版）

**需求**：在 Agent 执行工具时显示当前状态（思考中/执行中/完成）。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.step-hud",
    "name": "step-hud",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["tool.before_call", "step.after_execute", "agent_end.after"],
      "runtimeMessages": ["bbloop.ui.mascot"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  // 工具即将被调用 → 显示"执行中"
  pi.on("tool.before_call", (payload) => {
    chrome.runtime.sendMessage({
      type: "bbloop.ui.mascot",
      payload: {
        mood: "acting",
        label: "正在执行: " + String(payload.input?.action || "unknown")
      }
    }).catch(() => {});
  });

  // 步骤执行完成 → 显示结果
  pi.on("step.after_execute", (payload) => {
    const ok = payload.result?.ok;
    chrome.runtime.sendMessage({
      type: "bbloop.ui.mascot",
      payload: {
        mood: ok ? "happy" : "error",
        label: ok ? "步骤成功 ✓" : "步骤失败 ✗"
      }
    }).catch(() => {});
  });

  // Agent 结束 → 显示完成
  pi.on("agent_end.after", () => {
    chrome.runtime.sendMessage({
      type: "bbloop.ui.mascot",
      payload: { mood: "idle", label: "任务完成" }
    }).catch(() => {});
  });
};
```

**学习要点**：
- 一个插件可以监听多个 hook，组合出流程级的行为
- `tool.before_call` → `step.after_execute` → `agent_end.after` 是最常用的"执行流程"hook 组合
- `bbloop.ui.mascot` 是系统内置的 HUD 消息类型

---

### 8.3 LLM 路由：接入私有 API

**需求**：把 LLM 请求路由到企业内部的代理服务器。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.company.llm-proxy",
    "name": "company-llm-proxy",
    "version": "1.0.0",
    "permissions": {
      "llmProviders": ["openai_compatible"],
      "replaceLlmProviders": true
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  pi.registerProvider("openai_compatible", {
    resolveRequestUrl(route) {
      // 替换 base URL 为企业代理
      return "https://llm-proxy.internal.company.com/v1/chat/completions";
    },
    async send(input) {
      return await fetch(input.requestUrl || this.resolveRequestUrl(input.route), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer " + input.route.llmKey,
          "x-company-auth": "internal-token-here"
        },
        body: JSON.stringify(input.payload),
        signal: input.signal
      });
    }
  });
};
```

**注意**：
- `replaceLlmProviders: true` 授权覆盖系统默认的 `openai_compatible` provider
- 卸载或禁用插件后，系统自动恢复原始 provider（这是插件 runtime 的内置保障）

---

### 8.4 自定义工具：让 Agent 拥有新能力

**需求**：注册一个 `check_weather` 工具，LLM 可以在对话中调用。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.weather-tool",
    "name": "weather-tool",
    "version": "1.0.0",
    "permissions": {
      "tools": ["check_weather"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  pi.registerTool({
    name: "check_weather",
    description: "查询指定城市的天气信息",
    parameters: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "城市名称，如 '北京'、'上海'"
        }
      },
      required: ["city"]
    },
    execution: {
      capability: "process.exec",
      mode: "script"
    }
  });
};
```

---

## 9. AI 辅助创建工作流

### 9.1 用户 → AI 的典型对话

```
用户：帮我写一个插件，每次 Agent 开始执行任务时在控制台打印一条日志

AI（参考本文档）：
  - 选择 hook: runtime.route.after（监听 brain.run.start 消息）
  - 生成 plugin.json + index.js
  - 告知用户在 Plugin Studio 中注册
```

### 9.2 AI 生成插件的决策树

```
用户需求是什么？
├── "在某个时机执行某个动作" 
│   → 选择合适的 Hook（参考 §5.1 Hook 分类）
│   → 生成 pi.on(hook, handler)
│
├── "接入私有 LLM API"
│   → 使用 pi.registerProvider
│   → 设置 replaceLlmProviders 权限
│
├── "给 Agent 增加新工具"
│   → 使用 pi.registerTool
│   → 定义 JSON Schema 参数
│
├── "修改 Agent 的校验策略"
│   → 使用 pi.registerCapabilityPolicy
│   → 选择 verify policy 和 lease policy
│
└── "在 Panel 中显示自定义 UI"
    → 额外编写 ui.js
    → 在 plugin.json 中声明 uiModulePath
```

### 9.3 常用 Hook 选择指南

| 用户意图 | 推荐 Hook | 说明 |
|---------|-----------|------|
| "任务完成时做某事" | `agent_end.after` | Agent 运行完全结束 |
| "每一步执行后做某事" | `step.after_execute` | 每个工具调用完成 |
| "工具调用前检查/拦截" | `tool.before_call` | 工具即将执行 |
| "修改发给 LLM 的请求" | `llm.before_request` | 请求发出前 |
| "处理 LLM 返回结果" | `llm.after_response` | 收到响应后 |
| "监听所有系统消息" | `runtime.route.after` | 最通用的全局监听 |
| "在压缩前做处理" | `compaction.before` | 上下文即将压缩 |

---

## 10. UI Extension 参考（ui.js 中的 `ui` 对象）

UI 插件运行在 Panel（SidePanel）侧，可以拦截和修改 UI 的渲染行为。UI 插件通过 `uiModulePath` + `uiExportName` 声明，入口函数接收 `ui` 对象。

### 10.1 UI Hook 分类

**13 个 UI Hook**，按功能分为 5 组：

#### 通知（1 个）

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `ui.notice.before_show` | 通知弹出前 | 修改通知样式/内容、去重、阻止弹出 |

#### 消息渲染（4 个）

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `ui.message.before_render` | 每条消息渲染前 | 修改/隐藏单条消息 |
| `ui.message.list.before_render` | 消息列表整体渲染前 | 操作整个消息列表（排序/过滤） |
| `ui.tool.call.before_render` | 工具调用部分渲染前 | 修改工具调用的显示 |
| `ui.tool.result.before_render` | 工具结果部分渲染前 | 修改工具结果的显示 |

#### 输入框（3 个）

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `ui.chat_input.before_send` | 用户发送消息前 | 拦截/修改消息内容、阻止发送 |
| `ui.chat_input.after_send` | 消息成功发送后 | 发送后的副作用（统计/通知） |
| `ui.chat_input.before_render` | 输入框渲染状态重建时 | 修改 placeholder/disabled 状态 |

#### 会话（2 个）

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `ui.session.changed` | 活跃会话切换时 | 会话切换时的清理/初始化 |
| `ui.session.list.before_render` | 会话列表渲染前 | 修改会话列表显示（排序/标记） |

#### 布局（3 个）

| Hook | 触发时机 | 典型用途 |
|------|---------|---------|
| `ui.header.before_render` | 顶部 Header 渲染状态重建时 | 修改标题/状态显示 |
| `ui.queue.before_render` | 队列区渲染前 | 修改排队消息的显示 |
| `ui.runtime.event` | 每条 SW runtime 消息到达 Panel 时 | ✅ **全局消息拦截器（最常用）** |

### 10.2 UI Hook Payload 结构

#### ui.notice.before_show

```typescript
{
  type: "success" | "error";   // 通知类型
  message: string;              // 通知文本
  source?: string;              // 来源插件 ID
  sessionId?: string;           // 关联会话
  durationMs?: number;          // 显示时长（ms）
  dedupeKey?: string;           // 去重键
  ts?: string;                  // 时间戳
}
```

#### ui.runtime.event

```typescript
{
  type: string;       // 原始 runtime 消息的 type（如 "bbloop.ui.mascot"）
  message: unknown;   // 完整的原始 runtime 消息对象
}
```

#### ui.session.changed

```typescript
{
  sessionId: string;           // 新的活跃会话 ID
  previousSessionId: string;   // 之前的会话 ID
  reason?: string;             // 切换原因
}
```

#### ui.chat_input.before_send / after_send

```typescript
{
  text: string;                               // 用户输入的文本
  tabIds: number[];                           // 关联的 tab ID 列表
  skillIds: string[];                         // 关联的 skill ID 列表
  contextRefs: Array<Record<string, unknown>>; // 上下文引用
  mode: "normal" | "steer" | "followUp";      // 发送模式
  sessionId?: string;                         // 目标会话
}
```

#### ui.chat_input.before_render

```typescript
{
  sessionId?: string;
  text: string;           // 当前输入框文本
  placeholder: string;    // 占位文本
  disabled: boolean;      // 是否禁用
  isRunning: boolean;     // Agent 是否正在运行
  isCompacting: boolean;  // 是否正在压缩
  isStartingRun: boolean; // 是否正在启动
}
```

#### ui.message.before_render

```typescript
{
  role: string;          // "user" | "assistant" | "system" | "tool"
  content: string;       // 消息内容
  entryId: string;       // 消息条目 ID
  toolName?: string;     // 工具名（如果是 tool 类消息）
  toolCallId?: string;   // tool_call ID
}
```

#### ui.message.list.before_render

```typescript
{
  sessionId?: string;
  isRunning: boolean;
  messages: Array<{      // 所有消息的 render payload
    role: string;
    content: string;
    entryId: string;
    toolName?: string;
    toolCallId?: string;
  }>;
}
```

#### ui.tool.call.before_render / ui.tool.result.before_render

```typescript
{
  toolName: string;     // 工具名称
  toolCallId: string;   // tool_call ID
  content: string;      // 调用参数或结果的文本
}
```

#### ui.header.before_render

```typescript
{
  sessionId?: string;
  title: string;                   // 顶部标题文本
  isRunning: boolean;
  isCompacting: boolean;
  forkedFromSessionId?: string;    // 如果是 fork 出的会话
}
```

#### ui.session.list.before_render

```typescript
{
  sessions: Array<{
    id: string;
    title: string;
    updatedAt?: string;
    parentSessionId?: string;
    forkedFromSessionId?: string;
  }>;
  activeId: string;
  isOpen: boolean;
  loading?: boolean;
}
```

#### ui.queue.before_render

```typescript
{
  sessionId?: string;
  items: Array<{
    id: string;
    behavior: "steer" | "followUp";
    text: string;
  }>;
  state: {
    steer: number;
    followUp: number;
    total: number;
  };
}
```

### 10.3 UI Hook Handler 协议

与 SW 侧 hook 相同的三种返回值：

```javascript
// 放行（最常用）
ui.on("ui.runtime.event", (event) => {
  return { action: "continue" };
});

// 修改（patch）
ui.on("ui.notice.before_show", (event) => {
  return {
    action: "patch",
    patch: {
      type: "success",
      durationMs: 3000,
      message: "自定义通知: " + event.message
    }
  };
});

// 阻止（block）
ui.on("ui.chat_input.before_send", (event) => {
  if (event.text.includes("危险操作")) {
    return { action: "block", reason: "包含敏感内容" };
  }
});
```

### 10.4 常用 UI Hook 选择指南

| 用户意图 | 推荐 UI Hook | 说明 |
|---------|-------------|------|
| "定制通知弹窗样式" | `ui.notice.before_show` | 修改 type/message/duration |
| "拦截用户输入" | `ui.chat_input.before_send` | 可 block 阻止发送 |
| "监听所有 SW 消息" | `ui.runtime.event` | Panel 侧全局消息拦截 |
| "隐藏某类消息" | `ui.message.before_render` | block 阻止渲染 |
| "修改消息显示" | `ui.message.before_render` | patch content |
| "修改工具调用显示" | `ui.tool.call.before_render` | patch 工具参数展示 |
| "修改工具结果显示" | `ui.tool.result.before_render` | patch 结果展示 |
| "自定义输入框状态" | `ui.chat_input.before_render` | 修改 placeholder/disabled |
| "会话切换时执行逻辑" | `ui.session.changed` | 清理/初始化 |

### 10.5 UI Extension 创意示例

#### 示例 A：敏感词过滤器

用户发送消息前检查是否包含敏感关键词。

```javascript
// ui.js
module.exports = function registerPlugin(ui) {
  const SENSITIVE_WORDS = ["密码", "token", "secret", "私钥"];

  ui.on("ui.chat_input.before_send", (event) => {
    const text = String(event.text || "");
    for (const word of SENSITIVE_WORDS) {
      if (text.includes(word)) {
        return {
          action: "block",
          reason: "消息包含敏感词「" + word + "」，已阻止发送"
        };
      }
    }
  });
};
```

#### 示例 B：消息角色高亮器

修改消息渲染，给不同角色加前缀标记。

```javascript
// ui.js
module.exports = function registerPlugin(ui) {
  ui.on("ui.message.before_render", (event) => {
    const role = String(event.role || "");
    if (role === "tool") {
      return {
        action: "patch",
        patch: {
          content: "🔧 " + event.content
        }
      };
    }
    if (role === "system") {
      return {
        action: "patch",
        patch: {
          content: "⚙️ " + event.content
        }
      };
    }
  });
};
```

#### 示例 C：会话标题自动标注

在会话列表中为正在运行的会话加上动态标记。

```javascript
// ui.js
module.exports = function registerPlugin(ui) {
  ui.on("ui.session.list.before_render", (event) => {
    const sessions = (event.sessions || []).map(s => ({
      ...s,
      title: s.id === event.activeId && event.loading
        ? "⏳ " + s.title
        : s.title
    }));
    return {
      action: "patch",
      patch: { sessions }
    };
  });
};
```

#### 示例 D：工具调用简化显示

把工具调用参数的 JSON 简化为一行摘要。

```javascript
// ui.js
module.exports = function registerPlugin(ui) {
  ui.on("ui.tool.call.before_render", (event) => {
    const name = String(event.toolName || "");
    let summary = "";
    try {
      const args = JSON.parse(event.content || "{}");
      const keys = Object.keys(args).slice(0, 3);
      summary = keys.map(k => k + "=" + JSON.stringify(args[k]).slice(0, 30)).join(", ");
    } catch {
      summary = event.content;
    }
    return {
      action: "patch",
      patch: {
        content: name + "(" + summary + ")"
      }
    };
  });
};
```

---

## 11. Plugin Studio 改进方向

### 10.1 当前 Studio 的价值

- 三文件编辑（plugin.json / index.js / ui.js）
- 一键注册启用
- 4 种日志面板（runtime / brain / trigger / hookTrace）
- 项目管理（localStorage 持久化）

### 10.2 优先改进

| 优先级 | 改进 | 理由 |
|--------|------|------|
| P0 | 在 Hook 选择处内嵌 §5 的文档摘要 | 核心可发现性问题，参考 VSCode "IntelliSense" 的思路 |
| P0 | 编辑区切换到 CodeMirror/Monaco 替代 textarea | 基本的代码高亮和缩进 |
| P1 | 提供"从自然语言创建"入口——用户输入需求描述，交给 AI 生成 plugin 三件套 | 这是核心产品差异化 |
| P1 | 注册失败时的错误信息增强——精确到哪个字段、什么原因 | 调试效率 |
| P2 | 一键导出为 `.zip` / 一键导入 | 分享与备份 |
| P2 | 示例项目标注"学习路径"顺序 | 渐进式学习 |

---

## 12. permissions 的作用机制

当前 permissions 是**声明式白名单**：

- `permissions.hooks`：只有声明了的 hook 名，`pi.on()` 才会生效
- `permissions.runtimeMessages`：只有声明了的消息类型，`chrome.runtime.sendMessage()` 才会被转发
- `permissions.brainEvents`：声明插件会发出的事件类型（元信息，当前不做强制拦截）
- `permissions.tools`：声明要注册的工具名
- `permissions.llmProviders`：声明要注册的 LLM provider ID
- `permissions.capabilities`：声明要注册 policy 的能力名
- `permissions.modes`：声明要注册 provider 的执行模式
- `permissions.replaceProviders`：是否允许覆盖已有 mode/capability provider（默认 false）
- `permissions.replaceToolContracts`：是否允许覆盖已有 tool contract（默认 false）
- `permissions.replaceLlmProviders`：是否允许覆盖已有 LLM provider（默认 false）

**易错点**：忘记在 permissions 中声明 hook 或 runtimeMessage 会导致**静默失败**——插件注册成功但 hook 不触发、消息不送达。这是最常见的调试问题。

---

## 13. 创意插件示例库

> 以下示例均属于 **Plugin 专属领域**——通过系统级 Hook/Policy/Provider 实现，Skill 无法替代。
> 每个示例包含：产品场景、为什么是 Plugin 而不是 Skill、完整代码。

---

### 13.1 🛡️ Token 预算守卫

**场景**：控制每日 LLM API 消耗，避免意外高额账单。

**为什么是 Plugin**：需要拦截每一次 LLM 请求和响应来统计 token——这是系统级的流量控制，Skill（知识包）无法触及 LLM 传输层。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.token-budget-guard",
    "name": "token-budget-guard",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["llm.before_request", "llm.after_response"],
      "runtimeMessages": ["bbloop.global.message"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  const DAILY_BUDGET = 100000; // 每日 10 万 token
  let usedTokens = 0;
  let lastResetDate = new Date().toDateString();

  function resetIfNewDay() {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
      usedTokens = 0;
      lastResetDate = today;
    }
  }

  // 请求前：检查预算
  pi.on("llm.before_request", () => {
    resetIfNewDay();
    if (usedTokens >= DAILY_BUDGET) {
      chrome.runtime.sendMessage({
        type: "bbloop.global.message",
        payload: {
          kind: "error",
          message: "⚠️ 今日 Token 预算已耗尽（" + usedTokens + "/" + DAILY_BUDGET + "）",
          source: "plugin.user.token-budget-guard"
        }
      }).catch(() => {});
      return { action: "block", reason: "token budget exceeded" };
    }
  });

  // 响应后：累加 token
  pi.on("llm.after_response", (payload) => {
    resetIfNewDay();
    const response = payload.response || {};
    const usage = response.usage || {};
    const totalTokens = Number(usage.total_tokens || 0);
    usedTokens += totalTokens;
    if (usedTokens > DAILY_BUDGET * 0.8) {
      chrome.runtime.sendMessage({
        type: "bbloop.global.message",
        payload: {
          kind: "warning",
          message: "Token 预算已使用 " + Math.round(usedTokens / DAILY_BUDGET * 100) + "%",
          source: "plugin.user.token-budget-guard"
        }
      }).catch(() => {});
    }
  });
};
```

---

### 13.2 🚧 工具安全门

**场景**：在 Agent 自主执行时，禁止特定危险工具或限制操作范围。

**为什么是 Plugin**：需要在工具调用前拦截——这是内核执行链的前置守卫，Skill 无法阻止工具被调用。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.tool-safety-gate",
    "name": "tool-safety-gate",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["tool.before_call"],
      "runtimeMessages": ["bbloop.global.message"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  // 被禁止的工具列表
  const BLOCKED_TOOLS = ["host_bash", "host_write_file", "host_edit_file"];
  // 被禁止的导航域名
  const BLOCKED_DOMAINS = ["admin.example.com", "billing.stripe.com"];

  pi.on("tool.before_call", (payload) => {
    const action = String(payload.input?.action || "").trim();

    // 直接封禁危险工具
    if (BLOCKED_TOOLS.includes(action)) {
      chrome.runtime.sendMessage({
        type: "bbloop.global.message",
        payload: {
          kind: "warning",
          message: "🚧 已拦截危险工具: " + action,
          source: "plugin.user.tool-safety-gate"
        }
      }).catch(() => {});
      return { action: "block", reason: "tool blocked by safety gate: " + action };
    }

    // 拦截导航到敏感域名
    if (action === "navigate_tab") {
      const url = String(payload.input?.args?.url || "");
      for (const domain of BLOCKED_DOMAINS) {
        if (url.includes(domain)) {
          return { action: "block", reason: "navigation to " + domain + " blocked" };
        }
      }
    }
  });
};
```

---

### 13.3 🧠 智能模型路由

**场景**：简单任务用便宜模型，复杂任务用强模型，自动判断。

**为什么是 Plugin**：需要拦截 LLM 请求并修改 model 参数——这是 LLM 传输层的动态路由，Skill 无法修改即将发出的请求 payload。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.smart-model-router",
    "name": "smart-model-router",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["llm.before_request"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  const LIGHT_MODEL = "gpt-4o-mini";
  const HEAVY_MODEL = "gpt-5.3-codex";
  const TOOL_CALL_THRESHOLD = 3;
  const MESSAGE_LENGTH_THRESHOLD = 2000;

  pi.on("llm.before_request", (payload) => {
    const request = payload.request || {};
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const tools = Array.isArray(request.tools) ? request.tools : [];

    // 判断复杂度
    const totalLength = messages.reduce((sum, m) => {
      return sum + String(m.content || "").length;
    }, 0);
    const isComplex = tools.length > TOOL_CALL_THRESHOLD || totalLength > MESSAGE_LENGTH_THRESHOLD;

    return {
      action: "patch",
      patch: {
        request: {
          ...request,
          model: isComplex ? HEAVY_MODEL : LIGHT_MODEL
        }
      }
    };
  });
};
```

---

### 13.4 ⏱️ 任务计时器

**场景**：显示每个步骤的耗时和总任务时间，帮助用户感知 Agent 的效率。

**为什么是 Plugin**：需要跨步骤追踪时间状态 + 通过 runtime message 驱动 UI 反馈——Skill 没有步骤粒度的生命周期感知。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.mission-timer",
    "name": "mission-timer",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["runtime.route.after", "step.before_execute", "step.after_execute", "agent_end.after"],
      "runtimeMessages": ["bbloop.global.message"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  let missionStart = 0;
  let stepStart = 0;
  let stepCount = 0;

  pi.on("runtime.route.after", (event) => {
    if (String(event?.type || "") === "brain.run.start") {
      missionStart = Date.now();
      stepCount = 0;
    }
  });

  pi.on("step.before_execute", () => {
    stepStart = Date.now();
    stepCount += 1;
  });

  pi.on("step.after_execute", (payload) => {
    const stepMs = Date.now() - stepStart;
    const totalMs = Date.now() - missionStart;
    const action = String(payload.input?.action || "step");
    chrome.runtime.sendMessage({
      type: "bbloop.global.message",
      payload: {
        kind: "info",
        message: "#" + stepCount + " " + action + " " + (stepMs / 1000).toFixed(1) + "s · 总计 " + (totalMs / 1000).toFixed(1) + "s",
        source: "plugin.user.mission-timer"
      }
    }).catch(() => {});
  });

  pi.on("agent_end.after", () => {
    if (!missionStart) return;
    const totalMs = Date.now() - missionStart;
    chrome.runtime.sendMessage({
      type: "bbloop.global.message",
      payload: {
        kind: "success",
        message: "🏁 任务完成：" + stepCount + " 步 · " + (totalMs / 1000).toFixed(1) + "s",
        source: "plugin.user.mission-timer"
      }
    }).catch(() => {});
    missionStart = 0;
  });
};
```

---

### 13.5 📋 动作审计日志

**场景**：记录 Agent 的每一步操作，生成可审阅的操作报告。适用于团队审计、合规要求、或复盘 Agent 行为。

**为什么是 Plugin**：需要拦截每个工具调用和结果——这是跨步骤的系统级日志，Skill 只能在对话层面工作。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.action-audit-log",
    "name": "action-audit-log",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["tool.before_call", "step.after_execute", "agent_end.after"],
      "runtimeMessages": ["bbloop.global.message"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  const log = [];

  pi.on("tool.before_call", (payload) => {
    log.push({
      ts: new Date().toISOString(),
      event: "tool_call",
      action: String(payload.input?.action || ""),
      mode: String(payload.mode || ""),
      capability: String(payload.capability || ""),
      args: payload.input?.args || {}
    });
  });

  pi.on("step.after_execute", (payload) => {
    log.push({
      ts: new Date().toISOString(),
      event: "step_result",
      action: String(payload.input?.action || ""),
      ok: payload.result?.ok === true,
      verified: payload.result?.verified === true,
      error: payload.result?.error || null
    });
  });

  pi.on("agent_end.after", () => {
    const summary = log.map((entry, i) => {
      if (entry.event === "tool_call") {
        return "[" + (i + 1) + "] → " + entry.action + " (" + entry.mode + ")";
      }
      return "[" + (i + 1) + "] " + (entry.ok ? "✓" : "✗") + " " + entry.action + (entry.error ? " — " + entry.error : "");
    }).join("\n");

    chrome.runtime.sendMessage({
      type: "bbloop.global.message",
      payload: {
        kind: "info",
        message: "📋 审计日志：" + log.length + " 条记录已生成",
        source: "plugin.user.action-audit-log"
      }
    }).catch(() => {});

    // 重置
    log.length = 0;
  });
};
```

---

### 13.6 🔄 Prompt 注入器

**场景**：在每次 LLM 请求中自动注入额外的系统指令（日期、用户偏好、安全规则等）。

**为什么是 Plugin**：需要修改实际发送给 LLM 的 messages 数组——Skill 只能通过 `<skill>` prompt block 注入静态文本，无法动态修改每个请求。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.prompt-injector",
    "name": "prompt-injector",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["llm.before_request"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  pi.on("llm.before_request", (payload) => {
    const request = payload.request || {};
    const messages = Array.isArray(request.messages) ? [...request.messages] : [];

    // 找到第一条 system message 并追加自定义指令
    const systemIdx = messages.findIndex(m => m.role === "system");
    const customRules = [
      "当前时间: " + new Date().toLocaleString("zh-CN"),
      "用户偏好: 回复用中文，代码注释用英文",
      "安全规则: 不要执行 rm -rf 或 DROP TABLE 命令"
    ].join("\n");

    if (systemIdx >= 0) {
      messages[systemIdx] = {
        ...messages[systemIdx],
        content: String(messages[systemIdx].content || "") + "\n\n[插件注入]\n" + customRules
      };
    } else {
      messages.unshift({
        role: "system",
        content: "[插件注入]\n" + customRules
      });
    }

    return {
      action: "patch",
      patch: { request: { ...request, messages } }
    };
  });
};
```

---

### 13.7 🔇 静默模式

**场景**：临时禁用所有操作的验证（verify），让 Agent 快速执行探索性任务，不被验证步骤拖慢。

**为什么是 Plugin**：需要修改 Capability Policy——这是系统级的策略配置，Skill 无法改变执行引擎的验证行为。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.silent-mode",
    "name": "silent-mode",
    "version": "1.0.0",
    "permissions": {
      "capabilities": ["browser.action", "browser.verify"],
      "replaceProviders": true
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  // 把 browser.action 的验证完全关闭
  pi.registerCapabilityPolicy("browser.action", {
    defaultVerifyPolicy: "off",
    leasePolicy: "none"
  });

  // browser.verify 也改为 off
  pi.registerCapabilityPolicy("browser.verify", {
    defaultVerifyPolicy: "off",
    leasePolicy: "none"
  });
};
```

**使用方式**：需要快速执行时启用插件，需要严格校验时禁用。禁用后系统自动恢复原始策略。

---

### 13.8 🌊 LLM 响应流水印

**场景**：在 LLM 响应中自动追加来源标记，标明使用了哪个模型、消耗了多少 token。适用于需要追踪 AI 输出来源的团队。

**为什么是 Plugin**：需要拦截 LLM 响应——Skill 无法接触到响应的元数据层。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.response-watermark",
    "name": "response-watermark",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["llm.after_response"],
      "runtimeMessages": ["bbloop.global.message"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  pi.on("llm.after_response", (payload) => {
    const response = payload.response || {};
    const model = String(response.model || "unknown");
    const usage = response.usage || {};
    const promptTokens = Number(usage.prompt_tokens || 0);
    const completionTokens = Number(usage.completion_tokens || 0);

    chrome.runtime.sendMessage({
      type: "bbloop.global.message",
      payload: {
        kind: "info",
        message: "🏷️ " + model + " · ↑" + promptTokens + " ↓" + completionTokens + " tokens",
        source: "plugin.user.response-watermark"
      }
    }).catch(() => {});
  });
};
```

---

### 13.9 🧩 上下文压缩策略定制

**场景**：自定义什么时候触发上下文压缩、压缩摘要如何生成——比如保留所有工具调用结果，只压缩闲聊。

**为什么是 Plugin**：Compaction hooks 是唯一能介入上下文压缩流程的方式——Skill 无法影响记忆管理。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.compaction-strategy",
    "name": "compaction-strategy",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["compaction.check.before", "compaction.summary"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  // 只在 agent_end 时压缩，不在 pre_send 时压缩（避免中途丢失上下文）
  pi.on("compaction.check.before", (payload) => {
    if (payload.source === "pre_send") {
      return {
        action: "patch",
        patch: { shouldCompact: false }
      };
    }
  });

  // 修改压缩 prompt：要求保留工具调用结果
  pi.on("compaction.summary", (payload) => {
    return {
      action: "patch",
      patch: {
        promptText: payload.promptText + "\n\n重要：在摘要中必须保留所有工具调用的名称和关键结果数据，可以压缩闲聊和思考过程。"
      }
    };
  });
};
```

---

### 13.10 🎵 声效反馈

**场景**：Agent 执行步骤时播放声效——操作成功/失败/完成各有不同音效。

**为什么是 Plugin**：需要在步骤级 hook 中触发浏览器 Audio API——Skill 无法感知步骤结果，更无法控制浏览器音频。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.sound-fx",
    "name": "sound-fx",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["step.after_execute", "agent_end.after"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  // 使用 Web Audio API 生成简单音效（不依赖外部文件）
  function beep(freq, duration, type) {
    try {
      const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = type || "sine";
      gain.gain.value = 0.08;
      osc.start();
      osc.stop(ctx.currentTime + duration / 1000);
    } catch {}
  }

  pi.on("step.after_execute", (payload) => {
    if (payload.result?.ok) {
      beep(880, 100, "sine");      // 成功：高音短促
    } else {
      beep(220, 300, "sawtooth");  // 失败：低音长鸣
    }
  });

  pi.on("agent_end.after", () => {
    // 完成：三连音
    beep(523, 150, "sine");
    setTimeout(() => beep(659, 150, "sine"), 180);
    setTimeout(() => beep(784, 200, "sine"), 360);
  });
};
```

> **注意**：Service Worker 环境下 AudioContext 可能不可用。此插件更适合作为 UI Extension（ui.js）运行，因为 Panel 侧有完整的 Web Audio API。

---

### 13.11 🔍 LLM 请求/响应检查器

**场景**：把每次 LLM 请求和响应的摘要信息实时推送到 Panel，让用户能透视 Agent 的"思考过程"。

**为什么是 Plugin**：需要拦截 LLM 传输层——Skill 只能看到 Agent 的最终输出，看不到中间的 LLM 通信。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.llm-inspector",
    "name": "llm-inspector",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["llm.before_request", "llm.after_response"],
      "runtimeMessages": ["bbloop.global.message"]
    }
  }
}
```

**index.js**
```javascript
module.exports = function registerPlugin(pi) {
  let requestCount = 0;

  pi.on("llm.before_request", (payload) => {
    requestCount += 1;
    const request = payload.request || {};
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const tools = Array.isArray(request.tools) ? request.tools : [];

    chrome.runtime.sendMessage({
      type: "bbloop.global.message",
      payload: {
        kind: "info",
        message: "🔍 LLM #" + requestCount + " → " + messages.length + " msgs · " + tools.length + " tools · model: " + String(request.model || "?"),
        source: "plugin.user.llm-inspector"
      }
    }).catch(() => {});
  });

  pi.on("llm.after_response", (payload) => {
    const response = payload.response || {};
    const usage = response.usage || {};
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const firstChoice = choices[0] || {};
    const finishReason = String(firstChoice.finish_reason || "?");
    const toolCalls = Array.isArray(firstChoice.message?.tool_calls) ? firstChoice.message.tool_calls : [];

    chrome.runtime.sendMessage({
      type: "bbloop.global.message",
      payload: {
        kind: "info",
        message: "🔍 LLM #" + requestCount + " ← " + finishReason + (toolCalls.length > 0 ? " · " + toolCalls.length + " tool_calls" : "") + " · " + (usage.total_tokens || "?") + " tokens",
        source: "plugin.user.llm-inspector"
      }
    }).catch(() => {});
  });
};
```

---

### 13.12 🎨 UI Extension 完整示例：任务进度条

**场景**：在 SidePanel 中显示 Agent 任务的实时进度条——展示当前步骤编号、成功/失败比例、预计剩余时间。

**为什么是 Plugin**：需要 index.js（SW 侧 hook 收集数据）+ ui.js（Panel 侧渲染 UI）的双模块协作——Skill 没有 UI 能力。

**plugin.json**
```json
{
  "manifest": {
    "id": "plugin.user.progress-bar",
    "name": "progress-bar",
    "version": "1.0.0",
    "permissions": {
      "hooks": ["runtime.route.after", "step.after_execute", "agent_end.after"],
      "runtimeMessages": ["bbloop.ui.progress"]
    }
  },
  "uiModulePath": "ui.js",
  "uiExportName": "default"
}
```

**index.js**（SW 侧：收集步骤数据，推送给 Panel）
```javascript
module.exports = function registerPlugin(pi) {
  let startTime = 0;
  let steps = 0;
  let successes = 0;
  let failures = 0;

  function emitProgress(phase) {
    const elapsed = Date.now() - startTime;
    chrome.runtime.sendMessage({
      type: "bbloop.ui.progress",
      payload: {
        phase,
        steps,
        successes,
        failures,
        elapsedMs: elapsed,
        avgStepMs: steps > 0 ? Math.round(elapsed / steps) : 0,
        source: "plugin.user.progress-bar"
      }
    }).catch(() => {});
  }

  pi.on("runtime.route.after", (event) => {
    if (String(event?.type || "") !== "brain.run.start") return;
    startTime = Date.now();
    steps = 0;
    successes = 0;
    failures = 0;
    emitProgress("started");
  });

  pi.on("step.after_execute", (payload) => {
    steps += 1;
    if (payload.result?.ok) successes += 1;
    else failures += 1;
    emitProgress("step");
  });

  pi.on("agent_end.after", () => {
    emitProgress("done");
  });
};
```

**ui.js**（Panel 侧：接收数据，控制 UI 渲染）
```javascript
module.exports = function registerProgressBarUi(ui) {
  // 监听来自 SW 的进度消息
  ui.on("ui.runtime.event", (event) => {
    const message = event?.message || {};
    if (String(message.type || "") !== "bbloop.ui.progress") {
      return { action: "continue" };
    }

    const payload = message.payload || {};
    const phase = String(payload.phase || "");
    const steps = Number(payload.steps || 0);
    const successes = Number(payload.successes || 0);
    const failures = Number(payload.failures || 0);
    const elapsedMs = Number(payload.elapsedMs || 0);
    const avgStepMs = Number(payload.avgStepMs || 0);

    // 通过 patch 把进度信息传递给 UI 层渲染
    // 实际渲染由 Panel 的消息处理器完成
    // 这里的 patch 可以修改消息展示方式
    if (phase === "done") {
      const successRate = steps > 0 ? Math.round(successes / steps * 100) : 0;
      return {
        action: "patch",
        patch: {
          message: {
            ...message,
            payload: {
              ...payload,
              summary: "✅ " + steps + "步 · 成功率" + successRate + "% · 耗时" + (elapsedMs / 1000).toFixed(1) + "s"
            }
          }
        }
      };
    }

    return { action: "continue" };
  });
};
```

---

### 示例分类索引

| 示例 | 类别 | 核心 Hook | 难度 | 独特价值 |
|------|------|----------|------|---------|
| Token 预算守卫 | 🛡️ 成本控制 | `llm.before_request` + `llm.after_response` | 中 | 防超支 |
| 工具安全门 | 🛡️ 安全 | `tool.before_call` | 低 | 防误操作 |
| 智能模型路由 | 🧠 优化 | `llm.before_request` | 中 | 降成本提速 |
| 任务计时器 | ⏱️ 可观测 | `step.*` + `agent_end.after` | 低 | 效率感知 |
| 动作审计日志 | 📋 合规 | `tool.*` + `step.*` | 中 | 审计追溯 |
| Prompt 注入器 | 🔄 定制 | `llm.before_request` | 中 | 动态指令 |
| 静默模式 | 🔇 策略 | Policy API | 低 | 快速探索 |
| 响应流水印 | 🌊 追踪 | `llm.after_response` | 低 | 来源透明 |
| 压缩策略定制 | 🧩 记忆 | `compaction.*` | 高 | 上下文控制 |
| 声效反馈 | 🎵 体验 | `step.after_execute` + `agent_end.after` | 低 | 感官反馈 |
| LLM 检查器 | 🔍 调试 | `llm.*` | 低 | 透视思考 |
| 进度条 (UI) | 🎨 UI 扩展 | `step.*` + UI module | 高 | 可视化进度 |

---

## 14. 下一步行动

> **API 参考手册已独立发布**：[plugin-api-reference.md](plugin-api-reference.md)——面向 AI 和开发者的纯技术查阅手册，包含全部 30 个 Hook（SW 17 + UI 13）、SDK API、Capability/Policy 表、Permissions 机制。

| 阶段 | 产出 | 说明 |
|------|------|------|
| **Phase 1** | 本文档 review 定稿 | ✅ 已完成 |
| **Phase 2** | `docs/plugin-api-reference.md` | ✅ 已完成 |
| **Phase 3** | Plugin Studio UI 改进 | P0 级：Hook 文档内嵌 + 代码编辑器升级 |
| **Phase 4** | "从自然语言创建插件" 功能 | 用户描述需求 → AI 生成 → 一键注册 |
