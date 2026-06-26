import { resolveGjcTmuxBinary } from "./psmux-detect";

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
export const GJC_TMUX_SESSION_ID_OPTION = "@gjc-session-id";
export const GJC_TMUX_SESSION_STATE_FILE_OPTION = "@gjc-session-state-file";
export const GJC_TMUX_VERSION_OPTION = "@gjc-version";

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

/**
 * Resolve the tmux (or tmux-compatible multiplexer) command GJC should invoke.
 *
 * This is the shared entry point used by every GJC code path that needs to talk
 * to a multiplexer: `gjc --tmux` planning, `gjc session ...`, `gjc team ...`,
 * the lifecycle controller, and the harness resident owner. Routing all of
 * them through the same resolver means a single `GJC_TMUX_COMMAND` override or
 * a single Windows psmux / pmux detection wins for the whole process — the
 * failure mode where `gjc --tmux` creates a psmux-backed session and then
 * `gjc session status` fails because it queries literal `tmux` is closed off.
 *
 * Explicit `GJC_TMUX_COMMAND` / `GJC_TEAM_TMUX_COMMAND` overrides are honored on
 * every platform. On native Windows without an override the resolver walks
 * `psmux`, then `pmux`, then `tmux` and uses the first binary present on PATH.
 * On POSIX the resolver returns `tmux` (the historical default) and only
 * falls through to the platform-aware walker if the caller opts in.
 */
export function resolveGjcTmuxCommand(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return resolveGjcTmuxBinary({ env, platform }).command;
}

export type { PsmuxProbe, ResolvedTmuxBinary, ResolveGjcTmuxBinaryOptions } from "./psmux-detect";
export { clearPsmuxDetectionCache, detectPsmux, probePsmux, resolveGjcTmuxBinary } from "./psmux-detect";

/**
 * Build the exact-session target for tmux *option* commands
 * (`show-options` / `set-option`) and `display-message -t`.
 *
 * Session-scoped commands such as `kill-session` / `attach-session` resolve a
 * bare exact target (`=NAME`), but tmux 3.6a refuses to resolve a bare `=NAME`
 * for option/display commands. Appending the empty window separator (`=NAME:`)
 * keeps the exact-session match while giving tmux the window-qualified target
 * those commands require. See gajae-code#580.
 */
export function buildGjcTmuxExactOptionTarget(sessionName: string): string {
	return `=${sessionName}:`;
}

export const GJC_TMUX_UNTAGGED_REASON = "gjc_tmux_session_untagged";

export function buildGjcTmuxUntaggedSessionHint(tmuxCommand: string): string {
	return (
		`the active multiplexer "${tmuxCommand}" lists this session but did not return GJC's ${GJC_TMUX_PROFILE_OPTION} ownership tag; ` +
		"GJC-managed sessions and `gjc team` require a tmux provider that round-trips tmux user options. " +
		"For psmux on Windows, cwd/start-directory flags such as `-c` do not isolate the server namespace; psmux uses the tmux-compatible global `-L <namespace>` flag for that. " +
		"GJC_TMUX_COMMAND and GJC_TEAM_TMUX_COMMAND are binary overrides, not shell command lines, so `psmux -L name` is not a supported value. " +
		"Alternative multiplexers such as psmux on Windows do not reliably persist user options yet, so the Windows-native psmux path is not fully supported; " +
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
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		version?: string | null;
	} = {},
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
	if (metadata.sessionId)
		commands.push({
			description: "record GJC session identity",
			args: ["set-option", "-t", target, GJC_TMUX_SESSION_ID_OPTION, metadata.sessionId],
		});
	if (metadata.sessionStateFile)
		commands.push({
			description: "record GJC session state marker",
			args: ["set-option", "-t", target, GJC_TMUX_SESSION_STATE_FILE_OPTION, metadata.sessionStateFile],
		});
	if (metadata.version)
		commands.push({
			description: "record GJC version identity",
			args: ["set-option", "-t", target, GJC_TMUX_VERSION_OPTION, metadata.version],
		});
	return commands;
}

export function buildGjcTmuxProfileCommands(
	target: string,
	env: NodeJS.ProcessEnv = process.env,
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		version?: string | null;
	} = {},
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
