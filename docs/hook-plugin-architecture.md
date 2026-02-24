# Browser Brain Loop Hook + 插件系统架构规范（草案 v1）

> 目标：把当前“事件总线 + 硬编码工具分发”升级为“可控 Hook 管线 + 可插拔能力插件”，同时保持架构铁律：**决策在浏览器，执行可插拔，安全不可绕过**。
>
> 约定：本文锚点尽量使用 `path::symbol`，少量补充 `:line`。

## 1. 背景与边界

### 1.1 现状（代码事实）

1. 当前是事件总线，不是 Hook Runner：`extension/src/sw/kernel/events.ts::BrainEventBus`。
2. 主循环逻辑集中在闭包函数，外部不可细粒度注入：`extension/src/sw/kernel/runtime-loop.browser.ts::createRuntimeLoopController`、`extension/src/sw/kernel/runtime-loop.browser.ts::runAgentLoop`。
3. 工具执行为硬编码分发：`extension/src/sw/kernel/runtime-loop.browser.ts::executeToolCall`。
4. Browser 写操作安全依赖 lease：`extension/src/sw/kernel/runtime-infra.browser.ts::ensureLeaseForWrite`。
5. Bridge 侧协议与工具集固定：`bridge/src/protocol.ts::parseInvokeFrame`、`bridge/src/dispatcher.ts::dispatchInvoke`。

### 1.2 本文范围

1. 定义 Hook 体系（触发点、返回语义、可拦截边界、失败隔离）。
2. 定义插件体系（注册、生命周期、权限、隔离、插件内插件）。
3. 定义强约束（不可拦截、不变量、审计要求）。
4. 给出实现分期与验收口径。

### 1.3 非目标

1. 不在 v1 引入远程插件代码下载执行（MV3 RHC 禁止）。
2. 不在 v1 改写 Bridge 网络协议形状（`invoke` 帧先保持兼容）。
3. 不在 v1 引入“无上限自治循环”或弱化 verify/lease 语义。

### 1.4 实现进度（截至 2026-02-24）

1. 已完成：`HookRunner`、`PluginRuntime`、`ToolProviderRegistry` 已落地；`runtime.route.*`、`step.*`、`tool.*`、`agent_end.*`、`compaction.*` 已接入。
2. 已完成：`llm.before_request` / `llm.after_response` 已接入 LLM 主链路（`requestLlmWithRetry`），支持 `patch/block` 与非重试错误语义。
3. 未完成：文档中的 `run/session/cdp/bridge` 全域 Hook、`policy-guard`、Bridge middleware 化、sub-plugin 仍未落地。

## 2. 第一性原理与设计铁律

1. **决策一致性**：所有任务决策仍在浏览器内核（SW）完成。
2. **执行可替换**：能力执行端（浏览器内 provider / bridge provider / 其他 connector）可替换。
3. **安全前置**：任何插件都不能绕过硬安全闸门。
4. **可恢复**：MV3 可中断，状态必须持久化，不能依赖内存常驻。
5. **可审计**：Hook 与插件决策必须可追踪、可复盘。

## 3. Hook 模型

### 3.1 Hook 事件命名空间

建议统一命名：`<domain>.<phase>.<name>`。

1. run：`run.before_start`、`run.after_start`、`run.on_error`
2. session：`session.before_create`、`session.after_append_entry`、`session.before_fork`、`session.on_error`
3. llm：`llm.before_request`、`llm.after_response_raw`、`llm.after_response_parsed`、`llm.on_error`
4. tool：`tool.before_call`、`tool.after_result`、`tool.on_error`
5. execute：`execute.before_step`、`execute.after_step`、`execute.on_error`
6. cdp：`cdp.before_action`、`cdp.after_action`、`cdp.after_verify`、`cdp.on_error`
7. bridge（浏览器侧连接器语义）：`bridge.before_invoke`、`bridge.after_invoke`、`bridge.on_error`

### 3.2 Hook 返回语义

```ts
export type HookDecision =
  | { action: "continue" }
  | { action: "patch"; patch: Record<string, unknown> }
  | { action: "block"; code: string; message: string; details?: Record<string, unknown> };
```

### 3.3 域级拦截策略（硬规则）

1. 可 `patch`：`llm.before_request`、`tool.after_result`、`execute.after_step`。
2. 可 `block`：`run.before_start`、`tool.before_call`、`llm.before_request`（仅策略类）。
3. 只观测不可拦截：
   - `bridge` 鉴权/origin 校验：`bridge/src/server.ts:95`、`bridge/src/server.ts:151`
   - 协议合法性：`bridge/src/protocol.ts::parseInvokeFrame`
   - lease 强校验：`extension/src/sw/kernel/runtime-infra.browser.ts::ensureLeaseForWrite`
   - failed_verify 硬语义：`extension/src/sw/kernel/runtime-loop.browser.ts:1012`

### 3.4 Hook 执行顺序

1. 按 `priority DESC`，同优先级按注册顺序（稳定序）。
2. `before` 阶段：依次运行，可 `patch` 累积。
3. `after` 阶段：依次运行，可 `patch` 累积。
4. `error` 阶段：只允许降噪与补充上下文，不允许吞掉硬错误。

