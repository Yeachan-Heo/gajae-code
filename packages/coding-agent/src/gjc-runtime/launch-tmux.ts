import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION } from "@gajae-code/utils/dirs";
import { safeStderrWrite } from "@gajae-code/utils/safe-stderr";
import type { Args } from "../cli/args";
import { readLinuxProcStartTimeSync } from "./linux-proc";
import { tmuxRuntimeSessionPath } from "./session-layout";
import {
	GJC_COORDINATOR_SESSION_BRANCH_ENV,
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV,
	GJC_COORDINATOR_SESSION_READINESS_FILE_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
} from "./session-state-sidecar";
import {
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
	resolveGjcTmuxBinary,
	resolveGjcTmuxCommand,
} from "./tmux-common";
import {
	captureOwnerGenerationBaselineSync,
	classifyCgroup,
	executeTmuxOwnerIsolationPlanSync,
	isOwnerGenerationBaselineCurrentSync,
	lifecyclePaths,
	type OwnerIsolationProbeSync,
	planTmuxOwnerIsolationSync,
	replaceOwnerGenerationSync,
	type TmuxServerProof,
} from "./tmux-owner-isolation";
import {
	findGjcTmuxSessionByName,
	findGjcTmuxSessionByScope,
	type GjcTmuxSessionStatus,
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
	/** Generation state captured before owner-isolation planning; required for publication CAS. */
	ownerGenerationBaseline?: import("./tmux-owner-isolation").OwnerGenerationBaseline;
	/** Native tmux session identity emitted atomically by `new-session -P -F`. */
	createdSessionId?: string;
	/** Safe server identity proven immediately after creation. */
	createdServerIdentity?: { pid: number; startTime: string };
	isPsmux: boolean;
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
type WindowsPsmuxCompatibilityState = "fresh" | "continuation" | "managed";

function windowsPsmuxCompatibilityState(plan: TmuxLaunchPlan, env: NodeJS.ProcessEnv): WindowsPsmuxCompatibilityState {
	const marker = (value: string | undefined): boolean => Boolean(value?.trim());
	if (
		marker(env.GJC_SESSION_ID) ||
		marker(env[GJC_COORDINATOR_SESSION_ID_ENV]) ||
		marker(env[GJC_COORDINATOR_SESSION_BRANCH_ENV]) ||
		marker(env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV]) ||
		marker(env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV]) ||
		marker(env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]) ||
		marker(env[GJC_TMUX_ACTIVE_SESSION_ENV]) ||
		marker(env[GJC_TMUX_OWNER_GENERATION_ENV]) ||
		marker(env[GJC_TMUX_OWNER_STATE_DIR_ENV]) ||
		marker(env[GJC_TMUX_OWNER_SERVER_KEY_ENV]) ||
		Object.entries(env).some(([key, value]) => key.startsWith("GJC_TEAM_") && marker(value))
	)
		return "managed";
	return plan.attachSessionName ? "continuation" : "fresh";
}

type PsmuxSessionInventory =
	| { kind: "available"; names: ReadonlySet<string> }
	| { kind: "no-server" }
	| { kind: "unverifiable"; result: TmuxSpawnResult };

function classifyPsmuxSessionInventory(result: TmuxSpawnResult): PsmuxSessionInventory {
	if (result.exitCode === 0) {
		const names = new Set(
			(result.stdout ?? "")
				.split(/\r?\n/)
				.map(name => name.trim())
				.filter(Boolean),
		);
		return { kind: "available", names };
	}
	const stderr = result.stderr?.trim() ?? "";
	if (/\bno server running\b/i.test(stderr)) return { kind: "no-server" };
	return { kind: "unverifiable", result };
}

