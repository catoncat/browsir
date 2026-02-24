@contract(BHV-CHAT-NO-PROGRESS-GUARD)
Feature: No-progress guard for loop convergence

  Scenario: Repeated failures trigger retry circuit convergence guard
    Given loop keeps failing on equivalent target and reason
    When repeated failure signature reaches configured threshold
    Then runtime should emit retry_circuit_open
    And current round should stop early

  Scenario: Retry budget exhaustion triggers convergence guard
    Given loop keeps producing retryable failures across steps
    When retry budget is exhausted
    Then runtime should emit retry_budget_exhausted
    And current round should terminate

  Scenario: convergence guard yields non-done terminal status
    Given loop is terminated by convergence guard
    When session view and step stream are queried
    Then step stream should expose retry_circuit_open or retry_budget_exhausted
    And terminal status should be failed_verify or failed_execute
