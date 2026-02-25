import { SkillRegistry, type SkillMetadata } from "./skill-registry";

export interface SkillContentReadInput {
  location: string;
  skill: SkillMetadata;
  sessionId?: string;
  capability?: string;
}

export type SkillContentReader = (input: SkillContentReadInput) => Promise<string>;

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

export class SkillContentResolver {
  private reader: SkillContentReader;

  constructor(
    private readonly registry: SkillRegistry,
    options: {
      readText?: SkillContentReader;
    } = {}
  ) {
    this.reader = options.readText || defaultReader;
  }

  setReader(readText: SkillContentReader): void {
    this.reader = readText;
  }

  private buildPromptBlock(skill: SkillMetadata, content: string): string {
    const attrs = [
      `id="${escapeXmlAttribute(skill.id)}"`,
      `name="${escapeXmlAttribute(skill.name)}"`,
      `location="${escapeXmlAttribute(skill.location)}"`,
      `source="${escapeXmlAttribute(skill.source)}"`
    ];
    if (skill.disableModelInvocation) {
      attrs.push('disable-model-invocation="true"');
    }
    return `<skill ${attrs.join(" ")}>\n${content}\n</skill>`;
  }

  async resolveById(skillId: string, options: ResolveSkillContentOptions = {}): Promise<ResolvedSkillContent> {
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
    return {
      skill,
      content,
      promptBlock: this.buildPromptBlock(skill, content)
    };
  }
}
