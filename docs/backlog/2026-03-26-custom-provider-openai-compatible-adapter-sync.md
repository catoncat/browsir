---
id: ISSUE-042
title: "自定义 OpenAI-compatible provider 已保存但运行时未注册"
status: done
priority: p0
source: "调试对话：custom provider `rs` 聊天时报错未找到 LLM provider"
created: 2026-03-26
assignee: agent
claimed_at: 2026-03-26T23:49:01+08:00
resolved: 2026-03-26
tags: [llm, provider, runtime, config]
---

# ISSUE-042: 自定义 OpenAI-compatible provider 已保存但运行时未注册

## 现象

- ProviderSettings 可以新增自定义 OpenAI-compatible 服务，例如 `rs`
- 保存后聊天直接失败：`执行失败：未找到 LLM provider（rs）`

## 根因

- UI 会把自定义 provider 生成独立 id，并把 profile 绑定到这个 id
- Service Worker 运行时默认只内置注册 `openai_compatible` 和 `cursor_help_web`
- 配置保存链路没有把“哪些自定义 provider 是合法配置项”传给运行时
- 因此 route 解析得到 `provider=rs` 时，registry 查询直接 miss

## 修复方向

- 在保存配置时额外持久化一份 `llmProviderCatalog`
- 运行时仅根据这份 catalog，把声明过的 `model_llm` provider id 映射为 `openai-compatible` adapter
- 保留 `provider_not_found` 语义：没有 catalog 声明的 provider 仍然视为坏配置

## 工作总结

### 2026-03-26 23:56 +08:00

- 已完成配置保存链路与运行时注册链路打通：
  - `config.save` 现在会持久化 `llmProviderCatalog`
  - runtime loop / compaction 在取配置后会按 catalog 同步注册 `model_llm` provider
  - 新增 runtime-router 与 config-store save 测试覆盖该路径
- 结果：
  - 自定义 OpenAI-compatible provider `rs` 不再在聊天时因 `provider_not_found` 失败
  - 运行时只会为 catalog 明确声明的 provider 建 adapter，不会放宽坏配置语义
- 残留：
  - 无已知功能残留，后续如扩展 catalog 类型（例如更多 hosted provider）需要再补 mapping 策略

## 相关 commits

- `2086be1` `chore(llm): add provider catalog sync helper`
- `756ac8c` `feat(llm): sync provider catalog into runtime registry`
- `361d52f` `test(llm): persist provider catalog during config save`

## 工作总结（补充）

### 2026-03-26 23:58 +08:00

- 已再次验证 `config-store-save` 与 `runtime-router` 相关测试全部通过，覆盖了 `llmProviderCatalog -> runtime registry -> fetch chat/completions` 的真实回归路径
- 额外执行了 `cd extension && bunx tsc --noEmit`
- 当前存在 1 个与本次修复无关的现存类型错误：
  - `src/sw/kernel/channel-observer.ts(73,14): Property 'text' does not exist on type 'SessionEntry'`
- 本轮工作区改动尚未提交，因此本轮相关 commits 结论以 `未提交` 为准

## 相关 commits（补充）

- 未提交

## 工作总结（再次补充）

### 2026-03-27 00:13 +08:00

- 继续排查自定义 provider `rs` 在 `tool_call` 场景下的 `LLM HTTP 400`
- 现场错误：
  - `Invalid schema for function 'click': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level.`
- 根因补充：
  - `31d996e` 已引入 tool schema sanitize，但当时仅对 `provider === openai_compatible` 生效
  - 后续自定义 provider 独立 id 落地后，`rs` 虽然底层仍走 OpenAI-compatible transport，但不再命中这个旧条件
  - 结果是 `click` 等工具的顶层 `anyOf` 没被抹平，OpenAI 兼容端返回 400
- 已修复：
  - 将 tool schema sanitize / constraint hint 的适用条件从“provider id 恰好等于 `openai_compatible`”改为“所有 `model_llm` 路径”
  - 给 `runtime-router` 的自定义 provider 测试补充断言，确认 `click.parameters` 顶层不再含 `anyOf/oneOf/allOf/enum/not`
- 已验证：
  - `cd extension && bun run test src/sw/kernel/__tests__/runtime-router.browser.test.ts`

## 相关 commits（再次补充）

- 未提交
