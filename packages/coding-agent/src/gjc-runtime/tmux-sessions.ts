import {
	buildGjcTmuxExactOptionTarget,
	buildGjcTmuxProfileCommands,
	buildGjcTmuxSessionName,
	buildGjcTmuxUntaggedSessionError,
	GJC_TMUX_BRANCH_OPTION,
	GJC_TMUX_BRANCH_SLUG_OPTION,
	GJC_TMUX_PROFILE_OPTION,
	GJC_TMUX_PROFILE_VALUE,
	GJC_TMUX_PROJECT_OPTION,
	GJC_TMUX_SESSION_ID_OPTION,
	GJC_TMUX_SESSION_STATE_FILE_OPTION,
	GJC_TMUX_VERSION_OPTION,
	normalizeTmuxCreatedAt,
	resolveGjcTmuxCommand,
} from "./tmux-common";

export interface GjcTmuxSessionStatus {
	name: string;
	attached: boolean;
	windows: number;
	panes: number;
	bindings: string;
	createdAt: string;
	branch?: string;
	branchSlug?: string;
	project?: string;
	sessionId?: string;
	sessionStateFile?: string;
	version?: string;
	panePids: number[];
	profile?: string;
}

export interface GjcTmuxSessionTagsForGc {
	profile?: string;
	project?: string;
	branch?: string;
	branchSlug?: string;
	sessionId?: string;
	sessionStateFile?: string;
	version?: string;
	createdAt?: string;
	attached?: boolean;
	panePids?: number[];
}

export interface GjcTmuxSessionsForGc {
	tagged: GjcTmuxSessionStatus[];
	untagged: GjcTmuxSessionStatus[];
}

function runTmux(args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const result = Bun.spawnSync([tmuxCommand, ...args], { stdout: "pipe", stderr: "pipe", env });
	if (result.exitCode === 0) return result.stdout.toString();
	throw new Error(result.stderr.toString().trim() || `tmux ${args.join(" ")} failed`);
}

function tryKillSession(sessionName: string, env: NodeJS.ProcessEnv): void {
	try {
		runTmux(["kill-session", "-t", `=${sessionName}`], env);
	} catch {
		// Best-effort cleanup only; preserve the original create/tag failure.
	}
}

function parseBooleanFlag(value: string | undefined): boolean {
	return value === "1";
}

