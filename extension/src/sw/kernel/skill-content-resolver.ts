import { SkillRegistry, type SkillMetadata } from "./skill-registry";

export interface SkillContentReadInput {
  location: string;
  skill: SkillMetadata;
  sessionId?: string;
  capability?: string;
}

export type SkillContentReader = (input: SkillContentReadInput) => Promise<string>;

export interface SkillPromptAugmentInput {
  skill: SkillMetadata;
  content: string;
  sessionId?: string;
  capability?: string;
}

export type SkillPromptAugmenter = (
  input: SkillPromptAugmentInput,
) => Promise<string>;

export interface ResolvedSkillContent {
  skill: SkillMetadata;
  content: string;
  promptBlock: string;
}

export interface ResolveSkillContentOptions {
  allowDisabled?: boolean;
  sessionId?: string;
  capability?: string;
}

interface SkillResolveStat {
  skillId: string;
  resolveCount: number;
  errorCount: number;
  lastResolvedAt?: string;
  lastSessionId?: string;
  lastCapability?: string;
  lastError?: string;
}

export interface SkillResolverDebugView {
  summary: {
    resolveCount: number;
    errorCount: number;
    trackedSkillCount: number;
    lastResolvedAt?: string;
    lastSkillId?: string;
    lastError?: string;
  };
  bySkill: SkillResolveStat[];
}

function escapeXmlAttribute(input: string): string {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function defaultReader(): Promise<string> {
  return Promise.reject(new Error("skill content reader 未配置"));
}

function defaultPromptAugmenter(): Promise<string> {
  return Promise.reject(new Error("skill prompt augmenter 未配置"));
}

export class SkillContentResolver {
  private reader: SkillContentReader;
  private promptAugmenter: SkillPromptAugmenter;
  private resolveCount = 0;
  private errorCount = 0;
  private lastResolvedAt = "";
  private lastSkillId = "";
  private lastError = "";
  private readonly statsBySkill = new Map<string, SkillResolveStat>();

  constructor(
    private readonly registry: SkillRegistry,
    options: {
      readText?: SkillContentReader;
      buildPromptAugment?: SkillPromptAugmenter;
    } = {}
  ) {
    this.reader = options.readText || defaultReader;
    this.promptAugmenter = options.buildPromptAugment || defaultPromptAugmenter;
  }

  setReader(readText: SkillContentReader): void {
    this.reader = readText;
  }

  setPromptAugmenter(buildPromptAugment: SkillPromptAugmenter): void {
    this.promptAugmenter = buildPromptAugment;
  }

  getDebugView(): SkillResolverDebugView {
    return {
      summary: {
        resolveCount: this.resolveCount,
        errorCount: this.errorCount,
        trackedSkillCount: this.statsBySkill.size,
        ...(this.lastResolvedAt ? { lastResolvedAt: this.lastResolvedAt } : {}),
        ...(this.lastSkillId ? { lastSkillId: this.lastSkillId } : {}),
        ...(this.lastError ? { lastError: this.lastError } : {})
      },
      bySkill: Array.from(this.statsBySkill.values())
        .map((item) => ({ ...item }))
        .sort((a, b) => {
          const byError = b.errorCount - a.errorCount;
          if (byError !== 0) return byError;
          const byResolve = b.resolveCount - a.resolveCount;
          if (byResolve !== 0) return byResolve;
          return a.skillId.localeCompare(b.skillId);
        })
    };
  }

  private touchSkillStat(skillId: string): SkillResolveStat {
    const id = String(skillId || "").trim();
    const current = this.statsBySkill.get(id);
    if (current) return current;
    const created: SkillResolveStat = {
      skillId: id,
      resolveCount: 0,
      errorCount: 0
    };
    this.statsBySkill.set(id, created);
    return created;
  }

  private buildPromptBlock(
    skill: SkillMetadata,
    content: string,
    promptAugment = "",
  ): string {
    const attrs = [
      `id="${escapeXmlAttribute(skill.id)}"`,
      `name="${escapeXmlAttribute(skill.name)}"`,
      `location="${escapeXmlAttribute(skill.location)}"`,
      `source="${escapeXmlAttribute(skill.source)}"`
    ];
    if (skill.disableModelInvocation) {
      attrs.push('disable-model-invocation="true"');
    }
    const body = [String(content || "").trim(), String(promptAugment || "").trim()]
      .filter(Boolean)
      .join("\n\n");
    return `<skill ${attrs.join(" ")}>\n${body}\n</skill>`;
  }

  async resolveById(skillId: string, options: ResolveSkillContentOptions = {}): Promise<ResolvedSkillContent> {
    const requestedSkillId = String(skillId || "").trim();
    const stat = this.touchSkillStat(requestedSkillId || "unknown");
    stat.resolveCount += 1;
    stat.lastSessionId = options.sessionId ? String(options.sessionId) : undefined;
    stat.lastCapability = options.capability ? String(options.capability) : undefined;
    this.resolveCount += 1;
    this.lastResolvedAt = new Date().toISOString();
    this.lastSkillId = requestedSkillId;
    try {
      const skill = await this.registry.get(skillId);
      if (!skill) throw new Error(`skill 不存在: ${skillId}`);
      if (!options.allowDisabled && !skill.enabled) {
        throw new Error(`skill 未启用: ${skill.id}`);
      }

      const content = await this.reader({
        location: skill.location,
        skill,
        sessionId: options.sessionId,
        capability: options.capability
      });
      const promptAugment = await this.promptAugmenter({
        skill,
        content,
        sessionId: options.sessionId,
        capability: options.capability,
      });
      stat.lastResolvedAt = this.lastResolvedAt;
      stat.lastError = undefined;
      return {
        skill,
        content,
        promptBlock: this.buildPromptBlock(skill, content, promptAugment)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errorCount += 1;
      this.lastError = message;
      stat.errorCount += 1;
      stat.lastError = message;
      throw error;
    }
  }
}
