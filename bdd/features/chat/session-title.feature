@contract(BHV-SESSION-TITLE-LIFECYCLE)
Feature: Session Title Lifecycle Management

  Scenario: Initial AI title generation
    Given sidepanel is open
    When user sends a prompt "你好，请帮我写一个 React 组件"
    Then the session title should eventually be "AI 总结的标题"

  Scenario: Manual title regeneration with animation
    Given a session with title "旧标题" exists
    When user triggers "Regenerate Title" from more menu
    Then the header should briefly show "正在重新生成标题" with dots
    And the title should eventually update to "AI 总结的标题"

  Scenario: Manual title renaming in session list
    Given a session with title "自动生成的标题"
    When user opens session list
    And user renames the session to "我自定义的标题"
    Then the session title should be "我自定义的标题"
    And the title should not be overwritten by auto-summarization on next message

  Scenario: Periodic auto-summarization on long conversations
    Given a session has 9 messages
    And "Title Auto-Summarize Interval" is set to 10
    When user sends the 10th message
    Then the system should trigger an AI title refresh