### 3.5 Hook 失败隔离

1. 单个 Hook 抛错 -> 记日志 + 进入 `hook.on_error`，默认 fail-open。
2. 安全关键 Hook（可配置）可 fail-close，但必须返回明确错误码。
3. 所有 Hook 运行需有超时（例如 200ms/500ms 档），超时按失败处理。

## 4. 插件系统模型

### 4.1 插件分类

1. `hook-plugin`：只注册 Hook，不直接提供工具能力。
2. `capability-plugin`：提供能力 provider（fs/command/cdp-ext 等）。
3. `connector-plugin`：桥接外部执行端（例如 bridge-local）。

### 4.2 Manifest（建议）

```ts
export interface KernelPluginManifest {
  id: string;
  version: string;
  kind: "hook-plugin" | "capability-plugin" | "connector-plugin";
  entry: string; // 扩展包内静态资源路径
  permissions: string[];
  provides?: string[];
  dependsOn?: string[];
  hookPolicy?: {
    allowedHooks: string[];
    maxTimeoutMs?: number;
  };
}
```

### 4.3 生命周期

1. `register`：读取 manifest，校验签名/版本/权限声明。
2. `activate`：完成依赖解析并加入运行图。
3. `suspend`：临时停用（保留配置与状态）。
4. `deactivate`：从运行图移除。
5. `health-check`：周期检查（可配置）。

### 4.4 插件内插件（Sub-plugin）约束

你提出“插件也有自己的插件系统”，可支持，但必须加总线隔离：

1. Kernel 只信任顶层插件；sub-plugin 通过顶层插件托管。
2. sub-plugin 仅拿“受限 facade API”，不能直接拿 `chrome.*` 或宿主执行能力。
3. sub-plugin 权限上限 = 顶层插件被授予权限的子集。
4. 审计日志必须包含 `topPluginId` 与 `subPluginId`。

## 5. 不变量与不可绕过清单

以下规则对任何 Hook/插件都必须成立。

1. Bridge 鉴权与 origin 校验不可绕过：`bridge/src/server.ts::fetch`。
2. Invoke 协议与参数校验不可绕过：`bridge/src/protocol.ts::parseInvokeFrame`。
3. Bridge 并发上限不可绕过：`bridge/src/server.ts:210`。
4. strict 路径守卫不可绕过：`bridge/src/fs-guard.ts::FsGuard.assertAllowed`。
5. 命令白名单/strict 策略不可绕过：`bridge/src/cmd-registry.ts::resolveCommand`。
6. Browser 写操作 lease 校验不可绕过：`extension/src/sw/kernel/runtime-infra.browser.ts::ensureLeaseForWrite`。
7. `browser_action/browser_verify` 的 `failed_verify` 不可被插件强行改为成功：`extension/src/sw/kernel/runtime-loop.browser.ts:1012`。
8. 大脑边界不可绕过：Bridge 不做任务决策，仅执行代理。

## 6. 浏览器环境坑位（必须纳入设计）

### 6.1 MV3 生命周期

1. SW 空闲约 30s 可能被终止；单次事件/API 处理过长会被终止。
2. `fetch()` 长时间无响应会触发超时语义。
3. 全局变量会丢失，必须持久化关键状态。
4. `chrome.debugger` 活跃会影响生命周期（可能延长存活），不能作为稳定常驻依赖。

对策：

1. Hook/插件状态最小化，关键态落 `chrome.storage`/IDB。
2. 长任务拆分 + 心跳型恢复，不假设单次 run 全程不掉电。
3. 所有执行路径支持重入与幂等。

### 6.2 文件系统 API 与权限激活

1. `showOpenFilePicker/showSaveFilePicker/showDirectoryPicker` 要求瞬时用户激活。
2. `FileSystemHandle.requestPermission()` 在无 transient activation 或非 window 可消费上下文会失败。
3. SW 不是交互 UI 场景，不应承担 picker 发起职责。

对策：

1. 用户可见授权流程在 SidePanel/Offscreen 执行。
2. SW 只处理已授权 handle 或 OPFS provider。
3. 将“需要用户手势”的能力显式建模为 `interactive capability`。

### 6.3 OPFS 特性

1. OPFS 无用户弹窗，适合 Agent 浏览器内 workspace。
2. OPFS 受站点配额与清理策略影响（清站点数据会清除）。
3. `createSyncAccessHandle` 仅适用于 Dedicated Worker，适合高性能写路径。

对策：

1. 默认 workspace provider 使用 OPFS。
2. 关键元数据做双份索引（manifest + 校验）。
3. 大文件写走 worker + sync access handle，普通写走 async。

### 6.4 Offscreen 文档与 API 边界

1. Offscreen 可补齐 DOM 能力，但扩展 API 仅 `chrome.runtime` 可用。
2. 不能把 offscreen 当背景页替代品。

对策：

1. Offscreen 仅承载“必须 DOM 且可消息化”的子任务。
2. 业务决策与状态机仍在 SW。

