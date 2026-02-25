import { kvGet, kvSet } from "./idb-storage";
import { nowIso, randomId } from "./types";

export const SKILL_REGISTRY_META_KEY = "skills:meta:v1";

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  location: string;
  source: string;
  enabled: boolean;
  disableModelInvocation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillInstallInput {
  id?: string;
  name?: string;
  description?: string;
  location: string;
  source?: string;
  enabled?: boolean;
  disableModelInvocation?: boolean;
}

interface SkillRegistryState {
  version: 1;
  skills: SkillMetadata[];
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeSkillId(value: unknown): string {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text;
}

function toNameFallback(id: string): string {
  return id
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .trim();
}

function cloneSkill(skill: SkillMetadata): SkillMetadata {
  return { ...skill };
}

function normalizeStoredSkill(value: unknown): SkillMetadata | null {
  const raw = toRecord(value);
  const id = normalizeSkillId(raw.id);
  const location = String(raw.location || "").trim();
  if (!id || !location) return null;

  const nameRaw = String(raw.name || "").trim();
  const source = String(raw.source || "project").trim() || "project";
  const createdAt = String(raw.createdAt || "").trim() || nowIso();
  const updatedAt = String(raw.updatedAt || "").trim() || createdAt;

  return {
    id,
    name: nameRaw || toNameFallback(id) || id,
    description: String(raw.description || "").trim(),
    location,
    source,
    enabled: raw.enabled !== false,
    disableModelInvocation: raw.disableModelInvocation === true,
    createdAt,
    updatedAt
  };
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillMetadata>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutateTail: Promise<void> = Promise.resolve();

  private queueMutation<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutateTail.then(run, run);
    this.mutateTail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = (async () => {
      try {
        const raw = await kvGet(SKILL_REGISTRY_META_KEY);
        const state = toRecord(raw);
        const candidates = Array.isArray(state.skills) ? state.skills : [];
        this.skills.clear();
        for (const item of candidates) {
          const normalized = normalizeStoredSkill(item);
          if (!normalized) continue;
          this.skills.set(normalized.id, normalized);
        }
        this.loaded = true;
      } finally {
        this.loadPromise = null;
      }
    })();

    await this.loadPromise;
  }

  private async persist(): Promise<void> {
    const payload: SkillRegistryState = {
      version: 1,
      skills: Array.from(this.skills.values()).map((item) => cloneSkill(item))
    };
    await kvSet(SKILL_REGISTRY_META_KEY, payload);
  }

  async list(): Promise<SkillMetadata[]> {
    await this.ensureLoaded();
    return Array.from(this.skills.values())
      .map((item) => cloneSkill(item))
      .sort((a, b) => {
        const byName = a.name.localeCompare(b.name);
        if (byName !== 0) return byName;
        return a.id.localeCompare(b.id);
      });
  }

  async get(skillId: string): Promise<SkillMetadata | null> {
    await this.ensureLoaded();
    const id = normalizeSkillId(skillId);
    if (!id) return null;
    const found = this.skills.get(id);
    return found ? cloneSkill(found) : null;
  }

  async install(input: SkillInstallInput, options: { replace?: boolean } = {}): Promise<SkillMetadata> {
    return this.queueMutation(async () => {
      await this.ensureLoaded();
      const record = toRecord(input);
      const location = String(record.location || "").trim();
      if (!location) throw new Error("skill.location 不能为空");

      const id = normalizeSkillId(record.id || record.name || location || randomId("skill"));
      if (!id) throw new Error("skill.id 不能为空");

      const existing = this.skills.get(id);
      if (existing && !options.replace) {
        throw new Error(`skill already exists: ${id}`);
      }

      const now = nowIso();
      const name = String(record.name || "").trim() || toNameFallback(id) || id;
      const skill: SkillMetadata = {
        id,
        name,
        description: String(record.description || "").trim(),
        location,
        source: String(record.source || "project").trim() || "project",
        enabled: record.enabled !== false,
        disableModelInvocation: record.disableModelInvocation === true,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };

      this.skills.set(id, skill);
      await this.persist();
      return cloneSkill(skill);
    });
  }

  async enable(skillId: string): Promise<SkillMetadata> {
    return this.queueMutation(async () => {
      await this.ensureLoaded();
      const id = normalizeSkillId(skillId);
      const current = this.skills.get(id);
      if (!current) throw new Error(`skill 不存在: ${skillId}`);
      if (current.enabled) return cloneSkill(current);

      const next: SkillMetadata = {
        ...current,
        enabled: true,
        updatedAt: nowIso()
      };
      this.skills.set(id, next);
      await this.persist();
      return cloneSkill(next);
    });
  }

  async disable(skillId: string): Promise<SkillMetadata> {
    return this.queueMutation(async () => {
      await this.ensureLoaded();
      const id = normalizeSkillId(skillId);
      const current = this.skills.get(id);
      if (!current) throw new Error(`skill 不存在: ${skillId}`);
      if (!current.enabled) return cloneSkill(current);

      const next: SkillMetadata = {
        ...current,
        enabled: false,
        updatedAt: nowIso()
      };
      this.skills.set(id, next);
      await this.persist();
      return cloneSkill(next);
    });
  }

  async uninstall(skillId: string): Promise<boolean> {
    return this.queueMutation(async () => {
      await this.ensureLoaded();
      const id = normalizeSkillId(skillId);
      if (!id || !this.skills.has(id)) return false;
      this.skills.delete(id);
      await this.persist();
      return true;
    });
  }
}
