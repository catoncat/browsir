@contract(BHV-CHAT-SHARED-TABS-CONTEXT)
Feature: Shared tabs context is injected before loop

  Scenario: Shared tabs are injected into run context
    Given 用户在输入框选择多个 sharing tabs
    When 用户发送消息开始新一轮执行
    Then 当前会话的 metadata 应包含每个共享 tab 的 title 与 url

  Scenario: Assistant response reflects shared tabs context
    Given 共享 tabs 上下文已注入到当前轮消息
    When 本轮执行完成
    Then assistant 回复应体现共享 tabs 提供的信息

  Scenario: Empty shared tabs do not pollute context
    Given tabIds 为空数组
    When 用户发送消息
    Then 会话 metadata 中不应保留过期 sharedTabs

  Scenario: Shared tabs are overridden per send
    Given 同一会话先发送一组 tabIds
    When 第二次发送不同的 tabIds
    Then sharedTabs 应以第二次发送的集合覆盖第一次
