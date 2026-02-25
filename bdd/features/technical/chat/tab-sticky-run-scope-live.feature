@contract(BHV-CHAT-LIVE-TAB-STICKY-RUN-SCOPE)
Feature: Run-scope tab sticky behavior

  Scenario: Active tab changes should not drift execution target
    Given session already has a primary target tab for current run
    When browser active tab changes due to user context switch
    Then subsequent actions without explicit tab should still use primary tab

  Scenario: Explicit switch migrates primary tab
    Given current run has an existing primary target tab
    When planner explicitly switches execution target to another tab
    Then primary tab should migrate to the new explicit target
    And follow-up actions should use the migrated primary tab

  Scenario: Implicit fallback to active tab is forbidden under sticky mode
    Given sticky run-scope target is available
    When action payload omits tab id
    Then runtime should resolve target from run-scope primary tab
    And it should not silently fallback to current active tab
