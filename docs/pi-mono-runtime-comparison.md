# Browser Brain Loop 与 pi-mono Runtime 深度对比（非 UI）

更新时间：2026-02-25  
对比输入：
- 架构蓝图：`docs/non-ui-architecture-blueprint.md:5`、`docs/non-ui-architecture-blueprint.md:16`、`docs/non-ui-architecture-blueprint.md:65`
- 本仓实现：`extension/src/sw/kernel/*` + `bridge/src/*`
- 外部参照：`/Users/envvar/work/repos/_research/pi-mono/packages/{agent,ai,coding-agent}`

## 1. 第一性原理结论（先看这个）

1. Browser Brain Loop（下文简称 BBL）是“浏览器内核 runtime”：决策在 SW，Bridge 只执行。证据：`docs/non-ui-architecture-blueprint.md:7`、`extension/src/sw/kernel/runtime-router.ts:486`、`extension/src/sw/kernel/runtime-loop.browser.ts:587`。  
2. pi-mono 是“可组合 agent 技术栈”：`agent` 负责循环与工具语义，`ai` 负责 provider 抽象，`coding-agent` 负责宿主化与会话产品层。证据：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:104`、`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/api-registry.ts:23`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/sdk.ts:165`。  
3. 两者不是同类替换关系，而是“内核型 runtime（BBL）” vs “通用 SDK + CLI runtime（pi-mono）”。  
4. BBL 的核心优势是浏览器写操作隔离（lease）与协议门禁；pi-mono 的核心优势是 provider 抽象深度与 runtime 可扩展性。  
5. 当前 BBL 的主要偏差已收敛到 `no_progress/auto-repair` 一组语义；Provider 路由与 strict done 语义（含 `progress_uncertain`）已落地（见第 6、9 节）。

## 2. 蓝图分层逐维对比

