# 四基础 Tool Call 通用化拆层调研（2026-02-25）

## 背景与目标
- 四个基础工具：`read` / `write` / `edit` / `bash`
- 历史：先只走本机 bridge；后扩展到浏览器插件环境；目标是把“环境差异层”抽成通用执行层
- 结论先行：**拆层主体已完成（合同/能力/提供者/执行面），但“声明到执行自动装配”还没完全闭环**

## 1. 现在的真实执行链路（已通）

### 1.1 LLM 工具定义来源
- LLM 工具定义来自工具合同注册表（非硬编码数组直塞）。
  - `extension/src/sw/kernel/orchestrator.browser.ts:179`
  - `extension/src/sw/kernel/tool-contract-registry.ts:30`

### 1.2 tool_call 解析到工具计划
- runtime 解析 tool_call，按工具名构建执行计划。
  - `extension/src/sw/kernel/runtime-loop.browser.ts:2292`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:2332`

### 1.3 四基础工具映射为 capability
- `bash/read_file/write_file/edit_file` 统一映射为 capability：
  - `process.exec` / `fs.read` / `fs.write` / `fs.edit`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:108`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:118`

### 1.4 capability provider 路由执行
- `executeStep -> orchestrator.executeStep -> toolProviders.invoke`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1886`
  - `extension/src/sw/kernel/orchestrator.browser.ts:507`
  - `extension/src/sw/kernel/orchestrator.browser.ts:474`
  - `extension/src/sw/kernel/tool-provider-registry.ts:169`

### 1.5 bridge 平面执行（本机）
- runtime infra 发 WS `invoke` 帧到 bridge：
  - `extension/src/sw/kernel/runtime-infra.browser.ts:523`
  - `extension/src/sw/kernel/runtime-infra.browser.ts:537`
  - `extension/src/sw/kernel/runtime-infra.browser.ts:562`
- bridge 只收 `invoke`，解析 canonical tool 后分发：
  - `bridge/src/protocol.ts:27`
  - `bridge/src/protocol.ts:39`
  - `bridge/src/server.ts:342`
  - `bridge/src/dispatcher.ts:25`
  - `bridge/src/dispatcher.ts:75`

### 1.6 bridge 内部四工具执行器
- builtin handler 明确是 `read/write/edit/bash` 四个：
  - `bridge/src/dispatcher.ts:25`
  - `bridge/src/dispatcher.ts:26`
  - `bridge/src/dispatcher.ts:27`
  - `bridge/src/dispatcher.ts:28`

## 2. “本机/浏览器虚拟FS环境”如何并存（已通）

### 2.1 单控制平面
- 同一个 SW runtime-router 同时挂 runtime loop 与 infra handler：
  - `extension/src/sw/kernel/runtime-router.ts:1259`
  - `extension/src/sw/kernel/runtime-router.ts:1261`

### 2.2 四工具的双执行平面（你关注的点）
- bridge provider（默认，优先级低）：把 `fs.read/fs.write/fs.edit/process.exec` 转成 WS `invoke` 给本机 bridge。
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1652`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1656`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1659`
- 非 bridge provider（插件可注入）：可以覆盖 `fs.read/fs.write/fs.edit`，直接在扩展侧执行（例如虚拟FS）。
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1937`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1952`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1986`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:2009`

### 2.3 已有证据（不是 CDP 自动化）
- 测试已验证：`read_file` 的 tool_call 可以优先走插件注入的 `fs.read` provider，且 mode 为 `script`，不是 bridge。
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:1011`
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:1026`
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:1128`
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:1129`
- 测试还验证了虚拟 capability（`fs.virtual.read`）可按 URI 路由到不同 provider。
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:984`
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:987`
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:995`
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:1000`
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:1008`

### 2.4 说明
- 这意味着四工具已具备“同一语义，双后端”能力：默认本机 bridge，必要时切到浏览器侧虚拟FS provider。
- 但当前生产代码未看到内置的浏览器虚拟FS provider 对 `fs.read/fs.write/fs.edit` 做覆盖注册（测试里有示例插件，生产未启用）。
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1652`
  - `extension/src/sw/kernel/runtime-loop.browser.ts:1656`
  - `extension/src/sw/kernel/capability-policy.ts:29`

## 3. 这次改造到底完成了什么

### 3.1 完成项（确认）
1. 合同层：支持别名与 override（两端都有）
- runtime 侧：`extension/src/sw/kernel/tool-contract-registry.ts:206`
- bridge 侧：`bridge/src/tool-registry.ts:10`

2. 路由层：支持 capability provider、优先级、canHandle
- `extension/src/sw/kernel/tool-provider-registry.ts:39`
- `extension/src/sw/kernel/tool-provider-registry.ts:72`

3. 插件扩展层：可注入 provider/hook/policy，支持 enable/disable 回滚
- `extension/src/sw/kernel/plugin-runtime.ts:132`
- `extension/src/sw/kernel/plugin-runtime.ts:311`

4. 运行层：本机 bridge 与浏览器 cdp/script 可并存
- `extension/src/sw/kernel/runtime-router.ts:1288`
- `extension/src/sw/kernel/runtime-infra.browser.ts:1263`

### 3.2 未完成项（对 Skills 很关键）
1. runtime 可执行工具仍有硬编码白名单 + switch
- `extension/src/sw/kernel/runtime-loop.browser.ts:152`
- `extension/src/sw/kernel/runtime-loop.browser.ts:2309`
- `extension/src/sw/kernel/runtime-loop.browser.ts:2337`

2. 新注册工具合同会被 LLM 请求过滤
- 过滤逻辑：`extension/src/sw/kernel/runtime-loop.browser.ts:2731`
- 测试证明 `workspace_ls` 不会进入 tools：
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:2210`
  - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts:2284`

3. runtime-router 只有 debug 查看，没有插件/skills 注册控制面 API
- `extension/src/sw/kernel/runtime-router.ts:1246`
- `extension/src/sw/kernel/runtime-router.ts:1256`

4. capability policy 有字段未充分进主执行决策
- 定义：`extension/src/sw/kernel/capability-policy.ts:5`
- 当前执行主路径主要使用 verify/lease：`extension/src/sw/kernel/runtime-loop.browser.ts:1839`

## 4. 对 Skills 的直接影响（高相关）

### 4.1 可直接复用
- `ToolProviderRegistry`：做 skill capability 路由最合适
- `PluginRuntime`：做 skill 生命周期挂载（enable/disable/rollback）
- bridge `registerInvokeToolHandler`：进程内扩展 bridge 执行器
  - `bridge/src/dispatcher.ts:43`

### 4.2 必补改造
1. 合同层加“执行绑定”信息（例如 `execution: { capability, action, mode? }`）
2. runtime-loop 去掉“只靠工具名白名单”的主过滤，改为“合同 + provider 可用性”
3. runtime-router 增加技能控制面 API（注册/启停/卸载/查询）
4. panel 输入透传 skill 选择上下文到 session metadata（供 system context 注入）

## 5. 第一性判断
- 你们不是缺“执行器能力”，而是缺“声明 -> 执行”的统一映射层。
- 只做 skills 文件系统或只注册 contract 都不够；必须补齐运行时装配链路，否则会出现：
  - LLM 看不到技能工具
  - 看到了但 `E_TOOL_UNSUPPORTED`
  - 或走到错误执行平面
