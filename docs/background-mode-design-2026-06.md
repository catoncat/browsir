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

---

## 附录 A：快照核心代码详细对比（BBL infra-snapshot-helpers vs AIPex snapshot-manager）

### A.1 整体架构差异

| 维度 | BBL `infra-snapshot-helpers.ts` | AIPex `snapshot-manager.ts` |
|---|---|---|
| 定位 | 纯函数工具集（无状态） | 类实例 `SnapshotManager`（有缓存状态） |
| 快照策略 | 无策略概念，调用方决定 | `SnapshotStrategy` ("cdp" / "dom" / "auto") |
| 缓存 | 无内置缓存 | `#snapshotMap` 按 tabId 缓存 |
| UID 管理 | 由 `enrichmentPipeline` 外部分配 `ref` | 内建 `fetchExistingNodeIds()` + nanoid 分配 `data-aipex-nodeid` |
| CDP 封装 | 直接调 `chrome.debugger.sendCommand` | 经 `CdpCommander` 统一 timeout/retry |
| debugger 生命周期 | 内联 attach/detach | `DebuggerManager` 单例管理 |
| iframe | `collectFrameIdsFromTree` + 按 frameId 分桶查 AXTree | `IframeManager` + DOM 快照按 frame 合并 |
| DOM 快照 | `takeInteractiveSnapshotByDomEvaluate` (仍需 CDP) | `getDomSnapshot` (content script，无需 CDP) |

### A.2 AXTree 处理差异

**BBL — `takeInteractiveSnapshotByAX()`**：
```
1. Runtime.evaluate 取 page URL/title
2. Page.getFrameTree → collectFrameIdsFromTree → frameId 列表
3. 每个 frameId 调 Accessibility.getFullAXTree（树分桶）
4. 遍历 nodes: ignored=true 跳过 → backendDOMNodeId 存在性检查 → isSkipRole 过滤
5. 交互性过滤: isInteractiveRole 判定（16 种角色），filter=all 时跳过
6. 候选池上限: maxNodes*3（默认 360）
7. 每个候选: DOM.resolveNode → Runtime.callFunctionOn 取 20+ DOM 属性
8. enrichmentPipeline 三阶段处理
9. 排序: focused > visible > hasLabel → 截断到 maxNodes=120
10. 返回: JSON 对象数组，每节点 ~50-80 token
```

**AIPex — `createSnapshot()`**：
```
1. safeAttachDebugger → Accessibility.enable → Accessibility.getFullAXTree
2. iframeManager.populateIframes() 合并 iframe 子树
3. 遍历 nodes: 两阶段 isInterestingNode 筛选（角色+名字+值+控件状态）
4. fetchExistingNodeIds(): 批量 DOM.resolveNode + Runtime.callFunctionOn 取已有 UID
5. assignNodeIds(): 已有 UID 复用，新节点 nanoid → data-aipex-nodeid 回注入
6. buildTextSnapshotNode(): AXNode → TextSnapshotNode 递归转换
7. 返回: TextSnapshot { root, idToNode: Map<string, TextSnapshotNode> }
8. 输出: formatNode() 递归 → 缩进纯文本，每节点 ~10 token
```

**核心差异总结**：

| 步骤 | BBL | AIPex | 影响 |
|---|---|---|---|
| UID 来源 | enricher 分配 `ref`（`e0`, `e1`...），每次快照重新编号 | `data-aipex-nodeid` DOM 属性，跨快照稳定 | AIPex UID 在页面持续有效，BBL 每次快照 UID 都变 |
| 属性获取 | 每个节点单独 `DOM.resolveNode` + `callFunctionOn` | 批量并发（p-limit=50）+ 只取 UID 和 tagName | AIPex 快照速度更快（并发），BBL 串行 |
| 输出格式 | JSON 对象数组 | 缩进纯文本 | AIPex 输出 token 量 ~1/5 |
| 信息量 | 丰富（20+ DOM 属性/节点） | 精简（role + name + value + 状态 flag） | BBL 信噪比低但信息全，AIPex 精简但可能漏细节 |
| 角色过滤 | `isSkipRole`（15 种 SKIP_ROLES） | `SKIP_ROLES`（13 种）+ `isInterestingNode` 两阶段 | 整体过滤力度接近 |

### A.3 DOM 降级路径差异

**BBL — `takeInteractiveSnapshotByDomEvaluate()`**：
```
通过 CDP Runtime.evaluate 注入大段 JS 到页面执行
→ 仍需要 debugger attach
→ querySelector("*") 遍历所有元素
→ 按 interactive CSS selector 过滤
→ 提取 DOM 属性（tag, id, class, ariaLabel, value 等）
→ 生成 fallback selector path
→ 返回 JSON 数组
```

**AIPex — `getDomSnapshot()`**：
```
通过 chrome.tabs.sendMessage 向 content script 发消息
→ 不需要 debugger attach
→ content script 中 collectDomSnapshot() 遍历 DOM
→ 递归处理同源 iframe
→ UID 稳定化（data-aipex-nodeid）
→ 角色推断 + 交互性过滤
→ 返回 SerializedDomSnapshot
```

**核心差异**：BBL 的"DOM 降级"仍然依赖 CDP，因此不是真正的 background 通道。AIPex 的 DOM 路径完全不需要 debugger。

### A.4 搜索（search_elements）差异

**BBL**：
```
scoreSearchNode(): 分词 → 加权匹配 → top maxResults(20)
返回完整 JSON 对象数组
```

**AIPex**：
```
searchSnapshotText(): glob + "|" OR 语法全文匹配
→ 只返回匹配行 + contextLevels 行上下文
→ "✓" 标记匹配行
→ 分组显示，组间 "----" 分隔
```

