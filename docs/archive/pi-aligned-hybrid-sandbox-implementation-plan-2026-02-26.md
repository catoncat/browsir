# Browser Unix Sandbox（保留 Bridge）实施计划（PI-MONO 对齐）

日期：2026-02-26  
状态：Approved（开发中）  
作者：Codex + 项目 Owner

## 1. 背景与目标

当前产品核心价值不变：`Host Bridge` 提供本机无限能力（读写项目、执行命令、操控电脑）。  
新增目标：提供 `Browser Unix Sandbox`，让“无需本地安装/本地权限”的用户可直接在扩展内完成文件与命令任务。

本次改造是 **新增执行平面**，不是替换 Bridge。

## 2. 边界（强约束）

### 2.1 In Scope

1. 保留并继续增强 `host_* -> bridge` 路径。
2. 新增 `browser_* -> sandbox` 路径（Unix 风格运行环境）。
3. 三平面并存：`bridge` / `sandbox` / `cdp`。
4. 执行路由显式可观测（step stream 里可看到 mode/capability/provider）。

### 2.2 Out of Scope（本期不做）

1. 不删除 Bridge。
2. 不删除 `host_*` 工具。
3. 不修改 `script->cdp` 语义。
4. 不修改 `rule_planner fallback` 语义。
5. 不在本期开放 browser 侧 `node/pkg/npm`。

## 3. PI-MONO 对齐原则

## 3.1 Provider-First（对齐 model/provider 抽象）

对齐参考：
- `~/work/repos/_research/pi-mono/packages/coding-agent/src/core/model-registry.ts`
- `~/work/repos/_research/pi-mono/packages/coding-agent/docs/custom-provider.md`

执行面抽象为 Provider，不把 transport（ws/local/idb）暴露到上层策略：

1. `executor.bridge`（host 本地能力）
2. `executor.sandbox`（browser unix 能力）
3. `executor.cdp`（浏览器页面动作能力）

## 3.2 Message Transform Invariants（对齐跨 provider 消息稳定性）

对齐参考：
- `~/work/repos/_research/pi-mono/packages/ai/src/providers/transform-messages.ts`

保持并强化现有 `extension/src/sw/kernel/llm-message-model.browser.ts` 约束：

1. tool_call_id 规范化。
2. error/aborted assistant 消息不重放。
3. orphan tool_result 自动补齐对应 assistant tool_call。

## 3.3 Capability Routing（对齐能力契约与执行对象解耦）

工具规划层只产出 `capability + action + args`，由 provider registry 决定执行器，不把“host 或 browser”硬编码进高层意图。

## 4. 目标架构

## 4.1 执行路由矩阵

1. `host_read_file/host_write_file/host_edit_file/host_bash` -> Bridge
2. `browser_read_file/browser_write_file/browser_edit_file/browser_bash` -> Sandbox
3. `search_elements/click/fill/.../browser_verify` -> CDP

失败策略：
1. 同平面内可重试（参数重试/短暂错误重试）。
2. 禁止跨平面静默回退（host 失败不自动 browser，browser 失败不自动 host）。

## 4.2 Browser Unix Runtime 分层

1. `lifo-adapter`：统一外部 API，隔离第三方库升级影响。
2. `session sandbox manager`：按 session 维护 runtime 实例。
3. `path/runtime translator`：`mem://` / `vfs://` <-> unix path。
4. `command policy`：白名单命令与参数规则。
5. `persistence`：IDB 持久化与恢复。

## 5. 实施阶段

## 5.1 P1（本次起步）

目标：接入依赖 + 建立可运行 adapter 骨架，不影响现有 Bridge 主链。

任务：
1. `extension/package.json` 引入并锁定 `@lifo-sh/core`。
2. 新建 `extension/src/sw/kernel/browser-unix-runtime/lifo-adapter.ts`。
3. 新建类型定义与最小单测（构造/路由/基础命令）。
4. 先不切主路径；以 feature flag/调用点预留方式接线。

验收：
1. `cd extension && bun run build` 通过。
2. `cd extension && bun run test` 至少新增测试通过。

## 5.2 P2（接线）

目标：`browser_*` 实际走 sandbox provider。

任务：
1. 在 `runtime-loop.browser.ts` 注册 `executor.sandbox` capability provider。
2. 在 `virtual-fs.browser.ts` 迁移到 adapter（或双轨桥接）。
3. step stream 补充 `providerId=executor.sandbox` 可观测字段。

## 5.3 P3（策略）

目标：工具规划与提示词明确双执行面。

任务：
1. 保持 host/browser split tools 并存。
2. 默认优先 browser（零安装场景），用户明确本地任务时使用 host。
3. 维持 `script->cdp`、`rule_planner fallback` 原语义不变。

## 5.4 P4（BDD/门禁）

目标：新增 sandbox 能力证明，不破坏现有 bridge 契约。

任务：
1. 新增 BHV：browser sandbox 文件与命令闭环。
2. 新增 feature：bridge 断开时 browser_* 仍可完成任务。
3. gate 增加“跨平面静默回退禁止”检测用例。

## 5.5 P5（后续可选）

目标：逐步开放 browser `node/pkg/npm`。

策略：
1. M1: node-lite + pkg（纯 JS 包）。
2. M2: npm-lite（scripts/bin/lockfile 子集）。
3. M3: full npm（必要时 offscreen 重运行时）。

## 6. 风险与控制

1. 风险：第三方库升级引发 API 变更。
- 控制：adapter 隔离 + 锁版本 + contract test。

2. 风险：MV3 生命周期导致 runtime 丢失。
- 控制：session 级恢复策略 + 写后持久化 + 可恢复错误码。

3. 风险：跨平面隐式回退导致行为不可解释。
- 控制：路由硬约束 + 失败显式 + BDD 门禁。

## 7. 验收标准（全局）

1. Bridge 可用时：`host_*` 能执行本机操作。
2. Bridge 不可用时：`browser_*` 在 sandbox 可独立完成。
3. 三平面无隐式跨面回退。
4. 构建与测试通过：
- `cd extension && bun run build`
- `cd extension && bun run test`
- `bun run bdd:validate`
- `bun run bdd:gate`

## 8. 立即执行清单（P1）

1. 锁定 `@lifo-sh/core` 版本并安装。
2. 新增 `lifo-adapter` 与最小调用接口：
- `init(sessionId)`
- `invoke(frame, sessionId)`
- `dispose(sessionId)`
3. 增加最小测试与构建验证。

