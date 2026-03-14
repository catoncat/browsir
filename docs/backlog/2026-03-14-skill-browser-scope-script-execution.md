---
id: ISSUE-011
title: Skill browser scope 脚本执行闭环
status: open
priority: p1
source: next-development-master-plan-2026-03-14 + slice breakdown
created: 2026-03-14
assignee: unassigned
kind: slice
epic: EPIC-2026-03-14-NEXT-PHASE
parallel_group: skill-runtime
depends_on: []
write_scope:
  - extension/src/sw/kernel/dispatch-plan-executor.ts
  - extension/src/sw/kernel/loop-tool-dispatch.ts
  - extension/src/sw/kernel/skill-registry.ts
acceptance_ref: docs/next-development-slices-2026-03-14.md
tags: [slice, skill, browser-scope, execution]
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

