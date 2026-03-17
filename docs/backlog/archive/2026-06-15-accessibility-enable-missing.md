---
id: ISSUE-036
title: "CDP 快照缺少 Accessibility.enable — 导致 Shadow DOM 页面返回空 AX 树"
status: done
closed: 2026-06-15
priority: p0
source: "debug-snapshot session-cf17f57d — Grok.com search_elements 返回 0 结果"
created: 2026-06-15
assignee: copilot
claimed_at: 2026-06-15T21:40:00+08:00
tags: [cdp, snapshot, shadow-dom, accessibility]
---

# ISSUE-036: CDP 快照缺少 Accessibility.enable

## 问题描述

在 Grok.com 等使用 Shadow DOM 的页面上，`search_elements` 始终返回 0 个交互元素，导致 agent 无法完成任何自动化操作。

## 根因分析

### 对比 AIPex 的 CDP 调用序列

| 步骤 | AIPex (snapshot-manager.ts) | BBL (runtime-infra.browser.ts) |
|------|---------------------------|-------------------------------|
| 1 | `Accessibility.enable({})` | ❌ **缺失** |
| 2 | `getFullAXTree({})` — 不传 frameId | `getFullAXTree({ frameId })` — 逐帧调用 |
| 3 | `iframeManager.populateIframes()` | fallback: `getFullAXTree({})` |

### 关键发现

1. **`Accessibility.enable` 是 CDP 协议要求**：启用 Accessibility domain 后，Chrome 才会完整计算无障碍树。BBL 从未调用过此 API（全仓库搜索 0 匹配）。

2. **`Accessibility.getFullAXTree` 天然穿透 Shadow DOM**：无障碍树是渲染后的扁平化表示，不受 Shadow DOM boundary 限制。AIPex 能正常操作 Grok.com 正是因为它先 enable 了 Accessibility domain。

3. **不是 Shadow DOM 不可穿透，而是 AX 树未完整构建**。

### 证据

Debug snapshot: `dbg-20260315133127-session-cf17f57d-b2fa-4944-821d-1d54d6dc2bbe`
- 12 LLM steps, 14 tool steps
- `search_elements` 返回 `count: 0`
- Agent 正确识别 "Shadow DOM 限制" 并调用 `request_intervention`

## 修复方案

在 `takeInteractiveSnapshotByAX()` 中，于 `getFullAXTree` 调用前添加：

```typescript
await sendCdpCommand(tabId, "Accessibility.enable", {});
```

## 补充改进（可选）

- DOM 快照路径（`dom-snapshot-collector.ts`）的 `traverseElement()` 也不穿透 Shadow DOM（只遍历 `el.children`），后续可增加 `el.shadowRoot` 递归遍历。
- `dom-locator.ts` 的 `queryByUid()` 也不搜索 Shadow Root。

## 验收标准

- [x] `Accessibility.enable` 在 `takeInteractiveSnapshotByAX` 中被调用
- [x] `bun run test` 全部通过
- [x] `bun run build` 通过

## 完成总结

主修复（`Accessibility.enable`）已合入 main。补充改进（Shadow DOM 穿透遍历）也已完成：
- `dom-snapshot-collector.ts`: `traverseElement()` + `extractVisibleText()` 穿透 Shadow Root
- `dom-locator.ts`: `queryByUid()` 重写为 `deepQuery()`，统一搜索 Document → Shadow Root → iframe
- 新增 3 个 Shadow DOM 测试用例

## 相关 commits

- `39ef13a` fix(cdp): add Accessibility.enable before getFullAXTree (ISSUE-036)
- `afafb7f` feat(snapshot): Shadow DOM 穿透遍历 — traverseElement/extractVisibleText/queryByUid
