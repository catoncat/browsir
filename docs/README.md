# Docs 索引

## 推荐阅读顺序

1. `docs/hook-plugin-current-status.md`
   - 最新集成状态、完成度和门禁结果（含“去 fallback + Provider 非二选一”最新决议）
2. `docs/non-ui-architecture-blueprint.md`
   - 先理解系统分层、时序、协议与存储（复刻主文档）
3. `docs/hook-plugin-architecture.md`
   - Hook 管线、插件模型、不可绕过硬约束与浏览器坑位
4. `docs/tool-contract-provider-migration.md`
   - 工具契约去本机绑定、Provider/Registry 设计与分期迁移
5. `docs/kernel-runtime-migration-plan.md`
   - 再看 kernel 迁移背景、兼容入口（shim）与发布决策
6. `docs/pi-alignment-implementation-map.md`
   - 最后看与 pi 语义对齐的实现映射与 BDD 落地状态
7. `docs/browser-agent-reliability-playbook.md`
   - Browser Agent 失败根因、业界最佳实践对照与分阶段落地建议
8. `docs/adr-0001-browser-agent-reliability.md`
   - Browser Agent 可靠性改造的决策记录（ADR）
9. `docs/browser-agent-reliability-checklist.md`
   - Browser Agent 改造执行清单（按 P0/P1/P2）
10. `docs/llm-provider-subagent-design.md`
   - 多 Provider 与 Sub-Agent 设计沉淀（本产品口径、分阶段落地）

## 核心文档

- `docs/non-ui-architecture-blueprint.md`
  - 非 UI 架构蓝图（组件、时序、协议、存储、错误码、复刻清单）
- `docs/hook-plugin-current-status.md`
  - Hook/Plugin 集成现状（完成项、未完全切换项、验证状态）
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
- `docs/browser-agent-reliability-playbook.md`
  - Browser Agent 可靠性改进手册（根因复盘、官方实践、门禁建议）
- `docs/adr-0001-browser-agent-reliability.md`
  - Browser Agent 可靠性改造 ADR（背景、决策、回滚、验收）
- `docs/browser-agent-reliability-checklist.md`
  - Browser Agent 落地实施清单（任务分解与门禁执行）
- `docs/llm-provider-subagent-design.md`
  - 多 Provider 与 Sub-Agent 设计沉淀（避免黑盒降级，面向角色选模）

## BDD 文档（在 `bdd/`）

- `bdd/README.md`
  - BDD 总览、门禁命令、证据规则
- `bdd/CONTRACT-WRITING-GUIDELINE.md`
  - 契约写作规范（行为导向、去实现耦合）
- `bdd/SESSION-HANDOFF.md`
  - 续跑交接基线与执行顺序
