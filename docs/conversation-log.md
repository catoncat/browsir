# 对话记录（持续追加）

> 创建时间：2026-02-24 10:43:42 CST
> 记录范围：用户与助手在本仓内的工作对话（按顺序追加）

## Session 2026-02-24

### Step 1
- 用户：
  一起 详细过一遍 docs/non-ui-architecture-blueprint.md
  把我当成第一次接触这个项目的程序员 向我耐心详细的解释

- 助手：
  我先把 `docs/non-ui-architecture-blueprint.md` 全文读一遍，并行提取「整体架构」「关键数据流」「新手最容易卡住的点」三块信息。接下来我会按“先全局再细节”的顺序带你过一遍。

### Step 2
- 助手：
  我已经拿到文档全文（307 行），它结构很完整：先讲铁律、再讲分层/时序/协议/存储/状态机，最后给复刻清单和与 `pi-mono` 的对比。下一步我会并行做两件事：一条线做“逐节讲解”，另一条线做“新手学习路径和易错点”，然后合并成一份你能直接上手的讲解。

### Step 3
- 助手：
  两个并行阅读子任务已经启动，我在等它们回传结果；拿到后我会把它们合并成一套“先理解系统，再落到代码锚点”的教学版讲解。

### Step 4
- 助手：
  第一路并行结果已回来，结构化得很好。现在我继续等第二路“新手易错点 + 验证锚点”，拿到后我会把两路合并成完整讲解。

### Step 5
- 助手：
  第二个子任务还在运行，我先不空等：我会并行自己抽取关键锚点，确保讲解可直接对照代码定位。稍后如果子任务返回，我再补充进去。

### Step 6
- 助手：
  我重启了第二路分析任务（刚才那个子任务被中断了），它会只做一件事：给你“10 个最容易误解点 + 对应代码验证锚点”。

### Step 7
- 助手：
  我已经把并行结果汇总好了。最后我会按“第一性原理 → 架构分层 → 一次完整运行 → 容错恢复 → 对比定位”的顺序讲，确保你作为新同学能把这套系统直接装进脑子里。先补一份带行号索引，便于你边看边对照。

### Step 8
- 助手：
  我发现一个小异常：同一个文档第一次读取时是 307 行、现在带行号读取只到 211 行。我先快速核对下文件当前版本，避免给你讲错内容。

### Step 9
- 助手：
  我需要先和你对齐一个风险点：`docs/non-ui-architecture-blueprint.md` 在我读取过程中发生了变化（最初看到是 307 行且含 pi-mono 详细对比，现在当前文件是 211 行，`git status` 显示未跟踪 `??`）。
  你希望我按哪个版本讲解：
  1. 按当前 211 行版本（第 9 节是“延伸阅读”）。
  2. 也把你刚才那版 307 行里出现过的 pi-mono 详细对比一起讲。

### Step 10
- 用户：
  docs/non-ui-architecture-blueprint.md:208
       docs/pi-mono-runtime-comparison.md:1

  按这个

### Step 11
- 助手：
  收到，我们就按 `docs/non-ui-architecture-blueprint.md:208` 的“延伸阅读入口”继续，把 `docs/pi-mono-runtime-comparison.md:1` 一并讲透。
  我先并行读这两个文档并抽取同一套主线：第一性原理、运行闭环、恢复与安全、和 pi-mono 的关系定位。

### Step 12
- 助手：
  我已经拿到两份文档全文。为便于你边读边定位，我再补一版带行号索引，然后直接进入“从零上手”的讲解主线。

