import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION } from "@gajae-code/utils/dirs";
import { safeStderrWrite } from "@gajae-code/utils/safe-stderr";
import type { Args } from "../cli/args";
import { tmuxRuntimeSessionPath } from "./session-layout";
import { GJC_COORDINATOR_SESSION_ID_ENV, GJC_COORDINATOR_SESSION_STATE_FILE_ENV } from "./session-state-sidecar";
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
import { findGjcTmuxSessionByName, findGjcTmuxSessionByScope, type GjcTmuxSessionStatus } from "./tmux-sessions";

export {
	buildGjcTmuxExactSessionTarget,
	buildGjcTmuxProfileCommands,
	GJC_DEFAULT_TMUX_SESSION,
	GJC_TMUX_COMMAND_ENV,
	GJC_TMUX_MOUSE_ENV,
	GJC_TMUX_PROFILE_ENV,
	GJC_TMUX_SESSION_PREFIX,
};

export const GJC_TMUX_LAUNCHED_ENV = "GJC_TMUX_LAUNCHED";
export const GJC_LAUNCH_POLICY_ENV = "GJC_LAUNCH_POLICY";
export const GJC_TMUX_WINDOW_LABEL_MAX_WIDTH = 48;
export const GJC_PSMUX_PROFILE_FORCE_ENV = "GJC_PSMUX_PROFILE_FORCE";
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
}

export interface TmuxSpawnResult {
	exitCode: number | null;
	signalCode?: string | null;
	stderr?: string;
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
	 * When true, the spawn captures stderr into a buffer and forwards it to
	 * the parent stderr so the user still sees the live output. The captured
	 * text is also returned in TmuxSpawnResult.stderr for diagnostic
	 * surfacing in "attach failed" / "profile tagging failed" messages.
	 * Defaults to false to preserve the previous PTY-binding behavior for
	 * attach-session and other interactive commands.
	 */
	captureStderr?: boolean;
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
	version?: string | null;
}

interface CommandResolutionContext {
	cwd: string;
	argv: string[];
	execPath: string;
	extraEnv?: Record<string, string>;
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
	return value?.startsWith("/$bunfs/") === true;
}

