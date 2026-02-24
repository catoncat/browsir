# ADR-0001：Browser Agent 可靠性闭环与混合工具编排

> 状态：Proposed  
> 日期：2026-02-24  
> 决策范围：`extension/src/sw/kernel`（`snapshot / browser_action / browser_verify`）与 Loop 编排层

## 1. 背景

当前 Browser Agent 失败呈现为“执行成功但目标未推进”：

1. `ref` 非稳定句柄，快照代际切换后易失效。
2. verify 过于粗粒度（页面统计量变化），容易假阴性。
3. `verified=false` 在部分路径仍可被视为成功，语义不一致。
4. 缺少真实 `no_progress` 收敛机制，容易重复试探。
5. 默认 active tab 执行导致目标 tab 漂移。
6. 可在 shell 侧完成的工作过度挤压到浏览器动作链路。

## 2. 决策

本 ADR 采用以下决策：

1. 采用强闭环：`Observe -> Act -> Verify`，并以验证结果定义是否推进。
2. 执行目标绑定：`tabId + snapshotId` 成为 browser action 默认必备上下文。
3. 成功语义统一：`done` 必须满足“动作成功 + 验证通过”。
4. 增加 `no_progress`：重复签名与 ABAB 往返触发提前终止。
5. auto-repair 边界收口：仅在 `execute_error | failed_verify | no_progress` 触发。
6. 引入会话 `primaryTabId` 粘性，默认不跟随 active tab 漂移。
7. 默认混合编排策略：优先 `bash/read/write/edit`，浏览器仅做必须交互。

## 3. 备选方案与取舍

| 方案 | 描述 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A | 仅改提示词，不改内核 | 开发快 | 不可验证、不可收敛 | 否 |
| B | 仅增强 verify，不改状态语义 | 改动小 | 软失败循环仍在 | 否 |
| C | 外部框架替换内核 | 功能丰富 | 迁移成本高、边界重建 | 否 |
| D | 在现有内核上做闭环改造 | 可渐进、契约可控 | 需补齐测试与门禁 | 是 |

## 4. 影响评估

1. 代码影响：`runtime-infra.browser.ts`、`runtime-loop.browser.ts`、`events.ts`、BDD 映射。
2. 行为影响：任务成功率上升，误判率下降，重试更可控。
3. 性能影响：verify 轮询会增加少量时延，需要设置上限窗口。
4. 运维影响：失败证据更完整，定位成本下降。

## 5. 风险

1. 过严校验导致误杀（False Negative）。
2. 过松校验导致漏判（False Positive）。
3. 新旧语义并存时的兼容风险。
4. 外部站点动态变化导致不稳定。
5. 混合工具能力扩张带来安全边界压力。

## 6. 回滚策略

1. 回滚触发：live 成功率明显下降、误判率上升或关键流程不可用。
2. 回滚粒度：按功能开关回滚（verify mode、no_progress、auto-repair、tab sticky）。
3. 回滚顺序：先关闭新策略，再恢复旧判定；保持协议与存储兼容不回滚。
4. 回滚验证：`brain:e2e`、`bdd:gate`、`brain:e2e:live` 全量复验。

## 7. 验收标准

1. 契约：新增行为必须有 `bdd/contracts` + `bdd/features` + `contract-to-tests` 映射。
2. E2E：覆盖 `no_progress`、`strict verify`、`auto-repair boundary`、`tab sticky`。
3. Live：真实 LLM 冒烟成功率达到发布阈值。
4. 指标：`done && verify=true`、误判率、P95 重试次数达到门限。
5. 门禁命令：
   - `bun run bdd:validate`
   - `bun run brain:e2e`
   - `bun run bdd:gate`
   - `bun run brain:e2e:live`
   - `bun run bdd:gate:live`

## 8. 关联文档

1. `docs/browser-agent-reliability-playbook.md`
2. `docs/browser-agent-reliability-checklist.md`