| 维度 | BBL（蓝图 + 实现） | pi-agent | pi-ai | pi-coding-agent | 结论 |
|---|---|---|---|---|---|
| 决策中枢 | `runtime-router` 统一入口，`runtime-loop` 驱动轮次，`orchestrator` 管运行态：`extension/src/sw/kernel/runtime-router.ts:486`、`extension/src/sw/kernel/runtime-loop.browser.ts:1172`、`extension/src/sw/kernel/orchestrator.browser.ts:334` | `runLoop` 双层循环（outer follow-up + inner tool loop）：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:104` | 不做任务决策，只做 model.api 路由：`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/stream.ts:31` | 会话层驱动 agent，含 retry/compaction/扩展绑定：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:383` | BBL 更“内核化单体决策”；pi 拆分更细、可替换性更高 |
| 执行边界 | `runtime-infra` 分发 `bridge/lease/cdp`，写动作强制 lease：`extension/src/sw/kernel/runtime-infra.browser.ts:932`、`extension/src/sw/kernel/runtime-infra.browser.ts:935`、`extension/src/sw/kernel/runtime-infra.browser.ts:970` | 工具在 loop 内串行执行：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:294` | 无工具执行，仅 provider stream | 本地工具直连宿主 shell/fs：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/tools/bash.ts:68`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/tools/path-utils.ts:54` | BBL 执行面隔离更强；pi 执行面自由度更高 |
| 状态与恢复 | `RunState={running,paused,stopped,retry}`：`extension/src/sw/kernel/types.ts:149`；主循环有 `MAX_LOOP_STEPS` 上限：`extension/src/sw/kernel/runtime-loop.browser.ts:1224`、`extension/src/sw/kernel/runtime-loop.browser.ts:1358` | `while (true)`，靠无待处理消息退出：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:117`、`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:193` | provider 内有各自 retry 能力（例如 Gemini）：`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/providers/google-gemini-cli.ts:376` | `agent_end` 后先 retry 再 compaction：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:388`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:391` | BBL 更强调“可收敛上限”；pi 更强调“持续对话恢复” |
| 安全边界 | Bridge token + origin + strict roots + cmd 白名单：`bridge/src/server.ts:95`、`bridge/src/server.ts:150`、`bridge/src/fs-guard.ts:41`、`bridge/src/cmd-registry.ts:57` | 依赖宿主工具实现 | provider/key 安全由调用侧管理 | README 明确 full system access + no permission popups：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/README.md:337`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/README.md:417` | BBL 默认边界更“平台化”；pi 默认边界更“宿主信任” |
| 可观测与门禁 | 事件落盘 trace chunk + `brain.debug.dump`：`extension/src/sw/kernel/orchestrator.browser.ts:100`、`extension/src/sw/kernel/orchestrator.browser.ts:120`、`extension/src/sw/kernel/runtime-router.ts:440`；BDD gate：`bdd/README.md:3`、`tools/bdd-gate.ts:99` | 事件流细粒度：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/types.ts:179` | provider 维度测试覆盖高 | 单测覆盖高，偏工程验证 | BBL 更强在“契约门禁”；pi 更强在“组件级测试深度” |

## 3. 关键时序对照（谁在主导循环）

### 3.1 BBL（浏览器内核主导）

1. `brain.run.start` 进入统一路由：`extension/src/sw/kernel/runtime-router.ts:141`。  
2. `startFromPrompt` 先落 user message，再 pre-send compaction：`extension/src/sw/kernel/runtime-loop.browser.ts:1488`、`extension/src/sw/kernel/runtime-loop.browser.ts:1489`。  
3. `runAgentLoop` 拉起主循环：`extension/src/sw/kernel/runtime-loop.browser.ts:1172`。  
4. LLM 请求内置 retry：`extension/src/sw/kernel/runtime-loop.browser.ts:1058`、`extension/src/sw/kernel/runtime-loop.browser.ts:1134`。  
5. 工具执行统一走 `executeStep(mode=bridge/cdp)`：`extension/src/sw/kernel/runtime-loop.browser.ts:610`、`extension/src/sw/kernel/runtime-loop.browser.ts:651`、`extension/src/sw/kernel/runtime-loop.browser.ts:722`。  
6. 错误收口为 `failed_verify/failed_execute/progress_uncertain/max_steps/stopped`：`extension/src/sw/kernel/runtime-loop.browser.ts`。  
7. `loop_done` 输出终态：`extension/src/sw/kernel/runtime-loop.browser.ts:1387`。

### 3.2 pi-mono（agent/host 双层主导）

1. `agentLoop.runLoop` 外层负责 follow-up，内层负责 assistant/tool：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:104`、`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:122`。  
2. 每个 tool call 串行执行并发出 start/update/end 事件：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:305`、`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:324`、`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:341`。  
3. Host 层（coding-agent）在 `agent_end` 回调里执行 retry/compaction 策略：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:383`。  
4. retry 最终通过 `agent.continue()` 再入循环：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:2164`。

## 4. 失败恢复状态机对比（核心差异）

| 场景 | BBL | pi-coding-agent | 影响 |
|---|---|---|---|
| 可重试错误 | `requestLlmWithRetry` 内部处理，按 HTTP/错误文本判定：`extension/src/sw/kernel/runtime-loop.browser.ts:1134` | `_isRetryableError` + `_handleRetryableError`，并可配置 maxRetries/baseDelay：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:2083`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/settings-manager.ts:621` | BBL 偏固定策略；pi 可调节策略面更大 |
| retry 与 compaction 顺序 | 本仓 orchestrator 明确“retry 优先于 compaction”：`extension/src/sw/kernel/orchestrator.browser.ts:333`、`extension/src/sw/kernel/orchestrator.browser.ts:342` | 同样 retry 优先：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:388` | 语义一致，便于互鉴 |
| overflow 恢复 | 有 `handleAgentEnd` overflow 分支：`extension/src/sw/kernel/orchestrator.browser.ts:383`；主循环里错误仍可能落 `failed_execute`：`extension/src/sw/kernel/runtime-loop.browser.ts:1373` | overflow 触发 auto-compaction 并 `continue()`：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:1591`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:1729` | pi 的 overflow 自愈链路更完整 |
| 继续执行语义 | `brain.run.regenerate` 依赖 assistant 源消息并回溯前序 user：`extension/src/sw/kernel/runtime-router.ts:167`、`extension/src/sw/kernel/runtime-router.ts:180` | 原生 `continue()`，可优先消费 steering/follow-up：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent.ts:372`、`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent.ts:382` | BBL 偏“重答上一轮”；pi 偏“从当前上下文续跑” |
| 并发输入 | 运行中追加输入会 `loop_enqueue_skipped`（消息已入库）：`extension/src/sw/kernel/runtime-loop.browser.ts:1453`、`extension/src/sw/kernel/runtime-loop.browser.ts:1488` | 通过队列模式 `steer/follow_up` 注入：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent.ts:252`、`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent.ts:260` | pi 的中途干预语义更显式 |