function formatTmuxLaunchDiagnostic(stage: string, stderr?: string): string {
	const detail = stderr?.trim();
	const suffix = detail ? ` ${detail.slice(0, 240)}` : "";
	return `gjc --tmux failed after creating tmux session: ${stage}.${suffix}\n`;
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
function formatTmuxUnavailableDiagnostic(platform: NodeJS.Platform, tmuxCommand: string): string {
	if (platform === "win32") {
		return (
			`gjc --tmux requested but no tmux executable was found; starting without a tmux-backed session. ` +
			`GJC searched for psmux, pmux, and tmux on PATH (got \`${tmuxCommand}\`). ` +
			"Install psmux (https://github.com/psmux/psmux) for native Windows tmux support, or use WSL with real tmux. " +
			"You can also point GJC at a specific binary via GJC_TMUX_COMMAND.\n"
		);
	}
	return `gjc --tmux requested but no ${tmuxCommand} executable was found; starting without a tmux-backed session.\n`;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildEnvAssignments(values: Record<string, string> | undefined): string {
	const entries = Object.entries(values ?? {});
	return entries.length === 0 ? "" : ` ${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")}`;
}
function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
function stripRootTmuxFlag(rawArgs: string[]): string[] {
	return rawArgs.filter(arg => arg !== "--tmux");
}

function buildWindowsPowerShellInnerCommand(context: CommandResolutionContext, rawArgs: string[]): string {
	const command = resolveCurrentGjcCommand(context);
	const envLines = Object.entries({ [GJC_TMUX_LAUNCHED_ENV]: "1", ...(context.extraEnv ?? {}) }).map(
		([key, value]) => `$env:${key} = ${powershellQuote(value)}`,
	);
	// Resolve the inner command and arguments. PowerShell's `&` call operator
	// accepts a single command followed by its arguments directly (no script
	// block needed). Wrapping the call in `& { ... }` would be invalid because
	// adjacent single-quoted tokens inside a script block body are a parser
	// error: `& { 'a' 'b' }` fails with "Unexpected token 'b'" because PowerShell
	// only concatenates adjacent *double-quoted* strings, and even then only in
	// expression position. Emitting the arguments as a comma-separated array
	// (`& 'cmd' @('a','b')`) is also rejected because arrays are not valid as
	// the second-and-later positional arguments to `&` in command position. The
	// correct form is `& 'cmd' 'arg1' 'arg2'` — exactly what the joined
	// resolvedCommand + innerArgs produces below.
	const resolvedCommand = command.map(powershellQuote).join(" ");
	const innerArgs = stripRootTmuxFlag(rawArgs).map(powershellQuote).join(" ");
	const invocation = `& ${resolvedCommand} ${innerArgs}`;
	const exitLine = "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }";
	const script = [...envLines, invocation, exitLine].join("\n");
	// Encode the script as UTF-16LE base64 for pwsh -EncodedCommand. Do NOT
	// prepend a UTF-16LE BOM (0xFF 0xFE): the BOM survives the decode and is
	// inserted as a literal U+FEFF character in front of the first script
	// token, which pwsh then reports as a "term not recognized" parse error
	// (e.g. "﻿$env:GJC_TMUX_LAUNCHED"). pwsh expects the decoded buffer to
	// start with the first character of the script, not with a BOM.
	const body = Buffer.from(script, "utf16le");
	const encodedCommand = body.toString("base64");
	return `pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
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
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
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
	const entrypoint = context.argv[1];
	if (!entrypoint) return ["gjc"];
	if (isBunVirtualPath(entrypoint)) {
		return isBunVirtualPath(context.execPath) ? ["gjc"] : [context.execPath];
	}
	const pathModule = pathModuleForPlatform(context.platform);
	const resolvedEntrypoint = pathModule.isAbsolute(entrypoint)
		? entrypoint
		: pathModule.resolve(context.cwd, entrypoint);
	if (entrypoint.endsWith(".ts") || entrypoint.endsWith(".js") || entrypoint.endsWith(".mjs")) {
		return [context.execPath, resolvedEntrypoint];
	}
	return [resolvedEntrypoint];
}
function isWindowsPlatform(platform: NodeJS.Platform | undefined): boolean {
	return platform === "win32";
}
function pathModuleForPlatform(platform: NodeJS.Platform | undefined): typeof path.win32 | typeof path {
	return isWindowsPlatform(platform) ? path.win32 : path;
}

function buildInnerCommand(context: CommandResolutionContext, rawArgs: string[]): string {
	if (isWindowsPlatform(context.platform)) return buildWindowsPowerShellInnerCommand(context, rawArgs);
	const command = resolveCurrentGjcCommand(context);
	const quoted = [...command, ...stripRootTmuxFlag(rawArgs)].map(shellQuote).join(" ");
	return `exec env ${GJC_TMUX_LAUNCHED_ENV}=1${buildEnvAssignments(context.extraEnv)} ${quoted}`;
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

function escapeTmuxFormatLiteral(value: string): string {
	return value.replace(/#/g, "##");
}

function buildGjcTmuxRootTerminalTitleCommands(target: string, title: string): GjcTmuxProfileCommand[] {
	const sanitized = escapeTmuxFormatLiteral(sanitizeGjcTmuxRootTerminalTitle(title));
	return [
		{ description: "enable tmux client terminal title", args: ["set-option", "-t", target, "set-titles", "on"] },
		{
			description: "set tmux client terminal title",
			args: ["set-option", "-t", target, "set-titles-string", sanitized],
		},
	];
}

function applyGjcTmuxRootTerminalTitleProfile(context: {
	tmuxCommand: string;
	target: string;
	title: string | undefined;
	spawnSync: TmuxSpawnSync;
	options: TmuxSpawnOptions;
}): void {
	if (!context.title) return;
	for (const command of buildGjcTmuxRootTerminalTitleCommands(
		buildGjcTmuxExactOptionTarget(context.target, { env: context.options.env }),
		context.title,
	)) {
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
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
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

function cleanupCreatedTmuxSession(plan: TmuxLaunchPlan, spawnSync: TmuxSpawnSync, options: TmuxSpawnOptions): void {
	spawnSync(
		plan.tmuxCommand,
		["kill-session", "-t", buildGjcTmuxExactSessionTarget(plan.sessionName, { env: options.env })],
		options,
	);
}
function isTmuxAttachDisconnectError(result: TmuxSpawnResult): boolean {
	if (result.signalCode === "SIGHUP") return true;
	const stderr = result.stderr?.toLowerCase() ?? "";
	return stderr.includes("eio") || stderr.includes("input/output error");
}
function isWindowsPsmuxAttachConnectionRefused(plan: TmuxLaunchPlan, result: TmuxSpawnResult): boolean {
	if (plan.platform !== "win32" || !plan.isPsmux) return false;
	return result.stderr?.toLowerCase().includes("os error 10061") === true;
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
	const target = buildGjcTmuxExactOptionTarget(plan.sessionName, { env: options.env });
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
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxUnavailableDiagnostic(platform, tmuxCommand));
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

function defaultSpawnSync(command: string, args: string[], options: TmuxSpawnOptions): TmuxSpawnResult {
	// When captureStderr is set on the options, route stderr through a
	// pipe so we can both forward it to the parent stderr (so the user
	// still sees the live output) and retain it in TmuxSpawnResult.stderr
	// for diagnostic surfacing. PTY-bound commands (attach-session) keep
	// stderr: "inherit" because psmux needs a real terminal handle.
	const stdio = options.captureStderr
		? { stdin: options.stdin, stdout: options.stdout, stderr: "pipe" as const }
		: { stdin: options.stdin, stdout: options.stdout, stderr: options.stderr };
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		cwd: options.cwd,
		env: options.env,
		...stdio,
	});
	let stderrText: string | undefined;
	if (options.captureStderr) {
		const stderrBytes = result.stderr;
		stderrText = stderrBytes ? new TextDecoder().decode(stderrBytes) : "";
		if (stderrText.length > 0) {
			try {
				process.stderr.write(stderrText);
			} catch {
				// parent stderr already closed during shutdown; ignore.
			}
		}
	}
	return { exitCode: result.exitCode, signalCode: result.signalCode, stderr: stderrText };
}

export function launchDefaultTmuxIfNeeded(context: TmuxLaunchContext): boolean {
	renameExistingTmuxWindowIfNeeded(context);

	const plan = buildDefaultTmuxLaunchPlan(context);
	if (!plan) return false;
	const env = context.env ?? process.env;
	const spawnSync = context.spawnSync ?? defaultSpawnSync;
	const options: TmuxSpawnOptions = {
		cwd: plan.cwd,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	};
	const attachOptions: TmuxSpawnOptions = { ...options };
	const controlOptions: TmuxSpawnOptions = { ...options, captureStderr: true };
	// has-session / new-session retry / profile-tagging probe share these
	// pipe-stdio options. PTY-bound commands (attach-session, rename-window,
	// set-option in applyGjcTmuxProfile when we explicitly need the live TTY)
	// use `options` or `attachOptions` instead.
	const probeOptions: TmuxSpawnOptions = {
		...options,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		captureStderr: true,
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
		target: plan.sessionName,
		cwd: plan.cwd,
		env,
		spawnSync,
		branch: plan.branch,
		project: plan.project,
		sessionId: plan.sessionId ?? null,
		sessionStateFile: plan.sessionStateFile ?? null,
		version: VERSION,
	});
	const probeHasSession = (): TmuxSpawnResult =>
		spawnSync(
			plan.tmuxCommand,
			["has-session", "-t", buildGjcTmuxExactSessionTarget(plan.sessionName, { env })],
			probeOptions,
		);
	const attachCreatedSession = (): TmuxSpawnResult =>
		spawnSync(
			plan.tmuxCommand,
			["attach-session", "-t", buildGjcTmuxExactSessionTarget(plan.sessionName, { env })],
			attachOptions,
		);

	if (plan.attachSessionName) {
		applyGjcTmuxRootTerminalTitleProfile({
			tmuxCommand: plan.tmuxCommand,
			target: plan.attachSessionName,
			title: rootTerminalTitle,
			spawnSync,
			options,
		});
		const attached = spawnSync(
			plan.tmuxCommand,
			["attach-session", "-t", buildGjcTmuxExactSessionTarget(plan.attachSessionName, { env })],
			attachOptions,
		);
		if (attached.exitCode === 0) return true;
	}
	const created = spawnSync(plan.tmuxCommand, plan.newSessionArgs, newSessionOptions);
	if (created.exitCode === 0) {
		// On Windows + psmux 3.3.0/3.3.6, new-session can return exit 0
		// before the psmux server finishes registering the session on its
		// control socket. The follow-up set-option / attach-session then
		// fails with "can't find session / no server running". Probe the
		// server first, and if the race fired, retry new-session before
		// we hand the session to rename-window / applyGjcTmuxProfile so the
		// profile-tagging path always sees a registered session.
		const probeResult = probeHasSession();
		if (probeResult.exitCode !== 0) {
			const retry = spawnSync(plan.tmuxCommand, plan.newSessionArgs, newSessionOptions);
			const retryProbe = probeHasSession();
			if (retry.exitCode !== 0 || retryProbe.exitCode !== 0) {
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic(
						"new-session retry failed after missing session",
						retry.stderr ?? retryProbe.stderr ?? created.stderr,
					),
				);
				cleanupCreatedTmuxSession(plan, spawnSync, options);
				return false;
			}
		}
		renameTmuxWindow(
			plan.tmuxCommand,
			windowTitle,
			spawnSync,
			controlOptions,
			buildGjcTmuxExactSessionTarget(plan.sessionName, { env }),
		);
		const profile = applyGjcTmuxProfile(buildProfileInputs());
		// If the @gjc-profile ownership write failed, the cause can be
		// either (a) a real psmux persistence-tag rejection (e.g.
		// unsupported option on this server), or (b) the same new-session
		// registration race above — psmux returned 0 but the server died
		// before registering, so the follow-up set-option failed with
		// "can't find session". Distinguish the two: re-probe; if the
		// session is genuinely missing, retry new-session and re-apply the
		// profile. Otherwise, surface the persistence-tag failure.
		const ownershipFailure = profile.failures.find(item => item.command.args.includes("@gjc-profile"));
		if (ownershipFailure) {
			const probeAfterOwnership = probeHasSession();
			if (probeAfterOwnership.exitCode === 0) {
				// Session is present; tagging failed for a real reason.
				cleanupCreatedTmuxSession(plan, spawnSync, options);
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("profile tagging failed", ownershipFailure.stderr),
				);
				return true;
			}
			// Session is missing — retry.
			const retry = spawnSync(plan.tmuxCommand, plan.newSessionArgs, newSessionOptions);
			const retryProbe = probeHasSession();
			if (retry.exitCode !== 0 || retryProbe.exitCode !== 0) {
				cleanupCreatedTmuxSession(plan, spawnSync, options);
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic(
						"new-session retry failed after ownership failure",
						retry.stderr ?? retryProbe.stderr ?? ownershipFailure.stderr,
					),
				);
				return true;
			}
			const retryProfile = applyGjcTmuxProfile(buildProfileInputs());
			const retryOwnershipFailure = retryProfile.failures.find(item => item.command.args.includes("@gjc-profile"));
			if (retryOwnershipFailure) {
				cleanupCreatedTmuxSession(plan, spawnSync, options);
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
			target: plan.sessionName,
			title: rootTerminalTitle,
			spawnSync,
			options,
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
		return false;
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
		} else {
			const retry = spawnSync(plan.tmuxCommand, plan.newSessionArgs, newSessionOptions);
			const retryProbe = probeHasSession();
			if (retry.exitCode === 0 && retryProbe.exitCode === 0) {
				renameTmuxWindow(
					plan.tmuxCommand,
					windowTitle,
					spawnSync,
					controlOptions,
					buildGjcTmuxExactSessionTarget(plan.sessionName, { env }),
				);
				const retryProfile = applyGjcTmuxProfile(buildProfileInputs());
				const retryOwnershipFailure = retryProfile.failures.find(item =>
					item.command.args.includes("@gjc-profile"),
				);
				if (!retryOwnershipFailure) {
					ensureCreatedTmuxWindowTracksCallerTerminal(plan, spawnSync, controlOptions);
					applyGjcTmuxRootTerminalTitleProfile({
						tmuxCommand: plan.tmuxCommand,
						target: plan.sessionName,
						title: rootTerminalTitle,
						spawnSync,
						options,
					});
					const retryAttached = attachCreatedSession();
					if (retryAttached.exitCode === 0) return true;
					if (isTmuxAttachDisconnectError(retryAttached)) {
						(context.diagnosticWriter ?? safeStderrWrite)(
							formatTmuxLaunchDiagnostic("attach disconnected", retryAttached.stderr),
						);
						return true;
					}
				}
			}
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
	cleanupCreatedTmuxSession(plan, spawnSync, options);
	(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("attach failed", attached.stderr));
	return true;
}
