@contract(BHV-CHAT-MESSAGE-ACTIONS-RETRY-COPY)
Feature: Regenerate Assistant Answer

  Scenario: Forking from a historical assistant should create a new session and expose source metadata
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the conversation has at least two assistant replies
    And the historical assistant reply has an entryId
    When the user clicks the "在新对话中分叉" button on the historical assistant message
    Then the system should create a forked session
    And a "已分叉到新对话" notice should be displayed
    And the session list should include one more session
    And the forked session should expose source metadata

  Scenario: Forking from history should auto-regenerate with visible placeholder state
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the conversation has at least two assistant replies
    And the historical assistant reply has an entryId
    When the user clicks the "在新对话中分叉" button on the historical assistant message
    Then the forked session should immediately show "正在重新生成回复…"
    And the placeholder should expose aria-busy and regenerate spinner test ids
    And eventually a regenerated assistant message should appear without manual prompt

  Scenario: Retrying the latest assistant should stay in current session
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the latest assistant reply has an entryId
    When the user clicks the "重新回答" button on the latest assistant message
    Then the system should trigger regenerate in current session
    And a "已发起重新回答" notice should be displayed
    And the session list count should stay unchanged
    And eventually a new assistant message should appear in the list

  Scenario: Retrying latest assistant should render placeholder instead of blank wait
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the latest assistant reply has an entryId
    When the user clicks the "重新回答" button on the latest assistant message
    Then a "正在重新生成回复…" placeholder should appear immediately at message position
    And the placeholder should expose aria-busy and regenerate spinner test ids
    And eventually a new assistant message should replace the placeholder