### Step 13
- 助手（详细讲解）：
  按你指定入口，我们把这两份文档当成一套完整设计来讲：`docs/non-ui-architecture-blueprint.md:208` 指向 `docs/pi-mono-runtime-comparison.md:1`，前者是“本项目怎么做”，后者是“它和别家方案怎么对位”。

  先抓第一性原理
  1. 谁负责决策：浏览器扩展内核负责，不在本地进程。见 `docs/non-ui-architecture-blueprint.md:5`。
  2. 谁负责执行：本地 Bridge 只做代理执行，不做任务判断。见 `docs/non-ui-architecture-blueprint.md:5`。
  3. 系统如何解耦：所有跨层都走协议，不走跨层函数调用。见 `docs/non-ui-architecture-blueprint.md:6`。
  4. 失败后如何活下来：会话与 trace 分块持久化，可恢复。见 `docs/non-ui-architecture-blueprint.md:7`、`docs/non-ui-architecture-blueprint.md:128`。

  文档一逐节讲解（非 UI 架构蓝图）
  1. 设计铁律（第1节）
  这节在“立宪法”。核心目的是防止系统慢慢演变成“哪里都能调、哪里都能改”的失控形态。锚点在 `extension/src/background/sw-main.ts:5`、`extension/src/sw/kernel/runtime-router.ts:486`、`bridge/src/server.ts:81`。

  2. 组件分层（第2节）
  你可以把它看成五个角色：
  - `runtime-router`：收消息、分发。
  - `runtime-loop`：做 LLM 轮次决策。
  - `runtime-infra`：执行器，统一接 CDP/Bridge。
  - `orchestrator`：运行控制器（暂停/恢复/重试/压缩）。
  - Bridge：四工具执行代理（`read/write/edit/bash`）。
  关键是边界：Loop 不直接碰 CDP，Infra 不直接做“思考”。见 `docs/non-ui-architecture-blueprint.md:20` 到 `docs/non-ui-architecture-blueprint.md:54`。

  3. 关键时序（第3节）
  闭环是：`brain.run.start` -> 进 loop -> 调 LLM -> 有 tool_call 就交给 infra -> 写回 store -> 下一轮 -> `loop_done`。
  这节回答“请求如何从一句 prompt 变成可追踪执行流水”。见 `docs/non-ui-architecture-blueprint.md:77` 到 `docs/non-ui-architecture-blueprint.md:100`。

  4. 协议蓝图（第4节）
  有两层协议，不是一层：
  - 扩展内部 runtime message（`brain.run.* / brain.session.* / brain.step.*`）。
  - Browser↔Bridge 的 WS `invoke` 帧。
  这就是“内部控制面 + 外部执行面”。见 `docs/non-ui-architecture-blueprint.md:111`、`docs/non-ui-architecture-blueprint.md:120`。

  5. 存储模型（第5节）
  不是一个大 JSON，而是键空间分层：index/meta/entries/trace。
  价值：大会话可切块，恢复时可按 branch 回溯并注入压缩摘要，避免每次都喂全量历史。见 `docs/non-ui-architecture-blueprint.md:132` 到 `docs/non-ui-architecture-blueprint.md:145`。

  6. 状态机（第6节）
  状态不是“跑/不跑”二元，而是 Idle/Running/Paused/Stopped + retry + compaction。
  这让“暂停继续、失败重试、长会话压缩”都可控。见 `docs/non-ui-architecture-blueprint.md:151` 到 `docs/non-ui-architecture-blueprint.md:167`。

  7. 错误与降级（第7节）
  Bridge 错误码把失败类型明确化（参数错、工具错、路径拒绝、命令拒绝、并发满、超时）。
  Kernel 再做策略降级（无 LLM 跳过、可重试退避、`script -> cdp` fallback）。见 `docs/non-ui-architecture-blueprint.md:173` 到 `docs/non-ui-architecture-blueprint.md:187`。

  8. 复刻清单（第8节）
  这是“最小可实现路径”：先 Bridge，再 SW 三层 kernel，再 orchestrator + store，再加 BDD 门禁。
  顺序背后是依赖关系，不是随意排的。见 `docs/non-ui-architecture-blueprint.md:191` 到 `docs/non-ui-architecture-blueprint.md:206`。

  文档二逐节讲解（与 pi-mono 对比）
  1. 对比口径
  只比 runtime，不比 UI。比较维度是决策、执行、恢复、安全、门禁。见 `docs/pi-mono-runtime-comparison.md:3`。

  2. 一句话结论
  本项目是“运行时内核”；pi-mono 三包是“通用 Agent 技术栈分层”。不是直接替代关系。见 `docs/pi-mono-runtime-comparison.md:9`。

  3. 维度矩阵怎么读
  最关键三行是：
  - 决策中枢：本项目在扩展内核，pi-mono 更偏 SDK/CLI 组合。
  - 执行边界：本项目把执行收敛到 infra+Bridge；`coding-agent` 更直连宿主。
  - 安全默认：本项目强调 token/origin/lease/strict 白名单。
  见 `docs/pi-mono-runtime-comparison.md:17` 到 `docs/pi-mono-runtime-comparison.md:25`。

  4. 借鉴与不直迁
  可借鉴：`ai` 的 provider registry、`agent` 的 steering/follow-up。
  不建议直迁：`coding-agent` 的 shell 直连权限模型。
  见 `docs/pi-mono-runtime-comparison.md:27` 到 `docs/pi-mono-runtime-comparison.md:35`。

  5. 迁移优先级
  先做 provider registry，再考虑 steering/follow-up，最后做 JSONL 导出互操作。
  见 `docs/pi-mono-runtime-comparison.md:36` 到 `docs/pi-mono-runtime-comparison.md:40`。

  给新同学的心智模型
  1. 这是“浏览器内核 + 本地执行代理”的双体系统。
  2. 成功标准不是“命令执行了”，而是“任务推进被 verify 证明了”。
  3. 可恢复与安全边界不是附加项，是架构主轴。

  如果你愿意，下一步我可以按这套讲解直接带你过一遍真实代码入口顺序（从 `runtime-router` 到一次完整 `tool_call`），做成“首日上手清单”。

