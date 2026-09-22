import { logger } from "@gajae-code/utils";
import type { ToolSession } from ".";

/** A short foreground wait stays in the foreground even when a steer is admitted. */
export const STEER_FOLD_GRACE_MS = 2_000;

/** Model-facing line appended to a steer-folded background-start result. */
export function steerFoldReasonLine(jobId: string): string {
	return `Folded into background job ${jobId} because a user steer arrived; the command keeps running with its original timeout and its result will wake a later turn.`;
}

/** Model-facing line used when the `job` tool's own wait is folded. */
export function steerFoldAwaitReasonLine(jobIds: readonly string[]): string {
	const names = jobIds.map(id => `\`${id}\``).join(", ");
	return `Folded the job await for ${names} because a user steer arrived; the job${jobIds.length === 1 ? " keeps" : "s keep"} running with its original deadline${jobIds.length === 1 ? "" : "s"}, and its result${jobIds.length === 1 ? "" : "s"} will wake a later turn.`;
}

type SteerFoldSession = Pick<ToolSession, "settings" | "waitForUserSteering" | "requestForegroundBashBackground">;

function steerFoldEnabled(session: SteerFoldSession): boolean {
	const { waitForUserSteering, requestForegroundBashBackground } = session;
	if (!waitForUserSteering || !requestForegroundBashBackground) return false;
	return session.settings.get("busyPromptMode") === "steer";
}

/**
 * Watch for the first qualifying steer and invoke the supplied fold request.
 * A steer already queued when the wait starts, or one arriving inside the
 * grace window, is consumed at the ordinary tool boundary instead.
 */
export function watchSteerForFold(
	session: SteerFoldSession,
	startedAt: number,
	requestFold: () => Promise<unknown>,
	jobId?: string,
): () => void {
	if (!steerFoldEnabled(session)) return () => {};
	const waitForSteer = session.waitForUserSteering;
	if (!waitForSteer) return () => {};
	const watch = new AbortController();
	const observe = async (): Promise<void> => {
		while (!watch.signal.aborted) {
			await waitForSteer(watch.signal);
			if (watch.signal.aborted) return;
			if (Date.now() - startedAt < STEER_FOLD_GRACE_MS) continue;
			if (!steerFoldEnabled(session)) continue;
			await requestFold();
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
