# Background 模式设计文档

> 基于 AIPex 静默执行机制深度研究，为 Browser Brain Loop 设计 Background 模式支持方案。

---

## 1. 动机

当前 BBL 所有浏览器自动化通过 CDP debugger 执行。这意味着：

- **必须 attach debugger**：每次操作触发 Chrome 地址栏蓝色 debugger 指示条，用户感知强烈
- **窗口聚焦干扰**：Tab 切换、导航等操作抢占用户焦点
- **资源竞争**：同 tab 多 debugger 会话可能冲突
- **场景受限**：用户无法在自动化执行期间正常使用浏览器

Background 模式提供"低侵入"运行通道——牺牲部分高级能力换取静默后台执行。

---

## 2. AIPex 实现分析

### 2.1 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│  用户选择 → chrome.storage("AUTOMATION_MODE": focus|background) │
└────────────────────────┬────────────────────────────────────┘
                         │
         ┌───────────────┴───────────────┐
         ▼                               ▼
   ┌──────────┐                   ┌──────────────┐
   │  Focus   │                   │  Background  │
   └────┬─────┘                   └──────┬───────┘
        │                                │
  ┌─────┴──────────┐          ┌──────────┴───────────┐
  │ 工具集: ALL     │          │ 工具集: 过滤掉       │
  │                │          │ computer/screenshot  │
  └─────┬──────────┘          └──────────┬───────────┘
        │                                │
  ┌─────┴──────────┐          ┌──────────┴───────────┐
  │ CDP AXTree     │          │ DOM 树遍历           │
  │ (debugger)     │          │ (content script)     │
  └─────┬──────────┘          └──────────┬───────────┘
        │                                │
  ┌─────┴──────────┐          ┌──────────┴───────────┐
  │ SmartLocator   │          │ DomLocator           │
  │ CDP坐标/bbox   │          │ CSS selector by UID  │
  │ Input.dispatch │          │ JS dispatchEvent     │
  └────────────────┘          └──────────────────────┘
```

### 2.2 五层隔离机制

| 层 | Focus 模式 | Background 模式 | 实现位置 |
|---|---|---|---|
| **工具集过滤** | 全部工具 | 移除 `computer` + `*screenshot*` | `filterToolsByMode()` React hook |
| **快照采集** | CDP `Accessibility.getFullAXTree` | `chrome.scripting.executeScript` DOM 遍历 | `snapshot-provider.ts` `createSnapshot()` |
| **元素定位** | `SmartLocator`（CDP `DOM.resolveNode`） | `DomLocator`（`data-aipex-nodeid` CSS 选择器） | `element.ts` `getElementByUid()` |
| **动作执行** | CDP `Input.dispatchMouseEvent`/`DOM.focus` | JS `dispatchEvent(new MouseEvent())` 合成事件 | `SmartElementHandle` vs `DomElementHandle` |
| **Tab/窗口** | `tabs.update(active:true)` 聚焦 | `tabs.highlight()` 标记不聚焦 | 各 tool 内按 mode 分支 |

### 2.3 DOM 快照采集（content script）

AIPex `@aipexstudio/dom-snapshot` 包：

- **UID 稳定化**：元素已有 `data-aipex-nodeid` 则复用，新节点分配 nanoid
- **递归遍历**：`element.children` DFS，跳过 `script/style/noscript/svg/head`
- **iframe 递归**：同源 `iframe.contentDocument` 可访问时递归遍历
- **角色推断**：`el.computedRole` → `INPUT_TYPES_AS_ROLE` → ARIA fallback
- **隐藏过滤**：`display:none` 跳过整棵子树；`visibility:hidden` 允许后代覆盖
- **文本截断**：`maxTextLength=160`
- **输出转统一格式**：`DomSnapshotNode` → `TextSnapshotNode`（与 CDP 格式统一）

### 2.4 DomLocator（纯 DOM 操作器）

通过 `chrome.scripting.executeScript` 注入 `runDomAction` 函数：

```
支持 6 种动作，全部使用合成事件：
click     → dispatchEvent(MouseEvent: mousedown → mouseup → click)
fill      → element.value = ""; Event(input); Event(change); Event(blur)
hover     → dispatchEvent(MouseEvent: mouseover → mouseenter)
bounding-box → getBoundingClientRect()
value     → element.value / textContent
editor-value → value getter（无特殊编辑器处理）
```

**UID 查找**：`document.querySelector('[data-aipex-nodeid="<uid>"]')` + 同源 iframe 递归。

### 2.5 Background 模式的能力限制

| 限制 | 原因 |
|---|---|
| 无坐标级操作 | computer 工具依赖 CDP `Input.dispatchMouseEvent`，已过滤 |
| 无截图能力 | screenshot 工具依赖 CDP `Page.captureScreenshot`，已过滤 |
| 合成事件 `isTrusted=false` | 强安全性控件拒绝非信任事件 |
| CodeMirror/Monaco 不可用 | 这些编辑器拦截标准 DOM 事件，需要专用 API |
| 跨域 iframe 无法操作 | `contentDocument` 不可访问 |
| 语义信息降级 | DOM 启发式角色推断精度低于 CDP AXTree |

---

## 3. BBL 当前架构对照

### 3.1 快照管线

```
BBL 当前：
  takeInteractiveSnapshotByAX()
    → CDP Accessibility.getFullAXTree（按 frame 分桶）
    → 角色/交互性过滤 候选 → maxNodes*3=360
    → DOM.resolveNode 每个候选取 DOM 属性（20+ 字段）
    → enrichmentPipeline（Hierarchy + Intent + SessionContext）
    → 排序截断到 maxNodes=120
    → 搜索时 scoreSearchNode 只返回 top 20
    → 返回 JSON 对象数组，每节点 ~50-80 token

  降级路径：
  takeInteractiveSnapshotByDomEvaluate()
    → Runtime.evaluate 注入 querySelector 遍历（仍通过 CDP）
    → 纯文本格式输出

