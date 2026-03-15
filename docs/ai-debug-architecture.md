# AI 自动化调试浏览器扩展 — 架构与实施路线

## 背景

传统的 Chrome 扩展调试依赖手动打开 DevTools 检查 Service Worker，但 AI agent 无法直接通过 CDP 调试扩展的 SW 进程（权限隔离）。本文档描述一个三层架构，让 AI agent 能自动化完成扩展的调试闭环。

## 关键发现

### CDP 直连 WebSocket — 最优解（2026-03-15 验证）

**核心发现：** 绕过 `chrome-devtools-mcp` 的 autoConnect 握手，直接通过 Chrome 的 `DevToolsActivePort` 文件获取 WebSocket URL，用原生 CDP 协议连接，可以完整访问所有扩展目标（SidePanel、Service Worker、Sandbox iframe）。

```bash
# 1. 读取端口和 WebSocket 路径
cat "$HOME/Library/Application Support/Google/Chrome Beta/DevToolsActivePort"
# 输出：
# 9222
# /devtools/browser/<guid>

# 2. 连接 WebSocket（Node.js 原生 WebSocket 即可）
ws://127.0.0.1:9222/devtools/browser/<guid>
```

**已验证能力：**
| 操作 | 结果 |
|------|------|
| 列出所有 56 个目标（包括扩展页面、SW、iframe） | ✅ |
| 截图 SidePanel（`Page.captureScreenshot`） | ✅ |
| 读取 SidePanel DOM（`Runtime.evaluate`） | ✅ |
| 在输入框中输入消息并点击发送 | ✅ |
| 收到扩展 AI 的回复并读取 | ✅ |
| 发现 Service Worker target | ✅ |
| 发现 eval-sandbox.html iframe | ✅ |

**关键技术：** 使用 `Target.attachToTarget` + `flatten: true` 定向连接 SidePanel target，然后通过带 `sessionId` 的 CDP 命令操作。

### Puppeteer 默认禁用扩展

`chrome-devtools-mcp` 基于 Puppeteer 启动 Chrome，而 Puppeteer 默认传递 `--disable-extensions` 参数。这是之前"扩展无权限"的根因。

**解决方案：**
- `--ignore-default-chrome-arg='--disable-extensions'`：让 MCP 启动的 Chrome 保留扩展
- `--autoConnect`（推荐）：连接到用户已启动的 Chrome，天然保留所有扩展

### Chrome 144+ autoConnect（官方博文确认）

**来源：** [Chrome DevTools 官方博客](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session) (Sebastian Benz & Alex Rudenko, 2025-12-11)

Chrome Beta 147 / Stable 146（均 ≥ 144）支持 `chrome://inspect/#remote-debugging` 启用远程调试。MCP server 通过 `--autoConnect` 自动发现并连接。

**核心工作流程：**
1. 用户在 `chrome://inspect/#remote-debugging` 一次性启用远程调试
2. MCP server 发起连接请求时，Chrome 弹出对话框要求用户授权
3. 授权后调试中横幅显示「Chrome 正受到自动测试软件的控制」
4. AI agent 可以访问 DevTools 面板数据（元素面板、网络面板等）

**关键价值：** 支持在手动调试和 AI 辅助调试之间无缝切换——在 DevTools 中选中元素/网络请求后让 AI agent 接手调查。

## 三层架构

```
┌─────────────────────────────────────────────────────────┐
│                    AI Agent (Copilot/Claude)             │
├───────────┬────────────────────┬─────────────────────────┤
│   L1      │       L2           │         L3              │
│ 网页侧    │    扩展内核         │      扩展开发           │
│ 操作+验证 │    诊断+观测         │    全链路自动化         │
├───────────┼────────────────────┼─────────────────────────┤
│ chrome-   │ Bridge HTTP API    │ chrome-devtools-mcp     │
│ devtools- │ /api/diagnostics   │ -for-extension          │
│ mcp       │ /api/debug-snaps   │                         │
│ (官方)    │ (已实现)            │ (社区 fork)             │
└───────────┴────────────────────┴─────────────────────────┘
     ↓              ↓                      ↓
  Puppeteer     curl/fetch           Puppeteer + 扩展加载
  操作 SidePanel  读取 SW 内部状态     构建→加载→操作→诊断
```

### L1：网页侧操作与验证

**工具：** `chrome-devtools-mcp`（Google 官方，v0.20.0）

**能力：**
- 操作 SidePanel UI（点击、输入、截图）
- 检查页面 DOM 和 Console 输出
- 性能 trace 录制与分析
- 网络请求监控

**使用方式：**
```json
{
  "chrome-devtools": {
    "command": "npx",
    "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect", "--no-usage-statistics"]
  }
}
```

**调试场景：**
- 验证 SidePanel 渲染是否正确
- 检查用户交互流程（发消息→收回复→工具调用展示）
- 截图对比 UI 变更
- 检测 Console 中的错误信息

### L2：扩展内核诊断（已实现）

**工具：** Bridge HTTP API

**能力：**
- `brain.debug.snapshot`：模块级快照（runtime/sandbox/plugins/skills）
- `brain.debug.runtime`：运行态查询（session/queue/kernel 状态）
- `GET /api/diagnostics/<id>`：下载诊断 JSON
- `GET /api/debug-snapshots/<id>`：下载调试快照 JSON

**AI agent 调试流程：**
```bash
# 1. 列出所有导出
curl 'http://127.0.0.1:8787/api/diagnostics?token=$BRIDGE_TOKEN'
curl 'http://127.0.0.1:8787/api/debug-snapshots?token=$BRIDGE_TOKEN'

# 2. 下载诊断
curl 'http://127.0.0.1:8787/api/diagnostics/<id>?token=$BRIDGE_TOKEN' -o diag.json

# 3. 搜索关键线索
rg 'loop_error|failed_execute|no_progress' diag.json
jq '.payload.data.runtime.summary' snapshot.json
```