### Step 14
- 用户：
  好，不过把每一步你和我的对话都保存到一个对话的文档里，后面方便我看

### Step 15
- 助手：
  明白，我来把目前这轮的对话先落成文档，并从这一条开始持续追加。先检查 `docs/` 里有没有现成对话日志文件，再创建统一文件。

### Step 16
- 助手：
  对话文档已写入，我现在做一次快速校验（文件是否存在、行数、末尾是否是你最新请求），确认后就继续按这个文件持续追加。

### Step 17
- 用户：
  开始

### Step 18
- 助手：
  开始进入代码实战讲解。我会按你刚才约定的顺序，从 `runtime-router` 入口一路跟到一次完整 `tool_call`，同时把这一步也追加到 `docs/conversation-log.md`。

### Step 19
- 助手：
  我先并行拆成四段代码阅读：`runtime-router` 入口、`runtime-loop` 主循环、`runtime-infra` 执行层、Bridge 的 `protocol/dispatcher/server`。读完就按“调用链”给你串起来。

### Step 20
- 助手：
  `runtime-infra` 的精读结果已经回来，关键是它把 Bridge/CDP 两条执行通道统一成一个消息入口，并用 lease 保证写操作安全。
  我继续等另外三路（router/loop/bridge），拿齐后就给你完整“端到端调用链图解”。

### Step 21
- 助手：
  `runtime-router` 也回来了，入口分发链已经完整。还差 `runtime-loop` 和 Bridge 侧 invoke 链，我拿到后就给你一版“按真实调用顺序”的教学稿。

### Step 22
- 助手：
  `runtime-loop` 结果也到了，主循环和失败判定已经完整。再等最后一个 Bridge invoke 链，我就把“从消息入口到工具执行回流”的整条路径一次讲完。

### Step 23
- 助手：
  我现在把这段“实战调用链讲解”也同步追加到 `docs/conversation-log.md`，保证你后面回看时对得上当前输出。追加完我就给你正式讲解正文。

