# Hook/Plugin 集成现状（2026-02-24）

## 结论

- `main` 已完成 Hook/Plugin/Provider 主体集成并通过当前默认门禁。
- 当前是“新机制主路径 + 兼容层并存”，不是 100% 旧路径下线。

## 已完成

1. Hook Runner 与 `continue/patch/block` 语义落地：`extension/src/sw/kernel/hook-runner.ts`。
2. Orchestrator 已接入 `step.* / tool.* / agent_end.* / compaction.*`：`extension/src/sw/kernel/orchestrator.browser.ts`。
3. Router 已接入 `runtime.route.before/after/error`：`extension/src/sw/kernel/runtime-router.ts`。
4. Plugin Runtime（权限校验、enable/disable、超时隔离、回滚）已落地：`extension/src/sw/kernel/plugin-runtime.ts`。
5. Tool Provider Registry + Capability Policy Registry 已落地：`extension/src/sw/kernel/tool-provider-registry.ts`、`extension/src/sw/kernel/capability-policy.ts`。
6. BDD 契约已补齐：
   - `BHV-AGENT-HOOK-LIFECYCLE`
   - `BHV-CAPABILITY-PROVIDER-ROUTING`
7. LLM Hook 已接入主链路：`llm.before_request` / `llm.after_response` 已在 `extension/src/sw/kernel/runtime-loop.browser.ts::requestLlmWithRetry` 生效。
8. LLM 工具定义已改为 Tool Contract Registry 驱动：`extension/src/sw/kernel/tool-contract-registry.ts` + `extension/src/sw/kernel/runtime-loop.browser.ts`。
9. Bridge 侧已接入工具 registry 路由（含 alias -> canonical）：`bridge/src/tool-registry.ts`、`bridge/src/protocol.ts`、`bridge/src/dispatcher.ts`。

## 部分完成（仍有兼容层）

1. Legacy adapter 仍在注入：`extension/src/sw/kernel/orchestrator.browser.ts` 的 `wireLegacyAdapters(...)`。
2. `runtime-loop` 仍是双轨：
   - 命中 capability provider -> 新路径
   - 未命中 -> mode fallback（bridge/cdp/script）兼容路径
3. Bridge 已支持动态 handler 注册，但默认仍以内置四工具 handler 为主：`bridge/src/dispatcher.ts`。

## 本轮补充

1. 文档索引已更新：`docs/README.md`。
2. Hook 与 Tool 契约文档已加入“实现进度”段落并校正文档/代码偏差：
   - `docs/hook-plugin-architecture.md`
   - `docs/tool-contract-provider-migration.md`
3. 系统提示词已增加“简版任务进度”上下文（每轮动态注入）：`extension/src/sw/kernel/runtime-loop.browser.ts`。
4. LLM 请求链路已支持 Hook 拦截与改写：
   - `llm.before_request`：可 patch 请求体/URL，可 block；
   - `llm.after_response`：可 patch 响应，可 block；
   - Hook block/非法 patch 统一为不可重试错误（避免误触发重试风暴）。
5. Tool Contract Registry 已接入 LLM tools 生成：
   - `BrainOrchestrator.listLlmToolDefinitions()` 作为唯一来源；
   - `runtime-loop` 不再内置静态 `BRAIN_TOOL_DEFS` 常量。
6. 新增测试：
   - `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts`（覆盖 llm hook 时序/patch、registry tools 注入）；
   - `extension/src/sw/kernel/__tests__/tool-contract-registry.browser.test.ts`（覆盖默认契约、override、alias）。
7. Bridge 新增 registry/路由测试：
   - `bridge/test/tool-registry.test.ts`
   - `bridge/test/dispatcher.test.ts`
8. Bridge 新增动态注册能力：
   - `registerToolContract/unregisterToolContract`（`bridge/src/tool-registry.ts`）
   - `registerInvokeToolHandler/unregisterInvokeToolHandler`（`bridge/src/dispatcher.ts`）

## 验证状态

1. `bun run bdd:validate` 通过。
2. `bun run bdd:gate` 通过（default）。
3. `cd extension && bun run test` 通过（54 tests）。

## 下一阶段建议

1. 将 `executeToolCall` 的 legacy `switch` 收敛为 `ToolContractRegistry + Provider` 路由主路径。
2. 让 Bridge 的动态 provider 注册与 `parseInvokeFrame` 完全联动（当前仍依赖进程内 API 注入）。
3. 将 `llm` 相关 Hook 继续扩展到 `title refresh` 路径，统一语义与审计字段。