**调试场景：**
- LLM loop 卡住/无进展
- 工具调用失败
- Plugin/Skill 加载异常
- Compaction 触发条件分析

**已验证的数据模型（2026-03-15 实测）：**

Session Diagnostics (`/api/diagnostics/<id>`)：
```
schema: bbl.diagnostic.v4
payload:
  config      — bridgeUrl, llmProvider, llmModel, hasLlmApiKey
  summary     — running/stopped/paused, messageCount, stepCount, lastError, sandbox 状态
  timeline    — array(24+) 步骤执行追踪（"步骤2 完成 browser_write_file"）
  recentEvents— array(16+) 内核事件
  eventTypeCounts — step_execute/llm.request/hosted_chat.* 等计数
  sandbox     — summary + trace
  agent       — runtimeState, loopRuns, decisionTrace, conversationTail
  llm         — trace（请求/响应跟踪）
  tools       — trace（工具调用跟踪）
  debug       — stepStreamCount, stepStreamMeta, sandboxRuntimeMeta
```

Debug Snapshots (`/api/debug-snapshots/<id>`)：
```
schema: bbl.debug.export.v1
payload.data:
  runtime     — kernel state, session 列表, 运行中/暂停计数
  diagnostics — summary, timeline, recentEvents（可为空）
payload.target  — sessionId, filters
payload.client  — 客户端信息
```

### L3：全链路自动化

**工具：** `chrome-devtools-mcp-for-extension`（社区 fork，v0.26.3）

**能力：**
- `--loadExtensionsDir` 加载开发版扩展
- 18 个核心自动化工具（截图、点击、导航等）
- 插件架构可扩展自定义 MCP 工具
- 热重载开发支持

**使用方式：**
```json
{
  "chrome-devtools-extension": {
    "command": "npx",
    "args": [
      "-y",
      "chrome-devtools-mcp-for-extension@latest",
      "--loadExtensionsDir=./extension/dist",
      "--ignore-default-chrome-arg=--disable-extensions"
    ]
  }
}
```

**调试场景：**
- 修改代码 → 构建 → 自动加载扩展 → 操作 → 验证
- 自动化回归测试
- 跨版本 A/B 测试

## 实施路线

### Phase 1：快速验证（已完成 ✅）

1. ✅ 配置 `chrome-devtools-mcp` MCP server
2. ✅ 配置 `chrome-devtools-mcp-for-extension`
3. ✅ MCP 协议握手验证（29 个工具可用）
4. ✅ Chrome Beta 147 autoConnect 验证
5. ✅ Bridge API diagnostics 连通验证（`token=my-bridge-token`）
6. ✅ Session Diagnostics 数据模型确认（`bbl.diagnostic.v4`）
7. ✅ Debug Snapshots 数据模型确认（`bbl.debug.export.v1`）
8. ⚠️ 待做：在 Chrome 中启用远程调试 `chrome://inspect/#remote-debugging`

### Phase 2：L2 桥接增强

1. 在 Bridge 中新增 MCP wrapper endpoint，允许 AI agent 通过 MCP 协议调用调试快照 API
2. 或直接在 `chrome-devtools-mcp-for-extension` 中编写自定义 plugin，注入 Bridge 调用能力

### Phase 3：自动化闭环

1. 编写 npm script 一键启动 `chrome-devtools-mcp-for-extension` + 扩展构建 watcher
2. AI agent 全自动执行：代码修改 → `bun run build` → 扩展热重载 → UI 操作 → 诊断检查 → 结果报告

## 推荐的日常使用方式

### 场景 A：SidePanel UI 问题

```
1. 确保 Chrome 已启用远程调试
2. 让 AI 通过 chrome-devtools MCP 截图 SidePanel
3. AI 分析截图，定位 DOM 问题
4. AI 修改代码，构建，再截图验证
```

### 场景 B：Kernel/Loop 异常

```
1. 在 DebugView 面板点击"导出调试日志"
2. AI 通过 Bridge API 下载诊断 JSON
3. AI 用 rg/jq 分析诊断数据
4. 定位根因，修改代码
```

### 场景 C：全链路端到端调试

```
1. AI 通过 chrome-devtools-extension MCP 启动带扩展的 Chrome
2. 自动导航到测试页面
3. 打开 SidePanel，发送测试指令
4. 截图验证 UI + 读取 Bridge 诊断 + Console 日志
5. 综合判断问题根因
```

## 已配置的 MCP Servers

见 `.vscode/mcp.json`：

| Server | 用途 | 连接方式 |
|--------|------|---------|
| `chrome-devtools` | L1：操作用户当前浏览器 | autoConnect（Chrome 146） |
| `chrome-devtools-extension` | L3：加载开发扩展并自动化 | 启动新实例 + loadExtensionsDir |
| `copilot-enhance-3210` | 协议同步 | HTTP MCP |

## CDP 权限限制补充说明

| 限制 | 影响 | 绕过方案 |
|------|------|---------|
| SW 断点/源码调试 | CDP 无法设断点 | L2 内置 diagnostics 系统 |
| chrome.debugger API | 只能调试 HTTP tabs | L1 autoConnect |
| 扩展进程隔离 | CDP 看不到扩展内部状态 | L2 Bridge API 暴露内部状态 |
| Puppeteer --disable-extensions | 默认禁用扩展 | `--ignore-default-chrome-arg` 或 `--autoConnect` |
