---
id: ISSUE-001
title: 诊断系统优化 — 6 项改进
status: done
priority: p1
source: 调试对话 session-816e926f（2026-03-14 compaction 失败 + dog plugin UI 诊断）
created: 2026-03-14
assignee: agent
resolved: 2026-03-14
tags: [diagnostics, debug-snapshot, developer-experience]
---

# ISSUE-001: 诊断系统优化

## 背景

在诊断 compaction 失败 + dog plugin UI 未加载两个问题时，调试链接（diagnostics + debug-snapshot）提供了有效数据，但发现以下可优化点。

## 2026-03-14 进度更新

### 已落地

- `49ca822` `feat(extension): add filtered debug runtime views`
  - `brain.debug.runtime` / `brain.debug.snapshot` 支持按 `pluginId`
    及 `channels / eventTypes / text / errorsOnly` 过滤。
  - 为 Plugin Studio 的插件级调试导出打底，避免新增第三套后端 debug API。
- `b1438c3` `feat(extension): add filtered plugin studio debug links`
  - `extension/plugin-studio.html` 的运行日志支持按当前插件、关键词、错误状态、频道、热词筛选。
  - Plugin Studio 新增统一“复制调试链接”，导出的 payload 带当前筛选条件和筛选后日志。
- `f8f1448` `refactor(extension): unify chat debug link entry`
  - Chat 侧边栏收敛为单一“复制调试链接”入口。
  - 去掉并列的“复制诊断链接 / 复制调试快照链接 / 运行调试”入口，减少概念重叠。

### 对本 Issue 的影响

- 第 4 项 `plugin snapshot 缺少 UI 渲染链路状态`
  - **已完成**。`5a86611` 新增 `uiState` 字段到 plugin snapshot，包含：
    - `relayActive`（SidePanel 连接状态，via `chrome.runtime.getContexts`）
    - `panelAvailable`（SidePanel 是否响应查询）
    - `plugins`（per-plugin widget mount 状态、mounted widget IDs、errorCount、lastError）
  - 实现路径：`PanelUiPluginRuntime.getUiStateSnapshot()` → `bbloop.ui.state.query` 消息 → `buildPluginSnapshot()` 合并
- 第 5 项 `AGENTS.md 补充 diagnostics vs snapshot 选择策略`
  - 产品入口已先收敛，但 AGENTS 决策树文档尚未更新。

### 2026-03-14 第二轮进度

- `0799d67` `feat: enhance diagnostics — source/contentType in llm trace + column index + dynamic hints`
  - 第 1 项：diagnosticGuide.columnIndex 提供 rawEventTail/llm.skipped/llm.trace 的列名→索引映射
  - 第 2 项：compaction llm.request 增加 `source: "compaction"`；所有 llm.response.raw 增加 source 和 contentType；llm.trace preferredColumns 显式包含 source/stage/detail/contentType
  - 第 3 项：diagnosticGuide.hints 根据 lastError 自动生成诊断建议（compaction/offscreen/LLM HTTP/no_progress/timeout）
  - 第 6 项：buildLlmRawTracePayload 新增 source 和 contentType 参数
- `f17d418` `docs: add diagnostics vs snapshot decision strategy to AGENTS.md`
  - 第 5 项：AGENTS.md 新增 diagnostics vs snapshot 选择策略、交叉检索规则、uiState 说明

### Close Issues 总结

- `ISSUE-001` 全部 6 项均已完成，标记为 `done`。
- 关联 commits：`5a86611` (uiState), `0799d67` (trace+guide), `f17d418` (AGENTS.md)

## 优化项

### 1. columnar 格式需要索引辅助（p2）

`rawEventTail` 和 `llm.trace` 使用 `{ columns, rows }` 格式，用 jq 查询需要对照 columns 用数字下标（如 `.[2]`），容易出错。

**方案**：保留 columnar 节省体积，在 JSON 顶层加 `_columnIndex: { rawEventTail: {...}, llm: {...} }` 字段。或在 `diagnosticGuide` 中内联列名映射表。

### 2. llm.trace 缺少 source 标记（p1）

所有 LLM trace 行没有区分 "主 loop 调用" 和 "compaction 调用"。诊断时只能靠 timeline 文本反推哪条 trace 对应 compaction。

**方案**：在 `llm.trace.columns` 中确认 `source` 列已被填充（`"loop"` / `"compaction"` / `"summary"`），确保所有 LLM 请求事件包含此值。

### 3. diagnosticGuide 可做动态诊断建议（p2）

`payload.diagnosticGuide` 当前内容不明，未被诊断流程利用。

**方案**：导出时根据 `summary.lastError` 自动生成简短的诊断建议。如检测到 compaction 失败，输出 "检查 requestCompactionSummaryFromLlm 的 transport 兼容性"。

### 4. plugin snapshot 缺少 UI 渲染链路状态（p1）

快照中 plugin 有 `runtimeMessages`、`hooks`、`errorCount`，但缺少：
- UI widget mount 状态（是否成功挂载到 SidePanel DOM）
- runtimeMessage 投递状态（消息是否被 SidePanel 接收/丢弃）
- SidePanel relay 连接状态

**方案**：在 plugin snapshot 中增加 `uiState: { widgetMounted, lastMessageDelivered, relayActive }` 字段。

### 5. AGENTS.md 补充 diagnostics vs snapshot 选择策略（p1）

当前调试文档的推荐检索顺序只覆盖 diagnostics 内部的遍历路径，缺少：
- 何时优先看 diagnostics vs snapshot 的决策规则
- cross-reference 指引（diagnostics 中出现 plugin 错误时交叉查看 snapshot）

**方案**：在 AGENTS.md "对话调试" 段落增加决策树。

### 6. 缺少 transport 格式标识（p2）

诊断中 compaction 的 `llm.request` 记录了 `provider`，但没有标记 response 的 transport 格式（如 `responseFormat: "hosted_chat_jsonl"`）。

**方案**：在 `llm.response.raw` 事件中增加 `transportFormat` 字段。

## 关联 Bug

- Compaction 失败：`requestCompactionSummaryFromLlm` 不支持 hosted_chat 响应格式 → 另行修复
- Dog plugin offscreen：manifest.json 缺少 `"offscreen"` 权限 → 另行修复
