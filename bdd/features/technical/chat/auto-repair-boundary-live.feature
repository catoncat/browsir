@contract(BHV-CHAT-LIVE-AUTO-REPAIR-BOUNDARY)
Feature: Auto-repair trigger boundary

  Scenario: failed_execute allows auto-repair
    Given current round ends with failed_execute
    When runtime evaluates auto-repair eligibility
    Then auto-repair should be triggered
    And repair start/end should be observable in events

  Scenario: failed_verify allows auto-repair
    Given current round ends with failed_verify
    When runtime evaluates auto-repair eligibility
    Then auto-repair should be triggered
    And follow-up attempt should keep original goal context

  Scenario: progress_uncertain allows bounded auto-repair
    Given current round ends with progress_uncertain
    When runtime evaluates auto-repair eligibility
    Then auto-repair should be triggered with bounded budget

  Scenario: no-progress signal allows auto-repair
    Given current round emits loop_no_progress or retry_circuit_open or retry_budget_exhausted signal
    When runtime evaluates auto-repair eligibility
    Then auto-repair should be triggered with bounded budget

  Scenario: max_steps stopped must not auto-repair
    Given current round ends with max_steps or stopped
    When runtime evaluates auto-repair eligibility
    Then auto-repair must not trigger implicit next round
    And terminal status should remain unchanged
