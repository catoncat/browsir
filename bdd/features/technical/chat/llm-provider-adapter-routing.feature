@contract(BHV-LLM-PROVIDER-ADAPTER-ROUTING)
Feature: LLM provider adapter routing

  Scenario: 缺少 profile 配置时返回明确错误
    Given sidepanel 未配置可用 llmProfiles
    When 用户发起需要 LLM 规划的任务
    Then 会话状态应为 failed_execute 或 failed_verify
    And 响应中应包含 profile_not_found 或缺少配置提示

  Scenario: 指定 profile 时必须显式命中 provider 与 model
    Given sidepanel 配置可用 profile 且绑定 provider/model
    When 用户发起需要 tool_call 的任务
    Then 会话应通过该 profile 绑定的 provider 执行
    And 事件应包含 profile provider model 选择信息

  Scenario: provider 缺失时返回稳定错误
    Given sidepanel profile 指向未注册 provider
    When 用户发起需要 LLM 的任务
    Then 会话状态应为 failed_execute 或 failed_verify
    And 回复中应包含明确的 provider 不可用原因
    And 系统不应静默切换到弱模型
