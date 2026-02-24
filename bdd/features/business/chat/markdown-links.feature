@contract(BHV-CHAT-MARKDOWN-LINKS)
Feature: Markdown links are clickable and secure

  Scenario: Assistant message links open in new tab
    Given assistant sends a message containing "[Google](https://google.com)"
    Then the message should contain a link with text "Google"
    And the link should have attribute "target" set to "_blank"
    And the link should have attribute "rel" containing "noopener"

  Scenario: User message links are also rendered as clickable
    When user sends a message containing "Check this: https://example.com"
    Then the user bubble should contain a clickable link to "https://example.com"
