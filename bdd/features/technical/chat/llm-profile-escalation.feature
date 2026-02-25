@contract(BHV-LLM-PROFILE-ESCALATION)
Feature: LLM profile escalation policy

  Scenario: 重复失败时只允许同角色升级
    Given sidepanel 为 worker 角色配置 profile 升级链
    And 首个 profile 连续触发重复失败签名
    When 用户继续执行同一目标
    Then 系统应升级到链路中的下一个更强 profile
    And step stream 应包含 llm.route.escalated 与升级原因

  Scenario: 无上级 profile 时显式失败
    Given sidepanel 当前角色 profile 已是链路最高级
    And 任务持续触发重复失败签名
    When 用户继续执行同一目标
    Then 会话状态应为 failed_execute 或 failed_verify
    And step stream 应包含 llm.route.blocked

  Scenario: 不允许静默降级到弱模型
    Given sidepanel 开启自动升级策略
    When 任务在高等级 profile 下出现临时失败
    Then 系统不应自动切换到更弱 profile
    And 如需调整应以显式路由事件可观测
