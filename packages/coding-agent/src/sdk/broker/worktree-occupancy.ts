/**
 * Which session currently holds a GJC-managed worktree.
 *
 * Both launch paths need this answer and must not disagree about it: the broker
 * refuses a lifecycle launch into an occupied worktree, and the interactive
 * `gjc --worktree` launch refuses for the same reason. Keeping one predicate —
 * and one definition of "still running" — here prevents the two from drifting
 * into different notions of liveness.
 */

import type * as NativeBindings from "@gajae-code/natives";
import { resolveEquivalentPath } from "@gajae-code/utils";
import { probeLinuxProcPidSync } from "../../gjc-runtime/linux-proc";
import { processIncarnation } from "./process-incarnation";
import type { IndexedSession } from "./session-index";

function nativeLifecycle(): typeof NativeBindings {
	return require("@gajae-code/natives") as typeof NativeBindings;
}

export type ProcessObservation = "alive" | "exited" | "uncertain";

/** Only ESRCH or a changed, readable incarnation proves the owned process exited. */
export function observeProcess(
	pid: number,
	expectedIncarnation: string | undefined,
	readIncarnation: (pid: number) => string | undefined = processIncarnation,
): ProcessObservation {
	if (process.platform === "win32") {
		try {
			const reference = nativeLifecycle().Process.fromPid(pid);
			if (reference?.status() !== "running") return "exited";
		} catch {
			return "uncertain";
		}
		if (!expectedIncarnation) return "uncertain";
		const actualIncarnation = readIncarnation(pid);
		if (!actualIncarnation) return "uncertain";
		return actualIncarnation === expectedIncarnation ? "alive" : "exited";
	}
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "uncertain";
	}
	if (process.platform === "linux") {
		const probe = probeLinuxProcPidSync(pid);
		if (probe.kind === "live" && probe.state === "Z" && expectedIncarnation === `linux:${probe.startTime}`)
			return "exited";
	}
	if (!expectedIncarnation) return "uncertain";
	const actualIncarnation = readIncarnation(pid);
	if (!actualIncarnation) return "uncertain";
	return actualIncarnation === expectedIncarnation ? "alive" : "exited";
}

/**
 * The id of a session still occupying `worktreePath`, or null when it is free.
 *
 * `ensureLaunchWorktree` reuses an existing worktree without asking whether
 * anyone is in it, and an unnamed launch derives its directory deterministically
 * from the repository's current branch. Two concurrent sessions in one
 * repository therefore land in the same checkout and overwrite each other's
 * files with no error.
 *
 * Only a process observed as definitively exited releases the worktree.
 * `uncertain` counts as occupied: refusing a launch is recoverable by picking
 * another worktree name, whereas two live sessions sharing a checkout corrupts
 * work already done.
 *
 * A row carrying BOTH `terminalUncertain` and `forcedStaleRelease` is the one
 * exception. That pair is written only by the forced stop of a stale-endpoint
 * session: teardown was requested explicitly, so parking its worktree until an
 * OS probe happens to prove exit would leave the checkout locked indefinitely
 * (#5581) exactly when the probe returns `uncertain`. Such a row is released
 * regardless of the process observation.
 *
 * `terminalUncertain` on its own is not enough. The fail-closed tail of a
 * signal-escalated teardown sets it after SIGKILL without ever proving the child
 * gone, so that process may still be running in the checkout; releasing on the
 * flag alone would let a second session into the same worktree. Those rows stay
 * under the strict "only definitive exit releases" rule like every other
 * ordinary retained row.
 */
export function worktreeOccupant(
	sessions: readonly IndexedSession[],
	worktreePath: string,
	observe: (pid: number, expectedIncarnation: string | undefined) => ProcessObservation = observeProcess,
): string | null {
	// Session locators retain the canonical Git worktree root separately from the
	// session cwd. A host may start below that root, and a launch plan may arrive
	// through a symlink, so compare the root identity rather than the cwd spelling.
	const target = resolveEquivalentPath(worktreePath);
	for (const session of sessions) {
		const sessionWorktreeRoot = session.locator.worktreeRoot;
		if (
			session.terminal ||
			(session.terminalUncertain === true && session.forcedStaleRelease === true) ||
			typeof sessionWorktreeRoot !== "string" ||
			sessionWorktreeRoot.length === 0
		)
			continue;
		if (resolveEquivalentPath(sessionWorktreeRoot) !== target) continue;
		// `live` is heartbeat-derived and can be stale. Only positive process-exit
		// evidence releases a matching retained session's worktree.
		if (observe(session.pid, session.hostIncarnation ?? session.processIncarnation) === "exited") continue;
		return session.sessionId;
	}
	return null;
}
