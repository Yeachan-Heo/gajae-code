import * as path from "node:path";
import type { Args } from "../cli/args";

export const GJC_DEFAULT_TMUX_SESSION = "gajae_code";
export const GJC_TMUX_LAUNCHED_ENV = "GJC_TMUX_LAUNCHED";
export const GJC_LAUNCH_POLICY_ENV = "GJC_LAUNCH_POLICY";
export const GJC_TMUX_COMMAND_ENV = "GJC_TMUX_COMMAND";

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
	attachSessionArgs: string[];
}

interface CommandResolutionContext {
	cwd: string;
	argv: string[];
	execPath: string;
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

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveCurrentGjcCommand(context: CommandResolutionContext): string[] {
	const entrypoint = context.argv[1];
	if (!entrypoint) return ["gjc"];
	const resolvedEntrypoint = path.isAbsolute(entrypoint) ? entrypoint : path.resolve(context.cwd, entrypoint);
	if (entrypoint.endsWith(".ts") || entrypoint.endsWith(".js") || entrypoint.endsWith(".mjs")) {
		return [context.execPath, resolvedEntrypoint];
	}
	return [resolvedEntrypoint];
}

function buildInnerCommand(context: CommandResolutionContext, rawArgs: string[]): string {
	const command = resolveCurrentGjcCommand(context);
	const quoted = [...command, ...rawArgs].map(shellQuote).join(" ");
	return `exec env ${GJC_TMUX_LAUNCHED_ENV}=1 ${quoted}`;
}

export function buildDefaultTmuxLaunchPlan(context: TmuxLaunchContext): TmuxLaunchPlan | undefined {
	const env = context.env ?? process.env;
	const policy = parseLaunchPolicy(env);
	if (!context.parsed.tmux || policy === "direct") return undefined;
	if (env.TMUX || env[GJC_TMUX_LAUNCHED_ENV] === "1") return undefined;
	const platform = context.platform ?? process.platform;
	if (platform === "win32") return undefined;
	const tty = context.tty ?? { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) };
	if (policy === "tmux" && !isInteractiveRootLaunch(context.parsed, tty)) return undefined;

	const cwd = context.cwd ?? process.cwd();
	const sessionName = env.GJC_TMUX_SESSION?.trim() || GJC_DEFAULT_TMUX_SESSION;
	const tmuxCommand = env[GJC_TMUX_COMMAND_ENV]?.trim() || "tmux";
	const tmuxAvailable = context.tmuxAvailable ?? Bun.which(tmuxCommand) !== null;
	if (!tmuxAvailable) return undefined;
	const innerCommand = buildInnerCommand(
		{
			cwd,
			argv: context.argv ?? process.argv,
			execPath: context.execPath ?? process.execPath,
		},
		context.rawArgs,
	);
	return {
		tmuxCommand,
		sessionName,
		cwd,
		innerCommand,
		newSessionArgs: ["new-session", "-s", sessionName, "-c", cwd, innerCommand],
		attachSessionArgs: ["attach-session", "-t", sessionName],
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
	const created = spawnSync(plan.tmuxCommand, plan.newSessionArgs, options);
	if (created.exitCode === 0) return true;
	const attached = spawnSync(plan.tmuxCommand, plan.attachSessionArgs, options);
	return attached.exitCode === 0;
}
