---
id: ISSUE-024
title: "Sandbox Runtime 文件系统规范化 — Phase 2-5 剩余工作"
status: open
priority: p2
source: sandbox-runtime-filesystem-normalization-plan-2026-03-13
created: 2026-03-15
assignee: unassigned
kind: epic
depends_on: []
write_scope:
  - extension/src/sw/kernel/browser-unix-runtime/lifo-adapter.ts
  - extension/src/sw/kernel/browser-unix-runtime/session-runtime-manager.ts
  - extension/src/sw/kernel/browser-unix-runtime/virtual-path-resolver.ts
  - extension/src/sw/kernel/prompt/
  - extension/src/sw/kernel/skill-registry.ts
  - extension/src/sw/kernel/plugin-runtime.ts
tags:
  - epic
  - sandbox
  - virtual-filesystem
  - refactor
---

# ISSUE-024: Sandbox Runtime 文件系统规范化 — Phase 2-5 剩余工作

## 背景

`sandbox-runtime-filesystem-normalization-plan-2026-03-13.md` 定义了 5 个 Phase。
当前工作树中 Phase 0（语义冻结）和 Phase 1（SessionSandboxManager）已全部落地，Phase 2（路径翻译层）功能已实现但结构未清理。

本 issue 跟踪剩余 3.5 个 Phase 的工作。

## 当前已落地

| Phase | 状态 | 关键产物 |
|-------|------|---------|
| Phase 0: 语义冻结 | ✅ 完成 | 文档概念对齐 |
| Phase 1: SessionSandboxManager | ✅ 完成 | `session-runtime-manager.ts` + `LiveSessionSandbox` + dirty tracking + checkpoint 去抖 |
| Phase 2: 路径翻译 | ✅ 完成 | `virtual-path-resolver.ts`（240 行）从 lifo-adapter 抽出，lifo-adapter 1,412 → 1,192 行 |

## 剩余工作

### Slice A: lifo-adapter 路径翻译层抽离（Phase 2 收口）✅ 已完成

从 `lifo-adapter.ts`（1,412 行）抽出路径翻译逻辑为独立模块 `virtual-path-resolver.ts`（240 行）：
- `parseVirtualUri()`
- `resolveVirtualPath()`
- `rewriteCommandVirtualUris()`
- `unixPathToVirtualUri()`
- `normalizeRelativePath()`
- 相关类型 `VirtualNamespaceDescriptor`

**预期效果**：lifo-adapter 降至 ~1,100 行，路径翻译可被 prompt resolver / skill loader 复用。

### Slice B: Registry + 文件树事务一致性（Phase 3）✅ 审计通过

经深度审计（skill-registry / plugin-runtime / skill-controller / skill-create / storage-reset / lifo-adapter），Phase 3 在当前架构中已满足：

- `brain.skill.create` 已有完整 staging → backup → move → registry → cleanup 事务，失败有完整回滚
- VFS namespace 版本跟踪 + 跨 session 同步已上线（`markNamespaceChanged()` + `syncSharedNamespaces()`）
- `brain.storage.reset` 两侧一致保留（session VFS 清除、global 保留、registry 保留）
- `brain.skill.uninstall` 已加保护性 VFS 清理（失败不抛错，返回 `vfsCleanupError` 字段）

### Slice C: @路径 / skills / prompt 共用 resolver（Phase 4）✅ 审计通过

经审计（context-ref / context-ref-service / filesystem-inspect / prompt-resolver / skill-content-resolver / runtime-loop），Phase 4 三条链路已收敛：

- 聊天 `@/mem/...` 和 system prompt `@/mem/...` 共用 `extractPromptContextRefs()` → `classifyContextRefToken()` → `locator: "mem://..."`
- skill location 直接使用 `mem://...` → `executeStep()` → `invokeVirtualFrame()`
- 所有 browser 路径最终经过 `virtual-path-resolver.ts` 的 `parseVirtualUri()` + `resolveVirtualPath()`
- `@mem://...` 被正确拒绝为 `browser_canonical_invalid`，指引用户使用 `@/mem/...`

### Slice D: session delete / reset 语义闭环（Phase 5）✅ 审计通过

经深度审计（session-controller / storage-controller / storage-reset / orchestrator / lifo-adapter / session-runtime-manager），Phase 5 两条清理链路均已完整覆盖：

**`brain.session.delete` 链路**（7 步）：
1. `orchestrator.stop()` → 停止运行态
2. `flushSessionTraceWrites()` → 等待 pending trace
3. `removeSessionMeta()` → IDB sessions + entries（含 cursor 遍历）
4. `removeTraceRecords()` → IDB traces
5. `clearVirtualFilesForSession()` → sandbox dispose + namespace 清理（session + ephemeral __bbl）+ 遥测
6. `removeSessionIndexEntry()` → session 索引
7. `evictSessionRuntime()` → 清除所有内存缓存

**`brain.storage.reset` 链路**（4 步）：
1. `resetSessionStore()` → 清空 IDB sessions/entries/traces/SESSION_INDEX_KEY
2. `clearSessionScopedVirtualFiles()` → disposeAll + 所有 session/ephemeral namespace + 遥测
3. `initSessionIndex()` → 重建空索引
4. `orchestrator.resetRuntimeState()` → 清空所有内存 Maps

测试覆盖：6 个测试用例验证 delete/reset 后 VFS 读取 throws、stream cache 清空、trace 删除。

## 优先级

Slice A（结构清洁度）> Slice C（功能闭环验证）> Slice B（一致性）> Slice D（验证性）

## 验收

- [ ] 路径翻译逻辑独立模块化
- [ ] lifo-adapter.ts < 1,200 行
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
