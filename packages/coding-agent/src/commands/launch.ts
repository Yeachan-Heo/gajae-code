/**
 * Root command for the coding agent CLI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APP_NAME, setProjectDir } from "@gajae-code/utils";
import { Args, Command } from "@gajae-code/utils/cli";
import { parseArgs } from "../cli/args";
import { ROOT_LAUNCH_FLAGS } from "../cli/root-flags";
import { launchDefaultTmuxIfNeeded } from "../gjc-runtime/launch-tmux";
import { type PreparedLaunchWorktree, prepareLaunchWorktree } from "../gjc-runtime/launch-worktree";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
} from "../gjc-runtime/session-state-sidecar";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

export async function persistCoordinatorLaunchFailure(
	error: unknown,
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const stateFile = env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (!stateFile) return;
	const message = error instanceof Error ? error.message : String(error);
	const code = message.split(":", 1)[0] || "launch_failed";
	const now = new Date().toISOString();
	const payload = {
		schema_version: 1,
		session_id: env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || null,
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
		...(env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim()
			? { owner_generation: env[GJC_TMUX_OWNER_GENERATION_ENV] ?? null }
			: {}),
	};
	await fs.mkdir(path.dirname(stateFile), { recursive: true });
	await Bun.write(stateFile, `${JSON.stringify(payload, null, 2)}\n`);
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
		`# Launch in a sibling git worktree\n  ${APP_NAME} --worktree`,
		`# Use different model (fuzzy matching)\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# Limit model cycling to specific models\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# Pin a stored credential for this session\n  ${APP_NAME} --credential email:me@example.com`,
		`# Activate a model profile for this session\n  ${APP_NAME} --mpreset codex-medium`,
		`# Persist a model profile as the default\n  ${APP_NAME} --mpreset opencodego --default`,
		`# Export a session file to HTML\n  ${APP_NAME} --export ~/.gjc/agent/sessions/v2-<scope>/session.jsonl`,
		`# Use an explicit session storage directory\n  ${APP_NAME} --session-dir ./sessions`,
	];

	static strict = false;

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		const parsed = parseArgs([...args]);
		if (parsed.help || parsed.version) {
			await runRootCommand(parsed, args);
			return;
		}

		let launch: PreparedLaunchWorktree;
		try {
			launch = prepareLaunchWorktree(process.cwd(), args);
		} catch (error) {
			await persistCoordinatorLaunchFailure(error, process.cwd());
			throw error;
		}
		if (launch.worktree.enabled) {
			process.chdir(launch.cwd);
			setProjectDir(launch.cwd);
		}
		const launchParsed = parseArgs(launch.args);
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
	}
}
