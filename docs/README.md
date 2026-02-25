# Docs 索引（精简版）

目标：让后续开发优先对齐“当前真实实现”，避免被历史口径带偏。

## 1. 当前主线（必读，按顺序）

1. `docs/kernel-alignment-2026-02-25.md`
   - 本轮对齐基线：严格 done 语义、消息模型 transform、step stream 限流、trace 瘦身。
2. `docs/pi-alignment-implementation-map.md`
   - Pi 对齐点到代码锚点/测试锚点的映射。
3. `bdd/README.md`
   - 门禁语义与证明链路（contract -> feature -> mapping -> evidence -> gate）。

## 2. 实施文档（按需）

1. `docs/llm-provider-subagent-design.md`
   - Provider/Agent 路线与能力门禁设计。
2. `docs/refactor-status-summary-2026-02-25.md`
   - 本轮重构状态摘要。
3. `docs/goal-plan-next-phase-2026-02-25.md`
   - 下一阶段目标与拆解。

## 3. 架构与专题参考

- `docs/non-ui-architecture-blueprint.md`
- `docs/pi-mono-runtime-comparison.md`
- `docs/browser-agent-reliability-playbook.md`
- `docs/browser-agent-reliability-checklist.md`
- `docs/adr-0001-browser-agent-reliability.md`

## 4. 使用约定

- 若文档与实现冲突，以以下三者为准：
  1. `docs/kernel-alignment-2026-02-25.md`
  2. `extension/src/sw/kernel/**` 当前代码
  3. `extension/src/sw/kernel/__tests__/**` 与 `bdd:gate` 结果
