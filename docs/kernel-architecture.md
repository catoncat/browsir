# Kernel Architecture

Browser Brain Loop Kernel 是运行在 Chrome Extension Service Worker 中的 AI Agent 引擎核心，由 `BrainOrchestrator` 单例聚合以下 6 大子系统。

源码位置：`extension/src/sw/kernel/`（50 个模块 + 40 个测试文件）

---

## 1. Orchestrator（编排器）

**核心文件：** `orchestrator.browser.ts`

`BrainOrchestrator` 是 Kernel 的门面（Facade），内聚所有 registry 并提供统一 API。

### 聚合的子系统实例

| 实例 | 类型 | 职责 |
|------|------|------|
| `sessions` | `BrowserSessionManager` | 会话 CRUD + 上下文构建 |
| `events` | `BrainEventBus` | 全局事件总线 |
| `hooks` | `HookRunner<OrchestratorHookMap>` | 编排 hook 管道 |
| `toolProviders` | `ToolProviderRegistry` | 工具执行层（mode + capability） |
| `toolContracts` | `ToolContractRegistry` | 工具 Schema 层 |
| `capabilityPolicies` | `CapabilityPolicyRegistry` | 执行策略 |
| `llmProviders` | `LlmProviderRegistry` | LLM 适配器 |
| `skills` | `SkillRegistry` | Skill 安装/启停 |
| `skillResolver` | `SkillContentResolver` | Skill prompt 注入 |
| `plugins` | `PluginRuntime` | 插件生命周期 |

### Session 生命周期

```
createSession → appendUserMessage → [runtime-loop]
  ↓ loop 内部
  preSendCompactionCheck → LLM request → tool_call → executeStep → verify
  ↓ loop 结束
  handleAgentEnd → retry / compaction / done
```

### RunState 状态机

```typescript
interface RunState {
  running: boolean;    // loop 正在执行
  compacting: boolean; // 正在压缩上下文
  paused: boolean;     // 用户暂停
  stopped: boolean;    // 用户停止
  retry: RetryState;   // 自动重试状态
  queue: RunQueueState; // steer/followUp 队列
}
```

- **steer**：中断注入（抢占当前 loop turn）
- **followUp**：追加排队（当前 loop 结束后执行）

---

## 2. Tool 双层架构

### 2a. ToolContract（Schema 层）

**核心文件：** `tool-contract-registry.ts`

定义 LLM 可调用工具的名称、描述和 JSON Schema 参数。输出为 OpenAI function calling 格式 `ToolDefinition[]`。

**内置工具（46 个）：**

| 类别 | 工具 |
|------|------|
| **文件/Shell（8）** | `host_bash`, `browser_bash`, `host_read_file`, `browser_read_file`, `host_write_file`, `browser_write_file`, `host_edit_file`, `browser_edit_file` |
| **元素交互（8）** | `search_elements`, `click`, `fill_element_by_uid`, `select_option_by_uid`, `hover_element_by_uid`, `get_editor_value`, `fill_form`, `computer` |
| **导航/滚动（4）** | `press_key`, `scroll_page`, `navigate_tab`, `scroll_to_element` |
| **Tab 管理（6）** | `get_all_tabs`, `get_current_tab`, `create_new_tab`, `get_tab_info`, `close_tab`, `ungroup_tabs` |
| **验证/元数据（2）** | `browser_verify`, `get_page_metadata` |
| **视觉（5）** | `highlight_element`, `highlight_text_inline`, `capture_screenshot`, `capture_tab_screenshot`, `capture_screenshot_with_highlight` |
| **下载（2）** | `download_image`, `download_chat_images` |
| **Intervention（4）** | `list_interventions`, `get_intervention_info`, `request_intervention`, `cancel_intervention` |
| **Skill（7）** | `create_skill`, `load_skill`, `execute_skill_script`, `read_skill_reference`, `get_skill_asset`, `list_skills`, `get_skill_info` |

支持 builtin/override 两层，插件可通过 `register({ replace: true })` 替换内置工具。

**元素定位优先级：** `uid` > `ref` > `backendNodeId` > `selector`（fallback）

### 2b. ToolProvider（执行层）

