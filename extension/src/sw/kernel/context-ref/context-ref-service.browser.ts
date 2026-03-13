import {
  type MaterializedContextRef,
  type PromptContextRefInput,
  type ResolvedContextRef,
} from "../../../shared/context-ref";
import type { SessionMeta } from "../types";
import type {
  FilesystemInspectRuntime,
  FilesystemListResult,
  FilesystemStatResult,
} from "./filesystem-inspect.browser";

type JsonRecord = Record<string, unknown>;

interface ReadTextResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

function escapeXmlAttr(input: string): string {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toFiniteOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clipText(input: string, maxChars: number): string {
  const text = String(input || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isProbablyBinaryText(input: string): boolean {
  return /\u0000/.test(String(input || ""));
}

function formatContextBlockContent(content: string): string {
  return ["```text", String(content || ""), "```"].join("\n");
}

export function createContextRefService(input: {
  inspect: {
    stat(params: {
      sessionId: string;
      runtime: FilesystemInspectRuntime;
      path: string;
      cwd?: string;
    }): Promise<FilesystemStatResult>;
    list(params: {
      sessionId: string;
      runtime: FilesystemInspectRuntime;
      path: string;
      cwd?: string;
    }): Promise<FilesystemListResult>;
  };
  readText(params: {
    sessionId: string;
    runtime: FilesystemInspectRuntime;
    path: string;
    cwd?: string;
    offset?: number;
    limit?: number;
  }): Promise<ReadTextResult>;
}) {
  async function resolveContextRefs(params: {
    sessionId: string;
    sessionMeta: SessionMeta | null;
    refs: PromptContextRefInput[];
  }): Promise<ResolvedContextRef[]> {
    const hostCwd = String(
      params.sessionMeta?.header?.workingContext?.hostCwd || "",
    ).trim();
    const out: ResolvedContextRef[] = [];

    for (const ref of params.refs) {
      if (ref.runtimeHint === "invalid") {
        out.push({
          id: ref.id,
          raw: ref.raw,
          displayPath: ref.displayPath,
          source: ref.source,
          target: null,
          kind: "invalid",
          error:
            String(ref.error || "").trim() ||
            `无效上下文引用: ${ref.displayPath}`,
        });
        continue;
      }

      if (ref.runtimeHint === "host" && ref.syntax === "host_relative" && !hostCwd) {
        out.push({
          id: ref.id,
          raw: ref.raw,
          displayPath: ref.displayPath,
          source: ref.source,
          target: null,
          kind: "invalid",
          error: `相对路径 ${ref.displayPath} 缺少 hostCwd，当前会话无法解析 @./ 或 @../`,
        });
        continue;
      }

      const runtime: FilesystemInspectRuntime =
        ref.runtimeHint === "browser" ? "browser" : "host";
      const cwd =
        runtime === "host" && ref.syntax === "host_relative" ? hostCwd : undefined;
      const stat = await input.inspect.stat({
        sessionId: params.sessionId,
        runtime,
        path: ref.locator,
        ...(cwd ? { cwd } : {}),
      });
      out.push({
        id: ref.id,
        raw: ref.raw,
        displayPath: ref.displayPath,
        source: ref.source,
        target:
          runtime === "browser"
            ? { runtime: "browser", uri: stat.path || ref.locator }
            : { runtime: "host", path: stat.path || ref.locator },
        kind:
          stat.type === "directory"
            ? "directory"
            : stat.type === "missing"
              ? "missing"
              : stat.type === "file"
                ? "file"
                : "binary",
        sizeBytes: toFiniteOrUndefined(stat.size),
        mtimeMs: toFiniteOrUndefined(stat.mtimeMs),
        ...(stat.type === "missing"
          ? {
              error: `引用路径不存在: ${ref.displayPath}`,
            }
          : {}),
      });
    }

    return out;
  }

  async function materializeContextRefs(params: {
    sessionId: string;
    refs: ResolvedContextRef[];
  }): Promise<MaterializedContextRef[]> {
    const out: MaterializedContextRef[] = [];

    for (const ref of params.refs) {
      if (!ref.target) {
        out.push({
          refId: ref.id,
          mode: "error",
          summary: ref.error || `无效上下文引用: ${ref.displayPath}`,
        });
        continue;
      }

      if (ref.kind === "missing" || ref.kind === "invalid") {
        out.push({
          refId: ref.id,
          mode: "error",
          summary: ref.error || `无效上下文引用: ${ref.displayPath}`,
        });
        continue;
      }

      if (ref.kind === "directory") {
        const list = await input.inspect.list({
          sessionId: params.sessionId,
          runtime: ref.target.runtime,
          path: ref.target.runtime === "browser" ? ref.target.uri : ref.target.path,
        });
        const lines = list.entries.map((entry) =>
          `- ${entry.type === "directory" ? "directory" : "file"} ${entry.name}`,
        );
        out.push({
          refId: ref.id,
          mode: "index",
          summary: `目录索引，共 ${list.entries.length} 项`,
          content: lines.length > 0 ? lines.join("\n") : "(empty directory)",
        });
        continue;
      }

      if (ref.kind === "binary") {
        out.push({
          refId: ref.id,
          mode: "metadata_only",
          summary: "非文本文件，仅附带元信息",
        });
        continue;
      }

      const runtime = ref.target.runtime;
      const path = runtime === "browser" ? ref.target.uri : ref.target.path;
      const sizeBytes = Number(ref.sizeBytes || 0);
      if (sizeBytes > 64 * 1024) {
        out.push({
          refId: ref.id,
          mode: "metadata_only",
          summary: `文件较大（${sizeBytes} bytes），未直接内联全文`,
        });
        continue;
      }

      const readLimit = sizeBytes > 12 * 1024 ? 8 * 1024 : Math.max(1, sizeBytes || 12 * 1024);
      const read = await input.readText({
        sessionId: params.sessionId,
        runtime,
        path,
        limit: readLimit,
      });
      if (isProbablyBinaryText(read.content)) {
        out.push({
          refId: ref.id,
          mode: "metadata_only",
          summary: "检测到二进制内容，仅附带元信息",
        });
        continue;
      }
      if (sizeBytes <= 12 * 1024 && !read.truncated) {
        out.push({
          refId: ref.id,
          mode: "full",
          summary: `全文内联，${read.size} bytes`,
          content: read.content,
          truncated: false,
        });
        continue;
      }
      out.push({
        refId: ref.id,
        mode: "excerpt",
        summary: `摘录前 ${read.content.length} chars，源文件 ${read.size} bytes`,
        content: read.content,
        truncated: true,
      });
    }

    return out;
  }

  function buildContextPromptPrefix(params: {
    refs: ResolvedContextRef[];
    materialized: MaterializedContextRef[];
  }): string {
    if (!params.refs.length) return "";
    const materializedById = new Map(
      params.materialized.map((item) => [item.refId, item]),
    );
    const indexLines = ["<context_index>"];
    for (const ref of params.refs) {
      const materialized = materializedById.get(ref.id);
      const runtime = ref.target?.runtime || "unknown";
      indexLines.push(
        `  <ref id="${escapeXmlAttr(ref.id)}" path="${escapeXmlAttr(ref.displayPath)}" runtime="${escapeXmlAttr(runtime)}" kind="${escapeXmlAttr(ref.kind)}" mode="${escapeXmlAttr(materialized?.mode || "error")}" />`,
      );
    }
    indexLines.push("</context_index>");

    const blocks: string[] = [indexLines.join("\n")];
    for (const ref of params.refs) {
      const materialized = materializedById.get(ref.id);
      if (!materialized) continue;
      if (materialized.mode === "error") {
        blocks.push(
          `<context_ref_error id="${escapeXmlAttr(ref.id)}" path="${escapeXmlAttr(ref.displayPath)}">${escapeXmlAttr(materialized.summary || ref.error || "context ref failed")}</context_ref_error>`,
        );
        continue;
      }
      const attrs = [
        `id="${escapeXmlAttr(ref.id)}"`,
        `path="${escapeXmlAttr(ref.displayPath)}"`,
        `mode="${escapeXmlAttr(materialized.mode)}"`,
      ];
      const bodyParts: string[] = [];
      if (materialized.summary) {
        bodyParts.push(`summary: ${materialized.summary}`);
      }
      if (materialized.content) {
        bodyParts.push(formatContextBlockContent(materialized.content));
      }
      blocks.push(
        `<context_ref ${attrs.join(" ")}>\n${bodyParts.join("\n\n") || "(no inline content)"}\n</context_ref>`,
      );
    }
    return blocks.join("\n\n");
  }

  function buildContextRefFailureMessage(refs: ResolvedContextRef[]): string | null {
    const failures = refs.filter(
      (item) => item.kind === "missing" || item.kind === "invalid",
    );
    if (failures.length === 0) return null;
    return failures
      .map((item) => String(item.error || `上下文引用失败: ${item.displayPath}`))
      .join("\n");
  }

  function toMetadataRows(params: {
    refs: ResolvedContextRef[];
    materialized: MaterializedContextRef[];
  }): JsonRecord[] {
    const materializedById = new Map(
      params.materialized.map((item) => [item.refId, item]),
    );
    return params.refs.map((ref) => {
      const materialized = materializedById.get(ref.id);
      return {
        id: ref.id,
        raw: ref.raw,
        displayPath: ref.displayPath,
        source: ref.source,
        runtime: ref.target?.runtime || null,
        target:
          ref.target?.runtime === "browser"
            ? ref.target.uri
            : ref.target?.runtime === "host"
              ? ref.target.path
              : null,
        kind: ref.kind,
        sizeBytes: ref.sizeBytes ?? null,
        mtimeMs: ref.mtimeMs ?? null,
        mode: materialized?.mode || "error",
        summary: clipText(materialized?.summary || ref.error || "", 280),
      };
    });
  }

  return {
    resolveContextRefs,
    materializeContextRefs,
    buildContextPromptPrefix,
    buildContextRefFailureMessage,
    toMetadataRows,
  };
}
