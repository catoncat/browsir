@contract(BHV-CDP-BACKGROUND-FAILURE-TRACKER)
Feature: Background mode failure tracking and upgrade hints

  Scenario: Single failure does not trigger upgrade hint
    Given automation mode is set to "background"
    When a background operation fails once on tab 10
    Then buildUpgradeHint should return null for tab 10

  Scenario: Three consecutive failures trigger upgrade hint
    Given automation mode is set to "background"
    When background operations fail 3 times consecutively on tab 10
    Then buildUpgradeHint should return an upgrade hint object
    And hint should include recommendation to switch to focus mode

  Scenario: Success resets failure counter
    Given automation mode is set to "background"
    When background operations fail twice then succeed on tab 10
    Then consecutive failures should be reset to 0
    And buildUpgradeHint should return null for tab 10

  Scenario: Failure tracking is per-tab independent
    Given automation mode is set to "background"
    When tab 10 has 3 failures and tab 20 has 1 failure
    Then upgrade hint should be suggested for tab 10
    And upgrade hint should not be suggested for tab 20

  Scenario: Upgrade hint is attached to snapshot response
    Given automation mode is set to "background"
    When snapshot completes and shouldSuggestUpgrade is true
    Then snapshot response should include upgradeHint field

  Scenario: Upgrade hint is attached to action error details
    Given automation mode is set to "background"
    When DomLocator action fails and shouldSuggestUpgrade is true
    Then error details should include upgradeHint field

  Scenario: No automatic mode switch
    Given automation mode is set to "background"
    When consecutive failures exceed threshold
    Then automation mode should remain "background"
    And only a hint is attached to responses
