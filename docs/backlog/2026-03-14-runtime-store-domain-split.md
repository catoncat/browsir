---
id: ISSUE-009
title: Runtime Store 领域拆分
status: in-progress
priority: p0
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: agent
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: panel-store
depends_on: [ISSUE-008]
write_scope:
  - extension/src/panel/stores/runtime.ts
  - extension/src/panel/stores
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, panel, store, state]
---

# ISSUE-009: Runtime Store 领域拆分

## 目标

把 `runtime.ts` 拆成 chat/config/skills/plugins/diagnostics 等领域 store。

## 范围

建议分 2-3 个子 slice 执行：

### Phase A（优先）
- chat session / run → `chat-store.ts`

### Phase B
- environment / config → `config-store.ts`
- diagnostics → `diagnostics-store.ts`

### Phase C
- skills → `skills-store.ts`
- plugins → `plugins-store.ts`

Store 间协作约定：禁止循环依赖，store 间通过显式 action 调用或 computed getter 引用（不允许直接 `$patch` 其他 store 的状态）。

## 非目标

- 不改 UI 文案
- 不在本 slice 内重做 App 壳层

## 验收

- `runtime.ts` 不再是超级 store
- 新 store 之间通过明确 action / selector 协作
- 发送、rerun、stop 等聊天动作只在聊天域

## 工作记录

### Phase A — 2026-03-14

**完成内容**：chat session/run 域抽取

- 新建 `chat-store.ts`：6 个 state ref + 14 个 action（refreshSessions, loadConversation, createSession, sendPrompt, runAction, promoteQueuedPromptToSteer, fork/retry/regenerate/editRerun, refreshSessionTitle, updateSessionTitle, deleteSession）
- 新建 `send-message.ts`：共享的 chrome.runtime.sendMessage 传输 helper
- 瘦身 `runtime.ts`：移除全部 chat state/action，`bootstrap` / `ensureSkillSessionId` / `runSkill` 改为 cross-store 调用 `useChatStore()`
- `App.vue`：双 store（useRuntimeStore + useChatStore），storeToRefs 分离
- `DebugView.vue`：同样双 store 解构
- 类型 re-export：runtime.ts `export type { ConversationMessage, ... } from './chat-store'`，现有外部消费者无需改 import
- 验证：tsc --noEmit ✅ / bun run build ✅

**Commit**: `0c24eee`

**剩余**：Phase B (config/diagnostics)、Phase C (skills/plugins)

### Phase B — 2026-03-14

**完成内容**：config/health 域抽取

- 新建 `config-store.ts`：config/health/savingConfig/error state + loadConfig/refreshHealth/saveConfig actions + 全部 LLM profile normalization + normalizeConfig/normalizeHealth
- 新建 `store-helpers.ts`：共享 `toRecord`/`toIntInRange` 纯函数
- `runtime.ts` 进一步瘦身到 ~360 行：只保留 `loading` + `bootstrap`（cross-store orchestrator）+ skills/plugins 域
- `SettingsView`/`ProviderSettingsView`：切换到 `useConfigStore`，不再依赖 `useRuntimeStore`
- `DebugView`：health/config 切到 `useConfigStore`
- `App.vue`：三 store 消费（config + chat + runtime）
- 验证：tsc --noEmit ✅ / bun run build ✅

**Commit**: `d019f3f`

**剩余**：Phase C (skills/plugins)

