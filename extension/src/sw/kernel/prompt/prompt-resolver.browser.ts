import type {
  MaterializedContextRef,
  PromptContextRefInput,
  ResolvedContextRef,
} from "../../../shared/context-ref";
import {
  extractPromptContextRefs,
  rewritePromptWithContextRefPlaceholders,
} from "../../../shared/context-ref";
import { buildBrowserAgentSystemPromptBase } from "./prompt-policy.browser";
import type { SessionMeta } from "../types";
import type { ToolDefinition } from "../orchestrator.browser";
import type { BridgeConfig } from "../runtime-infra.browser";

export interface SystemPromptContextRefService {
  resolveContextRefs(params: {
    sessionId: string;
    sessionMeta: SessionMeta | null;
    refs: PromptContextRefInput[];
  }): Promise<ResolvedContextRef[]>;
  buildContextRefFailureMessage(refs: ResolvedContextRef[]): string;
  materializeContextRefs(params: {
    sessionId: string;
    refs: ResolvedContextRef[];
  }): Promise<MaterializedContextRef[]>;
  buildContextPromptPrefix(params: {
    refs: ResolvedContextRef[];
    materialized: MaterializedContextRef[];
  }): string;
}

export interface SystemPromptResolverInput {
  config: BridgeConfig;
  sessionId: string;
  sessionMeta: SessionMeta | null;
  toolDefinitions?: ToolDefinition[];
}

export function createSystemPromptResolver(deps: {
  contextRefService: SystemPromptContextRefService;
}) {
  const { contextRefService } = deps;

  async function resolveSystemPrompt(
    input: SystemPromptResolverInput,
  ): Promise<string> {
    const toolDefinitions = Array.isArray(input.toolDefinitions)
      ? input.toolDefinitions
      : [];
    const overridePrompt = String(input.config.llmSystemPromptCustom || "");
    if (!overridePrompt.trim()) {
      return buildBrowserAgentSystemPromptBase(toolDefinitions);
    }

    const parsedRefs = extractPromptContextRefs(overridePrompt, "system_prompt");
    if (parsedRefs.refs.length === 0) {
      return overridePrompt;
    }

    const resolvedRefs = await contextRefService.resolveContextRefs({
      sessionId: input.sessionId,
      sessionMeta: input.sessionMeta,
      refs: parsedRefs.refs,
    });
    const failureMessage =
      contextRefService.buildContextRefFailureMessage(resolvedRefs);
    if (failureMessage) {
      throw new Error(failureMessage);
    }

    const materializedRefs = await contextRefService.materializeContextRefs({
      sessionId: input.sessionId,
      refs: resolvedRefs,
    });
    const contextPrefix = contextRefService.buildContextPromptPrefix({
      refs: resolvedRefs,
      materialized: materializedRefs,
    });
    const promptBody = rewritePromptWithContextRefPlaceholders(
      overridePrompt,
      resolvedRefs,
    );
    return [
      contextPrefix,
      `<system_prompt>\n${promptBody || "请结合以上 system prompt 上下文约束执行。"}\n</system_prompt>`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return { resolveSystemPrompt };
}
