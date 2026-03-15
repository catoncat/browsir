---
id: ISSUE-025
title: "Prompt Policy Phase 6 — tool policy / done heuristic 收口"
status: open
priority: p2
source: sandbox-runtime-filesystem-normalization-plan-2026-03-13
created: 2026-03-15
assignee: unassigned
kind: task
depends_on:
  - ISSUE-024
write_scope:
  - extension/src/sw/kernel/prompt/prompt-policy.browser.ts
tags:
  - prompt
  - tool-policy
  - llm-behavior
---

# ISSUE-025: Prompt Policy Phase 6 — tool policy / done heuristic 收口

## 背景

ISSUE-024（Phase 0-5）已全部完成。Phase 6 是行为层对齐，目标是防止 LLM 在 skill 安装场景
误用 `browser_bash` 代替 `host_bash`，以及 `browser_bash` 描述夸大其宿主 shell 能力。

## 当前问题

1. `browser_bash` 描述写 "(primary)" + "Full Linux-like shell"，暗示可承担一切 shell 任务
2. `host_bash` 描述写 "Use only when host-side execution is explicitly needed"，阻碍正常使用
3. 基础提示词 "Default to browser sandbox (browser_*) tools" 可能导致 skill 安装
   先在 browser_bash 上反复试错
4. browser_proof_guard 对 `create_skill` / `host_bash` 等非浏览器工具不触发——
   经审计已确认无需修改（`BROWSER_PROOF_REQUIRED_TOOL_NAMES` 不含这些工具）

## 实施范围

### S1: `prompt-policy.browser.ts` tool 描述与引导语优化

修改范围仅限 `prompt-policy.browser.ts`：

- **`browser_bash` 描述**：去掉 "(primary)"，补充 "sandboxed — no real network, no host filesystem"
- **`host_bash` 描述**：去掉 "Use only when host-side execution is explicitly needed"
- **基础引导语**：skill 安装优先 `host_bash + create_skill` 的提示保持现有
  "prefer create_skill; avoid using browser_bash to scaffold skill files"，
  补充 host_bash 用于外部依赖安装

### S2: 验证（无代码修改）

- browser_proof_guard 对非浏览器工具已豁免 ✅
- `create_skill` 完成流已正确收口（不触发 proof guard）✅

## 验收

- [ ] `browser_bash` 描述不再暗示 "(primary)" 或完整宿主 shell
- [ ] `host_bash` 描述不再阻碍正常使用
- [ ] skill 安装引导语明确 host_bash 定位
- [ ] `bun run build` 通过
- [ ] `bun run test` 通过
