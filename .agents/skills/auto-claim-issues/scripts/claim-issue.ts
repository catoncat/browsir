#!/usr/bin/env bun

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Status = "open" | "in-progress" | "done";
type Priority = "p0" | "p1" | "p2";

type FrontmatterValue = string | string[];

interface Frontmatter {
  order: string[];
  data: Record<string, FrontmatterValue>;
}

interface IssueFile {
  path: string;
  filename: string;
  body: string;
  frontmatter: Frontmatter;
}

interface ParsedArgs {
  issueId?: string;
  assignee: string;
  group?: string;
  dryRun: boolean;
  json: boolean;
  allowConflicts: boolean;
}

type ClaimResult =
  | {
      kind: "claimed" | "preview";
      issue: ReturnType<typeof toIssueSummary>;
      reason: string;
    }
  | {
      kind: "blocked";
      reason: string;
      blockedByDependencies: Array<ReturnType<typeof toIssueSummary>>;
      blockedByConflicts: Array<ReturnType<typeof toIssueSummary>>;
    }
  | {
      kind: "already_claimed";
      issue: ReturnType<typeof toIssueSummary>;
      reason: string;
    };

function fail(message: string): never {
  console.error(`[auto-claim-issues] ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    assignee: "agent",
    dryRun: false,
    json: false,
    allowConflicts: false,
  };

  for (const item of argv) {
    if (item === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (item === "--json") {
      out.json = true;
      continue;
    }
    if (item === "--allow-conflicts") {
      out.allowConflicts = true;
      continue;
    }
    if (!item.startsWith("--")) continue;
    const eq = item.indexOf("=");
    const key = eq >= 0 ? item.slice(2, eq) : item.slice(2);
    const value = eq >= 0 ? item.slice(eq + 1).trim() : "";
    if (key === "issue" && value) out.issueId = value;
    if (key === "assignee" && value) out.assignee = value;
    if (key === "group" && value) out.group = value;
  }

  return out;
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean);
}

function stripQuotes(raw: string): string {
  const text = String(raw || "").trim();
  if (
    (text.startsWith("\"") && text.endsWith("\"")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) fail("backlog 文件缺少合法 frontmatter");
  const yaml = String(match[1] || "");
  const body = String(match[2] || "");
  const lines = yaml.split(/\r?\n/);
  const data: Record<string, FrontmatterValue> = {};
  const order: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) continue;
    const key = top[1];
    const rest = top[2];
    order.push(key);
    if (!rest) {
      const items: string[] = [];
      let cursor = i + 1;
      while (cursor < lines.length) {
        const child = lines[cursor];
        const bullet = child.match(/^\s*-\s+(.*)$/);
        if (!bullet) break;
        items.push(stripQuotes(bullet[1]));
        cursor += 1;
      }
      data[key] = items;
      i = cursor - 1;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = parseInlineArray(rest);
      continue;
    }
    data[key] = stripQuotes(rest);
  }

  return {
    frontmatter: { order, data },
    body,
  };
}

function formatScalar(raw: string): string {
  const text = String(raw ?? "");
  if (/^[A-Za-z0-9._/-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function serializeFrontmatter(frontmatter: Frontmatter): string {
  const seen = new Set<string>();
  const keys = [...frontmatter.order, ...Object.keys(frontmatter.data)].filter((key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lines: string[] = ["---"];
  for (const key of keys) {
    const value = frontmatter.data[key];
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${formatScalar(item)}`);
        }
      }
      continue;
    }
    lines.push(`${key}: ${formatScalar(String(value || ""))}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function loadIssueFile(filePath: string): IssueFile {
  const text = readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(text);
  return {
    path: filePath,
    filename: path.basename(filePath),
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  };
}

function writeIssueFile(issue: IssueFile): void {
  const next = `${serializeFrontmatter(issue.frontmatter)}\n${issue.body.replace(/^\n*/, "")}`;
  writeFileSync(issue.path, next, "utf8");
}

function readString(issue: IssueFile, key: string): string {
  const value = issue.frontmatter.data[key];
  return Array.isArray(value) ? "" : String(value || "").trim();
}

function readArray(issue: IssueFile, key: string): string[] {
  const value = issue.frontmatter.data[key];
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (!value) return [];
  return [String(value).trim()].filter(Boolean);
}

function normalizeScope(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/\/\*$/, "")
    .replace(/\*$/, "")
    .replace(/\/+$/, "");
}

function scopesConflict(a: string, b: string): boolean {
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function issueStatus(issue: IssueFile): Status {
  const value = readString(issue, "status");
  if (value === "open" || value === "in-progress" || value === "done") {
    return value;
  }
  return "open";
}

function issuePriority(issue: IssueFile): Priority {
  const value = readString(issue, "priority");
  if (value === "p0" || value === "p1" || value === "p2") return value;
  return "p2";
}

function priorityRank(priority: Priority): number {
  if (priority === "p0") return 0;
  if (priority === "p1") return 1;
  return 2;
}

function toIssueSummary(issue: IssueFile) {
  return {
    id: readString(issue, "id"),
    title: readString(issue, "title"),
    status: issueStatus(issue),
    priority: issuePriority(issue),
    parallel_group: readString(issue, "parallel_group"),
    depends_on: readArray(issue, "depends_on"),
    write_scope: readArray(issue, "write_scope"),
    path: path.relative(process.cwd(), issue.path),
  };
}

function findById(issues: IssueFile[], issueId: string): IssueFile | undefined {
  return issues.find((issue) => readString(issue, "id") === issueId);
}

function dependenciesSatisfied(issue: IssueFile, all: IssueFile[]): boolean {
  const deps = readArray(issue, "depends_on");
  if (deps.length === 0) return true;
  return deps.every((depId) => issueStatus(findById(all, depId) || issue) === "done");
}

function hasScopeConflict(issue: IssueFile, active: IssueFile[]): boolean {
  const currentScopes = readArray(issue, "write_scope");
  if (currentScopes.length === 0) return false;
  return active.some((other) => {
    const otherId = readString(other, "id");
    const currentId = readString(issue, "id");
    if (otherId === currentId) return false;
    const otherScopes = readArray(other, "write_scope");
    return currentScopes.some((left) => otherScopes.some((right) => scopesConflict(left, right)));
  });
}

function loadAllIssues(repoRoot: string): IssueFile[] {
  const backlogDir = path.join(repoRoot, "docs", "backlog");
  const files = readdirSync(backlogDir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
  return files.map((name) => loadIssueFile(path.join(backlogDir, name)));
}

function chooseIssue(issues: IssueFile[], args: ParsedArgs): ClaimResult {
  const active = issues.filter((issue) => issueStatus(issue) === "in-progress");

  if (args.issueId) {
    const exact = findById(issues, args.issueId);
    if (!exact) fail(`未找到 issue: ${args.issueId}`);
    if (issueStatus(exact) === "in-progress") {
      return {
        kind: "already_claimed",
        issue: toIssueSummary(exact),
        reason: "指定 issue 已经是 in-progress",
      };
    }
    if (issueStatus(exact) === "done") {
      fail(`指定 issue 已完成，不能重新 claim: ${args.issueId}`);
    }
    if (!dependenciesSatisfied(exact, issues)) {
      return {
        kind: "blocked",
        reason: "指定 issue 的 depends_on 尚未完成",
        blockedByDependencies: [toIssueSummary(exact)],
        blockedByConflicts: [],
      };
    }
    if (!args.allowConflicts && hasScopeConflict(exact, active)) {
      return {
        kind: "blocked",
        reason: "指定 issue 与当前 in-progress write_scope 冲突",
        blockedByDependencies: [],
        blockedByConflicts: [toIssueSummary(exact)],
      };
    }
    return {
      kind: args.dryRun ? "preview" : "claimed",
      issue: toIssueSummary(exact),
      reason: args.issueId ? "按指定 issue 认领" : "按条件自动认领",
    };
  }

  const candidates = issues
    .filter((issue) => issueStatus(issue) === "open")
    .filter((issue) => !args.group || readString(issue, "parallel_group") === args.group);

  const claimable = candidates
    .filter((issue) => dependenciesSatisfied(issue, issues))
    .filter((issue) => args.allowConflicts || !hasScopeConflict(issue, active))
    .sort((a, b) => {
      const prio = priorityRank(issuePriority(a)) - priorityRank(issuePriority(b));
      if (prio !== 0) return prio;
      const created = readString(a, "created").localeCompare(readString(b, "created"));
      if (created !== 0) return created;
      return readString(a, "id").localeCompare(readString(b, "id"));
    });

  if (claimable[0]) {
    return {
      kind: args.dryRun ? "preview" : "claimed",
      issue: toIssueSummary(claimable[0]),
      reason: "按优先级、依赖和 write_scope 冲突规则自动认领",
    };
  }

  return {
    kind: "blocked",
    reason: "当前没有可认领的 open issue",
    blockedByDependencies: candidates
      .filter((issue) => !dependenciesSatisfied(issue, issues))
      .map(toIssueSummary)
      .slice(0, 5),
    blockedByConflicts: candidates
      .filter((issue) => dependenciesSatisfied(issue, issues))
      .filter((issue) => hasScopeConflict(issue, active))
      .map(toIssueSummary)
      .slice(0, 5),
  };
}

function claimIssueFile(issue: IssueFile, assignee: string): void {
  issue.frontmatter.data.status = "in-progress";
  issue.frontmatter.data.assignee = assignee;
  issue.frontmatter.data.claimed_at = new Date().toISOString();
  if (!issue.frontmatter.order.includes("claimed_at")) {
    issue.frontmatter.order.push("claimed_at");
  }
  writeIssueFile(issue);
}

function printResult(result: ClaimResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.kind === "blocked") {
    console.log(`result: ${result.kind}`);
    console.log(`reason: ${result.reason}`);
    if (result.blockedByDependencies.length > 0) {
      console.log("blockedByDependencies:");
      for (const item of result.blockedByDependencies) {
        console.log(`- ${item.id} ${item.title}`);
      }
    }
    if (result.blockedByConflicts.length > 0) {
      console.log("blockedByConflicts:");
      for (const item of result.blockedByConflicts) {
        console.log(`- ${item.id} ${item.title}`);
      }
    }
    return;
  }

  console.log(`result: ${result.kind}`);
  console.log(`reason: ${result.reason}`);
  console.log(`id: ${result.issue.id}`);
  console.log(`title: ${result.issue.title}`);
  console.log(`parallel_group: ${result.issue.parallel_group}`);
  console.log(`path: ${result.issue.path}`);
  console.log(`depends_on: ${result.issue.depends_on.join(", ") || "(none)"}`);
  console.log(`write_scope: ${result.issue.write_scope.join(", ") || "(none)"}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const issues = loadAllIssues(repoRoot);
  const result = chooseIssue(issues, args);

  if (result.kind === "claimed") {
    const target = findById(issues, result.issue.id);
    if (!target) fail(`claim 目标不存在: ${result.issue.id}`);
    claimIssueFile(target, args.assignee);
    const refreshed = loadIssueFile(target.path);
    printResult(
      {
        ...result,
        issue: toIssueSummary(refreshed),
      },
      args.json,
    );
    return;
  }

  printResult(result, args.json);
}

main();
