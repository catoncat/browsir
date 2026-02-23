@contract(BHV-CHAT-LIST-OPEN-TABS-TOOLS)
Feature: list_tabs and open_tab tool loop in chat

  Scenario: list_tabs and open_tab close the loop with observable browser effect
    Given sidepanel loop has a reachable browser context
    When LLM emits tool calls "list_tabs" then "open_tab"
    Then list_tabs result should include tab count and tab entries
    And open_tab result should include opened tab metadata
    And the opened tab should be observable in browser tabs
