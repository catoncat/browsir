# Diagnostics Format

Browser Brain Loop 的诊断导出是给人和外部 AI 一起消费的单文件 JSON，目标是：

- 单链接下载
- 顶层分块稳定
- 低噪音
- 方便 `jq` / `rg` / 程序化读取

## 当前版本

- schema: `bbl.diagnostic.v4`
- 诊断文本包裹标记：`[[BBL_DIAGNOSTIC_V4]] ... [[/BBL_DIAGNOSTIC_V4]]`

## 顶层结构

- `diagnosticGuide`
  - 机器可读的检索顺序与 `jq` 提示
- `summary`
  - 最先看，含 `lastError` 与紧凑 `sandbox` 摘要
- `timeline`
  - 适合先快速扫最近发生了什么
- `sandbox`
  - 浏览器沙盒运行时专用诊断块
- `llm`
  - LLM 请求/解析/重试轨迹
- `tools`
  - 工具执行轨迹
- `agent`
  - loopRuns、decisionTrace、conversationTail
- `rawEventTail`
  - 最后兜底看原始尾部事件
- `debug`
  - 导出元信息与裁剪信息

## 推荐检索顺序

1. `summary.lastError`
2. `timeline`
3. `sandbox.summary`
4. `sandbox.trace`
5. `llm.trace`
6. `tools.trace`
7. `agent.loopRuns`
8. `rawEventTail`

## Sandbox 结构

`sandbox.summary` 聚合浏览器沙盒运行信息，重点字段：

- `flushCount`
- `flushSkippedCount`
- `forcedFlushCount`
- `flushTotalMs`
- `flushTotalBytes`
- `flushTotalFiles`
- `commandCount`
- `commandTimeoutCount`
- `commandNonZeroExitCount`
- `lastFlushAt`
- `lastFlushReason`
- `lastCommandAt`
- `lastCommand`
- `lastCommandExitCode`
- `runtime`
  - live runtime 的 `createdAt` / `lastUsedAt` / `lastFlushedAt` / `dirty`

`sandbox.trace` 是紧凑表格，最近事件 tail，常见 `type`：

- `flush.finished`
- `flush.skipped`
- `command.finished`

常用列：

- `ts`
- `type`
- `reason`
- `durationMs`
- `bytes`
- `fileCount`
- `forced`
- `dirty`
- `command`
- `exitCode`
- `timeoutHit`

## 常用 jq

```bash
jq '.summary.lastError' diag.json
jq '.summary.sandbox' diag.json
jq '.sandbox.summary' diag.json
jq '.sandbox.trace' diag.json
jq '.llm.trace' diag.json
jq '.tools.trace' diag.json
```

## 常用 rg

```bash
rg 'loop_error|llm.skipped|failed_execute|failed_verify|no_progress' diag.json
rg 'flush\\.finished|flush\\.skipped|command\\.finished|timeoutHit' diag.json
```

## 使用原则

- 不要把整个诊断 JSON 原样贴回模型上下文
- 先下载到本地文件，再精确检索
- 先看摘要和紧凑 trace，只有证据不足时再看 `rawEventTail`