AIPex 对比：
  CDP路径：
    → Accessibility.getFullAXTree
    → AXTree → uid 注入（data-aipex-nodeid）
    → 格式化为缩进文本，每节点 ~10 token
  DOM路径：
    → chrome.scripting.executeScript 注入 collectDomSnapshot()
    → uid 稳定化 + 角色推断
    → 转为统一 TextSnapshotNode 格式
```

**关键差异**：
1. BBL 的 DOM 降级路径仍需 CDP（Runtime.evaluate），不是真正的 background 通道
2. BBL 无 content script 侧快照能力
3. BBL 每个节点输出 ~50-80 token（JSON），AIPex ~10 token（纯文本）

### 3.2 动作执行

```
BBL 当前：
  infra-cdp-action.ts
    → 所有动作通过 CDP：
      click: DOM.resolveNode → 获取 bbox → Input.dispatchMouseEvent
      fill:  DOM.focus → Runtime.callFunctionOn(selectAll + insertText)
      hover: Input.dispatchMouseEvent(type: mouseMoved)
      scroll: Runtime.evaluate(scrollIntoView/scrollBy)
    → UID 属性名: data-brain-uid
    → 定位方式: backendNodeId → DOM.resolveNode → objectId

AIPex 对比：
  Focus:  SmartLocator（同上 CDP 方式，更完善的遮挡检测与 fallback）
  Background: DomLocator（chrome.scripting.executeScript 注入 JS 函数）
    → 定位方式: querySelector('[data-aipex-nodeid="<uid>"]')
    → 操作方式: 合成 DOM 事件
```

**关键差异**：
1. BBL 完全硬编码 CDP，无可替换的执行策略接口
2. BBL 的 UID 属性（`data-brain-uid`）通过 CDP 注入，background 模式无法使用
3. BBL 无 `ElementHandle` / `Locator` 抽象接口，动作代码与 CDP 耦合

### 3.3 工具注册

```
BBL 当前：
  tool-contract-registry.ts 静态注册全部工具 schema
  dispatch-plan-executor.ts 静态路由所有工具到 CDP capability
  → 无按模式过滤机制

AIPex 对比：
  allBrowserTools 静态注册
  useBrowserTools() hook 按 automationMode 动态过滤
  → LLM 在 background 模式下看不到 computer/screenshot 工具
```

---

## 4. BBL Background 模式设计方案

### 4.1 Phase 1：基础设施

#### 4.1.1 `automation-mode.ts` — 模式状态管理

```
位置：extension/src/sw/kernel/automation-mode.ts
职责：读写 chrome.storage 中的 automation mode
API：
  getAutomationMode(): Promise<"focus" | "background">
  setAutomationMode(mode): Promise<void>
  onAutomationModeChange(callback): void
```

#### 4.1.2 `dom-snapshot-collector.ts` — Content Script 侧快照采集

```
位置：extension/src/content/dom-snapshot-collector.ts
类型：Content Script（需要 manifest.json 注册）
职责：在页面上下文遍历 DOM 树，生成快照
API（消息协议）：
  请求：{ type: "brain:collect-dom-snapshot", options? }
  响应：{ success, data: SerializedDomSnapshot, error? }
