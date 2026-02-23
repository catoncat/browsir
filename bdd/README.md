# BDD Framework Index

本目录是 Browser Brain Loop 的行为契约门禁中心，采用 `contract -> feature -> mapping -> evidence -> gate` 流程。

## 目录与职责

- `schemas/behavior-contract.schema.json`
  - 契约结构约束（`BHV-*`、proof layers、风险等级等）
- `contracts/**/*.json`
  - Canonical 行为契约
- `features/**/*.feature`
  - Gherkin 视图，必须通过 `@contract(BHV-...)` 绑定契约
- `mappings/contract-to-tests.json`
  - 契约到证明层映射（`unit|integration|browser-cdp|e2e`）
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
bun run bdd:validate
bun run bdd:gate
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

- `bdd:validate`
  - 校验契约结构、feature 引用、mapping 基本一致性。
- `bdd:gate`（`BDD_GATE_PROFILE=default`）
  - 检查默认 profile 契约的 required layers、目标文件存在、evidence `passed=true`。
- `bdd:gate:live`（`BDD_GATE_PROFILE=live`）
  - 在默认契约基础上，额外检查 `gate_profile=live` 的契约。

## 产物

- 默认 e2e 证据：`bdd/evidence/brain-e2e.latest.json`
- live e2e 证据：`bdd/evidence/brain-e2e-live.latest.json`
