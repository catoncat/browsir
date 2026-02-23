@contract(BHV-CHAT-STREAMING-MESSAGE-CONTAINER)
Feature: Streaming message container isolates incremental updates

  Scenario: Streaming updates do not force full stable list rerender
    Given sidepanel has existing stable messages
    And assistant starts streaming a new reply
    When token deltas are received continuously
    Then deltas should update the streaming container
    And stable message list should remain structurally unchanged during stream

  Scenario: Stream completion flushes and clears container
    Given a streaming reply has partial content in container
    When streaming completes normally
    Then final message should appear in stable list
    And streaming container should be cleared