function parseNumber(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "0", 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseSessionLine(line: string): GjcTmuxSessionStatus | null {
	const [
		name = "",
		windows = "0",
		attached = "0",
		created = "",
		profile = "",
		bindings = "",
		panes = "0",
		panePids = "",
		branch = "",
		branchSlug = "",
		project = "",
		sessionId = "",
		sessionStateFile = "",
		version = "",
	] = line.split("\t");
	if (!name) return null;
	return {
		name,
		attached: parseBooleanFlag(attached),
		windows: parseNumber(windows),
		panes: parseNumber(panes),
		panePids: panePids
			.split(",")
			.map(pid => parseNumber(pid))
			.filter(pid => pid > 0),
		bindings,
		createdAt: normalizeTmuxCreatedAt(created),
		branch: branch || undefined,
		branchSlug: branchSlug || undefined,
		project: project || undefined,
		profile: profile || undefined,
		sessionId: sessionId || undefined,
		sessionStateFile: sessionStateFile || undefined,
		version: version || undefined,
	};
}

function runListSessions(format: string, env: NodeJS.ProcessEnv = process.env): string[] {
	let output = "";
	try {
		output = runTmux(["list-sessions", "-F", format], env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes("no server running") ||
			message.includes("failed to connect to server") ||
			message.includes("error connecting to")
		) {
			return [];
		}
		throw error;
	}
	return output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function listSessionLines(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions(
		`#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{${GJC_TMUX_PROFILE_OPTION}}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{${GJC_TMUX_BRANCH_OPTION}}\t#{${GJC_TMUX_BRANCH_SLUG_OPTION}}\t#{${GJC_TMUX_PROJECT_OPTION}}\t#{${GJC_TMUX_SESSION_ID_OPTION}}\t#{${GJC_TMUX_SESSION_STATE_FILE_OPTION}}\t#{${GJC_TMUX_VERSION_OPTION}}`,
		env,
	);
}

function listRawTmuxSessionNames(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions("#{session_name}", env).map(line => line.split("\t")[0] ?? line);
}

export function listGjcTmuxSessions(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus[] {
	return listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is GjcTmuxSessionStatus => session != null)
		.map(session => hydrateSessionFromExactOptions(session, env))
		.filter((session): session is GjcTmuxSessionStatus => session?.profile === GJC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** @internal */
export function listTmuxSessionsForGc(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionsForGc {
	const sessions = listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is GjcTmuxSessionStatus => session != null)
		.map(session => hydrateSessionFromExactOptions(session, env));
	const tagged = sessions
		.filter(session => session.profile === GJC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
	const taggedNames = new Set(tagged.map(session => session.name));
	const byName = new Map(sessions.map(session => [session.name, session]));
	const untagged = listRawTmuxSessionNames(env)
		.filter(name => !taggedNames.has(name))
		.map(
			name =>
				byName.get(name) ?? {
					name,
					attached: false,
					windows: 0,
					panes: 0,
					panePids: [],
					bindings: "",
					createdAt: "",
				},
		)
		.sort((a, b) => a.name.localeCompare(b.name));
	return { tagged, untagged };
}

export function findGjcTmuxSessionByBranch(
	branch: string,
	env: NodeJS.ProcessEnv = process.env,
	project?: string | null,
): GjcTmuxSessionStatus | undefined {
	return listGjcTmuxSessions(env).find(
		session => session.branch === branch && (!project || session.project === project),
	);
}

export function findGjcTmuxSessionByName(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
): GjcTmuxSessionStatus | undefined {
	return listGjcTmuxSessions(env).find(session => session.name === sessionName);
}

export function findGjcTmuxSessionByScope(
	project: string,
	branch: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): GjcTmuxSessionStatus | undefined {
	return listGjcTmuxSessions(env).find(
		session => session.project === project && (branch ? session.branch === branch : session.branch === undefined),
	);
}
export function statusGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus {
	const session = listGjcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	if (session) return session;
	if (listRawTmuxSessionNames(env).includes(sessionName)) {
		throw new Error(buildGjcTmuxUntaggedSessionError(sessionName, resolveGjcTmuxCommand(env)));
	}
	throw new Error(`gjc_tmux_session_not_found:${sessionName}`);
}

export function createGjcTmuxSession(env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus {
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const sessionName = buildGjcTmuxSessionName(env);
	// Build a shell-bootstrap command appropriate for the host shell. Psmux on
	// Windows runs the new-session command through PowerShell, so we use the
	// $env:VAR = ... assignment form there. POSIX keeps the historical exec
	// env form so the launched gjc inherits GJC_TMUX_LAUNCHED without leaking
	// into the parent tmux server.
	const platform = process.platform;
	const command = platform === "win32" ? "$env:GJC_TMUX_LAUNCHED = '1'; gjc" : "exec env GJC_TMUX_LAUNCHED=1 gjc";
	const created = Bun.spawnSync([tmuxCommand, "new-session", "-d", "-s", sessionName, command], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	if (created.exitCode !== 0) throw new Error(created.stderr.toString().trim() || "gjc_tmux_session_create_failed");
	try {
		for (const profileCommand of buildGjcTmuxProfileCommands(sessionName, env)) {
			runTmux(profileCommand.args, env);
		}
	} catch (error) {
		tryKillSession(sessionName, env);
		throw error;
	}
	return statusGjcTmuxSession(sessionName, env);
}

function readProfileForExactTarget(sessionName: string, env: NodeJS.ProcessEnv): string {
	return runTmux(
		["show-options", "-qv", "-t", buildGjcTmuxExactOptionTarget(sessionName), GJC_TMUX_PROFILE_OPTION],
		env,
	).trim();
}

function readExactOptionForGc(sessionName: string, option: string, env: NodeJS.ProcessEnv): string | undefined {
	try {
		return (
			runTmux(["show-options", "-qv", "-t", buildGjcTmuxExactOptionTarget(sessionName), option], env).trim() ||
			undefined
		);
	} catch {
		return undefined;
	}
}

function hydrateSessionFromExactOptions(session: GjcTmuxSessionStatus, env: NodeJS.ProcessEnv): GjcTmuxSessionStatus {
	if (session.profile === GJC_TMUX_PROFILE_VALUE) return session;
	const profile = readExactOptionForGc(session.name, GJC_TMUX_PROFILE_OPTION, env);
	if (profile !== GJC_TMUX_PROFILE_VALUE) return session;
	return {
		...session,
		profile,
		branch: session.branch ?? readExactOptionForGc(session.name, GJC_TMUX_BRANCH_OPTION, env),
		branchSlug: session.branchSlug ?? readExactOptionForGc(session.name, GJC_TMUX_BRANCH_SLUG_OPTION, env),
		project: session.project ?? readExactOptionForGc(session.name, GJC_TMUX_PROJECT_OPTION, env),
		sessionId: session.sessionId ?? readExactOptionForGc(session.name, GJC_TMUX_SESSION_ID_OPTION, env),
		sessionStateFile:
			session.sessionStateFile ?? readExactOptionForGc(session.name, GJC_TMUX_SESSION_STATE_FILE_OPTION, env),
		version: session.version ?? readExactOptionForGc(session.name, GJC_TMUX_VERSION_OPTION, env),
	};
}

/** @internal */
export function readTmuxSessionTagsForGc(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
): GjcTmuxSessionTagsForGc {
	const session = listGjcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	return {
		profile: readExactOptionForGc(sessionName, GJC_TMUX_PROFILE_OPTION, env),
		project: readExactOptionForGc(sessionName, GJC_TMUX_PROJECT_OPTION, env),
		branch: readExactOptionForGc(sessionName, GJC_TMUX_BRANCH_OPTION, env),
		branchSlug: readExactOptionForGc(sessionName, GJC_TMUX_BRANCH_SLUG_OPTION, env),
		sessionId: readExactOptionForGc(sessionName, GJC_TMUX_SESSION_ID_OPTION, env),
		sessionStateFile: readExactOptionForGc(sessionName, GJC_TMUX_SESSION_STATE_FILE_OPTION, env),
		version: readExactOptionForGc(sessionName, GJC_TMUX_VERSION_OPTION, env),
		createdAt: session?.createdAt,
		attached: session?.attached,
		panePids: session?.panePids,
	};
}

export function removeGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): GjcTmuxSessionStatus {
	const session = statusGjcTmuxSession(sessionName, env);
	if (session.attached || session.panePids.length > 0) {
		throw new Error(`gjc_tmux_session_live:${sessionName}`);
	}
	if (readProfileForExactTarget(session.name, env) !== GJC_TMUX_PROFILE_VALUE) {
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	}
	runTmux(["kill-session", "-t", `=${session.name}`], env);
	return session;
}

/**
 * Force-close a GJC-managed tmux session, even if a live pane is attached.
 *
 * This is the lifecycle-control counterpart to {@link removeGjcTmuxSession}: it
 * intentionally does NOT refuse live/attached panes (hard-kill is the contract),
 * but it keeps every safety check so it can only ever kill a genuinely
 * GJC-managed session:
 * - re-reads the exact tmux profile immediately before kill (never a non-GJC
 *   session, even one that collides by name);
 * - when `expectedSessionId` is given, requires the `@gjc-session-id` tag match;
 * - when `expectedStateFile` is given, requires the `@gjc-session-state-file`
 *   tag match.
 *
 * Returns the prior status (for audit). Throws a tagged error otherwise:
 * `gjc_tmux_session_not_found`, `gjc_tmux_session_not_managed`,
 * `gjc_tmux_session_id_mismatch`, or `gjc_tmux_session_state_file_mismatch`.
 */
export function forceCloseGjcTmuxSession(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
	expectedSessionId?: string,
	expectedStateFile?: string,
): GjcTmuxSessionStatus {
	const session = statusGjcTmuxSession(sessionName, env);
	if (readProfileForExactTarget(session.name, env) !== GJC_TMUX_PROFILE_VALUE) {
		throw new Error(`gjc_tmux_session_not_managed:${sessionName}`);
	}
	if (expectedSessionId !== undefined) {
		const actual = readExactOptionForGc(session.name, GJC_TMUX_SESSION_ID_OPTION, env);
		if (actual !== expectedSessionId) {
			throw new Error(`gjc_tmux_session_id_mismatch:${sessionName}`);
		}
	}
	if (expectedStateFile !== undefined) {
		const actual = readExactOptionForGc(session.name, GJC_TMUX_SESSION_STATE_FILE_OPTION, env);
		if (actual !== expectedStateFile) {
			throw new Error(`gjc_tmux_session_state_file_mismatch:${sessionName}`);
		}
	}
	// Intentionally NOT refusing live/attached panes — force-close is hard-kill.
	runTmux(["kill-session", "-t", `=${session.name}`], env);
	return session;
}

export function attachGjcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): never {
	const session = statusGjcTmuxSession(sessionName, env);
	const tmuxCommand = resolveGjcTmuxCommand(env);
	const result = Bun.spawnSync([tmuxCommand, "attach-session", "-t", `=${session.name}`], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env,
	});
	process.exit(result.exitCode ?? 1);
}
