import crypto from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BridgeConfig } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiagnosticExportEnvelope {
  id: string;
  kind: "session_diagnostics";
  sessionId: string;
  title: string;
  createdAt: string;
  schemaVersion: string;
  payload: Record<string, unknown>;
}

export interface DiagnosticExportSummary {
  id: string;
  kind: "session_diagnostics";
  sessionId: string;
  title: string;
  createdAt: string;
  schemaVersion: string;
  sizeBytes: number;
}

export interface DebugSnapshotExportEnvelope {
  id: string;
  kind: "kernel_debug_snapshot";
  sessionId: string;
  title: string;
  createdAt: string;
  schemaVersion: string;
  payload: Record<string, unknown>;
}

export interface DebugSnapshotExportSummary {
  id: string;
  kind: "kernel_debug_snapshot";
  sessionId: string;
  title: string;
  createdAt: string;
  schemaVersion: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeFileSegment(value: unknown, fallback: string): string {
  const text = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return text || fallback;
}

export function trimForTitle(value: unknown, fallback: string, max = 64): string {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return text.length > max ? text.slice(0, max) : text;
}

function resolveDiagnosticExportFile(config: BridgeConfig, exportId: string): string {
  return path.join(config.diagnosticsPath, `${exportId}.json`);
}

function resolveDebugSnapshotDir(config: BridgeConfig): string {
  return path.join(config.diagnosticsPath, "debug-snapshots");
}

function resolveDebugSnapshotExportFile(config: BridgeConfig, exportId: string): string {
  return path.join(resolveDebugSnapshotDir(config), `${exportId}.json`);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export async function writeDiagnosticExport(
  config: BridgeConfig,
  input: Record<string, unknown>,
): Promise<{
  item: DiagnosticExportSummary;
  downloadUrl: string;
}> {
  const payload = input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("diagnostics payload must be a JSON object");
  }

  const createdAt = nowIso();
  const sessionId = trimForTitle(input.sessionId, "unknown-session", 120);
  const title = trimForTitle(input.title, "未命名会话", 120);
  const schemaVersion = trimForTitle(
    (payload as Record<string, unknown>).schemaVersion,
    "unknown",
    48,
  );
  const exportId = [
    createdAt.slice(0, 19).replace(/[:T]/g, "").replace(/-/g, ""),
    sanitizeFileSegment(sessionId, "session"),
    crypto.randomUUID().slice(0, 8),
  ].join("-");
  const envelope: DiagnosticExportEnvelope = {
    id: exportId,
    kind: "session_diagnostics",
    sessionId,
    title,
    createdAt,
    schemaVersion,
    payload: payload as Record<string, unknown>,
  };
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  const filePath = resolveDiagnosticExportFile(config, exportId);

  await mkdir(config.diagnosticsPath, { recursive: true });
  await writeFile(filePath, body, "utf8");

  return {
    item: {
      id: exportId,
      kind: envelope.kind,
      sessionId: envelope.sessionId,
      title: envelope.title,
      createdAt: envelope.createdAt,
      schemaVersion: envelope.schemaVersion,
      sizeBytes: Buffer.byteLength(body, "utf8"),
    },
    downloadUrl: `/api/diagnostics/${encodeURIComponent(exportId)}`,
  };
}

export async function readDiagnosticExport(config: BridgeConfig, exportId: string): Promise<{
  envelope: DiagnosticExportEnvelope;
  sizeBytes: number;
}> {
  const safeId = sanitizeFileSegment(exportId, "");
  if (!safeId) {
    throw new Error("invalid diagnostics export id");
  }
  const filePath = resolveDiagnosticExportFile(config, safeId);
  const body = await readFile(filePath, "utf8");
  const parsed = JSON.parse(body) as DiagnosticExportEnvelope;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid diagnostics export payload");
  }
  return {
    envelope: parsed,
    sizeBytes: Buffer.byteLength(body, "utf8"),
  };
}

