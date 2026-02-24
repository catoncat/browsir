# 多 Provider 与 Sub-Agent 设计沉淀（面向 Browser Brain Loop）

> 日期：2026-02-24  
> 目的：沉淀本轮讨论结论，指导后续实现，避免“能力扩展”与“体验退化”冲突。

## 1. 背景

我们最初讨论的是「是否引入 Pi 式多 LLM Provider 兼容与注册机制」，随后延伸到「未来多 Agent 协作时如何分配模型」。

这份文档只保留对本产品有效的结论，不做泛化。

## 2. 当前现状（BBL）

当前 runtime 是单模型入口：

- 配置仅有 `llmApiBase/llmApiKey/llmModel`：`extension/src/sw/kernel/runtime-infra.browser.ts`
- 请求直接调用 `/chat/completions`：`extension/src/sw/kernel/runtime-loop.browser.ts`
- 主循环在浏览器内（正确），Bridge 只执行工具（正确）

结论：当前还没有 Provider 抽象，也没有按任务/角色选模能力。

## 3. 已确认事实（外部参考）

### 3.1 Pi 的能力边界

Pi 的 `pi-ai` 有完整 Provider 抽象、注册和跨 Provider 消息兼容；`coding-agent` 支持手动选模与扩展注册 Provider。  
但 Pi 主体并没有做“通用运行时自动选模主循环”（更多是手动切换 + 恢复时 fallback）。

### 3.2 Claude Code 的思路

Claude Code 更接近「可解释自动化」：

- 有模型别名与有限的自动回退策略
- 支持 Sub-Agent 绑定模型
- 不是黑盒式每步随机切模型

### 3.3 社区实践（Pi 生态）

高质量实现普遍遵循：

- 子 Agent 隔离执行（独立进程/独立上下文）
- 编排原语明确（single / parallel / chain / wave）
- 可恢复（重试、退避、resume）
- 模型选择可见、可控

## 4. 产品级决策（本项目）

### 决策 D1：要做多 Provider 抽象，但不是为“按价自动降级”

目标是支持未来多 Agent 协作和能力分工，不是做“便宜模型优先”的成本调度器。

### 决策 D2：默认不做“黑盒自动降级”

用户对“能力被悄悄降低”体验敏感。默认策略应是：

- 角色绑定模型（显式）
- 失败优先升级，不做静默降级
- 所有切模行为可观测、可解释

### 决策 D3：架构铁律保持不变

- 大脑决策必须留在浏览器侧 runtime
- Bridge 继续只做执行代理，不承载 Provider 选择逻辑

## 5. 目标架构（契合 BBL）

### 5.1 新增 LLM Provider Adapter 层（在 SW kernel）

在 `runtime-loop` 与 HTTP 之间增加适配层：

- `ProviderAdapter`：统一 `complete/stream` 调用接口
- `ProviderRegistry`：注册内置 provider 与扩展 provider
- `MessageTransform`：跨 provider 的 message/tool_call/tool_result 兼容转换

### 5.2 新增 Model Profile（而不是裸 model）

会话不再只存 `llmModel`，而是存 profile：

- `default`
- `planner`
- `worker`
- `scout`
- `reviewer`

每个 profile 显式定义 provider/model/timeout/retry，不隐式猜测。

### 5.3 为 Sub-Agent 预留角色选模

后续多 Agent 协作时，采用“角色 -> profile”路由：

- 简单探测类任务：`scout`（可配小模型）
- 主执行类任务：`worker`（主力模型）
- 评审类任务：`reviewer`（高可靠模型）

## 6. 明确不做（当前阶段）

- 不做全局自动降级（silent downgrade）
- 不做按 token 单价自动切换
- 不在 Bridge 实现 Provider 选择
- 不把 tool provider 路由和 llm provider 路由耦合成同一个逻辑块

## 7. 分阶段落地计划

### Phase A：Provider 抽象最小闭环

- 抽出 `ProviderAdapter` 接口
- 先落一个 `openai-chat` 适配器，行为与当前一致
- 加 `ProviderRegistry`（先静态注册）

### Phase B：Profile 化与可观测

- 配置从单 `llmModel` 升级为 profile
- 在事件流新增：`llm.route.selected` / `llm.route.fallback`
- UI 透出“本轮使用模型/Provider”

### Phase C：Sub-Agent 角色路由

- 增加子 Agent 任务编排（single/parallel 起步）
- 角色绑定 profile
- 失败策略仅允许“同角色升级”，禁止静默降级

## 8. 验收标准（BDD/运行态）

- 同一会话内可按 profile 稳定切换 provider/model
- 跨 provider 继续对话不破坏 tool_call 链路
- `loop_done` 成功率提升，且错误可解释
- 日志中可还原每次选模与切换原因
- 未配置次级模型时行为可预期（明确报错或停留原模型）

## 9. 参考实现与资料

- Pi monorepo（固定本地路径）：`~/work/repos/_research/pi-mono/`
- Pi 官方仓库：<https://github.com/badlogic/pi-mono>
- Pi 官方 subagent 示例：
  - <https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent>
- 社区参考：
  - task-tool（single/parallel/chain）：<https://github.com/richardgill/pi-extensions/tree/main/extensions/task-tool>
  - PiSwarm（wave + resume + retry）：<https://github.com/lsj5031/PiSwarm>
  - task-factory（queue + profile + fallback chain）：<https://github.com/patleeman/task-factory>
  - 社区索引 awesome-pi-agent：<https://github.com/qualisero/awesome-pi-agent>
