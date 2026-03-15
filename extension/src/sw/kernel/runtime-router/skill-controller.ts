import type { BrainOrchestrator } from "../orchestrator.browser";
import type { RuntimeLoopController } from "../runtime-loop.browser";
import { normalizeSkillCreateRequest } from "../skill-create";
import { invokeVirtualFrame, isVirtualUri } from "../virtual-fs.browser";
import {
  createVirtualStagingPath,
  moveVirtualPath,
  removeVirtualPathRecursively,
  statVirtualPath,
} from "./virtual-resource-ops";

type JsonRecord = Record<string, unknown>;

interface RuntimeOk<T = unknown> {
  ok: true;
  data: T;
}

interface RuntimeErr {
  ok: false;
  error: string;
}

type RuntimeResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

interface SkillDiscoverRootInput {
  root: string;
  source: string;
}

interface SkillDiscoverScanHit {
  root: string;
  source: string;
  path: string;
}

interface ParsedSkillFrontmatter {
  id?: string;
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
  warnings: string[];
}

const DEFAULT_SKILL_DISCOVER_MAX_FILES = 256;
const MAX_SKILL_DISCOVER_MAX_FILES = 4096;
const DEFAULT_SKILL_DISCOVER_ROOTS: Array<{ root: string; source: string }> = [
  { root: "mem://skills", source: "browser" },
];

function ok<T>(data: T): RuntimeOk<T> {
  return { ok: true, data };
}

function fail(error: string): RuntimeErr {
  return { ok: false, error };
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function normalizeIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function sanitizeSkillDiscoverCell(input: unknown, field: string): string {
  const text = String(input || "").trim();
  if (!text) return "";
  if (/[\r\n\t]/.test(text)) {
    throw new Error(`brain.skill.discover: ${field} 不能包含换行或制表符`);
  }
  return text;
}

function normalizeSkillPath(input: unknown): string {
  const raw = String(input || "")
    .trim()
    .replace(/\\/g, "/");
  const uriMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(raw);
  if (uriMatch) {
    const scheme = String(uriMatch[1] || "")
      .trim()
      .toLowerCase();
    let rest = String(uriMatch[2] || "")
      .replace(/^\/+/, "")
      .replace(/\/+/g, "/");
    if (rest.length > 1) {
      rest = rest.replace(/\/+$/g, "");
    }
    return `${scheme}://${rest}`;
  }

  let text = raw.replace(/\/+/g, "/");
  if (text.length > 1) {
    text = text.replace(/\/+$/g, "");
  }
  return text;
}

function quoteVirtualPrefixReplace(
  input: string,
  fromPrefix: string,
  toPrefix: string,
): string {
  if (!String(input || "").startsWith(fromPrefix)) {
    throw new Error(`skill staged path 前缀不匹配: ${input}`);
  }
  return `${toPrefix}${String(input || "").slice(fromPrefix.length)}`;
}

function buildStagedSkillWrites(
  writes: Array<{ path: string; content: string }>,
  skillDir: string,
  stagingDir: string,
): Array<{ path: string; content: string }> {
  return writes.map((item) => ({
    path: quoteVirtualPrefixReplace(item.path, skillDir, stagingDir),
    content: item.content,
  }));
}

function deriveSkillCleanupPath(location: string): string {
  const normalized = normalizeSkillPath(location);
  if (normalized.endsWith("/SKILL.md")) {
    return normalized.slice(0, -"/SKILL.md".length);
  }
  return normalized;
}

function normalizeSkillDiscoverRoots(
  payload: Record<string, unknown>,
): SkillDiscoverRootInput[] {
  const fallbackSource = String(payload.source || "").trim() || "browser";
  const rawRoots = Array.isArray(payload.roots) ? payload.roots : [];
  const out: SkillDiscoverRootInput[] = [];

  if (rawRoots.length > 0) {
    for (const item of rawRoots) {
      if (typeof item === "string") {
        const root = sanitizeSkillDiscoverCell(item, "root");
        if (!root) continue;
        if (!isVirtualUri(root)) {
          throw new Error("brain.skill.discover 仅支持 mem:// roots");
        }
        out.push({ root: normalizeSkillPath(root), source: fallbackSource });
        continue;
      }
      const row = toRecord(item);
      const root = sanitizeSkillDiscoverCell(
        row.root || row.path || "",
        "root",
      );
      if (!root) continue;
      if (!isVirtualUri(root)) {
        throw new Error("brain.skill.discover 仅支持 mem:// roots");
      }
      const source =
        sanitizeSkillDiscoverCell(row.source || fallbackSource, "source") ||
        fallbackSource;
      out.push({ root: normalizeSkillPath(root), source });
    }
  } else {
    out.push(
      ...DEFAULT_SKILL_DISCOVER_ROOTS.map((item) => ({
        root: normalizeSkillPath(item.root),
        source: item.source,
      })),
    );
  }

  const dedup = new Set<string>();
  const normalized: SkillDiscoverRootInput[] = [];
  for (const item of out) {
    const key = item.root;
    if (dedup.has(key)) continue;
    dedup.add(key);
    normalized.push(item);
  }
  return normalized;
}

function pathBaseName(path: string): string {
  const normalized = normalizeSkillPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return normalized;
  return normalized.slice(lastSlash + 1);
}

function pathParentBaseName(path: string): string {
  const normalized = normalizeSkillPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  const parent = normalized.slice(0, lastSlash);
  const parentSlash = parent.lastIndexOf("/");
  if (parentSlash < 0) return parent;
  return parent.slice(parentSlash + 1);
}

function shouldAcceptDiscoveredSkillPath(root: string, path: string): boolean {
  const normalizedRoot = normalizeSkillPath(root);
  const normalizedPath = normalizeSkillPath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  let relative = "";
  if (normalizedPath === normalizedRoot) {
    relative = "";
  } else if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    relative = normalizedPath.slice(normalizedRoot.length + 1);
  } else {
    return false;
  }
  if (!relative) return false;

  const parts = relative.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((item) => item === "node_modules" || item.startsWith("."))) {
    return false;
  }
  const base = parts[parts.length - 1] || "";
  if (parts.length === 1) {
    return /\.md$/i.test(base);
  }
  return base === "SKILL.md";
}

