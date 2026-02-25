@contract(BHV-CHAT-MESSAGE-ACTIONS-RETRY-COPY)
Feature: Regenerate Assistant Answer

  Scenario: 从历史 assistant 分叉应创建新会话并保留来源信息
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the conversation has at least two assistant replies
    And the historical assistant reply has an entryId
    When the user chooses "在新对话中分叉" on a historical assistant message
    Then the system should create a forked session
    And a "已分叉到新对话" notice should be displayed
    And the session list should include one more session
    And the forked session should expose source metadata

  Scenario: 从历史分叉后应自动重跑并给出运行态反馈
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the conversation has at least two assistant replies
    And the historical assistant reply has an entryId
    When the user chooses "在新对话中分叉" on a historical assistant message
    Then the forked session should immediately show a running indicator
    And the running indicator should remain visible until completion
    And eventually a regenerated assistant message should appear without manual prompt

  Scenario: 重试最新 assistant 应留在当前会话
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the latest assistant reply has an entryId
    When the user chooses "重新回答" on the latest assistant message
    Then the system should trigger regenerate in current session
    And a "已发起重新回答" notice should be displayed
    And the session list count should stay unchanged
    And eventually a new assistant message should appear in the list

  Scenario: 重试最新 assistant 时应展示运行态反馈而非空白等待
    Given sidepanel has a conversation with at least one user prompt and one assistant reply
    And the latest assistant reply has an entryId
    When the user chooses "重新回答" on the latest assistant message
    Then a running indicator should appear immediately at message position
    And the running indicator should keep visible loading feedback until completion
    And eventually a new assistant message should appear
