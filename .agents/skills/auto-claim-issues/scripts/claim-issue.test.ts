import { describe, expect, test } from "bun:test";

import {
  chooseIssue,
  dependenciesSatisfied,
  parseFrontmatter,
  type IssueFile,
} from "./claim-issue";

function issueFromFrontmatter(frontmatterBlock: string): IssueFile {
  const parsed = parseFrontmatter(`${frontmatterBlock}\nbody\n`);
  return {
    path: "/tmp/issue.md",
    filename: "issue.md",
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}

describe("auto-claim-issues", () => {
  test("parses inline array values with trailing comments", () => {
    const issue = issueFromFrontmatter(`---
id: ISSUE-005
title: Example
status: open
priority: p0
depends_on: [ISSUE-004]  # single-writer constraint
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
---`);

    expect(issue.frontmatter.data.depends_on).toEqual(["ISSUE-004"]);
  });

  test("treats missing dependency as unsatisfied", () => {
    const issue = issueFromFrontmatter(`---
id: ISSUE-010
title: Needs missing dep
status: open
priority: p0
depends_on: [ISSUE-999]
write_scope: []
---`);

    expect(dependenciesSatisfied(issue, [issue])).toBe(false);
  });

  test("blocks scope-conflicting open issue when another issue is in progress", () => {
    const active = issueFromFrontmatter(`---
id: ISSUE-004
title: Active
status: in-progress
priority: p0
depends_on: []
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
---`);
    const candidate = issueFromFrontmatter(`---
id: ISSUE-005
title: Candidate
status: open
priority: p0
depends_on: []
write_scope:
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-browser-proof.ts
---`);

    const result = chooseIssue([active, candidate], {
      assignee: "agent",
      dryRun: true,
      json: false,
      allowConflicts: false,
    });

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.blockedByConflicts.map((item) => item.id)).toEqual(["ISSUE-005"]);
    }
  });
});
