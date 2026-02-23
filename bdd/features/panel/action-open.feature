@contract(BHV-PANEL-ACTION-OPEN)
Feature: Clicking extension action opens side panel

  Scenario: side panel opens on action click
    Given side panel behavior is initialized
    When user clicks extension action icon
    Then side panel should be opened
