@contract(BHV-CHAT-LIVE-NO-PROGRESS-GUARD)
Feature: No-progress cases converge by max_steps without guard events (live)

  Scenario: Repeated failures do not trigger retry circuit guard events
    Given loop keeps failing on equivalent target and reason
    When repeated failure signature reaches configured threshold
    Then runtime should not emit loop_no_progress
    And runtime should not emit retry_circuit_open or retry_budget_exhausted

  Scenario: No-progress case should terminate by max_steps
    Given loop keeps producing retryable failures across steps
    When no valid progress is observed until step upper bound
    And session view and step stream are queried
    Then terminal status should be max_steps
    And terminal status should not be done
