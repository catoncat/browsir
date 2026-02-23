@contract(BHV-CDP-ON-DEMAND)
Feature: CDP should be used only on demand

  Scenario: Non-CDP actions should run without tab
    Given no tab is selected in sidepanel
    When planner returns an invoke action
    Then the action should run without tab resolution

  Scenario: CDP action without valid tab should fail explicitly
    Given no tab is selected in sidepanel
    When planner returns a cdp action without valid tabId
    Then response should contain "cdp.execute 需要有效 tabId"

  Scenario: Snapshot returns compact a11y payload under token budget
    Given a valid tab is selected in sidepanel
    When sidepanel requests cdp.snapshot with format compact and maxTokens
    Then snapshot should include nodes with ref and role
    And snapshot response should include compact text and truncated flag

  Scenario: Verify supports urlChanged assertion after navigation
    Given a valid tab is selected in sidepanel
    When sidepanel executes cdp.action navigate and then cdp.verify with urlChanged
    Then verify result should be ok
