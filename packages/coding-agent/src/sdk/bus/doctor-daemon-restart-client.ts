/**
 * Doctor-side caller for the owner-driven daemon restart protocol (D8).
 *
 * The owner already implements prepare/commit/cancel against its own admission
 * fence and occupancy (`chat-daemon-cli.ts`, `telegram-daemon-cli.ts`); this
 * module is the counterpart that a `gjc doctor --fix --repair
 * service.restart-owned` invocation drives. It never signals, kills, or reloads
 * anything: the only lever is the durable control request the owner polls, and
 * the only proof of the owner's exit is a positive kernel observation of its
 * exact incarnation.
 *
 * The successor is started through the product's own sanctioned start path,
 * never a doctor-private spawn, so the existing startup exclusion stays the
 * single authority for who may own the slot.
 */
import { randomUUID } from "node:crypto";
import type { Settings } from "../../config/settings";
import { observeProcessIncarnation } from "../broker/process-incarnation";
import {
	type ChatDaemonKind,
	type ChatDaemonState,
	chatDaemonGeneration,
	clearChatDoctorControlRequest,
	ensureDiscordDaemon,
	ensureSlackDaemon,
	readChatDaemonState,
	readChatDoctorControlRequest,
	writeChatDoctorControlRequest,
} from "./chat-daemon-control";
import type { DoctorDaemonControlRequest, DoctorDaemonIdentity, DoctorDaemonOwner } from "./doctor-daemon-restart";
import { ensureTelegramDaemonRunning, readDaemonState } from "./telegram-daemon";
import { DAEMON_GENERATION } from "./telegram-daemon-contract";
import {
	clearTelegramDoctorControlRequest,
	readTelegramDoctorControlRequest,
	writeTelegramDoctorControlRequest,
} from "./telegram-daemon-control";

/**
 * Per-owner adapter over the two control-file surfaces. Both owners implement
 * the same prepare/commit/cancel protocol; only the accessor signatures and the
 * sanctioned start path differ, so this is a shape adapter, never a second
 * protocol.
 */
/**
 * A published owner this doctor can drive, an owner that predates the current
 * restart protocol (which requires the disclosed one-time manual transition and
 * must never be signalled), or no record at all. The three are distinct: a
 * pre-protocol incumbent is present and must not be reported as absent.
 */
type OwnerObservation =
	| { readonly kind: "current"; readonly pid: number; readonly identity: DoctorDaemonIdentity }
	| { readonly kind: "pre_protocol" }
	| { readonly kind: "absent" };

interface OwnerAdapter {
	readonly owner: DoctorDaemonOwner;
	observe(): Promise<OwnerObservation>;
	read(): Promise<DoctorDaemonControlRequest | undefined>;
	write(request: DoctorDaemonControlRequest): Promise<void>;
	clear(requestId: string): Promise<void>;
	/** The product's own sanctioned start path; never a doctor-private spawn. */
	start(): Promise<boolean>;
}

const POLL_MS = 100;
const DEFAULT_DEADLINE_MS = 30_000;

export interface DoctorDaemonRestartOptions {
	readonly agentDir: string;
	readonly owner: DoctorDaemonOwner;
	readonly settings: Settings;
	readonly requestId?: string;
	readonly deadlineMs?: number;
	/** Bounded natural-completion wait; idle attached sessions still count as workload. */
	readonly drainSeconds?: number;
}

/**
 * Typed before/after-effect outcome. Every refusal names the exact stage it
 * stopped at, so a caller never has to infer whether an effect began.
 */
export type DoctorDaemonRestartOutcome =
	| {
			kind: "restarted";
			requestId: string;
			oldOwner: DoctorDaemonIdentity;
			successor: DoctorDaemonIdentity;
			adopted: boolean;
	  }
	| { kind: "owner_unavailable"; reason: "no_state" | "owner_not_confirmed_live" | "unsupported_incumbent_protocol" }
	| { kind: "prepare_refused"; reason: "control_write_failed" | "not_acknowledged" }
	// The owner enforces occupancy itself and simply does not exit while work
	// remains, which this client observes as `old_owner_exit_timeout`. A failed
	// commit here therefore means only that the durable request could not be
	// written, and must not claim to describe occupancy.
	| { kind: "commit_refused"; reason: "control_write_failed" }
	| { kind: "old_owner_exit_timeout"; requestId: string; oldOwner: DoctorDaemonIdentity }
	| {
			kind: "successor_refused";
			requestId: string;
			oldOwner: DoctorDaemonIdentity;
			reason: "start_refused" | "publication_timeout";
	  };

