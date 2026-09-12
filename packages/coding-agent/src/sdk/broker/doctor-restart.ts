import { randomUUID } from "node:crypto";
import { SdkClient, SdkClientError } from "../client/client";
import type {
	BrokerRestartCommitOptions,
	BrokerRestartOwnerIdentity,
	BrokerRestartPrepareOptions,
	BrokerRestartPrepareResult,
	BrokerRestartResult,
} from "./broker";
import { launchAuthorizedBrokerSuccessor, oldOwnerConfirmedExited } from "./daemon-entry";
import { type BrokerDiscovery, readBrokerDiscovery } from "./discovery";

export interface DoctorBrokerRestartOptions {
	agentDir: string;
	deadlineMs?: number;
	drain?: boolean;
	requestId?: string;
}

/**
 * Concrete typed before/after-effect outcome of a full D8 broker restart
 * attempt. Every refusal names the exact stage and, where the broker itself
 * refused, the broker's own typed error code -- never an opaque thrown
 * message standing in for a decision this adapter could name.
 */
export type DoctorBrokerRestartOutcome =
	| {
			kind: "restarted";
			requestId: string;
			oldOwner: BrokerRestartOwnerIdentity;
			successor: BrokerDiscovery;
			/** True when an already-committed successor for this exact request was found and reused, not spawned. */
			adopted: boolean;
	  }
	| { kind: "owner_unavailable"; reason: "no_discovery" | "owner_not_confirmed_live" }
	| { kind: "prepare_refused"; code: string; message: string }
	| { kind: "commit_refused"; code: string; message: string }
	| { kind: "old_owner_exit_timeout"; requestId: string; oldOwner: BrokerRestartOwnerIdentity }
	| {
			kind: "successor_refused";
			requestId: string;
			oldOwner: BrokerRestartOwnerIdentity;
			reason:
				| "deadline_elapsed"
				| "intent_not_committed"
				| "spawn_failed"
				| "spawn_exited_before_publication"
				| "publication_timeout";
			detail?: string;
	  };

function identity(discovery: BrokerDiscovery): BrokerRestartOwnerIdentity {
	return {
		ownerId: discovery.ownerId,
		generation: discovery.packageGeneration,
		pid: discovery.pid,
		incarnation: discovery.incarnation,
	};
}

function typedResult(response: unknown): BrokerRestartResult {
	if (response && typeof response === "object" && "ok" in response) return response as BrokerRestartResult;
	return { ok: false, error: { code: "protocol_error", message: "broker returned a malformed restart response" } };
}

export async function prepareDoctorBrokerRestart(
	client: SdkClient,
	discovery: BrokerDiscovery,
	options: DoctorBrokerRestartOptions & { requestId: string },
): Promise<BrokerRestartResult> {
	const input: BrokerRestartPrepareOptions = {
		...identity(discovery),
		requestId: options.requestId,
		deadlineAt: Date.now() + (options.deadlineMs ?? 30_000),
		drain: options.drain,
	};
	return typedResult(await client.global("broker.prepare_restart", { ...input }));
}

export async function commitDoctorBrokerRestart(
	client: SdkClient,
	discovery: BrokerDiscovery,
	prepared: BrokerRestartPrepareResult,
	requestId: string,
): Promise<BrokerRestartResult> {
	const input: BrokerRestartCommitOptions = {
		...identity(discovery),
		requestId,
		deadlineAt: prepared.expiresAt,
		lease: prepared.lease,
		occupancyEpoch: prepared.occupancyEpoch,
	};
	return typedResult(await client.global("broker.commit_restart", { ...input }));
}

export async function cancelDoctorBrokerRestart(client: SdkClient, requestId: string): Promise<BrokerRestartResult> {
	return typedResult(await client.global("broker.cancel_restart", { requestId }));
}

const OLD_OWNER_EXIT_POLL_MS = 50;

