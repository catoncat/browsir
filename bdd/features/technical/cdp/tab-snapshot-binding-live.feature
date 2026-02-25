@contract(BHV-CDP-LIVE-TAB-SNAPSHOT-BINDING)
Feature: Tab and snapshot binding for browser actions

  Scenario: Action and verify must stay on the snapshot tab
    Given snapshot is captured from a specific tab context
    When action and verify are issued with that snapshot context
    Then execution should stay on the same tab
    And cross-tab execution should be rejected without explicit switch

  Scenario: Stale snapshot reference cannot be accepted silently
    Given an element ref belongs to an outdated snapshot generation
    When the stale ref is used for a new action
    Then system should return explicit binding failure
    And result should not be marked done

  Scenario: Explicit target switch requires rebind before action
    Given session decides to switch to another target tab
    When no fresh snapshot is taken after the switch
    Then action should be rejected until a new snapshot is captured
