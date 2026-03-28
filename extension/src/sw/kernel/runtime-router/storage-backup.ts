import type { BrainOrchestrator } from "../orchestrator.browser";
import type { RuntimeInfraHandler } from "../runtime-infra.browser";
import {
  BUILTIN_SKILL_RESERVED_ERROR,
  isBuiltinSkillId,
  isBuiltinSkillLocation,
} from "../builtin-skill-policy";
import { invokeVirtualFrame, isVirtualUri } from "../virtual-fs.browser";
import { normalizePanelConfig } from "../../../shared/panel-config";
import {
  EXTENSION_DATA_BACKUP_SCHEMA_VERSION,
  type ExtensionDataBackup,
  type ExtensionDataBackupPayload,
  type ExtensionDataBackupSkill,
  type ExtensionDataBackupSkillFile,
  type ExtensionDataBackupSkillPackage,
} from "../../../shared/data-backup";
import {
  createVirtualStagingPath,
  moveVirtualPath,
  removeVirtualPathRecursively,
  statVirtualPath,
} from "./virtual-resource-ops";

type JsonRecord = Record<string, unknown>;

const DEFAULT_BACKUP_SESSION_ID = "__storage_backup__";

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function isMissingVirtualPathError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /ENOENT|no such file or directory/i.test(String(error.message || ""));
}

function isMissingSkillPackageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = String(error.message || "");
  return (
    message.startsWith("skill package 不存在:") ||
    /virtual file not found/i.test(message)
  );
}

function normalizeSessionId(raw: unknown): string {
  return String(raw || "").trim() || DEFAULT_BACKUP_SESSION_ID;
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

function pathBaseName(path: string): string {
  const normalized = normalizeSkillPath(path);
  if (!normalized) return "";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return normalized;
  return normalized.slice(lastSlash + 1);
}

function pathDirName(path: string): string {
  const normalized = normalizeSkillPath(path);
  if (!normalized || normalized === "mem://") return "mem://";
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= "mem://".length) return "mem://";
  return normalized.slice(0, lastSlash);
}

function deriveSkillCleanupPath(location: string): string {
  const normalized = normalizeSkillPath(location);
  if (normalized.endsWith("/SKILL.md")) {
    return normalized.slice(0, -"/SKILL.md".length);
  }
  return normalized;
}

function relativePathFromRoot(root: string, filePath: string): string {
  const normalizedRoot = normalizeSkillPath(root);
  const normalizedFile = normalizeSkillPath(filePath);
  if (normalizedRoot === normalizedFile) {
    return pathBaseName(normalizedFile);
  }
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  throw new Error(`文件不在 package root 下: ${normalizedFile}`);
}

