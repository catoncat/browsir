# Browser Agent 可靠性实施清单

> 对应 ADR：`docs/adr-0001-browser-agent-reliability.md`  
> 对应总览：`docs/browser-agent-reliability-playbook.md`

## 1. 使用说明

1. 本清单按 `P0 -> P1 -> P2` 执行。
2. 每项完成后，必须补测试或契约证据。
3. 若出现语义分歧，以 ADR 决策条款为准。

## 2. P0（止血）

### 2.1 目标绑定与执行安全

- [ ] `browser_action` 入参要求 `tabId + snapshotId`（或可验证的等价上下文）
- [ ] `ref` 失效时允许合理回退（例如 selector 候选），并输出稳定错误码
- [ ] 在 `runtime-loop` 内补目标一致性检查，避免隐式跨 tab/跨代执行

建议落点：
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/runtime-infra.browser.ts`

### 2.2 verify 从单点改为时间窗

- [ ] `click/fill/navigate` 引入短时间轮询 verify（设置可配置上限）
- [ ] `fill` 校验目标值变化
- [ ] `click` 校验目标状态变化或关键 selector/url 变化
- [ ] verify 超时返回明确错误码和 retryHint

建议落点：
- `extension/src/sw/kernel/runtime-infra.browser.ts`
- `extension/src/sw/kernel/runtime-loop.browser.ts`

### 2.3 统一成功语义

- [ ] 规范 `verified=false` 的结果语义，不再默认等同成功推进
- [ ] 对 `done` 增加“已验证推进”约束
- [ ] 输出结构中显式区分 `failed_execute / failed_verify / progress_uncertain`

建议落点：
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/types.ts`

### 2.4 文档与行为对齐

- [ ] README 中 `no_progress / auto-repair` 说明与实现一致
- [ ] 对外协议说明更新（tool 参数、错误码、verify 语义）

建议落点：
- `README.md`
- `docs/browser-agent-reliability-playbook.md`

## 3. P1（提稳定）

### 3.1 no_progress 收敛

- [ ] 增加动作签名（tool/kind/tabId/target/expect）
- [ ] 支持重复签名阈值检测
- [ ] 支持 ABAB ping-pong 检测
- [ ] 触发后输出统一事件与状态

建议落点：
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/events.ts`

### 3.2 tab 粘性

- [ ] 增加会话级 `primaryTabId`
- [ ] 默认执行目标不随 active tab 变化
- [ ] 仅显式切换时迁移 primaryTabId

建议落点：
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/session-manager.browser.ts`

### 3.3 错误与预算分层

- [ ] 分离 `failed_execute` 与 `progress_uncertain` 预算
- [ ] 为 `failed_verify` 增加单独预算和重试策略
- [ ] 错误码规范化并补充测试覆盖

建议落点：
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts`

## 4. P2（提上限）

### 4.1 混合工具编排策略

- [ ] 在 planner 提示或策略层明确：优先 `bash/read/write/edit`
- [ ] 仅将必须 UI 交互下沉到 browser action
- [ ] 工具切换时保留目标一致性上下文

建议落点：
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/tool-contract-registry.ts`

### 4.2 护栏与审计

- [ ] 域名 allowlist（可配置）
- [ ] 高风险动作二次确认策略
- [ ] 失败样本可回放（最小证据集）

建议落点：
- `extension/src/sw/kernel/capability-policy.ts`
- `docs/`

### 4.3 CDP 工程化

- [ ] 评估协议生成客户端（typed CDP）
- [ ] 比较迁移成本与收益
- [ ] 形成是否迁移的 ADR 补充记录

建议落点：
- `docs/`

## 5. 契约与测试清单

### 5.1 BDD 契约

- [ ] 复用并维持：
  - [ ] `BHV-LLM-CAPABILITY-GATE`
  - [ ] `BHV-CDP-ON-DEMAND`
  - [ ] `BHV-LLM-LIVE-CAPABILITY`
- [ ] 新增：
  - [ ] `BHV-LOOP-NO-PROGRESS-GUARD`
  - [ ] `BHV-AUTO-REPAIR-TRIGGER-BOUNDARY`
  - [ ] `BHV-STRICT-VERIFY-SEMANTICS`
- [ ] 更新 `bdd/mappings/contract-to-tests.json`

### 5.2 E2E 用例

- [ ] `no_progress` 触发终止
- [ ] action 成功但 verify 失败不可 `done`
- [ ] `max_steps/stopped/timeout` 不触发 auto-repair
- [ ] lease 异常后可回收
- [ ] live 成功率统计可复算

建议落点：
- `tools/brain-e2e.ts`
- `bdd/features/technical/*`
- `bdd/contracts/*`

## 6. 发布门禁

每次提交至少执行：

- [ ] `bun run bdd:validate`
- [ ] `bun run brain:e2e`
- [ ] `bun run bdd:gate`

发布前执行：

- [ ] `bun run brain:e2e:live`
- [ ] `bun run bdd:gate:live`

## 7. 完成定义（DoD）

- [ ] `done` 结果与 `verify=true` 语义一致
- [ ] `no_progress` 可观测、可重现、可终止
- [ ] default/live 两套 profile 语义一致
- [ ] 文档、契约、测试、门禁四者同步更新
