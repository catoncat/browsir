@contract(BHV-CHAT-MESSAGE-ACTIONS-RETRY-COPY)
Feature: Regenerate Assistant Answer

  Scenario: Regenerating an answer should not re-send user prompt but trigger answer regeneration
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the assistant reply has an entryId
    When the user clicks the "重新回答" button on the assistant message
    Then the system should trigger a new run for the current session
    And a "已发起重新回答" notice should be displayed
    And no new "user" role message should be added to the history
    And a new assistant message should eventually appear in the list
    And the previous user prompt should remain as the last user message before the new reply
