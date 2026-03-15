# Browser Sandbox Runtime 与文件系统规范化对齐计划

日期：2026-03-13

状态：大部分落地（Phase 0/1/2/3/4/5 完成，Phase 6 待验证）

> **2026-03-15 工作树对齐更新**：
>
> Phase 0（语义冻结）和 Phase 1（SessionSandboxManager）已在工作树中落地：
> - `SessionRuntimeManager<LiveSessionSandbox>` 按 sessionId 复用 sandbox（惰性创建 + 5min idle TTL + LRU 8 上限）
> - dirty tracking + 智能 checkpoint（首次立即 flush，后续 750ms 去抖合并）
> - global namespace 版本同步（skills/plugins 跨 session 变更检测）
>
> Phase 2（路径翻译）结构抽离已完成：
> - `virtual-path-resolver.ts`（240 行）已从 lifo-adapter 抽出
> - lifo-adapter 1,412 → 1,192 行（-16%）
> - `parseVirtualUri()` / `resolveVirtualPath()` / `rewriteCommandVirtualUris()` 等 17 个函数/类型独立模块化
>
> Phase 3（事务一致性）经审计确认已满足：
> - `brain.skill.create` 已有完整 staging + 回滚事务模式
> - VFS namespace 版本跟踪 + 跨 session 同步已上线
> - `brain.skill.uninstall` 已加 VFS 清理容错（orphan-safe）
>
> 此外，`commandRequiresEval()` 按需走 SW 直执行 vs eval-bridge，`fnv1aHash` VFS 去重已上线。

## 1. 背景

当前仓库已经在推进三件本应收敛到同一条主线的事情：

1. browser sandbox / virtual filesystem 的一等公民化
2. `/mem` / `mem://` 语义统一
3. skills、system prompt、聊天输入 `@路径`、`execute_skill_script` 的统一 resolver / materializer 管线

~~但当前实现里，沙盒 runtime 的持久化语义仍然偏离目标态：~~

~~- 现有 `lifo-adapter` 每次调用都会 `Sandbox.create({ persist: false })`~~
~~- 执行后立即 `destroy()`~~
~~- 只把 namespace 文件做 restore / capture~~

**（2026-03-15 注：上述问题已在 Phase 1 中修正，`SessionRuntimeManager` 按 session 复用实例。）**

这意味着现在做到的是“文件快照跨调用恢复”，不是“按 session 持续存在的 browser sandbox runtime”。

这与既有设计文档里“`session sandbox manager`：按 session 维护 runtime 实例”的目标态不一致。

参考：

- `docs/pi-aligned-hybrid-sandbox-implementation-plan-2026-02-26.md`
- `docs/context-reference-filesystem-and-kernel-boundaries-design-2026-03-13.md`

## 2. 本文目标

本文只做一件事：给当前主线一个可执行的、与文件系统规范化兼容的重构计划。

目标：

1. 明确当前哪些持久化层是对的，哪些是错位的
2. 把 browser sandbox 从“临时执行器”改回“session runtime”
3. 把 `/mem`、`mem://`、skills、system prompt、`@路径` 收敛到一套模型
4. 避免继续沿着“局部补丁式持久化”演化

非目标：

1. 不在本文里引入 Legacy/Fallback 双实现
2. 不把 Bridge 变成 planner 或上下文组装器
3. 不重新设计 skills 格式
4. 不改变 `mem://` 作为 canonical URI 的内核语义

## 3. 现状审计

### 3.1 当前已经存在的持久化层

| 层 | 位置 | 当前状态 | 结论 |
| --- | --- | --- | --- |
| Session Meta | `session-store.browser.ts` + `idb-storage.ts` | 持久化到 IDB `sessions` | 正确 |
| Session Entries | `session-store.browser.ts` + `idb-storage.ts` | 持久化到 IDB `entries` | 正确 |
| Step Trace | `orchestrator.browser.ts` + `session-store.browser.ts` | 持久化到 IDB `traces` | 正确 |
| Skill Registry Meta | `skill-registry.ts` | 持久化到 `kv` | 正确 |
| Plugin Registry / UI State | `runtime-router.ts` + `chrome.storage.local` | 持久化 registry / ui state | 正确 |
| Virtual Namespace Files | `browser-unix-runtime/lifo-adapter.ts` | 持久化到 `virtualfs:namespace:*` | 仅适合作为文件快照层 |
| `mem://__bbl` | `lifo-adapter.ts` | 会话内内存态，不落 IDB | 正确 |

