import { Buffer } from "node:buffer";
import * as path from "node:path";
import { safeStderrWrite } from "@gajae-code/utils";
import type { Args } from "../cli/args";
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
	resolveGjcTmuxCommand,
} from "./tmux-common";
import { findGjcTmuxSessionByBranch } from "./tmux-sessions";

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
	const commands = buildGjcTmuxProfileCommands(context.target, env, {
		branch: context.branch ?? null,
		branchSlug,
		project: context.project ?? null,
		sessionId: context.sessionId ?? env[GJC_COORDINATOR_SESSION_ID_ENV] ?? null,
		sessionStateFile: context.sessionStateFile ?? env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] ?? null,
	});
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

export function buildGjcTmuxWindowTitle(cwd: string, branch: string | null | undefined): string {
	const project = path.basename(path.resolve(cwd)) || "gjc";
	const trimmedBranch = branch?.trim();
	if (!trimmedBranch) return truncateVisible(project, GJC_TMUX_WINDOW_LABEL_MAX_WIDTH);

	const separatorWidth = visibleWidth(":");
	const projectWidth = visibleWidth(project);
	const fullTitle = `${project}:${trimmedBranch}`;
	if (visibleWidth(fullTitle) <= GJC_TMUX_WINDOW_LABEL_MAX_WIDTH) return fullTitle;

	const remainingBranchWidth = GJC_TMUX_WINDOW_LABEL_MAX_WIDTH - projectWidth - separatorWidth;
	if (remainingBranchWidth <= 0) return truncateVisible(project, GJC_TMUX_WINDOW_LABEL_MAX_WIDTH);

	return `${project}:${truncateVisibleTail(trimmedBranch, remainingBranchWidth)}`;
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

	const platform = context.platform ?? process.platform;
	if (platform === "win32") return;

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
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const sessionId = env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || sessionName;
	const sessionStateFile =
		env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim() ||
		path.join(cwd, ".gjc", "runtime", "tmux-sessions", `${buildGjcTmuxSessionSlug(sessionName)}.json`);
	const tmuxAvailable = context.tmuxAvailable ?? Bun.which(tmuxCommand) !== null;
	if (!tmuxAvailable) return undefined;
	const existingBranchSessionName =
		"existingBranchSessionName" in context
			? (context.existingBranchSessionName ?? undefined)
			: context.worktreeBranch
				? findGjcTmuxSessionByBranch(context.worktreeBranch, env, project)?.name
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
		attachSessionName: existingBranchSessionName,
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
		return attached.exitCode === 0;
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
	const attached = spawnSync(plan.tmuxCommand, ["attach-session", "-t", plan.sessionName], options);
	if (attached.exitCode === 0) return true;
	(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("attach failed", attached.stderr));
	return true;
}
