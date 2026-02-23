@contract(BHV-LLM-CAPABILITY-GATE)
Feature: Loop LLM capability gate

  Scenario: LLM 可用时完成 tool_call 闭环
    Given sidepanel 配置可用的 LLM API
    When 用户发送触发 tool_call 的目标
    Then 会话状态应为 done
    And 回复应包含 tool_call 完成结果

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