export async function writeDebugSnapshotExport(
  config: BridgeConfig,
  input: Record<string, unknown>,
): Promise<{
  item: DebugSnapshotExportSummary;
  downloadUrl: string;
}> {
  const payload = input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("debug snapshot payload must be a JSON object");
  }

  const createdAt = nowIso();
  const sessionId = trimForTitle(input.sessionId, "global", 120);
  const title = trimForTitle(input.title, "调试快照", 120);
  const schemaVersion = trimForTitle(
    (payload as Record<string, unknown>).schemaVersion,
    "unknown",
    48,
  );
  const exportId = [
    "dbg",
    createdAt.slice(0, 19).replace(/[:T]/g, "").replace(/-/g, ""),
    sanitizeFileSegment(sessionId, "global"),
    crypto.randomUUID().slice(0, 8),
  ].join("-");
  const envelope: DebugSnapshotExportEnvelope = {
    id: exportId,
    kind: "kernel_debug_snapshot",
    sessionId,
    title,
    createdAt,
    schemaVersion,
    payload: payload as Record<string, unknown>,
  };
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  const filePath = resolveDebugSnapshotExportFile(config, exportId);

  await mkdir(resolveDebugSnapshotDir(config), { recursive: true });
  await writeFile(filePath, body, "utf8");

  return {
    item: {
      id: exportId,
      kind: envelope.kind,
      sessionId: envelope.sessionId,
      title: envelope.title,
      createdAt: envelope.createdAt,
      schemaVersion: envelope.schemaVersion,
      sizeBytes: Buffer.byteLength(body, "utf8"),
    },
    downloadUrl: `/api/debug-snapshots/${encodeURIComponent(exportId)}`,
  };
}

export async function readDebugSnapshotExport(config: BridgeConfig, exportId: string): Promise<{
  envelope: DebugSnapshotExportEnvelope;
  sizeBytes: number;
}> {
  const safeId = sanitizeFileSegment(exportId, "");
  if (!safeId) {
    throw new Error("invalid debug snapshot export id");
  }
  const filePath = resolveDebugSnapshotExportFile(config, safeId);
  const body = await readFile(filePath, "utf8");
  const parsed = JSON.parse(body) as DebugSnapshotExportEnvelope;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid debug snapshot export payload");
  }
  return {
    envelope: parsed,
    sizeBytes: Buffer.byteLength(body, "utf8"),
  };
}

export async function listDebugSnapshotExports(
  config: BridgeConfig,
): Promise<DebugSnapshotExportSummary[]> {
  await mkdir(resolveDebugSnapshotDir(config), { recursive: true });
  const entries = await readdir(resolveDebugSnapshotDir(config), {
    withFileTypes: true,
  });
  const output: DebugSnapshotExportSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const exportId = entry.name.slice(0, -5);
    try {
      const { envelope, sizeBytes } = await readDebugSnapshotExport(
        config,
        exportId,
      );
      output.push({
        id: String(envelope.id || exportId),
        kind: "kernel_debug_snapshot",
        sessionId: String(envelope.sessionId || ""),
        title: trimForTitle(envelope.title, "调试快照", 120),
        createdAt: String(envelope.createdAt || ""),
        schemaVersion: String(envelope.schemaVersion || ""),
        sizeBytes,
      });
    } catch {
      // 忽略损坏文件，避免整个 list 因单个坏文件失败
    }
  }

  output.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return output;
}

export async function listDiagnosticExports(config: BridgeConfig): Promise<DiagnosticExportSummary[]> {
  await mkdir(config.diagnosticsPath, { recursive: true });
  const entries = await readdir(config.diagnosticsPath, { withFileTypes: true });
  const output: DiagnosticExportSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const exportId = entry.name.slice(0, -5);
    try {
      const { envelope, sizeBytes } = await readDiagnosticExport(config, exportId);
      output.push({
        id: String(envelope.id || exportId),
        kind: "session_diagnostics",
        sessionId: String(envelope.sessionId || ""),
        title: trimForTitle(envelope.title, "未命名会话", 120),
        createdAt: String(envelope.createdAt || ""),
        schemaVersion: String(envelope.schemaVersion || ""),
        sizeBytes,
      });
    } catch {
      // 忽略损坏文件，避免整个 list 因单个坏文件失败
    }
  }

  output.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return output;
}
