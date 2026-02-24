# Browser Brain + Loop + CDP + Local WS

这是一个可运行的 MVP：

- 浏览器侧（MV3 Extension）做 Planner + Loop Engine
- Service Worker 做 CDP Gateway + WS Client
- 本地 Bridge（Bun）提供 `read/write/edit/bash`
- 支持 `sessionId / parentSessionId / agentId`，可并行子 agents

架构铁律：

- **大脑永远在浏览器侧**（SidePanel + ServiceWorker + 浏览器内记忆）
- **本地 WS 只做执行代理**（read/write/edit/bash），不做任务决策

文档入口：

- 总索引：`docs/README.md`
- 非 UI 架构蓝图：`docs/non-ui-architecture-blueprint.md`
- pi-mono runtime 对比：`docs/pi-mono-runtime-comparison.md`
- BDD 总览：`bdd/README.md`

## 目录

```text
browser-brain-loop/
├── bridge/      # Bun 本地服务（ws://127.0.0.1:8787）
├── extension/   # MV3 扩展（SidePanel + Service Worker）
├── bdd/         # BDD 契约/特性/映射/门禁配置
└── tools/       # bdd:validate / bdd:gate 等脚本
```

## 快速启动

0. 一条命令启动（推荐）

在仓库根目录执行：

```bash
BRIDGE_TOKEN="replace-me" bun run brain:dev
```

它会同时启动 bridge + extension watcher。  
若检测到已有 bridge，会自动复用并继续启动 watcher。

1. 启动 bridge（手动模式）

```bash
cd bridge
bun install
BRIDGE_TOKEN="replace-me" bun run start
```

2. 加载扩展

- 打开 `chrome://extensions`
- 开启开发者模式
- 选择“加载已解压的扩展程序”
- 目录选 `extension`

3. 在 SidePanel 填配置

- `Bridge URL`: `ws://127.0.0.1:8787/ws`
- `Bridge Token`: 与环境变量一致
- 可选填 LLM（不填则规则 planner）：
  - `LLM Base`: `https://ai.chen.rs/v1`
  - `Model`: `gpt-5.3-codex`

4. 启动扩展自动热重载（可选，开发推荐）

```bash
BRIDGE_TOKEN="replace-me" bun run brain:ext:watch
```

当 `extension/` 文件变化时，会自动 bump bridge 版本号，扩展检测到版本变化后自动 `chrome.runtime.reload()`。
当前 watcher 流程为：`检测变更 -> 自动执行 extension build -> bump version -> reload`。
为避免循环触发，watcher 默认忽略 `extension/dist/**` 与 `extension/node_modules/**`。

## BDD（Behavior Contract Engine）基础设施

当前仓库已启用 BDD 分层门禁：契约先行 + 证据校验（all/ux/protocol/storage）。

会话中断续跑说明见：`bdd/SESSION-HANDOFF.md`
BDD 索引说明见：`bdd/README.md`

目录约定：

```text
bdd/
├── schemas/behavior-contract.schema.json  # 契约 schema
├── contracts/                             # Canonical behavior contracts
├── mappings/contract-categories.json      # 契约分类（ux/protocol/storage）
├── features/                              # Gherkin 视图（@contract(...)）
└── mappings/contract-to-tests.json        # 契约到证明层映射
```

关键规则：

- 每个行为契约 ID 必须唯一，格式：`BHV-...`
- 每个契约必须至少被一个 `.feature` 的 `@contract(...)` 引用
- 每个契约必须在 `contract-categories.json` 有且仅有一个分类（`ux|protocol|storage`）
- 每个契约必须在 `contract-to-tests.json` 有映射，且满足 `proof_requirements.required_layers/min_layers`
- gate 采用严格失败策略：任何契约缺失/映射不完整/目标路径不存在都会失败
- 对 `bdd/evidence/*.json` 的 `e2e` 证明层，gate 会检查 `passed=true`，并支持 `path::selector` 命中校验

命令：

```bash
bun run brain:e2e
bun run brain:e2e:live   # 真实 LLM 冒烟（需配置环境变量）
bun run bdd:validate
bun run bdd:gate
bun run bdd:gate:ux
bun run bdd:gate:protocol
bun run bdd:gate:storage
bun run bdd:gate:live    # 检查 live profile 契约
```

