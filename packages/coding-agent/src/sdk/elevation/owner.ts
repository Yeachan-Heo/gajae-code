import * as fs from "node:fs/promises";
import { isPidAlive } from "../broker/discovery";
import { isProcessIncarnation, processIncarnation } from "../broker/process-incarnation";

/**
 * Broker-owner principal.
 *
 * The elevation authority is the broker itself under the existing loopback
 * trust model: one local OS-user/broker authority derived entirely from
 * broker-owned state, never from caller input. `agentDirUid` is the uid that
 * owns the agent directory, `brokerPid`/`brokerIncarnation` identify the
 * broker process tenure so a restarted broker cannot attest the same
 * authority.
 */
export interface BrokerOwnerPrincipal {
	kind: "broker_owner";
	owner: {
		agentDirUid: number;
		brokerPid: number;
		brokerIncarnation: string;
	};
}

export function isBrokerOwnerPrincipal(value: unknown): value is BrokerOwnerPrincipal {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const principal = value as { kind?: unknown; owner?: unknown };
	if (principal.kind !== "broker_owner") return false;
	if (typeof principal.owner !== "object" || principal.owner === null) return false;
	const owner = principal.owner as { agentDirUid?: unknown; brokerPid?: unknown; brokerIncarnation?: unknown };
	return (
		Number.isSafeInteger(owner.agentDirUid) &&
		(owner.agentDirUid as number) >= 0 &&
		Number.isSafeInteger(owner.brokerPid) &&
		(owner.brokerPid as number) > 0 &&
		isProcessIncarnation(owner.brokerIncarnation)
	);
}

export function sameBrokerOwnerPrincipal(left: BrokerOwnerPrincipal, right: BrokerOwnerPrincipal): boolean {
	return (
		left.kind === right.kind &&
		left.owner.agentDirUid === right.owner.agentDirUid &&
		left.owner.brokerPid === right.owner.brokerPid &&
		left.owner.brokerIncarnation === right.owner.brokerIncarnation
	);
}

/**
 * Reads the broker-owner principal from broker-owned state. Throws when the
 * broker cannot attest a canonical process incarnation (the broker refuses to
 * start in that case anyway), so callers treat a throw as "authority
 * unavailable".
 */
export async function readBrokerOwnerPrincipal(
	agentDir: string,
	brokerPid: number,
	brokerIncarnation: string,
): Promise<BrokerOwnerPrincipal> {
	if (!Number.isSafeInteger(brokerPid) || brokerPid <= 0)
		throw new Error("Broker owner principal requires a live broker pid");
	if (!isProcessIncarnation(brokerIncarnation))
		throw new Error("Broker owner principal requires a canonical broker process incarnation");
	const stat = await fs.stat(agentDir);
	return {
		kind: "broker_owner",
		owner: {
			agentDirUid: stat.uid,
			brokerPid,
			brokerIncarnation,
		},
	};
}

export type ProcessIncarnationLiveness = "alive" | "dead" | "unknown";

/**
 * Tri-state liveness of a process incarnation.
 *
 * - `alive`: the pid is running and its current incarnation matches the
 *   stored one, so the original process tenure is still live.
 * - `dead`: ESRCH (the pid is provably gone — independent of any persisted
 *   incarnation text), or the pid is running under a *different* canonical
 *   incarnation (PID reuse), which provably means the original process
 *   ended.
 * - `unknown`: the pid is malformed, the persisted or observed incarnation
 *   is malformed/undefined, or the current incarnation cannot be read.
 *   Unknown never implies death: elevation claims must fail closed with
 *   `elevation_claim_in_progress` instead of terminalizing state on
 *   unprovable liveness.
 *
 * ESRCH is independent positive death proof: a pid that provably does not
 * exist is dead regardless of the persisted incarnation text, so a corrupt
 * persisted incarnation can never stall recovery forever.
 */
export function classifyProcessIncarnationLiveness(pid: unknown, incarnation: unknown): ProcessIncarnationLiveness {
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
	// ESRCH is positive death proof even with malformed persisted
	// incarnation text (AC-L6): the pid no longer exists, so the original
	// tenure provably ended and recovery may proceed.
	if (!isPidAlive(pid)) return "dead";
	// The pid is alive (or EPERM): a malformed/undefined persisted
	// incarnation cannot be compared, and a malformed/undefined observed
	// incarnation cannot be trusted, so liveness is unprovable. Unknown
	// never authorizes mutation.
	if (!isProcessIncarnation(incarnation)) return "unknown";
	const current = processIncarnation(pid);
	if (!isProcessIncarnation(current)) return "unknown";
	return current === incarnation ? "alive" : "dead";
}