### 3.2 当前缺失的持久化层

当前缺失的是：

- `Session Sandbox Runtime`

也就是：

- 同一 session 的 sandbox 实例
- shell/runtime 连续性
- runtime 生命周期管理
- 冷恢复之外的热态复用

这层目前没有真实存在。

### 3.3 当前实现的关键错位

#### 错位 A：把 runtime persistence 做成了 file snapshot persistence

当前 `withSessionSandbox()` 逻辑是：

1. 新建 sandbox
2. restore namespace files
3. 执行任务
4. capture namespace files
5. destroy sandbox

这只保住了“文件树”，没保住“runtime”。

#### 错位 B：`/mem` 语义没有在 shell 层闭环

文件系统规范化设计已经明确：

- 用户面是 `/mem/...`
- 内核 canonical 是 `mem://...`

但当前命令重写只处理 `mem://...`，没有把裸 `/mem/...` 统一映射进 sandbox mount。

结果是：

- 文档心智是 `/mem`
- 内部 shell 实际只认 `mem://`
- 最终用户、模型、命令执行三层语义不一致

#### 错位 C：global namespace 与 registry 存在双事实来源风险

当前 `skills/plugins` 既有 registry metadata，又有 global namespace file snapshot。

如果不收敛 source of truth，后续容易出现：

- registry 成功但文件树残留
- 文件树写入了但 registry 没同步
- reload 后两边状态不一致

#### 错位 D：reset/delete 目前只能清“快照层 + orchestrator 层”

当前 `brain.session.delete` / `brain.storage.reset` 清理是对的，但因为没有 session sandbox manager，所以它们还没清到真正的 sandbox runtime 生命周期层。

## 4. 设计原则

### 4.1 `/mem` 是用户面 mount，`mem://` 是内核 canonical

这一点直接继承现有文件系统规范化设计，不另起炉灶：

- 用户/模型/skills/system prompt/chat composer 看到的是 `/mem/...`
- 内核/协议/调试/测试仍使用 `mem://...`

### 4.2 Browser sandbox 必须是 session runtime，而不是命令执行器

目标态不允许把 browser sandbox 继续理解为：

- “像 host_bash 一样一命令一 shell”

目标态应当是：

- 同一 session 共享同一 sandbox runtime 实例
- runtime 有明确 acquire/release/dispose/reset 生命周期
- 文件快照只承担冷恢复职责

### 4.3 文件系统解析与 prompt 组装必须共用同一管线

以下对象都必须复用同一套 resolve/materialize 流程：

- 聊天输入 `@路径`
- `llmSystemPromptCustom` 中的 `@路径`
- skill `location`
- skill `references/`
- `execute_skill_script` 的路径定位

### 4.4 `mem://__bbl` 继续是会话内临时系统命名空间

它应保持：

- 会话内可复用
- 不进持久层
- 在 session delete / storage reset 时清除

## 5. 目标态架构

### 5.1 三层模型

#### 第一层：Session Runtime

按 `sessionId` 维护的热态 sandbox 实例。

职责：

- shell / runtime 连续性
- cwd / 临时目录 / 解压结果 / runtime cache 延续
- 生命周期管理

#### 第二层：Session Filesystem Snapshot

按 namespace 落到 IDB 的冷恢复副本。

职责：

- service worker reload 后恢复 `mem://`
- runtime 被回收后恢复文件树
- crash/reload 之后不丢 session 文件内容

不负责：

- shell runtime 持续性
- 进程态恢复

#### 第三层：Registry / Session Meta / Trace

单独的结构化事实层：

- skills meta
- plugins meta
- session meta
- entries
- traces

这层不能和文件树快照混为一谈。

### 5.2 新增核心模块

~~建议新增：~~

