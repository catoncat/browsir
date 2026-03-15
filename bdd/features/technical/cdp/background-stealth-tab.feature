@contract(BHV-CDP-BACKGROUND-STEALTH-TAB)
Feature: Stealth tab creation in minimized window for background mode

  Scenario: Background mode creates tab in stealth window
    Given automation mode is set to "background"
    When local.create_new_tab is dispatched
    Then tab should be created in a minimized popup window
    And response should contain stealth annotation

  Scenario: Stealth window is reused for multiple tabs
    Given a stealth tab already exists
    When another stealth tab is created
    Then both tabs should share the same window
    And chrome.windows.create should be called only once

  Scenario: Blank tab from window creation is removed
    When a new stealth window is created
    Then the default blank tab should be automatically removed

  Scenario: Stealth window auto-closes when empty
    Given stealth window has one tab
    When the last stealth tab is closed
    Then the stealth window should be removed

  Scenario: External tab removal triggers cleanup
    Given a stealth tab exists
    When chrome.tabs.onRemoved fires for that tab
    Then stealth tracking should be cleaned up

  Scenario: Stealth window recreation after external close
    Given a stealth window was closed externally
    When a new stealth tab is created
    Then a new minimized window should be created

  Scenario: Focus mode creates normal tabs
    Given automation mode is set to "focus"
    When local.create_new_tab is dispatched
    Then tab should be created in the user's active window
    And response should not contain stealth annotation
