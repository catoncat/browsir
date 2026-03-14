---
id: ISSUE-011
title: "Skill browser scope 脚本执行闭环"
status: done
priority: p1
source: "next-development-master-plan-2026-03-14 + slice breakdown"
created: 2026-03-14
assignee: agent
resolved: 2026-03-14
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: skill-runtime
depends_on: []
write_scope:
  - extension/src/sw/kernel/dispatch-plan-executor.ts
  - extension/src/sw/kernel/loop-tool-dispatch.ts
  - extension/src/sw/kernel/skill-registry.ts
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags:
  - slice
  - skill
  - browser-scope
  - execution
claimed_at: "2026-03-14T10:21:59.909Z"
---

# ISSUE-011: Skill browser scope 脚本执行闭环

## 目标

让 `execute_skill_script` 对 skill-bundled browser scope 脚本真正闭环，不再要求用户迁移到 host path。

## 范围

- skill script path 解析
- browser runtime 执行入口
- unsupported runtime 错误语义

## 非目标

- 不扩展新的脚本语言支持
- 不调整 skill catalog 注入策略

## 验收

- `execute_skill_script` 不再返回“请迁到 host path”
- 对不支持的运行时给出明确 unsupported
- browser scope 执行产物符合注入脚本单文件自包含约束（无顶层 import/export）

## 工作总结

### 2026-03-14 18:33 CST

**实施**：
- 在 `dispatch-plan-executor.ts` 中把 browser scope 的 JS/CJS/MJS skill script 改成 browser-native inline runner 执行：先从 `mem://skills/.../scripts/...` 读取源码，再把源码以 base64 注入到 browser sandbox runner 中执行，不再尝试直接 `node mem://...`
- 为 browser scope 加入明确的 unsupported 语义：`.ts/.tsx` 等非支持脚本类型直接返回 `E_TOOL_UNSUPPORTED`；检测到顶层 `import/export` 时也直接返回 unsupported，保持“单文件自包含”约束
- 新增 `execute-skill-script.browser.test.ts`，覆盖 browser JS 成功执行、`.ts` unsupported、顶层 `import/export` unsupported 三条关键路径

**结果**：
- `execute_skill_script` 现在可以对 browser scope 的自包含 JS skill script 闭环执行，不再要求迁到 host path
- browser scope 的不支持场景会返回明确错误语义，而不是引导用户走错误执行路径

**验证**：
- `cd extension && bun run test -- execute-skill-script.browser.test.ts`
- `cd extension && bunx tsc --noEmit`
- `cd extension && bun run build`

## 相关 commits

### 2026-03-14 18:33 CST

- 未提交
