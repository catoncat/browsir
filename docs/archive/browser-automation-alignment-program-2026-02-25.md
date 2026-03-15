# 浏览器自动化能力对齐计划（AIPex 对照，2026-02-25）

## 1. 目的与范围

本文统一沉淀三类信息，作为后续实现与验收的单一跟踪入口：

1. 已完成调查的事实结论（AIPex 研究、当前代码现状、风险）。
2. 以系统设计改造点为中心的实施计划（不按文件集拆解）。
3. 可证明门禁口径（BDD + 真实页面证据）。

适用范围：`extension/src/sw/kernel/**` 浏览器自动化主链路，以及其与 LLM Provider/Subagent、VFS/Skills 的协同边界。

## 2. 现状结论（截至 2026-02-25）

### 2.1 已有能力（可复用）

1. 浏览器任务闭环已具备：Observe -> Act -> Verify -> Lease。
2. 多 LLM provider 框架已落地，subagent（single/parallel/chain）已落地。
3. capability/provider/policy/plugin runtime 解耦骨架已具备。

### 2.2 主要差距（稳定性核心瓶颈）

1. Snapshot 仍以 DOM evaluate/querySelector 为主，不是 AXTree 主路径。
2. `ref/backendNodeId` 仍有伪映射语义，缺少真实稳定节点句柄链路。
3. 跨 iframe 语义树与动作链路不完整。
4. action 与 verify 仍存在“动作成功但目标推进不确定”的灰区。
5. 当前 evidence 显示仍存在回归项，尚未达到稳定门禁口径。

### 2.3 影响判断

1. 多 Provider/Subagent：正向影响，不构成阻塞。
2. VFS/Skills：中长期正向，但当前未产品化闭环；短期不是 P0 稳定性主 blocker。
3. 必须优先补执行层语义稳定性，再扩展模式与 Skills。

## 3. 系统设计改造点（Trackable）

状态定义：`planned | in_progress | blocked | done`

| ID | 改造点 | 目标状态 | 当前状态 | 验收标准（可证明） | 状态 |
| --- | --- | --- | --- | --- | --- |
| BA-01 | CDP 会话控制层（Session Plane） | attach/detach、timeout、pending、disconnect 统一语义 | 已落第一版（attach 锁、command timeout/pending、detach/close 清理）；仍需补更多异常覆盖 | 并发同 tab 不互相踩踏；断链后无悬挂命令；错误码一致 | in_progress |
| BA-02 | 语义快照层（Observe Plane） | AXTree-first，DOM fallback；稳定 `uid <-> backendNodeId/frameId` | 已切 AXTree-first + DOM fallback，动作链已可优先 backendNodeId；仍需补 iframe 与稳定 UID 回注入 | 同页多轮快照节点可追踪；重渲染可恢复映射 | in_progress |
| BA-03 | 动作执行层（Act Plane） | 动作优先真实节点句柄；smart click/fill | 已落 backendNodeId 优先执行与 Monaco-like model.setValue 适配；仍需补更多复杂控件策略 | React/Vue/Monaco 输入成功率显著提升；失败可分型 | in_progress |
| BA-04 | 跨 Frame 统一模型 | 主文档 + iframe 快照/动作统一 | 已落 AXTree 跨 frame 采集与 frameId 标注；仍需补更完整跨 frame 动作/坐标恢复 | 含 iframe 场景可稳定点击/输入/验证 | in_progress |
| BA-05 | 验证与进展判定层 | 时间窗轮询验证 + 多证据；no_progress 与 failed_execute 分离 | 已落 verify 时间窗轮询（含 selector/text 跨同源 iframe 检查）；语义收口仍需与 loop 联动强化 | 不再出现“动作成功但目标未推进仍通过” | in_progress |
| BA-06 | 模式编排层（background/focus） | 失败后可提示并升级 focus，保留上下文续跑当前 step | 已落第一阶段：失败协议可输出 `modeEscalation(background->focus)` + `resume_current_step` | 升级后无需从头开始；可在会话中续跑 | in_progress |
| BA-07 | Planner/Tool 协议层 | tool I/O 增加稳定引用、失败分类、恢复建议 | 已落第一阶段：`failureClass/modeEscalation/resume/stepRef` 已贯通到 tool failure payload | 重试/修复路径可预测，tool_call 抖动下降 | in_progress |
| BA-08 | 可证明测试层（BDD + Real Browser） | 默认 mock 稳定 + live 真实能力门禁双层闭环 | 已有双层框架，但真实场景覆盖不足 | 真实场景通过率达标且证据可审计 | planned |
| BA-09 | Provider/Subagent 协同策略 | 失败升级可走路由/子代理策略，不破坏执行稳定性 | 架构已在，策略闭环不足 | 路由升级链路可观测、可回放 | planned |
| BA-10 | VFS/Skills 执行边界 | 通过 capability provider 正式接入，不走旁路 | 插件侧 VFS/Skills 控制面未闭环 | Skills 接入后不破坏自动化门禁与可观测性 | planned |

## 4. 分阶段里程碑

### P0：先解决“输入/点击不稳”的执行语义问题

覆盖：`BA-01 ~ BA-05`

阶段退出标准：

- `search -> 打开站点 -> 输入文本 -> 获取分享链接` 可在 live profile 稳定通过。
- React/Vue 受控输入框场景达到目标成功率（由 live evidence 统计）。
- no_progress、failed_execute、failed_verify 语义可区分且可审计。

### P1：扩展复杂页面能力与模式升级

覆盖：`BA-04 ~ BA-07`