~~- `extension/src/sw/kernel/browser-unix-runtime/session-sandbox-manager.ts`~~

**（2026-03-15 注：已落地为 `session-runtime-manager.ts`（泛型），lifo-adapter 中实例化为 `SessionRuntimeManager<LiveSessionSandbox>`。）**

核心接口（已实现）：

- `acquire(sessionId)`
- `dispose(sessionId, reason)`
- `disposeAll(reason)`
- `flush(sessionId)`
- `flushAll()`
- `flushIfDue(sessionId, minIntervalMs, reason)`
- `markDirty(sessionId)`
- `reapExpired(reason)`

建议策略：

- 惰性创建
- per-session 串行化
- idle TTL 回收
- LRU 上限控制

## 6. 详细实施计划

### Phase 0：语义冻结 ✅ 已完成

目标：先冻结概念边界，避免实现继续沿错误口径扩散。

工作项：

1. ✅ 明确 `browser sandbox` 的目标态是 session runtime
2. ✅ 明确 `/mem` 是用户面唯一 browser path 语法
3. ✅ 明确 `mem://` 仅是 canonical URI
4. ✅ 明确 namespace snapshot 只是冷恢复层

验收：

- ✅ 文档中不再把"文件快照恢复"表述成"sandbox runtime persistence"

### Phase 1：落地 SessionSandboxManager ✅ 已完成

目标：把 `Sandbox.create({ persist: false })` 每次新建的模型改成按 session 复用。

**实现为** `SessionRuntimeManager<T>`（泛型，`session-runtime-manager.ts`）+ `LiveSessionSandbox`（lifo-adapter.ts 内）。

工作项：

1. ✅ 在 `browser-unix-runtime` 内引入 manager
2. ✅ `withSessionSandbox()` 改为从 manager 获取 runtime
3. ✅ restore 只在 cold start 时执行
4. ✅ capture 改为 dirty tracking + `checkpointSessionSandbox`（首次立即 flush，后续 750ms 去抖）
5. ✅ 支持 `dispose(sessionId)` 和 `disposeAll()`

额外落地能力：
- idle TTL 5min 回收 + LRU 8 session 上限
- global namespace 版本同步（`syncSharedNamespaces()`）
- 完整遥测（`SandboxTelemetrySummary` + 32 条 event tail）

验收：

- ✅ 同 session 两次 `browser_bash`，第二次能看到第一次创建的目录和文件（测试 `persists shell state across invocations`）
- ✅ 不同 session 互不污染（测试 `isolates files by session namespace`）

### Phase 2：统一路径翻译层

### Phase 2：统一路径翻译层 ⏳ 部分完成

目标：把 `/mem/...`、`mem://...`、sandbox unix path 三层映射统一。

工作项：

1. ✅ 从 `lifo-adapter.ts` 抽出路径翻译层为 `virtual-path-resolver.ts`（240 行，lifo-adapter 1,412 → 1,192 行）
2. ✅ shell 中支持裸 `/mem/...` 路径（`parseVirtualUri` + `rewriteCommandVirtualUris` 已实现）
3. ✅ shell 中继续兼容 `mem://...`
4. ✅ `@/mem/...` 解析统一落到 `mem://...`（ISSUE-019 system-prompt-resolver 已部分覆盖）

验收：

- ✅ 聊天输入、prompt、shell 命令都能把 `/mem/...` 指到同一对象（测试 `treats /mem and mem:// as the same sandbox path` 覆盖）

### Phase 3：把 namespace snapshot 降级成冷恢复层 ✅ 已满足

目标：收敛 source of truth，避免双写漂移。

**2026-03-15 审计结论**：当前架构已满足 Phase 3 要求。

工作项：

1. ✅ 保留 `virtualfs:namespace:*` — 现有 `namespaceFiles` / `namespaceVersions` 已承担冷恢复 + 版本同步职责
2. ✅ 职责仅为冷恢复副本 — `captureNamespaceFiles()` 做 dirty flush，`restoreNamespaceFiles()` 做冷恢复
3. ✅ `brain.skill.create` 已走统一事务入口（staging → backup → move → registry → cleanup，失败完整回滚）
4. ✅ `brain.skill.uninstall` 已保护性处理（registry 删除后 VFS 清理失败不抛错，返回 `vfsCleanupError` 字段）

