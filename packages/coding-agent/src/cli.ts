#!/usr/bin/env bun

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import "@gajae-code/utils/postmortem";
import { Args, type CliConfig, Command, type CommandEntry, Flags, run } from "@gajae-code/utils/cli";
import { APP_NAME, formatBunRuntimeError, MIN_BUN_VERSION, VERSION } from "@gajae-code/utils/dirs";
import { runFixtureReport } from "./cli/fixture-report";
import MemoryCommand from "./commands/memory";
import { isTmuxOwnerIsolationCliArgv, runTmuxOwnerIsolationCliFromStdin } from "./gjc-runtime/tmux-owner-isolation-cli";
import { smokeTestTabWorker } from "./tools/browser/tab-worker-smoke";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		formatBunRuntimeError({
			currentVersion: Bun.version,
			minVersion: MIN_BUN_VERSION,
			execPath: process.execPath,
		}),
	);
	process.exit(1);
}

process.title = APP_NAME;
const rootHelpFlags = ["--help", "-h", "help"];
const versionFlags = ["--version", "-v"];

export const commands: CommandEntry[] = [
	{ name: "codex-native-hook", load: () => import("./commands/codex-native-hook").then(m => m.default) },
	{ name: "state", load: () => import("./commands/state").then(m => m.default) },
	{ name: "setup", load: () => import("./commands/setup").then(m => m.default) },
	{ name: "acp", load: () => import("./commands/acp").then(m => m.default) },
	{ name: "skills", load: () => import("./commands/skills").then(m => m.default) },
	{ name: "session", load: () => import("./commands/session").then(m => m.default) },
	{ name: "harness", load: () => import("./commands/harness").then(m => m.default) },
	{ name: "coordinator", load: () => import("./commands/coordinator").then(m => m.default) },
	{ name: "team", load: () => import("./commands/team").then(m => m.default) },
	{ name: "ultragoal", load: () => import("./commands/ultragoal").then(m => m.default) },
	{ name: "gc", load: () => import("./commands/gc").then(m => m.default) },
	{ name: "ralplan", load: () => import("./commands/ralplan").then(m => m.default) },
	{ name: "config", load: () => import("./commands/config").then(m => m.default) },
	{ name: "stats", load: () => import("./commands/stats").then(m => m.default) },
	{ name: "notify", load: () => import("./commands/notify").then(m => m.default) },
	{ name: "sdk", load: () => import("./commands/sdk").then(m => m.default) },
	{ name: "daemon", load: () => import("./commands/daemon").then(m => m.default) },
	{ name: "web-search", aliases: ["q"], load: () => import("./commands/web-search").then(m => m.default) },
	{ name: "local-provider", load: () => import("./commands/local-provider").then(m => m.default) },
	{ name: "mcp-serve", load: () => import("./commands/mcp-serve").then(m => m.default) },
	{ name: "mcp", load: () => import("./commands/mcp").then(m => m.default) },
	{
		name: "contribute-pr",
		aliases: ["contribution-prep"],
		load: () => import("./commands/contribution-prep").then(m => m.default),
	},
	{ name: "deep-interview", load: () => import("./commands/deep-interview").then(m => m.default) },
	{ name: "migrate", load: () => import("./commands/migrate").then(m => m.default) },
	{ name: "rlm", load: () => import("./commands/rlm").then(m => m.default) },
	{ name: "update", load: () => import("./commands/update").then(m => m.default) },
	{ name: "plugin", load: () => import("./commands/plugin").then(m => m.default) },
	{ name: "completion", load: () => import("./commands/completion").then(m => m.default) },
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default) },
	{ name: "memory", load: async () => MemoryCommand },
];

async function showHelp(config: CliConfig): Promise<void> {
	const { renderRootHelp } = await import("@gajae-code/utils/cli");
	const { getExtraHelpText } = await import("./cli/fast-help");
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
}

async function installRuntimeGlobals(): Promise<void> {
	const { installH2Fetch } = await import("@gajae-code/ai/utils/h2-fetch");
	// Activate HTTP/2 for all `fetch()` calls (provider streams, OAuth, model
	// discovery, web tools). Bun's HTTP/2 client is gated on a startup flag we
	// can't toggle from JS, so we patch globalThis.fetch to pass
	// `protocol: "http2"` per request, with transparent HTTP/1.1 fallback on
	// `HTTP2Unsupported`. See @gajae-code/ai/utils/h2-fetch for details.
	installH2Fetch();

	const { warnIfMacOSNoFileLimitTooLow } = await import("./cli/nofile-limit");
	warnIfMacOSNoFileLimitTooLow();

	// Secondary in-process scrub of the macOS malloc-stack-logging vars. The real
	// boundary is the darwin re-exec guard at the top of runCli(): Bun snapshots the
	// spawn-default environment at startup, so deleting these here does NOT clean the
	// env children inherit by default — it only tidies `process.env` for code that
	// reads it directly. Kept as belt-and-braces for the rare re-exec-unavailable
	// fallback; managed spawns already use filterProcessEnv and the native PTY lane
	// strips them independently.
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
}

