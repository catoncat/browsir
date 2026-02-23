@contract(BHV-CHAT-TOOL-RENDERER-REGISTRY)
Feature: Tool output is rendered by registry

  Scenario: Registered renderer takes precedence
    Given a tool result with a registered renderer
    When assistant message is rendered in sidepanel
    Then tool output should be displayed via that renderer
    And output should include renderer-defined status presentation

  Scenario: Default renderer fallback
    Given a tool result without a registered renderer
    When assistant message is rendered in sidepanel
    Then output should be displayed by the default renderer
    And user should not see raw internal dump text