验收：

- ✅ `brain.skill.create`：VFS 写入 + registry 注册原子绑定
- ✅ `brain.storage.reset`：session VFS 清除，global（skills/plugins）+ registry 一致保留
- ✅ `brain.skill.uninstall`：registry 删除 + VFS 文件清理，VFS 失败不影响一致性

### Phase 4：接通 `@路径` / skills / system prompt 共用 resolver ✅ 已满足

目标：文件上下文引用能力正式成为公共基础设施。

**2026-03-15 审计结论**：三条链路已收敛到同一套解析管线。

工作项：

1. ✅ `ChatInput` 的 `@` 走统一 mention gateway（`extractPromptContextRefs(text, "composer_mention")`）
2. ✅ `contextRefs` 贯穿 `panel -> runtime-router -> runtime-loop`（`context-ref-service.browser.ts` 统一 resolve + materialize）
3. ✅ `llmSystemPromptCustom` 支持 `@路径`（`prompt-resolver.browser.ts` 调用 `extractPromptContextRefs(text, "system_prompt")`）
4. ✅ skills references 复用同一 resolver（`skill-content-resolver.ts` → `executeStep()` → `invokeVirtualFrame()`）
5. ✅ 所有 browser 路径最终经过 `virtual-path-resolver.ts` 的 `parseVirtualUri()` + `resolveVirtualPath()`

验收：

- ✅ 普通输入 `@/mem/...` → `classifyContextRefToken()` → `locator: "mem://..."` → `invokeVirtualFrame()`
- ✅ system prompt `@/mem/...` → 同一 `classifyContextRefToken()` → 同一管线
- ✅ skill `location: "mem://..."` → `executeStep()` → `invokeVirtualFrame()`
- ✅ 三条链路 resolve / materialize 结果一致（共用 `context-ref-service` + `filesystem-inspect`）

### Phase 5：升级 session delete / storage reset 语义 ✅ 审计通过

目标：把清理语义从"清快照"升级到"清 runtime + 清快照"。

> **2026-03-15 审计结果**：两条链路均已完整覆盖所有清理层。
>
> `brain.session.delete` 清理链（session-controller.ts）：
> 1. `orchestrator.stop()` → 停止运行态 + 清空队列
> 2. `orchestrator.flushSessionTraceWrites()` → 等待 pending trace 写入
> 3. `removeSessionMeta()` → IDB sessions + entries（cursor 遍历 by-session 索引）
> 4. `removeTraceRecords()` → IDB traces
> 5. `clearVirtualFilesForSession()` → sandboxManager.dispose() + namespace 清理 + 遥测清理
> 6. `removeSessionIndexEntry()` → session 索引
> 7. `orchestrator.evictSessionRuntime()` → 清除 stream/traceWriteTail/runState 内存缓存
>
> `brain.storage.reset` 清理链（storage-controller.ts + storage-reset.browser.ts）：
> 1. `resetSessionStore()` → 清空 IDB sessions/entries/traces/SESSION_INDEX_KEY
> 2. `clearSessionScopedVirtualFiles()` → disposeAll + 所有 session/ephemeral namespace + 遥测
> 3. `initSessionIndex()` → 重建空索引
> 4. `orchestrator.resetRuntimeState()` → 清空所有内存 Maps
>
> 测试覆盖：6 个测试用例覆盖 delete/reset 后的 VFS 读取（throws "virtual file not found"）、
> step stream cache 清空、trace 删除、session 列表移除。

`brain.session.delete` 必须清：

- ✅ session meta
- ✅ entries
- ✅ traces
- ✅ orchestrator runtime state
- ✅ live sandbox runtime
- ✅ session namespace snapshot
- ✅ session `__bbl` ephemeral namespace

`brain.storage.reset` 必须清：

- ✅ 所有 session/meta/entries/traces
- ✅ 所有 live sandbox runtime
- ✅ 所有 namespace snapshot
- ✅ 所有 ephemeral namespace

