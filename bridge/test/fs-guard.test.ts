import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
});
