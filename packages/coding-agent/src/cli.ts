#!/usr/bin/env bun
import { installH2Fetch } from "@gajae-code/ai";
import { APP_NAME, MIN_BUN_VERSION, procmgr, VERSION } from "@gajae-code/utils";

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

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import { type CliConfig, type CommandEntry, run } from "@gajae-code/utils/cli";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(1);
}

process.title = APP_NAME;

const commands: CommandEntry[] = [
	{ name: "codex-native-hook", load: () => import("./commands/codex-native-hook").then(m => m.default) },
	{ name: "state", load: () => import("./commands/state").then(m => m.default) },
	{ name: "setup", load: () => import("./commands/setup").then(m => m.default) },
	{ name: "skills", load: () => import("./commands/skills").then(m => m.default) },
	{ name: "session", load: () => import("./commands/session").then(m => m.default) },
	{ name: "team", load: () => import("./commands/team").then(m => m.default) },
	{ name: "ultragoal", load: () => import("./commands/ultragoal").then(m => m.default) },
	{ name: "ralplan", load: () => import("./commands/ralplan").then(m => m.default) },
	{
		name: "contribute-pr",
		aliases: ["contribution-prep"],
		load: () => import("./commands/contribution-prep").then(m => m.default),
	},
	{ name: "deep-interview", load: () => import("./commands/deep-interview").then(m => m.default) },
	{ name: "update", load: () => import("./commands/update").then(m => m.default) },
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default) },
];

async function showHelp(config: CliConfig): Promise<void> {
	const { renderRootHelp } = await import("@gajae-code/utils/cli");
	const { getExtraHelpText } = await import("./cli/args");
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
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
	process.stdout.write("smoke-test: ok\n");
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	if (argv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
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