## 5. 安全边界对比（工程重点）

### 5.1 BBL 的默认边界

1. 入口鉴权：Bridge 要求 token，且校验 origin：`bridge/src/server.ts:95`、`bridge/src/server.ts:150`。  
2. 并发限制：超并发返回 `E_BUSY`：`bridge/src/server.ts:210`。  
3. 文件系统：strict 模式必须 `BRIDGE_ROOTS`：`bridge/src/fs-guard.ts:41`。  
4. 命令控制：`cmdId` 白名单，strict 可按 `allowInStrict` 过滤：`bridge/src/cmd-registry.ts:54`、`bridge/src/cmd-registry.ts:67`。  
5. 浏览器写隔离：写动作必须持有 lease：`extension/src/sw/kernel/runtime-infra.browser.ts:970`、`extension/src/sw/kernel/runtime-infra.browser.ts:444`。  
6. 协议约束：只接受 `invoke` 帧 + 四工具集：`bridge/src/protocol.ts:20`、`bridge/src/protocol.ts:4`。

### 5.2 pi-coding-agent 的默认边界

1. 文档明确 full system access：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/README.md:337`。  
2. 文档明确 no permission popups / no plan mode：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/README.md:417`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/README.md:419`。  
3. 工具默认含 `bash`：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:2020`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/cli/args.ts:206`。  
4. bash 为本地 shell 直执行：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/tools/bash.ts:68`。  
5. 路径解析允许绝对路径，不含 roots allowlist：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/tools/path-utils.ts:54`。

### 5.3 差异判断

- BBL 更像“受限执行面 + 明确信任边界”。  
- pi-coding-agent 更像“宿主全能力 + 以操作者隔离为主”。  
- 因此把 pi-coding-agent 权限模型直接迁到扩展侧不合适。

## 6. Provider 抽象能力对比（BBL 剩余差距）

### 6.1 pi-ai 的抽象深度

1. `ApiProvider` 注册中心：`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/api-registry.ts:23`、`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/api-registry.ts:66`。  
2. `stream()` 按 `model.api` 动态分发：`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/stream.ts:31`。  
3. 内建 provider 批量注册：`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/providers/register-builtins.ts:12`。  
4. 跨 provider 消息归一化：`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/providers/transform-messages.ts:8`。  
5. OpenAI-compatible 兼容探测：`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/providers/openai-completions.ts:762`。  
6. provider 内 retry（Gemini）：`/Users/envvar/work/repos/_research/pi-mono/packages/ai/src/providers/google-gemini-cli.ts:376`。

### 6.2 BBL 当前形态

1. 已完成 provider 化主链路：`runtime-loop` 先 `resolveLlmRoute(...)`，再通过 `LlmProviderRegistry` 查找 provider 并调用 adapter 发送请求：`extension/src/sw/kernel/runtime-loop.browser.ts`、`extension/src/sw/kernel/llm-provider.ts`、`extension/src/sw/kernel/llm-provider-registry.ts`。  
2. 已具备 profile 路由与升级事件：`llm.route.selected / llm.route.escalated / llm.route.blocked`：`extension/src/sw/kernel/runtime-loop.browser.ts`、`extension/src/sw/kernel/llm-profile-resolver.ts`、`extension/src/sw/kernel/llm-profile-policy.ts`。  
3. 剩余差距不在“有没有 provider”，而在“provider 抽象深度”：当前仅内置 `openai_compatible`；请求 payload 组装、tool 过滤、流解析与部分重试策略仍在 `runtime-loop`，尚未完全下沉到 provider 层：`extension/src/sw/kernel/llm-openai-compatible-provider.ts`、`extension/src/sw/kernel/runtime-loop.browser.ts`。

## 7. 持久化与上下文恢复对比

| 维度 | BBL | pi-coding-agent | 结论 |
|---|---|---|---|
| 介质 | `chrome.storage.local` 分块键：`extension/src/sw/kernel/session-store.browser.ts:3`、`extension/src/sw/kernel/session-store.browser.ts:142`、`extension/src/sw/kernel/session-store.browser.ts:146` | JSONL append-only tree：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/session-manager.ts:653` | 都支持分支与恢复，但介质不同 |
| 上下文重建 | `session-manager.buildSessionContext`：`extension/src/sw/kernel/session-manager.browser.ts:192` | `buildSessionContext(entries, leafId, byId)`：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/session-manager.ts:307`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/session-manager.ts:1036` | 语义相近，可做互操作映射 |
| 追踪 | 事件 trace chunk 化：`extension/src/sw/kernel/orchestrator.browser.ts:120` | 事件实时输出 + 会话落盘：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts:316`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/agent-session.ts:344` | BBL 更偏可追溯审计流 |

