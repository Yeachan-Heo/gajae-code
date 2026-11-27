/**
 * Continue here (session single-owner design §12 "hand over to the TUI", §13 L1): a session held by
 * a broker-launched host is closed through the broker, between turns, and claimed by this process,
 * so this process becomes its one writer. Remote clients attached to the host (ACP bridges, chat
 * daemons) re-attach to this process's endpoint through the broker; they never block the close.
 */
import { randomUUID } from "node:crypto";
import { logger } from "@gajae-code/utils";
import { endpointIncarnation } from "../sdk/broker/endpoint-authority";
import { processIncarnation } from "../sdk/broker/process-incarnation";
import {
	DIRECT_SESSION_REGISTRATION_ATTEMPTS,
	isTransientSessionIndexLockError,
	resolveSessionLocator,
	SessionIndex,
	type SessionLocatorV2,
} from "../sdk/broker/session-index";
import { createBrokerSessionLifecycleService } from "../sdk/lifecycle/broker-client";
import { attemptSessionClaim, claimRefusal, type ResolvedSessionOwnership } from "./internal/session-claim-set";
import type { SessionHeldError, SessionOwnerClaim } from "./session-ownership";

/** The host Continue here closes: its index row's endpoint authority, and where remote clients look for it. */
export interface SessionHandoverTarget {
	readonly sessionId: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly endpointGeneration: number;
	readonly endpointIncarnation: string;
}

/**
 * `closed`: the host exited and this process holds the claim (`undefined` only when claims fail
 * open); the caller keeps it until its own open or switch has claimed, then releases it.
 */
export type SessionHandoverOutcome =
	| { readonly kind: "closed"; readonly claim: SessionOwnerClaim | undefined }
	| { readonly kind: "refused"; readonly message: string };

export const SESSION_HANDOVER_BUSY_MESSAGE = "The session is running a turn; try again when it finishes.";

const HANDOVER_ACTOR = { id: "gjc-continue-here", namespace: "session:handover" } as const;
/** This process's generation-0 index row for the session while it takes it over. */
interface FenceRow {
	readonly sessionId: string;
	readonly locator: SessionLocatorV2;
	readonly endpointGeneration: 0;
	readonly pid: number;
	readonly processIncarnation?: string;
}
/** An idle close waits up to three bounded teardown windows (graceful, SIGTERM, SIGKILL) before it answers. */
const HANDOVER_CLOSE_TIMEOUT_MS = 30_000;

/**
 * The host Continue here can close for `error`, or `undefined` when it is not offered: the holder
 * must be the live, broker-launched host in the session index (its row carries a
 * `lifecycleRequestId`, design §13 L1), not a terminal, the app or an embedding. The surface label
 * in the holder record does not decide it.
 */
export async function findSessionHandoverTarget(
	error: SessionHeldError,
	agentDir: string,
): Promise<SessionHandoverTarget | undefined> {
	const holder = error.holder;
	if (!holder || holder.host !== undefined) return undefined;
	try {
		const index = new SessionIndex(agentDir);
		await index.refresh();
		const row = index
			.listSessions(undefined, new Set([error.sessionId]))
			.sessions.find(session => session.sessionId === error.sessionId);
		if (!row?.live || row.lifecycleRequestId === undefined || row.pid !== holder.pid) return undefined;
		const incarnation = endpointIncarnation(row, error.sessionId);
		if (!incarnation) return undefined;
		return {
			sessionId: error.sessionId,
			agentDir,
			cwd: row.locator.cwd,
			endpointGeneration: row.endpointGeneration,
			endpointIncarnation: incarnation,
		};
	} catch (failure) {
		logger.warn("Could not read the session index for Continue here", { error: String(failure) });
		return undefined;
	}
}

