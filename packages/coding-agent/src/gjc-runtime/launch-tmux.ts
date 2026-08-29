import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@gajae-code/utils/dirs";
import { isCompiledBinary } from "@gajae-code/utils/env";
import { safeStderrWrite } from "@gajae-code/utils/safe-stderr";
import type { Args } from "../cli/args";
import { readLinuxProcStartTimeSync } from "./linux-proc";
import {
	MANAGED_OWNER_PREDECESSOR_GENERATION_ENV,
	MANAGED_OWNER_PREDECESSOR_INCARNATION_ENV,
	MANAGED_OWNER_PREDECESSOR_RUN_ID_ENV,
	MANAGED_OWNER_PREDECESSOR_TOKEN_ENV,
	MANAGED_OWNER_TRANSCRIPT_PATH_ENV,
} from "./managed-owner-admission";
import {
	MANAGED_OWNER_INCARNATION_ENV,
	MANAGED_OWNER_RUN_ID_ENV,
	MANAGED_OWNER_SUPERVISOR_ARG,
} from "./managed-owner-supervisor";
import { tmuxRuntimeSessionPath } from "./session-layout";
import {
	coordinatorSidecarSigningBootstrapEnv,
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL_ENV,
	GJC_COORDINATOR_SIDECAR_KEY_ID_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
} from "./session-state-sidecar";
import {
	assertGjcTmuxMutationAuthoritySync,
	bindGjcTmuxProviderAuthority,
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxExactSessionTarget,
	buildGjcTmuxProfileCommands,
	buildGjcTmuxSessionName,
	buildGjcTmuxSessionSlug,
	GJC_DEFAULT_TMUX_SESSION,
	GJC_TMUX_ACTIVE_SESSION_ENV,
	GJC_TMUX_COMMAND_ENV,
	GJC_TMUX_MOUSE_ENV,
	GJC_TMUX_PROFILE_ENV,
	GJC_TMUX_SESSION_PREFIX,
	type GjcTmuxProfileCommand,
	type ProviderAuthority,
	persistGjcTmuxProviderAuthoritySync,
	readGjcTmuxProviderAuthoritySync,
	resolveGjcTmuxBinary,
	resolveGjcTmuxCommand,
	resolveGjcTmuxProviderContext,
} from "./tmux-common";
import {
	captureOwnerGenerationBaselineSync,
	classifyCgroup,
	executeTmuxOwnerIsolationPlanSync,
	isOwnerGenerationBaselineCurrentSync,
	lifecyclePaths,
	type ManagedOwnerPredecessorEvidence,
	type OwnerGenerationBaseline,
	type OwnerIsolationProbeSync,
	planTmuxOwnerIsolationSync,
	replaceOwnerGenerationSync,
	resolveManagedOwnerPredecessorSync,
	type TmuxServerProof,
} from "./tmux-owner-isolation";
import { assertGjcTmuxStagedMutationAuthoritySync } from "./tmux-provider-context";
import {
	findGjcTmuxSessionByName,
	findGjcTmuxSessionByScope,
	type GjcTmuxSessionStatus,
	type ProvenTmuxSessionIdentity,
	proveGjcTmuxSessionMutationTarget,
} from "./tmux-sessions";
import {
	buildWindowsPowerShellInnerCommand,
	GJC_TMUX_LAUNCHED_ENV,
	type WindowsPowerShellInnerCommandOptions,
} from "./windows-powershell-command";

export type { WindowsPowerShellInnerCommandOptions };
export {
	buildGjcTmuxExactSessionTarget,
	buildGjcTmuxProfileCommands,
	buildWindowsPowerShellInnerCommand,
	GJC_DEFAULT_TMUX_SESSION,
	GJC_TMUX_COMMAND_ENV,
	GJC_TMUX_LAUNCHED_ENV,
	GJC_TMUX_MOUSE_ENV,
	GJC_TMUX_PROFILE_ENV,
	GJC_TMUX_SESSION_PREFIX,
};

export const GJC_LAUNCH_POLICY_ENV = "GJC_LAUNCH_POLICY";
export const GJC_TMUX_WINDOW_LABEL_MAX_WIDTH = 48;

const WINDOWS_PSMUX_ATTACH_RETRY_DELAY_MS = 100;
const GJC_TMUX_PSMUX_INCARNATION_OPTION = "@gjc-psmux-incarnation";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

type LaunchPolicy = "direct" | "tmux";

interface TtyState {
	stdin: boolean;
	stdout: boolean;
	columns?: number;
	rows?: number;
}

export interface TmuxLaunchContext {
	parsed: Args;
	rawArgs: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	argv?: string[];
	execPath?: string;
	platform?: NodeJS.Platform;
	tty?: TtyState;
	spawnSync?: TmuxSpawnSync;
	/**
	 * Provider authority boundaries. Production resolves, persists, and asserts
	 * the durable psmux authority; tests may inject deterministic equivalents.
	 */
	providerAuthorityResolver?: (input: {
		platform: NodeJS.Platform;
		env: NodeJS.ProcessEnv;
		command: string;
		stateDir: string;
		sessionId: string;
		generation: string;
	}) => ProviderAuthority;
	providerAuthorityPersist?: (authority: ProviderAuthority) => void;
	/** Re-proves an immutable staged authority before generation publication. */
	providerAuthorityStagedAssert?: (authority: ProviderAuthority) => void;
	/** Re-proves a current authority after generation publication. */
	providerAuthorityAssert?: (authority: ProviderAuthority) => void;
	tmuxAvailable?: boolean;
	tmuxStatusLines?: number;
	worktreeBranch?: string | null;
	currentBranch?: string | null;
	existingBranchSessionName?: string | null;
	project?: string | null;
	diagnosticWriter?: (message: string) => void;
	/**
	 * Synchronous owner-isolation proof boundary for managed tmux creation.
	 * Production uses Linux /proc probes; callers may inject deterministic proofs.
	 */
	ownerIsolationProbe?: OwnerIsolationProbeSync;
	/** Test seam for deterministic default-probe caller cgroup classification. */
	callerCgroupReader?: () => string | null;
}

export interface TmuxSpawnResult {
	exitCode: number | null;
	signalCode?: string | null;
	stderr?: string;
	stdout?: string;
}
export interface TmuxTerminalSize {
	columns: number;
	rows: number;
}

export type TmuxSpawnSync = (command: string, args: string[], options: TmuxSpawnOptions) => TmuxSpawnResult;

export interface TmuxSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin: "inherit" | "pipe";
	stdout: "inherit" | "pipe";
	stderr: "inherit" | "pipe";
	/**
	 * Captures control-plane stderr for sanitized, bounded diagnostics. PTY-bound
	 * commands retain inherited stderr for multiplexer compatibility.
	 */
	captureStderr?: boolean;
	/** Internal scoped-bootstrap input; never used for ordinary tmux commands. */
	stdinLine?: string;
}

export interface TmuxLaunchPlan {
	tmuxCommand: string;
	sessionName: string;
	cwd: string;
	innerCommand: string;
	newSessionArgs: string[];
	initialSize?: TmuxTerminalSize;
	branch?: string | null;
	attachSessionName?: string;
	project?: string | null;
	sessionId?: string | null;
	sessionStateFile?: string | null;
	/** Immutable Linux-managed owner provenance, assigned immediately before creation. */
	ownerGeneration?: string;
	/** Immutable run and endpoint identities bound into the supervised command. */
	ownerRunId?: string;
	ownerIncarnation?: string;
	/** Generation state captured before owner-isolation planning; required for publication CAS. */
	ownerGenerationBaseline?: OwnerGenerationBaseline;
	/** One-shot coordinator signing bootstrap endpoint; key material never enters tmux argv or environment. */
	coordinatorSidecarBootstrap?: { path: string; keyId: string };
	coordinatorSidecarBootstrapClose?: () => void;
	/** Native tmux session identity emitted atomically by `new-session -P -F`. */
	createdSessionId?: string;
	/** Safe server identity proven immediately after creation. */
	createdServerIdentity?: { pid: number; startTime: string; pidProven?: boolean };
	isPsmux: boolean;
	authority?: ProviderAuthority;
	platform: NodeJS.Platform;
}

function explicitTmuxSessionName(env: NodeJS.ProcessEnv): string | undefined {
	return env.GJC_TMUX_SESSION?.trim() || undefined;
}
function hasCurrentGjcVersion(session: GjcTmuxSessionStatus | undefined): boolean {
	return session?.version === VERSION;
}

function allowsExistingTmuxAttach(parsed: Args, env: NodeJS.ProcessEnv): boolean {
	// `--resume` belongs to the inner GJC session resolver. Let it reach main.ts so
	// value-less resume can show the session picker and valued resume can honor the target.
	return Boolean(parsed.continue || explicitTmuxSessionName(env));
}

function findExistingSessionForLaunch(context: {
	env: NodeJS.ProcessEnv;
	project: string;
	branch?: string | null;
}): string | undefined {
	const explicit = explicitTmuxSessionName(context.env);
	if (explicit) return findGjcTmuxSessionByName(explicit, context.env)?.name;
	const scoped = findGjcTmuxSessionByScope(context.project, context.branch, context.env);
	return hasCurrentGjcVersion(scoped) ? scoped?.name : undefined;
}

export interface GjcTmuxProfileResult {
	skipped: boolean;
	commands: GjcTmuxProfileCommand[];
	failures: Array<{ command: GjcTmuxProfileCommand; stderr?: string }>;
}

export interface GjcTmuxProfileContext {
	tmuxCommand: string;
	target: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawnSync?: TmuxSpawnSync;
	branch?: string | null;
	branchSlug?: string | null;
	project?: string | null;
	sessionId?: string | null;
	sessionStateFile?: string | null;
	ownerGeneration?: string | null;
	ownerServerKey?: string | null;
	version?: string | null;
	psmuxIncarnation?: string | null;
}

function tmuxExitMarkerPath(sessionStateFile: string): string {
	return path.join(path.dirname(sessionStateFile), "tmux-exit.json");
}

function buildPosixTmuxExitMarkerPrefix(markerPath: string): string {
	const markerDir = path.dirname(markerPath);
	return [
		`__gjc_tmux_exit_marker=${shellQuote(markerPath)}`,
		"__gjc_tmux_write_exit_marker() { __gjc_tmux_status=$?",
		"__gjc_tmux_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)",
		`mkdir -p ${shellQuote(markerDir)} 2>/dev/null || true`,
		'printf \'{"schema_version":1,"source":"tmux_inner_shell","ended_at":"%s","exit_code":%s}\\n\' "$__gjc_tmux_ended_at" "$__gjc_tmux_status" > "$__gjc_tmux_exit_marker" 2>/dev/null || true',
		"}",
		"trap __gjc_tmux_write_exit_marker EXIT",
	].join("; ");
}

