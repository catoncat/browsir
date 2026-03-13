import type { JsonRecord } from "./types";

export interface SnapshotEnrichmentContext {
  sessionId: string;
  origin: string;
  location: string;
  failureCounts?: Map<string, number>;
}

export interface SnapshotNode extends JsonRecord {
  uid: string;
  ref: string;
  role: string;
  name: string;
  value: string;
  axNodeId?: string | number;
  tag?: string;
  href?: string;
  depth?: number;
  parentId?: string;
  childIds?: string[];
  navType?: "nav" | "ext";
  failureCount?: number;
  visible?: boolean;
}

export interface SnapshotEnricher {
  id: string;
  enrich(nodes: SnapshotNode[], context: SnapshotEnrichmentContext): Promise<SnapshotNode[]>;
}

/**
 * HierarchyEnricher: Reconstructs depth information based on axNodeId/parentId
 */
export class HierarchyEnricher implements SnapshotEnricher {
  id = "hierarchy";
  async enrich(nodes: SnapshotNode[]): Promise<SnapshotNode[]> {
    const idToNode = new Map<string, SnapshotNode>();
    for (const node of nodes) {
      if (node.axNodeId) idToNode.set(String(node.axNodeId), node);
    }

    const computeDepth = (node: SnapshotNode, currentStack: Set<string>): number => {
      const parentId = String(node.parentId || "");
      if (!parentId || !idToNode.has(parentId) || currentStack.has(parentId)) return 0;
      currentStack.add(parentId);
      return 1 + computeDepth(idToNode.get(parentId)!, currentStack);
    };

    for (const node of nodes) {
      node.depth = computeDepth(node, new Set());
    }
    return nodes;
  }
}

/**
 * IntentEnricher: Generically identifies navigation and external links
 */
export class IntentEnricher implements SnapshotEnricher {
  id = "intent";
  async enrich(nodes: SnapshotNode[], context: SnapshotEnrichmentContext): Promise<SnapshotNode[]> {
    let originHost = "";
    try {
      originHost = new URL(context.origin).hostname;
    } catch {
      // ignore invalid origin
    }

    for (const node of nodes) {
      const tag = String(node.tag || "").toLowerCase();
      const role = String(node.role || "").toLowerCase();
      const isLink = role === "link" || role === "lnk" || tag === "a";
      const isContainer = tag === "article" || tag === "section" || (tag === "div" && role === "button");

      const href = String(node.href || "").trim();
      if (href) {
        try {
          const url = new URL(href, context.location);
          const isSameOrigin = url.hostname === originHost;
          const isLikelyDetail = /[\\/](status|p|item|detail|post|article|tweet)[\\/]/i.test(url.pathname);
          node.navType = isSameOrigin || isLikelyDetail ? "nav" : "ext";
        } catch {
          node.navType = "ext";
        }
      } else if (isContainer) {
        // For containers without direct href, check if they are likely wrappers
        const name = String(node.name || "").toLowerCase();
        if (name.includes("http") || name.includes("www.")) {
          node.navType = "ext";
        } else if (tag === "article" || role === "button") {
          node.navType = "nav";
        }
      }
    }
    return nodes;
  }
}

/**
 * SessionContextEnricher: Injects session-specific metadata like failure history
 */
export class SessionContextEnricher implements SnapshotEnricher {
  id = "session";
  async enrich(nodes: SnapshotNode[], context: SnapshotEnrichmentContext): Promise<SnapshotNode[]> {
    if (!context.failureCounts) return nodes;
    for (const node of nodes) {
      const count = context.failureCounts.get(node.uid) || context.failureCounts.get(node.ref);
      if (count) {
        node.failureCount = count;
      }
    }
    return nodes;
  }
}

/**
 * EnrichmentPipeline: Orchestrates multiple enrichers
 */
export class EnrichmentPipeline {
  private enrichers: SnapshotEnricher[] = [
    new HierarchyEnricher(),
    new IntentEnricher(),
    new SessionContextEnricher()
  ];

  async run(nodes: JsonRecord[], context: SnapshotEnrichmentContext): Promise<SnapshotNode[]> {
    let result = nodes as SnapshotNode[];
    for (const enricher of this.enrichers) {
      result = await enricher.enrich(result, context);
    }
    return result;
  }
}

export const defaultPipeline = new EnrichmentPipeline();