function isStatsHelpFastPath(argv: string[]): boolean {
	return argv[0] === "stats" && (argv.includes("--help") || argv.includes("-h"));
}

function showStatsFastHelp(): void {
	process.stdout.write(`Usage: ${APP_NAME} stats [options]

View usage statistics

Options:
  -p, --port <number>   Port for the dashboard server (default: 3847)
  -j, --json            Output stats as JSON
  -s, --summary         Print summary to console
  -h, --help            Show this help
`);
}

function isNotifyDaemonInternalFastPath(argv: string[]): boolean {
	return argv[0] === "notify" && argv[1] === "daemon-internal";
}

async function runNotifyDaemonInternalFastPath(argv: string[]): Promise<void> {
	const { parseNotifyArgs, runNotifyCommand } = await import("./cli/notify-cli");
	const cmd = parseNotifyArgs(argv);
	if (cmd?.action !== "daemon-internal") {
		throw new Error("invalid notify daemon-internal fast path");
	}
	await runNotifyCommand(cmd);
}

function isChatDaemonInternalFastPath(argv: string[]): boolean {
	return argv[0] === "daemon" && (argv[1] === "discord-internal" || argv[1] === "slack-internal");
}

async function runChatDaemonInternalFastPath(argv: string[]): Promise<void> {
	const action = argv[1];
	if (action !== "discord-internal" && action !== "slack-internal") {
		throw new Error("invalid chat daemon internal fast path");
	}
	const { runChatDaemonInternal } = await import("./sdk/bus/chat-daemon-cli");
	await runChatDaemonInternal(action === "discord-internal" ? "discord" : "slack", argv.slice(2));
}

function rootFixtureArg(argv: string[]): { present: boolean; id: string | undefined } {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		// Stop at the first subcommand token so a `--fixture` flag belonging to a
		// subcommand never hijacks the root fast-path into fixture-report mode.
		if (isSubcommand(arg)) return { present: false, id: undefined };
		if (arg === "--fixture") return { present: true, id: argv[i + 1] };
	}
	return { present: false, id: undefined };
}

function hasRootFastFlag(argv: string[], flags: readonly string[]): boolean {
	for (const arg of argv) {
		if (isSubcommand(arg)) return false;
		if (flags.includes(arg)) return true;
	}
	return false;
}

function hasRootHelpFlag(argv: string[]): boolean {
	return hasRootFastFlag(argv, rootHelpFlags);
}

function hasRootVersionFlag(argv: string[]): boolean {
	return hasRootFastFlag(argv, versionFlags);
}

