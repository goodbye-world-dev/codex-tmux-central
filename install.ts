#!/usr/bin/env bun

import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";

type HookHandler = {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
};

type HookGroup = {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
};

type HooksConfig = {
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
};

const TMUX_START = "# >>> codex-tmux-central >>>";
const TMUX_END = "# <<< codex-tmux-central <<<";
const ZSH_START = "# >>> codex-tmux-central >>>";
const ZSH_END = "# <<< codex-tmux-central <<<";

const options = parseArgs(process.argv.slice(2));
const targetHome = options.targetHome ?? process.env.HOME;

if (!targetHome) {
  throw new Error("Cannot determine the target home directory.");
}

for (const command of ["bun", "tmux", "codex"]) {
  if (!Bun.which(command)) {
    throw new Error(`Required command not found: ${command}`);
  }
}

const repoRoot = import.meta.dir;
const hookSource = join(repoRoot, "src", "tmux-status.ts");
const tmuxSnippet = (await readFile(join(repoRoot, "snippets", "tmux.conf"), "utf8")).trim();
const launcherSource = await readFile(join(repoRoot, "snippets", "tcodex.zsh"), "utf8");

const hookTarget = join(targetHome, ".codex", "hooks", "tmux-status.ts");
const hooksConfigTarget = join(targetHome, ".codex", "hooks.json");
const tmuxConfigTarget = join(targetHome, ".tmux.conf");
const launcherTarget = join(targetHome, ".config", "codex-tmux-central", "tcodex.zsh");
const zshConfigTarget = join(targetHome, ".zshrc");
const timestamp = new Date().toISOString().replaceAll(":", "-");
const backupRoot = join(targetHome, ".codex-tmux-central", "backups", timestamp);

const existingHooksText = await readOptional(hooksConfigTarget);
const hooksConfig = parseHooksConfig(existingHooksText, hooksConfigTarget);
const hookCommand = shellQuote(hookTarget);
const desiredHooks = mergeHooks(hooksConfig, hookCommand);
const desiredTmuxConfig = addManagedBlock(
  await readOptional(tmuxConfigTarget),
  TMUX_START,
  TMUX_END,
  tmuxSnippet,
);
const desiredZshConfig = addManagedBlock(
  await readOptional(zshConfigTarget),
  ZSH_START,
  ZSH_END,
  'source "$HOME/.config/codex-tmux-central/tcodex.zsh"',
);

await installFile(hookSource, hookTarget, 0o755);
await installText(hooksConfigTarget, `${JSON.stringify(desiredHooks, null, 2)}\n`);
await installText(tmuxConfigTarget, desiredTmuxConfig);
await installText(launcherTarget, launcherSource, 0o644);
await installText(zshConfigTarget, desiredZshConfig);

if (options.dryRun) {
  console.log("Dry run complete; no files were changed.");
} else {
  console.log("codex-tmux-central installed.");
  console.log(`Backups: ${backupRoot}`);
  console.log("Next steps:");
  console.log("  1. Run: tmux source-file ~/.tmux.conf");
  console.log("  2. Run: source ~/.zshrc");
  console.log("  3. Start Codex and use /hooks to trust the new hooks");
  console.log("  4. Launch a project with: tcodex <directory>");
}

async function installFile(source: string, target: string, mode: number): Promise<void> {
  const current = await readOptional(target);
  const desired = await readFile(source, "utf8");
  if (current === desired) {
    if (!options.dryRun) await chmod(target, mode);
    return;
  }

  logChange(target);
  if (options.dryRun) return;
  await backup(target);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, mode);
}

async function installText(target: string, desired: string, mode?: number): Promise<void> {
  const current = await readOptional(target);
  if (current === desired) {
    if (!options.dryRun && mode !== undefined) await chmod(target, mode);
    return;
  }

  logChange(target);
  if (options.dryRun) return;
  await backup(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, desired, "utf8");
  if (mode !== undefined) await chmod(target, mode);
}

async function backup(path: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return;
  } catch {
    return;
  }

  const destination = join(backupRoot, relative(targetHome!, path));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(path, destination);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

function parseHooksConfig(text: string, path: string): HooksConfig {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as HooksConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${String(error)}`);
  }
}

function mergeHooks(config: HooksConfig, command: string): HooksConfig {
  const hooks = { ...(config.hooks ?? {}) };
  const definitions: Record<string, HookGroup> = {
    SessionStart: {
      matcher: "startup|resume|clear",
      hooks: [{ type: "command", command, timeout: 3 }],
    },
    UserPromptSubmit: {
      hooks: [{ type: "command", command, timeout: 3 }],
    },
    PermissionRequest: {
      hooks: [{ type: "command", command, timeout: 3 }],
    },
    SubagentStart: {
      hooks: [{ type: "command", command, timeout: 3 }],
    },
    SubagentStop: {
      hooks: [{ type: "command", command, timeout: 3 }],
    },
    Stop: {
      hooks: [{ type: "command", command, timeout: 3 }],
    },
    SessionEnd: {
      hooks: [{ type: "command", command, timeout: 3 }],
    },
  };

  for (const [event, definition] of Object.entries(definitions)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...stripInstalledHandlers(groups),
      definition,
    ];
  }

  return {
    ...config,
    description: config.description ?? "User-level Codex lifecycle hooks.",
    hooks,
  };
}

function stripInstalledHandlers(groups: HookGroup[]): HookGroup[] {
  return groups.flatMap((group) => {
    const handlers = Array.isArray(group.hooks) ? group.hooks : [];
    const remaining = handlers.filter((handler) =>
      typeof handler.command !== "string" || !handler.command.includes("tmux-status.ts")
    );
    if (remaining.length === 0) return [];
    return [{ ...group, hooks: remaining }];
  });
}

function addManagedBlock(content: string, start: string, end: string, body: string): string {
  let base = content;
  const startIndex = base.indexOf(start);
  if (startIndex >= 0) {
    const endIndex = base.indexOf(end, startIndex + start.length);
    if (endIndex < 0) {
      throw new Error(`Found ${start} without matching ${end}.`);
    }
    base = `${base.slice(0, startIndex)}${base.slice(endIndex + end.length)}`;
  }

  const trimmed = base.trimEnd();
  const prefix = trimmed ? `${trimmed}\n\n` : "";
  return `${prefix}${start}\n${body.trim()}\n${end}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function logChange(path: string): void {
  console.log(`${options.dryRun ? "Would update" : "Updating"}: ${path}`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseArgs(args: string[]): { dryRun: boolean; targetHome?: string } {
  let dryRun = false;
  let targetHome: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--target-home") {
      targetHome = args[index + 1];
      if (!targetHome) throw new Error("--target-home requires a path");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { dryRun, targetHome };
}
