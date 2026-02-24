# Browser Agent 可靠性改进手册（根因复盘 + 业界对照）

> 更新时间：2026-02-24  
> 适用范围：`extension/src/sw/kernel` 的 browser tool-call 链路（`snapshot / browser_action / browser_verify`）以及 Loop 编排层。

关联文档：

1. `docs/adr-0001-browser-agent-reliability.md`
2. `docs/browser-agent-reliability-checklist.md`

## 1. 结论（TL;DR）

1. 当前核心问题不是“工具能不能执行”，而是“执行成功是否等价于目标推进成功”。
2. BBL 在 `ref` 稳定性、verify 语义一致性、no_progress 收敛和 tab 粘性上存在系统性缺口。
3. 业界主流做法是：`Observe -> Act -> Verify` 强闭环 + 时间窗轮询验证 + 浏览器与 shell/代码工具混合编排。

## 2. 输入样本与失败画像

本次分析基于诊断会话 `session-ce26e94d-a95e-49c5-bfc8-f7124bc330e3`（`BBL_DIAGNOSTIC_V2`）：

- `lastError = "action target not found by ref/selector"`
- 在 paste 任务中出现多站点切换（`pastebin -> hastebin -> rentry -> termbin -> dpaste`）
- 多次 `click/fill` 返回 `ok=true` 但 verify 未通过，导致策略反复试探

## 3. 仓库内根因证据（第一性原理）

### 3.1 定位层：`ref` 不是稳定句柄

- `snapshot` 每次重建 `e0/e1...` 索引，`ref` 生命周期短：`extension/src/sw/kernel/runtime-infra.browser.ts:843`
- `backendNodeId` 当前是占位值（`index+1`），不是真实 CDP 节点标识：`extension/src/sw/kernel/runtime-infra.browser.ts:852`
- selector 生成仅覆盖 `id/name`，大量节点可能为空 selector：`extension/src/sw/kernel/runtime-infra.browser.ts:808`
- 最终 selector 为空时直接报错：`extension/src/sw/kernel/runtime-infra.browser.ts:937`

### 3.2 判定层：verify 过粗且语义不一致

- 默认 verify（`on_critical`）把 `click/fill` 纳入，但无显式 expect 时仅对比 `url/title/textLength/nodeCount`：`extension/src/sw/kernel/runtime-loop.browser.ts:342`
- `click/fill` 动作执行后立即返回，没有稳定等待窗口：`extension/src/sw/kernel/runtime-infra.browser.ts:946`
- `cdp.verify` 也是单次判定，不轮询：`extension/src/sw/kernel/runtime-infra.browser.ts:1017`
- `browser_action` 中，很多场景 `verified=false` 仍可作为成功返回（只有 `navigate` 或显式 expect 才硬失败）：`extension/src/sw/kernel/runtime-loop.browser.ts:1663`

### 3.3 收敛层：文档声明与实现不一致

- README 声明已有 `no_progress` 检测：`README.md:265`
- 但事件类型中没有对应 `no_progress` 事件：`extension/src/sw/kernel/events.ts:3`
- 当前主要是“错误重试预算”而非“软失败循环收敛”：`extension/src/sw/kernel/runtime-loop.browser.ts:2152`

### 3.4 目标保持层：tab 易漂移

- 未显式传 `tabId` 时默认取 active tab：`extension/src/sw/kernel/runtime-loop.browser.ts:1620`
- `open_tab` 默认激活新页，可能改变后续动作目标：`extension/src/sw/kernel/runtime-loop.browser.ts:922`

### 3.5 工具编排层：浏览器动作过载

- 架构允许 `bash.exec`（默认开启）：`README.md:243`
- 但在实际策略里，容易把可在 shell 侧完成的文本/数据处理挤到浏览器动作链路，增加不确定性

## 4. 业界最佳实践（官方资料）

### 4.1 OpenAI / Anthropic：浏览器工具不应单打独斗

- OpenAI Computer Use 强调该能力“仍在早期”，并要求高风险场景谨慎与人类监督。  
  来源：<https://platform.openai.com/docs/guides/tools-computer-use>
- OpenAI Local Shell 提供“同一 agent 中调用本地 shell”的能力，适合把非 UI 工作移出浏览器。  
  来源：<https://platform.openai.com/docs/guides/tools-local-shell>
- Anthropic Computer Use 明确建议与 `bash/text_editor` 组合使用，不把浏览器当唯一执行面。  
  来源：<https://docs.anthropic.com/en/docs/agents-and-tools/computer-use>

### 4.2 Playwright / Puppeteer：动作必须带可操作性与等待

- Playwright actionability：点击前会检查可见、稳定、可接收事件、可用等条件。  
  来源：<https://playwright.dev/docs/actionability>
