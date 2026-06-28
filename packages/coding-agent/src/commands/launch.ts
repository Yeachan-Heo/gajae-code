/**
 * Root command for the coding agent CLI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { THINKING_EFFORTS } from "@gajae-code/ai";
import { APP_NAME, setProjectDir } from "@gajae-code/utils";
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { parseArgs } from "../cli/args";
import { launchDefaultTmuxIfNeeded } from "../gjc-runtime/launch-tmux";
import { prepareLaunchWorktree } from "../gjc-runtime/launch-worktree";
import {
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
} from "../gjc-runtime/session-state-sidecar";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

async function persistCoordinatorLaunchFailure(error: unknown, cwd: string): Promise<void> {
	const stateFile = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim();
	if (!stateFile) return;
	const message = error instanceof Error ? error.message : String(error);
	const code = message.split(":", 1)[0] || "launch_failed";
	const now = new Date().toISOString();
	const payload = {
		schema_version: 1,
		session_id: process.env[GJC_COORDINATOR_SESSION_ID_ENV]?.trim() || null,
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

	static flags = {
		model: Flags.string({
			description: 'Model to use (fuzzy match: "opus", "gpt-5.2", or "openai/gpt-5.2")',
		}),
		smol: Flags.string({
			description: "Smol/fast model for lightweight tasks (or GJC_SMOL_MODEL env)",
		}),
		slow: Flags.string({
			description: "Slow/reasoning model for thorough analysis (or GJC_SLOW_MODEL env)",
		}),
		plan: Flags.string({
			description: "Plan model for architectural planning (or GJC_PLAN_MODEL env)",
		}),
		mpreset: Flags.string({
			description: "Model profile preset to activate for this session",
		}),
		default: Flags.boolean({
			description: "Persist --mpreset as the default model profile",
		}),
		provider: Flags.string({
			description: "Provider to use (legacy; prefer --model)",
		}),
		"api-key": Flags.string({
			description: "API key (defaults to env vars)",
		}),
		"system-prompt": Flags.string({
			description: "System prompt (default: coding assistant prompt)",
		}),
		"append-system-prompt": Flags.string({
			description: "Append text or file contents to the system prompt",
		}),
		"allow-home": Flags.boolean({
			description: "Allow starting in ~ without auto-switching to a temp dir",
		}),
		mode: Flags.string({
			description: "Output mode: text (default), json, rpc, acp, rpc-ui, or bridge",
			options: ["text", "json", "rpc", "acp", "rpc-ui", "bridge"],
		}),
		print: Flags.boolean({
			char: "p",
			description: "Non-interactive mode: process prompt and exit",
		}),
		continue: Flags.boolean({
			char: "c",
			description: "Continue previous session",
		}),
		resume: Flags.string({
			char: "r",
			description: "Resume a session (by ID prefix, path, or picker if omitted)",
		}),
		"session-dir": Flags.string({
			description: "Directory for session storage and lookup",
		}),
		"no-session": Flags.boolean({
			description: "Don't save session (ephemeral)",
		}),
		models: Flags.string({
			description: "Comma-separated model patterns for Ctrl+P cycling",
		}),
		"no-tools": Flags.boolean({
			description: "Disable all built-in tools",
		}),
		"no-lsp": Flags.boolean({
			description: "Disable LSP tools, formatting, and diagnostics",
		}),
		"no-pty": Flags.boolean({
			description: "Disable PTY-based interactive bash execution",
		}),
		tmux: Flags.boolean({
			description: "Launch interactive startup inside tmux",
		}),
		tools: Flags.string({
			description: "Comma-separated list of tools to enable (default: all)",
		}),
		thinking: Flags.string({
			description: `Set thinking level: ${THINKING_EFFORTS.join(", ")}`,
			options: [...THINKING_EFFORTS],
		}),
		hook: Flags.string({
			description: "Load a hook/extension file (can be used multiple times)",
			multiple: true,
		}),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file (can be used multiple times)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		"no-skills": Flags.boolean({
			description: "Disable skills discovery and loading",
		}),
		skills: Flags.string({
			description: "Comma-separated glob patterns to filter skills (e.g., git-*,docker)",
		}),
		"no-rules": Flags.boolean({
			description: "Disable rules discovery and loading",
		}),
		export: Flags.string({
			description: "Export session file to HTML and exit",
		}),
		"list-models": Flags.string({
			description: "List available models (with optional fuzzy search)",
		}),
		"no-title": Flags.boolean({
			description: "Disable title auto-generation",
		}),
	};

	static examples = [
		`# Interactive mode\n  ${APP_NAME}`,
		`# Interactive mode with initial prompt\n  ${APP_NAME} "List all .ts files in src/"`,
		`# Include files in initial message\n  ${APP_NAME} @prompt.md @image.png "What color is the sky?"`,
		`# Non-interactive mode (process and exit)\n  ${APP_NAME} -p "List all .ts files in src/"`,
		`# Continue previous session\n  ${APP_NAME} --continue "What did we discuss?"`,
		`# Launch in a sibling git worktree\n  ${APP_NAME} --worktree`,
		`# Use different model (fuzzy matching)\n  ${APP_NAME} --model opus "Help me refactor this code"`,
		`# Limit model cycling to specific models\n  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o`,
		`# Activate a model profile for this session\n  ${APP_NAME} --mpreset codex-medium`,
		`# Persist a model profile as the default\n  ${APP_NAME} --mpreset opencodego --default`,
		`# Export a session file to HTML\n  ${APP_NAME} --export ~/.gjc/agent/sessions/--path--/session.jsonl`,
	];

	static strict = false;

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		const parsed = parseArgs([...args]);
		if (parsed.help || parsed.version) {
			await runRootCommand(parsed, args);
			return;
		}

		let launch: ReturnType<typeof prepareLaunchWorktree>;
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