**核心文件：** `tool-provider-registry.ts`

```typescript
interface StepToolProvider {
  id: string;
  mode?: ExecuteMode;        // "script" | "cdp" | "bridge"
  priority?: number;
  canHandle?(input): boolean | Promise<boolean>;
  invoke(input): Promise<unknown>;
}
```

两种注册维度：
- **Mode Provider**：按 `ExecuteMode` 注册，每个 mode 最多一个 provider
- **Capability Provider**：按 capability 字符串注册，支持优先级排序和 `canHandle` 过滤

解析流程：capability provider 优先 → mode hint 匹配 → 回退到 capability 默认 provider。

### 2c. CapabilityPolicy（执行策略）

**核心文件：** `capability-policy.ts`

```typescript
interface CapabilityExecutionPolicy {
  defaultVerifyPolicy?: "off" | "on_critical" | "always";
  leasePolicy?: { ... };
}
```

控制每个 capability 的默认验证策略和租约策略，支持 builtin/override 两层。

---

## 3. LLM Provider 系统

### 核心文件

| 文件 | 职责 |
|------|------|
| `llm-provider.ts` | `LlmProviderAdapter` 接口 + `LlmResolvedRoute` 类型 |
| `llm-provider-registry.ts` | `LlmProviderRegistry` 多 adapter 管理 |
| `llm-openai-compatible-provider.ts` | 默认 OpenAI-compatible adapter（`{base}/chat/completions`） |
| `llm-profile-resolver.ts` | Profile 多路由解析（从 BridgeConfig） |
| `llm-profile-policy.ts` | 失败升级策略（`upgrade_only` / `disabled`） |
| `llm-message-model.browser.ts` | Session message → LLM payload 转换 |

### LlmProviderAdapter 接口

```typescript
interface LlmProviderAdapter {
  id: string;
  resolveRequestUrl(route: LlmResolvedRoute): string;
  send(input: LlmProviderSendInput): Promise<unknown>;
}
```

默认注册 `openai_compatible` provider。插件可注册自定义 provider。

### Profile 路由

支持多 profile 配置，按 role 优先级解析。失败时可通过 `LlmProfileEscalationPolicy` 升级到更高级 profile。

---

## 4. Plugin 系统

**核心文件：** `plugin-runtime.ts`

### AgentPluginDefinition

```typescript
interface AgentPluginDefinition {
  manifest: AgentPluginManifest;   // id/name/version/timeoutMs/permissions
  hooks?: { [hookName]: handler | handler[] };
  providers?: {
    modes?: Record<ExecuteMode, StepToolProvider>;
    capabilities?: Record<string, StepToolProvider>;
  };
  policies?: { capabilities?: Record<string, CapabilityExecutionPolicy> };
  tools?: ToolContract[];
  llmProviders?: LlmProviderAdapter[];
}
```

### 权限模型

```typescript
interface AgentPluginPermissions {
  hooks?: string[];
  modes?: ExecuteMode[];
  capabilities?: string[];
  replaceProviders?: boolean;
  tools?: string[];
  replaceToolContracts?: boolean;
  llmProviders?: string[];
  replaceLlmProviders?: boolean;
  runtimeMessages?: string[];
  brainEvents?: string[];
}
```

### 生命周期

```
register → enable（注册 hooks/providers/policies/tools/llmProviders）
         → disable（卸载所有注册项 + 自动恢复被替换的 provider）
         → unregister
```

- 每个 hook handler 有独立 timeout（默认 1500ms，上限 10s）
- 卸载时自动恢复被替换的 mode/capability provider、policy 和 tool contract
- Plugin Studio 提供可视化编辑和热更新

---

## 5. Skill 系统

### 核心文件

| 文件 | 职责 |
|------|------|
| `skill-registry.ts` | `SkillRegistry`：IndexedDB 持久化的 skill 安装/启停管理 |
| `skill-content-resolver.ts` | `SkillContentResolver`：读取 SKILL.md → `<skill>` prompt block |
| `skill-create.ts` | `normalizeSkillCreateRequest()`：LLM create_skill 调用的规范化 |

### SkillMetadata

