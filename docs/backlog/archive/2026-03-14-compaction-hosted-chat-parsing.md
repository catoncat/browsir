---
id: ISSUE-002
title: Compaction 不支持 hosted_chat 响应格式导致上下文压缩失败
status: done
priority: p0
source: 调试对话 session-816e926f（2026-03-14）
created: 2026-03-14
assignee: agent
resolved: 2026-03-14
commit: 2175bd1
tags: [bug, compaction, hosted-chat, llm]
---

# ISSUE-002: Compaction 不支持 hosted_chat 响应格式

## 现象

通过 `cursor_help_web` provider 执行 compaction 时，LLM 返回了 status=200 的有效 hosted_chat JSONL 响应（24KB，以 `## Goal` 开头的合法摘要内容），但系统判定 "Compaction summary 为空" 并以 `failed_execute` 终止 loop。

## Root Cause

`requestCompactionSummaryFromLlm()`（`runtime-loop.browser.ts:~850-940`）调用 `parseLlmMessageFromBody(rawBody, contentType)` 解析响应。

`parseLlmMessageFromBody`（`loop-llm-stream.ts:316-333`）只处理两种格式：
1. SSE（`text/event-stream` 或 body 以 `data:` 开头）
2. OpenAI-compatible JSON（`{ choices: [{ message: {...} }] }`）

hosted_chat 的 content-type 是 `application/x-browser-brain-loop-hosted-chat+jsonl`，body 是每行一个 JSON 的 transport event，两种条件都不满足。结果返回 `{}`，`parseLlmContent({})` 结果为 `""`，触发错误。

主 loop（`runtime-loop.browser.ts:~2620`）正确使用 `readHostedChatTurnFromTransportStream` 处理此格式，但 compaction 路径没有适配。

## 修复方向

在 compaction 的响应解析处（`runtime-loop.browser.ts:~904`），增加对 hosted_chat 格式的检测，复用 `readHostedChatTurnFromTransportStream` 或等效逻辑提取 `assistantText` 作为 summary。

## 关键文件

- `extension/src/sw/kernel/runtime-loop.browser.ts` — requestCompactionSummaryFromLlm、主 loop 对比
- `extension/src/sw/kernel/loop-llm-stream.ts` — parseLlmMessageFromBody
- `extension/src/sw/kernel/orchestrator.browser.ts` — runCompaction 入口
