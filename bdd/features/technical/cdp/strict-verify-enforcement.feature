@contract(BHV-CDP-STRICT-VERIFY-ENFORCEMENT)
Feature: Strict verify enforcement for browser actions

  Scenario: Strict verify blocks done when verification does not pass
    Given browser action runs under strict verify policy
    When action execution returns success but verify does not pass
    Then step result should be failed_verify or progress_uncertain
    And loop status should not be done

  Scenario: Fill action requires observable value update
    Given fill action includes expected target value under strict verify
    When final observed value does not match expected value
    Then verification should fail explicitly
    And response should include retry guidance

  Scenario: Click action requires observable post-action change
    Given click action is executed under strict verify
    When URL selector and target state remain unchanged after click
    Then the action should be treated as failed_verify
