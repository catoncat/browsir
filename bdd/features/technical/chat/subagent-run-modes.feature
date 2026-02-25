@contract(BHV-SUBAGENT-RUN-MODES)
Feature: Subagent run modes
  作为编排内核
  我希望 `brain.agent.run` 支持 single/parallel/chain 三种最小原语
  以便在角色绑定 profile 下稳定启动子任务

  Scenario: single 模式可启动子任务并绑定路由
    Given sidepanel 已配置可用 worker profile
    When 调用 brain.agent.run mode=single 且提供 agent 与 task
    Then 应返回子任务 sessionId 与 runtime 视图
    And 子任务 step stream 中应出现 llm.route.selected
    And llm.route.selected 应包含绑定后的 role 与 profile

  Scenario: parallel 模式可批量启动并返回结果列表
    Given sidepanel 已配置 worker 与 reviewer profile
    When 调用 brain.agent.run mode=parallel 并提供多个 tasks
    Then 应返回与 tasks 等长的结果列表
    And 每个结果都应包含独立 sessionId

  Scenario: parallel 超过上限时显式失败
    When 调用 brain.agent.run mode=parallel 且 tasks 超过上限
    Then 返回应为失败并包含上限错误信息

  Scenario: chain 模式支持 {previous} 注入并返回 fan-in 汇总
    Given sidepanel 已配置 worker 与 reviewer profile
    When 调用 brain.agent.run mode=chain 并提供两段串行 chain
    Then 第二段任务应使用第一段输出替换 {previous}
    And 返回应包含 chain 结果列表与 fanIn.finalOutput fanIn.summary

  Scenario: chain 禁止 autoRun=false
    When 调用 brain.agent.run mode=chain 且 autoRun=false
    Then 返回应为失败并提示 chain 需要 autoRun=true