### `brain:e2e`（纯 CDP，无 Playwright）

`brain:e2e` 会启动临时 bridge + 临时 Chrome（加载当前 extension），并分两组执行：

1. Service-worker API 组：`cdp.snapshot` / `cdp.action` / `lease.*` / `cdp.verify`
2. Sidepanel loop 组：`MAX_STEPS` / `MAX_WALL_MS` 护栏
3. Live LLM 组（开启 `BRAIN_E2E_ENABLE_LIVE_LLM=true` 时）：真实模型能力冒烟（按成功率阈值判定）

关键断言：

- `snapshot(mode=interactive|full)` 必须返回可引用 A11y 节点：`nodes[*].ref/role/name/depth`（可兼容 `nodeId/backendNodeId` 句柄）
- `snapshot(format=compact, maxTokens=...)` 必须返回低噪紧凑文本，并提供 `truncated` 状态
- `cdp.action` 所有写动作都走 `lease.acquire(owner) -> cdp.action(owner) -> lease.release(owner)`
- `cdp.verify` 支持 `urlChanged` / `urlContains` / `titleContains` / `textIncludes` / `selectorExists`
- `ref` 行为分两类验证：
  - ref 存在但句柄过期：应可 fallback
  - ref 不存在：按现状返回 `ref ... not found`
- sidepanel 在 `stopped` 状态下优先返回状态文案，不应回显大段 snapshot JSON
- sidepanel 的 LLM 能力门禁：
  - LLM 可用时可完成 `tool_call -> tool_result -> done` 闭环
  - LLM 不可用且规则可解析时应降级成功
  - LLM 不可用且规则不可解析时应返回 `failed_execute`
  - LLM HTTP 失败时可回退到规则 planner
- sidepanel 的真实 LLM 能力冒烟（live suite）：
  - 在浏览器任务上进行多次尝试并用 `cdp.verify` 断言结果
  - 通过阈值：`passedAttempts >= minPass`（默认 `ceil(attempts*0.67)`）

运行后会产出证据文件：

```text
bdd/evidence/brain-e2e.latest.json
```

`bdd:gate` 会根据 `bdd/mappings/contract-to-tests.json` 对所有声明了 `e2e` 证明层的契约校验 `passed=true`（以及可选 selector 命中）。
`bdd:gate:live` 还会额外检查 `BHV-LLM-LIVE-CAPABILITY`，读取 `bdd/evidence/brain-e2e-live.latest.json`。

运行 live 套件示例：

```bash
BRAIN_E2E_LIVE_LLM_BASE="https://ai.chen.rs/v1" \
BRAIN_E2E_LIVE_LLM_KEY="<key>" \
BRAIN_E2E_LIVE_LLM_MODEL="gpt-5.3-codex" \
bun run brain:e2e:live

bun run bdd:gate:live
```

> 注意：品牌版 Google Chrome 会忽略 `--load-extension` / `--disable-extensions-except`。  
> 默认建议使用 `Chrome for Testing` 或 `Chromium`。必要时可手动指定：
>
> ```bash
> CHROME_BIN="/path/to/chrome-for-testing" bun run brain:e2e
> ```

### 最近进展（2026-02-24）

vNext 已切到 `sidepanel.html + service-worker.js` 主路径：

- 旧入口已移除：`extension/harness.html`、`extension/sidepanel.js`
- `extension/service-worker.js` 已收口为 shim，运行逻辑在 `extension/src/sw/kernel/*`（构建到 `extension/dist/service-worker.js`）
- 运行链路已支持：`brain.run.start -> LLM(tool_calls) -> executeBrainToolCall -> tool result 回灌 -> 下一轮`
- `brain.step.execute` 已从占位实现改为真实执行（`script/cdp/bridge` + verify）
- 主 sidepanel 已重构为聊天产品界面（多会话、会话内连续发送、设置抽屉）
- 调试能力迁移到独立页面：`extension/debug.html`（`Live Events / Step Stream / Debug Dump`）
- e2e 已覆盖 sidepanel + debug 工作台，并断言 `brain.runtime` 可观测性（`llm.request/llm.response.raw/auto_retry_*`）

当前校验方式：

