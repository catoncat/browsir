@contract(BHV-CHAT-DONE-SEMANTICS-STRICT)
Feature: Strict done semantics for loop status

  Scenario: Verify false must not be rolled up as done
    Given a step execution returns success but verify result is false
    When runtime computes final step status
    Then status should be failed_verify or progress_uncertain
    And done must not be emitted

  Scenario: Done requires execute success and verify pass
    Given a step requires post-action verification
    When execution succeeds and verification also passes
    Then step can be marked as done
    And final status reason should stay consistent with verification result

  Scenario: Failure reason remains visible to follow-up planning
    Given browser step fails verification
    When tool feedback is sent back to planner
    Then feedback should include explicit failure reason
    And next planning turn can distinguish failed_verify from failed_execute