function identityOf(owner: DoctorDaemonOwner, state: ChatDaemonState): DoctorDaemonIdentity {
	return { owner, ownerId: state.ownerId, generation: state.generation, incarnation: state.incarnation };
}

function chatAdapter(options: DoctorDaemonRestartOptions, kind: ChatDaemonKind): OwnerAdapter {
	return {
		owner: kind,
		async observe(): Promise<OwnerObservation> {
			const state = await readChatDaemonState(options.agentDir, kind);
			if (!state || state.stoppedAt !== undefined) return { kind: "absent" };
			// Present but older than the current restart protocol: the operator must
			// perform the disclosed one-time manual transition; doctor never signals it.
			if (state.generation !== chatDaemonGeneration(kind)) return { kind: "pre_protocol" };
			return { kind: "current", pid: state.pid, identity: identityOf(kind, state) };
		},
		read: () => readChatDoctorControlRequest(options.agentDir, kind),
		write: request => writeChatDoctorControlRequest(options.agentDir, kind, request),
		clear: requestId => clearChatDoctorControlRequest(options.agentDir, kind, requestId),
		async start() {
			const ensured =
				kind === "discord"
					? await ensureDiscordDaemon(options.settings)
					: await ensureSlackDaemon(options.settings);
			return ensured !== "disabled";
		},
	};
}

function telegramAdapter(options: DoctorDaemonRestartOptions): OwnerAdapter {
	const settings = options.settings;
	return {
		owner: "telegram",
		async observe(): Promise<OwnerObservation> {
			const state = await readDaemonState(settings);
			if (!state || state.stoppedAt !== undefined) return { kind: "absent" };
			if (state.generation !== DAEMON_GENERATION) return { kind: "pre_protocol" };
			// A provisional owner is physically live but not attachable as ready, so it
			// is not a restartable incumbent.
			if (state.ownershipPhase !== undefined && state.ownershipPhase !== "ready") return { kind: "absent" };
			return {
				kind: "current",
				pid: state.pid,
				identity: {
					owner: "telegram",
					ownerId: state.ownerId,
					generation: state.generation,
					incarnation: state.incarnation,
				},
			};
		},
		read: () => readTelegramDoctorControlRequest(settings),
		write: request => writeTelegramDoctorControlRequest(settings, request),
		clear: requestId => clearTelegramDoctorControlRequest(settings, requestId),
		async start() {
			// The product's own ensure path resolves the configured destination and
			// holds the existing setup lease; doctor never supplies a token or chat and
			// never refreshes a credential.
			const ensured = await ensureTelegramDaemonRunning({ settings });
			return ensured === "owner_spawned" || ensured === "attached";
		},
	};
}

/** Positive kernel absence only: a changed or missing record is never death proof. */
function confirmedExited(pid: number, incarnation: string): boolean {
	const observation = observeProcessIncarnation(pid);
	if (observation.status === "absent") return true;
	// A live pid whose incarnation differs is a reused pid, so the original
	// incarnation is genuinely gone; `unknown` stays inconclusive.
	return observation.status === "present" && observation.incarnation !== incarnation;
}

async function request(
	adapter: OwnerAdapter,
	identity: DoctorDaemonIdentity,
	requestId: string,
	action: DoctorDaemonControlRequest["action"],
	leaseExpiresAt: number,
): Promise<boolean> {
	try {
		await adapter.write({ version: 1, requestId, action, leaseExpiresAt, createdAt: Date.now(), ...identity });
		return true;
	} catch {
		return false;
	}
}

/**
 * Owner-side prepare/commit, positive-exit-confirmed cleanup, then exactly one
 * successor started through the product's own ensure path.
 *
 * Ordering is fixed: prepare (owner closes admission) → occupancy settles →
 * commit → owner exits under its own gate → positive absence proof → successor
 * start or adoption. A commit is never issued before the owner acknowledged the
 * prepare, and a successor is never started before the predecessor is proven
 * gone.
 */
