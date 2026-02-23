@contract(BHV-SESSION-STORAGE-RESET-BOOTSTRAP)
Feature: Session storage reset and bootstrap sequence stays consistent

  Scenario: Legacy state exists and bootstrap runs reset flow
    Given local storage contains legacy chatState.v2 payload
    When service-worker bootstrapSessionStore runs
    Then reset flow should archive legacy payload before deleting matched keys
    And session index should be initialized after reset
    And runtime should broadcast brain.bootstrap with mode legacy-reset

  Scenario: No legacy state and bootstrap only initializes index
    Given local storage does not contain legacy chatState.v2
    When service-worker bootstrapSessionStore runs
    Then reset flow should skip archive and reset
    And session index should still be initialized

  Scenario: Runtime storage reset route returns normalized reset result
    Given runtime receives message type brain.storage.reset
    When runtime router handles storage action
    Then resetSessionStore should run with runtime options
    And response should include removed keys and initialized index
