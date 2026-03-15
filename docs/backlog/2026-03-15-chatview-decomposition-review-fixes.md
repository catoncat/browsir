---
id: ISSUE-032
title: "ChatView 拆分 review 修复 — 异步竞态 / 时序耦合 / unmount 守卫"
status: done
priority: p1
source: "review/2026-03-15-round2-chatview-decomposition-review.md"
created: 2026-03-15
assignee: copilot
kind: slice
parallel_group: panel-shell
depends_on: []
write_scope:
  - extension/src/panel/ChatView.vue
  - extension/src/panel/App.vue
  - extension/src/panel/composables/use-chat-session-effects.ts
  - extension/src/panel/composables/use-tool-run-tracking.ts
tags: [slice, panel, chatview, correctness, review-fix]
---

# ISSUE-032: ChatView 拆分 review 修复

## 来源

Round 2 Code Review — 2 CRITICAL + 3 HIGH 发现。

## 修复清单

### CRITICAL

- [x] **C1**: `use-chat-session-effects.ts` fork title watcher 添加 staleness guard
- [x] **C2**: 消除 `bindLlmStreaming` 时序耦合（直接注入或添加 runtime assertion）

### HIGH

- [x] **H1**: `useToolRunTracking` 返回类型显式声明 `runPhase` 为 `WritableComputedRef`
- [x] **H2**: 异步 watcher 添加 unmount disposal 检查
- [x] **H3**: 替换 `defineExpose` 耦合为窄接口或 store

### MEDIUM（可后续处理）

- [x] **M1**: 删除 App.vue 中未使用的 `activeSessionId`
- [x] **M4**: `rebuildStableMessages` watch 添加 debounce 或串行队列

## 验收

- C1/C2 修复后 fork + LLM streaming 场景回归正常
- 现有测试继续通过
- `bun run build` 成功
