@contract(BHV-LLM-CAPABILITY-GATE)
Feature: Loop LLM capability gate

  Scenario: LLM 可用时完成 tool_call 闭环
    Given sidepanel 配置可用的 LLM API
    When 用户发送触发 tool_call 的目标
    Then 会话状态应为 done
    And 回复应包含 tool_call 完成结果

  Scenario: LLM 遇到可重试工具失败时继续重试并成功
    Given sidepanel 配置可用的 LLM API 且工具首次返回可重试失败
    When 用户发送触发 bash tool_call 的目标
    Then 会话状态应为 done
    And step stream 应包含失败后再次成功的 tool_call

  Scenario: CDP 操作失败后不中断并继续推进
    Given sidepanel 配置可用的 LLM API 且 browser_action 首次验证失败
    When 用户发送触发 browser_action 的目标
    Then 会话状态应为 done
    And 失败的 browser_action 应作为 tool 消息反馈给 LLM

  Scenario: LLM 返回超长 Retry-After 时快速失败
    Given sidepanel 配置可用的 LLM API 且 Retry-After 超过上限
    When 用户发送触发限流重试的目标
    Then 会话状态应为 failed_execute
    And 不应进入长等待自动重试

  Scenario: 重复可恢复失败应触发熔断
    Given sidepanel 配置可用的 LLM API 且同一工具目标持续返回可恢复失败
    When 用户发送触发持续失败的目标
    Then 会话状态应为 failed_execute
    And step stream 应包含重试熔断或预算耗尽事件

  Scenario: LLM 不可用但规则可解析时降级成功
    Given sidepanel 未配置 LLM API
    When 用户发送可被规则 planner 解析的目标
    Then 会话状态应为 done
    And 回复应包含规则执行结果

  Scenario: LLM 不可用且规则不可解析时显式失败
    Given sidepanel 未配置 LLM API
    When 用户发送规则 planner 无法解析的浏览器任务目标
    Then 会话状态应为 failed_execute
    And 回复应包含规则 planner 无法理解目标

  Scenario: LLM HTTP 失败时回退到规则 planner
    Given sidepanel 配置的 LLM API 返回 HTTP 错误
    When 用户发送可被规则 planner 解析的目标
    Then 会话状态应为 done
    And 回复应包含规则执行结果
