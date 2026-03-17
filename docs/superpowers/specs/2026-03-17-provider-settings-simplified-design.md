# Provider Settings 极简化设计

日期：2026-03-17

## 目标

把 SidePanel 的模型设置从“Provider + Profile 直接暴露”改成“用户只配置服务商和模型”。

用户视角只保留三件事：

1. 填一个 OpenAI-compatible 服务
2. 自动获取模型
3. 可选地把不同模型分配给不同场景

## 产品原则

- `profile` 是内核路由抽象，不是默认 UI 概念
- 默认能力仍然是 Cursor，但不作为一级配置卡片出现
- Cursor 只以一个问号提示说明副作用
- 默认页面只面向“单服务商多模型”使用路径
- 高级设置只解决“同服务不同场景模型分配”

## 页面结构

### 1. 自定义兼容服务卡片

- 输入项：
  - `API Base`
  - `API Key`
- 辅助提示：
  - 文案：`未配置时使用默认能力`
  - 右侧一个问号 tooltip
  - tooltip 说明：默认能力来自内置 Cursor 路径，某些场景会额外打开一个独立窗口
- 主按钮：`连接并获取模型`
- 获取成功后展示：
  - 当前服务状态
  - 主模型下拉

### 2. 高级设置折叠区

- `标题与摘要`
  - 默认：跟随主模型
  - 可选：同服务下的任一模型
- `失败兜底`
  - 默认：关闭
  - 可选：同服务下的任一模型

## 运行时映射

UI 不暴露 `llmDefaultProfile / llmAuxProfile / llmFallbackProfile`，但保存时继续映射到底层：

- 主模型 -> `llmDefaultProfile`
- 标题与摘要 -> `llmAuxProfile`
- 失败兜底 -> `llmFallbackProfile`

如果用户没有启用自定义服务，active routes 指向内置默认路径：

- `llmDefaultProfile = cursor_help_web`
- `llmAuxProfile = ""`
- `llmFallbackProfile = ""`

如果用户启用了自定义服务，自定义服务完全接管 active routes：

- 内部自动生成或复用隐藏 profile
- `llmDefaultProfile / llmAuxProfile / llmFallbackProfile` 都切到这些隐藏 profile
- Cursor 不再参与 active routes；只有在用户清空自定义服务时才重新接管
- UI 不展示 profile id
- 当前实现里内置 Cursor 的 hidden profile id 恰好与 provider id 同名，但这是内部约束，不进入产品文案

## 模型发现

- 直接请求用户填写的 `API Base + "/models"`
- 使用 `Authorization: Bearer <API Key>`
- 支持从以下返回结构提取模型：
  - `[{ id }]`
  - `{ data: [{ id }] }`
  - `{ models: [{ id }] }`

## 验证点

- 默认 UI 中不再出现 `Provider` / `Profile` 管理区
- 默认 UI 中不再出现单独的 Cursor 配置卡片，只保留问号提示
- 同一个服务返回多个模型时，可选择主模型
- 高级设置可把同服务的其他模型分配给辅助/兜底场景
- 保存后底层仍能正确写回 `default/aux/fallback profile`