**Token 开销估算**（500 AX 节点的典型页面，搜索 "submit button"）：

| 维度 | BBL | AIPex |
|---|---|---|
| 搜索结果数 | 20 个完整 JSON 对象 | 5-15 匹配行 + context |
| Token/结果 | ~50-80 | ~10-20 |
| 搜索总 Token | ~1000-1600 | ~100-300 |

---

## 附录 B：实现 Background 模式的预期改善与隐藏风险

### B.1 预期改善

| 改善点 | 描述 | 量化预期 |
|---|---|---|
| **用户体验** | 用户可以在自动化期间继续使用浏览器 | 从"完全被接管"变为"后台静默运行" |
| **debugger 指示条** | Background 模式完全不触发蓝色 debugger 条 | 100% 消除 |
| **窗口焦点** | Tab 操作不再抢占焦点 | 100% 消除 |
| **资源竞争** | 不占用 debugger 会话 slot | 减少与 DevTools 等冲突 |
| **快照速度** | content script DOM 遍历可能比 CDP AXTree + 逐个 resolveNode 更快 | 预估提速 30-50%（省去串行 resolveNode） |
| **Token 消耗** | 如果同时改用纯文本格式输出 | 预计降低 60-70% |
| **简单任务效率** | 对于"点击 → 填写 → 提交"类简单自动化流程 | 减少 2+ CDP 调用/步 |

### B.2 隐藏风险

#### B.2.1 严重风险

| 风险 | 描述 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| **isTrusted 拒绝** | 合成 DOM 事件 `isTrusted=false`，部分网站安全检测会拒绝非真实用户事件 | 高 | 特定网站（银行、支付、Google reCAPTCHA）完全无法操作 | 明确告知用户 background 模式在安全性强的网站上可能失败，引导切换 focus |
| **SPA 状态不一致** | 合成事件触发后，SPA 框架（React/Vue）可能未正确处理状态更新 | 中 | 操作看似成功但页面状态未实际改变 | 需在 fill 后主动触发 input + change + blur 事件链；建议自动化后重新快照验证 |
| **Content Script 生命周期** | MV3 Service Worker 可能在 content script 之前被唤醒，或 content script 在页面导航后丢失 | 中 | 快照请求无响应 | 增加就绪检测 + 超时重试；用 `chrome.scripting.executeScript` 作为 fallback 注入 |
| **cross-origin iframe** | 跨域 iframe 的 contentDocument 不可访问 | 高 | iframe 内元素无法操作（如嵌入的支付 widget、OAuth 弹窗） | 仅收集同源 iframe，跨域区域标记为 `<cross-origin-frame>` 提示 LLM |

#### B.2.2 中等风险

| 风险 | 描述 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| **角色推断不准** | DOM 启发式角色推断（`computedRole` + `INPUT_TYPES_AS_ROLE`）精度低于 CDP AXTree | 中 | LLM 看到错误角色，可能做出错误操作决策 | Chrome 80+ 支持 `el.computedRole`，但并非所有浏览器版本一致；需要 fallback 逻辑 |
| **Shadow DOM** | `querySelector` 无法穿透 Shadow DOM | 中 | Web Components 内部元素不可见 | 需要 `element.shadowRoot?.querySelector` 递归；但 closed shadow DOM 无解 |
| **隐藏元素误判** | `display:none` 检测依赖 `getComputedStyle`，性能开销大且可能漏掉通过 `clip`/`opacity` 隐藏的元素 | 低 | 返回不可操作的元素 | 综合检查 `offsetParent`/`getBoundingClientRect` |
| **UID 漂移** | DOM 动态变化后 `data-brain-uid` 所标记的元素可能已被替换 | 中 | 操作了错误元素 | 操作前验证 UID 对应元素仍存在，失败时建议重新 search_elements |
| **MV3 权限** | `chrome.scripting.executeScript` 需要 `scripting` 权限和主机权限 | 低 | 部分用户可能未授权 | manifest 声明 + 运行时权限请求 |

#### B.2.3 低风险但值得关注

| 风险 | 描述 |
|---|---|
| **编辑器操作** | CodeMirror/Monaco/ACE 等编辑器通过 VDOM 渲染，标准 `element.value` 无效，需要专用 API；background 模式下 AIPex 同样不支持 |
| **拖拽操作** | 合成 drag 事件序列（dragstart → dragover → drop）在很多框架中不被正确处理 |
| **文件上传** | `<input type="file">` 无法通过 DOM 事件触发打开文件选择对话框 |
| **Canvas 内容** | 无法通过 DOM 操作 Canvas/WebGL 内容 |
| **双工具维护** | 同时维护 CDP 路径和 DOM 路径增加代码复杂度和测试负担 |

### B.3 与 AIPex 的已知问题对照

AIPex 在 background 模式下遇到的已知问题及其状态：

| 问题 | AIPex 处理方式 | BBL 建议 |
|---|---|---|
| computer/screenshot 禁用 | 工具集过滤 + 工具内抛 Error | 同策略，在 prompt 中说明不可用原因 |
| 合成事件失败 | 无特殊处理，靠 LLM 重试 | 增加 actionResult.trusted=false 标记 |
| content script 未就绪 | 严格报错，不 fallback CDP | 可增加 executeScript fallback |
| 跨域 iframe | 静默跳过 | 在快照中标记 `<cross-origin-frame>` |
| 编辑器操作 | DomLocator 无特殊处理（直接失败） | 同上 |
| 模式切换后工具集更新 | `useAgent` 的 effect 依赖不含 tools 变化（AIPex 已知 bug） | BBL 需确保 mode 变更后 LLM 工具列表同步更新 |
