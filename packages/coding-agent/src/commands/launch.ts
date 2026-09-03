/**
 * Root command for the coding agent CLI.
 */

import { APP_NAME, getAgentDir, setProjectDir } from "@gajae-code/utils";
import { Args, Command } from "@gajae-code/utils/cli";
import { assertLocalLaunchArgs, parseArgs } from "../cli/args";
import { ROOT_LAUNCH_FLAGS } from "../cli/root-flags";
import { launchDefaultTmuxIfNeeded } from "../gjc-runtime/launch-tmux";
import {
	asLaunchWorktreeGuardError,
	type GjcLaunchWorktreePlan,
	type PreparedLaunchWorktree,
	parseLaunchWorktreeMode,
	planLaunchWorktree,
	prepareLaunchWorktree,
} from "../gjc-runtime/launch-worktree";
import { type LaunchWorktreeReservation, reserveLaunchWorktree } from "../gjc-runtime/launch-worktree-reservation";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_COORDINATOR_SIDECAR_KEY_ID_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_GENERATION_STAGED_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
	persistCoordinatorLaunchFailureState,
} from "../gjc-runtime/session-state-sidecar";
import { runRootCommand } from "../main";
import { assertMasterLaunchArgs } from "../master-mode/context";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";
import { type IndexedSession, SessionIndex } from "../sdk/broker/session-index";
import { worktreeOccupant } from "../sdk/broker/worktree-occupancy";

export async function persistCoordinatorLaunchFailure(
	error: unknown,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const stateFile = env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (!stateFile) return;
	const sessionId = env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || null;
	const ownerGenerationPublished = env[GJC_TMUX_OWNER_GENERATION_STAGED_ENV] !== "1";
	const ownerGeneration = env[GJC_TMUX_OWNER_GENERATION_ENV] ?? null;
	const message = error instanceof Error ? error.message : String(error);
	const code = message.split(":", 1)[0] || "launch_failed";
	const now = new Date().toISOString();
	const payload = {
		schema_version: 1,
		session_id: sessionId,
		state: "errored",
		ready_for_input: false,
		updated_at: now,
		current_turn_id: null,
		last_turn_id: null,
		live: false,
		reason: code,
		source: "agent_session_event",
		event: "launch_error",
		cwd,
		session_file: null,
		final_response: {
			text: message,
			format: "markdown",
			source: "launch_error",
			artifact_path: null,
			truncated: false,
		},
		error: { code, message, recoverable: true },
		...(sessionId && ownerGenerationPublished ? { owner_generation: ownerGeneration } : {}),
	};
	await persistCoordinatorLaunchFailureState({
		stateFile,
		cwd,
		sessionId,
		ownerGeneration,
		ownerStateDir: env[GJC_TMUX_OWNER_STATE_DIR_ENV] ?? null,
		ownerServerKey: env[GJC_TMUX_OWNER_SERVER_KEY_ENV] ?? null,
		managedLaunch: env.GJC_TMUX_LAUNCHED === "1",
		payload,
		signingRequired: env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]?.trim() === "true",
		keyId: env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV] ?? null,
	});
}

function worktreeInUseError(worktreePath: string, occupant?: string): Error {
	const holder = occupant ? `session ${occupant}` : "another launch";
	return new Error(
		`worktree_in_use:${worktreePath} is already held by ${holder}. ` +
			"Use gjc --worktree <name> for a separate checkout, or stop that session.",
	);
}

async function reserveLaunchWorktreeOrFail(agentDir: string, worktreePath: string): Promise<LaunchWorktreeReservation> {
	const reservation = await reserveLaunchWorktree(agentDir, worktreePath);
	if (!reservation) throw worktreeInUseError(worktreePath);
	return reservation;
}

/** Test seam for the path-keyed atomic reservation. */
export async function reserveLaunchWorktreeForTest(
	agentDir: string,
	worktreePath: string,
): Promise<LaunchWorktreeReservation> {
	return await reserveLaunchWorktreeOrFail(agentDir, worktreePath);
}

