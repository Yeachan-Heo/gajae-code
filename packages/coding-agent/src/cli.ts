#!/usr/bin/env bun

/**
 * CLI entry point — registers all commands explicitly and delegates to the
 * lightweight CLI runner from pi-utils.
 */
import "@gajae-code/utils/postmortem";
import { Args, type CliConfig, Command, type CommandEntry, run } from "@gajae-code/utils/cli";
import { APP_NAME, formatBunRuntimeError, MIN_BUN_VERSION, VERSION } from "@gajae-code/utils/dirs";
import { runFixtureReport } from "./cli/fixture-report";
import { offerMacosCommunityApp } from "./cli/macos-community-app";
import { ROOT_LAUNCH_FLAGS } from "./cli/root-flags";
import QuickLane from "./commands/quick-lane";
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
const MANAGED_OWNER_SUPERVISOR_ARG = "--internal-managed-owner-supervisor";
const MANAGED_OWNER_CHILD_TOKEN_ENV = "GJC_MANAGED_OWNER_CHILD_TOKEN";
const TMUX_OWNER_ISOLATION_ARG = "--internal-tmux-owner-isolation";

export const commands: CommandEntry[] = [
	{ name: "codex-native-hook", load: () => import("./commands/codex-native-hook").then(m => m.default) },
	{ name: "state", load: () => import("./commands/state").then(m => m.default) },
	{ name: "setup", load: () => import("./commands/setup").then(m => m.default) },
	{ name: "acp", load: () => import("./commands/acp").then(m => m.default) },
	{ name: "auth-broker", load: () => import("./commands/auth-broker").then(m => m.default) },
	{ name: "auth-gateway", load: () => import("./commands/auth-gateway").then(m => m.default) },
	{ name: "skills", load: () => import("./commands/skills").then(m => m.default) },
	{ name: "session", load: () => import("./commands/session").then(m => m.default) },
	{ name: "accounts", load: () => import("./commands/accounts").then(m => m.default) },
	{ name: "harness", load: () => import("./commands/harness").then(m => m.default) },
	{ name: "coordinator", load: () => import("./commands/coordinator").then(m => m.default) },
	{ name: "ultragoal", load: () => import("./commands/ultragoal").then(m => m.default) },
	{ name: "gc", load: () => import("./commands/gc").then(m => m.default) },
	{ name: "crash", load: () => import("./commands/crash").then(m => m.default) },
	{ name: "autoresearch", load: () => import("./commands/autoresearch").then(m => m.default) },
	{ name: "ralplan", load: () => import("./commands/ralplan").then(m => m.default) },
	{ name: "config", load: () => import("./commands/config").then(m => m.default) },
	{ name: "stats", load: () => import("./commands/stats").then(m => m.default) },
	{ name: "notify", load: () => import("./commands/notify").then(m => m.default) },
	{ name: "sdk", load: () => import("./commands/sdk").then(m => m.default) },
	{ name: "daemon", load: () => import("./commands/daemon").then(m => m.default) },
	{ name: "web-search", aliases: ["q"], load: () => import("./commands/web-search").then(m => m.default) },
	{ name: "local-provider", load: () => import("./commands/local-provider").then(m => m.default) },
	{ name: "model-presets", load: () => import("./commands/model-presets").then(m => m.default) },
	{ name: "mcp-serve", load: () => import("./commands/mcp-serve").then(m => m.default) },
	{ name: "mcp", load: () => import("./commands/mcp").then(m => m.default) },
	{
		name: "contribute-pr",
		aliases: ["contribution-prep"],
		load: () => import("./commands/contribution-prep").then(m => m.default),
	},
	{ name: "deep-interview", load: () => import("./commands/deep-interview").then(m => m.default) },
	{ name: "migrate", load: () => import("./commands/migrate").then(m => m.default) },
	{ name: "update", load: () => import("./commands/update").then(m => m.default) },
	{ name: "read", load: () => import("./commands/read").then(m => m.default) },
	{ name: "customize", load: () => import("./commands/customize").then(m => m.default) },
	{ name: "plugin", load: () => import("./commands/plugin").then(m => m.default) },
	{ name: "completion", load: () => import("./commands/completion").then(m => m.default) },
	{ name: "launch", load: () => import("./commands/launch").then(m => m.default) },
	{ name: "quick-lane", load: async () => QuickLane },
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

export function interactiveBootstrapText(
	argv: readonly string[],
	stdinIsTTY = process.stdin.isTTY,
	stdoutIsTTY = process.stdout.isTTY,
): string | undefined {
	if (!stdinIsTTY || !stdoutIsTTY || argv[0] !== "launch") return undefined;
	for (let index = 1; index < argv.length; index++) {
		const arg = argv[index];
		if (
			arg === "--print" ||
			arg?.startsWith("--print=") ||
			arg === "-p" ||
			arg === "--export" ||
			arg?.startsWith("--export=") ||
			arg === "--list-models" ||
			arg?.startsWith("--list-models=") ||
			arg === "--mode" ||
			arg?.startsWith("--mode=") ||
			arg === "--help" ||
			arg?.startsWith("--help=") ||
			arg === "-h" ||
			arg === "--version" ||
			arg?.startsWith("--version=") ||
			arg === "-v"
		)
			return undefined;
	}
	return "\u001b[?25h\u001b[38;5;45mGJC\u001b[0m warming workspace\r\n\r\n> ";
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

type MemoryGuardNativeSmokeLoad = () => Record<string, unknown>;
type WindowsJobMemoryProbeResult = Record<string, unknown> & { kind: string };
type MemoryGuardNativeSmokeReceipt = {
	api: "memory_guard_windows_job_probe_v1";
	source: "pi_natives";
	result: WindowsJobMemoryProbeResult;
};

export function isMemoryGuardNativeSmokeFastPath(argv: readonly string[]): boolean {
	return (
		argv.length === 3 && argv[0] === "internal" && argv[1] === "memory-guard-native-smoke" && argv[2] === "--json"
	);
}

function parseWindowsJobMemoryProbeResult(value: unknown): WindowsJobMemoryProbeResult {
	if (!value || typeof value !== "object") {
		throw new Error("memory-guard-native-smoke: native probe returned a non-object result");
	}
	const result = value as Record<string, unknown>;
	if (typeof result.kind !== "string") {
		throw new Error("memory-guard-native-smoke: native probe result is missing a string kind tag");
	}
	return result as WindowsJobMemoryProbeResult;
}

export function runMemoryGuardNativeSmokeFastPath(
	options: { loadNative?: MemoryGuardNativeSmokeLoad; writeStdout?: (text: string) => void } = {},
): void {
	if (!options.loadNative)
		throw new Error("memory-guard-native-smoke: native loader is unavailable on the static CLI path");
	const probe = options.loadNative().probeWindowsJobMemory;
	if (typeof probe !== "function") {
		throw new Error("memory-guard-native-smoke: probeWindowsJobMemory export missing from native addon");
	}
	const receipt: MemoryGuardNativeSmokeReceipt = {
		api: "memory_guard_windows_job_probe_v1",
		source: "pi_natives",
		result: parseWindowsJobMemoryProbeResult((probe as () => unknown)()),
	};
	(options.writeStdout ?? (text => process.stdout.write(text)))(`${JSON.stringify(receipt)}\n`);
}

async function runMemoryGuardNativeSmokeFastPathFromCli(): Promise<void> {
	const { runMemoryGuardNativeSmoke } = await import("./cli/native-smoke");
	runMemoryGuardNativeSmoke();
}

function isLaunchWorktreeSelector(arg: string): boolean {
	return (
		arg === "--worktree" ||
		arg === "-w" ||
		arg.startsWith("--worktree=") ||
		arg.startsWith("-w=") ||
		(arg.startsWith("-w") && arg.length > 2)
	);
}

function rootFlagDescriptor(arg: string) {
	if (arg.startsWith("--") && !arg.includes("="))
		return ROOT_LAUNCH_FLAGS[arg.slice(2) as keyof typeof ROOT_LAUNCH_FLAGS];
	if (/^-[^-]$/.test(arg))
		return Object.values(ROOT_LAUNCH_FLAGS).find(descriptor => descriptor.char === arg.slice(1));
	return undefined;
}

function rootFlagValueIndex(argv: readonly string[], index: number): number {
	const descriptor = rootFlagDescriptor(argv[index] ?? "");
	if (!descriptor || descriptor.kind === "boolean") return index;
	const value = argv[index + 1];
	return value && !value.startsWith("-") ? index + 1 : index;
}

function rootFixtureArg(argv: string[]): { present: boolean; id: string | undefined } {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--" || isSubcommand(arg)) return { present: false, id: undefined };
		if (arg === "--fixture") return { present: true, id: argv[i + 1] };
		const descriptor = rootFlagDescriptor(arg);
		if (descriptor && descriptor.kind !== "boolean") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) return { present: false, id: undefined };
			i++;
		}
	}
	return { present: false, id: undefined };
}

