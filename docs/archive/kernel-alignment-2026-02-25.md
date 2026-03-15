# Kernel 对齐基线（2026-02-25）

目标：给后续开发一个“当前真实实现”的最小对齐面，避免继续按旧口径（规则 fallback、大 payload trace、弱消息模型）开发。

## 1. 本轮已落地（必须知道）

对应提交：

- `49a8fa9`：compaction 改为 LLM 摘要链路 + trace 放大修复
- `5b9c7da`：消息模型增加 Pi 风格 transform（tool_call/tool_result 配对、id 归一）
- `1f1d75c`：`brain.step.stream` 增加条数/字节门禁 + compaction 摘要请求重试与退避

## 2. 当前硬约束（不要再改回去）

1. 缺少 LLM 配置不是“降级成功”，而是 `failed_execute`。
2. compaction 摘要必须通过独立 LLM 请求生成，不允许本地拼接假摘要。
3. 发给 LLM 前必须走消息 transform：
   - 保留历史 `role=tool + tool_call_id`
   - 补齐 assistant/tool_result 配对
   - 归一化非法 tool_call_id
4. step stream 返回必须受限流保护（事件数 + 字节数），不能无上限返回全量 trace。
5. `llm.response.raw` 只保留 `bodyPreview + bodyLength + bodyTruncated`，不回填整包 body。

## 3. 代码锚点（开发入口）

### 3.1 消息模型

- `extension/src/sw/kernel/llm-message-model.browser.ts`
  - `convertSessionContextMessagesToLlm`
  - `transformMessagesForLlm`
  - `normalizeToolCallId`

### 3.2 主循环与 compaction 摘要

- `extension/src/sw/kernel/runtime-loop.browser.ts`
  - 主请求：`requestLlmWithRetry`
  - compaction 摘要：`requestCompactionSummaryFromLlm`
  - 缺 LLM 配置收口：`loop_done.status=failed_execute`

### 3.3 step stream 与 debug dump 限流

- `extension/src/sw/kernel/runtime-router.ts`
  - `brain.step.stream` 支持 `maxEvents/maxBytes`
  - 返回 `streamMeta`（`truncated/cutBy/returnedEvents/returnedBytes/...`）
  - `brain.debug.dump` 同样返回裁剪后的 `stepStream` + `stepStreamMeta`

### 3.4 trace 持久化

- `extension/src/sw/kernel/session-store.browser.ts`
  - `readTraceChunk` / `writeTraceChunk` 按 `chunk` 真正分片读写（含旧数据兼容）

## 4. 对齐 Pi 的最小语义

1. compaction 流程：
   - 先 `prepareCompaction`
   - 再 `compact(...summaryGenerator)`
   - 摘要由外部 LLM hook 注入（`compaction.summary`）
2. 消息 transform：
   - 发送前统一转换
   - assistant/tool 关系在 transform 层修复，不在业务层散落修补
3. 错误语义：
   - retryable 才重试
   - 非 retryable 明确失败，不走静默 fallback

## 5. 关键测试（改代码前后都要跑）

```bash
bun test extension/src/sw/kernel/__tests__/compaction.browser.test.ts \
  extension/src/sw/kernel/__tests__/session-manager.browser.test.ts \
  extension/src/sw/kernel/__tests__/orchestrator.browser.test.ts \
  extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts \
  extension/src/sw/kernel/__tests__/llm-message-model.browser.test.ts

bun run bdd:validate
bun run bdd:gate
```

## 6. BDD 对齐重点

优先保证以下契约不回归：

- `BHV-CHAT-DONE-SEMANTICS-STRICT`
- `BHV-CHAT-HISTORY-INCLUDES-TOOL-RESULT`
- `BHV-SESSION-COMPACTION-STATE-MACHINE`
- `BHV-LLM-CAPABILITY-GATE`

## 7. 后续开发建议（按优先级）

1. 继续做“消息模型全链路同构”（统一内部 Message 类型，减少 runtime-loop 分支转换）。
2. 补 live 证据自动刷新流程（把默认 gate 与 live gate 的证据生成完全分离）。
3. 清理 `storage-reset` 测试隔离问题，恢复 kernel 全量绿灯。
