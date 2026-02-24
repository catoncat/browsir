# Kernel Runtime Migration Plan

## Background

当前仓库已收口为单套 Service Worker 实现：

- 当前生效：`extension/src/sw/kernel/*` + `extension/src/background/sw-main.ts`
- 构建产物：`extension/dist/service-worker.js`（由 `sw-main.ts` 打包生成）

## 为什么会出现“新旧两套”

根因不是业务逻辑要并存两份，而是**入口形态迁移**带来的过渡层：

1. 旧时代（monolith）：`extension/service-worker.js` 里包含所有 runtime 逻辑。
2. 新时代（kernel）：逻辑拆到 `extension/src/sw/kernel/*`，由 `extension/src/background/sw-main.ts` 组装，再构建到 `extension/dist/service-worker.js`。
3. 过渡期兼容：`manifest.json` 仍指向 `service-worker.js`，所以根目录 `extension/service-worker.js` 变成一行 shim：`import "./dist/service-worker.js"`。

结论：当前“看起来两套”，本质是**一套逻辑 + 一层兼容入口**，不是两份 runtime 逻辑漂移。

## 新实现是否完整

按协议面看，新实现已覆盖旧实现能力（见下表）。当前未完成项不在“能力”，而在“入口是否去 shim”这个发布决策。

## Compatibility Matrix

| 协议面 | 旧实现 | 新实现（迁移前） | 新实现（当前进度） |
|---|---|---|---|
| `config.get/save` | ✅ | ❌ | ✅ (`runtime-infra.browser.ts`) |
| `bridge.connect/invoke` | ✅ | ❌ | ✅ (`runtime-infra.browser.ts`) |
| `lease.acquire/heartbeat/release/status` | ✅ | ❌ | ✅ (`runtime-infra.browser.ts`) |
| `cdp.observe/snapshot/action/execute/verify/detach` | ✅ | ❌ | ✅ (`runtime-infra.browser.ts`) |
| `brain.run.regenerate` | ✅ | ❌ | ✅ (`runtime-router.ts`) |
| `brain.session.fork` | ✅ | ❌ | ✅ (`runtime-router.ts`) |
| `brain.session.list/view` `forkedFrom/parentSessionId` | ✅ | ❌ | ✅ (`runtime-router.ts`) |
| `brain.session.title.refresh` | ✅ | ❌ | ✅ (`runtime-router.ts`) |
| `brain.session.delete` | ✅ | ❌ | ✅ (`runtime-router.ts`) |
| `brain.debug.*` | ✅ | ❌ | ✅ (`runtime-router.ts`) |
| `brain.run.start` 完整 loop/tool_call 运行面 | ✅ | ❌ | ✅ (`runtime-loop.browser.ts`) |
| `brain.step.execute` 真实执行链（cdp/bridge + verify） | ✅ | ❌ | ✅ (`runtime-loop.browser.ts`) |

## 第一性对比（旧 monolith vs 新 kernel）

| 维度 | 旧 monolith | 新 kernel |
|---|---|---|
| 变更粒度 | 单文件大改，耦合高 | 按 infra/router/loop 分层，改动面可控 |
| 可测试性 | 端到端为主，单测困难 | `runtime-infra/router/loop` 可分层单测 |
| 协议演进 | 容易“改一处炸多处” | 协议入口集中，便于加 action 与契约映射 |
| BDD 映射稳定性 | 目标路径易失真 | 已迁移到 kernel 路径，gate 可直接约束 |
| 运维风险 | 排障靠全文检索 | 事件流与状态机可观测性更强 |

## Migration Phases

### Phase 0: 协议基线锁定

- 建立旧/新协议矩阵（本文件）
- 为新内核补基础单测（config/bridge/lease）
- 目标：迁移过程中可持续验证，不靠人工记忆

### Phase 1: Infra 协议迁移

- 已完成：
  - `config.*`
  - `bridge.*`
  - `lease.*`
  - `cdp.*`

### Phase 2: Brain 语义对齐

- 已完成：
  - `brain.run.regenerate`
  - `brain.session.fork`
  - `session.list/view` 返回 `forkedFrom/parentSessionId`
  - `brain.session.title.refresh`
  - `brain.session.delete`
  - `brain.debug.*`
  - `brain.run.start` loop/tool_call（含 retry/trace/sharedTabs）
  - `brain.step.execute` 真实执行链
- 剩余关键缺口：
  - 无协议级缺口；剩余为入口切换与旧 SW 收口

### Phase 3: 入口切换与收口

1. ✅ 已完成：SW 构建入口切到 `sw-main.ts`
2. ✅ 已完成：旧 `extension/service-worker.js` 收口为 shim（仅 `import "./dist/service-worker.js"`）
3. ✅ 已完成：e2e + BDD gate 全绿

## 最终收口选项（给产品/工程共同决策）

### 选项 A：保留 shim（当前）

- 形态：`manifest -> service-worker.js(shim) -> extension/dist/service-worker.js`
- 优点：对现有 e2e、开发加载方式零扰动。
- 成本：多一层入口文件，但无业务逻辑重复。
- 适用：当前节奏优先稳定上线。

### 选项 B：彻底去 shim

- 形态：`manifest` 直接指向 `extension/dist/service-worker.js`（并同步 sidepanel/debug 资源路径策略）
- 需要同时改：
  - 扩展加载与构建流程（保证 `dist` 始终存在且版本一致）
  - e2e 装载入口（避免依赖根目录 loader）
  - 文档与脚本（brain:dev / brain:e2e 的前置检查）
- 风险：构建产物缺失时扩展不可启动。
- 回滚：恢复 `manifest -> service-worker.js(shim)`，保留现有 kernel 逻辑不动。

推荐：短期走 A（功能已完整且稳定），中期用一次独立 MR 落地 B（只改入口，不再碰协议逻辑）。

## Acceptance Gates

- `cd extension && bunx tsc --noEmit`
- `cd extension && bun run test`
- `bun run brain:e2e`
- `bun run bdd:validate && bun run bdd:gate`

任一失败不切入口，不删除旧实现。