function hasRootFastFlag(argv: string[], flags: readonly string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--" || isSubcommand(arg) || isLaunchWorktreeSelector(arg)) return false;
		if (flags.includes(arg)) return true;
		i = rootFlagValueIndex(argv, i);
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
	static flags = ROOT_LAUNCH_FLAGS;
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
		`# Prefer a stored credential, falling back on quota limits\n  ${APP_NAME} --prefer-credential id:15`,
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
	const { runNativeSmokeTest } = await import("./cli/native-smoke");
	await runNativeSmokeTest();
	await smokeTestTabWorker();
	process.stdout.write("smoke-test: ok\n");
}

/** Normalize the sole `gjc resume` alias into the value-less launch intent. */
export function normalizeResumeAlias(argv: readonly string[]): string[] {
	return argv.length === 1 && argv[0] === "resume" ? ["--resume"] : [...argv];
}

function routeLegacyRootArgv(argv: readonly string[]): string[] | undefined {
	if (argv[0] === "coordinator-mcp") return ["mcp-serve", "coordinator", ...argv.slice(1)];
	return undefined;
}

/**
 * Map the common mistaken `models` subcommand spelling to non-agent listing.
 *
 * Agents frequently run `gjc models` from the bash tool expecting a catalog.
 * Without this route, `models` was a positional launch prompt and nested agents
 * re-invoked `gjc models`, spawning an unbounded process chain (#3857).
 * Always rewrite to `launch --list-models` so the invocation exits after a
 * bounded listing and never starts an interactive agent session.
 */
