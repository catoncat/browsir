# ISSUE-033: LLM 模块提取残留清理

- **优先级**: P2
- **来源**: Round 3 Review (2026-03-15)
- **状态**: Open

## 问题描述

LLM 效率优化提取（loop-llm-request.ts、loop-compaction-llm.ts、loop-browser-proof.ts）整体质量良好，但遗留以下清理项：

## 待办

1. **删除 runtime-loop.browser.ts 中 8 个 dangling imports** [HIGH]
   - computeRetryDelayMs, extractRetryDelayHintMs, isRetryableLlmStatus
   - hostedChatTurnToMessage, parseLlmMessageFromBody
   - readHostedChatTurnFromTransportStream, readLlmMessageFromSseStream
   - mapToolErrorReasonToTerminalStatus

2. **合并重复 createNonRetryableRuntimeError helper** [MEDIUM]
   - 出现在 loop-llm-request.ts 和 loop-compaction-llm.ts
   - 提取到 loop-shared-utils.ts

3. **对齐 compaction 重试延迟计算** [MEDIUM]
   - llmMaxRetryDelayMs=0 时 catch block 与 HTTP error block 行为不一致

4. **合并重复 BuildLlmRawTracePayloadInput 接口** [LOW]

## 验收标准

- `bun run build` 通过
- `bun run test` 全部通过
- runtime-loop.browser.ts 无未使用导入
- createNonRetryableRuntimeError 仅定义一次