### Step 24
- 助手：
  开始，下面是从入口到一次 `tool_call` 的代码实战路径（按真实调用顺序）。

  1. 入口：Runtime 消息先进入 `runtime-router` 的 `onMessage`，先给 infra 预处理，未命中再走 `brain.run.*` 业务分发。见 `extension/src/sw/kernel/runtime-router.ts:489`、`extension/src/sw/kernel/runtime-router.ts:498`、`extension/src/sw/kernel/runtime-router.ts:501`。
  2. 启动 run：`brain.run.start` 调 `runtimeLoop.startFromPrompt`，`autoRun` 默认 `true`。见 `extension/src/sw/kernel/runtime-router.ts:141`、`extension/src/sw/kernel/runtime-router.ts:147`。
  3. 准备会话：`startFromPrompt` 会创建/补建 session、写 user message、可选写 sharedTabs；`prompt` 为空则不启动 loop。见 `extension/src/sw/kernel/runtime-loop.browser.ts:1461`、`extension/src/sw/kernel/runtime-loop.browser.ts:1480`。
  4. 拉起循环：`startLoopIfNeeded` 在非 running 状态启动 `runAgentLoop`；若 stopped 会先重启状态。见 `extension/src/sw/kernel/runtime-loop.browser.ts:1434`、`extension/src/sw/kernel/runtime-loop.browser.ts:1441`。
  5. LLM 轮次：每轮先请求 LLM（带 messages+tools），解析 `tool_calls`。见 `extension/src/sw/kernel/runtime-loop.browser.ts:1240`、`extension/src/sw/kernel/runtime-loop.browser.ts:1250`。
  6. 无工具调用：若本轮没有 `tool_calls`，循环结束并走 `loop_done`。见 `extension/src/sw/kernel/runtime-loop.browser.ts:1277`。
  7. 有工具调用：逐个 `tool_call` 执行，入口是 `executeToolCall`，先 parse 参数 JSON。见 `extension/src/sw/kernel/runtime-loop.browser.ts:1287`、`extension/src/sw/kernel/runtime-loop.browser.ts:846`。
  8. 执行分派：`executeStep` 按 mode 分为 `bridge/cdp/script`；`script` 失败可 fallback 到 `cdp`。见 `extension/src/sw/kernel/runtime-loop.browser.ts:610`、`extension/src/sw/kernel/runtime-loop.browser.ts:639`、`extension/src/sw/kernel/runtime-loop.browser.ts:762`。
  9. infra 执行层：
     - Bridge：`invokeBridge` 统一发 WS `invoke` 帧。
     - CDP：`snapshot/action/verify` 形成“观察→执行→验收”闭环。
     见 `extension/src/sw/kernel/runtime-infra.browser.ts:358`、`extension/src/sw/kernel/runtime-infra.browser.ts:559`、`extension/src/sw/kernel/runtime-infra.browser.ts:848`。
  10. 写操作安全：`cdp.action` 的写类动作必须先持有 lease（tab 写锁 + TTL）。见 `extension/src/sw/kernel/runtime-infra.browser.ts:444`、`extension/src/sw/kernel/runtime-infra.browser.ts:965`。
  11. Bridge 真实 invoke 链：
      - 先协议校验：`type/id/tool/args`。
      - 再并发闸门：超限直接 `E_BUSY`。
      - 再 dispatcher 分发到 `read/write/edit/bash`。
      见 `bridge/src/protocol.ts:20`、`bridge/src/server.ts:210`、`bridge/src/dispatcher.ts:20`。
  12. bash 额外收口：`cmd-registry` 白名单 + strict 限制；不合规返回 `E_CMD/E_ARGS`。见 `bridge/src/cmd-registry.ts:54`、`bridge/src/cmd-registry.ts:57`、`bridge/src/cmd-registry.ts:67`。
  13. 回流到 loop：工具成功会写 `tool` 角色消息并进入下一轮；失败按 `failed_verify/failed_execute` 收敛。见 `extension/src/sw/kernel/runtime-loop.browser.ts:1335`、`extension/src/sw/kernel/runtime-loop.browser.ts:1329`。
  14. 兜底与可恢复：
      - 无 LLM 配置：`llm.skipped` 并 `loop_done(done)`。
      - LLM 异常：指数退避重试。
      见 `extension/src/sw/kernel/runtime-loop.browser.ts:1191`、`extension/src/sw/kernel/runtime-loop.browser.ts:1058`、`extension/src/sw/kernel/runtime-loop.browser.ts:1134`。

  新手最容易卡住的三点：
  1. 误把 Bridge 当大脑：实际大脑在 loop+orchestrator。
  2. 误把 ok 当成功：真正成功要看 verify 与状态收敛。
  3. 误以为 step.execute 直接操作浏览器：中间有 infra 和 lease 安全层。

  你如果继续说“下一步”，我就带你做第二段：从 `browser_action` 一个具体 case（比如 click+expect）逐行跟到 `verified=true/false` 的判定点。

### Step 25
- 用户：
  我们有 hook 机制吗

### Step 26
- 助手：
  我先快速全局搜一遍代码里是否存在明确的 `hook/hooks` 机制，同时区分“真正可插拔 hook”与“事件总线/回调”这两类，避免概念混淆。结果出来我会直接给你结论并附锚点。

