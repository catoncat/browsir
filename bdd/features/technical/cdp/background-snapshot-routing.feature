@contract(BHV-CDP-BACKGROUND-SNAPSHOT-ROUTING)
Feature: Background mode snapshot routing via content script DOM

  Scenario: Background mode uses content script DOM snapshot path
    Given automation mode is set to "background"
    When snapshot is requested for a tab
    Then snapshot should be collected via content script message
    And snapshot source should be "dom-background"
    And snapshot nodes should carry brainUid from DOM uid attribute
    And no debugger should be attached to the tab

  Scenario: Focus mode uses CDP debugger snapshot path
    Given automation mode is set to "focus"
    When snapshot is requested for a tab
    Then snapshot should use CDP Accessibility.getFullAXTree
    And snapshot source should not be "dom-background"

  Scenario: Content script failure returns graceful error snapshot
    Given automation mode is set to "background"
    And content script is not ready or throws an error
    When snapshot is requested for a tab
    Then snapshot should have source "dom-background-error"
    And snapshot count should be zero
    And error message should be preserved
    And session should not be broken

  Scenario: Content script timeout returns error within 10 seconds
    Given automation mode is set to "background"
    And content script does not respond
    When snapshot is requested for a tab
    Then snapshot request should timeout after 10 seconds
    And error should contain E_CONTENT_SCRIPT_NOT_READY
