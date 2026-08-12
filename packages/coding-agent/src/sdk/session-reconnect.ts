import { HEARTBEAT_TTL_MS } from "./bus/daemon-paths";
import { DEFAULT_SDK_REQUEST_TIMEOUT_MS, type SdkClientOptions } from "./client";

type SessionReconnectOptions = Required<
	Pick<SdkClientOptions, "reconnectAttempts" | "reconnectBackoffMs" | "reconnectMaxBackoffMs">
>;

const SESSION_RECONNECT_BACKOFF_MS = 250;
const SESSION_RECONNECT_MAX_BACKOFF_MS = 2_000;
/** Cover twice the host heartbeat TTL so a reaped stall still has room to recover. */
const SESSION_RECONNECT_BUDGET_MS = 2 * HEARTBEAT_TTL_MS;

function attemptsCovering(budgetMs: number): number {
	let elapsed = 0;
	let attempts = 0;
	while (elapsed <= budgetMs) {
		elapsed += Math.min(SESSION_RECONNECT_BACKOFF_MS * 2 ** attempts, SESSION_RECONNECT_MAX_BACKOFF_MS);
		attempts++;
	}
	return attempts;
}

/**
 * Reconnect budget for every long-lived SDK session client: ACP sessions and the
 * chat daemon's attached sessions alike. Named for the ACP session that first
 * needed it; it lives here because both live under the same host reaper and the
 * bus layer must not import the ACP layer to reach it.
 *
 * Invariant: the client's total reconnect budget must outlive the host heartbeat
 * TTL ({@link HEARTBEAT_TTL_MS}). The SDK host drops a session whose client has
 * not ponged within that TTL, so a client that gives up reconnecting sooner turns
 * every stall the host reaps into a permanently lost session ("SDK WebSocket
 * reconnect attempts exhausted"). The transport defaults (3 attempts at 25ms base
 * = 175ms total) are correct only for one-shot request clients.
 *
 * Backoff ramps 250 -> 500 -> 1000 and then holds at the 2s cap, so individual
 * sleeps stay short and recovery is prompt once the host answers again.
 */
export const ACP_SESSION_RECONNECT: SessionReconnectOptions = {
	reconnectAttempts: attemptsCovering(SESSION_RECONNECT_BUDGET_MS),
	reconnectBackoffMs: SESSION_RECONNECT_BACKOFF_MS,
	reconnectMaxBackoffMs: SESSION_RECONNECT_MAX_BACKOFF_MS,
};

/**
 * Post-connect response budget for session-scoped SDK commands dispatched
 * through the Router. It bounds the wait for a reply on an already-connected
 * transport; connecting, reconnecting, and lifecycle work keep their own
 * separate deadlines.
 *
 * The transport default (10s) is sized for one-shot broker requests and is too
 * short for the first query a cold session host answers: Q10
 * (`models.list/current`) collects credentials for every configured profile
 * provider, which on a multi-OAuth setup takes longer than 10s once and
 * milliseconds afterwards. Abandoning that request loses far more than the
 * query — the reply lands after the deadline, so the outcome can only be
 * reported as uncertain after the frame was sent, and ACP discards the session
 * it just created (#4258).
 *
 * The size is the SDK's existing model of what one healthy round trip may cost
 * while the producer is still working: an owner heartbeat window plus a second
 * window for recovery ({@link ACP_SESSION_RECONNECT}, and `SDK_RECONNECT_BUDGET_MS`
 * in `./prompt-watchdog`, both `2 * HEARTBEAT_TTL_MS`). A response budget shorter
 * than the recovery budget would abandon replies the rest of the stack is still
 * waiting to deliver.
 *
 * Session commands are acknowledgement-shaped (`turn.prompt` returns an accepted
 * receipt, not the turn's result), so no legitimate session request needs longer.
 * The tradeoff is that a connected but wedged host is reported after this budget
 * rather than after 10s, including `turn.abort`: ACP awaits that acknowledgement
 * before arming its own settlement grace (`CANCEL_SETTLEMENT_GRACE_MS`), which
 * bounds only the terminal that follows an acknowledged abort.
 */
export const SESSION_REQUEST_TIMEOUT_MS = 2 * HEARTBEAT_TTL_MS;

/**
 * Reply budget for `turn.abort`, which cannot use {@link SESSION_REQUEST_TIMEOUT_MS}.
 *
 * A cancel is the user asking for the turn to stop now, and the caller waits for
 * its acknowledgement before anything else can bound the turn: ACP arms its own
 * settlement grace only after `aborted: true` comes back, so an abort that waits
 * the full session budget delays cancellation by that budget and, if it finally
 * rejects, leaves the prompt for the inactivity watchdog instead of the cancel
 * path. Aborting therefore keeps the ordinary one-shot request deadline: the
 * abort is not the query whose cold first answer needed a wider budget (#4258).
 */
export const SESSION_ABORT_TIMEOUT_MS = DEFAULT_SDK_REQUEST_TIMEOUT_MS;
