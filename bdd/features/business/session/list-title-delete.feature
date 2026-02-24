@contract(BHV-SESSION-LIST-TITLE-DELETE)
Feature: session list title and delete controls

  Scenario: auto title, manual title refresh, and delete all work from session list
    Given a session completes at least one user and assistant round
    When the user opens Recent Chats
    Then the session row should show a short title field
    When the user triggers refresh title for the session
    Then the session title should be recomputed and persisted
    When the user triggers delete on the session row
    Then the session should be removed from session list and storage
