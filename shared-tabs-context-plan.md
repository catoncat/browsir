# Shared Tabs Context 实现计划

## 背景
用户新需求是补 **BDD + 实现链路**：现在 UI 已经能选择/显示 “Sharing tabs”，但 AI 实际不知道用户共享了哪些 tab。

当前断点：
- `ChatInput` 已 emit `tabIds`：`extension/src/panel/components/ChatInput.vue:21`, `:166-169`
- `App` 没继续透传 `tabIds`（仅按输入框文本发送）：`extension/src/panel/App.vue:84-90`
- `runtime.sendPrompt` 仅发 `prompt/newSession`：`extension/src/panel/stores/runtime.ts:162-169`
- `service-worker` 的 `brain.run.start` 仅处理 `prompt`，未接收共享 tab 上下文：`extension/service-worker.js:3190-3207`
- LLM payload 构建未注入 shared tabs：`extension/service-worker.js:1965-1995`

## 验收偏好（已确认）
1. 断言要“三层都要”（请求层 + 回复层 + 兜底场景）
2. 有效期“每次发送覆盖”
3. 结论：
   - 现有 CDP/tool 路径是 **LLM 主动调用工具后** 才能知道 tab（`list_tabs/open_tab`）
   - 本需求是 **用户已明确 sharing 的 tabs，在开跑前就进入上下文**，因此要新增“shared tabs 注入路径”

---

## 推荐实现（先 BDD，后代码）

### 1) 新增行为契约：Shared tabs context
**文件：** `bdd/contracts/chat/BHV-CHAT-SHARED-TABS-CONTEXT.v1.json`

建议定义：
- `id`: `BHV-CHAT-SHARED-TABS-CONTEXT`
- `intent`: 用户分享的 tabs（title/url）必须进入 AI 上下文，并在回复中可观测
- `proof_requirements.required_layers`: `unit`, `browser-cdp`, `e2e`
- `degrade_policy`: `tabIds` 为空时不注入 sharedTabs，仍可正常对话

与现有契约区分：
- 不重复 `BHV-TAB-REF-DEFAULT`（UI 选择行为）
- 不重复 `BHV-CHAT-LIST-OPEN-TABS-TOOLS`（工具调用闭环）
- 不重复 `BHV-CHAT-HISTORY-INCLUDES-TOOL-RESULT`（tool role 历史）

### 2) 新增 feature：shared tabs 的三层可执行断言
**文件：** `bdd/features/chat/shared-tabs-context.feature`

场景建议：
1. `Scenario: Shared tabs are injected into run context`
   - Given 用户选择多个 tabs 并发送
   - Then `brain.debug.dump.meta.header.metadata.sharedTabs` 包含每个 tab 的 `title` + `url`
2. `Scenario: Assistant response reflects shared tabs context`
   - Given mock LLM 接收到了 shared tabs 注入标记
   - Then assistant 回复包含约定 marker（例如 `SHARED_TABS_CONTEXT_PRESENT`）
3. `Scenario: Empty shared tabs do not pollute context`
   - Given `tabIds=[]`
   - Then metadata 不包含（或为空）`sharedTabs`
4. `Scenario: Shared tabs are overridden per send`
   - Given 同会话第二次发送新的 `tabIds`
   - Then 新一轮 metadata 以最新共享集合为准（覆盖旧值）

### 3) 更新 mapping
**文件：** `bdd/mappings/contract-to-tests.json`

新增 `BHV-CHAT-SHARED-TABS-CONTEXT` 映射：
- `unit`: `extension/src/panel/stores/runtime.ts::sendPrompt + extension/service-worker.js::handleBrainRunMessage + buildLlmPayloadFromSessionView`
- `browser-cdp`: `bdd/features/chat/shared-tabs-context.feature`
- `e2e`: `bdd/evidence/brain-e2e.latest.json`

### 4) 打通发送链路（最小改动）

#### 4.1 App 层透传 tabIds
**文件：** `extension/src/panel/App.vue`
- `handleSend` 接收 `payload: { text: string; tabIds: number[] }`
- 调 `store.sendPrompt(payload.text, { newSession: isNew, tabIds: payload.tabIds })`

#### 4.2 runtime 层透传到 brain.run.start
**文件：** `extension/src/panel/stores/runtime.ts`
- 扩展 `sendPrompt` options：`tabIds?: number[]`
- `sendMessage("brain.run.start", ...)` 增加 `tabIds`

#### 4.3 service-worker 落地 shared tabs 元数据（每次发送覆盖）
**文件：** `extension/service-worker.js`
- 在 `handleBrainRunMessage`（`3190+`）解析 `msg.tabIds`
- 复用 `queryAllTabsForBrain()`（`1864+`）按 id 解析出 `{ id, title, url }`
- 写入 session metadata（复用 `writeBrainSessionMeta` / `ensureBrainSession` 的 `header.metadata` 结构，见 `2776-2800`）
- 语义：每次 `brain.run.start` 带来的 shared tabs 覆盖上次值

#### 4.4 注入 LLM payload（让 AI“开跑前可见”）
**文件：** `extension/service-worker.js`
- 在 `buildLlmPayloadFromSessionView`（`1965+`）中，从 `view.meta.header.metadata.sharedTabs` 读取
- 若存在，追加一条 system/context 消息，内容包含共享 tabs 的 title/url 列表
- 若为空，不注入（保持 no-tab 兼容）

### 5) e2e 断言补齐
**文件：** `tools/brain-e2e.ts`
- 扩展 mock LLM 分支：检查请求 `messages` 中是否出现 shared tabs 注入片段，返回 marker
- 新增/扩展 case：
  1) 带 tabIds 发送 -> debug.dump 看到 `meta.header.metadata.sharedTabs`（title+url）
  2) assistant 回复含 marker
  3) 空 tabIds 不注入
  4) 第二轮发送覆盖共享集合

---

## 关键复用点（避免重复造轮子）
- Tab 枚举：`extension/service-worker.js::queryAllTabsForBrain` (`1864+`)
- Session metadata 管理：`readBrainSessionMeta / writeBrainSessionMeta / ensureBrainSession` (`2749+`, `2758+`, `2776+`)
- LLM payload 统一入口：`buildLlmPayloadFromSessionView` (`1965+`)
- 运行调试观测：`brain.debug.dump` (`3383+`)

## 验证步骤
1. `bun run brain:ext:build`（确保 sidepanel dist 与源码一致）
2. `bun run brain:e2e`
3. `bun run bdd:validate`
4. `bun run bdd:gate`

可选 live：
5. `bun run brain:e2e:live`
6. `bun run bdd:gate:live`

## 验收标准
- 新契约 validate/gate 通过
- e2e 可证明确实存在 sharedTabs 注入（title+url）
- assistant 回复可观测到 shared context 生效
- 空共享不污染上下文
- 同会话多次发送按“每次覆盖”生效
