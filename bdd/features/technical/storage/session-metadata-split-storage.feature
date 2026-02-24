@contract(BHV-SESSION-METADATA-SPLIT-STORAGE)
Feature: Session data and metadata are stored separately and consistently

  Scenario: Save session writes both data and metadata views
    Given a conversation with messages and trace exists
    When sidepanel persists session state
    Then session data store should contain full conversation payload
    And metadata store should contain lightweight list fields

  Scenario: Recover metadata from data when metadata is missing
    Given session data exists but metadata record is missing
    When sidepanel loads session list
    Then system should rebuild metadata from session data
    And conversation detail should remain readable