export async function restartDaemonForDoctor(options: DoctorDaemonRestartOptions): Promise<DoctorDaemonRestartOutcome> {
	const adapter = options.owner === "telegram" ? telegramAdapter(options) : chatAdapter(options, options.owner);
	const deadlineAt = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
	const before = await adapter.observe();
	if (before.kind === "pre_protocol") return { kind: "owner_unavailable", reason: "unsupported_incumbent_protocol" };
	if (before.kind === "absent") return { kind: "owner_unavailable", reason: "no_state" };
	if (confirmedExited(before.pid, before.identity.incarnation))
		return { kind: "owner_unavailable", reason: "owner_not_confirmed_live" };
	const identity = before.identity;
	const requestId = options.requestId ?? randomUUID();
	if (!(await request(adapter, identity, requestId, "prepare", deadlineAt)))
		return { kind: "prepare_refused", reason: "control_write_failed" };

	// The owner consumes a prepare without rewriting it, so the request simply
	// staying present proves nothing: this process wrote it. What IS observable to
	// a non-parent caller is that the owner remains the same live incarnation that
	// can still act on it. A request that outlives its own owner, or that a third
	// party removed, is never treated as accepted.
	const drainUntil = Date.now() + (options.drainSeconds ?? 0) * 1_000;
	let acknowledged = false;
	while (Date.now() < deadlineAt) {
		const current = await adapter.read();
		if (current?.requestId !== requestId) break;
		const owner = await adapter.observe();
		if (owner.kind !== "current" || owner.identity.incarnation !== identity.incarnation) break;
		if (!confirmedExited(before.pid, identity.incarnation)) {
			acknowledged = true;
			break;
		}
		await Bun.sleep(POLL_MS);
	}
	if (!acknowledged) {
		// An owner that already consumed the prepare has closed admission, and only a
		// `cancel` under the same request id reopens it — deleting the control file
		// reopens nothing and would strand a healthy daemon refusing all work. Cancel
		// when the addressed owner is still there (it unlinks the file itself);
		// otherwise there is nobody to reopen and the stale file is just removed.
		const owner = await adapter.observe();
		if (owner.kind === "current" && owner.identity.incarnation === identity.incarnation)
			await request(adapter, identity, requestId, "cancel", deadlineAt);
		else await adapter.clear(requestId);
		return { kind: "prepare_refused", reason: "not_acknowledged" };
	}

	// `--drain` is bounded natural completion only. The owner itself refuses the
	// commit while any workload remains (an idle attached session counts), so this
	// wait never detaches or retires anything on its behalf.
	if (Date.now() < drainUntil)
		await Bun.sleep(Math.min(drainUntil - Date.now(), Math.max(0, deadlineAt - Date.now())));

	if (!(await request(adapter, identity, requestId, "commit", deadlineAt))) {
		await adapter.clear(requestId);
		return { kind: "commit_refused", reason: "control_write_failed" };
	}

	while (Date.now() < deadlineAt) {
		if (confirmedExited(before.pid, identity.incarnation)) break;
		await Bun.sleep(POLL_MS);
	}
	if (!confirmedExited(before.pid, identity.incarnation))
		// The commit is durable and the owner may still retire under its own gate;
		// never cancel it here and never force the exit.
		return { kind: "old_owner_exit_timeout", requestId, oldOwner: identity };

	// An already-published successor of the same generation is adopted rather than
	// starting a second one.
	const published = await adapter.observe();
	if (published.kind === "current" && published.identity.incarnation !== identity.incarnation) {
		await adapter.clear(requestId);
		return { kind: "restarted", requestId, oldOwner: identity, successor: published.identity, adopted: true };
	}

	try {
		if (!(await adapter.start()))
			return { kind: "successor_refused", requestId, oldOwner: identity, reason: "start_refused" };
	} catch {
		return { kind: "successor_refused", requestId, oldOwner: identity, reason: "start_refused" };
	}

	while (Date.now() < deadlineAt) {
		const successor = await adapter.observe();
		if (successor.kind === "current" && successor.identity.incarnation !== identity.incarnation) {
			await adapter.clear(requestId);
			return { kind: "restarted", requestId, oldOwner: identity, successor: successor.identity, adopted: false };
		}
		await Bun.sleep(POLL_MS);
	}
	return { kind: "successor_refused", requestId, oldOwner: identity, reason: "publication_timeout" };
}
