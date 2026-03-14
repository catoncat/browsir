# 架构演进计划（Phase 2）— 2026-03-14

## 背景

Phase 1（ISSUE-004 ~ ISSUE-015）已全部完成，成果：

- `runtime-loop.browser.ts` 从 ~6,374 行降至 ~3,451 行（-46%），拆出 12 个独立模块
- `runtime.ts` store 从 ~1,539 行降至 38 行，拆为 chat/config/plugin/skill 四个领域 store
- App.vue 从 showXxx 布尔开关改为 ViewMode 联合类型
- Plugin 使用面/开发面分离完成
- Skill browser scope 执行闭环
- `@路径` 输入与 contextRef 发送链路接线完成
- BDD 契约与文档边界同步完成

Phase 2 聚焦**两个维度**：Kernel 层继续瘦身 + Panel 巨型组件拆分。

## 当前架构健康评估

| 层级 | 最大单体 | 行数 | 紧迫度 |
|------|---------|------|--------|
| Panel UI | **App.vue** | ~3,247 | **P0** — 当前最大技术债 |
| Kernel 编排 | `runtime-loop.browser.ts` | ~3,451 | P1 — 仍有 ~750 行可提取逻辑 |
| Store 层 | `chat-store.ts` | ~507 | 低 — 结构清晰 |
| Provider 链路 | 5 文件 / 426 行 | — | 低 — 接口极简但够用 |
| Plugin/Skill | 稳定 | — | 低 |
| Bridge | 稳定 | — | 低 |

## 演进优先级

### P0：App.vue 拆分（ISSUE-017）

**问题**：App.vue 3,247 行单文件组件，同时承载视图路由分发 + chat 全场景逻辑 + 接口类型定义 + Plugin UI 挂载。

**拆分策略**：

1. **抽 ChatView.vue**（~2,000 行）
   - 消息列表渲染与滚动管理
   - 流式响应容器编排（StreamingDraftContainer）
   - 工具运行快照展示
   - 队列管理与 steer/followUp 交互
   - Fork / retry / intervention 场景逻辑
   - Plugin UI widget/message 挂载

2. **抽 panel/types.ts**（~200 行）
   - 接口/类型定义移出 App.vue script 块

3. **App.vue 降为 Shell**（目标 <500 行）
   - ViewMode 切换
   - 顶栏（会话标题 + 操作按钮）
   - 侧栏（SessionList）
   - 视图容器（`<component :is="...">` 或条件渲染）
   - 全局事件监听（chrome.runtime.onMessage）

**写入范围**：
- `extension/src/panel/App.vue`（瘦身）
- `extension/src/panel/components/ChatView.vue`（新建）
- `extension/src/panel/types.ts`（新建）

**泳道**：`panel-shell`，App.vue 单写者

### P1：runtime-loop LLM 请求提取（ISSUE-018）

**问题**：`requestLlmWithRetry`（~375 行）是 runtime-loop 中最大的未拆出块。

**提取内容**：
- HTTP 请求构造 + retry 循环
- Profile 升级逻辑
- SSE / hosted-chat content-type 分发
- `llm.before_request` / `llm.after_response` hook 编排

**目标模块**：`loop-llm-request.ts`

**预计效果**：runtime-loop 从 ~3,451 行降至 ~3,076 行

**写入范围**：
- `extension/src/sw/kernel/runtime-loop.browser.ts`（瘦身）
- `extension/src/sw/kernel/loop-llm-request.ts`（新建）

**泳道**：`kernel-loop`，runtime-loop 单写者

### P2：system prompt 构建提取（ISSUE-019）

**问题**：`buildResolvedSystemPrompt`（~150 行）+ skill prompt 展开逻辑是纯函数，无外部依赖，可提取。

**目标模块**：`loop-system-prompt.ts`

**预计效果**：runtime-loop 进一步降至 ~2,926 行

**写入范围**：
- `extension/src/sw/kernel/runtime-loop.browser.ts`（瘦身）
- `extension/src/sw/kernel/loop-system-prompt.ts`（新建）

**泳道**：`kernel-loop`，需在 ISSUE-018 之后

### P3：auto-repair / overflow 语义统一（ISSUE-020）

**问题**：
1. README/AGENTS 声明的 `execute_error/no_progress` 触发条件，与内核终态枚举（`failed_execute/failed_verify/progress_uncertain/max_steps/stopped`）不完全同构
2. overflow 恢复路径可能落 `failed_execute` 而非自愈

**行动**：
1. 统一终态枚举命名（文档 ↔ 代码 1:1）
2. 补齐 overflow → auto-compaction → continue 链路
3. 更新 BDD 契约反映真实语义
4. 更新 README/AGENTS 中的终态描述

**写入范围**：
- `extension/src/sw/kernel/orchestrator.browser.ts`
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/loop-shared-types.ts`
- `README.md`
- `AGENTS.md`
- `bdd/contracts/`

**泳道**：`kernel-loop` + `bdd-docs`，需在 ISSUE-018/019 之后

## 泳道与并行策略

### Lane A：`panel-shell`（App.vue 单写者）

串行：ISSUE-017

### Lane B：`kernel-loop`（runtime-loop 单写者）

串行：ISSUE-018 → ISSUE-019 → ISSUE-020

### 并行策略

- ISSUE-017 和 ISSUE-018 可**并行**（不同文件泳道）
- ISSUE-019 必须等 ISSUE-018 完成
- ISSUE-020 必须等 ISSUE-018/019 完成

```
Batch 1（并行）:  ISSUE-017 (App.vue) + ISSUE-018 (LLM request)
Batch 2:          ISSUE-019 (system prompt)
Batch 3:          ISSUE-020 (语义统一)
```

## 验收基线

- [ ] `App.vue` < 500 行
- [ ] `runtime-loop.browser.ts` < 3,000 行
- [ ] 所有终态枚举与 README/AGENTS 1:1 对应
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
- [ ] `bun run bdd:gate` 通过（如有新契约）

## Provider 架构备忘（Backlog）

当前结论：多供应商 Provider 在 OpenAI 兼容生态下优先级极低。单一 `openai_compatible` provider + 网关转发已经足够。如果未来需要原生支持非 OpenAI API，可考虑：
- `send()` 返回 `LlmProviderResult` 而非 `Response`
- 流解析下沉到 provider 层
- 但**不引入**泛型系统 / 双流模式 / full system access 权限模型

参考对比文档：[pi-mono-runtime-comparison.md](./pi-mono-runtime-comparison.md)