Skill 通过 `SkillRegistry` 管理，持久化到 IndexedDB KV store。支持 mutation queue 串行写入。

### Skill 内容注入

`SkillContentResolver` 通过可插拔的 `SkillContentReader` 读取 skill 主文档，构建 `<skill id="..." name="...">` XML prompt block 注入 LLM 上下文。

### create_skill 工具

LLM 可通过 `create_skill` 工具原子性地创建/更新 skill 包：
- 主文档：`mem://skills/{id}/SKILL.md`
- 附属文件：`scripts/`、`references/`、`assets/`

---

## 6. Virtual FS + Browser Unix Runtime

### 核心文件

| 文件 | 职责 |
|------|------|
| `virtual-fs.browser.ts` | VFS 路由：`mem://` 前缀判断 + `invokeVirtualFrame()` 委托 |
| `browser-runtime-strategy.ts` | Runtime Strategy 类型 (`browser-first` / `host-first`) |
| `browser-unix-runtime/lifo-adapter.ts` | LIFO 沙箱适配：`@lifo-sh/core` 执行 read/write/edit/bash |

### mem:// 虚拟文件系统

- `shouldRouteFrameToBrowserVfs(frame)` 根据路径前缀 `mem://` 和 runtime hint 判断是否走浏览器 VFS
- `invokeVirtualFrame()` 委托给 lifo-adapter 在 `@lifo-sh/core` 沙箱中执行

### Runtime Strategy

```typescript
type BrowserRuntimeStrategy = "browser-first" | "host-first";
```

- **browser-first**：默认走浏览器沙箱，fallback 到 host bridge
- **host-first**：默认走 host bridge，仅 `mem://` 路径走浏览器

---

## 7. Hook 系统

**核心文件：** `hook-runner.ts` + `orchestrator-hooks.ts`

### HookRunner

泛型 `HookRunner<TMap>` 支持：
- 按优先级排序执行 handler
- 三种 action：`continue`（透传）/ `patch`（修改 payload）/ `block`（中断）
- 返回 `HookRunResult`（含 `blocked`/`reason`/`value`）

### 17 个 Hook 点

| 分类 | Hook |
|------|------|
| **Runtime 路由** | `runtime.route.before`, `runtime.route.after`, `runtime.route.error` |
| **Step 执行** | `step.before_execute`, `step.after_execute` |
| **Tool 调用** | `tool.before_call`, `tool.after_result` |
| **LLM 请求** | `llm.before_request`, `llm.after_response` |
| **Agent 结束** | `agent_end.before`, `agent_end.after` |
| **Compaction** | `compaction.check.before`, `compaction.check.after`, `compaction.before`, `compaction.summary`, `compaction.after`, `compaction.error` |

---

## 8. 事件系统

**核心文件：** `events.ts`

`BrainEventBus` 发布-订阅总线，约 50+ 事件类型：

| 分类 | 示例事件 |
|------|---------|
| **LLM** | `llm.request_start`, `llm.request_end`, `llm.stream_chunk` |
| **Loop** | `loop_start`, `loop_end`, `loop_step`, `loop_no_progress` |
| **Step** | `step_start`, `step_end`, `step_error` |
| **Input** | `input.user`, `input.steer`, `input.followUp` |
| **Subagent** | `subagent.spawn`, `subagent.end` |
| **Session** | `session_create`, `session_compact`, `session_remove` |
| **Auto-retry** | `auto_retry_start`, `auto_retry_end` |
| **Compaction** | `auto_compaction_start`, `auto_compaction_end` |

事件信封 `BrainEventEnvelope` 包含 `type`、`sessionId`、`ts`、`payload`，自动持久化到 IndexedDB trace chunk。

---

