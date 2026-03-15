# Docs 索引

目标：让后续开发优先对齐“当前真实实现”，避免被历史口径带偏。

## 1. 当前主线（必读）

1. `docs/kernel-architecture.md`
   - Kernel 引擎架构：6 大子系统、50 模块、消息协议、事件总线。
2. `docs/background-mode-design-2026-06.md`
   - 后台自动化模式设计：Content Script DOM 快照 + DomLocator 合成事件，对标 AIPex 5 层隔离。Phase 1-3 全部实现完毕。
3. `bdd/README.md`
   - 门禁语义与证明链路（contract → feature → mapping → evidence → gate）。

## 2. 调试与诊断

1. `docs/debug-interfaces.md` — 模块级窄接口
2. `docs/debug-snapshot-format.md` — 全局调试快照结构
3. `docs/diagnostics-format.md` — 会话级诊断 JSON 结构
4. `docs/runtime-debug-interface.md` — `brain.debug.runtime` 运行态接口
5. `docs/ai-debug-architecture.md` — AI Agent 调试架构

## 3. 插件与 Skill 系统

1. `docs/plugin-api-reference.md` — Plugin API 参考
2. `docs/plugin-system-product-design.md` — 插件系统产品设计
3. `docs/builtin-plugins.md` — 内置插件列表
4. `docs/plugin-architecture-gitlog.md` — 插件架构演进记录
5. `docs/plugin-ui-widget-api-plan-2026-03-14.md` — Panel 插件 UI widget API 方案

## 4. 架构与专题参考

- `docs/non-ui-architecture-blueprint.md` — 非 UI 架构蓝图
- `docs/llm-provider-subagent-design.md` — Provider/Agent 路线设计
- `docs/sandbox-page-design.md` — Sandbox 页面设计
- `docs/adr-0001-browser-agent-reliability.md` — ADR: 浏览器 agent 可靠性
- `docs/browser-agent-reliability-playbook.md` — 浏览器 agent 可靠性手册
- `docs/browser-agent-reliability-checklist.md` — 可靠性检查表
- `docs/cursor-toolbox-reference-2026-03-15.md` — Cursor-Toolbox 外部参考
- `docs/cursor-help-runtime-alignment-plan-2026-03-12.md` — Cursor Help 运行时对齐
- `docs/context-reference-filesystem-and-kernel-boundaries-design-2026-03-13.md` — 上下文引用与边界设计

## 5. 已归档（历史口径，仅供考古）

位于 `docs/archive/`，包含早期对齐文档（kernel-alignment、pi-alignment、refactor-status 等）。

## 6. 外部参考仓库

- **Pi monorepo**（Agent Core + LLM Provider）：`~/work/repos/_research/pi-mono/`
- **AIPex**（浏览器自动化参考实现）：`~/work/repos/_research/AIPex/`

详细参考路径见 `AGENTS.md` 中的"外部参考仓库"小节。

## 7. 使用约定

- 若文档与实现冲突，以以下三者为准：
  1. `AGENTS.md`（系统提示词）
  2. `extension/src/sw/kernel/**` 当前代码
  3. `extension/src/sw/kernel/__tests__/**` 与 `bdd:gate` 结果
