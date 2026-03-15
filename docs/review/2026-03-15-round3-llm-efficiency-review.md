# Round 3 Review: LLM 效率与流式优化

**日期**: 2026-03-15
**审查范围**: loop-llm-request.ts (+455), loop-compaction-llm.ts (+346), loop-browser-proof.ts (+163), prompt-policy.browser.ts (修改), runtime-loop.browser.ts (-766)
**涉及 Agent**: Agent 2 (Chat/UI)

---

## 总体评价

模块提取执行良好。三个新模块接口清晰、错误传播正确、无意外耦合。`skipToolListing` 和 `shapeSnapshotForLlm` 实现正确。浏览器验证预算(budget=4)追踪逻辑完善。

---

## HIGH（1 项）

### H1: runtime-loop.browser.ts 中 8 个 dangling imports
**文件**: runtime-loop.browser.ts L75-100
**问题**: 提取后遗留 8 个未使用的导入（`computeRetryDelayMs`, `extractRetryDelayHintMs`, `isRetryableLlmStatus`, `hostedChatTurnToMessage`, `parseLlmMessageFromBody`, `readHostedChatTurnFromTransportStream`, `readLlmMessageFromSseStream`, `mapToolErrorReasonToTerminalStatus`）。
**修复**: 删除。

---

## MEDIUM（2 项）

### M1: createNonRetryableRuntimeError 重复定义
**文件**: loop-llm-request.ts L61-71, loop-compaction-llm.ts L63-73
**问题**: 两个模块中有完全相同的 helper 函数。
**修复**: 提取到 `loop-shared-utils.ts`。

### M2: Compaction 重试延迟计算不一致
**文件**: loop-compaction-llm.ts catch block vs HTTP !ok block
**问题**: 当 `llmMaxRetryDelayMs=0` 时，catch block 会用 0 作为延迟上限（立即重试），而 HTTP 错误路径用 `Number.MAX_SAFE_INTEGER`。
**修复**: 对齐两处计算逻辑。

---

## LOW（1 项）

### L1: BuildLlmRawTracePayloadInput 接口重复定义
**修复**: 共享接口。

---

## 正面评价

- `loop-browser-proof.ts` 纯函数、零耦合、最佳模块
- `skipToolListing` 正确消除 2-3K token 重复
- `shapeSnapshotForLlm` 正确压缩 DOM 快照（保留 uid/ref/role/label）
- 错误传播链完整
- budget=4 的 per-scope-key 设计合理