interface CommandResolutionContext {
	cwd: string;
	argv: string[];
	execPath: string;
	extraEnv?: Record<string, string>;
	bootstrapSecret?: { path: string; urlEnv: string; keyIdEnv: string; keyId: string };
	tmuxExitMarkerPath?: string;
	platform?: NodeJS.Platform;
	managedOwnerSupervisor?: boolean;
}

function parseLaunchPolicy(env: NodeJS.ProcessEnv): LaunchPolicy {
	const raw = env[GJC_LAUNCH_POLICY_ENV]?.trim().toLowerCase();
	if (raw === "direct" || raw === "tmux") return raw;
	if (env.GJC_NO_TMUX === "1" || env.GJC_NO_TMUX === "true") return "direct";
	return "tmux";
}

function isInteractiveRootLaunch(parsed: Args, tty: TtyState): boolean {
	return (
		tty.stdin &&
		tty.stdout &&
		!parsed.help &&
		!parsed.version &&
		!parsed.print &&
		parsed.mode === undefined &&
		parsed.export === undefined &&
		parsed.listModels === undefined
	);
}

function isBunVirtualPath(value: string | undefined): boolean {
	const normalized = value?.trim().replace(/\\/g, "/").toLowerCase();
	return (
		normalized === "/$bunfs" ||
		normalized?.startsWith("/$bunfs/") === true ||
		normalized === "b:/~bun" ||
		normalized?.startsWith("b:/~bun/") === true
	);
}

const MAX_TMUX_DIAGNOSTIC_DETAIL_CODE_POINTS = 240;
const TERMINAL_DIAGNOSTIC_CONTROLS =
	/(?:\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|.)?|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)?|[\u0000-\u001f\u007f-\u009f])/g;

function sanitizeTmuxDiagnostic(stderr: string | undefined): string {
	const detail = stderr?.replace(TERMINAL_DIAGNOSTIC_CONTROLS, "").trim() ?? "";
	return Array.from(detail).slice(0, MAX_TMUX_DIAGNOSTIC_DETAIL_CODE_POINTS).join("");
}

function formatTmuxLaunchDiagnostic(stage: string, stderr?: string): string {
	const detail = sanitizeTmuxDiagnostic(stderr);
	const suffix = detail ? ` ${detail}` : "";
	return `gjc --tmux failed after creating tmux session: ${stage}.${suffix}\n`;
}

function failedRetryDiagnostic(retry: TmuxSpawnResult, retryProbe: TmuxSpawnResult): string | undefined {
	return retry.exitCode !== 0 ? retry.stderr : retryProbe.stderr;
}

function isExplicitTmuxRequest(context: TmuxLaunchContext): boolean {
	return context.parsed.tmux === true && context.rawArgs.includes("--tmux");
}

/**
 * Detect a corrupted gjc.cmd / gjc.bat wrapper at well-known PATH locations.
 * On Windows, `gjc.cmd` / `gjc.bat` files at the front of PATH that turn out
 * to be PE-binary garbage (e.g. a 194MB PE image written over the wrapper)
 * cause cmd.exe to hang silently when invoked from PowerShell — cmd reads
 * the binary as text and never returns, so the user sees the prompt return
 * with no output but no actual launch. This probe surfaces that failure mode
 * in the diagnostic so the user gets a clear "wrapper corrupted" hint instead
 * of a silent exit. Best-effort: returns null when the file is missing,
 * unreadable, or under 1KB (real CMD wrappers are 100-500 bytes; the original
 * 194MB PE-binary garbage was obviously out of band). Sync because the
 * call site (launchDefaultTmuxIfNeeded) is sync; uses statSync + 2-byte
 * read.
 */
