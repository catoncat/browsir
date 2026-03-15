import { describe, expect, it, beforeEach } from "vitest";
import {
  recordBackgroundSuccess,
  recordBackgroundFailure,
  shouldSuggestUpgrade,
  getConsecutiveFailures,
  buildUpgradeHint,
  clearTabFailureState,
  resetAllFailureState,
} from "../background-failure-tracker";

describe("background-failure-tracker", () => {
  beforeEach(() => {
    resetAllFailureState();
  });

  it("starts with zero failures", () => {
    expect(getConsecutiveFailures(1)).toBe(0);
    expect(shouldSuggestUpgrade(1)).toBe(false);
  });

  it("increments on failure", () => {
    recordBackgroundFailure(1);
    expect(getConsecutiveFailures(1)).toBe(1);
    recordBackgroundFailure(1);
    expect(getConsecutiveFailures(1)).toBe(2);
  });

  it("resets on success", () => {
    recordBackgroundFailure(1);
    recordBackgroundFailure(1);
    recordBackgroundSuccess(1);
    expect(getConsecutiveFailures(1)).toBe(0);
  });

  it("suggests upgrade after threshold (3) consecutive failures", () => {
    recordBackgroundFailure(10);
    recordBackgroundFailure(10);
    expect(shouldSuggestUpgrade(10)).toBe(false);
    recordBackgroundFailure(10);
    expect(shouldSuggestUpgrade(10)).toBe(true);
  });

  it("does not suggest upgrade after a success resets count", () => {
    recordBackgroundFailure(5);
    recordBackgroundFailure(5);
    recordBackgroundFailure(5);
    expect(shouldSuggestUpgrade(5)).toBe(true);
    recordBackgroundSuccess(5);
    expect(shouldSuggestUpgrade(5)).toBe(false);
  });

  it("tracks tabs independently", () => {
    recordBackgroundFailure(1);
    recordBackgroundFailure(1);
    recordBackgroundFailure(1);
    recordBackgroundFailure(2);
    expect(shouldSuggestUpgrade(1)).toBe(true);
    expect(shouldSuggestUpgrade(2)).toBe(false);
  });

  it("buildUpgradeHint returns null below threshold", () => {
    recordBackgroundFailure(1);
    expect(buildUpgradeHint(1)).toBeNull();
  });

  it("buildUpgradeHint returns hint at threshold", () => {
    recordBackgroundFailure(1);
    recordBackgroundFailure(1);
    recordBackgroundFailure(1);
    const hint = buildUpgradeHint(1);
    expect(hint).not.toBeNull();
    expect(hint!.upgrade_suggested).toBe(true);
    expect(hint!.reason).toBe("consecutive_background_failures");
    expect(hint!.consecutive_failures).toBe(3);
    expect(hint!.threshold).toBe(3);
    expect(typeof hint!.recommendation).toBe("string");
  });

  it("clearTabFailureState removes tracking for a tab", () => {
    recordBackgroundFailure(1);
    recordBackgroundFailure(1);
    recordBackgroundFailure(1);
    clearTabFailureState(1);
    expect(getConsecutiveFailures(1)).toBe(0);
    expect(shouldSuggestUpgrade(1)).toBe(false);
  });

  it("resetAllFailureState clears all tabs", () => {
    recordBackgroundFailure(1);
    recordBackgroundFailure(2);
    recordBackgroundFailure(3);
    resetAllFailureState();
    expect(getConsecutiveFailures(1)).toBe(0);
    expect(getConsecutiveFailures(2)).toBe(0);
    expect(getConsecutiveFailures(3)).toBe(0);
  });
});
