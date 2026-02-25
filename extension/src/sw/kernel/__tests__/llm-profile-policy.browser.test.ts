import { describe, expect, it } from "vitest";
import { decideProfileEscalation } from "../llm-profile-policy";

describe("llm-profile-policy.browser", () => {
  it("escalates to next profile when repeated failure happens", () => {
    const decision = decideProfileEscalation({
      orderedProfiles: ["worker.basic", "worker.pro", "worker.max"],
      currentProfile: "worker.basic",
      repeatedFailure: true
    });

    expect(decision).toEqual({
      type: "escalate",
      reason: "repeated_failure",
      profile: "worker.basic",
      nextProfile: "worker.pro"
    });
  });

  it("does not escalate when repeated failure condition is not met", () => {
    const decision = decideProfileEscalation({
      orderedProfiles: ["worker.basic", "worker.pro"],
      currentProfile: "worker.basic",
      repeatedFailure: false
    });

    expect(decision).toEqual({
      type: "no_change",
      reason: "not_repeated_failure",
      profile: "worker.basic"
    });
  });

  it("blocks escalation when current profile is already highest", () => {
    const decision = decideProfileEscalation({
      orderedProfiles: ["worker.basic", "worker.pro"],
      currentProfile: "worker.pro",
      repeatedFailure: true
    });

    expect(decision).toEqual({
      type: "blocked",
      reason: "no_higher_profile",
      profile: "worker.pro"
    });
  });

  it("blocks escalation for unknown profile", () => {
    const decision = decideProfileEscalation({
      orderedProfiles: ["worker.basic", "worker.pro"],
      currentProfile: "worker.unknown",
      repeatedFailure: true
    });

    expect(decision).toEqual({
      type: "blocked",
      reason: "unknown_profile",
      profile: "worker.unknown"
    });
  });

  it("supports explicit disabled policy", () => {
    const decision = decideProfileEscalation({
      orderedProfiles: ["worker.basic", "worker.pro"],
      currentProfile: "worker.basic",
      repeatedFailure: true,
      policy: "disabled"
    });

    expect(decision).toEqual({
      type: "no_change",
      reason: "policy_disabled",
      profile: "worker.basic"
    });
  });
});
