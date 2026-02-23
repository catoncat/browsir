@contract(BHV-TAB-REF-DEFAULT)
Feature: Tab reference defaults to active tab with @ mention support

  Scenario: New conversation auto-selects active tab
    Given browser has at least one open tab
    When user creates a new conversation
    Then the active tab should be auto-selected in selectedTabIds
    And tab chips should display above the composer input

  Scenario: User dismisses a referenced tab
    Given a conversation has an auto-selected tab
    When user clicks the dismiss button on a tab chip
    Then that tab should be removed from selectedTabIds
    And tab chips above the composer should update accordingly

  Scenario: @ mention triggers tab picker popup
    Given user is typing in the composer
    When user types "@"
    Then a floating tab picker popup should appear above the textarea
    And popup should list all available tabs with checkboxes

  Scenario: Multi-select tabs via @ mention
    Given the @ mention popup is visible
    When user selects multiple tabs from the popup
    Then all selected tabs should be added to selectedTabIds
    And tab chips above the composer should display all selected tabs

  Scenario: Closing @ mention popup
    Given the @ mention popup is visible
    When user clicks outside the popup or presses Escape
    Then the popup should close
    And previously selected tabs should remain unchanged