- Puppeteer Locator/Wait：推荐使用 `waitForSelector`/Locator 自动等待稳定状态。  
  来源：<https://pptr.dev/api/puppeteer.page.waitforselector>  
  来源：<https://pptr.dev/guides/page-interactions>

### 4.3 Browser Use / Stagehand：AI 规划 + 确定性执行混合

- Browser Use 官方工具集不仅有浏览器动作，也包含文件读写、bash 等系统工具；支持持久化 session/cookies。  
  来源：<https://docs.browser-use.com/customize/tools/available-tools>  
  来源：<https://docs.browser-use.com/customize/browser/browser-session>
- Browser Use 支持自定义工具与 Playwright 集成（稳定步骤 + AI 回退）。  
  来源：<https://docs.browser-use.com/customize/tools/add-tools>  
  来源：<https://docs.browser-use.com/customize/tools/playwright-integration>
- Stagehand 明确定位为“deterministic browser automation + AI fallback/self-heal”。  
  来源：<https://github.com/browserbase/stagehand>

### 4.4 OpenHands：本地执行能力强，但需要明确安全边界

- OpenHands 说明本地 runtime 默认无沙箱隔离，强调风险与防护配置。  
  来源：<https://docs.all-hands.dev/openhands/usage/local-setup/local-runtime>
- 其 Agent 默认可访问 shell + 非交互浏览器，体现“多工具编排”是行业常态。  
  来源：<https://docs.all-hands.dev/openhands/usage/key-features>

### 4.5 CDP 工程化：优先协议生成而非手写散落调用

- `cdp-use`（Browser Use 团队）强调从官方 CDP 协议自动生成类型安全客户端，降低手写协议漂移风险。  
  来源：<https://github.com/browser-use/cdp-use>
- CDP 官方对 `BackendNodeId` 的定义是“可在前端未持有节点对象时引用 DOM 节点”的稳定标识。  
  来源：<https://chromedevtools.github.io/devtools-protocol/tot/DOM/#type-BackendNodeId>

## 5. 对 BBL 的落地计划（按优先级）

### P0（先止血，1 个迭代内）

1. `browser_action` 强制绑定 `tabId + snapshotId`，禁止隐式跨代 ref。
2. verify 从“单点比对”改为“时间窗轮询”（如 0.5s~2s）。
3. 动作特化 verify：
   - `fill`: 校验目标元素 value/文本确实更新
   - `click`: 校验目标状态变化或关键 selector 出现/消失
4. 统一失败语义：`verified=false` 不再静默成功，至少进入 `progress_uncertain`。
5. 修正文档与实现偏差（`no_progress` 声明必须与代码一致）。

### P1（提稳定性，2~3 个迭代）

1. 引入真实稳定节点标识（真实 `backendNodeId`/可追踪 selector 候选集）。
2. 实现 `no_progress` 检测（重复签名 + ABAB ping-pong）并产生显式事件。
3. 会话级 `primaryTabId` 粘性，默认不跟随 active tab 漂移。
4. 失败预算拆分：`failed_execute` 与 `progress_uncertain` 分开计数和收口。

### P2（提上限，持续）

1. 规划器默认混合工具策略：优先 `bash/read/write`，浏览器只做必须交互。
2. 补风险护栏：域名 allowlist、敏感动作二次确认、可审计回放。
3. 评估 CDP 客户端工程化（协议生成/typed client），降低维护成本。

## 6. 验收与门禁建议

### 6.1 BDD 契约建议

延续现有门禁契约：

- `BHV-LLM-CAPABILITY-GATE`
- `BHV-CDP-ON-DEMAND`
- `BHV-LLM-LIVE-CAPABILITY`

新增建议：

- `BHV-LOOP-NO-PROGRESS-GUARD`
- `BHV-AUTO-REPAIR-TRIGGER-BOUNDARY`
- `BHV-STRICT-VERIFY-SEMANTICS`

落点：`bdd/contracts/*` + `bdd/features/*` + `bdd/mappings/contract-to-tests.json`

### 6.2 e2e 用例建议

在 `tools/brain-e2e.ts` 增补：

1. 连续重复签名触发 `no_progress` 并终止
2. action 成功但 verify 失败时不可 `done`
3. `max_steps/stopped/timeout` 不触发 auto-repair
4. 失败后 lease 可释放并可重获
5. live 任务记录 attempt 级成功率

### 6.3 SLO 指标建议

1. 任务成功率：`done 且 verify=true`
2. 误判率：`done 但 verify=false`（目标 0）
3. 平均重试次数与 P95
4. `no_progress` 触发率
5. e2e 总时长（default/live）

## 7. 备注

本手册优先解决“可解释失败 + 可收敛重试 + 可验证推进”三件事。  
在这些基础能力稳定前，不建议继续堆叠更复杂的浏览器动作策略。