### Step 27
- 助手：
  我再核实一下事件机制的实现细节（`orchestrator.events` 的定义和订阅方式），确保结论准确：到底是“可插拔 hook”还是“事件发布订阅”。

### Step 28
- 助手：
  我确认完了：项目里没有“可拦截并改写流程”的插件式 hook API，但有事件订阅机制。
  我先把这条问答也追加到日志，再给你结论和可用锚点。

### Step 29
- 助手（结论）：
  现在没有独立的 plugin-hook 体系（比如 before/after 可注册并改写执行结果）。
  有的是事件总线 `BrainEventBus`（发布/订阅），用于观测与广播，不用于拦截控制流。

  关键锚点：
  - 事件总线定义：`extension/src/sw/kernel/events.ts:36`
  - orchestrator 暴露 events：`extension/src/sw/kernel/orchestrator.browser.ts:82`
  - SW 订阅并广播为 `brain.event`：`extension/src/background/sw-main.ts:39`
  - 面板侧监听 `brain.event`：`extension/src/panel/App.vue:93`

  一句话：有“事件机制”，暂无“可插拔 hook 机制”。

### Step 30
- 用户：
  不是，我说的是 Agent 的 Hook，你可以看一下 Pi 的实现。

### Step 31
- 助手：
  明白，你说的是 Agent Hook（不是事件总线）。我现在去对照 `pi-mono` 的真实实现，先找 Hook 的定义点、触发时机、以及是否能拦截/改写执行，再回到我们项目给你精确结论。

### Step 32
- 助手：
  我同时本地直接扫一遍 `pi-mono` 代码（`hook/hooks`、`pre/post`、`approval`、`interceptor`），避免遗漏。

### Step 33
- 助手：
  第一路结果已确认：`pi/packages/agent` 里是“回调注入型 Hook + 事件订阅”，能在循环关键点改写或打断。
  我还在等 `coding-agent` 那路，它应该有更完整的扩展/hook 面。

### Step 34
- 助手：
  我不等子任务了，直接把 `coding-agent` 的 Hook 代码层也确认掉（`core/hooks`、`extensions` 入口、tool hook wrapper），这样给你的答案更完整。

### Step 35
- 助手：
  我不等子任务了，直接把 `coding-agent` 的 Hook 代码层也确认掉（`core/hooks`、`extensions` 入口、tool hook wrapper），这样给你的答案更完整。

### Step 36
- 助手：
  已对照完 Pi 两层实现（`packages/agent` + `packages/coding-agent`）。我把结论先写进日志，再给你一句话版和细节版对照。

### Step 37
- 助手（结论）：
  你说得对，Pi 里确实有 Agent Hook 机制，而且分两层：

  A. `pi-mono/packages/agent`（轻量 Hook，回调注入）
  - 定义：`AgentLoopConfig` 提供 `transformContext / convertToLlm / getSteeringMessages / getFollowUpMessages`。
    证据：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/types.ts:48`、`:67`、`:86`、`:97`
  - 触发：LLM 前做 transform+convert；tool 后检查 steering 并可跳过剩余工具。
    证据：`/Users/envvar/work/repos/_research/pi-mono/packages/agent/src/agent-loop.ts:213`、`:218`、`:365`、`:380`

  B. `pi-mono/packages/coding-agent`（完整 Hook，现名 extensions）
  - 注册接口：`ExtensionAPI.on(...)`
    证据：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/extensions/types.ts:916`
  - pre/post tool：`tool_call`（可 block）+ `tool_result`（可改写结果）
    证据：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/extensions/types.ts:951`、`:952`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/extensions/wrapper.ts:47`、`:73`、`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:607`、`:557`
  - session before* 可取消：`session_before_switch/fork/compact/tree`
    证据：`/Users/envvar/work/repos/_research/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:514`、`:537`

  回到我们项目（browser-brain-loop）：
  - 目前没有 Pi 这种“可注册、可拦截、可改写”的 Agent Hook Runner。
  - 现有的是事件总线（观测为主）：`BrainEventBus`。
    证据：`extension/src/sw/kernel/events.ts:36`、`extension/src/sw/kernel/orchestrator.browser.ts:82`

  一句话：Pi 有 Hook（尤其 coding-agent 的 extensions 很完整）；我们当前是 event 机制，还不是 Hook 机制。

