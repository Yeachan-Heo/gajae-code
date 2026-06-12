export const GJC_DEFAULT_TMUX_SESSION = "gajae_code";
export const GJC_TMUX_SESSION_PREFIX = `${GJC_DEFAULT_TMUX_SESSION}_`;
export const GJC_TMUX_COMMAND_ENV = "GJC_TMUX_COMMAND";
export const GJC_TMUX_PROFILE_ENV = "GJC_TMUX_PROFILE";
export const GJC_TMUX_MOUSE_ENV = "GJC_MOUSE";
export const GJC_TMUX_PROFILE_OPTION = "@gjc-profile";
export const GJC_TMUX_PROFILE_VALUE = "1";
export const GJC_TMUX_BRANCH_OPTION = "@gjc-branch";
export const GJC_TMUX_BRANCH_SLUG_OPTION = "@gjc-branch-slug";
export const GJC_TMUX_PROJECT_OPTION = "@gjc-project";

export interface GjcTmuxProfileCommand {
	description: string;
	args: string[];
}

export interface TmuxCommandResult {
	exitCode: number | null;
	stdout?: string;
	stderr?: string;
	signalCode?: string | null;
}

export type TmuxCommandRunner = (args: string[]) => TmuxCommandResult;

export function envDisabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

export function resolveGjcTmuxCommand(env: NodeJS.ProcessEnv = process.env): string {
	return env[GJC_TMUX_COMMAND_ENV]?.trim() || env.GJC_TEAM_TMUX_COMMAND?.trim() || "tmux";
}

export const GJC_TMUX_UNTAGGED_REASON = "gjc_tmux_session_untagged";

export function buildGjcTmuxUntaggedSessionHint(tmuxCommand: string): string {
	return (
		`the active multiplexer "${tmuxCommand}" lists this session but did not return GJC's ${GJC_TMUX_PROFILE_OPTION} ownership tag; ` +
		"GJC-managed sessions and `gjc team` require a tmux provider that round-trips tmux user options. " +
		"Alternative multiplexers such as psmux on Windows do not persist user options yet, so the Windows-native psmux path is not fully supported; " +
		"use real tmux for GJC-managed session and team flows."
	);
}

export function buildGjcTmuxUntaggedSessionError(sessionName: string, tmuxCommand: string): string {
	return `${GJC_TMUX_UNTAGGED_REASON}:${sessionName} — ${buildGjcTmuxUntaggedSessionHint(tmuxCommand)}`;
}

export function sanitizeTmuxToken(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "default"
	);
}

export function buildGjcTmuxSessionSlug(value: string): string {
	return sanitizeTmuxToken(value);
}

function randomTmuxSessionSuffix(): string {
	return Math.random().toString(36).slice(2, 10);
}

export function buildGjcTmuxSessionName(
	env: NodeJS.ProcessEnv = process.env,
	context: { branch?: string | null; now?: number; id?: string } = {},
): string {
	const explicit = env.GJC_TMUX_SESSION?.trim();
	if (explicit) return explicit;
	const timestamp = (context.now ?? Date.now()).toString(36);
	const id = context.id ?? randomTmuxSessionSuffix();
	const branchSlug = context.branch ? `${buildGjcTmuxSessionSlug(context.branch)}_` : "";
	return `${GJC_TMUX_SESSION_PREFIX}${branchSlug}${timestamp}_${id}`;
}

export function buildGjcTmuxRequiredProfileCommands(
	target: string,
	metadata: { branch?: string | null; branchSlug?: string | null; project?: string | null } = {},
): GjcTmuxProfileCommand[] {
	const commands: GjcTmuxProfileCommand[] = [
		{
			description: "mark GJC tmux ownership",
			args: ["set-option", "-t", target, GJC_TMUX_PROFILE_OPTION, GJC_TMUX_PROFILE_VALUE],
		},
	];
	if (metadata.branch)
		commands.push({
			description: "record GJC branch identity",
			args: ["set-option", "-t", target, GJC_TMUX_BRANCH_OPTION, metadata.branch],
		});
	if (metadata.branchSlug)
		commands.push({
			description: "record GJC branch slug",
			args: ["set-option", "-t", target, GJC_TMUX_BRANCH_SLUG_OPTION, metadata.branchSlug],
		});
	if (metadata.project)
		commands.push({
			description: "record GJC project identity",
			args: ["set-option", "-t", target, GJC_TMUX_PROJECT_OPTION, metadata.project],
		});
	return commands;
}

export function buildGjcTmuxProfileCommands(
	target: string,
	env: NodeJS.ProcessEnv = process.env,
	metadata: { branch?: string | null; branchSlug?: string | null; project?: string | null } = {},
): GjcTmuxProfileCommand[] {
	const commands = buildGjcTmuxRequiredProfileCommands(target, metadata);
	if (envDisabled(env[GJC_TMUX_PROFILE_ENV])) return commands;
	commands.push(
		{ description: "enable tmux clipboard integration", args: ["set-option", "-t", target, "set-clipboard", "on"] },
		{
			description: "make copy-mode selection readable",
			args: ["set-window-option", "-t", target, "mode-style", "fg=colour231,bg=colour60"],
		},
	);
	if (!envDisabled(env[GJC_TMUX_MOUSE_ENV]))
		commands.unshift({
			description: "enable tmux mouse scrolling",
			args: ["set-option", "-t", target, "mouse", "on"],
		});
	return commands;
}

export function normalizeTmuxCreatedAt(raw: string): string {
	const seconds = Number.parseInt(raw, 10);
	if (!Number.isFinite(seconds) || seconds <= 0) return raw;
	return new Date(seconds * 1000).toISOString();
}
