@contract(BHV-CHAT-HISTORY-INCLUDES-TOOL-RESULT)
Feature: Conversation history keeps tool result for follow-up turns

  Scenario: Follow-up turn includes prior tool role message
    Given first turn executed at least one tool_call successfully
    When user sends a follow-up goal in the same conversation
    Then LLM input history should contain role "tool" message from previous turn
    And assistant follow-up reply should reflect tool-context-aware answer
