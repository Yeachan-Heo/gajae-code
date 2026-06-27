#!/usr/bin/env bun

/**
 * Generate the canonical gajae-code host plugin bundles under `plugins/`.
 *
 * Single source of truth: the coordinator contract tool names plus the
 * coding-agent package version. Host bundles (Claude Code + Codex) and the
 * shared MCP wiring are rendered deterministically so a drift check can fail
 * CI when the committed files diverge from this renderer.
 *
 * Usage:
 *   bun scripts/generate-gjc-plugins.ts            # write files
 *   bun scripts/generate-gjc-plugins.ts --check    # compare bytes, exit 1 on drift
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { COORDINATOR_MCP_TOOL_NAMES } from "../packages/coding-agent/src/coordinator/contract";

const repoRoot = path.join(import.meta.dir, "..");
const pluginsDir = path.join(repoRoot, "plugins");

const DELEGATE_TOOLS = COORDINATOR_MCP_TOOL_NAMES.filter(name => name.startsWith("gjc_delegate_"));

const PLUGIN_NAME = "gajae-code";
const NAMESPACE_LABEL = "gajae-code-plugin";

interface DelegateMeta {
	tool: string;
	workflow: "plan" | "execute" | "team";
	skill: "ralplan" | "ultragoal" | "team";
	summary: string;
}

const DELEGATE_META: DelegateMeta[] = [
	{
		tool: "gjc_delegate_plan",
		workflow: "plan",
		skill: "ralplan",
		summary: "Delegate consensus planning to GJC (runs /skill:ralplan to a pending-approval plan).",
	},
	{
		tool: "gjc_delegate_execute",
		workflow: "execute",
		skill: "ultragoal",
		summary: "Delegate execution to GJC (runs /skill:ultragoal to completion with verification).",
	},
	{
		tool: "gjc_delegate_team",
		workflow: "team",
		skill: "team",
		summary: "Delegate parallel team execution to GJC (runs /skill:team with internal tmux workers).",
	},
];

function readPackageVersion(): string {
	const pkgPath = path.join(repoRoot, "packages", "coding-agent", "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
	if (!pkg.version) throw new Error("coding-agent package.json is missing a version");
	return pkg.version;
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function coordinatorServer(projectDirToken: string): Record<string, unknown> {
	return {
		"gjc-coordinator": {
			command: "gjc",
			args: ["mcp-serve", "coordinator"],
			env: {
				GJC_COORDINATOR_MCP_WORKDIR_ROOTS: projectDirToken,
				GJC_COORDINATOR_MCP_REPO: NAMESPACE_LABEL,
				GJC_COORDINATOR_MCP_SESSION_COMMAND: "gjc --worktree",
			},
		},
	};
}

// Claude Code expects an `mcpServers` wrapper in .mcp.json.
function claudeMcpServers(projectDirToken: string): Record<string, unknown> {
	// Fail-closed: workdir allowlist scoped to the host project; mutations omitted.
	return { mcpServers: coordinatorServer(projectDirToken) };
}

// Codex accepts a direct server map or an `mcp_servers` wrapper. Verified on
// Codex CLI 0.139.0, the direct map registers the server (an `mcp_servers`
// wrapper did not), so emit the direct, docs-blessed map.
function codexMcpServers(projectDirToken: string): Record<string, unknown> {
	return coordinatorServer(projectDirToken);
}

function commandDoc(meta: DelegateMeta): string {
	return `---
name: ${meta.workflow}
description: ${meta.summary}
---

Call the \`${meta.tool}\` coordinator MCP tool to delegate this work to gajae-code.

- Pass the current project directory as \`cwd\`.
- Pass the user's request as \`task\`.
- Only set \`allow_mutation: true\` after the user explicitly approves changes AND
  the coordinator server was started with the \`sessions\` mutation class enabled.
  Delegation is read-only until both conditions hold.

GJC starts a session and runs \`/skill:${meta.skill}\` to completion, returning a
durable \`turn_id\`, status, and artifact references. Poll with
\`gjc_coordinator_await_turn\` or \`gjc_coordinator_watch_events\`.
`;
}

function skillDoc(): string {
	const rows = DELEGATE_META.map(
		meta => `| \`${meta.tool}\` | ${meta.workflow} | /skill:${meta.skill} | ${meta.summary} |`,
	).join("\n");
	return `---
name: gjc-delegation
description: Delegate planning, execution, and team workflows to gajae-code via the coordinator MCP server.
---

# GJC delegation

This plugin exposes gajae-code's coordinator MCP server so a host agent can
delegate whole workflows to GJC and receive durable turn status plus artifacts.

## Tools

| Tool | Workflow | GJC skill | Purpose |
| --- | --- | --- | --- |
${rows}

## Fail-closed safety

The bundled MCP config sets \`GJC_COORDINATOR_MCP_WORKDIR_ROOTS\` to the host
project directory and does **not** set \`GJC_COORDINATOR_MCP_MUTATIONS\`.
Delegation is read-only until the user explicitly enables a mutation class and
passes \`allow_mutation: true\` per call. \`GJC_COORDINATOR_MCP_REPO\` is a
namespace label only, never a filesystem path.

## Polling

Each delegate returns a \`turn_id\`. Poll \`gjc_coordinator_await_turn\` (bounded)
or \`gjc_coordinator_watch_events\` for the \`delegation.started\` event and the
terminal turn state. Turn state is the source of truth, not terminal scrollback.
`;
}
function sessionSkillDoc(): string {
	return `---
name: gjc-session
description: Use GJC's published tmux session helpers for Clawhip-visible worktree sessions, prompt injection, tail checks, and harness owner debugging.
---

# GJC session helpers

Use this skill when a task needs an operator-visible GJC session in tmux: Clawhip/Hermes/OpenClaw can watch the pane, route stale-session alerts, and send follow-up prompts while the work stays in a dedicated git worktree.

Prefer Coordinator MCP for pure machine control. Prefer RPC/ACP when a host owns the tools. Use this visible-session helper flow when humans or chatops need tmux scrollback and a stable session name.

## Public helpers

- \`scripts/gjc-session/create.sh\` starts interactive \`gjc\` in a named tmux session, validates the worktree, preserves the pane after exit, prints and writes the session-specific durable state path, writes \`metadata.json\`, mirrors pane output to \`pane.log\`, records lifecycle events in \`events.log\`, writes normal-exit \`final.json\`, and optionally registers a Clawhip-style router watch.
- \`scripts/gjc-session/prompt.sh\` sends text or an \`@file\` prompt after the pane looks like a ready GJC TUI; if the tmux session vanished, it refuses injection and prints the durable metadata/log/final/events recovery paths plus the last pane-log excerpt.
- \`scripts/gjc-session/tail.sh\` captures bounded pane output for readiness and acceptance checks, with durable metadata, pane-log, event-log, and final-status fallback when tmux vanished.
- \`scripts/gjc-session/harness-tmux-owner-start.sh\` starts the harness RuntimeOwner inside tmux for dogfood/debug cases that need visible owner liveness.
- \`docs/gjc-session-clawhip-routing.md\` documents the full routed-session contract.

## Standard flow

1. Prepare a dedicated worktree and branch for the issue or PR. Do not use the canonical checkout for visible routed work.
2. Pick a stable, unambiguous session name that includes the repository and artifact id, such as \`gajae-code-issue-1055-gjc-session-skill\`.
3. Start the session:

   \`\`\`sh
   ./scripts/gjc-session/create.sh <session-name> <worktree-path> [channel-id] [mention]
   \`\`\`

   Channel ids and mentions are runtime inputs owned by the host/router. Never hard-code private ids, bot mentions, credentials, tokens, or private host paths into public docs or scripts.
4. Confirm readiness with bounded tail output:

   \`\`\`sh
   ./scripts/gjc-session/tail.sh <session-name> 80
   \`\`\`

   Wait for a ready GJC TUI signal such as \`Gajae forge\`, \`Type your message\`, \`> Type your message\`, or \`Working\`.
5. Send the actual task separately:

   \`\`\`sh
   ./scripts/gjc-session/prompt.sh <session-name> @/path/to/task.md
   \`\`\`

6. Verify prompt acceptance from work evidence, not from pasted text alone. Acceptable evidence includes a tool call or file read, a plan/todo update, a diff or test command, a GitHub comment/review/PR URL, or a terminal verdict such as \`MERGE_READY\` or \`REQUEST_CHANGES\`.

If tmux disappears before terminal verdict, inspect the state path printed by \`create.sh\`: \`metadata.json\` identifies the worktree/session, \`pane.log\` contains the mirrored transcript, \`events.log\` records launch/exit milestones, and \`final.json\` is present when \`gjc\` exited normally. Use \`tail.sh <session-name> [lines]\` to surface these artifacts without a live tmux server.

## Prompt expectations

Include repository, worktree, branch, base branch, issue/PR id, scope, non-goals, verification, and whether to commit/push/open a PR. Keep channel and mention values outside the prompt unless the host policy explicitly requires them.

## Harness owner sessions

For harness/RPC dogfooding where the RuntimeOwner itself must remain visible, use:

\`\`\`sh
./scripts/gjc-session/harness-tmux-owner-start.sh <session-name> <workspace> [issue-or-pr] [branch-label] [base]
\`\`\`

The helper requires the branch label to match the workspace checkout and prints \`SESSION_ID\`, \`STATE_ROOT\`, \`TMUX_SESSION\`, and a bounded monitor-capture command.

## Anti-patterns

- Starting long-running visible repo work with \`gjc -p\` instead of an interactive tmux session.
- Running the owner process under short shell timeouts or wrappers that can SIGKILL the session.
- Treating tmux process existence or a visible pasted prompt as proof of acceptance.
- Restarting a vanished session without first checking its durable metadata, pane log, event log, and final status.
- Launching from a shared canonical checkout instead of a task worktree.
- Hard-coding private channel ids, mentions, tokens, credentials, or internal-only paths.
`;
}


function readmeDoc(): string {
	return `# gajae-code plugin (generated)

These files are generated by \`scripts/generate-gjc-plugins.ts\` from the
coordinator contract and the coding-agent package version. Do not edit them by
hand; run \`bun run generate-plugins\` and commit the result. CI runs
\`bun run check:plugins\` to fail on drift.

- \`.claude-plugin/plugin.json\` — Claude Code manifest.
- \`.codex-plugin/plugin.json\` — Codex manifest.
- \`.mcp.json\` — Claude coordinator MCP wiring (\${CLAUDE_PROJECT_DIR}).
- \`.codex.mcp.json\` — Codex coordinator MCP wiring (host-neutral; \`gjc setup codex\` rewrites concrete roots).
- \`commands/\`, \`skills/\` — host-facing delegate command + skill docs.

Install: \`codex plugin marketplace add ./plugins\` (Codex) or \`/plugin marketplace add ./plugins\` (Claude Code), then install the \`gajae-code\` plugin.
`;
}

export function renderPluginFiles(): Map<string, string> {
	const version = readPackageVersion();
	const files = new Map<string, string>();
	const dir = PLUGIN_NAME; // the plugin folder lives under plugins/<name>/

	// Codex repo marketplace (verified shape: source object + policy + category).
	// `codex plugin marketplace add ./plugins` reads this and loads ./gajae-code.
	files.set(
		path.join(".agents", "plugins", "marketplace.json"),
		json({
			name: `${PLUGIN_NAME}-local`,
			interface: { displayName: "Gajae Code" },
			plugins: [
				{
					name: PLUGIN_NAME,
					source: { source: "local", path: `./${dir}` },
					policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
					category: "Productivity",
				},
			],
		}),
	);

	// Claude Code marketplace (legacy-compatible; Codex can also read this).
	files.set(
		path.join(".claude-plugin", "marketplace.json"),
		json({
			name: PLUGIN_NAME,
			owner: { name: "Gajae Code" },
			metadata: { description: "GJC delegation plugin", version },
			plugins: [
				{
					name: PLUGIN_NAME,
					source: `./${dir}`,
					description: "Delegate GJC planning/execution/team workflows via coordinator MCP.",
					version,
					author: { name: "Gajae Code" },
					keywords: ["gjc", "delegation", "mcp", "planning", "agents"],
				},
			],
		}),
	);

	// Plugin folder: Claude manifest
	files.set(
		path.join(dir, ".claude-plugin", "plugin.json"),
		json({
			name: PLUGIN_NAME,
			description: "Delegate planning, execution, and team workflows to GJC through the coordinator MCP server.",
			version,
			commands: "./commands",
			skills: "./skills",
			mcpServers: "./.mcp.json",
		}),
	);

	// Plugin folder: Codex manifest (only plugin.json lives under .codex-plugin;
	// skills/.mcp.json live at the plugin root per Codex plugin anatomy).
	files.set(
		path.join(dir, ".codex-plugin", "plugin.json"),
		json({
			name: PLUGIN_NAME,
			version,
			description: "Delegate Codex tasks to GJC workflows through coordinator MCP.",
			skills: "./skills/",
			mcpServers: "./.codex.mcp.json",
		}),
	);

	// Per-host MCP wiring. Claude uses its ${CLAUDE_PROJECT_DIR} token; Codex gets a
	// host-neutral file that `gjc setup codex` rewrites with a concrete workdir root.
	files.set(path.join(dir, ".mcp.json"), json(claudeMcpServers("${CLAUDE_PROJECT_DIR}")));
	files.set(path.join(dir, ".codex.mcp.json"), json(codexMcpServers("${PWD}")));
	for (const meta of DELEGATE_META) {
		files.set(path.join(dir, "commands", `delegate_${meta.workflow}.md`), commandDoc(meta));
	}
	files.set(path.join(dir, "skills", "gjc-delegation", "SKILL.md"), skillDoc());
	files.set(path.join(dir, "skills", "gjc-session", "SKILL.md"), sessionSkillDoc());
	files.set(path.join(dir, "README.md"), readmeDoc());

	return files;
}

function writeFiles(files: Map<string, string>): void {
	// Clean-generate: remove any stale generated files before writing.
	fs.rmSync(pluginsDir, { recursive: true, force: true });
	for (const [rel, content] of files) {
		const target = path.join(pluginsDir, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	process.stdout.write(`Generated ${files.size} plugin file(s) under plugins/\n`);
}

function checkFiles(files: Map<string, string>): number {
	const problems: string[] = [];
	for (const [rel, content] of files) {
		const target = path.join(pluginsDir, rel);
		let actual: string | null = null;
		try {
			actual = fs.readFileSync(target, "utf8");
		} catch {
			actual = null;
		}
		if (actual === null) {
			problems.push(`missing: plugins/${rel}`);
		} else if (actual !== content) {
			problems.push(`drift: plugins/${rel}`);
		}
	}
	if (problems.length > 0) {
		for (const problem of problems) process.stderr.write(`${problem}\n`);
		process.stderr.write(`Plugin bundle drift detected. Run \`bun run generate-plugins\`.\n`);
		return 1;
	}
	process.stdout.write(`Plugin bundle is in sync (${files.size} file(s)).\n`);
	return 0;
}

export { DELEGATE_TOOLS };

if (import.meta.main) {
	if (DELEGATE_TOOLS.length !== 3) {
		process.stderr.write(`Expected 3 delegate tools in the coordinator contract, found ${DELEGATE_TOOLS.length}.\n`);
		process.exit(1);
	}
	const check = process.argv.includes("--check");
	const files = renderPluginFiles();
	if (check) {
		process.exit(checkFiles(files));
	} else {
		writeFiles(files);
	}
}
