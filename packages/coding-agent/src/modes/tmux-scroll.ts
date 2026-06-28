import { resolveGjcTmuxCommand } from "../gjc-runtime/tmux-common";

// tmux copy-mode pads lines to the pane width, so allow trailing spaces before
// the line end while keeping the match scoped to the standalone `user` label.
export const TMUX_PREVIOUS_USER_INPUT_SEARCH_PATTERN = "^ *user *$";

type TmuxScrollFailureReason =
	| "not_inside_tmux"
	| "tmux_command_failed"
	| "copy_mode_failed"
	| "history_bottom_failed"
	| "search_failed";

export type TmuxScrollToPreviousUserInputResult =
	| { ok: true }
	| { ok: false; reason: TmuxScrollFailureReason; error?: string };

interface TmuxSpawnResult {
	exitCode: number | null;
	stderr?: { toString(): string };
}

type TmuxSpawnSync = (command: string, args: string[], env: NodeJS.ProcessEnv) => TmuxSpawnResult;

function defaultSpawnSync(command: string, args: string[], env: NodeJS.ProcessEnv): TmuxSpawnResult {
	return Bun.spawnSync([command, ...args], {
		env,
		stdout: "ignore",
		stderr: "pipe",
	});
}

function getErrorText(result: TmuxSpawnResult): string | undefined {
	const text = result.stderr?.toString().trim();
	return text ? text : undefined;
}

function runTmuxStep(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	spawnSync: TmuxSpawnSync,
	reason: TmuxScrollFailureReason,
): TmuxScrollToPreviousUserInputResult {
	try {
		const result = spawnSync(command, args, env);
		if (result.exitCode === 0) return { ok: true };
		return { ok: false, reason, error: getErrorText(result) };
	} catch (error) {
		return { ok: false, reason, error: error instanceof Error ? error.message : String(error) };
	}
}

export function scrollTmuxToPreviousUserInput(
	env: NodeJS.ProcessEnv = process.env,
	spawnSync: TmuxSpawnSync = defaultSpawnSync,
): TmuxScrollToPreviousUserInputResult {
	if (!env.TMUX) return { ok: false, reason: "not_inside_tmux" };

	let tmuxCommand: string;
	try {
		tmuxCommand = resolveGjcTmuxCommand(env);
	} catch (error) {
		return {
			ok: false,
			reason: "tmux_command_failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const targetPane = env.TMUX_PANE?.trim();
	const targetArgs = targetPane ? ["-t", targetPane] : [];
	const copyModeResult = runTmuxStep(tmuxCommand, ["copy-mode", ...targetArgs], env, spawnSync, "copy_mode_failed");
	if (!copyModeResult.ok) return copyModeResult;

	const historyBottomResult = runTmuxStep(
		tmuxCommand,
		["send-keys", ...targetArgs, "-X", "history-bottom"],
		env,
		spawnSync,
		"history_bottom_failed",
	);
	if (!historyBottomResult.ok) return historyBottomResult;

	return runTmuxStep(
		tmuxCommand,
		["send-keys", ...targetArgs, "-X", "search-backward", TMUX_PREVIOUS_USER_INPUT_SEARCH_PATTERN],
		env,
		spawnSync,
		"search_failed",
	);
}
