@contract(BHV-CDP-BACKGROUND-TOOL-FILTERING)
Feature: Background mode tool filtering for LLM tool definitions

  Scenario: Computer tool is filtered in background mode
    Given automation mode is set to "background"
    When LLM tool definitions are listed
    Then "computer" should not be in the tool list

  Scenario: Screenshot tools are filtered in background mode
    Given automation mode is set to "background"
    When LLM tool definitions are listed
    Then "capture_screenshot" should not be in the tool list
    And "capture_tab_screenshot" should not be in the tool list
    And "capture_screenshot_with_highlight" should not be in the tool list

  Scenario: Any tool containing screenshot is filtered in background mode
    Given automation mode is set to "background"
    When LLM tool definitions include a custom tool with "screenshot" in its name
    Then that tool should also be filtered out

  Scenario: Non-screenshot tools are kept in background mode
    Given automation mode is set to "background"
    When LLM tool definitions are listed
    Then "click", "navigate", "fill" and other standard tools should remain

  Scenario: All tools are available in focus mode
    Given automation mode is set to "focus"
    When LLM tool definitions are listed
    Then "computer" and all screenshot tools should be available
    And the tool list should be the same as without filtering

  Scenario: System prompt preview respects current mode
    Given automation mode is set to "background"
    When system prompt preview is requested
    Then the prompt should use the filtered tool definitions
