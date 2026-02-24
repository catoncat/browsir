# Docs 索引

## 推荐阅读顺序

1. `docs/non-ui-architecture-blueprint.md`
   - 先理解系统分层、时序、协议与存储（复刻主文档）
2. `docs/hook-plugin-architecture.md`
   - Hook 管线、插件模型、不可绕过硬约束与浏览器坑位
3. `docs/tool-contract-provider-migration.md`
   - 工具契约去本机绑定、Provider/Registry 设计与分期迁移
4. `docs/kernel-runtime-migration-plan.md`
   - 再看 kernel 迁移背景、兼容入口（shim）与发布决策
5. `docs/pi-alignment-implementation-map.md`
   - 最后看与 pi 语义对齐的实现映射与 BDD 落地状态

## 核心文档

- `docs/non-ui-architecture-blueprint.md`
  - 非 UI 架构蓝图（组件、时序、协议、存储、错误码、复刻清单）
- `docs/hook-plugin-architecture.md`
  - Hook 与插件体系（可拦截边界、隔离策略、硬不变量、落地分期）
- `docs/tool-contract-provider-migration.md`
  - 工具契约与执行后端解耦（命名、兼容、Provider、迁移/回滚策略）
- `docs/kernel-runtime-migration-plan.md`
  - kernel 迁移与收口状态（含 shim 方案）
- `docs/pi-alignment-implementation-map.md`
  - 与 pi 对齐的实现映射与 BDD 对齐状态
- `docs/pi-mono-runtime-comparison.md`
  - Browser Brain Loop 与 pi-mono 三模块的 runtime 维度对比与迁移建议

## BDD 文档（在 `bdd/`）

- `bdd/README.md`
  - BDD 总览、门禁命令、证据规则
- `bdd/CONTRACT-WRITING-GUIDELINE.md`
  - 契约写作规范（行为导向、去实现耦合）
- `bdd/SESSION-HANDOFF.md`
  - 续跑交接基线与执行顺序
