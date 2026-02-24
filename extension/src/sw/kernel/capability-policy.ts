import type { ExecuteCapability, ExecuteMode } from "./types";

export type StepVerifyPolicy = "off" | "on_critical" | "always";

export interface CapabilityExecutionPolicy {
  fallbackMode?: ExecuteMode;
  defaultVerifyPolicy?: StepVerifyPolicy;
  leasePolicy?: "auto" | "required" | "none";
  allowScriptFallback?: boolean;
}

export interface RegisterCapabilityPolicyOptions {
  replace?: boolean;
  id?: string;
}

interface PolicyEntry {
  id: string;
  policy: CapabilityExecutionPolicy;
}

const BUILTIN_POLICY_TABLE: Record<string, CapabilityExecutionPolicy> = {
  "process.exec": {
    fallbackMode: "bridge",
    defaultVerifyPolicy: "off",
    leasePolicy: "none",
    allowScriptFallback: false
  },
  "fs.read": {
    fallbackMode: "bridge",
    defaultVerifyPolicy: "off",
    leasePolicy: "none",
    allowScriptFallback: false
  },
  "fs.write": {
    fallbackMode: "bridge",
    defaultVerifyPolicy: "off",
    leasePolicy: "none",
    allowScriptFallback: false
  },
  "fs.edit": {
    fallbackMode: "bridge",
    defaultVerifyPolicy: "off",
    leasePolicy: "none",
    allowScriptFallback: false
  },
  "browser.snapshot": {
    fallbackMode: "cdp",
    defaultVerifyPolicy: "off",
    leasePolicy: "none",
    allowScriptFallback: false
  },
  "browser.action": {
    fallbackMode: "cdp",
    defaultVerifyPolicy: "on_critical",
    leasePolicy: "auto",
    allowScriptFallback: true
  },
  "browser.verify": {
    fallbackMode: "cdp",
    defaultVerifyPolicy: "always",
    leasePolicy: "none",
    allowScriptFallback: false
  }
};

function normalizeCapability(capability: ExecuteCapability): string {
  return String(capability || "").trim();
}

function normalizePolicy(policy: CapabilityExecutionPolicy): CapabilityExecutionPolicy {
  const next: CapabilityExecutionPolicy = {};
  if (policy.fallbackMode) next.fallbackMode = policy.fallbackMode;
  if (policy.defaultVerifyPolicy) next.defaultVerifyPolicy = policy.defaultVerifyPolicy;
  if (policy.leasePolicy) next.leasePolicy = policy.leasePolicy;
  if (typeof policy.allowScriptFallback === "boolean") {
    next.allowScriptFallback = policy.allowScriptFallback;
  }
  return next;
}

export class CapabilityPolicyRegistry {
  private readonly builtin = new Map<ExecuteCapability, CapabilityExecutionPolicy>();
  private readonly overrides = new Map<ExecuteCapability, PolicyEntry>();

  constructor(policyTable: Record<string, CapabilityExecutionPolicy> = BUILTIN_POLICY_TABLE) {
    for (const [capability, policy] of Object.entries(policyTable)) {
      this.builtin.set(capability, normalizePolicy(policy));
    }
  }

  register(capability: ExecuteCapability, policy: CapabilityExecutionPolicy, options: RegisterCapabilityPolicyOptions = {}): string {
    const key = normalizeCapability(capability);
    if (!key) throw new Error("capability 不能为空");

    const current = this.overrides.get(key);
    if (current && !options.replace) {
      throw new Error(`capability policy already registered: ${key}`);
    }

    const id = String(options.id || "").trim() || `policy:${key}`;
    this.overrides.set(key, {
      id,
      policy: normalizePolicy(policy)
    });
    return id;
  }

  unregister(capability: ExecuteCapability, expectedPolicyId?: string): boolean {
    const key = normalizeCapability(capability);
    const current = this.overrides.get(key);
    if (!current) return false;
    if (expectedPolicyId && current.id !== expectedPolicyId) return false;
    return this.overrides.delete(key);
  }

  get(capability: ExecuteCapability): {
    capability: ExecuteCapability;
    source: "builtin" | "override";
    id: string;
    policy: CapabilityExecutionPolicy;
  } | null {
    const key = normalizeCapability(capability);
    if (!key) return null;

    const override = this.overrides.get(key);
    if (override) {
      return {
        capability: key,
        source: "override",
        id: override.id,
        policy: normalizePolicy(override.policy)
      };
    }

    const builtin = this.builtin.get(key);
    if (!builtin) return null;
    return {
      capability: key,
      source: "builtin",
      id: `builtin:${key}`,
      policy: normalizePolicy(builtin)
    };
  }

  resolve(capability?: ExecuteCapability): CapabilityExecutionPolicy {
    const key = normalizeCapability(capability || "");
    if (!key) return {};
    const builtin = this.builtin.get(key) || {};
    const override = this.overrides.get(key)?.policy || {};
    return {
      ...normalizePolicy(builtin),
      ...normalizePolicy(override)
    };
  }

  list(): Array<{
    capability: ExecuteCapability;
    source: "builtin" | "override";
    id: string;
    policy: CapabilityExecutionPolicy;
  }> {
    const keys = new Set<string>([...this.builtin.keys(), ...this.overrides.keys()]);
    return Array.from(keys.values())
      .sort((a, b) => a.localeCompare(b))
      .map((capability) => this.get(capability))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  }
}
