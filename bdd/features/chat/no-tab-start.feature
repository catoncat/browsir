@contract(BHV-CHAT-NO-TAB-START)
Feature: Chat can start without referenced tab

  Scenario: Start a chat when no tab is referenced
    Given sidepanel has no referenced tabs
    When user sends a goal "read README.md"
    Then assistant should return a result message
    And error message should not contain "没有可用 tab"

  Scenario: Persist behavior state for no-tab chat
    Given chat state is persisted
    When a no-tab conversation is restored
    Then referenced tab list should remain empty