实现：
  - UID 属性名：data-brain-uid（复用现有命名）
  - 角色推断：computedRole → INPUT_TYPES_AS_ROLE → ARIA fallback
  - SKIP_TAGS：script, style, noscript, svg, head, meta, link, template
  - SKIP_ROLES：generic, none, group, main, navigation, contentinfo,
                search, banner, complementary, region, article, section,
                presentation, LineBreak, InlineTextBox
  - 同源 iframe 递归遍历
  - maxTextLength=160 截断
```

#### 4.1.3 `dom-locator.ts` — 纯 DOM 动作执行器

```
位置：extension/src/sw/kernel/dom-locator.ts
职责：通过 chrome.scripting.executeScript 注入页面操作
API：
  class DomLocator {
    constructor(tabId: number)
    click(uid: string, options?): Promise<ActionResult>
    fill(uid: string, value: string, options?): Promise<ActionResult>
    hover(uid: string, options?): Promise<ActionResult>
    boundingBox(uid: string): Promise<ActionResult<BoundingBox>>
    value(uid: string): Promise<ActionResult<string>>
  }
实现：
  - UID 定位：querySelector('[data-brain-uid="<uid>"]') + iframe 递归
  - 动作：合成 MouseEvent/Event 派发
  - 高亮反馈：可选 outline/boxShadow 动画（1.2s 淡出）
```

### 4.2 Phase 2：路由切换

#### 4.2.1 快照路由

在 `runtime-infra.browser.ts` 的 `takeSnapshot()` 函数中引入模式分支：

```
async function takeSnapshot(tabId, options) {
  const mode = await getAutomationMode();
  if (mode === "background") {
    return await takeSnapshotByDom(tabId, options); // 新增：content script 路径
  }
  // 现有 CDP 路径不变
  return await takeInteractiveSnapshotByAX(tabId, options, ...);
}
```

#### 4.2.2 动作路由

在 `infra-cdp-action.ts` 的 `executeByCDP()` 入口处引入模式分支：

```
async function executeAction(tabId, input) {
  const mode = await getAutomationMode();
  if (mode === "background") {
    return await executeByDom(tabId, input); // 新增：DomLocator 路径
  }
  return await executeByCDP(tabId, input);
}
```

#### 4.2.3 工具过滤

在 `runtime-loop.browser.ts` 的 LLM 工具集构建处：

```
const tools = mode === "background"
  ? toolDefinitions.filter(t =>
      t.name !== "computer" &&
      !t.name.includes("screenshot"))
  : toolDefinitions;
```

在 `prompt-policy.browser.ts` 的 system prompt 中按模式调整工具描述。

#### 4.2.4 Tab 行为适配

在 `dispatch-plan-executor.ts` 的 tab 操作处：

```
// background 模式创建 tab 不激活
chrome.tabs.create({ url, active: mode !== "background" });
// background 模式切换 tab 仅高亮
if (mode === "background") {
  chrome.tabs.highlight({ tabs: targetTab.index, windowId });
} else {
  chrome.tabs.update(tabId, { active: true });
}
```

### 4.3 Phase 3：健壮性

#### 4.3.1 UI 入口

Side Panel 增加 automation mode 切换开关（focus / background）。

#### 4.3.2 失败处理

Background 模式失败不自动升级到 focus 模式（AIPex 同策略），改为：
- 在 tool response 中标注 `mode: "background"` 和 `hint: "switch to focus mode for full capabilities"`
- LLM 可根据 hint 建议用户切换

#### 4.3.3 Content Script 就绪检测

Background 模式依赖 content script，需检测就绪性：
- `chrome.tabs.sendMessage` 超时处理
- 未就绪时返回明确错误码 `E_CONTENT_SCRIPT_NOT_READY`

---

## 5. Manifest 变更

```json
// manifest.json 新增
"content_scripts": [
  {
    "matches": ["<all_urls>"],
    "js": ["content/dom-snapshot-collector.js"],
    "run_at": "document_idle",
    "all_frames": true
  }
]
```

---

## 6. 风险与权衡

| 风险 | 缓解措施 |
|---|---|
| Content script 未加载 | 超时检测 + 明确错误提示 |
| 合成事件被拒绝 | 日志记录 + LLM 错误信息引导切 focus |
| 跨域 iframe | 仅处理同源 iframe，跨域 content 不可操作 |
| DOM 快照信噪比 | 复用 AIPex 的 SKIP_TAGS/SKIP_ROLES 过滤策略 |
| UID 不稳定（DOM 变化后） | 快照失效时重新采集并分配新 UID |
| 性能（大页面 DOM 遍历） | totalNodes 上限 + maxTextLength 截断 |

---

## 7. 未涵盖（可后续迭代）

- 模式自动升级策略（background 连续失败 → 建议切 focus）
- 混合模式（部分操作 CDP、部分 DOM）
- 离屏 tab（chrome.offscreen）支持
- Background Service Worker 中的 content script 管理
