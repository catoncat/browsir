import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  buildObserveProgressVerify,
  shouldVerifyStep,
  actionRequiresLease,
  shouldAcquireLease,
  isToolCallRequiringBrowserProof,
  didToolProvideBrowserProof,
  mapToolErrorReasonToTerminalStatus,
} from "../loop-browser-proof";

describe("loop-browser-proof", () => {
  describe("buildObserveProgressVerify", () => {
    it("detects URL change as progress", () => {
      const before = { page: { url: "https://a.com", title: "A", textLength: 100, nodeCount: 50 } };
      const after = { page: { url: "https://b.com", title: "A", textLength: 100, nodeCount: 50 } };
      const result = buildObserveProgressVerify(before, after);
      expect(result.ok).toBe(true);
    });

    it("detects title change as progress", () => {
      const before = { page: { url: "https://a.com", title: "A", textLength: 100, nodeCount: 50 } };
      const after = { page: { url: "https://a.com", title: "B", textLength: 100, nodeCount: 50 } };
      const result = buildObserveProgressVerify(before, after);
      expect(result.ok).toBe(true);
    });

    it("detects text-only change as progress", () => {
      const before = { page: { url: "https://a.com", title: "A", textLength: 100, nodeCount: 50 } };
      const textOnly = { page: { url: "https://a.com", title: "A", textLength: 200, nodeCount: 50 } };
      expect(buildObserveProgressVerify(before, textOnly).ok).toBe(true);

      const both = { page: { url: "https://a.com", title: "A", textLength: 200, nodeCount: 70 } };
      expect(buildObserveProgressVerify(before, both).ok).toBe(true);
    });

    it("returns not-ok when nothing changed", () => {
      const page = { page: { url: "https://a.com", title: "A", textLength: 100, nodeCount: 50 } };
      const result = buildObserveProgressVerify(page, page);
      expect(result.ok).toBe(false);
    });

    it("handles null/undefined inputs gracefully", () => {
      const result = buildObserveProgressVerify(null, null);
      expect(result.ok).toBe(false);
    });
  });

  describe("shouldVerifyStep", () => {
    it("returns false when policy is off", () => {
      expect(shouldVerifyStep("click", "off")).toBe(false);
    });

    it("returns true when policy is always", () => {
      expect(shouldVerifyStep("read_file", "always")).toBe(true);
    });

    it("returns true for critical actions with default policy", () => {
      for (const action of ["click", "type", "fill", "press", "scroll", "select", "navigate", "action"]) {
        expect(shouldVerifyStep(action, "on_critical")).toBe(true);
      }
    });

    it("returns false for non-critical actions with default policy", () => {
      expect(shouldVerifyStep("read_file", "on_critical")).toBe(false);
      expect(shouldVerifyStep("get_page_metadata", undefined)).toBe(false);
    });
  });

  describe("actionRequiresLease", () => {
    it("returns true for UI-mutating actions", () => {
      for (const kind of ["click", "type", "fill", "press", "scroll", "select", "navigate", "hover"]) {
        expect(actionRequiresLease(kind)).toBe(true);
      }
    });

    it("returns false for read-only actions", () => {
      expect(actionRequiresLease("observe")).toBe(false);
      expect(actionRequiresLease("screenshot")).toBe(false);
    });
  });

  describe("shouldAcquireLease", () => {
    it("returns false when leasePolicy is none", () => {
      expect(shouldAcquireLease("click", { leasePolicy: "none" } as any)).toBe(false);
    });

    it("returns true when leasePolicy is required", () => {
      expect(shouldAcquireLease("observe", { leasePolicy: "required" } as any)).toBe(true);
    });

    it("delegates to actionRequiresLease on auto", () => {
      expect(shouldAcquireLease("click", { leasePolicy: "auto" } as any)).toBe(true);
      expect(shouldAcquireLease("observe", { leasePolicy: "auto" } as any)).toBe(false);
    });
  });

  describe("isToolCallRequiringBrowserProof", () => {
    it("returns true for browser proof tool names", () => {
      expect(isToolCallRequiringBrowserProof("{}", "click")).toBe(true);
    });

    it("returns false for non-proof tools", () => {
      expect(isToolCallRequiringBrowserProof("{}", "get_page_metadata")).toBe(false);
    });

    it("filters computer tool by action", () => {
      expect(isToolCallRequiringBrowserProof('{"action":"click"}', "computer")).toBe(true);
      expect(isToolCallRequiringBrowserProof('{"action":"wait"}', "computer")).toBe(false);
      expect(isToolCallRequiringBrowserProof('{"action":"scroll"}', "computer")).toBe(false);
    });
  });

  describe("didToolProvideBrowserProof", () => {
    it("detects direct verified flag", () => {
      expect(didToolProvideBrowserProof("click", { verified: true })).toBe(true);
    });

    it("detects verifyReason=verified", () => {
      expect(didToolProvideBrowserProof("click", { verifyReason: "verified" })).toBe(true);
    });

    it("detects browser_verify ok=true", () => {
      expect(didToolProvideBrowserProof("browser_verify", { data: { ok: true } })).toBe(true);
    });

    it("detects nested verify ok=true", () => {
      expect(didToolProvideBrowserProof("click", { data: { verify: { ok: true } } })).toBe(true);
    });

    it("returns false when no proof present", () => {
      expect(didToolProvideBrowserProof("click", {})).toBe(false);
    });
  });

  describe("mapToolErrorReasonToTerminalStatus", () => {
    it("maps failed_verify", () => {
      expect(mapToolErrorReasonToTerminalStatus("failed_verify")).toBe("failed_verify");
    });

    it("maps progress_uncertain", () => {
      expect(mapToolErrorReasonToTerminalStatus("progress_uncertain")).toBe("progress_uncertain");
    });

    it("defaults to failed_execute", () => {
      expect(mapToolErrorReasonToTerminalStatus("unknown")).toBe("failed_execute");
      expect(mapToolErrorReasonToTerminalStatus(null)).toBe("failed_execute");
    });
  });
});
