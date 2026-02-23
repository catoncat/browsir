import { BridgeError } from "./errors";

export interface ResolvedCommand {
  argv: string[];
  risk: "low" | "medium" | "high";
}

interface CommandSpec {
  cmd: string;
  staticArgs?: string[];
  allowArgs: boolean;
  maxArgs?: number;
  risk: "low" | "medium" | "high";
  allowInStrict?: boolean;
}

const COMMANDS: Record<string, CommandSpec> = {
  "bash.exec": { cmd: "bash", staticArgs: ["-lc"], allowArgs: true, maxArgs: 1, risk: "high", allowInStrict: true },

  "rg.search": { cmd: "rg", allowArgs: true, maxArgs: 48, risk: "low" },
  "rg.files": { cmd: "rg", staticArgs: ["--files"], allowArgs: true, maxArgs: 24, risk: "low" },

  "git.status": { cmd: "git", staticArgs: ["status", "--short", "--branch"], allowArgs: false, risk: "low" },
  "git.diff": { cmd: "git", staticArgs: ["diff"], allowArgs: true, maxArgs: 24, risk: "low" },
  "git.show": { cmd: "git", staticArgs: ["show"], allowArgs: true, maxArgs: 24, risk: "low" },

  "bun.test": { cmd: "bun", staticArgs: ["test"], allowArgs: true, maxArgs: 32, risk: "low" },
  "bun.run": { cmd: "bun", staticArgs: ["run"], allowArgs: true, maxArgs: 32, risk: "medium" },
  "bun.install": { cmd: "bun", staticArgs: ["install"], allowArgs: true, maxArgs: 16, risk: "medium" },

  "npm.run": { cmd: "npm", staticArgs: ["run"], allowArgs: true, maxArgs: 32, risk: "medium" },
  "pnpm.run": { cmd: "pnpm", staticArgs: ["run"], allowArgs: true, maxArgs: 32, risk: "medium" },

  "uv.run": { cmd: "uv", staticArgs: ["run"], allowArgs: true, maxArgs: 32, risk: "medium" },

  "node.exec": { cmd: "node", allowArgs: true, maxArgs: 32, risk: "medium" },
  "python.exec": { cmd: "python3", allowArgs: true, maxArgs: 32, risk: "medium" },
};

interface ResolveCommandOptions {
  strictMode?: boolean;
  enableBashExec?: boolean;
}

function validateArg(arg: string): void {
  if (arg.length > 2048) {
    throw new BridgeError("E_ARGS", "Argument too long", { arg: `${arg.slice(0, 80)}...` });
  }
  if (/\u0000/.test(arg)) {
    throw new BridgeError("E_ARGS", "Argument contains null byte");
  }
}

export function resolveCommand(cmdId: string, args: string[], options: ResolveCommandOptions = {}): ResolvedCommand {
  const spec = COMMANDS[cmdId];
  if (!spec) {
    throw new BridgeError("E_CMD", "cmdId is not whitelisted", { cmdId });
  }

  if (cmdId === "bash.exec" && !options.enableBashExec) {
    throw new BridgeError("E_CMD", "bash.exec is disabled by BRIDGE_ENABLE_BASH_EXEC", {
      cmdId,
      enableHint: "Set BRIDGE_ENABLE_BASH_EXEC=false to disable"
    });
  }

  if (options.strictMode && spec.allowInStrict === false) {
    throw new BridgeError("E_CMD", "cmdId is not allowed in strict mode", {
      cmdId
    });
  }

  if (!spec.allowArgs && args.length > 0) {
    throw new BridgeError("E_ARGS", "This cmdId does not allow custom args", { cmdId });
  }

  if (spec.maxArgs !== undefined && args.length > spec.maxArgs) {
    throw new BridgeError("E_ARGS", "Too many args", {
      cmdId,
      maxArgs: spec.maxArgs,
      got: args.length,
    });
  }

  for (const arg of args) {
    validateArg(arg);
  }

  return {
    argv: [spec.cmd, ...(spec.staticArgs ?? []), ...args],
    risk: spec.risk,
  };
}

export function listCommandIds(): string[] {
  return Object.keys(COMMANDS).sort();
}
