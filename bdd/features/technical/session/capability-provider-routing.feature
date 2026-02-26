@contract(BHV-CAPABILITY-PROVIDER-ROUTING)
Feature: Capability provider routing decouples tool contract from execution object

  Scenario: 默认 mode providers 通过 provider registry 路由
    Given orchestrator is created with script and cdp mode providers
    When kernel executes brain.step.execute with capability browser.action and script mode fallback
    Then invoke should be routed via registered script provider
    And fallback should route to cdp provider only when script invocation fails
    And capability-only request should use policy fallback mode when mode is omitted

  Scenario: Capability provider can override mode-target binding
    Given capability provider fs.virtual.read is registered by plugin runtime
    When kernel executes brain.step.execute with capability fs.virtual.read
    Then invoke should be routed to capability provider
    And result should expose capabilityUsed in execution metadata

  Scenario: Missing provider reports stable adapter missing error
    Given script mode is requested and cdp provider is not registered
    When script invocation fails and fallback attempts cdp
    Then kernel should return or throw cdp adapter missing error with stable wording

  Scenario: Verify semantics remain stable after provider routing
    Given verify adapter is configured and provider routing is enabled
    When execute step completes through routed provider
    Then verifyReason should remain one of verified verify_failed verify_policy_off verify_adapter_missing
