---
id: ISSUE-035
title: "ProviderSettings 半成品新格式配置导致内置 Cursor profile 重复"
status: done
priority: p1
source: 调试对话 2026-03-17
created: 2026-03-17
assignee: agent
resolved: 2026-03-17
tags:
  - panel
  - llm-provider
  - config-migration
  - cursor-help
---

## 背景

SidePanel 的 LLM 配置正在从单体 profile 重构为 `Provider + Profile` 分层。
中断现场里残留了一批“半成品新格式”配置：内置 Cursor profile 的 id 仍然是旧草稿值 `built-in`，而不是 canonical id `cursor_help_web`。

## 现象

- 模型设置页默认模型下拉里出现两个 Cursor 选项
- `llmDefaultProfile` 指向 `built-in`
- 新逻辑又自动注入 canonical 内置 profile `cursor_help_web`
- 最终 UI 里同时存在 `built-in` 和 `cursor_help_web` 两个指向同一 provider 的 hosted_chat profile

## 根因

`normalizeNewConfig()` 只会补齐 canonical 内置 Cursor profile，但不会把中断现场残留的 `built-in` 收敛为 `cursor_help_web`。
因此：

1. 旧半成品 profile 被保留
2. canonical 内置 profile 又被追加
3. 默认/辅助/备用选择引用也没有同步 remap

## 处理

- 在 `normalizeProfile()` 中把 `providerId=cursor_help_web` 且 `builtin=true` 或 `id=built-in` 的 profile canonicalize 为 `cursor_help_web`
- 在 `normalizeNewConfig()` 中维护 `sourceId -> normalizedId` alias，用于 remap `llmDefaultProfile / llmAuxProfile / llmFallbackProfile`
- 对 canonical 内置 Cursor profile 做去重合并，避免同 id 重复进入 `llmProfiles`
- 补回归测试覆盖这类半成品新格式配置

## 工作总结

### 2026-03-17 14:47 +08:00

- 通过真实 SidePanel 运行态抓到重复 Cursor 选项，而不是只靠 build/test 推测
- 新增 `config-store-phase1` 回归测试，先验证红灯，再修复归一化逻辑
- 修复后重新通过单测、全量扩展测试和扩展构建
- 同时把 AGENTS 的浏览器调试约束加强为“默认持久 CDP 连接”，避免反复点 Allow

## 相关 commits

- 未提交
