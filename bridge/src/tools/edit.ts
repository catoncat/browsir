import { readFile, writeFile } from "node:fs/promises";
import { BridgeError } from "../errors";
import { asOptionalString, asString } from "../protocol";
import { applyUnifiedPatch } from "./patch";
import type { FsGuard } from "../fs-guard";

interface FindReplaceEdit {
  kind?: "find_replace";
  find: string;
  replace: string;
  all?: boolean;
}

interface UnifiedPatchEdit {
  kind: "unified_patch";
  patch: string;
}

type EditSpec = FindReplaceEdit | UnifiedPatchEdit;

function parseEdits(value: unknown): EditSpec[] {
  if (typeof value === "string") {
    return [{ kind: "unified_patch", patch: value }];
  }

  if (!value) {
    throw new BridgeError("E_ARGS", "edits is required");
  }

  if (Array.isArray(value)) {
    return value.map((item) => parseSingleEdit(item));
  }

  return [parseSingleEdit(value)];
}

function parseSingleEdit(value: unknown): EditSpec {
  if (!value || typeof value !== "object") {
    throw new BridgeError("E_ARGS", "edit item must be an object");
  }

  const obj = value as Record<string, unknown>;
  if (obj.kind === "unified_patch" || typeof obj.patch === "string") {
    return {
      kind: "unified_patch",
      patch: asString(obj.patch, "patch"),
    };
  }

  return {
    kind: "find_replace",
    find: asString(obj.find, "find"),
    replace: typeof obj.replace === "string" ? obj.replace : "",
    all: obj.all === true,
  };
}

function applyFindReplace(input: string, edit: FindReplaceEdit): { content: string; replacements: number } {
  if (edit.find.length === 0) {
    throw new BridgeError("E_ARGS", "find cannot be empty");
  }

  if (edit.all) {
    const parts = input.split(edit.find);
    const replacements = parts.length - 1;
    if (replacements === 0) {
      throw new BridgeError("E_PATCH", "find_replace failed: target not found", { find: edit.find });
    }
    return {
      content: parts.join(edit.replace),
      replacements,
    };
  }

  const idx = input.indexOf(edit.find);
  if (idx < 0) {
    throw new BridgeError("E_PATCH", "find_replace failed: target not found", { find: edit.find });
  }

  return {
    content: `${input.slice(0, idx)}${edit.replace}${input.slice(idx + edit.find.length)}`,
    replacements: 1,
  };
}

export interface EditResult {
  path: string;
  applied: boolean;
  hunks: number;
  replacements: number;
}

export async function runEdit(args: Record<string, unknown>, fsGuard: FsGuard): Promise<EditResult> {
  const filePath = asString(args.path, "path");
  const cwd = asOptionalString(args.cwd, "cwd");
  const edits = parseEdits(args.edits);

  const resolved = await fsGuard.resolveWrite(filePath, cwd);
  const original = await readFile(resolved, "utf8").catch((err) => {
    throw new BridgeError("E_PATH", "Failed to read file for edit", { path: resolved, cause: String(err) });
  });

  let content = original;
  let hunks = 0;
  let replacements = 0;

  for (const edit of edits) {
    if (edit.kind === "unified_patch") {
      const applied = applyUnifiedPatch(content, edit.patch);
      content = applied.content;
      hunks += applied.hunksApplied;
      continue;
    }

    const applied = applyFindReplace(content, edit);
    content = applied.content;
    replacements += applied.replacements;
  }

  if (content === original) {
    throw new BridgeError("E_PATCH", "No changes produced by edits");
  }

  await writeFile(resolved, content, "utf8").catch((err) => {
    throw new BridgeError("E_PATH", "Failed to write edited file", { path: resolved, cause: String(err) });
  });

  return {
    path: resolved,
    applied: true,
    hunks,
    replacements,
  };
}