function launchWindowsPsmuxCompatibilitySession(
	plan: TmuxLaunchPlan,
	env: NodeJS.ProcessEnv,
	spawnSync: TmuxSpawnSync,
	diagnostic: (message: string) => void,
): boolean {
	const options: TmuxSpawnOptions = {
		cwd: plan.cwd,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		captureStderr: true,
	};
	const attachOptions: TmuxSpawnOptions = { ...options, stdin: "inherit", stdout: "inherit", stderr: "inherit" };
	const state = windowsPsmuxCompatibilityState(plan, env);
	if (state === "managed") {
		diagnostic("psmux cannot provide immutable owner identity; refusing managed session creation.\n");
		throw new Error("gjc_tmux_owner_isolation_native_session_identity_unavailable");
	}

	const targetName = plan.attachSessionName ?? plan.sessionName;
	const inventory = (): PsmuxSessionInventory =>
		classifyPsmuxSessionInventory(spawnSync(plan.tmuxCommand, ["list-sessions", "-F", "#{session_name}"], options));

	if (state === "continuation") {
		const existing = inventory();
		const detail = existing.kind === "unverifiable" ? existing.result.stderr : undefined;
		diagnostic(
			formatTmuxLaunchDiagnostic(
				existing.kind === "available" && existing.names.has(targetName)
					? "existing psmux session is name-only and cannot be attached safely"
					: "existing session target not found",
				detail,
			),
		);
		return true;
	}

	const before = inventory();
	if (before.kind === "unverifiable") {
		diagnostic(formatTmuxLaunchDiagnostic("fresh session inventory failed", before.result.stderr));
		return true;
	}
	if (before.kind === "available" && before.names.has(targetName)) {
		diagnostic("tmux fresh session target already exists; preserving session without mutation.\n");
		return true;
	}
	const detachedIndex = plan.newSessionArgs.indexOf("-d");
	const foregroundArgs =
		detachedIndex < 0
			? plan.newSessionArgs
			: [...plan.newSessionArgs.slice(0, detachedIndex), ...plan.newSessionArgs.slice(detachedIndex + 1)];
	const created = spawnSync(plan.tmuxCommand, foregroundArgs, attachOptions);
	if (created.exitCode !== 0) {
		const wrapperWarning = detectCorruptedGjcWrapper();
		const suffix = wrapperWarning ? ` Wrapper warning: ${wrapperWarning}` : "";
		diagnostic(formatTmuxLaunchDiagnostic("foreground new-session failed", created.stderr) + suffix);
	}
	return true;
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
	tmuxExitMarkerPath?: string;
	platform?: NodeJS.Platform;
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
	// caller — gjc --tmux planning, gjc session create, gjc team bootstrap —
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
function pathModuleForPlatform(platform: NodeJS.Platform | undefined): typeof path.win32 | typeof path {
	return isWindowsPlatform(platform) ? path.win32 : path;
}

function buildInnerCommand(context: CommandResolutionContext, rawArgs: string[]): string {
	if (isWindowsPlatform(context.platform))
		return buildWindowsPowerShellInnerCommand({
			command: resolveCurrentGjcCommand(context),
			args: stripRootTmuxFlag(rawArgs),
			environment: context.extraEnv,
			tmuxExitMarkerPath: context.tmuxExitMarkerPath,
		});
	const command = resolveCurrentGjcCommand(context);
	const quoted = [...command, ...stripRootTmuxFlag(rawArgs)].map(shellQuote).join(" ");
	const invocation = `env ${GJC_TMUX_LAUNCHED_ENV}=1${buildEnvAssignments(context.extraEnv)} ${quoted}`;
	if (!context.tmuxExitMarkerPath) return `exec ${invocation}`;
	return `${buildPosixTmuxExitMarkerPrefix(context.tmuxExitMarkerPath)}; ${invocation}; exit $?`;
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
	return !parsed.noTitle && !env.PI_NO_TITLE;
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

	const cwd = context.cwd ?? process.cwd();
	const branch = context.worktreeBranch ?? context.currentBranch ?? readCurrentBranch(cwd);
	const title = buildGjcTmuxWindowTitle(context.project ?? cwd, branch);
	const spawnSync = context.spawnSync ?? defaultSpawnSync;
	renameTmuxWindow(tmuxCommand, title, spawnSync, {
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

function createdSessionTarget(plan: TmuxLaunchPlan): string {
	return plan.createdSessionId ?? plan.sessionName;
}

function createdSessionExactTarget(plan: TmuxLaunchPlan, env: NodeJS.ProcessEnv): string {
	return plan.createdSessionId ?? buildGjcTmuxExactSessionTarget(plan.sessionName, { env });
}

function createdSessionOptionTarget(plan: TmuxLaunchPlan, env: NodeJS.ProcessEnv): string {
	// Native tmux assigns `$N` atomically during creation. Keep that immutable
	// identity (with its required empty-window suffix) for every later option
	// mutation; a reusable session name could resolve to a different session.
	if (plan.createdSessionId) return `${plan.createdSessionId}:`;
	return buildGjcTmuxExactOptionTarget(plan.sessionName, { env });
}

function cleanupCreatedTmuxSession(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	probe: OwnerIsolationProbeSync,
): void {
	if (!isCreatedTmuxSessionIdentityStable(plan, spawnSync, options, probe))
		throw new Error("gjc_tmux_exact_cleanup_uncertain");
	const nativeSessionId = plan.createdSessionId!;
	const expectedPid = plan.createdServerIdentity!.pid;
	const guarded = spawnSync(
		plan.tmuxCommand,
		[
			"if-shell",
			"-t",
			nativeSessionId,
			"-F",
			`#{&&:#{==:#{pid},${expectedPid}},#{&&:#{==:#{session_id},${nativeSessionId}},#{==:#{session_name},${plan.sessionName}}}}`,
			`kill-session -t ${nativeSessionId} \\; display-message -p __gjc_tmux_guarded_cleanup_ok__`,
			"display-message -p __gjc_tmux_guarded_cleanup_refused__",
		],
		options,
	);
	if (guarded.exitCode !== 0 || guarded.stdout?.trim() !== "__gjc_tmux_guarded_cleanup_ok__")
		throw new Error("gjc_tmux_exact_cleanup_uncertain");
}

function cleanupCreatedTmuxSessionAfterFailure(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	probe: OwnerIsolationProbeSync,
	primary: Error,
): void {
	try {
		cleanupCreatedTmuxSession(plan, spawnSync, options, probe);
	} catch (cleanupError) {
		throw new AggregateError([primary, cleanupError], "gjc_tmux_exact_cleanup_uncertain");
	}
}

function isCreatedTmuxSessionIdentityStable(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	probe: OwnerIsolationProbeSync,
): boolean {
	if (plan.isPsmux || !plan.createdSessionId || !plan.createdServerIdentity) return false;
	try {
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
	return result.stderr?.trim() === `psmux: can't find session '=${plan.sessionName}' (no server running)`;
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
	const result = Bun.spawnSync([tmuxCommand, "show-options", "-gqv", "status"], {
		cwd,
		env,
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
	const tmuxAvailable = context.tmuxAvailable ?? Bun.which(tmuxCommand) !== null;
	if (!tmuxAvailable) {
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxUnavailableDiagnostic(platform));
		return undefined;
	}
	const existingSessionName = allowsExistingTmuxAttach(context.parsed, env)
		? "existingBranchSessionName" in context
			? (context.existingBranchSessionName ?? undefined)
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
				[GJC_COORDINATOR_SESSION_ID_ENV]: sessionId,
				[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: sessionStateFile,
				// Carry the GJC-managed session name into the child so `gjc team`
				// can target the correct leader session by name. Under psmux on
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
		attachSessionName: existingSessionName,
	};
}

function prepareManagedOwnerLifecycle(plan: TmuxLaunchPlan, context: TmuxLaunchContext): void {
	if (plan.ownerGeneration) return;
	const sessionId = plan.sessionId ?? plan.sessionName;
	const stateDir = path.dirname(plan.sessionStateFile ?? path.join(plan.cwd, ".gjc", "runtime"));
	const generation = crypto.randomUUID();
	// Stage the generation in the child command. It becomes current only after
	// immutable creation proof and ownership tagging complete.

	plan.ownerGeneration = generation;
	const innerCommand = buildInnerCommand(
		{
			cwd: plan.cwd,
			argv: context.argv ?? process.argv,
			execPath: context.execPath ?? process.execPath,
			extraEnv: {
				[GJC_COORDINATOR_SESSION_ID_ENV]: sessionId,
				[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: plan.sessionStateFile ?? "",
				[GJC_TMUX_ACTIVE_SESSION_ENV]: plan.sessionName,
				[GJC_TMUX_OWNER_GENERATION_ENV]: generation,
				[GJC_TMUX_OWNER_STATE_DIR_ENV]: stateDir,
				[GJC_TMUX_OWNER_SERVER_KEY_ENV]: plan.tmuxCommand,
			},
			// Linux managed owner close signals the pane PID. Do not place the exit-marker shell
			// in front of it; `buildInnerCommand` therefore execs the GJC owner directly.
			tmuxExitMarkerPath: plan.platform === "linux" ? undefined : tmuxExitMarkerPath(plan.sessionStateFile ?? ""),
			platform: plan.platform,
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
			return { state: "safe", pid: 1, startTime: "not-applicable", cgroup: { classification: "not_applicable" } };
		}
		const probe = spawn(plan.tmuxCommand, ["display-message", "-p", "#{pid}"], {
			cwd: plan.cwd,
			env,
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
	const baseline = captureOwnerGenerationBaselineSync(stateDir, sessionId);
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
			plan.createdServerIdentity = { pid: server.pid!, startTime: server.startTime! };
			cleanupCreatedTmuxSessionAfterFailure(plan, spawn, options, probe, new Error("owner_generation_stale"));
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
	plan.createdServerIdentity = { pid: outcome.server_pid, startTime: outcome.server_start_time };
	return executed ?? { exitCode: 1, stderr: "tmux owner isolation did not execute" };
}

function requiredProfileFailure(profile: GjcTmuxProfileResult): GjcTmuxProfileResult["failures"][number] | undefined {
	const requiredOptions = new Set([
		"@gjc-profile",
		"@gjc-session-id",
		"@gjc-session-state-file",
		"@gjc-owner-generation",
		"@gjc-owner-server-key",
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
	if (plan?.isPsmux && plan.platform === "win32" && !env.TMUX)
		return launchWindowsPsmuxCompatibilitySession(
			plan,
			env,
			context.spawnSync ?? defaultSpawnSync,
			context.diagnosticWriter ?? safeStderrWrite,
		);
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
	const options: TmuxSpawnOptions = {
		cwd: plan.cwd,
		env,

		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	};
	const ownerIsolationProbe =
		context.ownerIsolationProbe ?? defaultOwnerIsolationProbe(plan, env, rawSpawnSync, context.callerCgroupReader);
	const spawnSync = rawSpawnSync;
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
		target: createdSessionTarget(plan),
		cwd: plan.cwd,
		env,
		spawnSync,
		branch: plan.branch,
		project: plan.project,
		sessionId: plan.sessionId ?? null,
		sessionStateFile: plan.sessionStateFile ?? null,
		ownerGeneration: plan.ownerGeneration ?? null,
		ownerServerKey: plan.tmuxCommand,
		version: VERSION,
	});
	const probeHasSession = (): TmuxSpawnResult =>
		spawnSync(plan.tmuxCommand, ["has-session", "-t", createdSessionExactTarget(plan, env)], probeOptions);
	const attachCreatedSession = (): TmuxSpawnResult =>
		spawnSync(plan.tmuxCommand, ["attach-session", "-t", createdSessionExactTarget(plan, env)], attachOptions);

	if (plan.attachSessionName) {
		let existingTarget: string;
		let existingProof: ReturnType<typeof proveGjcTmuxSessionMutationTarget> | undefined;
		if (plan.platform !== "linux") {
			existingTarget = buildGjcTmuxExactSessionTarget(plan.attachSessionName, { env });
		} else {
			try {
				existingProof = proveGjcTmuxSessionMutationTarget(plan.attachSessionName, env);
				existingTarget = existingProof.nativeSessionId;
			} catch {
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
						: buildGjcTmuxExactOptionTarget(plan.attachSessionName, { env }),
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
				(context.diagnosticWriter ?? safeStderrWrite)(
					"tmux existing session proof failed; preserving session without mutation.\n",
				);
				return true;
			}
		}
		const attached = spawnSync(plan.tmuxCommand, ["attach-session", "-t", existingTarget], attachOptions);
		if (attached.exitCode === 0) return true;
	}
	try {
		prepareManagedOwnerLifecycle(plan, context);
	} catch (error) {
		(context.diagnosticWriter ?? safeStderrWrite)(`tmux owner lifecycle publication failed: ${String(error)}`);
		return true;
	}
	if (!plan.sessionId || !plan.sessionStateFile || !plan.ownerGeneration || !plan.tmuxCommand) {
		(context.diagnosticWriter ?? safeStderrWrite)("tmux required ownership metadata was unavailable");
		return true;
	}
	const created = createIsolatedTmuxSession(
		plan,
		rawSpawnSync,
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
				return true;
			}
			const retry = createIsolatedTmuxSession(
				plan,
				rawSpawnSync,
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
				cleanupCreatedTmuxSessionAfterFailure(
					plan,
					spawnSync,
					options,
					ownerIsolationProbe,
					new Error("new-session retry failed after missing session"),
				);

				return true;
			}
		}
		if (!isCreatedTmuxSessionIdentityStable(plan, spawnSync, controlOptions, ownerIsolationProbe)) {
			(context.diagnosticWriter ?? safeStderrWrite)(
				"tmux created session proof failed; preserving session without mutation.\n",
			);
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
				return true;
			}
			const retry = createIsolatedTmuxSession(
				plan,
				rawSpawnSync,
				newSessionOptions,
				context.diagnosticWriter ?? safeStderrWrite,
				ownerIsolationProbe,
			);
			const retryProbe = probeHasSession();
			if (retry.exitCode !== 0 || retryProbe.exitCode !== 0) {
				cleanupCreatedTmuxSessionAfterFailure(
					plan,
					spawnSync,
					options,
					ownerIsolationProbe,
					new Error("new-session retry failed after ownership failure"),
				);

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
				cleanupCreatedTmuxSessionAfterFailure(
					plan,
					spawnSync,
					options,
					ownerIsolationProbe,
					new Error("profile tagging failed after retry"),
				);

				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("profile tagging failed after retry", retryOwnershipFailure.stderr),
				);
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
		return true;
	}
	if (!isCreatedTmuxSessionIdentityStable(plan, spawnSync, controlOptions, ownerIsolationProbe)) {
		(context.diagnosticWriter ?? safeStderrWrite)(
			"tmux created session proof failed; preserving session without attach.\n",
		);
		return true;
	}
	try {
		replaceOwnerGenerationSync(
			path.dirname(plan.sessionStateFile!),
			plan.sessionId!,
			plan.ownerGeneration!,
			plan.ownerGenerationBaseline!,
		);
	} catch (error) {
		const publicationError = error instanceof Error ? error : new Error(String(error));
		cleanupCreatedTmuxSessionAfterFailure(plan, spawnSync, options, ownerIsolationProbe, publicationError);
		(context.diagnosticWriter ?? safeStderrWrite)(`tmux owner lifecycle publication failed: ${String(error)}`);
		return true;
	}
	if (!isCreatedTmuxSessionIdentityStable(plan, spawnSync, controlOptions, ownerIsolationProbe)) {
		(context.diagnosticWriter ?? safeStderrWrite)(
			"tmux created session proof failed after lifecycle publication; preserving session without attach.\n",
		);
		return true;
	}
	// attach-session needs PTY inherit for the user-facing attach; keep it unchanged.
	const attached = attachCreatedSession();
	if (attached.exitCode === 0) return true;
	if (isTmuxAttachDisconnectError(attached)) {
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("attach disconnected", attached.stderr));
		return true;
	}
	if (isWindowsPsmuxAttachConnectionRefused(plan, attached)) {
		waitForWindowsPsmuxAttachRetry();
		const probeAfterAttach = probeHasSession();
		if (probeAfterAttach.exitCode === 0) {
			const retryAttached = attachCreatedSession();
			if (retryAttached.exitCode === 0) return true;
			if (isTmuxAttachDisconnectError(retryAttached)) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("attach disconnected", retryAttached.stderr),
				);
				return true;
			}
			cleanupCreatedTmuxSessionAfterFailure(
				plan,
				spawnSync,
				options,
				ownerIsolationProbe,
				new Error("attach retry failed"),
			);

			(context.diagnosticWriter ?? safeStderrWrite)(
				formatTmuxLaunchDiagnostic("attach retry failed", retryAttached.stderr),
			);
			return true;
		} else {
			if (!isWindowsPsmuxMissingSessionRegistrationRace(plan, probeAfterAttach)) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("attach recovery probe failed", probeAfterAttach.stderr),
				);
				return true;
			}
			const retry = createIsolatedTmuxSession(
				plan,
				rawSpawnSync,
				newSessionOptions,
				context.diagnosticWriter ?? safeStderrWrite,
				ownerIsolationProbe,
			);
			const retryProbe = probeHasSession();
			if (retry.exitCode === 0 && retryProbe.exitCode === 0) {
				renameTmuxWindow(
					plan.tmuxCommand,
					windowTitle,
					spawnSync,
					controlOptions,
					createdSessionExactTarget(plan, env),
				);
				const retryProfile = applyGjcTmuxProfile(buildProfileInputs());
				const retryOwnershipFailure = requiredProfileFailure(retryProfile);
				emitOptionalProfileDiagnostics(retryProfile, context.diagnosticWriter ?? safeStderrWrite);
				if (retryOwnershipFailure) {
					cleanupCreatedTmuxSessionAfterFailure(
						plan,
						spawnSync,
						options,
						ownerIsolationProbe,
						new Error("profile tagging failed after retry"),
					);

					(context.diagnosticWriter ?? safeStderrWrite)(
						formatTmuxLaunchDiagnostic("profile tagging failed after retry", retryOwnershipFailure.stderr),
					);
					return true;
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
				const retryAttached = attachCreatedSession();
				if (retryAttached.exitCode === 0) return true;
				if (isTmuxAttachDisconnectError(retryAttached)) {
					(context.diagnosticWriter ?? safeStderrWrite)(
						formatTmuxLaunchDiagnostic("attach disconnected", retryAttached.stderr),
					);
					return true;
				}
				cleanupCreatedTmuxSessionAfterFailure(
					plan,
					spawnSync,
					options,
					ownerIsolationProbe,
					new Error("attach failed after recovery"),
				);

				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("attach failed after recovery", retryAttached.stderr),
				);
				return true;
			}
			cleanupCreatedTmuxSessionAfterFailure(
				plan,
				spawnSync,
				options,
				ownerIsolationProbe,
				new Error("attach recovery recreate failed"),
			);

			const recoveryFailure = retry.exitCode !== 0 ? retry.stderr : retryProbe.stderr;
			(context.diagnosticWriter ?? safeStderrWrite)(
				formatTmuxLaunchDiagnostic("attach recovery recreate failed", recoveryFailure),
			);
			return true;
		}
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
			return true;
		}
	}
	cleanupCreatedTmuxSessionAfterFailure(plan, spawnSync, options, ownerIsolationProbe, new Error("attach failed"));
	(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("attach failed", attached.stderr));
	return true;
}
