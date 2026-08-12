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
 *   bun scripts/generate-gjc-plugins.ts --check    # compare complete file set + bytes, exit 1 on drift
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
/**
 * Inventory of `gjc sdk session` semantic verbs plus the raw hatch kinds,
 * mirrored from the SDK session CLI (`SdkSessionCliAction` / raw kinds in
 * `packages/coding-agent/src/sdk/cli/session-cli.ts`). The advisory
 * `gjc-sdk-session` skill is rendered from this inventory and
 * `scripts/verify-gjc-skill-docs.ts` checks every skill reference against it,
 * so a skill can never advertise a verb the CLI does not ship.
 */
export const SDK_SESSION_CLI_VERBS = ["list", "inspect", "send", "status", "tail", "raw"] as const;
export type SdkSessionCliVerb = (typeof SDK_SESSION_CLI_VERBS)[number];

export const SDK_SESSION_RAW_KINDS = ["control", "query", "global"] as const;
export type SdkSessionRawKind = (typeof SDK_SESSION_RAW_KINDS)[number];

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
Codex resume bridge correlation: after registering an app-server handoff with
\`gjc_coordinator_register_codex_handoff\`, pass the same \`session_id\` as
\`codex_host_session_id\` on delegate calls so the new GJC session auto-binds to
the Codex thread for wake-on-completion and questions. Acknowledge durable wakes
by \`wake_key\` with \`gjc_coordinator_ack_codex_handoff\`; heartbeats are unsupported
(\`automation_update_unavailable\`), so delivery is event-driven with startup drain.
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
## Codex resume bridge correlation

After registering an app-server handoff with \`gjc_coordinator_register_codex_handoff\`,
pass the same \`session_id\` as \`codex_host_session_id\` on delegate calls so new GJC
sessions auto-bind to the Codex thread for wake-on-completion and questions. Acknowledge
durable wakes by \`wake_key\` with \`gjc_coordinator_ack_codex_handoff\`; heartbeats are
unsupported (\`automation_update_unavailable\`), so delivery is event-driven with startup drain.

## Polling

Each delegate returns a \`turn_id\`. Poll \`gjc_coordinator_await_turn\` (bounded)
or \`gjc_coordinator_watch_events\` for the \`delegation.started\` event and the
terminal turn state. Turn state is the source of truth, not terminal scrollback.
`;
}

function sdkSessionSkillDoc(): string {
	const verbs = SDK_SESSION_CLI_VERBS.join("|");
	const rawKinds = SDK_SESSION_RAW_KINDS.join("|");
	return `---
name: gjc-sdk-session
description: Operate GJC SDK sessions from the CLI (\`gjc sdk session ${verbs}\` plus the explicit raw ${rawKinds} hatch). Advisory reference: broker-bound, credential-free output; mutating verbs run only when explicitly invoked.
---

# GJC SDK session CLI (advisory)

Advisory reference for interacting with live GJC SDK sessions through the
broker-bound \`gjc sdk session\` command family. This skill is informational:
it never prints endpoint credentials or changes configuration, and it never
references removed command routes. Mutating commands are only documented and
run when the operator explicitly invokes them.

## Broker authority

\`list\`, \`inspect\`, \`send\`, \`status\`, and \`tail\` resolve sessions through the
SDK broker. The broker validates the indexed session against its durable
endpoint record and hands the CLI a connection credential the CLI uses and
never prints. \`--agent-dir\` selects the broker state directory.

## Semantic verbs

- \`gjc sdk session list\` — broker \`session.list\` projected to the versioned,
  credential-free row DTO (session id, locator, pid, liveness, tombstone,
  activity, heartbeat, identity provenance, ambiguity).
- \`gjc sdk session inspect <sessionId>\` — one indexed row; when the broker is
  absent, falls back to a credential-free offline projection from the local
  endpoint discovery record.
- \`gjc sdk session send <sessionId> --text <prompt>\` — ordered \`turn.prompt\`
  carrying a caller-chosen operation reference (ULID). \`--wait\` polls
  \`turn.result\` with \`kind: "prompt"\` until terminal or the wait window elapses;
  it never cancels a running turn.
- \`gjc sdk session status <sessionId> <opRef>\` — lossless \`turn.result\` with
  \`kind: "prompt"\` for a previously submitted operation reference.

- \`gjc sdk session tail <sessionId>\` — retained transcript replay from the
  durable checkpoint followed by live event-ring frames. \`--strict\` fails
  closed on retention gaps, \`--until-idle\` exits at a terminal turn state,
  \`--all-events\` widens the emitted event kinds, and \`--cursor\` resumes from a
  saved checkpoint token that is re-minted per connection.

## Raw hatch

\`gjc sdk session raw ${rawKinds}\` dispatches one SDK operation with \`--op\`
(control/global) or \`--query\` (query) plus a JSON input source. Lifecycle
globals require \`--idempotency-key\`; destructive control operations accept
\`--confirm\`. Endpoint-disclosure operations are refused by default and stay
refused by this skill.

## Lossless prompt results

\`turn.result\` with \`kind: "prompt"\` reports \`accepted\`, \`in_flight\`,
\`terminal_ok\`, or \`failed\`; only retained-record eviction yields \`unknown\`,
which means uncertainty, never proof of non-execution. \`turn.prompt_status\`
remains a legacy prompt-only alias. Never reuse an operation reference as a retry
mechanism.

## Checkpoint gaps

\`tail\` reports a \`retention_gap\` with the missing sequence range and a
\`resync\` checkpoint when retained history or the event ring dropped entries;
\`--strict\` turns any gap into exit code 1.
`;
}

