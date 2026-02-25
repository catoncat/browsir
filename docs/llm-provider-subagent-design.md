# LLM 实施蓝图：先 Provider，后 Agents（Browser Brain Loop）

> 日期：2026-02-25  
> 目标：把“多 LLM Provider + 多 Agent”讨论收敛为可执行方案。  
> 主线：必须先完成 Provider 层，再进入 Agents 编排层。

## 0. 实施铁律

1. 先 Provider，后 Agents。
2. 大脑只在浏览器侧（SW/SidePanel），Bridge 只做执行代理。
3. 默认不做黑盒自动降级；允许“可解释升级”，禁止“静默降级”。
4. 场景尚未最终拍板，先按候选场景与评估维度推进。

## 1. 当前基线（必须承认的现实）

- 当前是单 LLM 入口：`llmApiBase/llmApiKey/llmModel`（`extension/src/sw/kernel/runtime-infra.browser.ts`）。
- 运行时在 `runtime-loop` 直接发 `/chat/completions`（`extension/src/sw/kernel/runtime-loop.browser.ts`）。
- 现有 Provider 抽象主要是工具执行 Provider（`ToolProviderRegistry`），不是 LLM Provider。

结论：现在还没有 LLM Provider 抽象和 profile 路由，因此多 Agent 选模暂不具备实现基础。

## 2. 范围与非目标

### 本轮范围

- 建立 LLM Provider Adapter/Registry 的最小闭环。
- 建立 profile 解析与“升级优先”策略骨架（不含自动降级）。
- 用 BDD 与单测锁住语义，确保后续接 Agents 不漂移。

### 明确不做

- 不做按价格自动切模。
- 不做全局静默降级。
- 不把 Provider 路由下沉到 Bridge。
- 不在本阶段引入复杂学习型路由。

## 3. 阶段门禁（Entry / Exit / Blocker）

| 阶段 | Entry（进入条件） | Exit（完成条件） | Blocker（阻塞） |
| --- | --- | --- | --- |
| Phase 1 Provider | 单模型链路稳定、BDD 门禁可跑 | 具备 `ProviderAdapter + Registry + ProfileResolver` 最小闭环；新增合同通过 | 出现“无提示降级”或 Bridge 承担决策 |
| Phase 2 Agents | Phase 1 全部 Exit 满足 | 角色绑定 profile、支持最小 `single/parallel` 子任务编排、可观测路由 | Provider 选路不稳定、失败语义不可解释 |

## 4. Phase 1：Provider（先做）

### 4.1 目标

- 把 LLM 调用从“硬编码 HTTP”改为“Provider Adapter 调用”。
- 保持行为等价：现有成功/失败语义不回归。
- 引入 profile 路由骨架：默认 profile + 同角色升级链（显式配置）。

### 4.2 代码落点（建议）

- 新增 `extension/src/sw/kernel/llm-provider.ts`
  - 定义 `LlmProviderAdapter`、`LlmRequest`、`LlmResponse`。
- 新增 `extension/src/sw/kernel/llm-provider-registry.ts`
  - 注册/替换/查询 provider。
- 新增 `extension/src/sw/kernel/llm-openai-compatible-provider.ts`
  - 封装当前 `/chat/completions` 行为，作为第一个 provider。
- 新增 `extension/src/sw/kernel/llm-profile-resolver.ts`
  - 解析 profile -> `{ provider, model, base, key, retry/timeout }`。
- 修改 `extension/src/sw/kernel/runtime-loop.browser.ts`
  - `requestLlmWithRetry` 与 title 生成改为通过 registry/provider。
- 修改 `extension/src/sw/kernel/runtime-infra.browser.ts`
  - 配置结构从单 model 扩展为 profile（兼容旧字段）。

### 4.3 可观测事件（最小集）

- `llm.route.selected`：本轮选中的 `profile/provider/model`。
- `llm.route.escalated`：升级触发原因（如重复失败签名）。
- `llm.route.blocked`：需要升级但无可用上级模型。

### 4.4 DoD（完成定义）

1. 旧配置仍可运行（向后兼容）。
2. 新配置可指定不同 provider/model。
3. 失败时不静默降级，行为是“保留原配置并失败”或“显式升级”。
4. 日志可以还原每次选路原因。
5. Provider 相关 contract + feature + unit 都通过。

## 5. Phase 2：Agents（后做）

### 5.1 前置条件

- Phase 1 Exit 全量满足。
- profile 与选路事件在实测中稳定。

### 5.2 目标

- 引入子 Agent 角色：`scout / worker / reviewer`（初版）。
- 角色绑定 profile，不允许角色外静默切模。
- 支持最小编排原语：`single`、`parallel`。

### 5.3 失败策略

- 只允许同角色升级链（例如 `worker.basic -> worker.pro`）。
- 无上级模型时显式失败并返回原因。
- 不自动降级到弱模型。

## 6. 候选应用场景（尚未拍板）

> 这些是候选，不是最终承诺。先按评估维度筛选。

1. Repo 探索：`scout` 快速定位，`worker` 实施改动。
2. 代码评审：`worker` 产出后由 `reviewer` 复核风险。
3. 长链路任务：浏览器动作和文件操作由现有 tool provider 执行，LLM 只负责编排。

### 评估维度

1. 成功率是否提升。
2. 平均轮次是否下降。
3. 失败是否可解释（含路由原因）。
4. 用户是否感知到“能力变弱”。

## 7. 对应测试与 BDD（本次先落 Provider）

## 7.1 单元测试

- `extension/src/sw/kernel/__tests__/tool-provider-registry.browser.test.ts`
  - 补充 mode hint 严格匹配与回退行为。
  - 补充 capability provider 抛错元信息保留（`modeUsed/capabilityUsed`）。
  - 补充 `resolveMode` 在 `mode + capability` 共存时优先级。
- `extension/src/sw/kernel/__tests__/llm-profile-policy.browser.test.ts`
  - 验证 `upgrade_only`：只允许向上升级。
  - 验证无上级 profile 时显式 `blocked`，不隐式降级。

## 7.2 新增 BDD 契约（Provider 阶段）

- `BHV-LLM-PROVIDER-ADAPTER-ROUTING`
  - 约束 provider 路由、显式选模与错误语义稳定。
- `BHV-LLM-PROFILE-ESCALATION`
  - 约束仅允许升级、不允许静默降级。

## 7.3 新增 BDD 场景（technical/chat）

- `bdd/features/technical/chat/llm-provider-adapter-routing.feature`
- `bdd/features/technical/chat/llm-profile-escalation.feature`

## 7.4 验证命令

```bash
bun test extension/src/sw/kernel/__tests__/tool-provider-registry.browser.test.ts extension/src/sw/kernel/__tests__/llm-profile-policy.browser.test.ts
bun run bdd:lint:features
bun run bdd:validate
```

## 8. 实施清单（按顺序）

1. 完成 Provider Adapter/Registry 代码骨架。
2. 把 runtime-loop 切到 Provider 调用，但保持现有行为。
3. 接 profile resolver 与兼容配置。
4. 补齐可观测事件。
5. 跑通 unit + bdd validate。
6. 再进入 Agents 编排阶段。

## 9. 参考资料

- Pi 本地仓库（固定路径）：`~/work/repos/_research/pi-mono/`
- Pi 官方：<https://github.com/badlogic/pi-mono>
- Pi subagent 示例：
  - <https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent>