function sanitizeRelativeBackupPath(raw: unknown): string {
  const path = String(raw || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  if (!path) {
    throw new Error("备份文件路径不能为空");
  }
  if (path.startsWith("mem://")) {
    throw new Error(`备份文件路径必须是相对路径: ${path}`);
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((item) => item === "." || item === "..")) {
    throw new Error(`备份文件路径非法: ${path}`);
  }
  return segments.join("/");
}

function normalizeBackupSkill(raw: unknown): ExtensionDataBackupSkill {
  const row = toRecord(raw);
  const location = normalizeSkillPath(row.location);
  const id = String(row.id || "").trim();
  if (!id) {
    throw new Error("备份 skill 缺少 id");
  }
  if (!location || !isVirtualUri(location)) {
    throw new Error(`备份 skill location 非法: ${location || "<empty>"}`);
  }
  if (isBuiltinSkillId(id) || isBuiltinSkillLocation(location)) {
    throw new Error(BUILTIN_SKILL_RESERVED_ERROR);
  }
  return {
    id,
    name: String(row.name || "").trim() || id,
    description: String(row.description || "").trim(),
    location,
    source: String(row.source || "browser").trim() || "browser",
    enabled: row.enabled !== false,
    disableModelInvocation: row.disableModelInvocation === true,
    createdAt: String(row.createdAt || "").trim(),
    updatedAt: String(row.updatedAt || "").trim(),
  };
}

function normalizeBackupFiles(raw: unknown): ExtensionDataBackupSkillFile[] {
  if (!Array.isArray(raw)) {
    throw new Error("备份 skill files 必须是数组");
  }
  const out: ExtensionDataBackupSkillFile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const row = toRecord(item);
    const path = sanitizeRelativeBackupPath(row.path);
    if (seen.has(path)) {
      throw new Error(`备份 skill 文件重复: ${path}`);
    }
    seen.add(path);
    out.push({
      path,
      content: String(row.content || ""),
    });
  }
  if (out.length === 0) {
    throw new Error("备份 skill 至少需要一个文件");
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeBackupSkillPackage(raw: unknown): ExtensionDataBackupSkillPackage {
  const row = toRecord(raw);
  const skill = normalizeBackupSkill(row.skill);
  const packageRoot = normalizeSkillPath(
    row.packageRoot || deriveSkillCleanupPath(skill.location),
  );
  if (!packageRoot || !isVirtualUri(packageRoot)) {
    throw new Error(`备份 packageRoot 非法: ${packageRoot || "<empty>"}`);
  }
  const files = normalizeBackupFiles(row.files);
  return {
    skill,
    packageRoot,
    files,
  };
}

function normalizeBackupPayload(raw: unknown): ExtensionDataBackup {
  const row = toRecord(raw);
  const schemaVersion = String(row.schemaVersion || "").trim();
  if (schemaVersion !== EXTENSION_DATA_BACKUP_SCHEMA_VERSION) {
    throw new Error(
      `不支持的备份格式：${schemaVersion || "<empty>"}`,
    );
  }
  const payload = toRecord(row.payload);
  const skillsRaw = Array.isArray(payload.skills) ? payload.skills : [];
  const skills = skillsRaw.map((item) => normalizeBackupSkillPackage(item));
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const item of skills) {
    if (ids.has(item.skill.id)) {
      throw new Error(`备份中存在重复 skill id: ${item.skill.id}`);
    }
    if (roots.has(item.packageRoot)) {
      throw new Error(`备份中存在重复 package root: ${item.packageRoot}`);
    }
    ids.add(item.skill.id);
    roots.add(item.packageRoot);
  }
  return {
    schemaVersion: EXTENSION_DATA_BACKUP_SCHEMA_VERSION,
    exportedAt: String(row.exportedAt || "").trim() || new Date().toISOString(),
    payload: {
      config: normalizePanelConfig(toRecord(payload.config)),
      skills,
    },
  };
}

async function readVirtualTextFile(
  path: string,
  sessionId: string,
): Promise<string> {
  const result = await invokeVirtualFrame({
    sessionId,
    tool: "read",
    args: {
      path,
      runtime: "sandbox",
    },
  });
  const row = toRecord(result);
  if (typeof row.content === "string") return row.content;
  if (typeof row.text === "string") return row.text;
  const data = toRecord(row.data);
  if (typeof data.content === "string") return data.content;
  throw new Error(`读取备份文件失败: ${path}`);
}

async function writeVirtualTextFile(
  path: string,
  content: string,
  sessionId: string,
): Promise<void> {
  await invokeVirtualFrame({
    sessionId,
    tool: "write",
    args: {
      path,
      content,
      mode: "overwrite",
      runtime: "sandbox",
    },
  });
}

async function listVirtualEntries(
  path: string,
  sessionId: string,
): Promise<Array<{ path: string; type: string }>> {
  const result = await invokeVirtualFrame({
    sessionId,
    tool: "list",
    args: {
      path,
      runtime: "sandbox",
    },
  });
  const row = toRecord(result);
  const entries = Array.isArray(row.entries) ? row.entries : [];
  return entries
    .map((item) => {
      const entry = toRecord(item);
      return {
        path: normalizeSkillPath(entry.path),
        type: String(entry.type || "").trim() || "other",
      };
    })
    .filter((item) => item.path);
}

async function collectSkillPackageFiles(
  packageRoot: string,
  sessionId: string,
): Promise<ExtensionDataBackupSkillFile[]> {
  const stat = await statVirtualPath(packageRoot, sessionId);
  if (!stat.exists) {
    throw new Error(`skill package 不存在: ${packageRoot}`);
  }
  if (stat.type === "file") {
    return [
      {
        path: pathBaseName(packageRoot),
        content: await readVirtualTextFile(packageRoot, sessionId),
      },
    ];
  }
  if (stat.type !== "directory") {
    throw new Error(`不支持的 skill package 类型: ${packageRoot} (${stat.type})`);
  }

  const entries = await listVirtualEntries(packageRoot, sessionId);
  const out: ExtensionDataBackupSkillFile[] = [];
  for (const entry of entries) {
    if (entry.type === "directory") {
      const nested = await collectSkillPackageFiles(entry.path, sessionId);
      for (const item of nested) {
        out.push({
          path: sanitizeRelativeBackupPath(
            `${pathBaseName(entry.path)}/${item.path}`,
          ),
          content: item.content,
        });
      }
      continue;
    }
    if (entry.type !== "file") continue;
    out.push({
      path: relativePathFromRoot(packageRoot, entry.path),
      content: await readVirtualTextFile(entry.path, sessionId),
    });
  }
  if (out.length === 0) {
    throw new Error(`skill package 为空: ${packageRoot}`);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function exportCustomSkillPackages(
  orchestrator: BrainOrchestrator,
  sessionId: string,
  options: {
    skipMissingPackages?: boolean;
  } = {},
): Promise<ExtensionDataBackupSkillPackage[]> {
  const skills = (await orchestrator.listSkills()).filter(
    (item) => String(item.source || "").trim() !== "builtin",
  );
  const packages: ExtensionDataBackupSkillPackage[] = [];
  for (const skill of skills) {
    const packageRoot = deriveSkillCleanupPath(skill.location);
    try {
      packages.push({
        skill: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          location: skill.location,
          source: skill.source,
          enabled: skill.enabled,
          disableModelInvocation: skill.disableModelInvocation,
          createdAt: skill.createdAt,
          updatedAt: skill.updatedAt,
        },
        packageRoot,
        files: await collectSkillPackageFiles(packageRoot, sessionId),
      });
    } catch (error) {
      if (!options.skipMissingPackages || !isMissingSkillPackageError(error)) {
        throw error;
      }
    }
  }
  return packages.sort((a, b) => a.skill.id.localeCompare(b.skill.id));
}

async function captureRollbackBackup(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
  sessionId: string,
): Promise<ExtensionDataBackup> {
  const cfgResult = await infra.handleMessage({ type: "config.get" });
  if (!cfgResult || !cfgResult.ok) {
    throw new Error(cfgResult?.error || "config.get failed");
  }
  return {
    schemaVersion: EXTENSION_DATA_BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    payload: {
      config: normalizePanelConfig(toRecord(cfgResult.data)),
      skills: await exportCustomSkillPackages(orchestrator, sessionId, {
        skipMissingPackages: true,
      }),
    },
  };
}

async function removeCustomSkill(
  orchestrator: BrainOrchestrator,
  skillId: string,
  sessionId: string,
): Promise<void> {
  const current = await orchestrator.getSkill(skillId);
  if (!current || String(current.source || "").trim() === "builtin") return;
  const cleanupPath = deriveSkillCleanupPath(current.location);
  await orchestrator.uninstallSkill(skillId);
  await removeVirtualPathRecursively(cleanupPath, sessionId).catch(() => undefined);
}

async function restoreSkillPackage(
  orchestrator: BrainOrchestrator,
  pkg: ExtensionDataBackupSkillPackage,
  sessionId: string,
): Promise<void> {
  const packageRoot = normalizeSkillPath(pkg.packageRoot);
  const targetLocation = normalizeSkillPath(pkg.skill.location);
  const targetBaseName = pathBaseName(packageRoot);
  const rootIsFile = packageRoot === targetLocation;
  const existingById = await orchestrator.getSkill(pkg.skill.id);
  const oldCleanupPath = existingById
    ? deriveSkillCleanupPath(existingById.location)
    : "";
  const backupPath = createVirtualStagingPath(pathDirName(packageRoot), "skill_backup");

  let stagingRoot = "";
  let stagingMoveTarget = "";
  let backedUpExistingPackage = false;
  try {
    if (rootIsFile) {
      if (pkg.files.length !== 1 || pkg.files[0]?.path !== targetBaseName) {
        throw new Error(`单文件 skill 备份格式非法: ${pkg.skill.id}`);
      }
      stagingRoot = createVirtualStagingPath(pathDirName(packageRoot), "skill_restore");
      stagingMoveTarget = `${stagingRoot}/${targetBaseName}`;
      await writeVirtualTextFile(
        stagingMoveTarget,
        pkg.files[0]?.content || "",
        sessionId,
      );
    } else {
      stagingRoot = createVirtualStagingPath(pathDirName(packageRoot), "skill_restore");
      stagingMoveTarget = stagingRoot;
      for (const file of pkg.files) {
        await writeVirtualTextFile(
          `${stagingRoot}/${sanitizeRelativeBackupPath(file.path)}`,
          file.content,
          sessionId,
        );
      }
    }

    if ((await statVirtualPath(packageRoot, sessionId)).exists) {
      try {
        await moveVirtualPath(packageRoot, backupPath, sessionId);
        backedUpExistingPackage = true;
      } catch (error) {
        if (!isMissingVirtualPathError(error)) {
          throw error;
        }
      }
    }
    await moveVirtualPath(stagingMoveTarget, packageRoot, sessionId);
    await orchestrator.installSkill(
      {
        id: pkg.skill.id,
        name: pkg.skill.name,
        description: pkg.skill.description,
        location: targetLocation,
        source: pkg.skill.source,
        enabled: pkg.skill.enabled,
        disableModelInvocation: pkg.skill.disableModelInvocation,
      },
      { replace: true },
    );
    if (oldCleanupPath && oldCleanupPath !== packageRoot) {
      await removeVirtualPathRecursively(oldCleanupPath, sessionId).catch(
        () => undefined,
      );
    }
    await removeVirtualPathRecursively(backupPath, sessionId).catch(() => undefined);
    if (rootIsFile) {
      await removeVirtualPathRecursively(stagingRoot, sessionId).catch(() => undefined);
    }
  } catch (error) {
    if (stagingRoot) {
      await removeVirtualPathRecursively(stagingRoot, sessionId).catch(
        () => undefined,
      );
    }
    await removeVirtualPathRecursively(packageRoot, sessionId).catch(() => undefined);
    if (backedUpExistingPackage) {
      await moveVirtualPath(backupPath, packageRoot, sessionId).catch(
        () => undefined,
      );
    } else {
      await removeVirtualPathRecursively(backupPath, sessionId).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function applyBackupPayload(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
  payload: ExtensionDataBackupPayload,
  sessionId: string,
): Promise<{
  importedSkillIds: string[];
  removedSkillIds: string[];
}> {
  const cfgResult = await infra.handleMessage({
    type: "config.save",
    payload: payload.config,
  });
  if (!cfgResult || !cfgResult.ok) {
    throw new Error(cfgResult?.error || "config.save failed");
  }

  const currentCustomSkills = (await orchestrator.listSkills()).filter(
    (item) => String(item.source || "").trim() !== "builtin",
  );
  const targetIds = new Set(payload.skills.map((item) => item.skill.id));
  const removedSkillIds: string[] = [];

  for (const skill of currentCustomSkills) {
    if (targetIds.has(skill.id)) continue;
    await removeCustomSkill(orchestrator, skill.id, sessionId);
    removedSkillIds.push(skill.id);
  }

  const importedSkillIds: string[] = [];
  for (const skillPackage of payload.skills) {
    await restoreSkillPackage(orchestrator, skillPackage, sessionId);
    importedSkillIds.push(skillPackage.skill.id);
  }

  return {
    importedSkillIds,
    removedSkillIds,
  };
}

export async function exportExtensionDataBackup(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
  rawSessionId?: unknown,
): Promise<ExtensionDataBackup> {
  const sessionId = normalizeSessionId(rawSessionId);
  const cfgResult = await infra.handleMessage({ type: "config.get" });
  if (!cfgResult || !cfgResult.ok) {
    throw new Error(cfgResult?.error || "config.get failed");
  }
  return {
    schemaVersion: EXTENSION_DATA_BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    payload: {
      config: normalizePanelConfig(toRecord(cfgResult.data)),
      skills: await exportCustomSkillPackages(orchestrator, sessionId),
    },
  };
}

export async function importExtensionDataBackup(
  orchestrator: BrainOrchestrator,
  infra: RuntimeInfraHandler,
  rawBackup: unknown,
  rawSessionId?: unknown,
): Promise<{
  importedAt: string;
  importedSkillIds: string[];
  removedSkillIds: string[];
}> {
  const sessionId = normalizeSessionId(rawSessionId);
  const backup = normalizeBackupPayload(rawBackup);
  const previous = await captureRollbackBackup(orchestrator, infra, sessionId);
  try {
    const result = await applyBackupPayload(
      orchestrator,
      infra,
      backup.payload,
      sessionId,
    );
    return {
      importedAt: new Date().toISOString(),
      importedSkillIds: result.importedSkillIds,
      removedSkillIds: result.removedSkillIds,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await applyBackupPayload(orchestrator, infra, previous.payload, sessionId);
    } catch (rollbackError) {
      const rollbackReason =
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
      throw new Error(`导入失败，且回滚失败：${reason}; rollback=${rollbackReason}`);
    }
    throw new Error(`导入失败，已回滚：${reason}`);
  }
}