## 8. 测试与门禁强度对比

1. BBL 有契约门禁链：`contract -> feature -> mapping -> evidence -> gate`，并强制 `passed=true`：`bdd/README.md:3`、`bdd/README.md:24`、`tools/bdd-gate.ts:99`、`tools/bdd-gate.ts:180`。  
2. 测试文件数量快照（2026-02-24）：  
`extension/src/sw/kernel/*.test.ts` = 6，`pi-agent` = 4，`pi-ai` = 30，`pi-coding-agent` = 50。  
3. 代码规模快照（TypeScript，no tests）：  
BBL runtime(`extension/src/sw/kernel + bridge/src`)≈6288 行；pi-agent≈1518 行；pi-ai≈23024 行（去 `models.generated.ts` 后≈10236）；pi-coding-agent/src≈37706（其中 core≈19357）。

## 9. 规范-实现偏差（需要明确）

### 9.1 规范声明

1. README 声明存在 `no_progress` 与 auto-repair 触发条件：`README.md:253`、`README.md:254`、`README.md:276`。  
2. AGENTS 同样声明必须启用 `no_progress`：`AGENTS.md:122`、`AGENTS.md:123`。

### 9.2 当前实现

1. kernel 已落地 `loop_no_progress` 事件（重复签名 / ping-pong / 浏览器证据连续缺失），但尚未形成独立的 `no_progress` 终态枚举：`extension/src/sw/kernel/events.ts`、`extension/src/sw/kernel/runtime-loop.browser.ts`。  
2. strict done 语义已补齐 `progress_uncertain` 收口（验证不可判定或无进展时不会误报 done）：`extension/src/sw/kernel/runtime-loop.browser.ts`、`extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts`。  
3. 文档仍有差距点：README/AGENTS 里写的 `execute_error/no_progress` 触发条件，与当前内核终态枚举（`failed_execute/failed_verify/progress_uncertain/max_steps/stopped`）尚未完全同构。

### 9.3 结论

当前是“主链路已对齐，边缘语义待收口”：Provider/路由/strict done 与 `loop_no_progress` 已实现，但 auto-repair 触发口径和终态命名仍需统一。

## 10. 迁移建议（按收益/风险）

1. 高收益低风险：补齐 provider 深度，新增第二个 provider 适配器并下沉消息转换/流解析，继续保持 Bridge 非决策边界。  
2. 高收益中风险：在已落地 `loop_no_progress` 的基础上，继续把 auto-repair 触发条件与 README/AGENTS 对齐（并明确终态映射）。  
3. 中收益中风险：把 retry/compaction 参数化（保持保守默认值），并与 profile 升级策略协同。  
4. 低收益低风险：提供 JSONL 导出适配层，方便与 pi 生态工具互通，不替换 BBL 的分块存储。  
5. 明确不建议：直接迁移 pi-coding-agent 的“full system access + no permission popups”模型到扩展侧。

---

如需继续，我可以下一步直接补一版“可执行迁移 PR 拆分清单”（按文件和测试项列出）。