### Step 38
- 用户：
  他们好像不止三个吧如果我们也要做插件系统的话，你觉得应该怎么设计？目前我们的架构要做到这个，有没有什么障碍？

### Step 39
- 助手：
  你这个判断对，绝不该只做 3 个 hook。
  我先并行梳理三件事：1) 现在有哪些天然挂点；2) 哪些挂点能安全开放；3) 哪些会破坏“浏览器是大脑”的架构铁律。然后给你一版可落地插件系统设计。

### Step 40
- 助手：
  我已经拿到骨架信息了。下一步我会精读 4 个关键点：`runAgentLoop`、`executeStep`、`runtime-infra.handleMessage`、`bridge server invoke`，然后给你“插件能力矩阵 + 改造障碍清单”。

### Step 41
- 助手：
  我再补一层：把 `runtime-router` 和 `orchestrator` 的可插入边界看清楚，这样我们能判断“插件应该挂在哪一层、避免跨层污染”。

### Step 42
- 助手：
  我再看一下 Bridge 侧的 `invoke` 主干和 `dispatcher`，评估插件系统是否要下沉到 Bridge（以及风险）。

### Step 43
- 助手：
  已对照 Pi 的 `agent` 与 `coding-agent` 实现，确认你的判断正确：Hook 不止三个，完整体系应覆盖 run/llm/tool/session/safety 多阶段。

### Step 44
- 助手（设计建议）：
  是的，不该只做 3 个。建议按“先可观测、再可拦截、最后可扩展工具”三阶段落地插件系统。

  建议的 Hook 分层：
  1. run/session 生命周期：`run.before_start`、`run.after_start`、`session.before_fork`、`session.before_compact`、`session.after_compact`。
  2. LLM 生命周期：`llm.before_request`（可改 payload）、`llm.after_response`（可改解析结果）、`llm.on_error`。
  3. tool 生命周期：`tool.before_call`（可 block）、`tool.after_result`（可改写结果）。
  4. 执行与安全：`step.before_execute`、`step.after_execute`、`cdp.before_action`、`cdp.after_verify`、`bridge.before_invoke`、`bridge.after_invoke`。

  对应当前架构的障碍：
  1. 目前只有事件总线，不支持拦截返回值。`extension/src/sw/kernel/events.ts:36`。
  2. `runtime-loop` 是大 switch +内联流程，hook 点虽有但未抽象成可插拔管线。`extension/src/sw/kernel/runtime-loop.browser.ts:846`、`extension/src/sw/kernel/runtime-loop.browser.ts:1058`。
  3. 工具定义和分发是静态的（`BRAIN_TOOL_DEFS` + `executeToolCall` switch）。`extension/src/sw/kernel/runtime-loop.browser.ts:58`、`extension/src/sw/kernel/runtime-loop.browser.ts:846`。
  4. Bridge 协议工具集静态四种，动态插件工具无法直接透传。`bridge/src/protocol.ts:4`、`bridge/src/dispatcher.ts:15`。
  5. MV3 Service Worker 不能远程动态执行代码，插件必须打包或受限加载。

  可落地方案（第一性原理不破坏）：
  1. 决策仍在浏览器：插件运行在 SW，不把决策下放 Bridge。
  2. 引入 `PluginRunner`：按 `priority + id` 顺序执行 hook，统一超时、错误策略、审计。
  3. Hook 返回三类动作：`continue` / `block(reason)` / `patch(payload)`；并按 schema 校验 patch。
  4. 强制不变量后置校验：lease、verifyPolicy 下限、bridge 白名单在 hook 后再次检查。
  5. 先做内建插件注册表（静态 import），再做配置启停（`chrome.storage.local`）。

  推荐分期：
  - P1（低风险）：只做 `tool.before_call`、`tool.after_result`、`llm.before_request`。
  - P2：补 `session.before_*` 与 `step.before/after_execute`。
  - P3：工具注册扩展（把 `executeToolCall` 改为 registry map）。

  这样能做到：能力接近 Pi 的 hooks/extensions，同时不破坏“浏览器是大脑、Bridge 只执行”的架构铁律。
