import { Buffer } from "node:buffer";
import * as path from "node:path";
import { VERSION } from "@gajae-code/utils/dirs";
import { safeStderrWrite } from "@gajae-code/utils/safe-stderr";
import type { Args } from "../cli/args";
import { tmuxRuntimeSessionPath } from "./session-layout";
import { GJC_COORDINATOR_SESSION_ID_ENV, GJC_COORDINATOR_SESSION_STATE_FILE_ENV } from "./session-state-sidecar";
import {
	buildGjcTmuxProfileCommands,
	buildGjcTmuxSessionName,
	buildGjcTmuxSessionSlug,
	GJC_DEFAULT_TMUX_SESSION,
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

type LaunchPolicy = "direct" | "tmux";

interface TtyState {
	stdin: boolean;
	stdout: boolean;
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

export type TmuxSpawnSync = (command: string, args: string[], options: TmuxSpawnOptions) => TmuxSpawnResult;

export interface TmuxSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin: "inherit";
	stdout: "inherit";
	stderr: "inherit";
}

export interface TmuxLaunchPlan {
	tmuxCommand: string;
	sessionName: string;
	cwd: string;
	innerCommand: string;
	newSessionArgs: string[];
	branch?: string | null;
	attachSessionName?: string;
	project?: string | null;
	sessionId?: string | null;
	sessionStateFile?: string | null;
}

function explicitTmuxSessionName(env: NodeJS.ProcessEnv): string | undefined {
	return env.GJC_TMUX_SESSION?.trim() || undefined;
}
function hasCurrentGjcVersion(session: GjcTmuxSessionStatus | undefined): boolean {
	return session?.version === VERSION;
}

function allowsExistingTmuxAttach(parsed: Args, env: NodeJS.ProcessEnv): boolean {
	return Boolean(parsed.continue || parsed.resume || explicitTmuxSessionName(env));
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
	const invocation = ["&", ...command.map(powershellQuote), ...stripRootTmuxFlag(rawArgs).map(powershellQuote)].join(
		" ",
	);
	const exitLine = "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }";
	const script = [...envLines, invocation, exitLine].join("\n");
	const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
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
	const options: TmuxSpawnOptions = { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" };
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

function sanitizeTmuxWindowTitleSegment(value: string): string {
	return value.replace(/:+/g, "-");
}

function sanitizeTmuxWindowProjectName(project: string): string {
	const trimmed = project.trim();
	if (!trimmed || /^\.+$/.test(trimmed)) return "gjc";
	if (trimmed.startsWith(".")) return sanitizeTmuxWindowTitleSegment(`dot-${trimmed.replace(/^\.+/, "")}`);
	return sanitizeTmuxWindowTitleSegment(trimmed);
}

export function buildGjcTmuxWindowTitle(cwd: string, branch: string | null | undefined): string {
	const project = sanitizeTmuxWindowProjectName(path.basename(path.resolve(cwd)) || "gjc");
	const trimmedBranch = sanitizeTmuxWindowTitleSegment(branch?.trim() ?? "");
	if (!trimmedBranch) return truncateVisible(project, GJC_TMUX_WINDOW_LABEL_MAX_WIDTH);

	const separatorWidth = visibleWidth(GJC_TMUX_WINDOW_BRANCH_SEPARATOR);
	const projectWidth = visibleWidth(project);
	const fullTitle = `${project}${GJC_TMUX_WINDOW_BRANCH_SEPARATOR}${trimmedBranch}`;
	if (visibleWidth(fullTitle) <= GJC_TMUX_WINDOW_LABEL_MAX_WIDTH) return fullTitle;

	const remainingBranchWidth = GJC_TMUX_WINDOW_LABEL_MAX_WIDTH - projectWidth - separatorWidth;
	if (remainingBranchWidth <= 0) return truncateVisible(project, GJC_TMUX_WINDOW_LABEL_MAX_WIDTH);

	return `${project}${GJC_TMUX_WINDOW_BRANCH_SEPARATOR}${truncateVisibleTail(trimmedBranch, remainingBranchWidth)}`;
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
	spawnSync(plan.tmuxCommand, ["kill-session", "-t", `=${plan.sessionName}`], options);
}
function isTmuxAttachDisconnectError(result: TmuxSpawnResult): boolean {
	if (result.signalCode === "SIGHUP") return true;
	const stderr = result.stderr?.toLowerCase() ?? "";
	return stderr.includes("eio") || stderr.includes("input/output error");
}

export function buildDefaultTmuxLaunchPlan(context: TmuxLaunchContext): TmuxLaunchPlan | undefined {
	const env = context.env ?? process.env;
	const policy = parseLaunchPolicy(env);
	if (!context.parsed.tmux || policy === "direct") return undefined;
	if (env.TMUX || env[GJC_TMUX_LAUNCHED_ENV] === "1") return undefined;
	const platform = context.platform ?? process.platform;
	const tty = context.tty ?? { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) };
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
			},
			platform,
		},
		context.rawArgs,
	);
	return {
		tmuxCommand,
		sessionName,
		cwd,
		innerCommand,
		newSessionArgs: ["new-session", "-d", "-s", sessionName, "-c", cwd, innerCommand],
		branch,
		project,
		sessionId,
		sessionStateFile,
		attachSessionName: existingSessionName,
	};
}

function defaultSpawnSync(command: string, args: string[], options: TmuxSpawnOptions): TmuxSpawnResult {
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		cwd: options.cwd,
		env: options.env,
		stdin: options.stdin,
		stdout: options.stdout,
		stderr: options.stderr,
	});
	return { exitCode: result.exitCode, signalCode: result.signalCode };
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

	if (plan.attachSessionName) {
		const attached = spawnSync(plan.tmuxCommand, ["attach-session", "-t", `=${plan.attachSessionName}`], options);
		if (attached.exitCode === 0) return true;
	}

	const created = spawnSync(plan.tmuxCommand, plan.newSessionArgs, options);
	if (created.exitCode === 0) {
		renameTmuxWindow(
			plan.tmuxCommand,
			buildGjcTmuxWindowTitle(plan.project ?? plan.cwd, plan.branch),
			spawnSync,
			options,
			`=${plan.sessionName}`,
		);

		const profile = applyGjcTmuxProfile({
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
		const ownershipFailure = profile.failures.find(item => item.command.args.includes("@gjc-profile"));
		if (ownershipFailure) {
			cleanupCreatedTmuxSession(plan, spawnSync, options);
			(context.diagnosticWriter ?? safeStderrWrite)(
				formatTmuxLaunchDiagnostic("profile tagging failed", ownershipFailure.stderr),
			);
			return true;
		}
	}
	if (created.exitCode !== 0) return false;
	const attached = spawnSync(plan.tmuxCommand, ["attach-session", "-t", `=${plan.sessionName}`], options);
	if (attached.exitCode === 0) return true;
	if (isTmuxAttachDisconnectError(attached)) {
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("attach disconnected", attached.stderr));
		return true;
	}
	cleanupCreatedTmuxSession(plan, spawnSync, options);
	(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("attach failed", attached.stderr));
	return true;
}
