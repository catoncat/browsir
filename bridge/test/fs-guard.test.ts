import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsGuard } from "../src/fs-guard";

describe("FsGuard strict mode", () => {
  test("allows inside root and denies outside root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "bridge-out-"));

    try {
      const nested = path.join(root, "a");
      await mkdir(nested, { recursive: true });
      const allowedFile = path.join(nested, "ok.txt");
      const deniedFile = path.join(outside, "no.txt");
      await writeFile(allowedFile, "ok", "utf8");
      await writeFile(deniedFile, "no", "utf8");

      const guard = new FsGuard("strict", [root]);
      const resolved = await guard.resolveRead(allowedFile);
      expect(resolved).toContain(root);

      await expect(guard.resolveRead(deniedFile)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("resolveInspect allows missing target under allowed root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-root-inspect-"));
    try {
      const guard = new FsGuard("strict", [root]);
      const resolved = await guard.resolveInspect("missing/file.txt", root);
      expect(resolved).toBe(
        path.join(await realpath(root), "missing", "file.txt"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expands ~/ to host home directory", async () => {
    const guard = new FsGuard("god", []);
    const resolved = await guard.resolveInspect("~/bbl-home-check.txt");
    expect(resolved.startsWith(path.join(os.homedir(), path.sep))).toBe(true);
  });
});