function trimQuotePair(text: string): string {
  const value = String(text || "").trim();
  if (!value) return value;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function parseFrontmatterBoolean(raw: string): boolean | undefined {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return undefined;
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  return undefined;
}

function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const out: ParsedSkillFrontmatter = { warnings: [] };
  const lines = String(content || "").split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") return out;

  const fields: Record<string, string> = {};
  let endLine = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    if (line.trim() === "---") {
      endLine = i;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([a-zA-Z0-9._-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    fields[match[1].toLowerCase()] = trimQuotePair(match[2]);
  }
  if (endLine < 0) {
    out.warnings.push("frontmatter 未闭合");
    return out;
  }

  const id = String(fields.id || "").trim();
  const name = String(fields.name || "").trim();
  const description = String(fields.description || "").trim();
  const disableRaw = String(
    fields["disable-model-invocation"] ||
      fields["disable_model_invocation"] ||
      fields["disablemodelinvocation"] ||
      "",
  ).trim();

  if (id) out.id = id;
  if (name) out.name = name;
  if (description) out.description = description;
  if (disableRaw) {
    const parsed = parseFrontmatterBoolean(disableRaw);
    if (parsed === undefined) {
      out.warnings.push("disable-model-invocation 不是布尔值");
    } else {
      out.disableModelInvocation = parsed;
    }
  }
  return out;
}

function deriveSkillNameFromLocation(location: string): string {
  const base = pathBaseName(location);
  const seed =
    base.toUpperCase() === "SKILL.MD"
      ? pathParentBaseName(location)
      : base.replace(/\.md$/i, "");
  const collapsed = String(seed || "")
    .trim()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed || "skill";
}

function deriveSkillIdSeedFromLocation(location: string): string {
  const base = pathBaseName(location);
  if (base.toUpperCase() === "SKILL.MD") {
    return pathParentBaseName(location) || location;
  }
  return base.replace(/\.md$/i, "") || location;
}

function extractSkillReadContent(data: unknown): string {
  const root = toRecord(data);
  const rootData = toRecord(root.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates: unknown[] = [
    data,
    root.content,
    root.text,
    rootData.content,
    rootData.text,
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
  throw new Error("brain.skill.discover: 文件读取工具未返回文本");
}

function extractBashExecResult(data: unknown): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  const root = toRecord(data);
  const rootData = toRecord(root.data);
  const rootResponse = toRecord(root.response);
  const rootResponseData = toRecord(rootResponse.data);
  const rootResponseInnerData = toRecord(rootResponseData.data);
  const rootResult = toRecord(root.result);
  const candidates = [
    root,
    rootData,
    rootResponse,
    rootResponseData,
    rootResponseInnerData,
    rootResult,
  ];
  for (const item of candidates) {
    const stdout = item.stdout;
    if (typeof stdout !== "string") continue;
    const stderr = typeof item.stderr === "string" ? item.stderr : "";
    const exitCodeRaw = Number(item.exitCode);
    return {
      stdout,
      stderr,
      exitCode: Number.isFinite(exitCodeRaw) ? exitCodeRaw : null,
    };
  }
  throw new Error("brain.skill.discover 未返回 stdout");
}

function parseSkillDiscoverFindOutput(input: {
  root: string;
  source: string;
  stdout: string;
}): SkillDiscoverScanHit[] {
  const rows = String(input.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out: SkillDiscoverScanHit[] = [];
  for (const row of rows) {
    const path = normalizeSkillPath(row);
    if (!path) continue;
    if (!shouldAcceptDiscoveredSkillPath(input.root, path)) continue;
    out.push({
      root: input.root,
      source: input.source,
      path,
    });
  }
  return out;
}

async function writeVirtualTextFile(
  path: string,
  content: string,
  sessionId = "default",
): Promise<JsonRecord> {
  const resolvedPath = String(path || "").trim();
  if (!resolvedPath) throw new Error("write path 不能为空");
  if (!isVirtualUri(resolvedPath)) {
    throw new Error("write path 仅支持 mem://");
  }
  return await invokeVirtualFrame({
    tool: "write",
    args: {
      path: resolvedPath,
      content: String(content || ""),
      mode: "overwrite",
      runtime: "sandbox",
    },
    sessionId: String(sessionId || "").trim() || "default",
  });
}

export async function handleBrainSkill(
  orchestrator: BrainOrchestrator,
  runtimeLoop: RuntimeLoopController,
  message: unknown,
): Promise<RuntimeResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");

  if (action === "brain.skill.create") {
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) return fail("brain.skill.create 需要 sessionId");
    const nested = toRecord(payload.skill);
    const source =
      Object.keys(nested).length > 0 ? { ...payload, ...nested } : payload;
    const normalized = normalizeSkillCreateRequest(source);
    const skillId = String(normalized.skill.id || "").trim();
    const stagingDir = createVirtualStagingPath(normalized.root, "skill_stage");
    const stagedWrites = buildStagedSkillWrites(
      normalized.writes,
      normalized.skillDir,
      stagingDir,
    );
    const cleanupPath = deriveSkillCleanupPath(normalized.skill.location);
    const backupPath = createVirtualStagingPath(normalized.root, "skill_backup");
    const existingStat = await statVirtualPath(cleanupPath, sessionId);
    try {
      for (const file of stagedWrites) {
        await writeVirtualTextFile(file.path, file.content, sessionId);
      }
      if (existingStat.exists) {
        await moveVirtualPath(cleanupPath, backupPath, sessionId);
      }
      await moveVirtualPath(stagingDir, normalized.skillDir, sessionId);
      const skill = await orchestrator.installSkill(normalized.skill, {
        replace: normalized.replace,
      });
      await removeVirtualPathRecursively(backupPath, sessionId);
      return ok({
        sessionId,
        skillId: skill.id,
        skill,
        root: normalized.root,
        skillDir: normalized.skillDir,
        location: skill.location,
        fileCount: normalized.writes.length,
        files: normalized.writes.map((item) => item.path),
      });
    } catch (error) {
      await removeVirtualPathRecursively(stagingDir, sessionId).catch(() => undefined);
      await removeVirtualPathRecursively(normalized.skillDir, sessionId).catch(() => undefined);
      if (existingStat.exists) {
        await moveVirtualPath(backupPath, cleanupPath, sessionId).catch(
          () => undefined,
        );
      } else {
        await removeVirtualPathRecursively(backupPath, sessionId).catch(
          () => undefined,
        );
      }
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (action === "brain.skill.list") {
    return ok({
      skills: await orchestrator.listSkills(),
    });
  }

  if (action === "brain.skill.install") {
    const skillPayload =
      Object.keys(toRecord(payload.skill)).length > 0
        ? toRecord(payload.skill)
        : payload;
    const location = normalizeSkillPath(skillPayload.location);
    if (!location) return fail("brain.skill.install 需要 location");
    if (!isVirtualUri(location)) {
      return fail("brain.skill.install location 仅支持 mem://");
    }

    const skill = await orchestrator.installSkill(
      {
        id: String(skillPayload.id || "").trim() || undefined,
        name: String(skillPayload.name || "").trim() || undefined,
        description: String(skillPayload.description || "").trim() || undefined,
        location,
        source: String(skillPayload.source || "").trim() || undefined,
        enabled:
          skillPayload.enabled === undefined
            ? undefined
            : skillPayload.enabled !== false,
        disableModelInvocation:
          skillPayload.disableModelInvocation === undefined
            ? undefined
            : skillPayload.disableModelInvocation === true,
      },
      {
        replace: payload.replace === true || skillPayload.replace === true,
      },
    );
    return ok({
      skillId: skill.id,
      skill,
    });
  }

  if (action === "brain.skill.resolve") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.resolve 需要 skillId");
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) return fail("brain.skill.resolve 需要 sessionId");
    const capability =
      String(payload.capability || "fs.read").trim() || "fs.read";
    const resolved = await orchestrator.resolveSkillContent(skillId, {
      allowDisabled: payload.allowDisabled === true,
      sessionId,
      capability,
    });
    return ok({
      skillId: resolved.skill.id,
      skill: resolved.skill,
      content: resolved.content,
      promptBlock: resolved.promptBlock,
    });
  }

  if (action === "brain.skill.discover") {
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) return fail("brain.skill.discover 需要 sessionId");

    const roots = normalizeSkillDiscoverRoots(payload);
    if (!roots.length) return fail("brain.skill.discover 需要 roots");

    const discoverCapability =
      String(payload.discoverCapability || "process.exec").trim() ||
      "process.exec";
    const readCapability =
      String(payload.readCapability || "fs.read").trim() || "fs.read";
    const maxFiles = normalizeIntInRange(
      payload.maxFiles,
      DEFAULT_SKILL_DISCOVER_MAX_FILES,
      1,
      MAX_SKILL_DISCOVER_MAX_FILES,
    );
    const timeoutMs = normalizeIntInRange(
      payload.timeoutMs,
      60_000,
      5_000,
      300_000,
    );
    const autoInstall = payload.autoInstall !== false;
    const replace = payload.replace !== false;

    const hits: SkillDiscoverScanHit[] = [];
    let scanStdoutBytes = 0;
    const scanStderrChunks: string[] = [];
    let scanExitCode: number | null = 0;

    for (let i = 0; i < roots.length; i += 1) {
      if (hits.length >= maxFiles) break;
      const rootItem = roots[i];
      const root = normalizeSkillPath(rootItem.root);
      const source = String(rootItem.source || "").trim() || "browser";
      const quotedRoot = `'${root.replace(/'/g, "'\"'\"'")}'`;
      const command = `find ${quotedRoot} -name '*.md'`;
      const discoveredStep = await runtimeLoop.executeStep({
        sessionId,
        capability: discoverCapability,
        action: "invoke",
        args: {
          frame: {
            tool: "bash",
            args: {
              cmdId: "bash.exec",
              args: [command],
              runtime: "sandbox",
              timeoutMs,
            },
          },
        },
        verifyPolicy: "off",
      });
      if (!discoveredStep.ok) {
        return fail(
          discoveredStep.error || `brain.skill.discover 扫描失败: ${root}`,
        );
      }

      const scanResult = extractBashExecResult(discoveredStep.data);
      scanStdoutBytes += scanResult.stdout.length;
      if (scanResult.stderr) scanStderrChunks.push(scanResult.stderr);
      if (scanResult.exitCode !== null && scanResult.exitCode !== 0) {
        scanExitCode = scanResult.exitCode;
      }
      const foundInRoot = parseSkillDiscoverFindOutput({
        root,
        source,
        stdout: scanResult.stdout,
      });
      for (const hit of foundInRoot) {
        hits.push(hit);
        if (hits.length >= maxFiles) break;
      }
    }

    const uniqueHits: SkillDiscoverScanHit[] = [];
    const seenPaths = new Set<string>();
    for (const hit of hits) {
      const normalizedPath = normalizeSkillPath(hit.path);
      if (!normalizedPath || seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);
      uniqueHits.push({
        ...hit,
        path: normalizedPath,
      });
    }

    const skipped: Array<Record<string, unknown>> = [];
    const discovered: Array<Record<string, unknown>> = [];
    const installed: unknown[] = [];

    for (const hit of uniqueHits) {
      let content = "";
      try {
        const readOut = await runtimeLoop.executeStep({
          sessionId,
          capability: readCapability,
          action: "invoke",
          args: {
            path: hit.path,
            frame: {
              tool: "read",
              args: {
                path: hit.path,
                ...(isVirtualUri(hit.path) ? { runtime: "sandbox" } : {}),
              },
            },
          },
          verifyPolicy: "off",
        });
        if (!readOut.ok) {
          skipped.push({
            location: hit.path,
            source: hit.source,
            reason: readOut.error || "文件读取失败",
          });
          continue;
        }
        content = extractSkillReadContent(readOut.data);
      } catch (error) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const frontmatter = parseSkillFrontmatter(content);
      const name = frontmatter.name || deriveSkillNameFromLocation(hit.path);
      const description = String(frontmatter.description || "").trim();
      const idSeed = String(
        frontmatter.id ||
          frontmatter.name ||
          deriveSkillIdSeedFromLocation(hit.path),
      ).trim();
      if (!description) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: "frontmatter.description 缺失，按 Pi 规则跳过",
          warnings: frontmatter.warnings,
        });
        continue;
      }

      const candidate = {
        id: idSeed,
        name,
        description,
        location: hit.path,
        source: hit.source,
        enabled: true,
        disableModelInvocation: frontmatter.disableModelInvocation === true,
        warnings: frontmatter.warnings,
      };
      discovered.push(candidate);

      if (!autoInstall) continue;
      try {
        const skill = await orchestrator.installSkill(
          {
            id: candidate.id,
            name: candidate.name,
            description: candidate.description,
            location: candidate.location,
            source: candidate.source,
            enabled: true,
            disableModelInvocation: candidate.disableModelInvocation,
          },
          {
            replace,
          },
        );
        installed.push(skill);
      } catch (error) {
        skipped.push({
          location: hit.path,
          source: hit.source,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return ok({
      sessionId,
      roots,
      scan: {
        maxFiles,
        timeoutMs,
        discoverCapability,
        readCapability,
        stdoutBytes: scanStdoutBytes,
        stderr: scanStderrChunks.join("\n"),
        exitCode: scanExitCode,
      },
      counts: {
        scanned: uniqueHits.length,
        discovered: discovered.length,
        installed: installed.length,
        skipped: skipped.length,
      },
      discovered,
      installed,
      skipped,
      skills: autoInstall ? await orchestrator.listSkills() : undefined,
    });
  }

  if (action === "brain.skill.enable") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.enable 需要 skillId");
    const skill = await orchestrator.enableSkill(skillId);
    return ok({
      skillId: skill.id,
      skill,
    });
  }

  if (action === "brain.skill.disable") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.disable 需要 skillId");
    const skill = await orchestrator.disableSkill(skillId);
    return ok({
      skillId: skill.id,
      skill,
    });
  }

  if (action === "brain.skill.uninstall") {
    const skillId = String(payload.skillId || payload.id || "").trim();
    if (!skillId) return fail("brain.skill.uninstall 需要 skillId");
    const sessionId = String(payload.sessionId || "").trim() || "default";
    const current = await orchestrator.getSkill(skillId);
    const cleanupPath = current?.location
      ? deriveSkillCleanupPath(current.location)
      : "";
    const removed = await orchestrator.uninstallSkill(skillId);
    if (!removed) return fail(`skill 不存在: ${skillId}`);
    let vfsCleanupError: string | undefined;
    if (cleanupPath) {
      try {
        await removeVirtualPathRecursively(cleanupPath, sessionId);
      } catch (error) {
        vfsCleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    return ok({
      skillId,
      removed,
      ...(cleanupPath ? { removedPath: cleanupPath } : {}),
      ...(vfsCleanupError ? { vfsCleanupError } : {}),
    });
  }

  return fail(`unsupported brain.skill action: ${action}`);
}
