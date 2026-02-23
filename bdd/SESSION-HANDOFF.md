# BDD 交接文档（可中断续跑）

更新时间：2026-02-21
仓库路径：`/Users/envvar/work/repos/browser-brain-loop`

## 1. 当前目标

- 总目标：后续开发全面基于 BDD（Behavior Contract Engine）
- 分期策略：
  1. 第 1 阶段：契约/门禁基础设施
  2. 第 2 阶段：纯 CDP e2e 与证据门禁
  3. 第 3 阶段：agent 自增强闭环（浏览器内可自建工具与插件能力）

## 2. 当前阶段状态

- 第 1 阶段：已完成
- 第 2 阶段：已完成首版落地并实跑通过（8/8），并新增 Chat/Storage 契约扩展
- 第 3 阶段：未开始

说明：本次已完成仓库迁移，后续所有命令都在新路径执行，不再依赖 `mom` 根脚本。

## 3. 已完成清单

### 3.1 BDD 基础设施（Phase 1）

- 契约 schema：`bdd/schemas/behavior-contract.schema.json`
- 基线契约：
  - `bdd/contracts/chat/BHV-CHAT-NO-TAB-START.v1.json`
  - `bdd/contracts/cdp/BHV-CDP-ON-DEMAND.v1.json`
  - `bdd/contracts/panel/BHV-PANEL-ACTION-OPEN.v1.json`
- Gherkin 视图：
  - `bdd/features/chat/no-tab-start.feature`
  - `bdd/features/cdp/on-demand.feature`
  - `bdd/features/panel/action-open.feature`
- 契约映射：`bdd/mappings/contract-to-tests.json`
- 校验与门禁：
  - `tools/bdd-validate.ts`
  - `tools/bdd-gate.ts`
  - `tools/bdd-lib.ts`

### 3.1.1 本轮新增契约（2026-02-21）

- 新增契约：
  - `bdd/contracts/chat/BHV-CHAT-TOOL-RENDERER-REGISTRY.v1.json`
  - `bdd/contracts/chat/BHV-CHAT-STREAMING-MESSAGE-CONTAINER.v1.json`
  - `bdd/contracts/storage/BHV-SESSION-METADATA-SPLIT-STORAGE.v1.json`
- 新增 feature：
  - `bdd/features/chat/tool-renderer-registry.feature`
  - `bdd/features/chat/streaming-message-container.feature`
  - `bdd/features/storage/session-metadata-split-storage.feature`
- 映射已接入：
  - `bdd/mappings/contract-to-tests.json`
- 修复了既有契约映射缺口：
  - `BHV-TAB-REF-DEFAULT` 已补 mapping，gate 不再因缺失失败

### 3.2 纯 CDP e2e（Phase 2 首版）

- e2e 脚本：`tools/brain-e2e.ts`
- 扩展测试入口：`extension/sidepanel.html`（vNext）
- e2e 证据文件：`bdd/evidence/brain-e2e.latest.json`
- 门禁要求：`BHV-CDP-ON-DEMAND` 必须包含 `e2e` 证明层，并由 gate 校验 `passed=true`
- 本仓脚本入口：
  - `brain:bridge`
  - `check:brain-bridge`
  - `brain:ext:watch`
  - `brain:dev`
  - `brain:e2e`
  - `bdd:validate`
  - `bdd:gate`

### 3.3 已落地实现（对应新增契约）

- 已切换到 vNext 主路径：
  - `extension/sidepanel.html` + `extension/sidepanel-loader.js` + `extension/dist/assets/sidepanel.js`（UI）
  - `extension/service-worker.js`（Brain runtime 与 tool_calls 执行链）
- 旧入口已移除：
  - `extension/harness.html`
  - `extension/sidepanel.js`

## 4. 最近一次可复现验证（新路径实跑）

在 `/Users/envvar/work/repos/browser-brain-loop` 下执行：

1. `bun run check:brain-bridge`
- 结果：`typecheck + test` 通过（9 pass / 0 fail）

2. `bun run brain:e2e`
- 结果：8 passed / 0 failed

3. `bun run bdd:validate && bun run bdd:gate`
- 结果：通过

4. `bash -n tools/brain-dev.sh`
- 结果：语法通过

5. `bun run brain:ext:build && bun run brain:ext:test`
- 结果：通过

6. 本轮最新门禁快照
- `bdd:validate`：通过（当前仓库 contracts/features/mappings 以命令输出为准）
- `bdd:gate`：通过（当前输出：`profile=default`, `contracts=10/11`, `mappings=11`）

## 5. 待办（下一次会话优先做）

1. 把新增 3 条 feature 接成可执行测试
- 目标：在 `tools/brain-e2e.ts` 增加对应断言，而不是只停留在结构门禁

2. 实现 `BHV-CHAT-STREAMING-MESSAGE-CONTAINER`
- 目标：稳定消息区与流式容器分离，避免全量重绘

3. 实现 `BHV-SESSION-METADATA-SPLIT-STORAGE`
- 目标：会话正文与 metadata 分离写入，并支持 metadata 缺失恢复

4. 证据新鲜度门禁
- 现状：`bdd:gate` 仅检查 `passed=true`
- 目标：增加 `ts` 新鲜度窗口（建议 24h）

5. CI 接入
- 目标：把 `check:brain-bridge + brain:e2e + bdd:validate + bdd:gate` 接入 CI

## 6. 执行顺序（下次直接照做）

1. 改 `tools/brain-e2e.ts`
- 为 3 条新增 feature 增加可执行断言（至少先补 renderer registry）

2. 持续收敛 vNext UI/SW
- 继续把历史测试与文档口径统一到 `brain.*` 协议，避免回流旧路径

3. 实现 `BHV-SESSION-METADATA-SPLIT-STORAGE`
- 引入 data/meta 分离持久化结构与恢复逻辑

4. 改 `tools/bdd-gate.ts`
- 增加 evidence `ts` 新鲜度校验

5. 回归验证
- `bun run check:brain-bridge`
- `bun run brain:e2e`
- `bun run bdd:validate && bun run bdd:gate`

## 7. 下次开聊可直接贴的启动词

```text
继续 browser-brain-loop 的 BDD 第 2 阶段补强。
先读取 bdd/SESSION-HANDOFF.md，然后按“第5节待办 + 第6节执行顺序”继续。
完成后给我：
1) 改动文件清单
2) 命令实跑结果
3) 是否满足严格门禁
```

## 8. 约束提醒

- BDD 语义：行为契约优先，测试是行为证明，不是实现证明
- 第 2 阶段当前已可用，但还需“证据新鲜度 + CI”补强
- 第 3 阶段（agent 自增强）请单独推进，避免和门禁补强混在一次提交