export function routeModelsAlias(argv: readonly string[]): string[] | undefined {
	if (argv[0] !== "models") return undefined;
	const rest = argv.slice(1);
	if (rest[0] === "presets") return ["model-presets", ...rest.slice(1)];
	if (rest.length === 0) return ["launch", "--list-models"];
	// Pure search tokens become a single fuzzy pattern (matches --list-models).
	if (rest.every(token => !token.startsWith("-") && !token.startsWith("@"))) {
		return ["launch", "--list-models", rest.join(" ")];
	}
	// Mixed flags still go through list-models first so "models" is never a prompt.
	return ["launch", "--list-models", ...rest];
}

/** Apply the same default-launch routing used by runCli after root fast paths. */
export function routeRootArgv(argv: readonly string[]): string[] {
	const normalizedArgv = normalizeResumeAlias(argv);
	const legacyArgv = routeLegacyRootArgv(normalizedArgv);
	if (legacyArgv) return legacyArgv;
	const modelsArgv = routeModelsAlias(normalizedArgv);
	if (modelsArgv) return modelsArgv;
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
	if (isMemoryGuardNativeSmokeFastPath(argv)) {
		await runMemoryGuardNativeSmokeFastPathFromCli();
		return;
	}
	if (argv.length === 1 && argv[0] === TMUX_OWNER_ISOLATION_ARG) {
		const { runTmuxOwnerIsolationCliFromStdin } = await import("./gjc-runtime/tmux-owner-isolation-cli");
		await runTmuxOwnerIsolationCliFromStdin();
		return;
	}
	if (argv.length === 1 && argv[0] === MANAGED_OWNER_SUPERVISOR_ARG) {
		const { runManagedOwnerSupervisor } = await import("./gjc-runtime/managed-owner-supervisor");
		await runManagedOwnerSupervisor();
		return;
	}
	if (process.env[MANAGED_OWNER_CHILD_TOKEN_ENV] !== undefined) {
		const { admitManagedOwnerBeforeCli, completeManagedOwnerRecovery } = await import(
			"./gjc-runtime/managed-owner-admission"
		);
		const admission = await admitManagedOwnerBeforeCli();
		if (admission.kind === "blocked") return;
		if (admission.kind === "recovery") {
			await completeManagedOwnerRecovery(admission.context);
			return;
		}
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
	if (argv.length === 1 && argv[0] === "macos-community-app-offer") {
		await offerMacosCommunityApp();
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
	const normalizedArgv = normalizeResumeAlias(argv);
	const legacyArgv = routeLegacyRootArgv(normalizedArgv);
	const modelPresetsArgv =
		normalizedArgv[0] === "models" && normalizedArgv[1] === "presets" ? routeModelsAlias(normalizedArgv) : undefined;
	if (!legacyArgv && !modelPresetsArgv && hasRootHelpFlag(normalizedArgv)) {
		const { renderRootHelp } = await import("@gajae-code/utils/cli");
		const { getExtraHelpText } = await import("./cli/fast-help");
		renderRootHelp({ bin: APP_NAME, version: VERSION, commands: new Map([["launch", RootHelpCommand]]) });
		const extra = getExtraHelpText();
		if (extra.trim().length > 0) {
			process.stdout.write(`\n${extra}\n`);
		}
		return;
	}
	if (!legacyArgv && hasRootVersionFlag(normalizedArgv)) {
		process.stdout.write(`${APP_NAME}/${VERSION}\n`);
		return;
	}
	const runArgv = legacyArgv ?? modelPresetsArgv ?? routeRootArgv(normalizedArgv);
	if (isStatsHelpFastPath(runArgv)) {
		showStatsFastHelp();
		return;
	}
	const bootstrap = interactiveBootstrapText(runArgv);
	if (bootstrap) process.stdout.write(bootstrap);
	await installRuntimeGlobals();
	return run({ bin: APP_NAME, version: VERSION, argv: runArgv, commands, help: showHelp });
}

if (import.meta.main) {
	await runCli(process.argv.slice(2));
}
