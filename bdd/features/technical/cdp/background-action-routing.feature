@contract(BHV-CDP-BACKGROUND-ACTION-ROUTING)
Feature: Background mode action routing via DomLocator synthetic events

  Scenario: Background mode routes click through DomLocator
    Given automation mode is set to "background"
    When click action is issued with a valid uid
    Then action should be executed via chrome.scripting.executeScript
    And result should have mode "background"
    And synthetic mousedown, mouseup, click events should be dispatched

  Scenario: Background mode routes fill through DomLocator
    Given automation mode is set to "background"
    When fill action is issued with a valid uid and value
    Then element value should be set via synthetic events
    And focus, input, change, blur events should be dispatched
    And result should have mode "background"

  Scenario: Background mode routes hover through DomLocator
    Given automation mode is set to "background"
    When hover action is issued with a valid uid
    Then mouseover and mouseenter events should be dispatched
    And result should have mode "background"

  Scenario: Missing uid is rejected in background mode
    Given automation mode is set to "background"
    When action is issued without uid or ref
    Then result should be an error
    And error should indicate uid/ref is required

  Scenario: Unsupported action kind is rejected in background mode
    Given automation mode is set to "background"
    When action kind is not click, fill, type, or hover
    Then result should be an error
    And error should indicate the kind is not supported
    And action should not fallback to CDP

  Scenario: Element not found returns retryable error
    Given automation mode is set to "background"
    When action targets a uid that does not exist in the DOM
    Then result should be an error with code E_DOM_ACTION_FAILED
    And error should be marked retryable

  Scenario: Focus mode uses CDP action path unchanged
    Given automation mode is set to "focus"
    When click action is issued
    Then action should use CDP Input.dispatch path
    And result should not have mode "background"
