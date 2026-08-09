import { HEARTBEAT_TTL_MS } from "./bus/daemon-paths";
import type { SdkClientOptions } from "./client";

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
