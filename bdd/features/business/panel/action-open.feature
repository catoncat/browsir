@contract(BHV-PANEL-ACTION-OPEN)
Feature: Clicking extension action opens side panel

  Scenario: side panel opens on action click
    Given extension action is available and side panel permission is granted
    When user clicks extension action icon
    Then side panel should be opened for current tab
    And runtime should remain responsive
