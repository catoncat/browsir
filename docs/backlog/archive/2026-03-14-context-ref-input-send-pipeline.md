---
id: ISSUE-012
title: "`@路径` 输入与发送链路接线"
status: done
priority: p0
source: "next-development-master-plan-2026-03-14 + slice breakdown"
created: 2026-03-14
assignee: agent
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-store
depends_on:
  - ISSUE-009
write_scope:
  - extension/src/panel/components/ChatInput.vue
  - extension/src/panel/stores/runtime.ts
  - extension/src/sw/kernel/orchestrator.browser.ts
  - extension/src/sw/kernel/runtime-router/run-controller.ts
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags:
  - slice
  - context-ref
  - chat-input
  - send-pipeline
claimed_at: "2026-03-14T11:57:08.290Z"
---

# ISSUE-012: `@路径` 输入与发送链路接线

## 目标

把 `ChatInput` 的路径引用真正接到 `contextRefs` 发送链路。

## 范围

- 输入框提取结果
- send payload
- orchestrator / run-controller 接线

## 非目标

- 不做新的 prompt DSL
- 不做自动猜测文件注入

## 验收

- `@路径` 引用进入 `contextRefs`
- 发送链路不依赖纯文本 include
- 空文本 + contextRefs 仍可发起请求

## 工作总结

**日期**: 2026-03-14

**分析发现**：整条链路（ChatInput → App.vue → chat-store → run-controller → runtime-loop）已经将 `contextRefs` 字段一路传递到 SW，但存在三个关键问题：

1. ChatInput 使用默认 source `"prompt_parser"` 提取 refs，SW 的 `normalizeExplicitContextRefs` 会过滤掉该 source，导致 ChatInput 提取的 refs 全部被丢弃
2. ChatInput 发送原始文本（含 `@path` 字面量），SW 依赖重新解析原文来恢复 refs — 发送链路实质依赖纯文本 include
3. ChatInput 的 `handleSubmit` 空值守卫不检查 contextRefs，空文本 + contextRefs 无法提交

**修复内容**（仅 ChatInput.vue，共 4 行改动）：
- Source 改为 `"composer_mention"`，使 refs 通过 `normalizeExplicitContextRefs` 保留
- 发送 `extracted.cleanedText` 而非原始 `text.value`，消除纯文本依赖
- Guard 增加 `extracted.refs.length > 0` 检查，支持空文本 + contextRefs 提交

**验证**：run-controller / orchestrator / runtime-loop 无需修改，已原生支持 contextRefs。全部 300 测试通过，构建成功。

## 相关 commits

- `c7f8191` fix(ChatInput): wire @path refs as composer_mention contextRefs, send cleanedText

