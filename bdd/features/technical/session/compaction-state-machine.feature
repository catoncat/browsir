@contract(BHV-SESSION-COMPACTION-STATE-MACHINE)
Feature: Kernel compaction state machine is deterministic

  Scenario: Threshold check triggers compaction event chain
    Given session context token usage reaches compaction threshold
    When orchestrator runs pre-send compaction check
    Then pre-send compaction check should return true
    And event stream should include auto_compaction_start then session_compact then auto_compaction_end
    And rebuilt context should include previous summary system message

  Scenario: Overflow path chooses compaction instead of retry
    Given agent end reports overflow with an error
    When orchestrator handles agent end decision
    Then decision should be continue with reason compaction_overflow
    And auto_retry_start should not be emitted before compaction events

  Scenario: Retryable non-overflow path enters retry branch first
    Given agent end reports retryable network error without overflow
    When orchestrator handles agent end decision
    Then decision should be retry with backoff delay
    And event stream should include auto_retry_start
