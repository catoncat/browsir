@contract(BHV-CHAT-SHARED-TABS-CONTEXT)
Feature: Shared tabs context is injected before loop

  Scenario: Shared tabs are injected into run context
    Given 用户在输入框选择多个 sharing tabs
    When 用户发送消息并触发 brain.run.start
    Then brain.debug.dump.meta.header.metadata.sharedTabs 应包含每个 tab 的 title 与 url

  Scenario: Assistant response reflects shared tabs context
    Given mock LLM 收到了 shared tabs 上下文注入
    When loop 完成
    Then assistant 回复应包含 "SHARED_TABS_CONTEXT_PRESENT"

  Scenario: Empty shared tabs do not pollute context
    Given tabIds 为空数组
    When 用户发送消息
    Then metadata 中不应保留 sharedTabs

  Scenario: Shared tabs are overridden per send
    Given 同一会话先发送一组 tabIds
    When 第二次发送不同的 tabIds
    Then sharedTabs 应以第二次发送的集合为准
