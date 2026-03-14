# Browser Brain Loop 下一阶段开发总计划（2026-03-14）

## 摘要

这份文档按当前仓库真实状态重排主线，不再沿用旧的 `runtime-router-first` 叙事。

当前已经完成两轮内核拆分：

1. `runtime-loop.browser.ts` 已抽出共享类型层、共享工具层、failure protocol 层。
2. `runtime-loop.browser.ts` 已继续抽出：
   - `loop-llm-route.ts`
   - `loop-llm-stream.ts`
   - `loop-tool-display.ts`

配套的并行实施切片见：

- [next-development-slices-2026-03-14.md](./next-development-slices-2026-03-14.md)

因此，下一阶段的真正主战场已经变为：

1. `runtime-loop.browser.ts` 剩余执行编排块继续拆分
2. `App.vue + runtime.ts` 产品层收口
3. Plugin / Skill 产品面重构
4. `@文件路径` 产品闭环
5. Cursor Help provider 稳定化
6. BDD / 文档边界同步

## 当前状态重评估

### 已完成

- `runtime-router.ts` 已显著瘦身，不再是当前头号 God module。
- `runtime-infra.browser.ts` 已抽出：
  - `infra-bridge-client.ts`
  - `infra-cdp-action.ts`
  - `infra-snapshot-helpers.ts`
- `SessionWorkingContext`、`hostCwd`、`ContextRefService` 已落地第一轮。
- Cursor Help provider 已进入正式实现态，已有 content / injected hook / native sender / executor 多层结构。
- `runtime-loop.browser.ts` 已从约 6374 行压到约 4127 行。

### 已从待办中移除

- “抽共享类型 / 共享工具 / failure protocol”
- “抽 LLM route / retry”
- “抽 SSE / hosted transport stream”
- “抽 tool display / tool payload”

这些都已在当前工作树完成，不应重复计划或重复实现。

### 当前剩余最高优先级

#### 1. `runtime-loop.browser.ts`

剩余仍应继续拆出的块：

- session title / title refresh / message text parse
- browser proof / lease / verify policy 相关编排
- no-progress / signature / tool outcome 汇总
- compaction summary 请求与结果整形

#### 2. Panel 产品层

- `App.vue` 仍依赖 `showSettings/showSkills/showPlugins/showDebug` 布尔开关组织产品 IA
- `runtime.ts` 仍是聊天、配置、技能、插件、诊断的大总 store

#### 3. Plugin / Skill 产品面

- 使用面与开发面未分层
- UI 暴露过多 `mem://`、`plugin.json`、热更新等底层概念

## 主线阶段

## Phase 1：继续拆 `runtime-loop.browser.ts`

### 已完成切片

- shared types / constants
- shared pure utils
- failure protocol
- LLM route / retry helpers
- SSE / hosted transport stream parsing
- tool display / success-failure payload builders

### 下一刀

优先拆出 `loop-session-title.ts`，收口：

- `normalizeSessionTitle`
- `readSessionTitleSource`
- `withSessionTitleMeta`
- `parseLlmContent`
- `requestSessionTitleFromLlm`
- `refreshSessionTitleAuto`

完成标准：

- `runtime-loop.browser.ts` 不再直接承载标题生成与标题刷新逻辑
- 标题相关逻辑只通过新模块暴露
- 继续保持无兼容壳、无旧实现残留

当前状态：

- 已在当前工作树完成，待提交

### 再下一刀

拆 browser proof / lease / verify 相关编排，形成独立执行策略模块。

完成标准：

- `shouldVerifyStep`
- `shouldAcquireLease`
- browser proof failure 映射
- 相关 observe/verify 组合逻辑

不再散落在主 loop 文件中。

## Phase 2：收口 SidePanel 产品层

### 目标

把 SidePanel 从工程控制台收成“聊天产品面 + 开发者面分离”的结构。

### 关键改造

- `App.vue` 改为显式 shell / view mode，而不是多个 `showXxx`
- `runtime.ts` 拆分为 chat / config / skills / plugins / diagnostics 等 store
- 默认产品面只保留聊天主链路
- Skills / Plugins / Debug / Studio 收入开发者面

## Phase 3：Plugin / Skill 产品化

### Plugin

- `PluginsView` 只做管理和启停
- `PluginStudioView` 只做开发和调试
- Widget API 成为正式 plugin UI contract

### Skill

- 继续坚持 catalog metadata 被动可见
- 完整 `SKILL.md` 只按需加载
- `execute_skill_script` 闭环到 browser scope，不再允许“迁到 host path”

## Phase 4：`@文件路径` 产品闭环

### 已完成前提

- `SessionWorkingContext`
- `hostCwd`
- `ContextRefService`
- `/mem` 与 `mem://` 的基础语义

### 未完成

- 输入框真正支持 `@路径`
- prompt send payload 稳定携带 `contextRefs`
- materialize / dedupe / budget summary 全链路产品化
- inspect / debug 展示 ref resolve 结果

## Phase 5：Cursor Help Provider 稳定化

继续坚持正式链路：

- sidepanel 主聊
- page-side sender 触发内部入口
- fetch-hook 改写请求
- SSE rewrite 回传净化事件

继续禁止：

- direct-api
- composer 正式回退
- DOM 回读作为成功路径

## Phase 6：BDD 与文档同步

- 契约按产品模块重新编目
- 不再接受源码锚点充当 required proof
- `kernel-architecture.md` 与真实目录结构同步

## 当前阶段成果记录

### 已完成的内核重构链路

- `runtime-infra.browser.ts` → `infra-bridge-client.ts` / `infra-cdp-action.ts` / `infra-snapshot-helpers.ts`
- `runtime-loop.browser.ts` → `loop-tool-dispatch.ts` / `dispatch-plan-executor.ts`
- `runtime-loop.browser.ts` → `loop-shared-types.ts` / `loop-shared-utils.ts` / `loop-failure-protocol.ts`
- `runtime-loop.browser.ts` → `loop-llm-route.ts` / `loop-llm-stream.ts` / `loop-tool-display.ts`

### 当前明确禁止重复做的工作

- 不要再次创建或重新平移：
  - `loop-llm-route.ts`
  - `loop-llm-stream.ts`
  - `loop-tool-display.ts`
- 不要在计划里再把这三项写成“待开始”

## 验收基线

- 每完成一个拆分切片，都必须至少通过：
  - `cd extension && bunx tsc --noEmit`
  - 该切片对应的新增单测
  - 至少一个 runtime-loop 现有回归测试

- 禁止：
  - 保留旧实现与新实现并存
  - 保留兼容分支
  - 用“先导出再慢慢迁”方式拖长过渡态