export class RootHelpCommand extends Command {
	static description = "Red-claw AI coding assistant";
	static hidden = true;
	static args = {
		messages: Args.string({
			description: "Messages to send (prefix files with @)",
			required: false,
			multiple: true,
		}),
	};
	static flags = {
		model: Flags.string({ description: 'Model to use (fuzzy match: "opus", "gpt-5.2", or "openai/gpt-5.2")' }),
		smol: Flags.string({ description: "Smol/fast model for lightweight tasks (or GJC_SMOL_MODEL env)" }),
		slow: Flags.string({ description: "Slow/reasoning model for thorough analysis (or GJC_SLOW_MODEL env)" }),
		plan: Flags.string({ description: "Plan model for architectural planning (or GJC_PLAN_MODEL env)" }),
		mpreset: Flags.string({ description: "Model profile preset to activate for this session" }),
		default: Flags.boolean({ description: "Persist --mpreset as the default model profile" }),
		provider: Flags.string({ description: "Provider to use (legacy; prefer --model)" }),
		"api-key": Flags.string({ description: "API key (defaults to env vars)" }),
		credential: Flags.string({
			description:
				"Stored credential selector: email:<addr>, id:<n>, account:<id>, project:<id>, or provider/email:<addr>",
		}),
		"system-prompt": Flags.string({ description: "System prompt (default: coding assistant prompt)" }),
		"append-system-prompt": Flags.string({ description: "Append text or file contents to the system prompt" }),
		"mcp-config": Flags.string({ description: "Tools-only MCP config file (absolute path)" }),
		"allow-home": Flags.boolean({ description: "Allow starting in ~ without auto-switching to a temp dir" }),
		mode: Flags.string({
			description: "Output mode: text (default), json, or acp",
			options: ["text", "json", "acp"],
		}),
		print: Flags.boolean({ char: "p", description: "Non-interactive mode: process prompt and exit" }),
		continue: Flags.boolean({ char: "c", description: "Continue previous session" }),
		resume: Flags.string({ char: "r", description: "Resume a session (by ID prefix, path, or picker if omitted)" }),
		"session-dir": Flags.string({ description: "Directory for session storage and lookup" }),
		"no-session": Flags.boolean({ description: "Don't save session (ephemeral)" }),
		models: Flags.string({ description: "Comma-separated model patterns for Alt+N cycling" }),
		"no-tools": Flags.boolean({ description: "Disable all built-in tools" }),
		"no-lsp": Flags.boolean({ description: "Disable LSP tools, formatting, and diagnostics" }),
		"no-pty": Flags.boolean({ description: "Disable PTY-based interactive bash execution" }),
		tmux: Flags.boolean({ description: "Launch interactive startup inside tmux" }),
		tools: Flags.string({ description: "Comma-separated list of tools to enable (default: all)" }),
		thinking: Flags.string({
			description: "Set thinking level: ultra, high, medium, low",
			options: ["ultra", "high", "medium", "low"],
		}),
		hook: Flags.string({ description: "Load a hook/extension file (can be used multiple times)", multiple: true }),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file (can be used multiple times)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({ description: "Disable extension discovery (explicit -e paths still work)" }),
		"no-skills": Flags.boolean({ description: "Disable skills discovery and loading" }),
		skills: Flags.string({ description: "Comma-separated glob patterns to filter skills (e.g., git-*,docker)" }),
		"no-rules": Flags.boolean({ description: "Disable rules discovery and loading" }),
		export: Flags.string({ description: "Export session file to HTML and exit" }),
		"list-models": Flags.string({ description: "List available models (with optional fuzzy search)" }),
		"no-title": Flags.boolean({ description: "Disable title auto-generation" }),
	};
	static examples = [
		`# Interactive mode\n  ${APP_NAME}`,
		`# Interactive mode with initial prompt\n  ${APP_NAME} "List all .ts files in src/"`,
		`# Include files in initial message\n  ${APP_NAME} @prompt.md @image.png "What color is the sky?"`,
		`# Non-interactive mode (process and exit)\n  ${APP_NAME} -p "List all .ts files in src/"`,
		`# Continue previous session\n  ${APP_NAME} --continue "What did we discuss?"`,
		`# Launch in a sibling git worktree\n  ${APP_NAME} --worktree`,
		`# Use different model (fuzzy matching)\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# Limit model cycling to specific models\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# Pin a stored credential for this session\n  ${APP_NAME} --credential email:me@example.com`,
		`# Activate a model profile for this session\n  ${APP_NAME} --mpreset codex-medium`,
		`# Persist a model profile as the default\n  ${APP_NAME} --mpreset opencodego --default`,
		`# Export a session file to HTML\n  ${APP_NAME} --export ~/.gjc/agent/sessions/--path--/session.jsonl`,
	];
	static strict = false;
	async run(): Promise<void> {}
}

/**
 * Determine whether argv[0] is a known subcommand name.
 * If not, the entire argv is treated as args to the default "launch" command.
 */
function isSubcommand(first: string | undefined): boolean {
	if (!first || first.startsWith("-") || first.startsWith("@")) return false;
	return commands.some(e => e.name === first || e.aliases?.includes(first));
}

/**
 * Smoke-test entry. Spawns the stats sync worker and the browser tab worker, then verifies their protocol.
 *
 * Purpose: catch silent compiled-worker load regressions (issues #1011,
 * #1027, and #2598). Neither `--version` nor `stats --summary` spawns both
 * worker entries on a fresh install. This probe proves each bundled worker
 * module resolves and evaluates; the tab-worker probe also completes its
 * bootstrap/closed protocol without launching a browser. Wired into
 * `scripts/install-tests/run-ci.sh` so binary / source-link / tarball installs
 * exercise it on every CI run.
 */
