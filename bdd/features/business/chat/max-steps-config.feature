@contract(BHV-CHAT-MAX-STEPS-CONFIG)
Feature: Configure maximum loop steps in settings

  Scenario: Change max steps in settings and verify persistence
    Given sidepanel is open and system is idle
    When user opens settings panel
    And user changes "Max Steps" to 20
    And user clicks "Apply & Restart System"
    Then settings should be saved successfully
    And "Max Steps" should remain 20 after re-opening settings

  Scenario: System enforces user-configured max steps
    Given "Max Steps" is configured to 2
    When user sends a prompt that requires many steps
    Then the loop should terminate with "max_steps" status after 2 steps
    And assistant should message "已达到最大步数 2"
