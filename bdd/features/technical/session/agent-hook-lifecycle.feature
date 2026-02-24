@contract(BHV-AGENT-HOOK-LIFECYCLE)
Feature: Agent hook lifecycle remains deterministic and isolated

  Scenario: Hook block does not crash runtime execution
    Given step pipeline has a tool.before_call hook returning block
    When kernel executes brain.step.execute
    Then response should be controlled failure instead of unhandled exception
    And script to cdp fallback semantics should remain unchanged for non-hook errors

  Scenario: Hook patch can adjust result without breaking loop invariants
    Given step pipeline has a tool.after_result hook returning patch
    When kernel executes brain.step.execute
    Then response data should reflect patched result
    And verify reason semantics should remain compatible

  Scenario: Runtime route and compaction hooks are emitted on critical paths
    Given runtime router receives brain.agent.end and compaction-triggering session state
    When orchestrator handles agent end and compaction
    Then runtime.route.before and runtime.route.after hooks should be observable
    And compaction.before and compaction.after hooks should be observable
