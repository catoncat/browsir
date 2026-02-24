# Browser Brain vNext 对齐 Pi 的实现映射

> 基线：以 `pi-mono` 的 session/compaction/state-machine 语义为准，浏览器侧替换存储介质（`chrome.storage.local` 分片），保持事件名与判定顺序一致。

## 1) 源实现 -> 目标文件 -> 验收用例

| Pi 对照点 | 目标实现 | 当前用例 |
| --- | --- | --- |
| `session-manager.ts` `buildSessionContext` | `extension/src/sw/kernel/session-manager.browser.ts` `buildSessionContext()` | `extension/src/sw/kernel/__tests__/session-manager.browser.test.ts` |
| `session-manager.ts` `append* / getBranch / getLeaf / setLeaf` | `extension/src/sw/kernel/session-manager.browser.ts` 对应方法 | `extension/src/sw/kernel/__tests__/session-manager.browser.test.ts` |
| `compaction/compaction.ts` `findCutPoint` | `extension/src/sw/kernel/compaction.browser.ts` `findCutPoint()` | `extension/src/sw/kernel/__tests__/compaction.browser.test.ts` |
| `compaction/compaction.ts` `prepareCompaction/compact` | `extension/src/sw/kernel/compaction.browser.ts` `prepareCompaction()/compact()` | `extension/src/sw/kernel/__tests__/compaction.browser.test.ts` |
| `agent-session.ts` `_checkCompaction` | `extension/src/sw/kernel/orchestrator.browser.ts` `preSendCompactionCheck()/handleAgentEnd()` | `extension/src/sw/kernel/__tests__/orchestrator.browser.test.ts` |
| `agent-session.ts` retry 判定优先 | `extension/src/sw/kernel/orchestrator.browser.ts` `handleAgentEnd()` | `extension/src/sw/kernel/__tests__/orchestrator.browser.test.ts` |
| `agent-session.ts` 事件集合 | `extension/src/sw/kernel/events.ts` + `orchestrator.browser.ts` emit | `extension/src/sw/kernel/__tests__/orchestrator.browser.test.ts` |

## 2) 接口冻结（1:1）

- 事件名只保留：`auto_retry_start`、`auto_retry_end`、`auto_compaction_start`、`auto_compaction_end`、`session_compact`
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

## 4) BDD 对齐状态（已完成）

- 已完成契约与 feature 绑定：
  - `BHV-SESSION-COMPACTION-STATE-MACHINE`
  - `BHV-SESSION-STORAGE-RESET-BOOTSTRAP`
  - `bdd/features/technical/session/compaction-state-machine.feature`
  - `bdd/features/technical/storage/session-reset-bootstrap.feature`
- 已完成映射：
  - `bdd/mappings/contract-to-tests.json`
- 已完成门禁分层：
  - `bdd/mappings/contract-categories.json`（`ux|protocol|storage`）
  - `bun run bdd:gate:storage` 可独立校验存储类契约
