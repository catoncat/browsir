# Plugin 架构回溯（基于 Git Log）

更新时间：2026-02-27

## 1. 目标

这份文档回答两个问题：

1. 当前插件能力是否真的走统一插件机制，而不是写死分支。
2. `example-mission-hud-dog` 在系统里到底调用了哪些能力、经过哪些链路。

## 2. 关键提交时间线（按能力分层）

### Kernel/Router 层

- `406516f` `feat(kernel): add editable plugin runtime lifecycle and llm provider routing`
  - 建立插件 runtime 生命周期（注册/启停/卸载）主干。
- `17c5905` `feat(plugin): harden plugin.install and refactor builtin capability plugin bootstrap`
  - 固化内置 capability 插件引导策略。
- `22a5666` `fix(plugin): disallow uninstalling builtin plugins`
  - 内置插件保护：`runtime.builtin.plugin.*` 不允许卸载。

### Plugin UI/Runtime 层

- `96d92c9` `feat(plugin): wire ui render hooks and expose ui extensions`
  - 面板 UI runtime hook + uiExtension 生命周期接入。
- `75f8805` `feat(plugin): bootstrap builtin send-success notice plugin`
  - 启动时注册内置通知插件（确保可见）。
- `f4d6586` `fix(plugin): emit send-success notice on every run start`
  - 修复去重策略，保证每次发送都触发。
- `449175c` `feat(plugin): add animated dog mascot mission HUD`
  - 新增小狗 HUD 插件链路（思考/执行/校验/完成/错误）。

## 3. 运行架构（不是死代码）

### 3.1 注册路径

- 外部插件：
  - `brain.plugin.register` / `brain.plugin.register_extension` / `brain.plugin.install` -> `runtime-router` -> `orchestrator.registerPlugin(...)`。
- 内置插件：
  - 启动 bootstrap（`ensureBuiltinRoutePlugins`）中调用同一个 `orchestrator.registerPlugin(...)`。

关键点：内置与外部共享 **同一插件 runtime 执行模型**，差异仅在“注册来源”。

### 3.2 执行路径（Hook 真正被调度）

1. Orchestrator 执行步骤前，统一触发 `tool.before_call`：
   - `extension/src/sw/kernel/orchestrator.browser.ts:706`
2. 步骤完成后统一触发 `step.after_execute`：
   - `extension/src/sw/kernel/orchestrator.browser.ts:736`
3. agent 收尾统一触发 `agent_end.after`：
   - `extension/src/sw/kernel/orchestrator.browser.ts:913`
4. mission-hud 插件在这些 hook 里发 runtime 消息：
   - `extension/src/sw/kernel/runtime-loop.browser.ts:3183`
   - `extension/src/sw/kernel/runtime-loop.browser.ts:3227`
   - `extension/src/sw/kernel/runtime-loop.browser.ts:3238`
   - `extension/src/sw/kernel/runtime-loop.browser.ts:3264`

这说明它是“被 orchestrator hook 调度”的插件逻辑，不是 UI 内硬编码轮询。

### 3.3 UI 消费路径

1. SW 通过 `chrome.runtime.sendMessage` 发 `bbloop.ui.mascot`：
   - `extension/src/sw/kernel/runtime-loop.browser.ts:3091`
2. Panel runtime message 分发到 `showMissionMascot`：
   - `extension/src/panel/App.vue:2165`
3. Vue 组件渲染 SVG 动画：
   - `extension/src/panel/components/MissionMascot.vue:21`

## 4. 当前 `example-mission-hud-dog` 使用能力（可观测）

- Hook：
  - `runtime.route.after`
  - `tool.before_call`
  - `step.after_execute`
  - `agent_end.after`
- Runtime 消息输出：
  - `bbloop.ui.mascot`

`send-success` 插件：

- Hook：`runtime.route.after`
- Runtime 消息输出：`bbloop.global.message`, `brain.event`
- Brain 事件类型：`plugin.global_message`

## 5. 为什么之前 UI 会显示很多“无”

旧面板只展示 provider 维度（modes/capabilities/llmProviders/uiExtension），
而 mission-hud 本质是 hook + runtime message 型插件，所以 provider 项天然为空。

## 6. 本次修正

### 6.1 元数据模型补充（仅展示，不做权限拦截）

新增插件可声明字段：

- `permissions.runtimeMessages: string[]`
- `permissions.brainEvents: string[]`

对应代码：

- `extension/src/sw/kernel/plugin-runtime.ts`
- `extension/src/sw/kernel/runtime-router.ts`
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/plugins/send-success-global-message/plugin.json`

### 6.2 插件面板改为“已使用功能”视图

- 不再堆叠一堆“无”。
- 只展示有值的能力项：hooks / provider / policy / tools / llm / runtimeMessages / brainEvents / uiExtension。
- 增加“类型”聚合标签（Hook、执行链、UI/事件输出等）。

对应代码：

- `extension/src/panel/stores/runtime.ts`
- `extension/src/panel/components/PluginsView.vue`

## 7. 验证点

- 内置插件存在性与事件发送有测试覆盖：
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts`
- 插件 hook 调度由 orchestrator 统一执行：
  - `extension/src/sw/kernel/orchestrator.browser.ts`

结论：当前 mission-hud 不是死代码，它是“内置注册来源 + 统一插件运行时机制”下的 hook 插件。
