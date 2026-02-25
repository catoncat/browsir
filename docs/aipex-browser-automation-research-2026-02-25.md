# AIPex 浏览器自动化研究笔记（2026-02-25）

## 1. 研究目标

本笔记用于沉淀 AIPex 在“浏览器自动化可用性/稳定性”上的关键设计，作为 Browser Brain Loop 后续迭代的对照基线。

重点回答四件事：

1. AIPex 的端到端调用链是什么。
2. 它为什么在真实网页场景更稳。
3. 它的静默（background）模式是怎么实现的，边界在哪里。
4. 我们项目应优先吸收哪些实现。

---

## 2. 样本与范围

- 研究仓库：`~/work/repos/_research/AIPex`
- 重点模块：
  - `packages/browser-ext`
  - `packages/browser-runtime`
  - `packages/core`
  - `packages/dom-snapshot`

---

## 3. 核心结论（TL;DR）

1. AIPex 不是靠 prompt“玄学更强”，而是执行层做了工程化约束：  
   `tab 级 debugger 生命周期管理 + AXTree 快照 + uid 回注入 + 跨 iframe 合并 + 分层 fallback`。
2. 它有双通道自动化：
   - `focus`：CDP + AXTree + 可视化工具（更强）。
   - `background`：DOM snapshot + 注入脚本操作（更静默）。
3. 静默模式是“能力受限换低侵入”，不是“同等能力的隐身模式”。
4. 对我们最值钱的不是 UI，而是 6 个底层模块：`DebuggerManager`、`CdpCommander`、`SnapshotManager`、`IframeManager`、`SmartLocator`、`DomLocator`。

---

## 4. 端到端链路（AIPex）

1. SidePanel 入口  
   `packages/browser-ext/src/pages/sidepanel/index.tsx`
2. 组装 ChatApp / agent  
   `packages/browser-ext/src/pages/common/app-root.tsx`
3. 根据 automation mode 选择工具集  
   `packages/browser-ext/src/lib/browser-agent-config.ts`
4. 创建 AIPex agent  
   `packages/aipex-react/src/hooks/use-agent.ts`
5. 发送消息并消费事件流  
   `packages/aipex-react/src/hooks/use-chat.ts`
6. 进入 core agent run loop + tool calling  
   `packages/core/src/agent/aipex.ts`
7. 浏览器工具执行（runtime）  
   `packages/browser-runtime/src/tools/*`
8. 落到 automation 层（CDP 或 DOM）  
   `packages/browser-runtime/src/automation/*`

---

## 5. 工具面与能力组织

工具聚合在：

- `packages/browser-runtime/src/tools/index.ts`
- 默认导出 `allBrowserTools`（多类工具统一注册）

高频能力组：

- Tabs：查询/创建/关闭/切换组织
- UI 操作：`search_elements`、`click`、`fill_element_by_uid`、`fill_form`、`hover_element_by_uid`
- Page：metadata / scroll / highlight
- Screenshot：截图与高亮截图
- Computer：坐标级鼠标键盘动作
- Intervention：人类介入
- Skill：技能加载与执行

特点：工具层是统一入口，但执行可按 mode 分流。

---

## 6. 稳定性的关键实现

### 6.1 DebuggerManager（会话生命周期）

文件：`packages/browser-runtime/src/automation/debugger-manager.ts`

- `safeAttachDebugger`：同 tab attach 去重锁，避免并发抢占。
- attach 后自动延迟 detach，减少频繁 attach/detach 抖动。
- 监听 `onDetach` / `tabs.onRemoved`，统一清理状态。

### 6.2 CdpCommander（命令语义）

文件：`packages/browser-runtime/src/automation/cdp-commander.ts`

- 所有 CDP 命令统一走 `sendCommand`。
- 内置 timeout、pending registry、断链统一 reject。
- 错误语义一致，便于上层编排做重试/回退策略。

### 6.3 SnapshotManager（AXTree + uid 注入）

文件：`packages/browser-runtime/src/automation/snapshot-manager.ts`

- focus 模式下主路径：`Accessibility.getFullAXTree`。
- interesting nodes 两阶段筛选，减少噪声节点。
- 通过 `DOM.resolveNode + Runtime.callFunctionOn` 把 uid 回注入 DOM（`data-aipex-nodeid`）。
- 后续动作不再靠脆弱 selector 猜测，而是 `uid -> backendDOMNodeId`。

### 6.4 IframeManager（跨 frame）

文件：`packages/browser-runtime/src/automation/iframe-manager.ts`

- `Page.getFrameTree + DOM.getFrameOwner` 建 iframe 映射。
- 按 frame 拉取 AXTree，合并入主树。
- 子树 nodeId 做前缀化，避免冲突。

### 6.5 SmartLocator（CDP 真实动作）

文件：`packages/browser-runtime/src/automation/smart-locator.ts`

- click 前做 bounding box 与遮挡检测，必要时降级 JS click。
- fill 先尝试 Monaco 原生 API，失败再走通用路径（focus + selectAll + insertText + input/change/blur）。
- 跨 iframe 坐标恢复，提升复杂页面点击命中率。