- `bun run brain:ext:build`
- `bun run brain:ext:test`
- `bun run brain:e2e`
- `bun run bdd:validate && bun run bdd:gate`
- `bun run bdd:gate:ux|protocol|storage`（按职责分层校验）

## 协议

统一 `invoke`：

```json
{
  "id": "u1",
  "type": "invoke",
  "tool": "read",
  "args": { "path": "src/a.ts" },
  "sessionId": "s-main",
  "parentSessionId": "s-root",
  "agentId": "child-1"
}
```

成功：

```json
{ "id": "u1", "ok": true, "data": { "content": "..." }, "sessionId": "s-main" }
```

失败：

```json
{ "id": "u1", "ok": false, "error": { "code": "E_PATH", "message": "denied" } }
```

事件帧：

```json
{ "type": "event", "event": "invoke.started", "id": "u1", "sessionId": "s-main", "ts": "..." }
```

## 工具定义

1. `read(path, offset?, limit?, cwd?)`
2. `write(path, content, mode=overwrite|append|create, cwd?)`
3. `edit(path, edits, cwd?)`
4. `bash(cmdId, args, cwd?, timeoutMs?)`

`bash` 仅允许白名单 `cmdId`，映射见 `bridge/src/cmd-registry.ts`。
`cmdId=bash.exec` 默认开启（无限能力）；如需临时收紧，可设置 `BRIDGE_ENABLE_BASH_EXEC=false`。

## 扩展侧 CDP API（通过 `chrome.runtime.sendMessage`）

1. `cdp.snapshot`：A11y-first 分级观测，支持参数：
   - `mode`: `text|interactive|full`
   - `filter`: `interactive|all`
   - `format`: `compact|json`
   - `diff`: 是否返回快照差异
   - `maxTokens` / `depth` / `selector` / `noAnimations`
   - 返回：`snapshotId/ts/url/title/count/truncated/hash/diff/compact + nodes[*].ref/role/name/depth`（兼容 `nodeId/backendNodeId`）
2. `cdp.action`：支持 `ref` 或 `selector` 的页面动作（click/type/fill/press/scroll/select/navigate），`ref` 优先，`selector` 回退
3. `cdp.verify`：对 URL/title/text/selector 断言，支持 `urlChanged`（可传 `previousUrl`）
4. `lease.acquire|heartbeat|release|status`：tab 写操作租约（owner + ttl）

## Loop 编排与收敛策略

- LLM 工具入参不再直接喂原始大 snapshot JSON；优先使用 `snapshot.compact + 关键元信息`，避免二次硬截断导致关键信息丢失。
- 在 strict 策略下，`browser_action` 执行后默认必须通过验证（显式 `expect` 走 `cdp.verify`，否则走前后观测推进校验）。
- 新增 `no_progress` 检测：当 action 签名连续重复或 ABAB 往返（ping-pong）时提前终止本轮。
- auto-repair 仅在 `execute_error | failed_verify | no_progress` 时触发；`max_steps | stopped | timeout` 不自动开启下一轮。
- 回复策略中，`stopped/timeout/max_steps/failed_*` 状态文案优先于 memory 回填。

## 多 Session 与并行子 agents

- 每个 loop 有独立 `sessionId`
- 子 agent 运行时设置 `parentSessionId=<父会话>` + 独立 `agentId`
- SidePanel 支持 JSON 数组批量派生子 agents，并可设置并发上限

## 护栏

即使是 `god mode`（无限能力）也保留：

- `MAX_STEPS` / `MAX_WALL_MS`
- `bash timeout`
- `maxConcurrency`
- 输出截断
- 全量审计（JSONL）

## 自治修复

- SidePanel 支持 `AUTO_REPAIR_ROUNDS` + `自动修复(on/off)`
- 仅在 `execute_error/failed_verify/no_progress` 时会把失败摘要写入下一轮 goal 并尝试修复
- `max_steps/stopped/timeout` 默认不进入下一轮 repair
- 对“提前 done”有拦截（无成功动作时不允许 done）

## 远程隧道（SSH）

```bash
ssh -N -L 8787:127.0.0.1:8787 <host>
```

然后扩展仍连接 `ws://127.0.0.1:8787/ws`。