function detectCorruptedGjcWrapper(): string | null {
	if (process.platform !== "win32") return null;
	const pathEnv = process.env.PATH ?? "";
	if (!pathEnv) return null;
	const seen = new Set<string>();
	for (const dir of pathEnv.split(path.delimiter)) {
		for (const name of ["gjc.cmd", "gjc.bat"]) {
			const full = path.join(dir, name);
			if (seen.has(full)) continue;
			seen.add(full);
			try {
				const stat = fs.statSync(full);
				if (!stat.isFile()) continue;
				if (stat.size < 1024) continue;
				if (stat.size > 64 * 1024) {
					return `Detected suspicious gjc wrapper at ${full}: ${stat.size} bytes (expected <1KB). The wrapper may be corrupted; cmd.exe will hang reading it as text. Recreate it from the gjc-tmux.cmd template.`;
				}
				const head = fs.readFileSync(full);
				if (head.byteLength < 2) continue;
				const view = new Uint8Array(head);
				if (view[0] === 0x4d && view[1] === 0x5a) {
					return `Detected PE-binary gjc wrapper at ${full} (MZ header, ${stat.size} bytes). cmd.exe will hang reading it as text. Recreate the wrapper from the gjc-tmux.cmd template.`;
				}
			} catch {}
		}
	}
	return null;
}
function formatTmuxUnavailableDiagnostic(platform: NodeJS.Platform): string {
	if (platform === "win32") {
		return (
			`gjc --tmux requested but no tmux executable was found; cannot continue without a tmux-backed session. ` +
			"GJC searched for psmux, pmux, and tmux on PATH. " +
			"Install psmux (https://github.com/psmux/psmux) for native Windows tmux support, or use WSL with real tmux. " +
			"You can also point GJC at a specific binary via GJC_TMUX_COMMAND.\n"
		);
	}
	return "gjc --tmux requested but no tmux executable was found; cannot continue without a tmux-backed session.\n";
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function coordinatorSidecarSigningEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const marker = env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]?.trim();
	const bootstrap = coordinatorSidecarSigningBootstrapEnv();
	const key =
		env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]?.trim() ?? bootstrap[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	const keyId = env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]?.trim() ?? bootstrap[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV];
	if (marker === undefined && key === undefined && keyId === undefined) return {};
	if (marker !== "true" || !key || !keyId || !/^[a-f0-9]{64}$/.test(keyId))
		throw new Error("Coordinator sidecar signing key is required for this tmux launch.");
	return {
		[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
		[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: key,
		[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: keyId,
	};
}

function coordinatorSidecarControlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const controlEnv = { ...env };
	delete controlEnv[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	return controlEnv;
}

function buildEnvAssignments(values: Record<string, string> | undefined): string {
	const entries = Object.entries(values ?? {});
	return entries.length === 0 ? "" : ` ${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")}`;
}
function stripRootTmuxFlag(rawArgs: string[]): string[] {
	return rawArgs.filter(arg => arg !== "--tmux");
}

export function applyGjcTmuxProfile(context: GjcTmuxProfileContext): GjcTmuxProfileResult {
	const env = context.env ?? process.env;
	const branchSlug = context.branch ? buildGjcTmuxSessionSlug(context.branch) : (context.branchSlug ?? null);
	// The psmux UX filter (mouse / set-clipboard / mode-style /
	// set-window-option) now lives in buildGjcTmuxProfileCommands so every
	// caller — gjc --tmux planning, gjc session create —
	// applies the same drop set when the active multiplexer is psmux. We pass
	// the resolved tmuxCommand through the new opts seam so the filter
	// engages for this exact command, not whatever the resolver returns at
	// profile-build time.
	const commands = buildGjcTmuxProfileCommands(
		context.target,
		env,
		{
			branch: context.branch ?? null,
			branchSlug,
			project: context.project ?? null,
			sessionId: context.sessionId ?? env[GJC_COORDINATOR_SESSION_ID_ENV] ?? null,
			sessionStateFile: context.sessionStateFile ?? env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] ?? null,
			ownerGeneration: context.ownerGeneration ?? null,
			ownerServerKey: context.ownerServerKey ?? null,
			version: context.version ?? null,
		},
		{ tmuxCommand: context.tmuxCommand },
	);
	if (context.psmuxIncarnation)
		commands.push({
			description: "record psmux incarnation",
			args: ["set-option", "-t", context.target, GJC_TMUX_PSMUX_INCARNATION_OPTION, context.psmuxIncarnation],
		});
	if (commands.length === 0) return { skipped: true, commands: [], failures: [] };
	const spawnSync = context.spawnSync ?? defaultSpawnSync;
	const cwd = context.cwd ?? process.cwd();
	const options: TmuxSpawnOptions = {
		cwd,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		captureStderr: true,
	};
	const failures: GjcTmuxProfileResult["failures"] = [];
	for (const command of commands) {
		const result = spawnSync(context.tmuxCommand, command.args, options);
		if (result.exitCode !== 0) failures.push({ command, stderr: result.stderr });
	}
	return { skipped: false, commands, failures };
}

function resolveCurrentGjcCommand(context: CommandResolutionContext): string[] {
	const pathModule = pathModuleForPlatform(context.platform);
	const isRealAbsolutePath = (value: string | undefined): value is string => {
		const normalized = value?.trim();
		if (!normalized || isBunVirtualPath(normalized)) return false;
		return pathModule.isAbsolute(normalized) || path.isAbsolute(normalized);
	};
	const isGjcExecutable = (value: string | undefined): value is string =>
		isRealAbsolutePath(value) && /^gjc(?:[._-]|$)/i.test(pathModule.basename(value.trim()));

	const runtime = context.argv[0]?.trim();
	const entrypoint = context.argv[1]?.trim();
	if (entrypoint && !isBunVirtualPath(entrypoint) && /\.(?:[cm]?[jt]s)$/i.test(entrypoint)) {
		const executable = isRealAbsolutePath(runtime)
			? runtime
			: isRealAbsolutePath(context.execPath)
				? context.execPath.trim()
				: undefined;
		if (!executable)
			throw new Error(
				"Unable to determine the current GJC source runtime for tmux launch; invoke GJC through an absolute runtime path.",
			);
		const resolvedEntrypoint = pathModule.isAbsolute(entrypoint)
			? entrypoint
			: pathModule.resolve(context.cwd, entrypoint);
		return [executable, resolvedEntrypoint];
	}

	const executable =
		(isGjcExecutable(entrypoint) ? entrypoint : undefined) ??
		(isGjcExecutable(runtime) ? runtime : undefined) ??
		(isGjcExecutable(context.execPath) ? context.execPath.trim() : undefined);
	if (executable) return [executable];
	throw new Error(
		"Unable to determine the current GJC executable for tmux launch; Bun virtual paths and PATH fallback are not accepted.",
	);
}
function isWindowsPlatform(platform: NodeJS.Platform | undefined): boolean {
	return platform === "win32";
}
function pathModuleForPlatform(platform: NodeJS.Platform | undefined): typeof path.win32 | typeof path.posix {
	return isWindowsPlatform(platform) ? path.win32 : path.posix;
}

function buildInnerCommand(context: CommandResolutionContext, rawArgs: string[]): string {
	if (isWindowsPlatform(context.platform))
		return buildWindowsPowerShellInnerCommand({
			command: resolveCurrentGjcCommand(context),
			args: stripRootTmuxFlag(rawArgs),
			environment: context.extraEnv,
			bootstrapSecret: context.bootstrapSecret,
			tmuxExitMarkerPath: context.tmuxExitMarkerPath,
		});
	const command = resolveCurrentGjcCommand(context);
	const childArgs = stripRootTmuxFlag(rawArgs);
	const supervisorEnv: Record<string, string> = context.managedOwnerSupervisor
		? {
				GJC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify([...command, ...childArgs]),
				GJC_MANAGED_OWNER_SUPERVISED: "1",
			}
		: {};
	const invocationArgs = context.managedOwnerSupervisor
		? [...command, MANAGED_OWNER_SUPERVISOR_ARG]
		: [...command, ...childArgs];
	const quoted = invocationArgs.map(shellQuote).join(" ");
	const invocation = `env ${GJC_TMUX_LAUNCHED_ENV}=1${buildEnvAssignments({ ...context.extraEnv, ...supervisorEnv })}${
		context.bootstrapSecret
			? ` ${context.bootstrapSecret.urlEnv}=${shellQuote(context.bootstrapSecret.path)} ${context.bootstrapSecret.keyIdEnv}=${shellQuote(context.bootstrapSecret.keyId)}`
			: ""
	} ${quoted}`;
	const bootstrappedInvocation = invocation;
	if (!context.tmuxExitMarkerPath) return `exec ${bootstrappedInvocation}`;
	return `${buildPosixTmuxExitMarkerPrefix(context.tmuxExitMarkerPath)}; ${bootstrappedInvocation}; exit $?`;
}

function stageCoordinatorSidecarBootstrap(
	stateDir: string,
	signingEnv: Record<string, string>,
): { path: string; keyId: string } | undefined {
	const key = signingEnv[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	const keyId = signingEnv[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV];
	if (!key || !keyId) return undefined;
	let bootstrapDir = stateDir;
	try {
		fs.mkdirSync(bootstrapDir, { recursive: true, mode: 0o700 });
	} catch {
		bootstrapDir = path.join(os.tmpdir(), "gjc-coordinator-bootstrap");
		fs.mkdirSync(bootstrapDir, { recursive: true, mode: 0o700 });
	}
	return { path: path.join(bootstrapDir, `.coordinator-sidecar-${crypto.randomUUID()}.key`), keyId };
}

/**
 * Materialize a one-shot loopback bootstrap endpoint immediately before the
 * managed owner child launches. The key never enters a file, argv, or tmux
 * server environment, and the endpoint closes after its first successful read.
 */
function writeCoordinatorSidecarBootstrapFile(plan: TmuxLaunchPlan, env: NodeJS.ProcessEnv): void {
	const bootstrap = plan.coordinatorSidecarBootstrap;
	if (!bootstrap) return;
	const key = coordinatorSidecarSigningEnv(env)[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	if (!key) throw new Error("Coordinator sidecar signing key disappeared before the managed owner launch.");
	plan.coordinatorSidecarBootstrapClose?.();
	plan.coordinatorSidecarBootstrapClose = undefined;
	const token = crypto.randomUUID();
	const ready = new Int32Array(new SharedArrayBuffer(4));
	const worker = isCompiledBinary()
		? new Worker("./packages/coding-agent/src/gjc-runtime/coordinator-sidecar-bootstrap-worker.ts", {
				type: "module",
			})
		: new Worker(new URL("./coordinator-sidecar-bootstrap-worker.ts", import.meta.url).href, { type: "module" });
	worker.postMessage({ type: "start", key, token, ready: ready.buffer });
	Atomics.wait(ready, 0, 0, 2_000);
	const port = Atomics.load(ready, 0);
	if (port <= 0) {
		void worker.terminate();
		throw new Error("Coordinator sidecar bootstrap responder failed to start.");
	}
	const endpoint = `http://127.0.0.1:${port}/bootstrap/${token}`;
	const stagedPath = bootstrap.path;
	plan.coordinatorSidecarBootstrap = { path: endpoint, keyId: bootstrap.keyId };
	plan.coordinatorSidecarBootstrapClose = () => {
		worker.postMessage({ type: "close" });
		void worker.terminate();
	};
	plan.innerCommand = replaceCoordinatorBootstrapPath(plan.innerCommand, stagedPath, endpoint, plan.platform);
	plan.newSessionArgs = [...plan.newSessionArgs.slice(0, -1), plan.innerCommand];
}

function replaceCoordinatorBootstrapPath(
	innerCommand: string,
	previousPath: string,
	nextPath: string,
	platform: NodeJS.Platform,
): string {
	if (platform !== "win32") return innerCommand.replace(previousPath, nextPath);
	const marker = "-EncodedCommand ";
	const markerIndex = innerCommand.indexOf(marker);
	if (markerIndex < 0)
		throw new Error("Coordinator sidecar bootstrap command is missing its encoded PowerShell payload.");
	const prefix = innerCommand.slice(0, markerIndex + marker.length);
	const encoded = innerCommand.slice(markerIndex + marker.length).trim();
	const script = Buffer.from(encoded, "base64").toString("utf16le");
	const replaced = script.replace(previousPath, nextPath);
	if (replaced === script)
		throw new Error("Coordinator sidecar bootstrap path was not present in the encoded PowerShell payload.");
	return `${prefix}${Buffer.from(replaced, "utf16le").toString("base64")}`;
}

function cleanupCoordinatorSidecarBootstrap(plan: TmuxLaunchPlan): void {
	plan.coordinatorSidecarBootstrapClose?.();
	plan.coordinatorSidecarBootstrapClose = undefined;
	plan.coordinatorSidecarBootstrap = undefined;
}

function visibleWidth(value: string): number {
	return Bun.stringWidth(value);
}

function truncateVisible(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	if (maxWidth === 1) return "…";

	let result = "";
	for (const char of value) {
		if (visibleWidth(`${result}${char}…`) > maxWidth) break;
		result += char;
	}

	return `${result}…`;
}

function truncateVisibleTail(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	if (maxWidth === 1) return "…";

	let result = "";
	for (const char of Array.from(value).reverse()) {
		if (visibleWidth(`…${char}${result}`) > maxWidth) break;
		result = `${char}${result}`;
	}

	return `…${result}`;
}

const GJC_TMUX_WINDOW_BRANCH_SEPARATOR = "-";
const GJC_TMUX_WINDOW_TITLE_PREFIX = "GJC-";
const GJC_TMUX_TERMINAL_TITLE_PREFIX = "GJC: ";
const GJC_TMUX_ROOT_TERMINAL_TITLE_OPTION = "@gjc-root-terminal-title";
const GJC_TMUX_ROOT_TERMINAL_TITLE_SESSION_OPTION = "@gjc-root-terminal-title-session";
const GJC_TMUX_DYNAMIC_SESSION_TITLE = "GJC: #{session_name}";

function sanitizeTmuxWindowTitleSegment(value: string): string {
	return value.replace(/:+/g, "-");
}

function sanitizeTmuxWindowProjectName(project: string): string {
	const trimmed = project.trim();
	if (!trimmed || /^\.+$/.test(trimmed)) return "gjc";
	if (trimmed.startsWith(".")) return sanitizeTmuxWindowTitleSegment(`dot-${trimmed.replace(/^\.+/, "")}`);
	return sanitizeTmuxWindowTitleSegment(trimmed);
}

function buildGjcTmuxPrefixedTitle(prefix: string, cwd: string, branch: string | null | undefined): string {
	const project = sanitizeTmuxWindowProjectName(path.basename(path.resolve(cwd)) || "gjc");
	const projectTitle = `${prefix}${project}`;
	const trimmedBranch = sanitizeTmuxWindowTitleSegment(branch?.trim() ?? "");
	if (!trimmedBranch) return truncateVisible(projectTitle, GJC_TMUX_WINDOW_LABEL_MAX_WIDTH);

	const separatorWidth = visibleWidth(GJC_TMUX_WINDOW_BRANCH_SEPARATOR);
	const projectWidth = visibleWidth(projectTitle);
	const fullTitle = `${projectTitle}${GJC_TMUX_WINDOW_BRANCH_SEPARATOR}${trimmedBranch}`;
	if (visibleWidth(fullTitle) <= GJC_TMUX_WINDOW_LABEL_MAX_WIDTH) return fullTitle;

	const remainingBranchWidth = GJC_TMUX_WINDOW_LABEL_MAX_WIDTH - projectWidth - separatorWidth;
	if (remainingBranchWidth <= 0) return truncateVisible(projectTitle, GJC_TMUX_WINDOW_LABEL_MAX_WIDTH);

	return `${projectTitle}${GJC_TMUX_WINDOW_BRANCH_SEPARATOR}${truncateVisibleTail(trimmedBranch, remainingBranchWidth)}`;
}

export function buildGjcTmuxWindowTitle(cwd: string, branch: string | null | undefined): string {
	return buildGjcTmuxPrefixedTitle(GJC_TMUX_WINDOW_TITLE_PREFIX, cwd, branch);
}

function buildGjcTmuxRootTerminalTitle(cwd: string, branch: string | null | undefined): string {
	return buildGjcTmuxPrefixedTitle(GJC_TMUX_TERMINAL_TITLE_PREFIX, cwd, branch);
}

function sanitizeGjcTmuxRootTerminalTitle(title: string): string {
	return title.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim() || "GJC";
}

function buildGjcTmuxRootTerminalTitleFormat(sessionName: string): string {
	if (!sessionName.startsWith(GJC_TMUX_SESSION_PREFIX)) return GJC_TMUX_DYNAMIC_SESSION_TITLE;
	return `#{?#{==:#{${GJC_TMUX_ROOT_TERMINAL_TITLE_SESSION_OPTION}},#{session_name}},#{${GJC_TMUX_ROOT_TERMINAL_TITLE_OPTION}},${GJC_TMUX_DYNAMIC_SESSION_TITLE}}`;
}

function buildGjcTmuxRootTerminalTitleCommands(
	target: string,
	sessionName: string,
	title: string,
): GjcTmuxProfileCommand[] {
	const sanitized = sanitizeGjcTmuxRootTerminalTitle(title);
	const format = buildGjcTmuxRootTerminalTitleFormat(sessionName);
	return [
		{
			description: "remember tmux client terminal title fallback",
			args: ["set-option", "-t", target, GJC_TMUX_ROOT_TERMINAL_TITLE_OPTION, sanitized],
		},
		{
			description: "remember tmux client terminal title session",
			args: ["set-option", "-t", target, GJC_TMUX_ROOT_TERMINAL_TITLE_SESSION_OPTION, sessionName],
		},
		{ description: "enable tmux client terminal title", args: ["set-option", "-t", target, "set-titles", "on"] },
		{
			description: "set dynamic tmux client terminal title",
			args: ["set-option", "-t", target, "set-titles-string", format],
		},
	];
}

function applyGjcTmuxRootTerminalTitleProfile(context: {
	tmuxCommand: string;
	target: string;
	sessionName: string;
	title: string | undefined;
	spawnSync: TmuxSpawnSync;
	options: TmuxSpawnOptions;
}): void {
	if (!context.title) return;
	for (const command of buildGjcTmuxRootTerminalTitleCommands(context.target, context.sessionName, context.title)) {
		context.spawnSync(context.tmuxCommand, command.args, context.options);
	}
}

function shouldSetGjcTmuxRootTerminalTitle(parsed: Args, env: NodeJS.ProcessEnv): boolean {
	return !parsed.noTitle && !(env.GJC_NO_TITLE || env.PI_NO_TITLE);
}

function buildTmuxRenameWindowArgs(title: string, target?: string): string[] {
	return target ? ["rename-window", "-t", target, "--", title] : ["rename-window", "--", title];
}

function renameTmuxWindow(
	tmuxCommand: string,
	title: string,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	target?: string,
): void {
	spawnSync(tmuxCommand, buildTmuxRenameWindowArgs(title, target), options);
}

interface TmuxWindowIdentity {
	paneId: string;
	windowId: string;
	windowIndex: string;
}

function parseTmuxWindowIdentity(value: string): TmuxWindowIdentity | null {
	const [paneId, windowId, windowIndex, extra] = value.trim().split("\t");
	if (
		extra !== undefined ||
		paneId === undefined ||
		windowId === undefined ||
		windowIndex === undefined ||
		!/^%\d+$/.test(paneId) ||
		!/^@\d+$/.test(windowId) ||
		!/^\d+$/.test(windowIndex)
	)
		return null;
	return { paneId, windowId, windowIndex };
}

function quoteTmuxCommandArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function renameExistingTmuxWindow(
	tmuxCommand: string,
	paneId: string,
	title: string,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
): void {
	if (!/^%\d+$/.test(paneId)) return;
	const observed = spawnSync(
		tmuxCommand,
		["display-message", "-p", "-t", paneId, "#{pane_id}\t#{window_id}\t#{window_index}"],
		options,
	);
	if (observed.exitCode !== 0) return;
	const identity = parseTmuxWindowIdentity(observed.stdout ?? "");
	if (!identity || identity.paneId !== paneId) return;

	// `if-shell -F` evaluates the pane binding and inserts the rename into the
	// same tmux command queue. The nested command targets the immutable window
	// id, so an active-window switch or index reuse cannot redirect the rename.
	const predicate = `#{&&:#{==:#{pane_id},${identity.paneId}},#{&&:#{==:#{window_id},${identity.windowId}},#{==:#{window_index},${identity.windowIndex}}}}`;
	const command = `rename-window -t ${identity.windowId} -- ${quoteTmuxCommandArgument(title)}`;
	spawnSync(tmuxCommand, ["if-shell", "-t", identity.paneId, "-F", predicate, command], options);
}

function renameExistingTmuxWindowIfNeeded(context: TmuxLaunchContext): void {
	const env = context.env ?? process.env;
	if (!env.TMUX || env[GJC_TMUX_LAUNCHED_ENV] === "1") return;
	if (parseLaunchPolicy(env) === "direct") return;

	// Note: Windows is intentionally allowed here. Psmux supports
	// `rename-window` and we want the leader window to inherit the
	// sanitized project-branch title even on native Windows, where
	// gjc --tmux runs through PowerShell to a psmux backend.

	const tty = context.tty ?? { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) };
	if (!isInteractiveRootLaunch(context.parsed, tty)) return;

	const tmuxCommand = resolveGjcTmuxCommand(env);
	const tmuxAvailable = context.tmuxAvailable ?? Bun.which(tmuxCommand) !== null;
	if (!tmuxAvailable) return;

	const paneId = env.TMUX_PANE?.trim();
	if (!paneId) return;
	const cwd = context.cwd ?? process.cwd();
	const branch = context.worktreeBranch ?? context.currentBranch ?? readCurrentBranch(cwd);
	const title = buildGjcTmuxWindowTitle(context.project ?? cwd, branch);
	const spawnSync = context.spawnSync ?? defaultSpawnSync;
	renameExistingTmuxWindow(tmuxCommand, paneId, title, spawnSync, {
		cwd,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		captureStderr: true,
	});
}

function readCurrentBranch(cwd: string): string | null {
	try {
		const result = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return null;
		const branch = result.stdout.toString().trim();
		return branch || null;
	} catch {
		return null;
	}
}

function createdSessionExactTarget(plan: TmuxLaunchPlan, env: NodeJS.ProcessEnv): string {
	return (
		plan.createdSessionId ??
		buildGjcTmuxExactSessionTarget(plan.sessionName, {
			env,
			platform: plan.platform,
			binary: { command: plan.tmuxCommand, isPsmux: plan.isPsmux, viaExplicitOverride: true },
		})
	);
}

function createdSessionOptionTarget(plan: TmuxLaunchPlan, env: NodeJS.ProcessEnv): string {
	// Native tmux assigns `$N` atomically during creation. Keep that immutable
	// identity (with its required empty-window suffix) for every later option
	// mutation; a reusable session name could resolve to a different session.
	if (plan.createdSessionId) return `${plan.createdSessionId}:`;
	return buildGjcTmuxExactOptionTarget(plan.sessionName, {
		env,
		platform: plan.platform,
		binary: { command: plan.tmuxCommand, isPsmux: plan.isPsmux, viaExplicitOverride: true },
	});
}

function cleanupCreatedTmuxSession(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	probe: OwnerIsolationProbeSync,
): void {
	// psmux does not disclose an immutable session ID. Never turn its reusable
	// name readback into a destructive cleanup target.
	if (plan.isPsmux || !isCreatedTmuxSessionIdentityStable(plan, spawnSync, options, probe))
		throw new Error("gjc_tmux_exact_cleanup_uncertain");
	const nativeSessionId = plan.createdSessionId!;
	// Emit the `#{pid}` clause only when the server proof proved a PID. Non-Linux
	// probes report a placeholder PID, and pinning `#{pid}` to it yields a
	// predicate no live tmux server can satisfy, which turns every guarded
	// cleanup on those platforms into `gjc_tmux_exact_cleanup_uncertain`.
	const createdServer = plan.createdServerIdentity!;
	const serverPidPredicate = createdServer.pidProven === false ? "1" : `#{==:#{pid},${createdServer.pid}}`;
	const guarded = spawnSync(
		plan.tmuxCommand,
		[
			"if-shell",
			"-t",
			nativeSessionId,
			"-F",
			`#{&&:${serverPidPredicate},#{&&:#{==:#{session_id},${nativeSessionId}},#{==:#{session_name},${plan.sessionName}}}}`,
			`kill-session -t ${nativeSessionId} \\; display-message -p __gjc_tmux_guarded_cleanup_ok__`,
			"display-message -p __gjc_tmux_guarded_cleanup_refused__",
		],
		options,
	);
	if (guarded.exitCode !== 0 || guarded.stdout?.trim() !== "__gjc_tmux_guarded_cleanup_ok__")
		throw new Error("gjc_tmux_exact_cleanup_uncertain");
}
function cleanupCreatedTmuxSessionBeforePublicationFailure(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	probe: OwnerIsolationProbeSync,
): void {
	// Generation publication is the commit point. Before it, clean up only when
	// the immutable session and server proof still identify our provisional
	// session; a failed proof must preserve it for recovery.
	if (!isCreatedTmuxSessionIdentityStable(plan, spawnSync, options, probe)) return;
	try {
		cleanupCreatedTmuxSession(plan, spawnSync, options, probe);
	} catch {
		// The guarded command either refused or its proof changed after the
		// preflight. In both cases preserving the session is safer than retrying.
	}
}

function cleanupCreatedTmuxSessionAfterFailure(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	probe: OwnerIsolationProbeSync,
): void {
	cleanupCreatedTmuxSessionBeforePublicationFailure(plan, spawnSync, options, probe);
}

function isCreatedTmuxSessionIdentityStable(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	probe: OwnerIsolationProbeSync,
): boolean {
	if (!plan.createdServerIdentity) return false;
	try {
		if (plan.isPsmux) {
			const binding = spawnSync(
				plan.tmuxCommand,
				["display-message", "-p", "-t", createdSessionExactTarget(plan, options.env), "#{session_name}"],
				options,
			);
			return binding.exitCode === 0 && binding.stdout?.trim() === plan.sessionName;
		}
		if (!plan.createdSessionId) return false;
		const before = probe.probeServer(plan.tmuxCommand);
		if (
			before.state !== "safe" ||
			before.pid !== plan.createdServerIdentity.pid ||
			before.startTime !== plan.createdServerIdentity.startTime
		)
			return false;
		const binding = spawnSync(
			plan.tmuxCommand,
			["display-message", "-p", "-t", plan.createdSessionId, "#{session_id}\t#{session_name}"],
			options,
		);
		const after = probe.probeServer(plan.tmuxCommand);
		return (
			binding.exitCode === 0 &&
			binding.stdout?.trim() === `${plan.createdSessionId}\t${plan.sessionName}` &&
			after.state === "safe" &&
			after.pid === before.pid &&
			after.startTime === before.startTime
		);
	} catch {
		return false;
	}
}
function isTmuxAttachDisconnectError(result: TmuxSpawnResult): boolean {
	if (result.signalCode === "SIGHUP") return true;
	return /\b(?:EIO|input\/output error)\b/i.test(result.stderr ?? "");
}
function isWindowsPsmuxAttachConnectionRefused(plan: TmuxLaunchPlan, result: TmuxSpawnResult): boolean {
	if (plan.platform !== "win32" || !plan.isPsmux) return false;
	return /\bos error 10061\b/i.test(result.stderr ?? "");
}

function isWindowsPsmuxMissingSessionRegistrationRace(
	plan: TmuxLaunchPlan,
	result: { exitCode?: number | null; stderr?: string },
): boolean {
	if (plan.platform !== "win32" || !plan.isPsmux || result.exitCode === 0) return false;
	return result.stderr?.trim() === `psmux: can't find session '${plan.sessionName}' (no server running)`;
}
function waitForWindowsPsmuxAttachRetry(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WINDOWS_PSMUX_ATTACH_RETRY_DELAY_MS);
}
function normalizeTmuxTerminalDimension(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return undefined;
	return value;
}

function normalizeTmuxStatusLineCount(value: number | undefined): number {
	if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return 0;
	return value;
}

function parseTmuxStatusLineCount(value: string): number {
	const normalized = value.trim().toLowerCase();
	if (normalized.length === 0 || normalized === "off" || normalized === "0") return 0;
	if (normalized === "on") return 1;
	const parsed = Number.parseInt(normalized, 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function readTmuxStatusLineCount(tmuxCommand: string, cwd: string, env: NodeJS.ProcessEnv): number {
	if (resolveGjcTmuxBinary({ env }).isPsmux) return 0;
	const result = Bun.spawnSync([tmuxCommand, "show-options", "-gqv", "status"], {
		cwd,
		env: coordinatorSidecarControlEnv(env),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return 0;
	return parseTmuxStatusLineCount(new TextDecoder().decode(result.stdout));
}

function resolveCallerTmuxTerminalSize(tty: TtyState, tmuxStatusLines = 0): TmuxTerminalSize | undefined {
	if (!tty.stdout) return undefined;
	const columns = normalizeTmuxTerminalDimension(tty.columns);
	const rows = normalizeTmuxTerminalDimension(tty.rows);
	if (columns === undefined || rows === undefined) return undefined;
	const adjustedRows = Math.max(1, rows - normalizeTmuxStatusLineCount(tmuxStatusLines));
	return { columns, rows: adjustedRows };
}

function buildTmuxNewSessionSizeArgs(size: TmuxTerminalSize | undefined): string[] {
	return size ? ["-x", String(size.columns), "-y", String(size.rows)] : [];
}

// Ensure the freshly created window fits the terminal that ultimately attaches.
// `new-session` already starts the window (and the inner TUI) at the caller's
// captured `-x/-y` size; this step governs what happens on `attach-session`.
//
// On native tmux we must NOT reassert with `resize-window`: that command flips
// the window's `window-size` option to `manual`, pinning it to the capture-time
// dimensions and stopping `attach-session` from resizing the window to the real
// client. When the attaching terminal is larger than the capture — e.g. a GUI
// terminal that reports a smaller size before it finishes sizing — the pinned
// window stays small and tmux paints the uncovered client area with `·` fill
// (the "window smaller than client" symptom). Keeping `window-size` on `latest`
// lets tmux size the window to the attaching client (status line included).
//
// psmux (Windows) does not share tmux's `window-size` semantics, so preserve the
// historical explicit `resize-window` reassert there rather than sending an
// option its server may reject and echo into the user's pane.
function ensureCreatedTmuxWindowTracksCallerTerminal(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
): void {
	if (!plan.initialSize) return;
	const target = createdSessionOptionTarget(plan, options.env);
	if (plan.isPsmux) {
		spawnSync(
			plan.tmuxCommand,
			["resize-window", "-t", target, "-x", String(plan.initialSize.columns), "-y", String(plan.initialSize.rows)],
			options,
		);
		return;
	}
	spawnSync(plan.tmuxCommand, ["set-window-option", "-t", target, "window-size", "latest"], options);
}

export function buildDefaultTmuxLaunchPlan(context: TmuxLaunchContext): TmuxLaunchPlan | undefined {
	const env = context.env ?? process.env;
	const policy = parseLaunchPolicy(env);
	if (!context.parsed.tmux || policy === "direct") return undefined;
	if (env.TMUX || env[GJC_TMUX_LAUNCHED_ENV] === "1") return undefined;
	const platform = context.platform ?? process.platform;
	const tty = context.tty ?? {
		stdin: Boolean(process.stdin.isTTY),
		stdout: Boolean(process.stdout.isTTY),
		columns: process.stdout.columns,
		rows: process.stdout.rows,
	};
	if (policy === "tmux" && !isInteractiveRootLaunch(context.parsed, tty)) return undefined;

	const cwd = context.cwd ?? process.cwd();
	const branch = context.worktreeBranch ?? context.currentBranch ?? readCurrentBranch(cwd);
	const project = context.project ?? cwd;
	const sessionName = buildGjcTmuxSessionName(env, { branch });
	// Pick the most appropriate tmux binary for this platform. On native Windows
	// the resolver walks psmux / pmux / tmux and uses the first one present on
	// PATH, so the default `gjc --tmux` flow lands on a real multiplexer even
	// without an explicit GJC_TMUX_COMMAND override.
	const resolvedBinary = resolveGjcTmuxBinary({ platform, env });
	const tmuxCommand = resolvedBinary.command;
	const sessionId = env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || sessionName;
	// The session ROOT is keyed by the active GJC session (GJC_SESSION_ID), NOT the
	// coordinator/tmux identity. Fall back to the coordinator id only for standalone
	// tmux launches with no GJC session context.
	const gjcSessionId = env.GJC_SESSION_ID?.trim() || sessionId;
	const sessionStateFile =
		env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim() ||
		tmuxRuntimeSessionPath(cwd, gjcSessionId, buildGjcTmuxSessionSlug(sessionName));
	const signingEnv = coordinatorSidecarSigningEnv(env);
	// Stage only the one-shot channel descriptor (path + key id). The PKCS#8 key
	// itself stays in memory until writeCoordinatorSidecarBootstrapFile runs
	// immediately before the managed owner launches, so attach-only, tmux-less,
	// and other non-launch paths never expose key material on disk.
	const coordinatorSidecarBootstrap = stageCoordinatorSidecarBootstrap(path.dirname(sessionStateFile), signingEnv);
	const childSigningEnv = { ...signingEnv };
	delete childSigningEnv[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	const tmuxAvailable = context.tmuxAvailable ?? Bun.which(tmuxCommand) !== null;
	if (!tmuxAvailable) {
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxUnavailableDiagnostic(platform));
		return undefined;
	}
	const existingSessionName = allowsExistingTmuxAttach(context.parsed, env)
		? "existingBranchSessionName" in context
			? (context.existingBranchSessionName ?? undefined)
			: resolvedBinary.isPsmux && platform === "win32"
				? explicitTmuxSessionName(env)
				: findExistingSessionForLaunch({
						env,
						project,
						branch,
					})
		: undefined;
	const innerCommand = buildInnerCommand(
		{
			cwd,
			argv: context.argv ?? process.argv,
			execPath: context.execPath ?? process.execPath,
			extraEnv: {
				...childSigningEnv,
				[GJC_COORDINATOR_SESSION_ID_ENV]: sessionId,
				[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: sessionStateFile,
				// Carry the GJC-managed session name into the child so tmux-backed
				// flows can target the correct leader session by name. Under psmux on
				// Windows the inherited TMUX_PANE can resolve to the wrong/default
				// session, which would split/send workers into the wrong session.
				[GJC_TMUX_ACTIVE_SESSION_ENV]: sessionName,
			},
			tmuxExitMarkerPath: tmuxExitMarkerPath(sessionStateFile),
			platform,
		},
		context.rawArgs,
	);
	const tmuxStatusLines =
		context.tmuxStatusLines ??
		(context.tmuxAvailable === undefined ? readTmuxStatusLineCount(tmuxCommand, cwd, env) : 0);
	const initialSize = resolveCallerTmuxTerminalSize(tty, tmuxStatusLines);
	return {
		tmuxCommand,
		isPsmux: resolvedBinary.isPsmux,
		platform,
		sessionName,
		cwd,
		innerCommand,
		newSessionArgs: [
			"new-session",
			"-d",
			...buildTmuxNewSessionSizeArgs(initialSize),
			"-s",
			sessionName,
			"-c",
			cwd,
			...(resolvedBinary.isPsmux ? [] : ["-P", "-F", "#{session_id}"]),
			innerCommand,
		],
		initialSize,
		branch,
		project,
		sessionId,
		sessionStateFile,
		coordinatorSidecarBootstrap,
		attachSessionName: existingSessionName,
	};
}

function trustedReplacementAuthority(
	stateDir: string,
	sessionId: string,
	baseline: OwnerGenerationBaseline,
): ManagedOwnerPredecessorEvidence | undefined {
	return resolveManagedOwnerPredecessorSync(stateDir, sessionId, baseline);
}

function prepareManagedOwnerLifecycle(plan: TmuxLaunchPlan, context: TmuxLaunchContext): void {
	if (plan.ownerGeneration) return;
	const sessionId = plan.sessionId ?? plan.sessionName;
	const stateDir = path.dirname(plan.sessionStateFile ?? path.join(plan.cwd, ".gjc", "runtime"));
	const baseline = captureOwnerGenerationBaselineSync(stateDir, sessionId);
	const replacement = trustedReplacementAuthority(stateDir, sessionId, baseline);
	const generation = crypto.randomUUID();
	const runId = crypto.randomUUID();
	const incarnation = crypto.randomUUID();
	plan.ownerGenerationBaseline = baseline;
	// Stage immutable identity in the child command. It becomes current only after
	// immutable creation proof and ownership tagging complete.
	plan.ownerGeneration = generation;
	plan.ownerRunId = runId;
	plan.ownerIncarnation = incarnation;
	const innerCommand = buildInnerCommand(
		{
			cwd: plan.cwd,
			argv: context.argv ?? process.argv,
			execPath: context.execPath ?? process.execPath,
			extraEnv: {
				...(plan.coordinatorSidecarBootstrap
					? {
							[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
							[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: plan.coordinatorSidecarBootstrap.keyId,
						}
					: {}),
				[GJC_COORDINATOR_SESSION_ID_ENV]: sessionId,
				[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: plan.sessionStateFile ?? "",
				// The tmux server inherits the bootstrap secret as child environment;
				// never serialize it into the command argument passed to tmux.
				[GJC_TMUX_ACTIVE_SESSION_ENV]: plan.sessionName,
				[GJC_TMUX_OWNER_GENERATION_ENV]: generation,
				[GJC_TMUX_OWNER_STATE_DIR_ENV]: stateDir,
				[GJC_TMUX_OWNER_SERVER_KEY_ENV]: plan.tmuxCommand,
				[MANAGED_OWNER_RUN_ID_ENV]: runId,
				[MANAGED_OWNER_INCARNATION_ENV]: incarnation,
				...(replacement
					? {
							[MANAGED_OWNER_PREDECESSOR_TOKEN_ENV]: replacement.predecessorToken,
							[MANAGED_OWNER_PREDECESSOR_GENERATION_ENV]: replacement.generation,
							[MANAGED_OWNER_PREDECESSOR_RUN_ID_ENV]: replacement.runId,
							[MANAGED_OWNER_PREDECESSOR_INCARNATION_ENV]: replacement.incarnation,
							[MANAGED_OWNER_TRANSCRIPT_PATH_ENV]:
								context.env?.GJC_SESSION_FILE ?? process.env.GJC_SESSION_FILE ?? "",
						}
					: {}),
			},
			bootstrapSecret: plan.coordinatorSidecarBootstrap
				? {
						path: plan.coordinatorSidecarBootstrap.path,
						urlEnv: GJC_COORDINATOR_SIDECAR_BOOTSTRAP_URL_ENV,
						keyIdEnv: GJC_COORDINATOR_SIDECAR_KEY_ID_ENV,
						keyId: plan.coordinatorSidecarBootstrap.keyId,
					}
				: undefined,
			// Linux managed owner close signals the pane PID. Do not place the exit-marker shell
			// in front of it; `buildInnerCommand` therefore execs the GJC owner directly.
			tmuxExitMarkerPath: plan.platform === "linux" ? undefined : tmuxExitMarkerPath(plan.sessionStateFile ?? ""),
			platform: plan.platform,
			managedOwnerSupervisor: plan.platform === "linux",
		},
		context.rawArgs,
	);
	plan.innerCommand = innerCommand;
	plan.newSessionArgs = [...plan.newSessionArgs.slice(0, -1), innerCommand];
}

function defaultSpawnSync(command: string, args: string[], options: TmuxSpawnOptions): TmuxSpawnResult {
	// Only attach-session is interactive. Every other command is control-plane
	// traffic and must not write unbounded, untrusted terminal bytes directly.
	const interactiveAttach = args[0] === "attach-session";
	const stdin = options.stdinLine === undefined ? options.stdin : Buffer.from(`${options.stdinLine}\n`);
	const stdio = interactiveAttach
		? { stdin, stdout: options.stdout, stderr: options.stderr }
		: { stdin, stdout: options.stdout, stderr: "pipe" as const };
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		cwd: options.cwd,
		env: options.env,
		...stdio,
	});
	const stderrText = stdio.stderr === "pipe" ? new TextDecoder().decode(result.stderr) : undefined;
	return {
		exitCode: result.exitCode,
		signalCode: result.signalCode,
		stderr: stderrText,
		stdout: result.stdout ? new TextDecoder().decode(result.stdout) : "",
	};
}

function defaultOwnerIsolationProbe(
	plan: TmuxLaunchPlan,
	env: NodeJS.ProcessEnv,
	spawn: TmuxSpawnSync,
	callerCgroupReader?: () => string | null,
): OwnerIsolationProbeSync {
	const stateDir = path.dirname(plan.sessionStateFile ?? path.join(plan.cwd, ".gjc", "runtime"));
	const probeServer = (): TmuxServerProof => {
		if (plan.platform !== "linux") {
			return {
				state: "safe",
				pid: 1,
				startTime: "not-applicable",
				cgroup: { classification: "not_applicable" },
				pidProven: false,
			};
		}
		const probe = spawn(plan.tmuxCommand, ["display-message", "-p", "#{pid}"], {
			cwd: plan.cwd,
			env: coordinatorSidecarControlEnv(env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		if (probe.exitCode !== 0) {
			return /no server running|failed to connect|error connecting/.test(probe.stderr ?? "")
				? { state: "absent" }
				: { state: "unverifiable" };
		}
		const pid = Number(probe.stdout?.trim());
		let startTime: string | undefined;
		let cgroupText: string | null = null;
		try {
			startTime = readLinuxProcStartTimeSync(pid) ?? undefined;
			cgroupText = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
		} catch {}
		if (!startTime) return { state: "unverifiable" };
		const cgroup = classifyCgroup({ platform: plan.platform, cgroupText });
		return {
			state:
				cgroup.classification === "safe"
					? "safe"
					: cgroup.classification === "unsafe_service"
						? "unsafe"
						: "unverifiable",
			pid,
			startTime,
			cgroup,
		};
	};
	return {
		readCallerCgroup:
			plan.platform !== "linux"
				? () => null
				: (callerCgroupReader ??
					(() => {
						try {
							return fs.readFileSync("/proc/self/cgroup", "utf8");
						} catch {
							return null;
						}
					})),
		probeServer,
		recordAttempt: ({ attempt }) => {
			const generation = plan.ownerGeneration ?? plan.sessionName;
			const root = lifecyclePaths(stateDir, plan.sessionId ?? plan.sessionName, generation).root;
			fs.mkdirSync(root, { recursive: true, mode: 0o700 });
			const file = path.join(root, `attempt-${attempt.token}.json`);
			let descriptor: number | undefined;
			try {
				descriptor = fs.openSync(file, "wx", 0o600);
				fs.writeFileSync(
					descriptor,
					`${JSON.stringify({
						schema_version: 1,
						generation,
						session_id: plan.sessionId ?? plan.sessionName,
						...attempt,
						created_at: new Date().toISOString(),
					})}\n`,
				);
				fs.fsyncSync(descriptor);
				fs.closeSync(descriptor);
				descriptor = undefined;
				const directory = fs.openSync(root, "r");
				try {
					fs.fsyncSync(directory);
				} finally {
					fs.closeSync(directory);
				}
			} finally {
				if (descriptor !== undefined) fs.closeSync(descriptor);
			}
		},
	};
}

function createIsolatedTmuxSession(
	plan: TmuxLaunchPlan,
	spawn: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	diagnostic: (message: string) => void,
	probe: OwnerIsolationProbeSync,
): TmuxSpawnResult {
	const sessionId = plan.sessionId ?? plan.sessionName;
	const stateDir = path.dirname(plan.sessionStateFile ?? path.join(plan.cwd, ".gjc", "runtime"));
	const baseline = plan.ownerGenerationBaseline ?? captureOwnerGenerationBaselineSync(stateDir, sessionId);
	plan.ownerGenerationBaseline = baseline;
	const ownerPlan = planTmuxOwnerIsolationSync(
		{
			schema_version: 1,
			op: "plan",
			platform: plan.platform,
			session_id: sessionId,
			owner_generation: plan.ownerGeneration ?? plan.sessionName,
			baseline,
			cwd: plan.cwd,
			state_dir: stateDir,
			socket_key: plan.tmuxCommand,
			tmux_argv: [plan.tmuxCommand, ...plan.newSessionArgs],
		},
		probe,
	);
	let executed: TmuxSpawnResult | undefined;
	const outcome = executeTmuxOwnerIsolationPlanSync(ownerPlan, {
		socketKey: plan.tmuxCommand,
		spawn: (argv, stdinLine) => {
			executed = spawn(argv[0]!, argv.slice(1), {
				...options,
				stdin: stdinLine ? "pipe" : options.stdin,
				stdinLine,
			});
			if (!plan.isPsmux) {
				const nativeSessionId = executed.stdout?.trim();
				if (/^\$\d+$/.test(nativeSessionId ?? "")) plan.createdSessionId = nativeSessionId;
			}
			return { exitCode: executed.exitCode, stdout: executed.stdout };
		},
		probeServer: probe.probeServer,
		isCurrentGeneration: () => isOwnerGenerationBaselineCurrentSync(stateDir, sessionId, baseline),
		cleanupSpawned: ({ nativeSessionId, server }) => {
			plan.createdSessionId = nativeSessionId;
			plan.createdServerIdentity = {
				pid: server.pid!,
				startTime: server.startTime!,
				pidProven: server.pidProven,
			};
			cleanupCreatedTmuxSessionAfterFailure(plan, spawn, options, probe);
		},
	});
	// A failed planned spawn is the new-session failure. Let its established
	// diagnostic path report it exactly once instead of replacing it with an
	// isolation diagnostic.
	if (executed && executed.exitCode !== 0) return executed;
	if (!outcome.ok) {
		diagnostic(`tmux owner isolation failed: ${outcome.code}`);
		return { exitCode: 1, stderr: outcome.diagnostic };
	}
	if (!plan.isPsmux && outcome.native_session_id) plan.createdSessionId = outcome.native_session_id;
	plan.createdServerIdentity = {
		pid: outcome.server_pid,
		startTime: outcome.server_start_time,
		pidProven: plan.platform === "linux" ? undefined : false,
	};
	return executed ?? { exitCode: 1, stderr: "tmux owner isolation did not execute" };
}

function requiredProfileFailure(profile: GjcTmuxProfileResult): GjcTmuxProfileResult["failures"][number] | undefined {
	const requiredOptions = new Set([
		"@gjc-profile",
		"@gjc-session-id",
		"@gjc-session-state-file",
		"@gjc-owner-generation",
		"@gjc-owner-server-key",
		GJC_TMUX_PSMUX_INCARNATION_OPTION,
	]);
	return profile.failures.find(item => requiredOptions.has(String(item.command.args[item.command.args.length - 2])));
}

function emitOptionalProfileDiagnostics(profile: GjcTmuxProfileResult, diagnostic: (message: string) => void): void {
	for (const failure of profile.failures) {
		if (requiredProfileFailure({ ...profile, failures: [failure] })) continue;
		diagnostic("optional tmux profile command failed");
	}
}

export function launchDefaultTmuxIfNeeded(context: TmuxLaunchContext): boolean {
	const env = context.env ?? process.env;
	// Planning performs only applicability checks. It must precede both the ambient
	// window rename and provider refusal so inapplicable root launches reach main
	// unchanged, while unsupported managed launches fail before any tmux mutation.
	const plan = buildDefaultTmuxLaunchPlan(context);
	if (!plan && env.TMUX && (context.platform ?? process.platform) === "win32") {
		const ambientProvider = resolveGjcTmuxBinary({ platform: "win32", env });
		if (ambientProvider.isPsmux) return false;
	}
	// Direct launches inside an ambient tmux session retain their existing title
	// behavior, but only after managed-launch applicability was ruled out.
	renameExistingTmuxWindowIfNeeded(context);
	if (!plan) {
		const env = context.env ?? process.env;
		const tty = context.tty ?? {
			stdin: Boolean(process.stdin.isTTY),
			stdout: Boolean(process.stdout.isTTY),
		};
		const platform = context.platform ?? process.platform;
		const tmuxCommand = resolveGjcTmuxBinary({ platform, env }).command;
		const tmuxAvailable = context.tmuxAvailable ?? Bun.which(tmuxCommand) !== null;
		if (
			isExplicitTmuxRequest(context) &&
			parseLaunchPolicy(env) !== "direct" &&
			!env.TMUX &&
			env[GJC_TMUX_LAUNCHED_ENV] !== "1" &&
			isInteractiveRootLaunch(context.parsed, tty) &&
			!tmuxAvailable
		)
			return true;
		return false;
	}

	const rawSpawnSync = context.spawnSync ?? defaultSpawnSync;
	if (plan.isPsmux && plan.platform === "win32") {
		try {
			if (plan.attachSessionName) {
				const stateDir = env[GJC_TMUX_OWNER_STATE_DIR_ENV]?.trim();
				const sessionId = env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim();
				const generation = env[GJC_TMUX_OWNER_GENERATION_ENV]?.trim();
				if (!stateDir || !sessionId || !generation) throw new Error("gjc_tmux_provider_authority_unavailable");
				plan.authority = readGjcTmuxProviderAuthoritySync({ stateDir, sessionId, generation });
			} else {
				prepareManagedOwnerLifecycle(plan, context);
				if (!plan.sessionId || !plan.ownerGeneration || !plan.sessionStateFile)
					throw new Error("gjc_tmux_provider_authority_missing_lifecycle_identity");
				const stateDir = path.dirname(plan.sessionStateFile);
				const previousAuthority =
					plan.ownerGenerationBaseline?.state === "current"
						? readGjcTmuxProviderAuthoritySync({
								stateDir,
								sessionId: plan.sessionId,
								generation: plan.ownerGenerationBaseline.generation,
							})
						: undefined;
				plan.authority = previousAuthority
					? bindGjcTmuxProviderAuthority(previousAuthority, {
							stateDir,
							sessionId: plan.sessionId,
							generation: plan.ownerGeneration,
						})
					: (
							context.providerAuthorityResolver ??
							(input =>
								bindGjcTmuxProviderAuthority(
									resolveGjcTmuxProviderContext({
										platform: input.platform,
										env: input.env,
										binary: { command: input.command, isPsmux: true, viaExplicitOverride: true },
									}),
									input,
								))
						)({
							platform: plan.platform,
							env,
							command: plan.tmuxCommand,
							stateDir,
							sessionId: plan.sessionId,
							generation: plan.ownerGeneration,
						});
			}
			plan.tmuxCommand = plan.authority.command;
			if (!plan.attachSessionName) {
				(context.providerAuthorityPersist ?? persistGjcTmuxProviderAuthoritySync)(plan.authority);
				(context.providerAuthorityStagedAssert ?? assertGjcTmuxStagedMutationAuthoritySync)(plan.authority);
			}
		} catch (error) {
			cleanupCoordinatorSidecarBootstrap(plan);
			(context.diagnosticWriter ?? safeStderrWrite)(`tmux provider authority resolution failed: ${String(error)}`);
			return true;
		}
	}
	let providerAuthorityPublished = !plan.authority || Boolean(plan.attachSessionName);
	const spawnSync: TmuxSpawnSync = (command, args, options) => {
		const authority = plan.authority;
		if (!authority) return rawSpawnSync(command, args, options);
		const assertAuthority = providerAuthorityPublished
			? (context.providerAuthorityAssert ?? assertGjcTmuxMutationAuthoritySync)
			: (context.providerAuthorityStagedAssert ?? assertGjcTmuxStagedMutationAuthoritySync);
		assertAuthority(authority);
		try {
			return rawSpawnSync(command, [...authority.commandPrefix, ...args], options);
		} finally {
			assertAuthority(authority);
		}
	};
	const creationSpawn = plan.authority ? spawnSync : rawSpawnSync;
	const spawnEnv = { ...env };
	delete spawnEnv[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	const signingEnv = coordinatorSidecarSigningEnv(env);
	Object.assign(spawnEnv, signingEnv);
	delete spawnEnv[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	const options: TmuxSpawnOptions = {
		cwd: plan.cwd,
		env: spawnEnv,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	};
	const ownerIsolationProbe =
		context.ownerIsolationProbe ?? defaultOwnerIsolationProbe(plan, env, spawnSync, context.callerCgroupReader);
	const attachOptions: TmuxSpawnOptions = { ...options };
	const controlOptions: TmuxSpawnOptions = {
		...options,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		captureStderr: true,
	};
	// has-session / new-session retry / profile-tagging probe share these
	// pipe-stdio options. Only attach-session inherits the interactive terminal.
	const probeOptions: TmuxSpawnOptions = {
		...controlOptions,
	};
	// new-session needs pipe stdio (not inherit) because the user terminal must
	// remain untouched until attach-session takes over. Inheriting psmux's
	// stdout/stderr for new-session can corrupt the terminal state or race with
	// attach-session on Windows, where psmux 3.3.0/3.3.6's server can die if it
	// sees the controlling TTY in an inconsistent state mid-spawn. Capturing
	// both streams also gives the diagnostic writer the full error detail when
	// new-session itself fails.
	const newSessionOptions: TmuxSpawnOptions = {
		...options,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		captureStderr: true,
	};

	const windowTitle = buildGjcTmuxWindowTitle(plan.project ?? plan.cwd, plan.branch);
	const rootTerminalTitle = shouldSetGjcTmuxRootTerminalTitle(context.parsed, env)
		? buildGjcTmuxRootTerminalTitle(plan.project ?? plan.cwd, plan.branch)
		: undefined;
	const buildProfileInputs = (): GjcTmuxProfileContext => ({
		tmuxCommand: plan.tmuxCommand,
		cwd: plan.cwd,
		env: coordinatorSidecarControlEnv(env),
		spawnSync,
		branch: plan.branch,
		project: plan.project,
		sessionId: plan.sessionId ?? null,
		sessionStateFile: plan.sessionStateFile ?? null,
		ownerGeneration: plan.ownerGeneration ?? null,
		ownerServerKey: plan.tmuxCommand,
		version: VERSION,
		psmuxIncarnation: plan.isPsmux ? (plan.ownerIncarnation ?? null) : null,
		target: createdSessionOptionTarget(plan, env),
	});
	const hasExactRequiredPsmuxMetadata = (): boolean => {
		if (!plan.isPsmux || !plan.authority) return true;
		const required = [
			...buildGjcTmuxProfileCommands(createdSessionOptionTarget(plan, env), env, {
				sessionId: plan.sessionId,
				sessionStateFile: plan.sessionStateFile,
				ownerGeneration: plan.ownerGeneration,
				ownerServerKey: plan.tmuxCommand,
				version: VERSION,
			}),
			...(plan.ownerIncarnation
				? [
						{
							description: "record psmux incarnation",
							args: [
								"set-option",
								"-t",
								createdSessionOptionTarget(plan, env),
								GJC_TMUX_PSMUX_INCARNATION_OPTION,
								plan.ownerIncarnation,
							],
						},
					]
				: []),
		].filter(command =>
			[
				"@gjc-profile",
				"@gjc-session-id",
				"@gjc-session-state-file",
				"@gjc-owner-generation",
				"@gjc-owner-server-key",
				GJC_TMUX_PSMUX_INCARNATION_OPTION,
			].includes(command.args[command.args.length - 2] ?? ""),
		);
		return required.every(command => {
			const option = command.args[command.args.length - 2]!;
			const expected = command.args[command.args.length - 1]!;
			const readback = spawnSync(
				plan.tmuxCommand,
				["display-message", "-p", "-t", createdSessionOptionTarget(plan, env), `#{${option}}`],
				controlOptions,
			);
			return readback.exitCode === 0 && readback.stdout?.trim() === expected;
		});
	};
	const probeHasSession = (): TmuxSpawnResult =>
		spawnSync(plan.tmuxCommand, ["has-session", "-t", createdSessionExactTarget(plan, env)], probeOptions);
	const attachCreatedSession = (): TmuxSpawnResult =>
		spawnSync(plan.tmuxCommand, ["attach-session", "-t", createdSessionExactTarget(plan, env)], attachOptions);

	if (plan.attachSessionName) {
		let existingTarget: string;
		let existingProof: ProvenTmuxSessionIdentity | undefined;
		if (plan.platform !== "linux") {
			existingTarget = buildGjcTmuxExactSessionTarget(plan.attachSessionName, {
				env,
				platform: plan.platform,
				binary: { command: plan.tmuxCommand, isPsmux: plan.isPsmux, viaExplicitOverride: true },
			});
		} else {
			try {
				existingProof = proveGjcTmuxSessionMutationTarget(plan.attachSessionName, env);
				existingTarget = existingProof.nativeSessionId;
			} catch {
				cleanupCoordinatorSidecarBootstrap(plan);
				(context.diagnosticWriter ?? safeStderrWrite)(
					"tmux existing session proof failed; preserving session without mutation.\n",
				);
				return true;
			}
		}
		if (!plan.isPsmux)
			applyGjcTmuxRootTerminalTitleProfile({
				tmuxCommand: plan.tmuxCommand,
				target:
					plan.platform === "linux" && existingTarget.startsWith("$")
						? `${existingTarget}:`
						: buildGjcTmuxExactOptionTarget(plan.attachSessionName, {
								env,
								platform: plan.platform,
								binary: { command: plan.tmuxCommand, isPsmux: plan.isPsmux, viaExplicitOverride: true },
							}),
				sessionName: plan.attachSessionName,
				title: rootTerminalTitle,
				spawnSync,
				options: controlOptions,
			});
		if (plan.platform === "linux") {
			try {
				const proof = proveGjcTmuxSessionMutationTarget(plan.attachSessionName, env);
				if (
					!existingProof ||
					proof.nativeSessionId !== existingProof.nativeSessionId ||
					proof.serverPid !== existingProof.serverPid ||
					proof.serverStartTime !== existingProof.serverStartTime
				)
					throw new Error("tmux_session_identity_changed");
			} catch {
				cleanupCoordinatorSidecarBootstrap(plan);
				(context.diagnosticWriter ?? safeStderrWrite)(
					"tmux existing session proof failed; preserving session without mutation.\n",
				);
				return true;
			}
		}
		const attached = spawnSync(plan.tmuxCommand, ["attach-session", "-t", existingTarget], attachOptions);
		if (attached.exitCode === 0) {
			cleanupCoordinatorSidecarBootstrap(plan);
			return true;
		}
	}
	try {
		prepareManagedOwnerLifecycle(plan, context);
	} catch (error) {
		cleanupCoordinatorSidecarBootstrap(plan);
		(context.diagnosticWriter ?? safeStderrWrite)(`tmux owner lifecycle publication failed: ${String(error)}`);
		return true;
	}
	if (!plan.sessionId || !plan.sessionStateFile || !plan.ownerGeneration || !plan.tmuxCommand) {
		cleanupCoordinatorSidecarBootstrap(plan);
		(context.diagnosticWriter ?? safeStderrWrite)("tmux required ownership metadata was unavailable");
		return true;
	}
	try {
		writeCoordinatorSidecarBootstrapFile(plan, env);
	} catch (error) {
		cleanupCoordinatorSidecarBootstrap(plan);
		(context.diagnosticWriter ?? safeStderrWrite)(`tmux coordinator sidecar bootstrap failed: ${String(error)}`);
		return true;
	}
	const created = createIsolatedTmuxSession(
		plan,
		creationSpawn,
		newSessionOptions,
		context.diagnosticWriter ?? safeStderrWrite,
		ownerIsolationProbe,
	);
	if (created.exitCode === 0 && !plan.isPsmux && !plan.createdSessionId) {
		// Native tmux must atomically disclose its immutable `$N` identity. Do not
		// downgrade to the reusable session name or mutate the unidentified session.
		(context.diagnosticWriter ?? safeStderrWrite)(
			"gjc --tmux failed after creating tmux session: native session identity was unavailable; preserving session for recovery.\n",
		);
		cleanupCoordinatorSidecarBootstrap(plan);
		return true;
	}
	if (created.exitCode === 0) {
		// psmux on Windows can return before it registers its new session. Retry
		// only its documented missing-session registration race; other failed
		// proofs are preserved without cleanup or a second creation attempt.
		const probeResult = probeHasSession();
		if (probeResult.exitCode !== 0) {
			if (!isWindowsPsmuxMissingSessionRegistrationRace(plan, probeResult)) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("session registration probe failed", probeResult.stderr),
				);
				cleanupCoordinatorSidecarBootstrap(plan);
				return true;
			}
			try {
				writeCoordinatorSidecarBootstrapFile(plan, env);
			} catch (error) {
				cleanupCoordinatorSidecarBootstrap(plan);
				(context.diagnosticWriter ?? safeStderrWrite)(
					`tmux coordinator sidecar bootstrap retry failed: ${String(error)}`,
				);
				return true;
			}
			const retry = createIsolatedTmuxSession(
				plan,
				creationSpawn,
				newSessionOptions,
				context.diagnosticWriter ?? safeStderrWrite,
				ownerIsolationProbe,
			);
			const retryProbe = probeHasSession();
			if (retry.exitCode !== 0 || retryProbe.exitCode !== 0) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic(
						"new-session retry failed after missing session",
						failedRetryDiagnostic(retry, retryProbe),
					),
				);
				cleanupCreatedTmuxSessionAfterFailure(plan, spawnSync, options, ownerIsolationProbe);
				cleanupCoordinatorSidecarBootstrap(plan);
				return true;
			}
		}
		if (!isCreatedTmuxSessionIdentityStable(plan, spawnSync, controlOptions, ownerIsolationProbe)) {
			(context.diagnosticWriter ?? safeStderrWrite)(
				"tmux created session proof failed; preserving session without mutation.\n",
			);
			cleanupCoordinatorSidecarBootstrap(plan);
			return true;
		}
		renameTmuxWindow(plan.tmuxCommand, windowTitle, spawnSync, controlOptions, createdSessionExactTarget(plan, env));
		const profile = applyGjcTmuxProfile(buildProfileInputs());
		// If the @gjc-profile ownership write failed, the cause can be
		// either (a) a real psmux persistence-tag rejection (e.g.
		// unsupported option on this server), or (b) the same new-session
		// registration race above — psmux returned 0 but the server died
		// before registering, so the follow-up set-option failed with
		// "can't find session". Distinguish the two: re-probe; if the
		// session is genuinely missing, retry new-session and re-apply the
		// profile. Otherwise, surface the persistence-tag failure.
		const ownershipFailure = requiredProfileFailure(profile);
		emitOptionalProfileDiagnostics(profile, context.diagnosticWriter ?? safeStderrWrite);
		if (ownershipFailure) {
			const probeAfterOwnership = probeHasSession();
			if (
				!isWindowsPsmuxMissingSessionRegistrationRace(plan, ownershipFailure) ||
				!isWindowsPsmuxMissingSessionRegistrationRace(plan, probeAfterOwnership)
			) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("profile tagging failed", ownershipFailure.stderr),
				);
				cleanupCreatedTmuxSessionBeforePublicationFailure(plan, spawnSync, controlOptions, ownerIsolationProbe);
				cleanupCoordinatorSidecarBootstrap(plan);
				return true;
			}
			try {
				writeCoordinatorSidecarBootstrapFile(plan, env);
			} catch (error) {
				cleanupCoordinatorSidecarBootstrap(plan);
				(context.diagnosticWriter ?? safeStderrWrite)(
					`tmux coordinator sidecar bootstrap retry failed: ${String(error)}`,
				);
				return true;
			}
			const retry = createIsolatedTmuxSession(
				plan,
				creationSpawn,
				newSessionOptions,
				context.diagnosticWriter ?? safeStderrWrite,
				ownerIsolationProbe,
			);
			const retryProbe = probeHasSession();
			if (retry.exitCode !== 0 || retryProbe.exitCode !== 0) {
				cleanupCreatedTmuxSessionAfterFailure(plan, spawnSync, options, ownerIsolationProbe);
				cleanupCoordinatorSidecarBootstrap(plan);
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic(
						"new-session retry failed after ownership failure",
						failedRetryDiagnostic(retry, retryProbe),
					),
				);
				return true;
			}
			const retryProfile = applyGjcTmuxProfile(buildProfileInputs());
			const retryOwnershipFailure = requiredProfileFailure(retryProfile);
			emitOptionalProfileDiagnostics(retryProfile, context.diagnosticWriter ?? safeStderrWrite);
			if (retryOwnershipFailure) {
				cleanupCreatedTmuxSessionAfterFailure(plan, spawnSync, options, ownerIsolationProbe);
				cleanupCoordinatorSidecarBootstrap(plan);
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("profile tagging failed after retry", retryOwnershipFailure.stderr),
				);
				return true;
			}
			if (!hasExactRequiredPsmuxMetadata()) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					"tmux required ownership metadata readback failed; preserving session without publication.\n",
				);
				cleanupCreatedTmuxSessionBeforePublicationFailure(plan, spawnSync, controlOptions, ownerIsolationProbe);
				cleanupCoordinatorSidecarBootstrap(plan);
				return true;
			}
			// Recovery succeeded via retry — fall through to attach-session below.
		}
		ensureCreatedTmuxWindowTracksCallerTerminal(plan, spawnSync, controlOptions);
		applyGjcTmuxRootTerminalTitleProfile({
			tmuxCommand: plan.tmuxCommand,
			target: createdSessionOptionTarget(plan, env),
			sessionName: plan.sessionName,
			title: rootTerminalTitle,
			spawnSync,
			options: controlOptions,
		});
	}
	const probeWarning = detectCorruptedGjcWrapper();
	if (created.exitCode !== 0) {
		// The new-session spawn failed. Surface the captured stderr so the
		// user sees the actual psmux rejection (e.g. "cannot create session:
		// server is shutting down") instead of a silent exit. The wrapper
		// probe gives the user a deterministic hint when the silent-exit
		// symptom is actually caused by a corrupted gjc.cmd / gjc.bat on
		// PATH (a 194MB PE-binary at the wrapper path produces cmd.exe
		// hangs that look like a tmux/psmux failure from the user's seat).
		const stderr = created.stderr;
		const suffix = probeWarning ? ` Wrapper warning: ${probeWarning}` : "";
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("new-session failed", stderr) + suffix);
		cleanupCoordinatorSidecarBootstrap(plan);
		return true;
	}
	if (!hasExactRequiredPsmuxMetadata()) {
		(context.diagnosticWriter ?? safeStderrWrite)(
			"tmux required ownership metadata readback failed; preserving session without publication.\n",
		);
		cleanupCreatedTmuxSessionBeforePublicationFailure(plan, spawnSync, controlOptions, ownerIsolationProbe);
		cleanupCoordinatorSidecarBootstrap(plan);
		return true;
	}
	if (!isCreatedTmuxSessionIdentityStable(plan, spawnSync, controlOptions, ownerIsolationProbe)) {
		(context.diagnosticWriter ?? safeStderrWrite)(
			"tmux created session proof failed; preserving session without attach.\n",
		);
		cleanupCoordinatorSidecarBootstrap(plan);
		return true;
	}
	try {
		const stateDir = path.dirname(plan.sessionStateFile!);
		resolveManagedOwnerPredecessorSync(stateDir, plan.sessionId!, plan.ownerGenerationBaseline!);
		replaceOwnerGenerationSync(stateDir, plan.sessionId!, plan.ownerGeneration!, plan.ownerGenerationBaseline!);
		providerAuthorityPublished = true;
	} catch (error) {
		cleanupCreatedTmuxSessionBeforePublicationFailure(plan, spawnSync, controlOptions, ownerIsolationProbe);
		cleanupCoordinatorSidecarBootstrap(plan);
		(context.diagnosticWriter ?? safeStderrWrite)(`tmux owner lifecycle publication failed: ${String(error)}`);
		return true;
	}
	try {
		if (!isCreatedTmuxSessionIdentityStable(plan, spawnSync, controlOptions, ownerIsolationProbe)) {
			(context.diagnosticWriter ?? safeStderrWrite)(
				"tmux created session proof failed after lifecycle publication; preserving session without attach.\n",
			);
			cleanupCoordinatorSidecarBootstrap(plan);
			return true;
		}
		if (!hasExactRequiredPsmuxMetadata()) {
			(context.diagnosticWriter ?? safeStderrWrite)(
				"tmux required ownership metadata readback failed after lifecycle publication; preserving session without attach.\n",
			);
			cleanupCoordinatorSidecarBootstrap(plan);
			return true;
		}
		// attach-session needs PTY inherit for the user-facing attach; keep it unchanged.
		const attached = attachCreatedSession();
		if (attached.exitCode === 0) {
			cleanupCoordinatorSidecarBootstrap(plan);
			return true;
		}
		if (isTmuxAttachDisconnectError(attached)) {
			(context.diagnosticWriter ?? safeStderrWrite)(
				formatTmuxLaunchDiagnostic("attach disconnected", attached.stderr),
			);
			cleanupCoordinatorSidecarBootstrap(plan);
			return true;
		}
		if (isWindowsPsmuxAttachConnectionRefused(plan, attached)) {
			waitForWindowsPsmuxAttachRetry();
			const probeAfterAttach = probeHasSession();
			if (probeAfterAttach.exitCode === 0) {
				if (
					!isCreatedTmuxSessionIdentityStable(plan, spawnSync, controlOptions, ownerIsolationProbe) ||
					!hasExactRequiredPsmuxMetadata()
				) {
					(context.diagnosticWriter ?? safeStderrWrite)(
						"tmux created session proof failed after attach recovery probe; preserving session without attach.\n",
					);
					cleanupCoordinatorSidecarBootstrap(plan);
					return true;
				}
				const retryAttached = attachCreatedSession();
				if (retryAttached.exitCode === 0) {
					cleanupCoordinatorSidecarBootstrap(plan);
					return true;
				}
				if (isTmuxAttachDisconnectError(retryAttached)) {
					(context.diagnosticWriter ?? safeStderrWrite)(
						formatTmuxLaunchDiagnostic("attach disconnected", retryAttached.stderr),
					);
					cleanupCoordinatorSidecarBootstrap(plan);
					return true;
				}

				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("attach retry failed", retryAttached.stderr),
				);
				cleanupCoordinatorSidecarBootstrap(plan);
				return true;
			}
			if (!isWindowsPsmuxMissingSessionRegistrationRace(plan, probeAfterAttach)) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("attach recovery probe failed", probeAfterAttach.stderr),
				);
				cleanupCoordinatorSidecarBootstrap(plan);
				return true;
			}
			(context.diagnosticWriter ?? safeStderrWrite)(
				"tmux attach recovery found the published session missing; preserving lifecycle state without recreation.\n",
			);
			cleanupCoordinatorSidecarBootstrap(plan);
			return true;
		}
		// Closing an SSH/Windows Terminal tab can make `tmux attach-session`
		// exit with code 1 and no captured stderr while the tmux server correctly
		// keeps the just-created session alive. Preserve that live session so the
		// user can reattach instead of treating the parent client teardown as a
		// launch failure.
		const attachFailureStderr = attached.stderr?.trim() ?? "";
		if (attachFailureStderr.length === 0) {
			const probeAfterAttachFailure = probeHasSession();
			if (probeAfterAttachFailure.exitCode === 0) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("attach disconnected", attached.stderr),
				);
				cleanupCoordinatorSidecarBootstrap(plan);
				return true;
			}
		}
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("attach failed", attached.stderr));
		cleanupCoordinatorSidecarBootstrap(plan);
		return true;
	} catch (error) {
		(context.diagnosticWriter ?? safeStderrWrite)(
			formatTmuxLaunchDiagnostic(
				"post-publication verification or attach failed; preserving committed session",
				String(error),
			),
		);
		cleanupCoordinatorSidecarBootstrap(plan);
		return true;
	}
}
