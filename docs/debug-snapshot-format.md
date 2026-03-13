# Debug Snapshot Format

调试快照用于外部 AI / Codex 排查 Browser Brain Loop 的全局模块状态，不替代单会话诊断。

适用场景：

- plugin rehydrate / register / hook 执行异常
- skill registry / skill resolver 行为异常
- capability provider / policy 冲突
- session runtime / queue / trace cache 状态异常
- 想看当前 kernel 模块面貌，而不是某个会话的完整故障诊断

## 当前版本

- schema: `bbl.debug.snapshot.v1`
- Bridge API:
  - `GET /api/debug-snapshots?token=<BRIDGE_TOKEN>`
  - `POST /api/debug-snapshots?token=<BRIDGE_TOKEN>`
  - `GET /api/debug-snapshots/<id>?token=<BRIDGE_TOKEN>`

## 使用顺序

1. 先看 `data.runtime.summary`
2. 再看 `data.plugins.summary`
3. 再看 `data.skills.summary`
4. 如果问题和 provider / policy 有关，看：
   - `data.plugins.modeProviders`
   - `data.plugins.capabilityProviders`
   - `data.plugins.capabilityPolicies`
   - `data.plugins.toolContracts`
5. 如果问题和某个 session 卡住有关，看：
   - `data.runtime.sessions`
   - `data.runtime.session`
   - `data.sandbox`
6. 如果问题和 skill 注入/解析有关，看：
   - `data.skills.skills`
   - `data.skills.resolver`

## Scope

`brain.debug.snapshot` 支持这些 scope：

- `runtime`
- `sandbox`
- `plugins`
- `skills`
- `all`

通常对外导出推荐直接用 `all`。

## 关键块

### `data.runtime`

- `summary`
  - session 数量、运行中数量、暂停数量
  - trace cache / pending write / blocked trace 数量
- `kernel`
  - live run state / cached step stream / pending trace write 对应的 session ids
- `sessions`
  - 每个 session 的标题、更新时间、runtime queue 状态
- `activity`
  - runtime route / plugin runtime message / plugin hook / internal event 的最近 tail

### `data.plugins`

- `summary`
  - plugin 总数、启用数、报错数、timeout 数
  - persisted plugin 记录数、UI extension 数
- `plugins`
  - plugin runtime view
- `persisted`
  - 插件持久化记录
- `uiExtensions`
  - UI 扩展注册记录
- `modeProviders`
- `capabilityProviders`
- `capabilityPolicies`
- `toolContracts`
- `llmProviders`

### `data.skills`

- `summary`
  - skill 总数、启用数、`disableModelInvocation` 数
- `skills`
  - skill registry 列表
- `resolver`
  - skill resolver 调试统计
  - 重点看 `summary.lastError`
  - 重点看 `bySkill[].errorCount`

### `data.sandbox`

- 浏览器沙盒 flush / command telemetry
- 重点看 `summary.flushSkippedCount`、`summary.commandTimeoutCount`

## 常用 jq

```bash
jq '.payload.data.runtime.summary' debug-snapshot.json
jq '.payload.data.plugins.summary' debug-snapshot.json
jq '.payload.data.skills.summary' debug-snapshot.json
jq '.payload.data.skills.resolver' debug-snapshot.json
jq '.payload.data.plugins.capabilityProviders' debug-snapshot.json
```

## 与 diagnostics 的分工

- `diagnostics`：看单会话故障链路、LLM/tool trace、timeline
- `debug snapshot`：看全局模块状态、plugin/skill/provider/runtime caches

先判断问题是“单会话失败”还是“系统模块异常”，再选导出类型。
