@contract(BHV-SESSION-INTERRUPTION-RECOVERY)
Feature: Non-user interruptions keep session recoverable

  Scenario: Browser restart (service worker recreation) keeps prior session readable
    Given a session already has persisted user and assistant messages
    When browser restarts and service worker is recreated
    Then brain.session.view should still return persisted conversation messages
    And runtime should not silently resume the previous in-flight loop

  Scenario: Service worker restart keeps conversation recoverable
    Given a session already has persisted user and assistant messages
    And step trace records were appended before interruption
    When service worker restarts unexpectedly
    Then brain.session.view should still return persisted conversation messages
    And brain.step.stream should still return historical trace records
    And runtime state should recover as not running
    And user can continue the same session with a new prompt

  Scenario: Extension hot reload does not silently auto-resume in-flight loop
    Given a loop is running and has written at least one session entry
    When extension hot reload happens unexpectedly
    Then in-flight loop should not continue silently after reload
    And prior session entries should remain available
    And user can restart conversation by explicit prompt or regenerate action

  Scenario: Bridge disconnect or timeout keeps context and allows follow-up
    Given a tool call fails due to bridge disconnect or timeout
    When runtime records the failure and ends current loop
    Then session history should include failure message or loop error for diagnosis
    And previous context should remain available in conversation view
    And after bridge reconnect user can continue in the same session

  Scenario: User stop is not treated as interruption recovery path
    Given user explicitly stops current run
    When no new explicit start input is provided
    Then runtime should stay in stopped state
    And system should not auto-resume as interruption recovery
