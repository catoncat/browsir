# Model Settings Scene-First Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把模型设置重做成“场景选模型为主、添加服务商为辅”的交互，并把内置免费模型与自定义服务商模型统一纳入可选目录。

**Architecture:** 保留现有 `PanelConfigNew` 与隐藏 profile 路由模型，在 panel 侧增加一层统一的模型目录 view-model。主页面只做场景选择，次级面板只做服务商接入，二者通过共享目录状态衔接。

**Tech Stack:** Vue 3、Pinia、TypeScript、Vitest

---

## Chunk 1: 文档与失败测试

### Task 1: 记录新交互约束

**Files:**
- Create: `docs/superpowers/specs/2026-03-17-model-settings-scene-first-design.md`
- Create: `docs/superpowers/plans/2026-03-17-model-settings-scene-first.md`

- [ ] Step 1: 写设计文档
- [ ] Step 2: 写实现计划

### Task 2: 先写失败测试

**Files:**
- Modify: `extension/src/panel/components/__tests__/ProviderSettingsView.test.ts`
- Modify: `extension/src/panel/stores/__tests__/config-store-phase1.test.ts`
- Test: `extension/src/panel/utils/__tests__/provider-settings-state.test.ts`

- [ ] Step 1: 写“主界面以场景选择为主”的测试
- [ ] Step 2: 写“添加服务商不会自动切换场景”的测试
- [ ] Step 3: 写“内置免费模型目录聚合”的测试
- [ ] Step 4: 运行相关测试，确认先失败

## Chunk 2: 统一模型目录

### Task 3: 增加模型目录 view-model

**Files:**
- Modify: `extension/src/panel/utils/provider-settings-state.ts`
- Test: `extension/src/panel/utils/__tests__/provider-settings-state.test.ts`

- [ ] Step 1: 增加统一模型选项结构，包含 `providerId/providerLabel/modelId/optionValue`
- [ ] Step 2: 聚合自定义服务商模型
- [ ] Step 3: 聚合内置免费模型
- [ ] Step 4: 运行测试确认通过

### Task 4: 提供内置免费模型探测数据

**Files:**
- Modify: `extension/src/sw/kernel/runtime-router/debug-controller.ts`
- Modify: `extension/src/sw/kernel/web-chat-executor.browser.ts`
- Modify: `extension/src/panel/stores/config-store.ts`

- [ ] Step 1: 增加 panel 可读的内置免费模型数据接口
- [ ] Step 2: 在 config store 中增加读取方法
- [ ] Step 3: 用最小测试或现有测试补验证

## Chunk 3: 重写模型设置 UI

### Task 5: 主页面改成场景选择器

**Files:**
- Modify: `extension/src/panel/components/ProviderSettingsView.vue`
- Test: `extension/src/panel/components/__tests__/ProviderSettingsView.test.ts`

- [ ] Step 1: 去掉当前“默认/自定义切换”结构
- [ ] Step 2: 改为三个场景选择器
- [ ] Step 3: 每个选择器末尾增加 `+ 添加自定义服务商`
- [ ] Step 4: 运行组件测试

### Task 6: 增加次级服务商面板

**Files:**
- Modify: `extension/src/panel/components/ProviderSettingsView.vue`
- Test: `extension/src/panel/components/__tests__/ProviderSettingsView.test.ts`

- [ ] Step 1: 加服务商名称输入，设为必填
- [ ] Step 2: 加 API Base / API Key / 获取模型
- [ ] Step 3: 添加成功后返回主界面且不改场景值
- [ ] Step 4: 新模型以 `服务商名称 / 模型名` 出现在选择器里

## Chunk 4: 保存链路与验证

### Task 7: 修正 legacy/save 路由

**Files:**
- Modify: `extension/src/panel/stores/config-store.ts`
- Modify: `extension/src/panel/stores/__tests__/config-store-phase1.test.ts`

- [ ] Step 1: 修复 builtin cursor profile 在 legacy config 中丢失的问题
- [ ] Step 2: 运行相关测试确认通过

### Task 8: 全量验证

**Files:**
- No code changes required

- [ ] Step 1: 运行 `cd extension && bun run test`
- [ ] Step 2: 运行 `cd extension && bun run build`
- [ ] Step 3: 检查最终 diff，确认没有残留错误交互