### 6.5 MV3 代码装载限制（RHC/CSP）

1. MV3 不允许远程托管可执行代码。
2. extension pages CSP 最低策略限制脚本来源与 `unsafe-eval`。

对策：

1. 插件代码必须随扩展打包。
2. 运行时只允许加载静态 entry，不 fetch+eval。

## 7. 建议的运行时组件

新增核心模块（建议放在 `extension/src/sw/kernel/`）：

1. `hook-types.ts`：Hook 类型定义与决策模型。
2. `hook-runner.ts`：注册、顺序执行、超时与隔离。
3. `plugin-host.ts`：插件生命周期、依赖与权限校验。
4. `capability-registry.ts`：能力 provider 注册与解析。
5. `policy-guard.ts`：执行后不变量校验。
6. `audit-writer.ts`：统一审计输出（可复用现有 trace）。

## 8. 最小侵入落点（按当前代码）

### 8.1 先改 extension

1. `extension/src/sw/kernel/runtime-loop.browser.ts::executeStep`
   - 增加 `execute.before_step/after_step/on_error`。
2. `extension/src/sw/kernel/runtime-loop.browser.ts::executeToolCall`
   - 增加 `tool.before_call/after_result/on_error`。
3. `extension/src/sw/kernel/runtime-loop.browser.ts::requestLlmWithRetry`
   - 增加 `llm.before_request/after_response_*/on_error`。
4. `extension/src/sw/kernel/runtime-router.ts::registerRuntimeRouter`
   - 注入 `hookRunner` 与 `pluginHost`。
5. `extension/src/sw/kernel/runtime-infra.browser.ts::handleMessage`
   - 注入 `cdp.*` 与 `bridge.*` hooks（仅在可拦截域开放 block/patch）。
6. `extension/src/sw/kernel/events.ts::BrainEventBus.emit`
   - listener 隔离（try/catch），防插件监听器污染主流程。

### 8.2 再改 bridge（可选后置）

1. `bridge/src/dispatcher.ts::dispatchInvoke` -> middleware pipeline。
2. `bridge/src/server.ts::startBridgeServer` 增加插件执行审计元信息。
3. `bridge/src/protocol.ts::parseInvokeFrame` 暂不改帧形状，仅加 canonical 映射支持。

## 9. 审计与可观测要求

每次 Hook/插件执行最少记录：

1. `traceId/sessionId/stepId`
2. `hookName/pluginId/subPluginId`
3. `inputHash/outputHash`
4. `decision`（continue/patch/block）
5. `durationMs/timeout/errored`
6. `policyCheckResult`（是否触发硬约束拒绝）

## 10. BDD 门禁补强（与 Hook/插件配套）

新增契约建议：

1. `BHV-AGENT-HOOK-LIFECYCLE`（高风险）
2. `BHV-PLUGIN-FAILURE-ISOLATION`（高风险）
3. `BHV-CAPABILITY-PROVIDER-ROUTING`（高风险）

门禁要求：

1. `required_layers` 至少 `unit + integration + browser-cdp + e2e`。
2. e2e mapping 必须带 selector（`path::selector token`），避免整文件 `passed=true` 的弱约束。

## 11. 分期落地计划

### Phase 1（低风险）

1. 落 HookRunner 与 hook type。
2. 接入 llm/tool/execute 三大域。
3. 只开放 `continue/patch`，暂不开放 `block`（除 run.before_start）。

验收：

1. 现有 e2e 不退化。
2. Hook 抛错不影响主流程。
3. 关键 trace 字段可检索。

### Phase 2（中风险）

1. 接入 runtime-router/runtime-infra 的 run/session/cdp/bridge hooks。
2. 引入 plugin-host 与权限声明。
3. 加 `policy-guard`。

验收：

1. lease/verify/strict 不变量 100% 保持。
2. 插件超时、异常、禁用都可恢复。

### Phase 3（中高风险）

1. Bridge middleware 化（可选）。
2. 插件内插件支持。
3. 能力 provider 与工具契约完全解耦（见另一份迁移文档）。

## 12. 决策日志（本轮结论）

1. 4 工具能力保留，但不绑定本机。
2. Bridge 降级为可选连接器插件，不再是必需主路径。
3. `bash` 语义不再作为 canonical 名（详见迁移文档）。
4. 先做 Hook 管线与能力解耦，再做 Bridge 插件化。

## 13. 外部参考（浏览器坑位依据）

1. Extension SW 生命周期：
   - https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
2. Offscreen API（仅 `runtime` API）：
   - https://developer.chrome.com/docs/extensions/reference/api/offscreen
3. Storage API 与配额：
   - https://developer.chrome.com/docs/extensions/reference/api/storage
4. MV3 RHC 限制：
   - https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
5. MV3 CSP 最低限制：
   - https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
6. File picker 的 transient activation：
   - https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker
7. `requestPermission()` 的激活约束：
   - https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission
8. OPFS 与 `getDirectory()`：
   - https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory
   - https://web.dev/origin-private-file-system/
