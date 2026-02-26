@contract(BHV-SESSION-STORAGE-RESET-BOOTSTRAP)
Feature: Session storage reset and bootstrap sequence stays consistent

  Scenario: Service worker bootstrap initializes session index
    Given service worker starts on install or startup
    When service-worker startup bootstrap runs
    Then session index should be initialized
    And bootstrap should not depend on legacy archive flow

  Scenario: Runtime storage reset route returns normalized reset result
    Given runtime receives message type brain.storage.reset
    When runtime router handles storage action
    Then storage reset flow should run with runtime options
    And response should include removed keys and initialized index

  Scenario: Runtime storage init route returns current index
    Given runtime receives message type brain.storage.init
    When runtime router handles storage action
    Then response should include current initialized index