/**
 * Owner-side prepare/commit/stop, positive-exit-confirmed cleanup, then
 * exactly one successor launch or adoption. The exact sequence:
 *
 * 1. Read the CURRENT discovery snapshot (never a stale caller-supplied one)
 *    and prove its owner is live via a real connected client, not an
 *    incarnation string comparison alone.
 * 2. `prepare_restart` against that exact owner tuple/generation; on any
 *    prepare refusal, cancel the reservation and return the broker's own
 *    typed refusal rather than throwing.
 * 3. `commit_restart` with the exact lease/occupancyEpoch prepare returned.
 *    Once committed, the owner is durably retiring: cancellation is no longer
 *    safe and this function must never call cancel past this point.
 * 4. Close the client (every path below runs with the client closed).
 * 5. Wait, bounded by the request deadline, for `observeProcessIncarnation`
 *    to positively confirm the exact old pid is OS-absent -- never inferred
 *    from a changed/missing incarnation read, and never from discovery
 *    disappearing (a crashed writer can leave a stale discovery file behind
 *    just as easily as a clean exit can remove it).
 * 6. Launch (or adopt an already-published) exactly one successor for this
 *    requestId, holding the shared startup exclusion only around the launch
 *    decision itself -- never across the successor's own publication wait,
 *    which would deadlock this process against its own spawned child.
 *
 * The successor clears the durable committed intent itself, from inside its
 * own `Broker#start()`, only after its own publication has independently
 * proven it owns the root -- never here, and never before that proof exists.
 */
export async function restartBrokerForDoctor(options: DoctorBrokerRestartOptions): Promise<DoctorBrokerRestartOutcome> {
	const old = await readBrokerDiscovery(options.agentDir);
	if (!old) return { kind: "owner_unavailable", reason: "no_discovery" };
	const oldOwner = identity(old);
	const requestId = options.requestId ?? randomUUID();
	const deadlineMs = options.deadlineMs ?? 30_000;
	const deadlineAt = Date.now() + deadlineMs;

	let client: SdkClient;
	try {
		client = await SdkClient.connect(old.url, old.token, { timeoutMs: deadlineMs });
	} catch {
		return { kind: "owner_unavailable", reason: "owner_not_confirmed_live" };
	}

	let prepared: BrokerRestartPrepareResult | undefined;
	try {
		const prepareResult = await prepareDoctorBrokerRestart(client, old, { ...options, requestId });
		if (!prepareResult.ok)
			return { kind: "prepare_refused", code: prepareResult.error.code, message: prepareResult.error.message };
		prepared = prepareResult.result as BrokerRestartPrepareResult;

		const commitResult = await commitDoctorBrokerRestart(client, old, prepared, requestId);
		if (!commitResult.ok) {
			// A commit refusal leaves the owner's own reservation in place; the
			// owner's lease-expiry timer (or an explicit cancel by the same
			// requestId) is what releases it, never a resurrect-old-owner retry
			// from here.
			try {
				await cancelDoctorBrokerRestart(client, requestId);
			} catch {
				// Best-effort: an unreachable owner past a refused commit still
				// self-expires its own lease.
			}
			return { kind: "commit_refused", code: commitResult.error.code, message: commitResult.error.message };
		}
	} catch (caught) {
		throw caught instanceof SdkClientError
			? caught
			: new Error(
					`SDK broker restart prepare/commit failed: ${caught instanceof Error ? caught.message : String(caught)}`,
					{
						cause: caught,
					},
				);
	} finally {
		await client.close().catch(() => undefined);
	}

	// Committed: the owner is durably retiring. Wait for its exact OS
	// incarnation to be positively confirmed absent before authorizing any
	// successor -- never inferred from discovery disappearing or from a
	// PID-reuse-vulnerable incarnation mismatch alone.
	while (Date.now() < deadlineAt) {
		if (oldOwnerConfirmedExited(oldOwner.pid)) break;
		await Bun.sleep(OLD_OWNER_EXIT_POLL_MS);
	}
	if (!oldOwnerConfirmedExited(oldOwner.pid)) return { kind: "old_owner_exit_timeout", requestId, oldOwner };

	const successor = await launchAuthorizedBrokerSuccessor({
		agentDir: options.agentDir,
		requestId,
		deadlineAt: prepared!.expiresAt,
		packageGeneration: old.packageGeneration,
	});
	if (successor.kind === "refused")
		return { kind: "successor_refused", requestId, oldOwner, reason: successor.reason, detail: successor.detail };
	return {
		kind: "restarted",
		requestId,
		oldOwner,
		successor: successor.discovery,
		adopted: successor.kind === "adopted",
	};
}

export type { BrokerRestartResult };
