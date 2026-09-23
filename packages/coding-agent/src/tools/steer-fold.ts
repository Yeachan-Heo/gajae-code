import { logger } from "@gajae-code/utils";
import type { FoldReason } from "../async/job-manager";
import type { ToolSession } from ".";

/** A short foreground wait stays in the foreground even when a steer is admitted. */
export const STEER_FOLD_GRACE_MS = 2_000;

/** Model-facing line appended to a steer-folded background-start result. */
export function steerFoldReasonLine(jobId: string): string {
	return `Folded into background job ${jobId} because a user steer arrived; the command keeps running with its original timeout and its result will wake a later turn.`;
}

/** Model-facing cause clause for a fold, keyed by the recorded {@link FoldReason}. */
export function foldReasonClause(reason: FoldReason): string {
	switch (reason) {
		case "steer":
			return "because a user steer arrived";
		case "chord":
			return "because the user pressed the fold chord";
		case "sdk_control":
			return "because an SDK client requested it";
		case "timer":
			return "because the auto-background threshold elapsed";
	}
}

/** Model-facing line used when the `job` tool's own wait is folded; states the real trigger. */
export function foldAwaitReasonLine(folded: ReadonlyMap<string, FoldReason>): string {
	const jobIds = [...folded.keys()];
	const names = jobIds.map(id => `\`${id}\``).join(", ");
	const reasons = [...new Set(folded.values())];
	const single = reasons.length === 1 ? reasons[0] : undefined;
	const cause = single ? foldReasonClause(single) : "because the waits were folded";
	const plural = jobIds.length !== 1;
	return `Folded the job await for ${names} ${cause}; the job${plural ? "s keep" : " keeps"} running with ${plural ? "their original deadlines" : "its original deadline"}, and ${plural ? "their results" : "its result"} will wake a later turn.`;
}

type SteerFoldSession = Pick<ToolSession, "settings" | "waitForUserSteering" | "requestForegroundBashBackground">;

/** The session hooks a steer fold needs, resolved once so callers never re-read and non-null-assert them. */
interface SteerFoldHooks {
	waitForSteer: NonNullable<ToolSession["waitForUserSteering"]>;
	requestFold: NonNullable<ToolSession["requestForegroundBashBackground"]>;
}

/**
 * Whether a queued user steer may fold the running foreground wait. Mirrors
 * the loop's steer admission: `busyPromptMode=queue` never admits a steer
 * into the busy run, so it never folds. `toolInterruptPolicy` is
 * deliberately NOT a gate: `finish_tools` means "do not kill the batch to
 * deliver a steer", and a fold kills nothing. It is the one way to deliver
 * the steer now AND let the command finish, so it applies under both
 * policies; the policy only decides what the loop does with sibling tools
 * after the fold returns. The auto-background setting is likewise not
 * consulted: like the chord, a steer fold is a user action.
 *
 * Fails closed: a session that cannot report newly admitted steering or
 * accept a fold request is not steer-foldable.
 */
function steerFoldHooks(session: SteerFoldSession): SteerFoldHooks | undefined {
	const { waitForUserSteering, requestForegroundBashBackground } = session;
	if (!waitForUserSteering || !requestForegroundBashBackground) return undefined;
	if (session.settings.get("busyPromptMode") !== "steer") return undefined;
	return { waitForSteer: waitForUserSteering, requestFold: requestForegroundBashBackground };
}

/**
 * Fold on the first user steer that ARRIVES after the wait has run for
 * {@link STEER_FOLD_GRACE_MS} since `startedAt`. A steer already queued when
 * the wait starts, or one that arrives inside the grace window, never folds:
 * the wait finishes normally and that steer is consumed at the ordinary tool
 * boundary. The watcher keeps observing so a later qualifying steer still
 * folds, and re-checks the gate at that moment so a `busyPromptMode` change
 * during the wait is honored. `requestFold` receives the session's resolved
 * fold request so the caller targets its own adapter without re-reading the
 * optional session hook.
 * Returns a stop function; call it when the wait settles. No-op when steer
 * folding is gated off at start.
 */
export function watchSteerForFold(
	session: SteerFoldSession,
	startedAt: number,
	requestFold: (fold: SteerFoldHooks["requestFold"]) => Promise<unknown>,
	jobId?: string,
): () => void {
	const hooks = steerFoldHooks(session);
	if (!hooks) return () => {};
	const watch = new AbortController();
	const observe = async (): Promise<void> => {
		while (!watch.signal.aborted) {
			await hooks.waitForSteer(watch.signal);
			if (watch.signal.aborted) return;
			if (Date.now() - startedAt < STEER_FOLD_GRACE_MS) continue;
			const current = steerFoldHooks(session);
			if (!current) continue;
			await requestFold(current.requestFold);
			return;
		}
	};
	observe().catch((error: unknown) => {
		logger.warn("Steer-triggered fold failed", {
			...(jobId ? { jobId } : {}),
			error: error instanceof Error ? error.message : String(error),
		});
	});
	return () => watch.abort();
}
