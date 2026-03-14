---
id: ISSUE-015
title: BDD / 文档边界同步
status: done
priority: p1
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: copilot
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: bdd-docs
depends_on: [ISSUE-006, ISSUE-009, ISSUE-010, ISSUE-012, ISSUE-014]
write_scope:
  - bdd
  - docs/kernel-architecture.md
  - docs/context-reference-filesystem-and-kernel-boundaries-design-2026-03-13.md
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, bdd, docs, architecture]
---

# ISSUE-015: BDD / 文档边界同步

## 目标

让 BDD 契约分类、证明要求、架构文档与当前真实边界一致。

## 范围

建议分两阶段执行：

### Phase A（可提前启动，不依赖代码重构完成）
- contract categories 重编目
- 证明要求更新

### Phase B（等代码稳定后启动）
- kernel 文档边界
- context ref 文档边界

## 非目标

- 不在本 slice 内继续大规模代码重构

## 验收

- 契约分类能反映当前一级模块
- 不再接受源码锚点充当 required proof
- 文档与目录边界一致

## 工作总结

### Phase A: 契约重编目 + 证明修复

1. **contract-categories.json**: 3 类 (`protocol`/`ux`/`storage`) → 6 类 (`orchestrator`/`runtime-loop`/`cdp`/`llm`/`session`/`panel`)，每个契约映射到其实际所属的一级子系统
2. **contract-to-tests.json**: 修复 7 处 stale proof targets：
   - `runtime.ts::saveConfig` → `config-store.ts::saveConfig`
   - `runtime.ts::loadConversation` → `chat-store.ts::loadConversation`
   - `runtime.ts::forkFromAssistantEntry+retryLastAssistantEntry` → `chat-store.ts`
   - `runtime.ts::sendPrompt` → `chat-store.ts::sendPrompt`
   - `runtime-loop.browser.ts::shouldVerifyStep` → `loop-browser-proof.ts::shouldVerifyStep`（2 处）
   - `runtime-loop.browser.ts::refreshSessionTitleAuto` → `loop-session-title.ts::refreshSessionTitleAuto`
3. **Added test file refs**: no-progress 契约 proof 添加了 `loop-progress-guard.browser.test.ts` 引用，消除纯源码锚点
4. **BDD tooling**: 更新 `bdd-lib.ts` 类型/集合、`bdd-gate.ts` 错误信息、`bdd-feature-lint.ts` category→layer 映射（`panel`→business，`orchestrator`/`cdp`/`llm`→technical，`session`/`runtime-loop`→混合不强制）、测试 `ux`→`panel`

### Phase B: 文档边界

1. **kernel-architecture.md**: 31→50 模块，§9 补充 10 个缺失核心模块，新增 §10 Loop 提取模块（10 个 `loop-*.ts` 纯函数模块）
2. **context-ref doc §11**: 添加实施进度注释（Store 拆分 ✅、Loop 拆分 部分完成、Router/SidePanel 拆分 未开始）
3. **AGENTS.md**: 模块数 31→50

### 残留

6 个 pre-existing gate failures 未修复（与本 ISSUE 无关，属于 runtime-router.ts 源码中函数签名变更导致的锚点失配）。

## 相关 commits

- `b15095f` refactor(bdd): realign contract categories and fix stale proof targets (ISSUE-015 Phase A)
- `5195d0c` docs: update kernel architecture to 50 modules + add loop extraction section (ISSUE-015 Phase B)

