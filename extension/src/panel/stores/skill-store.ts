import { defineStore } from "pinia";
import { sendMessage } from "./send-message";
import { toRecord } from "./store-helpers";
import { useChatStore } from "./chat-store";

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

export interface SkillDiscoverRoot {
  root: string;
  source?: string;
}

export interface SkillDiscoverOptions {
  sessionId?: string;
  roots?: SkillDiscoverRoot[];
  autoInstall?: boolean;
  replace?: boolean;
  maxFiles?: number;
  timeoutMs?: number;
}

export interface SkillDiscoverResult {
  sessionId: string;
  roots: Array<{ root: string; source: string }>;
  counts: {
    scanned: number;
    discovered: number;
    installed: number;
    skipped: number;
  };
  discovered: Array<Record<string, unknown>>;
  installed: SkillMetadata[];
  skipped: Array<Record<string, unknown>>;
  skills?: SkillMetadata[];
}

function extractContentFromStepExecuteResult(value: unknown): string {
  const root = toRecord(value);
  const rootData = toRecord(root.data);
  const rootDataData = toRecord(rootData.data);
  const rootDataResponse = toRecord(rootData.response);
  const rootDataResponseData = toRecord(rootDataResponse.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates: unknown[] = [
    root.content,
    root.text,
    rootData.content,
    rootData.text,
    rootDataData.content,
    rootDataData.text,
    rootDataResponse.content,
    rootDataResponse.text,
    rootDataResponseData.content,
    rootDataResponseData.text,
    rootResponse.content,
    rootResponse.text,
    rootResponseData.content,
    rootResponseData.text,
    rootResponseInnerData.content,
    rootResponseInnerData.text,
    rootResult.content,
    rootResult.text,
  ];
  for (const item of candidates) {
    if (typeof item === "string") return item;
  }
  throw new Error("文件读取工具未返回 content 文本");
}

export const useSkillStore = defineStore("skill", () => {
  const chatStore = useChatStore();

  async function ensureSkillSessionId(
    inputSessionId?: string,
  ): Promise<string> {
    const provided = String(inputSessionId || "").trim();
    if (provided) return provided;
    const current = String(chatStore.activeSessionId || "").trim();
    if (current) return current;
    await chatStore.createSession();
    return chatStore.activeSessionId;
  }

  async function listSkills(): Promise<SkillMetadata[]> {
    const out = await sendMessage<{ skills: SkillMetadata[] }>(
      "brain.skill.list",
    );
    return Array.isArray(out.skills) ? out.skills : [];
  }

  async function readVirtualFile(
    path: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<string> {
    const sessionId = await ensureSkillSessionId();
    const step = await sendMessage<Record<string, unknown>>(
      "brain.step.execute",
      {
        sessionId,
        capability: "fs.read",
        action: "invoke",
        args: {
          frame: {
            tool: "read",
            args: {
              path: String(path || "").trim(),
              runtime: "sandbox",
              ...(options.offset == null ? {} : { offset: options.offset }),
              ...(options.limit == null ? {} : { limit: options.limit }),
            },
          },
        },
        verifyPolicy: "off",
      },
    );
    const result = toRecord(step);
    if (result.ok !== true) {
      throw new Error(String(result.error || "文件读取失败"));
    }
    return extractContentFromStepExecuteResult(result.data);
  }

  async function writeVirtualFile(
    path: string,
    content: string,
    mode: "overwrite" | "append" | "create" = "overwrite",
  ): Promise<void> {
    const sessionId = await ensureSkillSessionId();
    const step = await sendMessage<Record<string, unknown>>(
      "brain.step.execute",
      {
        sessionId,
        capability: "fs.write",
        action: "invoke",
        args: {
          frame: {
            tool: "write",
            args: {
              path: String(path || "").trim(),
              runtime: "sandbox",
              content: String(content || ""),
              mode,
            },
          },
        },
        verifyPolicy: "off",
      },
    );
    const result = toRecord(step);
    if (result.ok !== true) {
      throw new Error(String(result.error || "文件写入失败"));
    }
  }

  async function installSkill(
    input: SkillInstallInput,
    options: { replace?: boolean } = {},
  ): Promise<SkillMetadata> {
    const payload: Record<string, unknown> = {
      skill: {
        ...input,
      },
    };
    if (options.replace === true) payload.replace = true;
    const out = await sendMessage<{ skill: SkillMetadata }>(
      "brain.skill.install",
      payload,
    );
    return out.skill;
  }

  async function enableSkill(skillId: string): Promise<SkillMetadata> {
    const out = await sendMessage<{ skill: SkillMetadata }>(
      "brain.skill.enable",
      { skillId },
    );
    return out.skill;
  }

  async function disableSkill(skillId: string): Promise<SkillMetadata> {
    const out = await sendMessage<{ skill: SkillMetadata }>(
      "brain.skill.disable",
      { skillId },
    );
    return out.skill;
  }

  async function uninstallSkill(skillId: string): Promise<boolean> {
    const out = await sendMessage<{ removed: boolean }>(
      "brain.skill.uninstall",
      { skillId },
    );
    return out.removed === true;
  }

  async function discoverSkills(
    options: SkillDiscoverOptions = {},
  ): Promise<SkillDiscoverResult> {
    const sessionId = await ensureSkillSessionId(options.sessionId);
    const out = await sendMessage<SkillDiscoverResult>("brain.skill.discover", {
      sessionId,
      ...(Array.isArray(options.roots) && options.roots.length > 0
        ? { roots: options.roots }
        : {}),
      ...(options.autoInstall === undefined
        ? {}
        : { autoInstall: options.autoInstall }),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
      ...(options.maxFiles == null ? {} : { maxFiles: options.maxFiles }),
      ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs }),
    });
    return out;
  }

  async function runSkill(skillId: string, argsText = ""): Promise<void> {
    const id = String(skillId || "").trim();
    if (!id) {
      throw new Error("skillId 不能为空");
    }
    const args = String(argsText || "").trim();
    const prompt = args ? `/skill:${id} ${args}` : `/skill:${id}`;
    await chatStore.sendPrompt(prompt);
  }

  return {
    listSkills,
    readVirtualFile,
    writeVirtualFile,
    installSkill,
    enableSkill,
    disableSkill,
    uninstallSkill,
    discoverSkills,
    runSkill,
  };
});
