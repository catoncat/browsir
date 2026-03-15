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
| Phase 2: 路径翻译 | ⏳ 功能完成，结构待清理 | `parseVirtualUri` / `resolveVirtualPath` / `rewriteCommandVirtualUris` 已实现但内联在 lifo-adapter |

## 剩余工作

### Slice A: lifo-adapter 路径翻译层抽离（Phase 2 收口）

从 `lifo-adapter.ts`（1,412 行）抽出路径翻译逻辑为独立模块 `virtual-path-resolver.ts`：
- `parseVirtualUri()`
- `resolveVirtualPath()`
- `rewriteCommandVirtualUris()`
- `unixPathToVirtualUri()`
- `normalizeRelativePath()`
- 相关类型 `VirtualNamespaceDescriptor`

**预期效果**：lifo-adapter 降至 ~1,100 行，路径翻译可被 prompt resolver / skill loader 复用。

### Slice B: Registry + 文件树事务一致性（Phase 3）

确保 skills/plugins 的 registry metadata 与 VFS 文件树写入的原子性：
- 统一事务入口（registry 写入 + namespace 文件写入绑定）
- uninstall/delete/reset 后两边状态一致

### Slice C: @路径 / skills / prompt 共用 resolver（Phase 4）

验证 ISSUE-019（system-prompt-resolver）的产出是否已满足：
- 聊天输入 `@/mem/...`
- `llmSystemPromptCustom` 中的 `@路径`
- skill reference
- 三条链路 resolve / materialize 结果一致

如仍有 gap，补齐共用 resolver。

### Slice D: session delete / reset 语义闭环（Phase 5）

当前 `clearVirtualFilesForSession()` 已接通 `sandboxManager.dispose()`。
验证是否有遗漏的 runtime 生命周期层需要清理。

## 优先级

Slice A（结构清洁度）> Slice C（功能闭环验证）> Slice B（一致性）> Slice D（验证性）

## 验收

- [ ] 路径翻译逻辑独立模块化
- [ ] lifo-adapter.ts < 1,200 行
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
