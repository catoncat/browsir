# MCP Host-First / Remote-Ready MVP 设计

> 目标：在不破坏“脑在浏览器侧，宿主只做执行代理”架构铁律的前提下，为 BBL 增加 MCP tool 接入能力。

---

## 1. 问题定义

当前 BBL 的外部能力接入主要有两类：

- 浏览器内置工具：由扩展侧静态注册，走 `script/cdp/bridge` 三种执行通道
- 宿主侧四工具：由本地 Bridge 提供 `read/write/edit/bash` 执行代理

MCP 的价值不在于再引入一套“代理脑”，而在于让 BBL 能消费外部现成工具生态。这里要解决的是：

1. 如何让模型看见 MCP tool，并像调用内置工具一样调用它们
2. 如何同时支持本地 `host` MCP server 和远程 `remote` MCP server
3. 如何让 secret 留在 host，而不是落到浏览器存储
4. 如何在 MVP 阶段保持实现简单、可验证、可演进

---

## 2. 设计原则

### 2.1 架构原则

- **脑仍在浏览器侧**：server 注册表、工具暴露、调度决策、loop 编排都在扩展 SW
- **Bridge 只做执行代理**：负责 transport、连接、鉴权、缓存、调用，不参与任务决策
- **不引入第二套 tool runtime**：优先复用现有 `ToolContract + CapabilityProvider + custom.invoke`

### 2.2 MVP 原则

- **只做 MCP tools**
- **不做** resources / prompts / sampling / elicitation
- **host-first**：先打通本地 `stdio`
- **remote-ready**：接口与存储设计一次到位，第二阶段补 `Streamable HTTP`

### 2.3 安全原则

- secret 不进入 extension storage
- extension 只保存无密钥的 server metadata
- 当前 MVP 不支持 bearer token / OAuth client secret / 自定义 header 注入
- 远程 server URL 需要 host 白名单约束

---

## 3. 为什么不新增 `mcp` mode

BBL 当前已经有适合动态外部工具的基础设施：

- `ToolContract.execution` 可以声明 `capability + mode + action`
- `loop-tool-dispatch` 已支持 `custom.invoke`
- `ToolProviderRegistry` 已支持 capability provider

因此第一性原理上不需要为了 MCP 再新增一套 runtime mode。  
MCP 更像一种“外部 tool provider”，不是新的编排平面。

结论：

- **新增 capability：`mcp.call`**
- **复用现有 `bridge` mode**
- **MCP tool 在 LLM 面前表现为普通 function tool**

---

## 4. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Extension SW                                               │
│  - MCP server registry                                     │
│  - 动态 tool materializer                                  │
│  - ToolContract: mcp__<serverId>__<toolName>               │
│  - capability provider: mcp.call                           │
└───────────────────────┬─────────────────────────────────────┘
                        │ bridge.invoke
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Bridge                                                     │
│  - MCP client registry                                     │
│  - stdio / streamable-http transport                       │
│  - auth/secret store                                       │
│  - tool discovery cache                                    │
│  - invoke handlers: mcp_list_tools / mcp_call_tool         │
└───────────────┬───────────────────────────────┬─────────────┘
                │                               │
                ▼                               ▼
      Local MCP Server (stdio)       Remote MCP Server (HTTP)
```

---

## 5. 核心决策

### 5.1 工具暴露方式：展开为独立动态工具

不采用单一 `mcp.call(serverId, toolName, args)` 暴露给 LLM。  
而是将每个 MCP tool 物化为独立 function：

- `mcp__filesystem__read_file`
- `mcp__github__create_issue`

原因：

- 模型选择工具时更稳定
- schema 可直接挂到 function definition
- 调试与诊断粒度更细
- 和现有 `ToolContract` 机制天然兼容

### 5.2 传输选型

- 本地 host：`StdioClientTransport`
- 远程 remote：`StreamableHTTPClientTransport`

说明：

- remote 不按旧 SSE-only 方案实现
- 以 MCP 当前官方传输规范为准

### 5.3 Secret 放置

- 当前 MVP 不做 secret store
- 后续如果要支持鉴权，必须先补 host secret resolver，再开放配置入口

### 5.4 生命周期

- SW 启动或配置变更后触发 `mcp_list_tools`
- tool schema 变更时重建对应动态 tool contracts
- Bridge 维护 client 连接池与 tool cache

---

## 6. 数据模型

### 6.1 Extension 侧

```ts
type McpServerTransport = "stdio" | "streamable-http";

