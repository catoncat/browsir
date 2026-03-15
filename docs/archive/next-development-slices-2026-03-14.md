# Browser Brain Loop 下一阶段并行 Slices（2026-03-14）

本文件把 [next-development-master-plan-2026-03-14.md](./next-development-master-plan-2026-03-14.md) 拆成可直接派发给不同 agent 的实施 slices。

主计划负责“做什么、为什么、先后顺序”，本文件负责“谁可以现在开做、会改哪些文件、是否能并行”。

## 使用规则

- 每个 slice 必须对应一个 `docs/backlog/*.md` issue 文件。
- `write_scope` 重叠的 slice 默认不要并行分配。
- `runtime-loop.browser.ts`、`App.vue`、`runtime.ts` 仍然是单写者泳道。
- 可以并行的优先是“新模块 + 小接线”，不要把两个 agent 同时派去切同一个大文件。

## 当前泳道

### Lane A：`kernel-loop`

单写者文件：

- `extension/src/sw/kernel/runtime-loop.browser.ts`

串行 slices：

1. `ISSUE-004` session title 抽离
2. `ISSUE-005` browser proof / lease / verify 抽离
3. `ISSUE-006` no-progress / signature / outcome 汇总抽离
4. `ISSUE-007` compaction summary / aux LLM 请求抽离

### Lane B：`panel-shell`

单写者文件：

- `extension/src/panel/App.vue`

串行 slices：

1. `ISSUE-008` App shell / view mode 收口
2. `ISSUE-010` Plugin 使用面 / 开发面导航收口

### Lane C：`panel-store`

单写者文件：

- `extension/src/panel/stores/runtime.ts`

串行 slices：

1. `ISSUE-009` runtime store 领域拆分
2. `ISSUE-012` `@路径` 输入与发送链路接线
3. `ISSUE-013` ContextRef diagnostics / inspect 接线

### Lane D：`skill-runtime`

主文件：

- `extension/src/sw/kernel/dispatch-plan-executor.ts`
- `extension/src/sw/kernel/loop-tool-dispatch.ts`

可与 Lane A / B 并行，但不要与改同文件的 slice 并行：

1. `ISSUE-011` skill script browser scope 闭环

### Lane E：`cursor-help`

主文件：

- `extension/src/sw/kernel/web-chat-executor.browser.ts`
- `extension/src/content/cursor-help-content.ts`
- `extension/src/injected/cursor-help-page-hook.ts`

可与前面各 lane 并行：

1. `ISSUE-014` Cursor Help provider contract / inspect 稳定化

### Lane F：`bdd-docs`

主文件：

- `bdd/`
- `docs/kernel-architecture.md`

建议最后进入：

1. `ISSUE-015` BDD / 文档边界同步

## 推荐并行批次

### Batch 0

- `ISSUE-004` 进行中

### Batch 1

在 `ISSUE-004` 合入后，可并行启动：

- `ISSUE-005`
- `ISSUE-008`
- `ISSUE-011`
- `ISSUE-014`

### Batch 2

在各自前置完成后启动：

- `ISSUE-006`（依赖 `ISSUE-005`）
- `ISSUE-009`（依赖 `ISSUE-008`）
- `ISSUE-010`（依赖 `ISSUE-008`）

### Batch 3

- `ISSUE-007`（依赖 `ISSUE-006`）
- `ISSUE-012`（依赖 `ISSUE-009`）

### Batch 4

- `ISSUE-013`（依赖 `ISSUE-012`）
- `ISSUE-015`（依赖 `ISSUE-006`、`ISSUE-009`、`ISSUE-010`、`ISSUE-012`、`ISSUE-014`）

## Slice 清单

## `ISSUE-004` Runtime Loop 标题模块抽离

- 目标：把 session title / title refresh / LLM title request 从 `runtime-loop.browser.ts` 拆到独立模块
- 当前状态：`in-progress`
- 写入范围：
  - `extension/src/sw/kernel/runtime-loop.browser.ts`
  - `extension/src/sw/kernel/loop-session-title.ts`
  - `extension/src/sw/kernel/__tests__/loop-session-title.browser.test.ts`

## `ISSUE-005` Runtime Loop Browser Proof / Lease / Verify 抽离

- 目标：抽出 `shouldVerifyStep`、`shouldAcquireLease`、observe/verify 组合逻辑、browser proof 失败语义
- 状态：`open`
- 依赖：`ISSUE-004`
- 写入范围：
  - `extension/src/sw/kernel/runtime-loop.browser.ts`
  - `extension/src/sw/kernel/loop-browser-proof.ts`
  - `extension/src/sw/kernel/__tests__/loop-browser-proof.browser.test.ts`

## `ISSUE-006` Runtime Loop No-Progress / Signature 抽离

