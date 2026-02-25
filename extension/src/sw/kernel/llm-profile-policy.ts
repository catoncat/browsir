export type LlmProfileEscalationPolicy = "upgrade_only" | "disabled";

export interface DecideProfileEscalationInput {
  orderedProfiles: string[];
  currentProfile: string;
  repeatedFailure: boolean;
  policy?: LlmProfileEscalationPolicy;
}

export type ProfileEscalationDecision =
  | {
      type: "no_change";
      reason: "policy_disabled" | "not_repeated_failure";
      profile: string;
    }
  | {
      type: "escalate";
      reason: "repeated_failure";
      profile: string;
      nextProfile: string;
    }
  | {
      type: "blocked";
      reason: "unknown_profile" | "no_higher_profile";
      profile: string;
    };

export function decideProfileEscalation(input: DecideProfileEscalationInput): ProfileEscalationDecision {
  const policy = input.policy || "upgrade_only";
  const orderedProfiles = Array.isArray(input.orderedProfiles)
    ? input.orderedProfiles.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const currentProfile = String(input.currentProfile || "").trim();

  if (policy === "disabled") {
    return {
      type: "no_change",
      reason: "policy_disabled",
      profile: currentProfile
    };
  }

  if (!input.repeatedFailure) {
    return {
      type: "no_change",
      reason: "not_repeated_failure",
      profile: currentProfile
    };
  }

  const currentIndex = orderedProfiles.indexOf(currentProfile);
  if (currentIndex < 0) {
    return {
      type: "blocked",
      reason: "unknown_profile",
      profile: currentProfile
    };
  }

  const nextProfile = orderedProfiles[currentIndex + 1];
  if (!nextProfile) {
    return {
      type: "blocked",
      reason: "no_higher_profile",
      profile: currentProfile
    };
  }

  return {
    type: "escalate",
    reason: "repeated_failure",
    profile: currentProfile,
    nextProfile
  };
}