interface McpServerConfig {
  id: string;
  label: string;
  enabled: boolean;
  transport: McpServerTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
}
```

```ts
interface McpDiscoveredTool {
  serverId: string;
  toolName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

### 6.2 Bridge 侧

```ts
interface McpServerRuntimeState {
  serverId: string;
  connected: boolean;
  transport: "stdio" | "streamable-http";
  toolsVersion: string;
  lastSyncAt?: string;
  lastError?: string;
}
```

---

## 7. 命名与协议

### 7.1 Capability

- `mcp.call`

### 7.2 Bridge invoke tools

- `mcp_list_tools`
- `mcp_call_tool`

后续可扩展：

- `mcp_get_server_status`
- `mcp_refresh_server`

### 7.3 动态 tool name

格式：

- `mcp__<serverId>__<toolName>`

要求：

- `serverId` 与 `toolName` 都做安全规范化
- 仅允许 `[a-z0-9_]+`

---

## 8. 执行流

### 8.1 Tool 发现

1. SidePanel 保存 MCP server 配置
2. SW 将配置同步给 Bridge
3. SW 调用 `mcp_list_tools`
4. Bridge 返回 `serverId + tool schema`
5. SW 物化为动态 `ToolContract`

### 8.2 Tool 调用

1. LLM 选择 `mcp__github__create_issue`
2. `loop-tool-dispatch` 读取 contract.execution
3. 路由到 `custom.invoke`
4. 进入 capability `mcp.call`
5. provider 通过 `bridge.invoke` 调 `mcp_call_tool`
6. Bridge 执行真实 MCP tool
7. 结果作为普通 tool result 返回 loop

---

## 9. 文件落点

### 9.1 Extension

- `extension/src/sw/kernel/mcp-registry.ts`
  - MCP server 配置与 discovered tools 持久化
- `extension/src/sw/kernel/mcp-tool-materializer.ts`
  - 将 discovered tools 转换为 `ToolContract`
- `extension/src/sw/kernel/runtime-loop.browser.ts`
  - 注册 `mcp.call` capability provider
- `extension/src/sw/kernel/orchestrator.browser.ts`
  - 暴露必要的 registry 接线
- `extension/src/panel/**`
  - 后续补 MCP 配置 UI

### 9.2 Bridge

- `bridge/src/mcp/types.ts`
- `bridge/src/mcp/client-registry.ts`
- `bridge/src/mcp/secret-store.ts`
- `bridge/src/mcp/tool-schema.ts`
- `bridge/src/mcp/clients/stdio-client.ts`
- `bridge/src/mcp/clients/streamable-http-client.ts`

以及：

- `bridge/src/dispatcher.ts`
- `bridge/src/tool-registry.ts`
- `bridge/src/protocol.ts`

---

## 10. 分阶段实施

### Phase 1：Host-only MVP

范围：

- 支持本地 `stdio` MCP server
- 打通 `mcp_list_tools` / `mcp_call_tool`
- 动态 tool contracts 注册
- 基础错误与诊断输出

不做：

- remote HTTP
- OAuth
- MCP settings UI
- 断线重连优化

验收标准：

- 能注册一个本地 MCP server
- LLM 能看到其 tools
- 能成功调用至少一个 MCP tool

### Phase 2：Remote-ready 落地

范围：

- `Streamable HTTP` transport
- bearer token / OAuth client credentials
- URL allowlist
- health/status 接口

### Phase 3：产品化

范围：

- Panel MCP 配置页
- per-server enable/disable
- tool sync 状态与错误面板
- diagnostics / debug snapshot 暴露 MCP 状态

### 10.1 MCP 设置页 UI 口径

这不是 debug panel，也不是开发者控制台。  
MCP 在 Panel 里的形态应当是**系统设置里的连接能力管理**。

#### 界面类型

- `settings`

#### 首要任务

- `录入`：把一个本地或远程 MCP server 配进系统
- `决策`：决定哪些 server 启用、哪些先关闭

不把“调试”“查看原始 payload”“手工发请求”作为首要任务。

#### 信息优先级

最大：

- MCP server 列表
- 每个 server 的名称、启用状态、连接方式

次之：

- `stdio` 的 command / args / cwd
- `streamable-http` 的 url

默认收起：

- 诊断细节

#### 交互密度

- `紧凑`
- 桌面优先，但保持移动端可滚动和可点按
- 列表先扫一眼，编辑按需展开

#### 视觉约束

- 延续现有 Panel 视觉语言，不另起一套“开发工具”皮肤
- 字体继续使用产品主界面的默认字体，不引入等宽大面积排版
- 颜色以中性底色 + 单一强调色为主，不使用荧光告警感配色
- 允许 section 级容器，但**不要把每个字段都做成一张独立 card**
- server 项优先用“列表项 / inset panel”而不是漂浮调试卡片
- 间距以 `8/12/16` 为主，边界清晰但克制

#### 动效目的

- 只允许用于 `展开/收起`、`保存反馈`、`启用状态切换`
- 不做装饰性动画
- 不做类似终端输出、日志流动、脉冲扫描的视觉暗示

#### 文案约束

- 面向普通产品设置，而不是面向 SDK 调试
- 避免出现 JSON、payload、raw request、debug dump 一类入口
- 优先使用“名称 / 启用 / 连接方式 / 工作目录 / 服务地址”这类产品化词汇

---

## 11. 测试策略

### 11.1 Bridge

- `mcp_list_tools` 成功/失败
- `mcp_call_tool` 成功/失败/timeout
- 非法 serverId / 非法 toolName / schema 异常
- secret 解引用失败

### 11.2 Extension

- 动态 tool contract 注册/替换/卸载
- `custom.invoke -> mcp.call` 路由正确
- tool 名规范化
- Bridge 返回 schema 更新后重建 tool surface

### 11.3 集成

- 本地 mock MCP server 端到端调用
- 至少一条 runtime loop 集成测试覆盖真实调用链

---

## 12. 非目标

以下不属于本轮：

- 让 Bridge 自己成为 MCP host/agent
- 在浏览器侧直接维持远程 MCP socket/HTTP session
- resources/prompts 与 tool surface 混做一版
- 为 MCP 单独发明一套 loop/permission/plan 系统

---

## 13. 决策总结

本方案的关键不是“把 MCP 塞进系统”，而是把 MCP 降格为 BBL 现有工具体系的一类外部 provider：

- 浏览器侧仍拥有 tool surface 与调度权
- Bridge 只拥有 transport 与 secret
- MVP 先聚焦 `tools`
- 先 `stdio`，后 `streamable-http`
- 不新增 `mcp` mode，只新增 `mcp.call capability`

这条路线改动面最小，和现有 Kernel/Bridge 分层最一致，也最容易做出可验证的第一版。
