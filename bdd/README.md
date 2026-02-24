# BDD Framework Index

本目录是 Browser Brain Loop 的行为契约门禁中心，采用 `contract -> feature -> mapping -> evidence -> gate` 流程。

配套文档：
- 交接：`bdd/SESSION-HANDOFF.md`
- 写作规范：`bdd/CONTRACT-WRITING-GUIDELINE.md`

## 目录与职责

- `schemas/behavior-contract.schema.json`
  - 契约结构约束（`BHV-*`、proof layers、风险等级等）
- `contracts/**/*.json`
  - Canonical 行为契约
- `mappings/contract-categories.json`
  - 契约分类清单：`ux | protocol | storage`
- `features/**/*.feature`
  - Gherkin 视图，必须通过 `@contract(BHV-...)` 绑定契约
  - 分层约束：
    - `features/business/**`：业务行为语义（用户目标、系统可观察结果）
    - `features/technical/**`：技术契约语义（协议、路由、存储一致性）
  - 分类绑定：
    - `ux -> business`
    - `protocol|storage -> technical`
- `mappings/contract-to-tests.json`
  - 契约到证明层映射（`unit|integration|browser-cdp|e2e`）
  - `target` 支持多文件（同一条 proof 可包含多个 `path::anchor`）
  - `e2e` 的 `target` 支持 `path::selector`，gate 会校验 evidence 中存在命中的 passed 用例
  - `browser-cdp` 的 `target` 必须是 `.feature`，且必须被该 contract 的 `@contract(...)` 引用
- `evidence/*.json`
  - e2e 运行证据，`gate` 强制检查 `passed=true`

## 双层 LLM 测试策略

1. `BHV-LLM-CAPABILITY-GATE`（默认门禁）
- 使用 mock LLM，验证编排层正确性：SSE 消费、tool_call 闭环、降级状态语义。

2. `BHV-LLM-LIVE-CAPABILITY`（live 门禁）
- 使用真实 LLM endpoint，验证真实能力：浏览器任务成功率与可验证进展。
- 该契约 `context.gate_profile=live`，默认 `bdd:gate` 不检查，`bdd:gate:live` 检查。

## 命令

默认门禁（本地/CI 稳定）：

```bash
bun run brain:e2e
bun run bdd:lint:features
bun run bdd:validate
bun run bdd:gate
bun run bdd:gate:ux
bun run bdd:gate:protocol
bun run bdd:gate:storage
```

真实 LLM 门禁（需要外网与 key）：

```bash
BRAIN_E2E_LIVE_LLM_BASE="https://ai.chen.rs/v1" \
BRAIN_E2E_LIVE_LLM_KEY="<key>" \
BRAIN_E2E_LIVE_LLM_MODEL="gpt-5.3-codex" \
bun run brain:e2e:live

bun run bdd:gate:live
```

可调参数：

- `BRAIN_E2E_LIVE_ATTEMPTS`（默认 `3`）
- `BRAIN_E2E_LIVE_MIN_PASS`（默认 `ceil(attempts*0.67)`）

## 门禁语义

- `bdd:lint:features`
  - 校验 feature 是否位于 `business|technical` 正确目录。
  - 校验 contract category 与 feature 分层一致性（`ux->business`，`protocol|storage->technical`）。
  - 对 `business` 层执行“实现细节禁词”检查，防止把内部实现写进业务场景。
- `bdd:validate`
  - 先执行 `bdd:lint:features`，再校验契约结构、feature 引用、mapping 基本一致性、category 完整性。
- `bdd:gate`（`BDD_GATE_PROFILE=default`）
  - 先执行 `bdd:lint:features`。
  - 检查默认 profile 契约的 required layers、目标文件存在、evidence `passed=true`。
  - 若 e2e `target` 带 selector（`file.json::token`），还会校验证据中有命中的 passed 测试项。
- `bdd:gate:ux|protocol|storage`
  - 仅检查对应分类契约，适合分层门禁与分责任维护。
- `bdd:gate:live`（`BDD_GATE_PROFILE=live`）
  - 在默认契约基础上，额外检查 `gate_profile=live` 的契约。

## 双 Agent 反自证流程

1. 冻结契约
- `.feature` 先由用户或 Challenger 定稿，Builder 不得改写业务规则。

2. 先挑战后实现
- Challenger 先写边界场景（空值、重复操作、异常恢复）。
- Builder 只改实现，让既有场景通过。

3. 每轮加反例
- 每次“全绿”后必须新增至少 1 个反例场景，防止回归到“为绿而绿”。

4. 变异校验
- 周期性注入最小缺陷（如 `>` 改 `>=`），若测试未失败则回炉强化场景。

## 产物

- 默认 e2e 证据：`bdd/evidence/brain-e2e.latest.json`
- live e2e 证据：`bdd/evidence/brain-e2e-live.latest.json`
