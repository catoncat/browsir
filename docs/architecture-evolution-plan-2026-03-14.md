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
| Panel UI | **ChatView.vue** | ~2,142 | **P0** — 当前最大技术债 |
| Panel Shell | `App.vue` | ~86 | 低 — 壳层收口已落地 |
| Kernel 编排 | `runtime-loop.browser.ts` | ~3,304 | P1 — 仍有后续瘦身空间 |
| Store 层 | `chat-store.ts` | ~507 | 低 — 结构清晰 |
| Provider 链路 | 5 文件 / 426 行 | — | 低 — 接口极简但够用 |
| Plugin/Skill | 稳定 | — | 低 |
| Bridge | 稳定 | — | 低 |

## 演进优先级

### P0：ChatView 主控拆分（ISSUE-017，首轮 controller 抽离已启动）

**问题**：`App.vue` 壳层收口已经在真实工作树中完成，但技术债并未消失，而是迁移到了 `ChatView.vue`。当前 `ChatView.vue` 仍同时承载 **chat 主视图渲染、tool pending / run-view 主状态机、step stream 恢复与 polling、`chrome.runtime` 消息总线、残余 panel UI plugin runtime wiring、send/export/debug 用户动作**，新的边界问题已经从“App 巨型组件”演变为“ChatView 巨型主控组件”。

**校准后的拆分策略**：

1. **接受当前 `App.vue` 壳层收口成果，不回滚**
   - `App.vue` 保持 shell：`activeView` / `SessionList` / 顶层 bootstrap / 视图切换
   - 不再把 chat controller 逻辑回流到壳层

2. **保留 `panel/types.ts` 作为 panel view-model / run-view 类型收口点**
   - `ViewMode` / `DisplayMessage` / run-view types 继续集中维护

3. **继续从 `ChatView.vue` 抽运行态控制器**
   - 当前工作树已存在 `use-llm-streaming.ts` 与 `use-tool-run-tracking.ts`，首轮已把流式草稿状态、tool run tracking / step stream sync / tool card model 从主文件中移出
   - 下一步不再是假设性新建 `use-tool-pending-state.ts`，而是先观察 `use-tool-run-tracking.ts` 是否稳定；若继续膨胀，再在 `ISSUE-021` 中做第二阶段细拆
   - 当前剩余重点已经转向：runtime message bus / polling / bridge status wiring 仍留在 `ChatView.vue`

4. **从 `ChatView.vue` 抽 runtime message bus / polling / step-stream wiring**
   - 当前工作树已出现 `use-runtime-messages.ts` 首版文件，但尚未真正接入 `ChatView.vue`
   - 下一步是把 `chrome.runtime.onMessage`、轮询同步、bridge/runtime event 分发、bridge status 刷新从视图主体移出，并统一收口到该边界

5. **继续复用现有 `use-ui-render-pipeline.ts`，承接 panel UI plugin runtime / render hook 管线**
   - 当前工作树中 `ChatView.vue` 已接入该 composable，首轮 plugin runtime / render hook 边界已经出现
   - 下一步重点是继续把残余 side-effect 和 wiring 从 `ChatView.vue` 主体移出，而不是再平行新建一个 `use-panel-ui-runtime.ts`

6. **将 send / export / debug link / 轻交互动作继续拆离**
   - 候选：`use-conversation-actions.ts` / `use-conversation-export.ts`
   - 避免 `ChatView.vue` 同时是 controller、message bus、toolbar action hub

7. **`shell-context.ts` 降级为“按需引入”，不再作为第一阶段硬前置**
   - 只有当 props/emits 或多层注入边界真的成为阻碍时再引入
   - 不为了“遵守旧计划”而制造一个未被真实需求验证的 context 层

**写入范围**：
- `extension/src/panel/App.vue`（保持 shell，必要时只做适配）
- `extension/src/panel/ChatView.vue`
- `extension/src/panel/types.ts`
- `extension/src/panel/composables/use-llm-streaming.ts`（已落地，继续保持窄边界）
- `extension/src/panel/composables/use-tool-run-tracking.ts`（已落地，继续观察是否需要二次细拆）
- `extension/src/panel/composables/use-runtime-messages.ts`（已出现首版文件，待接线）
- `extension/src/panel/composables/use-ui-render-pipeline.ts`（优先复用/扩展）
- `extension/src/panel/composables/use-conversation-actions.ts`（推荐新建）

**泳道**：`panel-chat`，`ChatView.vue` 单写者

### P1：runtime-loop LLM 请求提取（ISSUE-018，当前工作树已出现首版抽离）

**问题**：`requestLlmWithRetry`（~375 行）曾是 runtime-loop 中最大的未拆出块；当前工作树已经出现 `loop-llm-request.ts` 首版实现，但仍需按 build / test / 行数门槛完成收口。

**提取内容**：
- HTTP 请求构造 + retry 循环
- Profile 升级逻辑
- SSE / hosted-chat content-type 分发
- `llm.before_request` / `llm.after_response` hook 编排