阶段退出标准：

- iframe + 动态加载页面可稳定完成核心动作。
- background 失败可提示切 focus 并续跑当前 step，不需重开任务。
- tool 失败类型可被 planner 利用做确定性修复路径。

### P2：平台化协同（Provider/Subagent + Skills）

覆盖：`BA-08 ~ BA-10`

阶段退出标准：

- live 门禁下可观测多路由升级策略（provider/subagent）。
- VFS/Skills 以 provider 方式接入后，不破坏现有 BDD gate。
- 文档、诊断、证据链完整，支持持续回归治理。

## 5. 可证明门禁与场景矩阵

以下场景是本计划的强约束，不是可选项。

| 场景 ID | 场景描述 | 关键能力 | 证据要求 | 门禁 |
| --- | --- | --- | --- | --- |
| SCN-REAL-001 | 搜索在线 plain text 站点，输入文本并返回分享链接 | 搜索、导航、输入、链接提取、verify | trace + 事件 + e2e evidence（必要时视频） | live |
| SCN-REAL-002 | React 受控输入框（状态驱动）稳定输入 | smart fill、事件触发顺序、verify | 同上 | live |
| SCN-REAL-003 | Vue/动态加载输入框稳定输入 | 迟到元素等待、重试与恢复 | 同上 | live |
| SCN-REAL-004 | iframe 内输入/点击 | frame 语义合并、跨 frame 动作 | 同上 | live |
| SCN-REAL-005 | background 失败后切 focus 并续跑 | 模式升级编排、会话续跑 | 同上 | live |

默认 profile 继续保留 mock 编排门禁，保证回归定位速度；live profile 专门证明真实能力。

## 6. 与现有架构的兼容性说明

1. 多 Provider/Subagent 不需要回退，继续作为编排层能力演进。
2. 本轮改造不改变“Bridge 不做任务决策”的架构铁律。
3. VFS/Skills 必须通过 capability provider 接入，避免形成并行执行系统。

## 7. 跟踪节奏（执行看板）

- [ ] M0：冻结改造点与验收口径（本文 + BDD 映射）
- [ ] M1：完成 BA-01/BA-02（会话层 + AXTree 快照层）
- [ ] M2：完成 BA-03/BA-04（动作层 + iframe）
- [ ] M3：完成 BA-05（验证/进展收口）并通过 SCN-REAL-001~004
- [ ] M4：完成 BA-06/BA-07（模式升级 + 协议增强）并通过 SCN-REAL-005
- [ ] M5：完成 BA-08~BA-10（协同策略 + VFS/Skills 接入约束）

## 8. 关联文档

1. `docs/aipex-browser-automation-research-2026-02-25.md`
2. `docs/aipex-skills-filesystem-investigation-2026-02-25.md`
3. `docs/llm-provider-subagent-design.md`
4. `docs/pi-mono-runtime-comparison.md`
5. `docs/browser-agent-reliability-playbook.md`
6. `bdd/README.md`

## 9. 最新进展

- 2026-02-25：`runtime-infra` 完成 BA-01/BA-02 第一阶段实现：
  - CDP 命令控制层：attach 锁、命令超时、pending 中断、auto-detach 清理。
  - Snapshot：`AXTree` 主路径，失败自动降级到 DOM evaluate。
  - Action：`backendNodeId` 优先执行，失败再 selector fallback。
- 2026-02-25：继续推进 BA-04/BA-05 第一阶段实现：
  - AXTree 快照支持按 frame tree 聚合并输出 `frameId`。
  - `cdp.verify` 支持时间窗轮询（`waitForMs/pollIntervalMs`）并增强同源 iframe 下 `selectorExists/textIncludes` 检查。
- 2026-02-25：推进 BA-03 第一阶段实现：
  - `fill/type` 输入链路加入 Monaco-like `model.setValue` 优先策略，并保留 value/contenteditable fallback。
  - 输入事件序列增强（beforeinput/input/change/keyup），降低受控组件状态不同步概率。
- 证明测试：
  - `extension/src/sw/kernel/__tests__/runtime-infra.browser.test.ts`
  - 新增用例：
    - `uses AXTree as snapshot primary path when accessibility nodes are available`
    - `executes action via backendNodeId before selector fallback`
    - `includes frameId in AXTree snapshot nodes when frame trees are available`
    - `polls verify within time window until selector condition becomes true`
  - 端到端场景：
    - `tools/brain-e2e.ts` 新增 `fill 支持 monaco-like 受控输入（model.setValue）`，并在 `bun run brain:e2e` 中通过。
- 2026-02-25：推进 BA-06/BA-07 第一阶段实现（`runtime-loop`）：
  - 工具失败协议新增 `failureClass + modeEscalation + resume + stepRef`，并统一写入 `tool` 消息（LLM 可消费）。
  - browser 相关失败默认可给出 `background -> focus` 升级提示，附 `resume_current_step` 续跑语义。
  - `loop_no_progress` 事件新增 machine-readable repair 结构，重试与 stop 收口都保留同一失败分类语义。
- 2026-02-25：可证明测试更新：
  - 单测：`extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts`
    - 新增 `tool_call browser_action 失败时输出可恢复协议并给出 focus 升级提示`
    - 增强 `loop_no_progress` 用例，断言 `failureClass/resume` 字段
  - E2E：`tools/brain-e2e.ts`
    - 新增 `brain.reliability / background 失败提示切 focus 并续跑当前 step`
    - `bun run brain:e2e` 最新结果：`passed=37 failed=0`