## 9. 其他核心模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **Runtime Loop** | `runtime-loop.browser.ts` | LLM loop 引擎：prompt → LLM → tool_call → verify → retry/no_progress 检测 |
| **Runtime Router** | `runtime-router.ts` | SW 消息路由：session CRUD、run/stop/steer、plugin/skill 管理、subagent 调度 |
| **Runtime Infra** | `runtime-infra.browser.ts` | 基础设施：WS Bridge 连接、CDP Gateway、lease 管理、snapshot enrichment |
| **Session Manager** | `session-manager.browser.ts` | 会话管理：CRUD + context 构建 |
| **Session Store** | `session-store.browser.ts` | IDB 持久化：session index/meta/entries/traces |
| **Compaction** | `compaction.browser.ts` | 上下文压缩：overflow/threshold 触发、保留尾部、turn 边界切分 |
| **Snapshot Enricher** | `snapshot-enricher.ts` | A11y snapshot 后处理：hierarchy/intent/session-context 三阶段 enrichment |
| **Extension API** | `extension-api.ts` | 外部扩展 Builder 模式注册 API |
| **IDB Storage** | `idb-storage.ts` | IndexedDB 初始化 + 通用 KV 存储 |
| **Storage Reset** | `storage-reset.browser.ts` | session store 重置 + index 初始化 |
| **Infra Bridge Client** | `infra-bridge-client.ts` | WS Bridge 连接客户端封装 |
| **Infra CDP Action** | `infra-cdp-action.ts` | CDP 动作执行：click/fill/select/hover 等 |
| **Infra Snapshot Helpers** | `infra-snapshot-helpers.ts` | snapshot 辅助：AXTree 解析、ref 解析 |
| **Dispatch Plan Executor** | `dispatch-plan-executor.ts` | subagent dispatch plan 执行 |
| **Eval Bridge** | `eval-bridge.ts` | SidePanel/Offscreen JS eval 桥接 |
| **Web Chat Executor** | `web-chat-executor.browser.ts` | 嵌入式 web chat transport 执行器（cursor-help 等） |
| **Persistable AST Analyzer** | `persistable-ast-analyzer.ts` | AST 分析：检测插件脚本可持久化性 |
| **Prompt Enricher** | `prompt/` | LLM prompt 构建：`prompt-enricher.ts`、`schema-to-prompt.ts` 等 |
| **Cursor Help Pool** | `cursor-help-*.ts` | `cursor_help` 专属连接池系列模块（如 `execution` / `pool-window` / `pool-state` 等） |
| **Background Auto** | `automation-mode.ts` | 自动化模式状态管理（`focus` / `background`）|
| **Stealth Tab** | `stealth-tab.ts` | 后台模式下的隐身/最小化窗口标签页管理 |
| **Failure Tracker** | `background-failure-tracker.ts` | 后台模式连续失败追踪与降级提示 |

---

## 10. Loop 提取模块

从 `runtime-loop.browser.ts` 提取的纯函数模块，所有函数均为无副作用、可独立测试的纯函数。

| 文件 | 职责 |
|------|------|
| `loop-shared-types.ts` | Loop 共享类型：`NoProgressReason`、`NO_PROGRESS_CONTINUE_BUDGET`、终止状态枚举 |
| `loop-shared-utils.ts` | Loop 共享工具函数：`clipText`、`safeStringify` |
| `loop-browser-proof.ts` | 浏览器证明：`shouldVerifyStep`、`buildObserveProgressVerify`、`actionRequiresLease`、`isToolCallRequiringBrowserProof`、`didToolProvideBrowserProof`、`mapToolErrorReasonToTerminalStatus` |
| `loop-progress-guard.ts` | No-progress 检测：`calculateActionSignature`、`isNoProgress`、`updateProgressBudget`、`normalizeNoProgressEvidenceValue`、`buildNoProgressEvidenceFingerprint`、`buildNoProgressScopeKey`、`resolveNoProgressDecision` |
| `loop-failure-protocol.ts` | 失败协议：失败分类、重试决策、终止状态映射 |
| `loop-llm-route.ts` | LLM 路由辅助：session route prefs 读取、failure signature 归一化、retry delay hints 提取 |
| `loop-llm-stream.ts` | LLM 流解析：SSE body 解析、hosted chat transport 读取 |
| `loop-session-title.ts` | 会话标题：`refreshSessionTitleAuto`、LLM 消息文本提取、标题规范化 |
| `loop-tool-dispatch.ts` | 工具调度辅助：tool call 路由和参数解析 |
| `loop-tool-display.ts` | 工具展示辅助：forceFocus 添加、成功/失败 payload 构建 |
