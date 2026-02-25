# Browser Brain 对齐 Pi 实现映射（2026-02-25）

> 基线：以 `pi-mono` 的 session/compaction/message-transform 语义为准，浏览器侧替换存储介质（`chrome.storage.local` 分片），但不改变关键状态判定与事件语义。

## 1) Pi 对照点 -> 目标实现 -> 验证锚点

| Pi 对照点 | Browser Brain 实现 | 验证锚点 |
| --- | --- | --- |
| `session-manager.ts` `buildSessionContext` | `extension/src/sw/kernel/session-manager.browser.ts` `buildSessionContext()` | `extension/src/sw/kernel/__tests__/session-manager.browser.test.ts` |
| `session-manager.ts` `append* / getBranch / getLeaf / setLeaf` | `extension/src/sw/kernel/session-manager.browser.ts` 对应方法 | `extension/src/sw/kernel/__tests__/session-manager.browser.test.ts` |
| `compaction/compaction.ts` `findCutPoint` | `extension/src/sw/kernel/compaction.browser.ts` `findCutPoint()` | `extension/src/sw/kernel/__tests__/compaction.browser.test.ts` |
| `compaction/compaction.ts` `prepareCompaction/compact` | `extension/src/sw/kernel/compaction.browser.ts` `prepareCompaction()/compact()` | `extension/src/sw/kernel/__tests__/compaction.browser.test.ts` |
| Pi compaction 的外部摘要生成 hook（summaryGenerator） | `extension/src/sw/kernel/runtime-loop.browser.ts` `requestCompactionSummaryFromLlm()` + `compaction.summary` hook | `extension/src/sw/kernel/__tests__/orchestrator.browser.test.ts` |
| Pi `transform-messages.ts`（tool_call/tool_result 配对） | `extension/src/sw/kernel/llm-message-model.browser.ts` `transformMessagesForLlm()` / `normalizeToolCallId()` | `extension/src/sw/kernel/__tests__/llm-message-model.browser.test.ts` |
| 发送前统一消息转换（会话上下文 -> LLM 消息） | `extension/src/sw/kernel/llm-message-model.browser.ts` `convertSessionContextMessagesToLlm()` | `extension/src/sw/kernel/__tests__/llm-message-model.browser.test.ts` |
| 严格 done 语义（缺 LLM 配置不成功降级） | `extension/src/sw/kernel/runtime-loop.browser.ts`（`missing_llm_config` -> `failed_execute`） | `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts` |
| step trace 读取门禁（防止上下文爆炸） | `extension/src/sw/kernel/runtime-router.ts`（`brain.step.stream` `maxEvents/maxBytes` + `streamMeta`） | `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts` |
| trace/raw 负载瘦身策略 | `extension/src/sw/kernel/runtime-loop.browser.ts`（`llm.response.raw` 仅保留 preview 元信息） | `tools/brain-e2e.ts`（`llm.response.raw` 可观测断言） |
| trace 分片持久化语义 | `extension/src/sw/kernel/session-store.browser.ts` `readTraceChunk()/writeTraceChunk()` | `extension/src/sw/kernel/__tests__/session-manager.browser.test.ts` |

## 2) 接口冻结（继续保持 1:1）

- 事件名：`auto_retry_start`、`auto_retry_end`、`auto_compaction_start`、`auto_compaction_end`、`session_compact`
- 协议：
  - `brain.run.start|stop|pause|resume`
  - `brain.session.view|get|list`
  - `brain.step.stream`
  - `brain.storage.archive|reset|init`
- 存储键：
  - `session:index`
  - `session:<id>:meta`
  - `session:<id>:entries:<chunk>`
  - `trace:<id>:<chunk>`

## 3) 启动迁移序（不迁移旧数据）

1. 检测 `chatState.v2`
2. 命中后执行 `archiveLegacyState()`
3. 执行 `resetSessionStore()`
4. 执行 `initSessionIndex()`
5. 广播 `brain.bootstrap` 结果

对应实现：`extension/src/background/sw-main.ts` + `extension/src/sw/kernel/storage-reset.browser.ts`

## 4) 当前 BDD 对齐重点

- `BHV-CHAT-DONE-SEMANTICS-STRICT`
- `BHV-CHAT-HISTORY-INCLUDES-TOOL-RESULT`
- `BHV-SESSION-COMPACTION-STATE-MACHINE`
- `BHV-LLM-CAPABILITY-GATE`