**目标模块**：`loop-llm-request.ts`（当前工作树已新建）

**实现口径**：
- 作为“带窄依赖注入的 requester 模块”落地，而不是把函数体原样搬家
- 优先收口：request lifecycle / hook / transport parsing / retry state / trace emit

**预计效果**：runtime-loop 在当前 ~3,304 行基础上继续逼近 ~3,076 行目标

**写入范围**：
- `extension/src/sw/kernel/runtime-loop.browser.ts`（瘦身）
- `extension/src/sw/kernel/loop-llm-request.ts`（新建）

**泳道**：`kernel-loop`，runtime-loop 单写者

### P2：终态 / overflow 语义统一（ISSUE-020）

**问题**：
1. `runtime-loop.browser.ts` 的 `finalStatus`、`loop-shared-types.ts` 的 `FailureReason`、`orchestrator.browser.ts` 的 `handleAgentEnd()` decision 是三层并行语义
2. overflow → compaction → continue 的 ownership 横跨 runtime-loop / orchestrator / runtime-router，文档与实现容易漂移

**行动**：
1. **Phase A — 状态模型统一**：定义 canonical terminal status / failure reason / agent-end decision 映射
2. **Phase B — ownership 梳理**：理清 overflow → auto-compaction → continue 的真实 ownership
3. 再回写 README / AGENTS / BDD，确保文档跟随 canonical 语义而不是各写各的

**写入范围**：
- `extension/src/sw/kernel/orchestrator.browser.ts`
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/loop-shared-types.ts`
- `extension/src/sw/kernel/runtime-router/`
- `README.md`
- `AGENTS.md`
- `bdd/contracts/`

**泳道**：`kernel-loop` + `bdd-docs`，建议在 ISSUE-018 之后

### P3：Prompt 域整合（ISSUE-019）

**问题**：`buildResolvedSystemPrompt` 并不是“纯函数小工具”，而是 context-ref 解析 + system prompt 组装的一部分；当前 prompt 逻辑已分散在 `runtime-loop.browser.ts` 与 `prompt/prompt-policy.browser.ts` 两处。

**目标方向**：
- 不再新增根层 `loop-system-prompt.ts`
- 将 resolver 下沉到 `prompt/` 域，集中 system prompt + context-ref 解析逻辑

**目标模块**：`extension/src/sw/kernel/prompt/system-prompt-resolver.browser.ts`（或并入 `prompt-policy.browser.ts`）

**写入范围**：
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/prompt/`

**泳道**：`kernel-loop`，建议在 ISSUE-020 之后

## 泳道与并行策略

### Lane A：`panel-chat`（ChatView.vue 单写者）

串行：ISSUE-017（必要时再接 ISSUE-021）

### Lane B：`kernel-loop`（runtime-loop 单写者）

串行：ISSUE-018 → ISSUE-020 → ISSUE-019

### 并行策略

- ISSUE-017 和 ISSUE-018 可**并行**（不同文件泳道）
- ISSUE-020 必须等 ISSUE-018 完成
- ISSUE-019 建议等 ISSUE-020 完成后再做（避免继续打散 prompt 语义）

```
Batch 1（并行）:  ISSUE-017 (ChatView decomposition) + ISSUE-018 (LLM request)
Batch 2:          ISSUE-020 (语义统一)
Batch 3:          ISSUE-019 (prompt 域整合)
```

## 验收基线

- [ ] `App.vue` 保持 shell-only，不再回流 chat controller / runtime bus / plugin runtime 逻辑
- [ ] `use-runtime-messages.ts` 完成接线，`ChatView.vue` 不再直接承载 runtime message bus/polling/bridge status wiring
- [ ] `ChatView.vue` 首轮不再同时内联 toolbar / conversation actions 等剩余热点
- [ ] `use-ui-render-pipeline.ts` 与 `use-llm-streaming.ts` 继续保持已落地的独立边界，不回流到 `ChatView.vue`
- [ ] `use-tool-run-tracking.ts` 稳定承接 run tracking 逻辑，或进一步细拆为更窄的 composable
- [ ] `runtime-loop.browser.ts` < 3,000 行
- [ ] canonical terminal status / failure reason / agent-end decision 已对齐
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
- [ ] `bun run bdd:gate` 通过（如有新契约）

## Provider 架构备忘（Backlog）

当前结论：多供应商 Provider 在 OpenAI 兼容生态下优先级极低。单一 `openai_compatible` provider + 网关转发已经足够。如果未来需要原生支持非 OpenAI API，可考虑：
- `send()` 返回 `LlmProviderResult` 而非 `Response`
- 流解析下沉到 provider 层
- 但**不引入**泛型系统 / 双流模式 / full system access 权限模型

参考对比文档：[pi-mono-runtime-comparison.md](./pi-mono-runtime-comparison.md)