/**
 * Hand the session over to this process (design §13 L1):
 * 1. A generation-0 row for this process fences the gap, so a remote resume after the host exits
 *    sees the session live and waits instead of launching another host.
 * 2. The broker closes the host only between turns (`ifIdle`, atomic in the host); a running turn
 *    or work lease answers `busy`. It answers once the host process has exited.
 * 3. This process claims the session. From here the broker's resume waits on the claim until this
 *    process publishes its endpoint, so the fence row is withdrawn on every outcome.
 *
 * The host is looked up again on every attempt, so a retry after `busy` uses its current endpoint
 * authority; a host that has exited meanwhile leaves only the claim to take.
 */
export async function handOverSession(
	error: SessionHeldError,
	agentDir: string,
	ownership: ResolvedSessionOwnership,
): Promise<SessionHandoverOutcome> {
	const target = await findSessionHandoverTarget(error, agentDir);
	if (!target) return await claimHandedOver(error.sessionId, ownership);
	const index = new SessionIndex(agentDir);
	const incarnation = processIncarnation(process.pid);
	// Set before the append: an append can reject after its row is durable, so a row that was only
	// attempted is withdrawn too.
	let fence: FenceRow | undefined;
	try {
		fence = {
			sessionId: target.sessionId,
			locator: await resolveSessionLocator(target.cwd, agentDir),
			endpointGeneration: 0,
			pid: process.pid,
			...(incarnation ? { processIncarnation: incarnation } : {}),
		};
		await index.append({ type: "host_registered", ...fence });
	} catch (failure) {
		logger.warn("Continue here could not fence the session handover", { error: String(failure) });
		if (fence) await withdrawFence(index, fence);
		return { kind: "refused", message: "The session index could not be updated to hand the session over." };
	}
	try {
		return (await closeIdleHost(target)) ?? (await claimHandedOver(target.sessionId, ownership));
	} catch (failure) {
		logger.warn("Continue here could not claim the session", { error: String(failure) });
		return { kind: "refused", message: "The session host closed, but this terminal could not claim the session." };
	} finally {
		await withdrawFence(index, fence);
	}
}

/** Withdraw the fence row, retrying lock contention as the direct-session registration does. */
async function withdrawFence(index: SessionIndex, fence: FenceRow): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await index.append({ type: "host_unregistered", ...fence });
			return;
		} catch (failure) {
			if (!isTransientSessionIndexLockError(failure) || attempt >= DIRECT_SESSION_REGISTRATION_ATTEMPTS) {
				logger.warn("Could not withdraw the Continue here fence row", { error: String(failure) });
				return;
			}
			await Bun.sleep(50 * attempt);
		}
	}
}

async function claimHandedOver(
	sessionId: string,
	ownership: ResolvedSessionOwnership,
): Promise<SessionHandoverOutcome> {
	const attempt = await attemptSessionClaim(ownership, sessionId);
	const refusal = claimRefusal(ownership, sessionId, attempt);
	if (refusal) return { kind: "refused", message: refusal.operatorMessage };
	return { kind: "closed", claim: attempt.status === "claimed" ? attempt.claim : undefined };
}

async function closeIdleHost(target: SessionHandoverTarget): Promise<SessionHandoverOutcome | undefined> {
	try {
		const outcome = await createBrokerSessionLifecycleService(target.agentDir).close({
			actor: HANDOVER_ACTOR,
			capability: "session.close",
			// A fresh key per attempt: the broker replays a recorded refusal for a reused one.
			requestKey: `continue-here:${target.sessionId}:${randomUUID()}`,
			target: {
				sessionId: target.sessionId,
				endpointGeneration: target.endpointGeneration,
				endpointIncarnation: target.endpointIncarnation,
				ifIdle: true,
			},
			timeoutMs: HANDOVER_CLOSE_TIMEOUT_MS,
		});
		if (outcome.ok) return undefined;
		if (outcome.error.code === "busy") return { kind: "refused", message: SESSION_HANDOVER_BUSY_MESSAGE };
		logger.warn("Continue here: the broker did not close the session host", { code: outcome.error.code });
		return { kind: "refused", message: `The session host could not be closed (${outcome.error.code}).` };
	} catch (failure) {
		logger.warn("Continue here: the session close request failed", { error: String(failure) });
		return { kind: "refused", message: "The session host could not be reached to close it." };
	}
}
