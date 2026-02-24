# 工具契约去本机绑定与 Provider 迁移计划（草案 v1）

> 目标：保留 Agent 的核心工具能力，但把“工具契约”从“本机执行实现”中解耦。系统在无本机 Bridge 时也能完整运行（基于浏览器内 workspace provider）。

## 1. 当前问题与目标态

### 1.1 当前问题（代码事实）

1. LLM 工具定义曾硬编码且绑定本机语义（当前已迁移到 Tool Contract Registry）：`extension/src/sw/kernel/tool-contract-registry.ts`、`extension/src/sw/kernel/runtime-loop.browser.ts`。
2. 执行分发硬编码 `switch`：`extension/src/sw/kernel/runtime-loop.browser.ts::executeToolCall`。
3. Bridge 仅支持固定四工具：`bridge/src/types.ts:1`、`bridge/src/protocol.ts:4`。
4. Bridge dispatcher 硬编码分派：`bridge/src/dispatcher.ts:20`。
5. `bash` 语义泄漏底层实现（默认映射 `bash.exec`），不利于多后端能力抽象。

### 1.2 目标态

1. 工具契约描述 `what`（能力），provider 描述 `how`（实现）。
2. 默认 provider 是浏览器内 workspace，不依赖本机 Bridge。
3. Bridge 变成可选 connector provider（`local-host`）。
4. LLM 可继续看到稳定工具能力，但路由后端可替换。

### 1.3 实现进度（截至 2026-02-24）

1. 已完成：extension 侧已落 `ToolProviderRegistry + CapabilityPolicyRegistry + PluginRuntime`，`executeStep` 支持 capability/provider 路由与策略覆盖。
2. 部分完成：`runtime-loop` 已按 capability 路由调用 orchestrator，且 LLM tools 已由 registry 驱动；`executeToolCall` 仍保留 legacy `switch`。
3. 部分完成：Bridge `protocol + dispatcher` 已接入 registry 路由与 alias 解析，但 provider 动态注册与非内置 provider 尚未落地。
4. 未完成：canonical 工具名（`fs.read_text/fs.write_text/fs.patch_text/command.run`）全量迁移、`workspace-opfs/workspace-command` 默认 provider 尚未落地。

## 2. 术语与命名

### 2.1 Canonical 工具命名（建议）

1. `fs.read_text`（alias: `read_file`, `read`）
2. `fs.write_text`（alias: `write_file`, `write`）
3. `fs.patch_text`（alias: `edit_file`, `edit`）
4. `command.run`（alias: `bash`）

说明：

1. `bash` 不是能力名，是某类执行器实现名。
2. `command.run` 更中性，便于映射浏览器内命令、远端执行器、本机 shell。

### 2.2 Command 子命令命名

1. `commandId` canonical：`shell.exec`（alias: `bash.exec`）
2. 对外不暴露“必须是 bash”的实现前提。

## 3. 契约层设计（what）

```ts
export type ToolName = string;
export type Json = Record<string, unknown>;

export interface ToolContract {
  name: ToolName;           // canonical
  version: "v1";
  aliases?: ToolName[];
  argSchema: Json;
  resultSchema?: Json;
  sideEffects: string[];    // e.g. ["workspace.fs.read"]
  defaultProvider: string;  // provider id
}

export interface ToolCallEnvelope {
  requestedTool: string;
  canonicalTool: string;
  args: Json;
  sessionId?: string;
  parentSessionId?: string;
  agentId?: string;
}

export interface ToolResultEnvelope {
  requestedTool: string;
  canonicalTool: string;
  providerId: string;
  ok: boolean;
  data?: Json;
  error?: { code: string; message: string; details?: Json };
}
```

## 4. Provider 层设计（how）

### 4.1 Provider 接口

