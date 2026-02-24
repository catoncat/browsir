# 多 Provider 与 Sub-Agent 策略沉淀（Browser Brain Loop）

> 日期：2026-02-24  
> 目标：沉淀“多 LLM 提供商 + 多 Agent 协作”设计共识，且不破坏 Browser Brain Loop 的架构铁律。

## 1. 背景与问题

我们最初讨论的是“是否需要多 LLM Provider 抽象”，后续扩展到“多 Agent 协作时的小模型分工”。

当前 BBL 的 LLM 路径是单入口配置：

- `llmApiBase/llmApiKey/llmModel`（`extension/src/sw/kernel/runtime-infra.browser.ts`）
- 请求直接发到 `.../chat/completions`（`extension/src/sw/kernel/runtime-loop.browser.ts`）

这在单模型单 Agent 时代够用，但对未来多 Agent 协作不够：

- 无法稳定做“角色分工”（Scout/Worker/Reviewer）
- 无法跨 Provider 做消息兼容与模型切换
- 无法做可解释的模型升级策略

## 2. 结论（决策摘要）

1. 需要做多 Provider 抽象，但不是为了“省钱自动降级”。
2. 默认不做黑盒自动降级；优先做“显式角色绑定模型”。
3. 自动策略只允许“升级优先”（小模型失败 -> 大模型），不做静默降级。
4. Sub-Agent 要做，但实现必须契合 BBL：大脑仍在浏览器侧，Bridge 仍只做执行代理。

## 3. 产品原则（必须遵守）

1. 可解释：每一步要能看到“哪个 Agent、哪个模型、为什么选它”。
2. 可控：用户可关闭自动升级；关键任务可锁定模型。
3. 不惊喜：不做偷偷换模型导致能力突降。
4. 不破坏安全边界：lease、capability policy、tool contract 约束不变。
5. 不引入本地决策中心：Bridge 不承担模型路由与任务决策。

## 4. 对外参考（结论化）

## 4.1 Pi（含社区）

- Pi `pi-ai` 在 Provider 抽象、注册、跨 Provider 消息兼容上很完整，值得借鉴。
- Pi `coding-agent` 主产品里，主流是手动切模型（`/model`）+ 会话恢复 fallback，不是主循环自动选模。
- 社区 Sub-Agent 实践已较成熟，常见形态是 `single / parallel / chain / wave` 编排。

## 4.2 Claude Code

- 有模型别名与 Sub-Agent 模型配置能力。
- 更接近“角色分工 + 有约束回退”，不是每一步黑盒自动降级。

## 5. 目标能力（面向 BBL）

## 5.1 多 Provider 基础层

新增浏览器侧 LLM 适配层（仅在 extension 内）：

1. `LlmProviderRegistry`：注册 provider adapter（openai-compatible / anthropic / google 等）。
2. `ModelCatalog`：管理可选模型与能力标签（reasoning/tool/image/context）。
3. `MessageInterop`：跨 Provider 消息归一化（thinking/tool_call_id/tool_result）。
4. `LlmRouter`：按“场景 + 角色 + 策略”选模型（先规则，后可学习）。

## 5.2 Sub-Agent 编排层

在现有 runtime/orchestrator 上加“轻量子代理”：

1. 每个子代理有独立上下文窗（逻辑隔离，可映射到独立 session 分支）。
2. 每个子代理有独立模型策略（如 `scout=haiku`, `worker=sonnet`, `reviewer=opus`）。
3. 支持三种编排原语：`single`、`parallel`、`chain`。
4. 子代理只通过 tool contract 执行，不绕过 capability/provider 路由。

## 6. 我们明确“不做”的事

1. 不做全局“失败就随便降级到更弱模型”。
2. 不在 Bridge 引入模型路由或任务决策逻辑。
3. 不在第一阶段做复杂学习型路由（先规则可观测，再优化）。

## 7. 优先场景（与产品强相关）

1. Scout（小模型）快速读仓与定位 -> Worker（中模型）实施 -> Reviewer（强模型）把关。
2. 长链路任务中，工具执行仍由现有 capability/provider 执行，LLM 只负责规划与决策。
3. 当小模型连续失败（结构化工具调用错误/verify 推进失败）时，自动升级到上一级模型并记录原因。

## 8. 分阶段落地

## Phase 0（最小增量）

1. 抽出 `requestLlmWithRetry` 的 provider adapter 接口，行为保持不变。
2. 引入 `modelProfile` 概念（先支持手动指定）。
3. 事件补齐：`llm.route.selected`、`llm.route.escalated`、`agent.subtask.*`。

## Phase 1（可用）

1. 上线角色模型映射（Scout/Worker/Reviewer）。
2. 支持 `single/parallel/chain` 子任务编排。
3. 只启用“升级”自动策略（禁用自动降级）。

## Phase 2（增强）

1. 跨 Provider 消息兼容层完整接入。
2. 引入熔断与冷却（按 provider/model/error signature）。
3. 基于 BDD/live evidence 做策略调参。

## 9. 验收指标

1. 任务成功率：多 Agent 场景下较单 Agent 提升。
2. 失败可解释率：失败事件含模型、路由原因、错误签名。
3. 体验稳定性：无“无提示降级”投诉；自动升级可观测。
4. 架构约束：Bridge 不新增决策职责；lease/capability policy 全量生效。

## 10. 后续行动项

1. 输出 `LlmProviderRegistry` 与 `LlmRouter` 接口草案（TS 类型）。
2. 设计 `agentProfile` 配置结构（模型、thinking、工具白名单）。
3. 增加对应 BDD 契约（角色分工、升级策略、并行编排、失败可解释）。