async function runSmokeTest(): Promise<void> {
	const { smokeTestSyncWorker } = await import("@gajae-code/stats");
	await smokeTestSyncWorker();
	// Prove the embedded native addon extracts and the new perf exports resolve in
	// the COMPILED single binary (dev runs only load the on-disk .node). Loading the
	// natives module triggers loadNative()/embedded extraction; calling each new
	// export confirms the symbols are present in the shipped binary.
	const { h06FormatHashLines, h02ScoreSequenceFuzzy, h01FindBestFuzzyMatch } = await import("@gajae-code/natives");
	const hashed = h06FormatHashLines("a\nb", 1);
	if (hashed.split("\n").length !== 2) {
		throw new Error(`smoke-test: h06FormatHashLines returned unexpected output: ${JSON.stringify(hashed)}`);
	}
	if (typeof h02ScoreSequenceFuzzy !== "function" || typeof h01FindBestFuzzyMatch !== "function") {
		throw new Error("smoke-test: native fuzzy exports missing from embedded addon");
	}
	await smokeTestTabWorker();
	process.stdout.write("smoke-test: ok\n");
}

/** Normalize the sole `gjc resume` alias into the value-less launch intent. */
export function normalizeResumeAlias(argv: readonly string[]): string[] {
	return argv.length === 1 && argv[0] === "resume" ? ["--resume"] : [...argv];
}

/** Apply the same default-launch routing used by runCli after root fast paths. */
export function routeRootArgv(argv: readonly string[]): string[] {
	const normalizedArgv = normalizeResumeAlias(argv);
	const first = normalizedArgv[0];
	return first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help"
		? normalizedArgv
		: isSubcommand(first)
			? normalizedArgv
			: ["launch", ...normalizedArgv];
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	// macOS malloc-env launch boundary. Re-exec once with a scrubbed environment
	// BEFORE any fast path or subprocess spawn, so the startup env snapshot Bun hands
	// to every child lane (Bun.spawn defaults, node:child_process, native PTY, tmux
	// owner, plugin installs, subagents) is clean. This runs ahead of the
	// tmux-owner-isolation and notify-daemon fast paths so those lanes execute inside
	// the already-scrubbed process too. The cheap inline predicate keeps the common
	// (uncontaminated / non-darwin) path free of extra module loads; the guard module
	// (MACOS_MALLOC_ENV_VARS / GJC_MALLOC_ENV_REEXEC) loads only when a re-exec is due.
	if (
		process.platform === "darwin" &&
		process.env.GJC_MALLOC_ENV_REEXEC === undefined &&
		(process.env.MallocStackLogging !== undefined || process.env.MallocStackLoggingNoCompact !== undefined)
	) {
		const { reexecWithScrubbedMallocEnv } = await import("./cli/malloc-env-guard");
		const code = await reexecWithScrubbedMallocEnv();
		if (code !== null) {
			process.exitCode = code;
			return;
		}
		// Re-exec could not be spawned; fall through and run in this process.
	}
	if (isTmuxOwnerIsolationCliArgv(argv)) {
		await runTmuxOwnerIsolationCliFromStdin();
		return;
	}
	if (isNotifyDaemonInternalFastPath(argv)) {
		await runNotifyDaemonInternalFastPath(argv);
		return;
	}
	if (isChatDaemonInternalFastPath(argv)) {
		await runChatDaemonInternalFastPath(argv);
		return;
	}
	if (argv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	const fixtureArg = rootFixtureArg(argv);
	if (fixtureArg.present) {
		const id = fixtureArg.id;
		if (!id || id.startsWith("-")) {
			process.stderr.write(`${APP_NAME} --fixture requires a fixture id\n`);
			process.exitCode = 1;
			return;
		}
		process.exitCode = await runFixtureReport(id);
		return;
	}
	if (isStatsHelpFastPath(argv)) {
		showStatsFastHelp();
		return;
	}
	if (hasRootHelpFlag(argv)) {
		const { renderRootHelp } = await import("@gajae-code/utils/cli");
		const { getExtraHelpText } = await import("./cli/fast-help");
		renderRootHelp({ bin: APP_NAME, version: VERSION, commands: new Map([["launch", RootHelpCommand]]) });
		const extra = getExtraHelpText();
		if (extra.trim().length > 0) {
			process.stdout.write(`\n${extra}\n`);
		}
		return;
	}
	if (hasRootVersionFlag(argv)) {
		process.stdout.write(`${APP_NAME}/${VERSION}\n`);
		return;
	}
	await installRuntimeGlobals();
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	const runArgv = routeRootArgv(argv);
	return run({ bin: APP_NAME, version: VERSION, argv: runArgv, commands, help: showHelp });
}

if (import.meta.main) {
	await runCli(process.argv.slice(2));
}
