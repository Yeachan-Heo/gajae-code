/**
 * Advisory detection of long blocking `sleep` in bash commands (#4465).
 *
 * When the agent reaches for a long silent `sleep N` instead of using
 * `subagent await` or `job poll` to wait for background work, the session emits
 * nothing for the entire duration and looks indistinguishable from a hang to
 * the operator. This module detects that pattern and returns a bounded advisory
 * notice — it never blocks the command, adds no fake progress, and respects the
 * authority boundary: only the tool result/guidance surfaces the warning, not a
 * runtime refusal. Legitimate sleeps (daemons, test servers, rate-limit pacing)
 * are not blocked; the notice is purely advisory.
 *
 * Detection is intentionally conservative: a standalone `sleep` with an explicit
 * numeric duration at or above the threshold, or a `sleep` chained with `&&` to
 * a single trailing command (the common "sleep then check" pattern from #4465).
 * Compound commands where `sleep` is incidental to real work are not flagged.
/**
 * Minimum sleep duration (in seconds) that triggers the advisory notice.
 */
const LONG_SLEEP_THRESHOLD_SEC = 120;

/**
 * Matches a standalone `sleep` command with an explicit numeric duration.
 * Supports `sleep N`, `sleep Ns`, `sleep Nm`, `sleep Nh`, `sleep 1d`, and
 * multiple arguments (`sleep 5 3` — sleeps 5s per POSIX, but the intent is the
 * same). The number is parsed as seconds for the threshold check.
 *
 * Examples that trigger:
 *   `sleep 800`
 *   `sleep 800; git log --oneline -1`
 *   `sleep 300 && git log --oneline -1`
 *   `sleep 5m`
 *
 * Examples that do NOT trigger:
 *   `sleep 5`
 *   `sleep 10; echo done`
 *   `server --port 3000` (no sleep at all)
 */
const SLEEP_DURATION_RE = /(?:^|[\s;&|]+)sleep\s+([0-9]+(?:\.[0-9]+)?)([smhd]?)/;

/** Parse a sleep duration token into seconds. */
function parseSleepSeconds(rawNumber: string, unit: string): number {
	const value = Number.parseFloat(rawNumber);
	if (!Number.isFinite(value) || value <= 0) return 0;
	const unitLower = unit.toLowerCase();
	switch (unitLower) {
		case "":
		case "s":
			return value;
		case "m":
			return value * 60;
		case "h":
			return value * 3600;
		case "d":
			return value * 86400;
		default:
			return value;
	}
}

/** Round seconds to the nearest whole minute for human-readable display. */
function roundToMinutes(seconds: number): number {
	return Math.round(seconds / 60);
}

/**
 * Format a duration in seconds as a short `Xm` / `Xs` string.
 *
 * `Xs` for anything under a minute (covers the zero case), otherwise `Xm`.
 * Uses the same minute rounding as the notice body so the two stay consistent.
 */
function formatDuration(seconds: number): string {
	return seconds < 60 ? `${Math.round(seconds)}s` : `${roundToMinutes(seconds)}m`;
}

/**
 * Detect a long blocking sleep in a bash command and return an advisory notice,
 * or `undefined` if the command does not contain a qualifying sleep. The notice
 * is appended to the bash result output; it never blocks execution.
 *
 * `timeoutSec` is the effective (already-clamped) execution timeout the command
 * will run under, when known. The bash tool kills the command at this timeout
 * whether the sleep fits inside it or not. Passing it lets the notice report
 * the bounded effective silent wait the operator will actually observe, instead
 * of the requested duration (which may be much longer and is never reached).
 * When `timeoutSec` is `undefined` (no timeout known at the construction
 * boundary), the notice reports only the requested duration and stays useful.
 */
export function longSleepAdvisory(command: string, timeoutSec?: number): string | undefined {
	const match = command.match(SLEEP_DURATION_RE);
	if (!match) return undefined;
	const requestedSeconds = parseSleepSeconds(match[1]!, match[2]!);
	if (requestedSeconds < LONG_SLEEP_THRESHOLD_SEC) return undefined;

	const parts = [
		`Note: this command requests a sleep of ~${formatDuration(requestedSeconds)}, during which the session produces no output and is indistinguishable from a hang (#4465).`,
	];

	// When the effective timeout is known and is shorter than the requested
	// sleep, the command is killed at the timeout — the operator never sees the
	// full requested duration. Surface the bounded wait so the notice matches
	// observable behavior. (For PTY/async the same timeout applies: the tool
	// kills the command at timeoutSec regardless of mode.)
	if (timeoutSec !== undefined && timeoutSec < requestedSeconds) {
		parts.push(
			`The execution timeout will kill this command after ~${formatDuration(timeoutSec)}, so the effective silent wait is bounded by the timeout, not the requested sleep.`,
		);
	}

	parts.push(
		"Long blocking sleeps are not how to wait for subagents or background jobs.",
		"Prefer `subagent await` (which emits periodic liveness) or `job poll` to wait observably.",
	);
	return parts.join(" ");
}