function sdkGuidesSkillDoc(): string {
	return `---
name: gjc-sdk-guides
description: Index of trusted GJC SDK reference guides (broker, session CLI, embedding, app development). Advisory only: read these documents for background; there is no guide to execute and no workflow skill to run.
---

# GJC SDK guides (advisory)

Advisory index of trusted GJC SDK reference documents. These guides are
reading material for background understanding; nothing in this skill is
executable and no workflow skill is invoked.

- \`docs/sdk.md\` — SDK overview: endpoint discovery, protocol, query and
  control surfaces, broker launch isolation, managed notification adapters.
- \`docs/sdk-session-cli.md\` — the \`gjc sdk session\` command family: semantic
  verbs, raw hatch, lossless statuses, broker authority, and checkpoint gaps.
- \`docs/sdk-embedding.md\` — embedding GJC in-process.
- \`docs/sdk-app-guide.md\` — building applications on the SDK.

## Advisory boundary

The references above are consulted as background, never executed. The plugin
bundle keeps the four default workflow skills unchanged; this skill adds no
workflow and performs no configuration or state mutation.
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
- \`commands/\`, \`skills/\` — host-facing delegate command + skill docs, including
  the advisory \`gjc-sdk-session\` (SDK session CLI reference) and
  \`gjc-sdk-guides\` (trusted SDK guide index) skills.

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
			metadata: { description: "GJC delegation plugin with advisory SDK skills", version },
			plugins: [
				{
					name: PLUGIN_NAME,
					source: `./${dir}`,
					description:
						"Delegate GJC planning/execution/team workflows via coordinator MCP, plus advisory SDK session CLI and guide skills.",
					version,
					author: { name: "Gajae Code" },
					keywords: ["gjc", "delegation", "mcp", "planning", "agents", "sdk"],
				},
			],
		}),
	);

	// Plugin folder: Claude manifest
	files.set(
		path.join(dir, ".claude-plugin", "plugin.json"),
		json({
			name: PLUGIN_NAME,
			description:
				"Delegate planning, execution, and team workflows to GJC through the coordinator MCP server, plus advisory SDK session CLI and guide skills.",
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
			description:
				"Delegate Codex tasks to GJC workflows through coordinator MCP, plus advisory SDK session CLI and guide skills.",
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
	files.set(path.join(dir, "skills", "gjc-sdk-session", "SKILL.md"), sdkSessionSkillDoc());
	files.set(path.join(dir, "skills", "gjc-sdk-guides", "SKILL.md"), sdkGuidesSkillDoc());
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

function listPluginFiles(dir: string, rel = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryRel = path.join(rel, entry.name);
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listPluginFiles(entryPath, entryRel));
		} else {
			// Treat symlinks and special entries as files: no unrendered entry may be installable.
			files.push(entryRel);
		}
	}
	return files;
}

export function findUnexpectedPluginFiles(files: ReadonlyMap<string, string>, root = pluginsDir): string[] {
	const expected = new Set(files.keys());
	return listPluginFiles(root).filter(rel => !expected.has(rel)).sort();
}

function checkFiles(files: Map<string, string>, root = pluginsDir, report = true): number {
	const problems: string[] = [];
	for (const [rel, content] of files) {
		const target = path.join(root, rel);
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
	for (const rel of findUnexpectedPluginFiles(files, root)) {
		problems.push(`unexpected: plugins/${rel}`);
	}
	if (problems.length > 0) {
		if (report) {
			for (const problem of problems) process.stderr.write(`${problem}\n`);
			process.stderr.write(`Plugin bundle drift detected. Run \`bun run generate-plugins\`.\n`);
		}
		return 1;
	}
	process.stdout.write(`Plugin bundle is in sync (${files.size} file(s)).\n`);
	return 0;
}

function runSelfTest(): void {
	const files = renderPluginFiles();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-plugin-self-test-"));
	try {
		for (const [rel, content] of files) {
			const target = path.join(root, rel);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}
		for (const rel of [
			path.join(PLUGIN_NAME, "commands", "stale.md"),
			path.join(PLUGIN_NAME, "skills", "stale", "SKILL.md"),
		]) {
			const target = path.join(root, rel);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, "stale\n");
		}
		const unexpected = findUnexpectedPluginFiles(files, root);
		if (
			checkFiles(files, root, false) !== 1 ||
			!unexpected.includes(path.join(PLUGIN_NAME, "commands", "stale.md")) ||
			!unexpected.includes(path.join(PLUGIN_NAME, "skills", "stale", "SKILL.md"))
		) {
			throw new Error("plugin file-set check did not reject stale command and skill files");
		}
		process.stdout.write("Plugin file-set self-test passed.\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

export { DELEGATE_TOOLS };

if (import.meta.main) {
	if (DELEGATE_TOOLS.length !== 3) {
		process.stderr.write(`Expected 3 delegate tools in the coordinator contract, found ${DELEGATE_TOOLS.length}.\n`);
		process.exit(1);
	}
	if (process.argv.includes("--self-test")) {
		runSelfTest();
	} else if (process.argv.includes("--check")) {
		process.exit(checkFiles(renderPluginFiles()));
	} else {
		writeFiles(renderPluginFiles());
	}
}
