#!/usr/bin/env bun

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { Args, type CliConfig, Command, type CommandEntry, Flags, run } from "@gajae-code/utils/cli";
import { APP_NAME, formatBunRuntimeError, MIN_BUN_VERSION, VERSION } from "@gajae-code/utils/dirs";

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

const commands: CommandEntry[] = [
	{ name: "codex-native-hook", load: () => import("./commands/codex-native-hook").then(m => m.default) },
	{ name: "state", load: () => import("./commands/state").then(m => m.default) },
	{ name: "setup", load: () => import("./commands/setup").then(m => m.default) },
	{ name: "skills", load: () => import("./commands/skills").then(m => m.default) },
	{ name: "session", load: () => import("./commands/session").then(m => m.default) },
	{ name: "harness", load: () => import("./commands/harness").then(m => m.default) },
	{ name: "coordinator", load: () => import("./commands/coordinator").then(m => m.default) },
	{ name: "team", load: () => import("./commands/team").then(m => m.default) },
	{ name: "ultragoal", load: () => import("./commands/ultragoal").then(m => m.default) },
	{ name: "gc", load: () => import("./commands/gc").then(m => m.default) },
	{ name: "ralplan", load: () => import("./commands/ralplan").then(m => m.default) },
	{ name: "config", load: () => import("./commands/config").then(m => m.default) },
	{ name: "notify", load: () => import("./commands/notify").then(m => m.default) },
	{ name: "web-search", aliases: ["q"], load: () => import("./commands/web-search").then(m => m.default) },
	{ name: "mcp-serve", load: () => import("./commands/mcp-serve").then(m => m.default) },
	{
		name: "contribute-pr",
		aliases: ["contribution-prep"],
		load: () => import("./commands/contribution-prep").then(m => m.default),
	},
	{ name: "deep-interview", load: () => import("./commands/deep-interview").then(m => m.default) },
	{ name: "migrate", load: () => import("./commands/migrate").then(m => m.default) },
	{ name: "rlm", load: () => import("./commands/rlm").then(m => m.default) },
	{ name: "update", load: () => import("./commands/update").then(m => m.default) },
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default) },
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
	const [{ installH2Fetch }, { procmgr }] = await Promise.all([import("@gajae-code/ai"), import("@gajae-code/utils")]);
	// Activate HTTP/2 for all `fetch()` calls (provider streams, OAuth, model
	// discovery, web tools). Bun's HTTP/2 client is gated on a startup flag we
	// can't toggle from JS, so we patch globalThis.fetch to pass
	// `protocol: "http2"` per request, with transparent HTTP/1.1 fallback on
	// `HTTP2Unsupported`. See @gajae-code/ai/utils/h2-fetch for details.
	installH2Fetch();

	// Strip macOS malloc-stack-logging env vars before any subprocess is spawned.
	// Otherwise every child bun process (subagents, plugin installs, ptree spawns,
	// etc.) prints a `MallocStackLogging: can't turn off …` warning to stderr.
	procmgr.scrubProcessEnv();
}

class RootHelpCommand extends Command {
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
		"system-prompt": Flags.string({ description: "System prompt (default: coding assistant prompt)" }),
		"append-system-prompt": Flags.string({ description: "Append text or file contents to the system prompt" }),
		"allow-home": Flags.boolean({ description: "Allow starting in ~ without auto-switching to a temp dir" }),
		mode: Flags.string({
			description: "Output mode: text (default), json, rpc, acp, rpc-ui, or bridge",
			options: ["text", "json", "rpc", "acp", "rpc-ui", "bridge"],
		}),
		print: Flags.boolean({ char: "p", description: "Non-interactive mode: process prompt and exit" }),
		continue: Flags.boolean({ char: "c", description: "Continue previous session" }),
		resume: Flags.string({ char: "r", description: "Resume a session (by ID prefix, path, or picker if omitted)" }),
		"session-dir": Flags.string({ description: "Directory for session storage and lookup" }),
		"no-session": Flags.boolean({ description: "Don't save session (ephemeral)" }),
		models: Flags.string({ description: "Comma-separated model patterns for Ctrl+P cycling" }),
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
 * Smoke-test entry. Spawns the stats sync worker, pings it, exits.
 *
 * Purpose: catch the silent worker-load regressions that hit compiled
 * binaries (issues #1011 and #1027). Neither `--version` nor
 * `stats --summary` actually spawns a Worker on a fresh install — the
 * sync path early-returns when no session files exist. This probe is the
 * minimal end-to-end test that proves `new Worker(...)` resolves and the
 * bundled worker module evaluates successfully. Wired into
 * `scripts/install-tests/run-ci.sh` so binary / source-link / tarball
 * installs all exercise it on every CI run.
 */
async function runSmokeTest(): Promise<void> {
	const { smokeTestSyncWorker } = await import("@gajae-code/stats");
	await smokeTestSyncWorker();
	// Prove the embedded native addon extracts and the new perf exports resolve in
	// the COMPILED single binary (dev runs only load the on-disk .node). Loading the
	// natives module triggers loadNative()/embedded extraction; calling each new
	// export confirms the symbols are present in the shipped binary.
	const { h06FormatHashLines, h02ScoreSequenceFuzzy, h01FindBestFuzzyMatch } = await import(
		"../../natives/native/index.js"
	);
	const hashed = h06FormatHashLines("a\nb", 1);
	if (hashed.split("\n").length !== 2) {
		throw new Error(`smoke-test: h06FormatHashLines returned unexpected output: ${JSON.stringify(hashed)}`);
	}
	if (typeof h02ScoreSequenceFuzzy !== "function" || typeof h01FindBestFuzzyMatch !== "function") {
		throw new Error("smoke-test: native fuzzy exports missing from embedded addon");
	}
	process.stdout.write("smoke-test: ok\n");
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	if (argv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	if (rootHelpFlags.includes(argv[0] ?? "")) {
		const { renderRootHelp } = await import("@gajae-code/utils/cli");
		const { getExtraHelpText } = await import("./cli/fast-help");
		renderRootHelp({ bin: APP_NAME, version: VERSION, commands: new Map([["launch", RootHelpCommand]]) });
		const extra = getExtraHelpText();
		if (extra.trim().length > 0) {
			process.stdout.write(`\n${extra}\n`);
		}
		return;
	}
	if (versionFlags.includes(argv[0] ?? "")) {
		process.stdout.write(`${APP_NAME}/${VERSION}\n`);
		return;
	}
	await installRuntimeGlobals();
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	const first = argv[0];
	const runArgv =
		first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help"
			? argv
			: isSubcommand(first)
				? argv
				: ["launch", ...argv];
	return run({ bin: APP_NAME, version: VERSION, argv: runArgv, commands, help: showHelp });
}

await runCli(process.argv.slice(2));
