# Runtime Infra CDP Action 抽离后续执行文档（2026-03-14）

## 目标
将 `extension/src/sw/kernel/runtime-infra.browser.ts` 中剩余的 CDP Action 执行逻辑完整抽离到独立模块（`infra-cdp-action.ts`），让 `runtime-infra.browser.ts` 仅负责编排与依赖注入，降低体积和耦合度。

## 当前状态（基于最新代码）
- `runtime-infra.browser.ts` 已完成部分模块化（Bridge Client、Snapshot Helpers 已独立）。
- 但文件内仍存在大量 CDP Action 相关函数（如 `resolveRefEntry`、`executeActionByBackendNode`、`executeRefActionByCDP` 等），说明“Wire + remove”尚未彻底完成。
- 需要重新做一次“抽离闭环”：移动 → 接线 → 删除残留 → 验证。

## 我将执行的步骤
1. **盘点依赖边界**
   - 明确 CDP Action 子模块输入/输出接口。
   - 确认哪些工具函数保留在 `runtime-infra.browser.ts`，哪些迁移到 `infra-cdp-action.ts`。

2. **完成模块抽离与接线**
   - 在 `infra-cdp-action.ts` 内收敛 Action 相关实现。
   - 在 `createRuntimeInfraHandler` 中通过工厂/依赖注入方式接入 executor。

3. **清理主文件残留**
   - 从 `runtime-infra.browser.ts` 删除重复或已迁移的 Action 代码。
   - 清理无用 import / type / 常量，确保无 orphan 逻辑。

4. **回归验证（必做）**
   - TypeScript 校验。
   - extension 构建。
   - 相关测试（至少跑到当前改动覆盖路径）。

5. **小步提交**
   - 按“同一组关联改动”原则提交一次原子 commit，记录抽离范围与验证结果。

## 完成标准
- `runtime-infra.browser.ts` 不再承载 CDP Action 细节实现，仅保留编排层代码。
- `infra-cdp-action.ts` 成为 CDP Action 单一实现入口。
- 构建/类型检查/测试通过（或仅剩已确认的无关历史问题）。
- 有清晰 commit 说明本次重构边界。

## 风险与注意事项
- 避免再次出现“局部替换导致结构错位/孤儿代码”问题；优先整段迁移、一次性收口。
- 任何 Legacy/Fallback 路径若被触发，先暂停并征询是否删除后再继续。
- 注入脚本相关改动需保持“单文件可执行产物”约束（本轮若未触达则不做额外改动）。