### 6.6 DomLocator（静默模式执行）

文件：`packages/browser-runtime/src/automation/dom-locator.ts`

- 通过 `chrome.scripting.executeScript` 注入页面动作。
- 按 `data-aipex-nodeid` 定位，支持同源 iframe 递归查找。
- 支持 click/fill/hover/value/editor-value 等基础动作。

---

## 7. 静默模式（background）是怎么做到的

### 7.1 机制

1. 模式状态存储：`AUTOMATION_MODE`（focus/background）  
   `packages/browser-runtime/src/runtime/automation-mode.ts`
2. 工具层硬隔离：background 过滤掉 `computer` 与所有 screenshot 工具  
   `packages/browser-ext/src/lib/browser-agent-config.ts`
3. 快照改走 DOM 路径，不走 CDP  
   `packages/browser-runtime/src/automation/snapshot-provider.ts`
4. 动作改为页面脚本注入执行，不做系统级鼠标键盘接管  
   `packages/browser-runtime/src/automation/dom-locator.ts`
5. 对窗口焦点相关操作做限制或降级  
   `packages/browser-runtime/src/tools/tab.ts`  
   `packages/browser-runtime/src/tools/tools/window-management/index.ts`

### 7.2 代价（功能与稳定性折损）

- 无视觉坐标能力（computer/screenshot 禁用）。
- 语义来源从 AXTree 降到 DOM 启发式。
- 对 `isTrusted` 强依赖的复杂控件更容易失败。
- 跨域 iframe 深层动作能力受限。
- 动态重渲染导致 uid 失效时，需要重新快照。

结论：静默模式是“低侵入优先”，不是“满能力隐身”。

---

## 8. “失败后自动切全自动并续跑”可行性评估

结论：**理论可行，当前实现未完整打通**。

已具备条件：

- 会话可持续（`sessionId`）并可继续对话，不必从头开新会话。  
  `packages/aipex-react/src/hooks/use-chat.ts`
- 工具失败事件可捕获并驱动 UI 反馈。  
  `packages/aipex-react/src/adapters/chat-adapter.ts`

当前缺口：

- 模式切换后未看到完整的“自动升级编排策略”（失败触发 -> 切 mode -> 注入提示 -> 续跑当前 step）。
- `useAgent` 当前 effect 依赖不含 tools 变化，mode 切换后的工具集更新策略需要谨慎确认。  
  `packages/aipex-react/src/hooks/use-agent.ts`

---

## 9. 与我们项目（Browser Brain Loop）对照

我们当前优点：

- 已有租约、verify、runtime infra、capability policy 的框架。  
  `extension/src/sw/kernel/runtime-infra.browser.ts`  
  `extension/src/sw/kernel/runtime-loop.browser.ts`

主要差距：

1. snapshot 仍以 `Runtime.evaluate + querySelector` 为主，不是 AXTree 主路径。
2. ref/backendNode 目前是伪映射，不是稳定的真实 backend node 绑定。
3. 缺少完整的跨 iframe AXTree 合并与定位链路。
4. 缺少类似 AIPex 的专用 `DebuggerManager/CdpCommander` 分层（我们当前逻辑更多内嵌在 infra handler）。

---

## 10. 建议迁移顺序（先做能立刻提升稳定性的）

### P0（必须先做）

1. 抽出 `DebuggerManager + CdpCommander`（统一 attach/timeout/pending/error 语义）。
2. 将 `cdp.snapshot` 主路径升级为 AXTree（保留 DOM 作为 fallback）。
3. 建立真实 `uid -> backendDOMNodeId` 映射与 DOM 回注入。
4. `browser_action` 改为优先走 backend node 动作链（click/fill first）。

### P1（复杂场景稳定性）

1. 引入 iframe AXTree 合并。
2. 完整的 Smart fill 策略（Monaco 优先 + 通用 fallback）。
3. 背景/焦点双模式能力矩阵与自动降级策略。

### P2（体验层）

1. 失败触发“建议切 focus 并续跑”。
2. 自动续跑当前 step（不清 session，不重头）。
3. 对外文案与诊断提示标准化。

---

## 11. 测试与可证明性

AIPex 在 automation 层有 Puppeteer 集成测试（这点值得直接复用思路）：

- `packages/browser-runtime/src/automation/snapshot-manager.puppeteer.test.ts`
- `packages/browser-runtime/src/automation/iframe-manager.puppeteer.test.ts`
- `packages/browser-runtime/src/automation/smart-locator.puppeteer.test.ts`

对我们的启发：  
“真实页面 + 真实 frame + 真实输入链”的集成测试要成为门禁，而不只靠 mock。

---

## 12. 后续维护约定

本研究文档作为外部方案参考，不替代本仓库真实实现口径。  
若后续实现落地与本文不一致，以以下内容为准：

1. `extension/src/sw/kernel/**` 现行代码
2. `extension/src/sw/kernel/__tests__/**`
3. `bdd` 合同门禁与 evidence

