# Hook/Plugin 集成现状（2026-02-24）

## 结论

- `main` 已完成 Hook/Plugin/Provider 主体集成并通过当前默认门禁。
- 当前仍有少量旧执行分支，但核心路由已切到 capability/provider（含多 provider 并存与 fail-fast）。
- 仍待收口：`browser_action/snapshot` 的执行仍保留 `runtime-loop` 内联分支，尚未完全下沉到 provider。

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
10. Provider 已支持同 capability 多实例并存路由（`priority + canHandle`）：`extension/src/sw/kernel/tool-provider-registry.ts`。
11. Orchestrator 已移除 legacy constructor adapter 注入（`wireLegacyAdapters` 下线），测试改为显式 `registerToolProvider`。
12. `bash/read/write/edit` 已改为 capability-first 调度（不再强绑 `mode=bridge`），并补内置低优先级 bridge capability provider：`extension/src/sw/kernel/runtime-loop.browser.ts`。
13. `runtime-loop` 已去掉 `script -> cdp` 自动 fallback，执行失败直接返回错误，避免隐式降级掩盖问题。
14. `snapshot/browser_action/browser_verify` 已补内置 capability provider（`cdp`），tool_call 默认走 capability-first 路由，可被插件 provider 覆盖。

## 部分完成（仍有兼容层）

1. `runtime-loop.executeToolCall` 仍保留参数映射/错误归一化逻辑（不是纯 provider plan），但核心执行已走 capability provider。
2. `runtime-loop.executeStep` 仍保留显式 mode 分支（`bridge/cdp/script`），还不是纯 provider-only 主干。
3. Bridge 已支持动态 handler 注册，但默认仍以内置四工具 handler 为主：`bridge/src/dispatcher.ts`。
4. `targetUri` 级对象路由（`workspace://` / `local://` / `plugin://`）尚未在 tool contract 层统一化。

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

## 本轮讨论决议（新增）

1. 去掉开发期兼容 fallback（旧路径收口）：
   - 收敛 `executeToolCall` 双分发兜底；
   - 收敛 alias/legacy 二次解析兜底。
2. Provider 语义修正为“并存路由”，不是“二选一替换”：
   - 同一能力可同时有多个 provider；
   - 路由依据目标对象（例如 `workspace://`、`local://`、`plugin://`）。
3. 失败语义修正：
   - provider 缺失/未就绪 -> 显式报错；
   - 不再用 fallback 掩盖执行顺序或注册时序问题。

## 任务进度（简版）

1. Hook/Plugin 主干：已完成。
2. Tool Contract + Bridge canonical：已完成。
3. 去 fallback（开发期）：进行中。
4. Provider 多路并存（非二选一）：已完成（含 `priority + canHandle` 与回滚语义）。
5. `workspace/local/plugin` 对象路由与契约测试：待开始。

## 验证状态

1. `bun run bdd:validate` 通过。
2. `bun run bdd:gate` 通过（default）。
3. `cd extension && bun run test` 通过（63 tests）。

## 下一阶段建议

1. 先完成去 fallback 收口（fail-fast）。
2. 继续收口 `executeToolCall`（参数 plan/错误模板抽象），减少内联分支体积。
3. 为工具调用补 `targetUri` 路由语义，明确 `workspace/local/plugin` 三类对象边界与测试矩阵。