验收：

- ✅ delete/reset 后重新 acquire session，不会读到旧 runtime 状态

### Phase 6：planner / tool policy / done heuristic 收口

目标：避免“runtime 修好了，但模型仍按旧心智乱用”。

工作项：

1. skill 安装类任务默认优先 `host_bash + create_skill`
2. `browser_bash` 不再被鼓励承担完整宿主 shell 角色
3. skill 安装完成态明确收口：
   - `create_skill.ok`
   - `load_skill.ok` 或 `list_skills` 出现目标 skill
4. 完成后允许 loop 直接结束，不再被 `browser_proof_guard` 拖进 `progress_uncertain`

验收：

- “安装第三方 skill” 任务不再在 `browser_bash` 上反复试错
- 安装成功后正常收口

## 7. 测试计划

### 7.1 browser sandbox runtime

新增或改造测试：

1. 同 session 两次 `browser_bash` 目录连续可见
2. 同 session shell 临时文件连续可见
3. session dispose 后 runtime 消失，但 snapshot 可冷恢复
4. 不同 session 隔离

### 7.2 `/mem` / `mem://` 统一

新增测试：

1. `@/mem/...` -> `mem://...`
2. shell `/mem/...` -> sandbox unix path
3. `mem://...` 与 `/mem/...` 指向同一对象

### 7.3 reset / delete

新增测试：

1. `brain.session.delete` 真正销毁 live sandbox runtime
2. `brain.storage.reset` 真正销毁全部 live sandbox runtime
3. `mem://__bbl` 与 session namespace 一起清空

### 7.4 context ref / prompt / skills

新增测试：

1. system prompt 中 `@/mem/...`
2. skill reference 中 `@/mem/...`
3. 聊天输入 `@/mem/...`
4. 三条链路 materialize 结果一致

## 8. 迁移策略

### 8.1 不做 Legacy/Fallback 双轨

本项目实现口径不考虑 Legacy/Fallback。

因此迁移策略必须是：

1. 先引入目标态 manager
2. 再逐步替换旧调用路径
3. 不长期维护“per-invocation sandbox”与“session runtime sandbox”双实现

### 8.2 数据兼容策略

保留当前 `virtualfs:namespace:*` 键格式，先作为冷恢复层继续读取。

原则：

1. 不先做 schema 大迁移
2. 先把 runtime manager 跑通
3. 等新模型稳定后再评估是否需要升级 snapshot schema

## 9. 风险与约束

### 9.1 service worker 生命周期

即使引入 session runtime manager，Chrome MV3 service worker 仍会被系统挂起。

所以目标态不能假设：

- runtime 永不丢失

正确模型必须是：

- 热态尽量复用
- 冷态依赖 snapshot 恢复

### 9.2 内存上限

live sandbox runtime 不能无限增长。

必须有：

- TTL
- LRU
- 最大 live session 数量

### 9.3 第三方 sandbox 能力边界

就算 runtime 持久化了，也不代表 `browser_bash` 自动变成完整宿主 shell。

仍需保留能力边界：

- sandbox 适合 browser-native / mem-native 动作
- host 适合真实 OS 工具链与系统依赖

## 10. 自审结论

这份计划与当前正在推进的文件系统规范化主线是对齐的，不冲突。

理由：

1. 它没有否定 `/mem` 作为用户面语法，反而把 `/mem` 补成真正可执行的 mount 语义。
2. 它没有否定 `mem://` canonical，反而把 `mem://` 从“用户暴露语法”收口回内核层。
3. 它没有另起一套 skills / prompt / `@路径` 机制，而是要求三者复用同一 resolver/materializer。
4. 它没有把 namespace snapshot 删掉，而是把它放回“冷恢复层”的正确位置。
5. 它没有引入 Legacy/Fallback 双轨，而是直接向 session runtime 目标态收敛。

本文的核心判断只有一句：

- 当前仓库已经有“session/meta/message/trace/registry/file snapshot”的持久化。
- 但还没有“session sandbox runtime”的持久化。
- 后续重构应围绕这个缺口展开，而不是继续在 file snapshot 层堆补丁。