- 目标：抽出 no-progress fingerprint、tool signature、continue budget、terminal status 汇总
- 状态：`open`
- 依赖：`ISSUE-005`
- 写入范围：
  - `extension/src/sw/kernel/runtime-loop.browser.ts`
  - `extension/src/sw/kernel/loop-progress-guard.ts`
  - `extension/src/sw/kernel/__tests__/loop-progress-guard.browser.test.ts`

## `ISSUE-007` Runtime Loop Compaction / Aux LLM 抽离

- 目标：把 compaction summary 请求、aux route 解析、summary 结果整形从主 loop 移出
- 状态：`open`
- 依赖：`ISSUE-006`
- 写入范围：
  - `extension/src/sw/kernel/runtime-loop.browser.ts`
  - `extension/src/sw/kernel/loop-compaction-llm.ts`
  - `extension/src/sw/kernel/__tests__/loop-compaction-llm.browser.test.ts`

## `ISSUE-008` App Shell / View Mode 收口

- 目标：把 `showSettings/showSkills/showPlugins/showDebug` 收成显式 shell / view mode
- 状态：`open`
- 依赖：无
- 写入范围：
  - `extension/src/panel/App.vue`
  - `extension/src/panel/components/*`（仅与壳层编排直接相关的组件）

## `ISSUE-009` Runtime Store 领域拆分

- 目标：把 `runtime.ts` 拆成 chat/config/skills/plugins/diagnostics 等 store
- 状态：`open`
- 依赖：`ISSUE-008`
- 写入范围：
  - `extension/src/panel/stores/runtime.ts`
  - `extension/src/panel/stores/*`

## `ISSUE-010` Plugin 使用面 / 开发面分离

- 目标：明确 `PluginsView` 与 `PluginStudioView` 的职责，不再重复暴露同一套控制面
- 状态：`open`
- 依赖：`ISSUE-008`
- 写入范围：
  - `extension/src/panel/components/PluginsView.vue`
  - `extension/src/panel/components/PluginStudioView.vue`
  - `extension/src/panel/App.vue`

## `ISSUE-011` Skill Browser Scope 执行闭环

- 目标：让 `execute_skill_script` 对 skill-bundled browser scope 脚本真正闭环，不再要求迁到 host path
- 状态：`open`
- 依赖：无
- 写入范围：
  - `extension/src/sw/kernel/dispatch-plan-executor.ts`
  - `extension/src/sw/kernel/loop-tool-dispatch.ts`
  - `extension/src/sw/kernel/skill-registry.ts`

## `ISSUE-012` `@路径` 输入与发送链路接线

- 目标：把 `ChatInput` 里的路径引用真正接到 `contextRefs` 发送链路，而不是停留在局部提取
- 状态：`open`
- 依赖：`ISSUE-009`
- 写入范围：
  - `extension/src/panel/components/ChatInput.vue`
  - `extension/src/panel/stores/runtime.ts`
  - `extension/src/sw/kernel/orchestrator.browser.ts`
  - `extension/src/sw/kernel/runtime-router/run-controller.ts`

## `ISSUE-013` ContextRef Diagnostics / Inspect 接线

- 目标：让 resolve/materialize/budget summary 进入 diagnostics / inspect / provider 侧可见面
- 状态：`open`
- 依赖：`ISSUE-012`
- 写入范围：
  - `extension/src/sw/kernel/context-ref/`
  - `extension/src/panel/utils/diagnostics.ts`
  - `extension/src/panel/components/DebugView.vue`

## `ISSUE-014` Cursor Help Provider Contract 稳定化

- 目标：收紧 `inspect` / readiness / runtime mismatch / transport contract，继续坚持 sidepanel 主聊 + hook 接管链路
- 状态：`open`
- 依赖：无
- 写入范围：
  - `extension/src/sw/kernel/web-chat-executor.browser.ts`
  - `extension/src/content/cursor-help-content.ts`
  - `extension/src/injected/cursor-help-page-hook.ts`
  - `extension/src/panel/components/ProviderSettingsView.vue`

## `ISSUE-015` BDD / 文档边界同步

- 目标：让 BDD 契约分类、门禁要求、架构文档与当前真实边界一致
- 状态：`open`
- 依赖：
  - `ISSUE-006`
  - `ISSUE-009`
  - `ISSUE-010`
  - `ISSUE-012`
  - `ISSUE-014`
- 写入范围：
  - `bdd/`
  - `docs/kernel-architecture.md`
  - `docs/context-reference-filesystem-and-kernel-boundaries-design-2026-03-13.md`

## 与 backlog 的结合方式

可以，而且应该直接结合，建议就按下面的层级执行：

1. 主计划文档：定义长期主线与阶段优先级
2. slice index 文档：定义本轮可并行的切片与依赖图
3. backlog issue 文件：定义可派给 agent 的最小工作单元

也就是说：

- 不是再造一套 slice 系统
- 而是把 slice 作为 backlog 的一种 `kind`
- agent 接活时读 `docs/backlog/*.md`
- 调度者读本文件判断哪些 issue 现在可以并行开
