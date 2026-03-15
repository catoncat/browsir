# Runtime Infra CDP Action 抽离后续执行文档（2026-03-14）

## 目标
将 `extension/src/sw/kernel/runtime-infra.browser.ts` 中剩余的 CDP Action 执行逻辑完整抽离到独立模块（`infra-cdp-action.ts`），让 `runtime-infra.browser.ts` 仅负责编排与依赖注入，降低体积和耦合度。

## 任务进度
- [✓] **抽离逻辑到 `infra-cdp-action.ts`**: 将 `resolveRefEntry`, `executeActionByBackendNode`, `executeRefActionByCDP`, `executeByCDP`, `verifyByCDP` 完整搬迁。
- [✓] **接线与依赖注入**: 在 `runtime-infra.browser.ts` 中引入 `createCdpActionExecutor`，并通过其调用 Action 逻辑。
- [✓] **清理冗余实现**: 从 `runtime-infra.browser.ts` 中物理删除了约 1000 行重复代码（commit `17593ce`）。
- [✓] **类型校验与验证**: `get_errors` 确认 `runtime-infra.browser.ts` 和 `infra-cdp-action.ts` 无类型错误。

## 结论
`runtime-infra.browser.ts` 已成功瘦身，CDP Action 相关交互逻辑现在统一收口在 `infra-cdp-action.ts`。

## 下一步计划
- 开始执行 `docs/plugin-ui-widget-api-plan-2026-03-14.md` 中的 Panel 插件 Widget API 方案。
- 实施 `Mission Hud Dog` 的 Widget 化改造。

