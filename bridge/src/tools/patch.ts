import { BridgeError } from "../errors";

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function parseHunks(patch: string): Hunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("@@")) {
      i += 1;
      continue;
    }

    const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!m) {
      throw new BridgeError("E_PATCH", "Invalid hunk header", { header: line });
    }

    const hunk: Hunk = {
      oldStart: Number.parseInt(m[1]!, 10),
      oldCount: Number.parseInt(m[2] ?? "1", 10),
      newStart: Number.parseInt(m[3]!, 10),
      newCount: Number.parseInt(m[4] ?? "1", 10),
      lines: [],
    };

    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.startsWith("@@")) break;
      if (next.startsWith("\\ No newline at end of file")) {
        i += 1;
        continue;
      }
      hunk.lines.push(next);
      i += 1;
    }

    hunks.push(hunk);
  }

  if (hunks.length === 0) {
    throw new BridgeError("E_PATCH", "No hunks found in unified patch");
  }

  return hunks;
}

function splitText(text: string): { lines: string[]; hasTrailingNewline: boolean } {
  if (text.length === 0) {
    return { lines: [], hasTrailingNewline: false };
  }
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  return { lines, hasTrailingNewline };
}

export function applyUnifiedPatch(original: string, patch: string): { content: string; hunksApplied: number } {
  const hunks = parseHunks(patch);
  const { lines: originalLines, hasTrailingNewline } = splitText(original);

  const output: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) {
      throw new BridgeError("E_PATCH", "Overlapping hunks", { oldStart: hunk.oldStart });
    }

    output.push(...originalLines.slice(cursor, start));
    cursor = start;

    for (const line of hunk.lines) {
      const op = line[0];
      const body = line.slice(1);

      if (op === " ") {
        const got = originalLines[cursor] ?? "";
        if (got !== body) {
          throw new BridgeError("E_PATCH", "Context mismatch while applying patch", {
            expected: body,
            got,
            line: cursor + 1,
          });
        }
        output.push(got);
        cursor += 1;
        continue;
      }

      if (op === "-") {
        const got = originalLines[cursor] ?? "";
        if (got !== body) {
          throw new BridgeError("E_PATCH", "Delete mismatch while applying patch", {
            expected: body,
            got,
            line: cursor + 1,
          });
        }
        cursor += 1;
        continue;
      }

      if (op === "+") {
        output.push(body);
        continue;
      }

      throw new BridgeError("E_PATCH", "Invalid patch line", { line });
    }
  }

  output.push(...originalLines.slice(cursor));

  let content = output.join("\n");
  if (hasTrailingNewline) {
    content += "\n";
  }

  return {
    content,
    hunksApplied: hunks.length,
  };
}