```ts
export interface ToolProvider {
  id: string;
  capabilities: string[]; // fs.read_text, command.run ...
  invoke(call: ToolCallEnvelope, ctx: ProviderRuntimeContext): Promise<ToolResultEnvelope>;
}

export interface ProviderRuntimeContext {
  sessionId?: string;
  traceId: string;
  config: Record<string, unknown>;
  emit?: (stream: "stdout" | "stderr", chunk: string) => void;
  guards: {
    enforcePolicy: (effect: string, payload: Json) => void;
  };
}
```

### 4.2 首批 provider 规划

1. `workspace-opfs`（默认）
   - 实现 `fs.read_text` / `fs.write_text` / `fs.patch_text`
2. `workspace-command`（默认）
   - 实现 `command.run`，仅允许白名单 `commandId`
3. `bridge-local`（可选）
   - 实现 `fs.*` + `command.run` 的桥接
4. `plugin-xxx`（可选）
   - 第三方插件能力提供者

## 5. Registry 路由层

### 5.1 Registry 接口

```ts
export interface ToolRegistry {
  registerContract(contract: ToolContract): void;
  registerProvider(provider: ToolProvider): void;
  bind(toolName: string, providerId: string): void;
  resolve(requestedTool: string): { contract: ToolContract; provider: ToolProvider; requestedTool: string };
  listContracts(): ToolContract[];
}
```

### 5.2 解析策略

1. 先按 canonical 精确匹配。
2. 再按 alias 匹配 canonical。
3. 若 session 有 provider override，优先 override。
4. 否则走 contract 默认 provider。
5. 再做 policy guard 校验。

## 6. extension 侧迁移方案

### 6.1 改造点

1. LLM tools 已改为 `ToolContractRegistry` 动态输出：
   - `extension/src/sw/kernel/tool-contract-registry.ts`
   - `extension/src/sw/kernel/runtime-loop.browser.ts`
2. 将 `executeToolCall` 从 `switch` 改为 `registry.resolve + provider.invoke`：
   - `extension/src/sw/kernel/runtime-loop.browser.ts:846`
3. `startFromPrompt` 可注入 provider 偏好（session metadata）：
   - `extension/src/sw/kernel/runtime-loop.browser.ts:1461`
4. 在 `runtime-router` 初始化阶段注入 registry：
   - `extension/src/sw/kernel/runtime-router.ts:486`

### 6.2 行为兼容

1. 对 LLM 继续提供 legacy tool 名（alias）。
2. 工具响应补充 `canonicalTool/providerId`，保留现有 `response.data` 结构。
3. `edit_file` 参数兼容双栈：
   - legacy `{old,new}`
   - canonical `{find,replace,all?}`

## 7. bridge 侧迁移方案

### 7.1 改造点

1. `bridge/src/types.ts`
   - `ToolName` 已从 union 扩展为 string，`InvokeRequest` 增加 `canonicalTool`。
2. `bridge/src/protocol.ts`
   - `TOOL_SET` 已改为 registry 校验，支持 alias -> canonical 解析。
3. `bridge/src/dispatcher.ts`
   - 固定 `switch` 已改为 `registry.resolve + handler` 映射。
4. `bridge/src/server.ts`
   - 已输出 `requested tool + canonicalTool`；metrics 摘要仍是内置逻辑，后续再切到 provider/contract 驱动。

### 7.2 兼容策略

1. WS 帧保持 `{type,id,tool,args}` 不变。
2. legacy tool 名通过 alias 自动路由。
3. 增加开关：`BRIDGE_TOOL_ALIASES=true`（默认开），后续可关闭收敛。

## 8. `command.run` 详细语义（替代 bash）

### 8.1 统一参数

```json
{
  "commandId": "shell.exec",
  "argv": ["echo hello"],
  "cwd": "/workspace",
  "timeoutMs": 30000
}
```

### 8.2 语义分层

1. `commandId` 是逻辑能力 ID（策略层判定）。
2. provider 决定如何执行（本地 shell/浏览器内 runner/远端）。
3. 返回统一 envelope（exitCode/stdout/stderr/truncated/timeoutHit）。

### 8.3 安全策略

