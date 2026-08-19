#!/usr/bin/env bun

import { mkdir, readFile, rm } from "node:fs/promises";

type HookInput = {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
};

type State = {
  agents: Record<string, string>;
};

const rawInput = await Bun.stdin.text();
let input: HookInput = {};

try {
  input = JSON.parse(rawInput) as HookInput;
} catch {
  finish();
}

const event = input.hook_event_name ?? "";
const supportedEvents = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
]);

if (!supportedEvents.has(event)) {
  finish(event);
}

const pane = process.env.TMUX_PANE;
if (!process.env.TMUX || !pane) {
  finish(event);
}

const sessionId = safeToken(input.session_id ?? "unknown");
const stateRoot = `${process.env.TMPDIR ?? "/tmp"}/codex-tmux-status`;
const statePath = `${stateRoot}/${sessionId}.json`;
const lockPath = `${statePath}.lock`;

await mkdir(stateRoot, { recursive: true });

let status = "";
let clearOptions = false;
let state: State = { agents: {} };
let locked = false;

for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    await mkdir(lockPath);
    locked = true;
    break;
  } catch {
    await Bun.sleep(25);
  }
}

try {
  state = await loadState(statePath);

  switch (event) {
    case "SessionStart":
      state.agents = {};
      status = "🟢 IDLE";
      break;
    case "UserPromptSubmit":
      state.agents = {};
      status = "🟡 WORK";
      break;
    case "PermissionRequest":
      status = "#[blink]🔴 INPUT#[noblink]";
      break;
    case "SubagentStart":
      if (input.agent_id) {
        state.agents[input.agent_id] = safeLabel(input.agent_type ?? "agent");
      }
      status = "🟡 WORK";
      break;
    case "SubagentStop":
      if (input.agent_id) {
        delete state.agents[input.agent_id];
      }
      status = "🟡 WORK";
      break;
    case "Stop":
      state.agents = {};
      status = "🟢 IDLE";
      break;
    case "SessionEnd":
      clearOptions = true;
      state.agents = {};
      break;
  }

  if (event === "SessionEnd") {
    await rm(statePath, { force: true });
  } else {
    await Bun.write(statePath, `${JSON.stringify(state)}\n`);
  }
} finally {
  if (locked) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

if (clearOptions) {
  runTmux(["set-window-option", "-u", "-t", pane, "@codex_status"]);
  runTmux(["set-window-option", "-u", "-t", pane, "@codex_agents_label"]);
} else {
  const agents = Object.values(state.agents);
  const agentLabel = agents.length === 0
    ? ""
    : agents.length === 1
      ? ` 🤖1 ${agents[0]}`
      : ` 🤖${agents.length}`;

  runTmux(["set-window-option", "-t", pane, "@codex_status", status]);
  runTmux(["set-window-option", "-t", pane, "@codex_agents_label", agentLabel]);
}

runTmux(["refresh-client", "-S"]);
finish(event);

async function loadState(path: string): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<State>;
    return { agents: parsed.agents ?? {} };
  } catch {
    return { agents: {} };
  }
}

function runTmux(args: string[]): void {
  Bun.spawnSync(["tmux", ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

function safeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}

function safeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24) || "agent";
}

function finish(hookEvent?: string): never {
  if (hookEvent === "Stop" || hookEvent === "SubagentStop") {
    process.stdout.write("{}\n");
  }
  process.exit(0);
}
