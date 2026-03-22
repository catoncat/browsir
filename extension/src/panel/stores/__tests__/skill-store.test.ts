import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useChatStore } from "../chat-store";
import { sendMessage } from "../send-message";
import {
  extractContentFromStepExecuteResult,
  useSkillStore,
} from "../skill-store";

vi.mock("../send-message", () => ({
  sendMessage: vi.fn(),
}));

describe("skill-store", () => {
  const sendMessageMock = vi.mocked(sendMessage);

  beforeEach(() => {
    setActivePinia(createPinia());
    sendMessageMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts nested read content from brain.step.execute payloads", () => {
    expect(
      extractContentFromStepExecuteResult({
        data: {
          data: {
            content: "# SKILL\nbody",
          },
        },
      }),
    ).toBe("# SKILL\nbody");
  });

  it("throws when no readable content field exists", () => {
    expect(() =>
      extractContentFromStepExecuteResult({
        data: {
          bytes: 12,
        },
      }),
    ).toThrow("文件读取工具未返回 content 文本");
  });

  it("saveSkill should route panel saves to brain.skill.save", async () => {
    const chatStore = useChatStore();
    chatStore.activeSessionId = "session-skill-save";
    const store = useSkillStore();

    sendMessageMock.mockResolvedValueOnce({
      skill: {
        id: "skill.demo",
        name: "Demo Skill",
        description: "demo description",
        location: "mem://skills/demo/SKILL.md",
        source: "browser",
        enabled: true,
        disableModelInvocation: false,
        createdAt: "2026-03-22T10:00:00.000Z",
        updatedAt: "2026-03-22T10:00:00.000Z",
      },
    });

    const saved = await store.saveSkill({
      location: "mem://skills/demo/SKILL.md",
      content: "---\ndescription: demo description\n---\n",
      source: "browser",
      enabled: true,
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith("brain.skill.save", {
      sessionId: "session-skill-save",
      location: "mem://skills/demo/SKILL.md",
      content: "---\ndescription: demo description\n---\n",
      source: "browser",
      enabled: true,
    });
    expect(saved.id).toBe("skill.demo");
  });
});