1. 默认 provider 仅允许低风险 `commandId`。
2. `shell.exec` 属高风险，默认关闭或仅 dev profile 开启。
3. 所有 `command.run` 经过 policy guard + audit。

## 9. 浏览器内 workspace provider 设计

### 9.1 存储层

1. 文件正文：OPFS。
2. 索引与元数据：IDB 或 `chrome.storage.local`。
3. 路径模型：虚拟根 `/workspace/**`，禁止相对越界。

### 9.2 API 映射

1. `fs.read_text` -> OPFS file read（支持 offset/limit）。
2. `fs.write_text` -> OPFS write（mode: overwrite/append/create）。
3. `fs.patch_text` -> 内存 patch + 原子写回。

### 9.3 失败语义

1. 路径不存在：`E_PATH`。
2. 冲突写：`E_CONFLICT`。
3. 配额不足：`E_QUOTA`。
4. 权限不可用：`E_PERMISSION`。

## 10. Hook 与 provider 交叉策略

1. `tool.before_call` 可 patch `args`，但不能改 `canonicalTool`。
2. `tool.after_result` 可 patch `data`，不能把硬失败伪装成功。
3. `execute.after_step` 可补充摘要，不能改写 `verified=false -> true`。

## 11. 分期迁移计划（可执行）

### Phase 0（基线修复）

1. 修复 `edit_file` 参数契约漂移。
2. 补充当前行为快照测试。

验收：

1. `bun run check:brain-bridge`
2. `bun run brain:e2e`

### Phase 1（Bridge 内部 registry 化）

1. 新增 `bridge/src/tool-registry.ts`。
2. 改 dispatcher/protocol 走 registry。
3. 保持对外协议不变。
4. 当前状态：已完成。

验收：

1. `bun run check:brain-bridge`
2. 旧工具名全兼容。

### Phase 2（extension 工具调用 registry 化）

1. LLM tool definitions 动态化（已完成）。
2. `executeToolCall` 去 switch。
3. 增加 `canonicalTool/providerId` 回包。

验收：

1. `bun run brain:e2e`
2. `failed_verify` 语义不回归。

### Phase 3（默认切到浏览器内 provider）

1. 上线 `workspace-opfs` 与 `workspace-command`。
2. Bridge 变可选插件。
3. 无 Bridge 时 4 工具仍可用。

验收：

1. 断开 Bridge 的 e2e 通过。
2. Bridge 模式与无 Bridge 模式行为一致（同契约）。

### Phase 4（门禁与文档收口）

1. 新增 BDD 契约：
   - `BHV-TOOL-CONTRACT-PROVIDER-DECOUPLE`
   - `BHV-COMMAND-RUN-SAFETY-POLICY`
2. 更新 README/Docs/BDD mapping。
3. 可选关闭 legacy alias。

## 12. 回滚策略

1. provider 路由可按开关回退到 legacy switch。
2. 关闭 registry 动态覆盖能力，仅保留默认内置 contracts。
3. 保留 legacy alias 至少两个发布窗口。

## 13. 风险清单

1. MV3 生命周期导致 registry/provider 内存态丢失。
2. OPFS 配额和清理策略影响长期工作区可用性。
3. 兼容期双命名导致 telemetry 分裂。
4. `command.run` 若策略不严，会引入与 `bash` 相同风险。

## 14. 验收口径（DoD）

1. 无 Bridge 模式下：`fs.read_text/fs.write_text/fs.patch_text/command.run` 全链路可用。
2. Bridge 模式下：同契约、同错误码、同审计字段。
3. Hook 参与后：不变量（lease/verify/strict）无退化。
4. BDD gate 覆盖插件与 provider 路由场景。

## 15. 决策日志（本轮）

1. `bash` 不再作为 canonical 能力名，采用 `command.run`。
2. Bridge 不删除，改为可选 connector provider。
3. 工具契约稳定优先，执行后端可插拔。
4. 先 registry 化，再默认 provider 切换，再收敛 alias。
