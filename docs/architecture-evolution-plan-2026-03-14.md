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

### P0：App.vue 壳层 / Controller 拆分（ISSUE-017，当前 WIP 已启动）

**问题**：App.vue 的技术债不只是模板过大，而是 **Shell 路由、panel 级 runtime/plugin 生命周期、chat 运行态控制器、chat 主视图渲染** 四类职责叠加在一个 SFC 内。

**校准后的拆分策略**：

1. **抽 `panel/types.ts`**（当前 WIP 已出现）
   - `ViewMode` / `DisplayMessage` / run-view types 统一收口

2. **抽 `use-tool-pending-state.ts`**（当前 WIP 主线）
   - tool pending / llm streaming / step stream sync / tool card derived state
   - 先把真正最重的运行态控制器从 `App.vue` 中移出，而不是先做“模板搬家”

3. **抽 `shell-context.ts`**
   - shell actions + `panelUiRuntime` injection key
   - 为后续 `ChatView` 或更深层子树提供上下文，避免 prop drilling

4. **App.vue 收缩为 Shell + panel 级生命周期**
   - 保留 `activeView` / 顶栏 / `SessionList` / runtime listener / plugin runtime hydrate

5. **`ChatView.vue` 延后到 controller 边界稳定后**
   - 仅在状态/控制器已经收口后，再评估是否引入 view-only `ChatView.vue`
   - 避免把一个 3000+ 行 SFC 直接搬成一个 2000+ 行子组件

**写入范围**：
- `extension/src/panel/App.vue`（瘦身）
- `extension/src/panel/types.ts`
- `extension/src/panel/utils/use-tool-pending-state.ts`
- `extension/src/panel/shell-context.ts`
- `extension/src/panel/components/ChatView.vue`（可选后续）

**泳道**：`panel-shell`，App.vue 单写者

### P1：runtime-loop LLM 请求提取（ISSUE-018）

**问题**：`requestLlmWithRetry`（~375 行）是 runtime-loop 中最大的未拆出块。

**提取内容**：
- HTTP 请求构造 + retry 循环
- Profile 升级逻辑
- SSE / hosted-chat content-type 分发
- `llm.before_request` / `llm.after_response` hook 编排

**目标模块**：`loop-llm-request.ts`

**实现口径**：
- 作为“带窄依赖注入的 requester 模块”落地，而不是把函数体原样搬家
- 优先收口：request lifecycle / hook / transport parsing / retry state / trace emit

**预计效果**：runtime-loop 从 ~3,451 行降至 ~3,076 行

**写入范围**：
- `extension/src/sw/kernel/runtime-loop.browser.ts`（瘦身）
- `extension/src/sw/kernel/loop-llm-request.ts`（新建）

**泳道**：`kernel-loop`，runtime-loop 单写者

### P2：终态 / overflow 语义统一（ISSUE-020）

**问题**：
1. `runtime-loop.browser.ts` 的 `finalStatus`、`loop-shared-types.ts` 的 `FailureReason`、`orchestrator.browser.ts` 的 `handleAgentEnd()` decision 是三层并行语义
2. overflow → compaction → continue 的 ownership 横跨 runtime-loop / orchestrator / runtime-router，文档与实现容易漂移

**行动**：
1. 定义 canonical terminal status / failure reason / agent-end decision 映射
2. 梳理 overflow → auto-compaction → continue 的真实 ownership
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

### Lane A：`panel-shell`（App.vue 单写者）

串行：ISSUE-017

### Lane B：`kernel-loop`（runtime-loop 单写者）

串行：ISSUE-018 → ISSUE-020 → ISSUE-019

### 并行策略

- ISSUE-017 和 ISSUE-018 可**并行**（不同文件泳道）
- ISSUE-020 必须等 ISSUE-018 完成
- ISSUE-019 建议等 ISSUE-020 完成后再做（避免继续打散 prompt 语义）

```
Batch 1（并行）:  ISSUE-017 (App.vue) + ISSUE-018 (LLM request)
Batch 2:          ISSUE-020 (语义统一)
Batch 3:          ISSUE-019 (prompt 域整合)
```

## 验收基线

- [ ] `App.vue` 首轮不再直接维护 tool pending / llm streaming 内联状态机；长期目标再收敛到 shell 级体量
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