async function assertLaunchWorktreeUnoccupied(worktree: GjcLaunchWorktreePlan | { enabled: false }): Promise<void> {
	if (!worktree.enabled) return;
	let sessions: readonly IndexedSession[];
	try {
		sessions = (await new SessionIndex(getAgentDir()).open()).listSessionIdentities();
	} catch {
		throw new Error(`worktree_occupancy_unavailable:${worktree.worktreePath}`);
	}
	const occupant = worktreeOccupant(sessions, worktree.worktreePath);
	if (occupant) throw worktreeInUseError(worktree.worktreePath, occupant);
}

async function reserveLaunchWorktreePreflight(
	worktree: GjcLaunchWorktreePlan | { enabled: false },
): Promise<LaunchWorktreeReservation | undefined> {
	if (!worktree.enabled) return undefined;
	const reservation = await reserveLaunchWorktreeOrFail(getAgentDir(), worktree.worktreePath);
	try {
		await assertLaunchWorktreeUnoccupied(worktree);
		return reservation;
	} catch (error) {
		await reservation.release();
		throw error;
	}
}

export default class Index extends Command {
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
		`# Launch in a repo-local git worktree (git-ignored {repo}/.worktrees)\n  ${APP_NAME} --worktree`,
		`# Use different model (fuzzy matching)\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# Limit model cycling to specific models\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# Pin a stored credential for this session\n  ${APP_NAME} --credential email:me@example.com`,
		`# Prefer a stored credential, falling back on quota limits\n  ${APP_NAME} --prefer-credential id:15`,
		`# Activate a model profile for this session\n  ${APP_NAME} --mpreset codex-medium`,
		`# Persist a model profile as the default\n  ${APP_NAME} --mpreset opencodego --default`,
		`# Export a session file to HTML\n  ${APP_NAME} --export ~/.gjc/agent/sessions/v2-<scope>/session.jsonl`,
		`# Use an explicit session storage directory\n  ${APP_NAME} --session-dir ./sessions`,
	];

	static strict = false;

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		const parsed = parseArgs([...args], "deferred");
		if (parsed.mode !== "acp") assertLocalLaunchArgs(parsed);
		assertMasterLaunchArgs(parsed);
		if (parsed.help || parsed.version) {
			await runRootCommand(parsed, args);
			return;
		}

		let launch: PreparedLaunchWorktree;
		let reservation: LaunchWorktreeReservation | undefined;
		try {
			const plannedWorktree = planLaunchWorktree(process.cwd(), parseLaunchWorktreeMode(args).mode);
			reservation = await reserveLaunchWorktreePreflight(plannedWorktree);
			launch = prepareLaunchWorktree(process.cwd(), args);
		} catch (error) {
			await reservation?.release();
			const guard = asLaunchWorktreeGuardError(error);
			// A user-fixable launch refusal exits with only its actionable message: no stack
			// trace, and no durable crash record for a configuration state the user can fix.
			if (guard) {
				try {
					await persistCoordinatorLaunchFailure(error, process.cwd());
				} catch {
					// Persistence is diagnostic only; never replace the actionable refusal.
				}
				process.stderr.write(`${guard.message}\n`);
				process.exit(1);
			}
			await persistCoordinatorLaunchFailure(error, process.cwd());
			throw error;
		}
		try {
			if (launch.worktree.enabled) {
				process.chdir(launch.cwd);
				setProjectDir(launch.cwd);
			}
			const launchParsed = parseArgs(launch.args, "deferred");
			if (launchParsed.mode !== "acp") assertLocalLaunchArgs(launchParsed);
			assertMasterLaunchArgs(launchParsed);
			if (
				launchDefaultTmuxIfNeeded({
					parsed: launchParsed,
					rawArgs: launch.args,
					cwd: launch.cwd,
					worktreeBranch: launch.worktree.enabled && !launch.worktree.detached ? launch.worktree.branchName : null,
					project: launch.cwd,
				})
			)
				return;
			await runRootCommand(launchParsed, launch.args);
		} finally {
			await reservation?.release();
		}
	}
}
