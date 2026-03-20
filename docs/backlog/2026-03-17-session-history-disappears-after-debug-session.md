---
id: ISSUE-039
title: 调试会话后历史记录消失，live runtime 无法再找到 session
status: open
priority: p1
source: 用户调试对话 + debug snapshot dbg-20260317151924-session-fda15764-21d6-4033-b4e8-ed51b80a107c-3c9aa401
created: 2026-03-17
assignee: unassigned
tags: [session, history, persistence, diagnostics]
---

# ISSUE-039: 调试会话后历史记录消失，live runtime 无法再找到 session

## 现象

- 用户反馈“对话历史坏掉了，没了”。
- 用户提供的 debug snapshot 仍然存在，说明该 session 在 `2026-03-17T15:19:24Z` 时曾成功导出：
  - `sessionId = session-fda15764-21d6-4033-b4e8-ed51b80a107c`
  - `title = "Hi. How can I help you with …"`
- 但随后通过 live runtime 调试接口 `brain.debug.dump` 再次查询同一 `sessionId`，返回：
  - `session 不存在: session-fda15764-21d6-4033-b4e8-ed51b80a107c`

## 已知证据

- 快照文件：
  - `http://127.0.0.1:8787/api/debug-snapshots/dbg-20260317151924-session-fda15764-21d6-4033-b4e8-ed51b80a107c-3c9aa401`
- live 调试：
  - `brain.debug.dump({ sessionId })` 返回 `ok=false`，错误为 `session 不存在`
- 当前问题与“标题不回填”无直接因果关系；标题问题已在本轮通过 hosted_chat body 解析修复。

## 初步判断

- 更像是 session index / meta / entries 的持久化或恢复链路有缺口，而不是单纯 UI 渲染问题。
- 由于 snapshot 仍可下载，说明 Bridge 导出物与 runtime 当前 session registry 已经分叉。
- 需要重点检查：
  - `orchestrator.sessions.listSessions()` 与 `getMeta(sessionId)` 的一致性
  - Service Worker 重启后的 session 恢复路径
  - panel 会话列表刷新与真实 session storage 的同步关系

## 建议下一步

1. 复现“有 snapshot 但 live dump 查不到 session”的最短路径。
2. 对比 `listSessions()`、`getMeta()`、`getEntries()` 在 SW 重启前后的结果。
3. 检查最近和会话列表、fork/edit-rerun、auto title 回写相关的改动是否影响 session meta/index 落盘。
