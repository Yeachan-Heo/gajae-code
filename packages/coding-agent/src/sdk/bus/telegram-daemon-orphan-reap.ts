import * as path from "node:path";
import { isProcessIncarnation } from "../broker/process-incarnation";
import type { TelegramDaemonFs } from "./telegram-daemon";
import {
	listTelegramOwnerMarkers,
	removeTelegramOwnerMarker,
	type TelegramOwnerMarker,
} from "./telegram-daemon-owner-registry";

/**
 * A stable, identity-bound reference to a process opened BEFORE the incarnation
 * check and used for ALL subsequent operations. This closes the PID-reuse race:
 * the native handle pins the exact process incarnation, so a reused PID cannot
 * be signaled through a stale reference — the OS will reject the operation.
 *
 * `signalRoot` signals only the pinned root process (root-only).
 * `terminateTree` signals the process AND its descendants / process group.
 */
export interface TelegramOrphanProcessRef {
	/** The incarnation of the process this reference was opened against. */
	incarnation: string;
	/**
	 * Gracefully terminate this process and its entire descendant tree / process
	 * group (TERM → wait → KILL escalation). Returns true if the process (and
	 * its children) exited within the bounded wait.
	 */
	terminateTree(signal?: NodeJS.Signals): boolean;
}

export interface TelegramOrphanReapDeps {
	fs?: TelegramDaemonFs;
	now?: () => number;
	pidAlive: (pid: number) => boolean;
	pidIncarnation: (pid: number) => string | undefined;
	/**
	 * Opens a stable process reference bound to the exact process incarnation at
	 * open time. The reference must be opened BEFORE the incarnation check so
	 * that termination operates on the same identity that was proven stale.
	 */
	processReference?: (pid: number) => TelegramOrphanProcessRef | undefined;
	platform?: NodeJS.Platform;
}

export interface TelegramOrphanCandidate {
	marker: TelegramOwnerMarker;
	executablePath?: string;
	argv?: string[];
}

export type OrphanReapDecision =
	| { kind: "reaped"; pid: number; acquisitionId: string }
	| { kind: "refused"; pid: number; acquisitionId: string; reason: string }
	| { kind: "inert"; pid: number; acquisitionId: string };

export interface TelegramOrphanRecoveryReceipt {
	version: 1;
	agentDir: string;
	currentOwnerId: string;
	currentAcquisitionId: string;
	currentPid: number;
	createdAt: number;
	candidates: number;
	terminated: number;
	refused: number;
	inert: number;
	// bounded, secret-free
	reasons: Record<string, number>;
	// no command lines, tokens, chatIds, env dumps
}

/**
 * Maximum number of candidate markers the sweep will inspect and attempt to
 * reap. A runaway registry cannot turn the sweep into unbounded wall time.
 */
const MAX_REAP_CANDIDATES = 64;

/** Bounded cooperative-termination wait before escalating to hard kill (ms). */
const TERM_GRACE_MS = 2_000;
/** Bounded hard-kill wait before declaring termination failed (ms). */
const KILL_WAIT_MS = 1_500;

/**
 * Identity-bound, process-group-aware termination.
 *
 * Uses the stable process reference (opened before the incarnation check) so
 * that a reused PID cannot be signaled through a stale handle. The native
 * `terminateTree` signals the process AND its descendants / process group,
 * proving complete owned process-group cleanup rather than root-only signal.
 *
 * Falls back to POSIX `process.kill(-pgid)` when a native reference is
 * unavailable, attempting the negative-pid group signal first.
 */
async function terminateOwnedProcessTree(
	pid: number,
	ref: TelegramOrphanProcessRef | undefined,
	deps: TelegramOrphanReapDeps,
): Promise<boolean> {
	// Preferred path: native stable reference with process-group termination.
	if (ref) {
		try {
			const exited = await boundedTerminationWait(pid, deps, () => {
				try {
					return ref.terminateTree("SIGTERM");
				} catch {
					return false;
				}
			});
			if (exited) return true;
			// Escalate to hard kill via the same stable reference.
			try {
				ref.terminateTree("SIGKILL");
			} catch {
				return !deps.pidAlive(pid);
			}
			return await boundedTerminationWait(pid, deps, () => false, KILL_WAIT_MS);
		} catch {
			return !deps.pidAlive(pid);
		}
	}

	// Fallback: POSIX process-group signal via negative-pid.
	try {
		try {
			process.kill(-pid, "SIGTERM");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return true;
			// EPERM or ESRCH on the group: try root-only signal as last resort.
			try {
				process.kill(pid, "SIGTERM");
			} catch (e2) {
				if ((e2 as NodeJS.ErrnoException).code === "ESRCH") return true;
				return false;
			}
		}
		const exited = await boundedTerminationWait(pid, deps, () => false);
		if (exited) return true;
		try {
			process.kill(-pid, "SIGKILL");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return true;
			try {
				process.kill(pid, "SIGKILL");
			} catch (e2) {
				if ((e2 as NodeJS.ErrnoException).code === "ESRCH") return true;
				return false;
			}
		}
		return await boundedTerminationWait(pid, deps, () => false, KILL_WAIT_MS);
	} catch {
		return false;
	}
}

/**
 * Poll process liveness within a bounded deadline. The optional `signalFn`
 * fires the initial signal; it is called once, then liveness is polled.
 * Incarnation drift also proves exit (the reference's process is gone even if
 * the PID was reused).
 */
async function boundedTerminationWait(
	pid: number,
	deps: TelegramOrphanReapDeps,
	signalFn: () => boolean,
	budgetMs = TERM_GRACE_MS,
): Promise<boolean> {
	signalFn();
	const clock = deps.now ?? Date.now;
	const deadline = clock() + budgetMs;
	const step = Math.max(Math.floor(budgetMs / 40), 25);
	while (clock() < deadline) {
		if (!deps.pidAlive(pid)) return true;
		await new Promise<void>(r => setTimeout(r, step));
	}
	return !deps.pidAlive(pid);
}

/**
 * Bounded stale-owner sweep. Authorizes termination only from product-owned
 * marker registry bound to exact agentDir digest + acquisitionId + pid + incarnation.
 * Never authorizes from bare /proc cmdline similarity; markers are the trust anchor.
 *
 * Safety invariants:
 * 1. The stable process reference is opened BEFORE the incarnation check and
 *    used for termination, so a reused PID cannot be signaled through a stale
 *    handle.
 * 2. Process-group termination (not root-only signal) ensures reparented
 *    descendants of an orphaned daemon are also cleaned up.
 * 3. Zombies and dead processes are classified inert without any signaling.
 * 4. The sweep is bounded: at most MAX_REAP_CANDIDATES markers are inspected.
 */
export async function reapTelegramDaemonOrphans(input: {
	agentDir: string;
	currentOwnerId: string;
	currentAcquisitionId: string;
	currentPid: number;
	currentIncarnation: string;
	fsImpl: TelegramDaemonFs;
	deps: TelegramOrphanReapDeps;
}): Promise<{ decisions: OrphanReapDecision[]; receipt: TelegramOrphanRecoveryReceipt }> {
	const fsImpl = input.fsImpl;
	const deps = input.deps;
	const candidates = await listTelegramOwnerMarkers(fsImpl, input.agentDir);
	const decisions: OrphanReapDecision[] = [];
	const reasons: Record<string, number> = {};
	let terminated = 0;
	let refused = 0;
	let inert = 0;

	// Bound the sweep: process at most MAX_REAP_CANDIDATES markers.
	const bounded = candidates.slice(0, MAX_REAP_CANDIDATES);

	for (const entry of bounded) {
		if (!entry.marker) {
			decisions.push({
				kind: "refused",
				pid: -1,
				acquisitionId: entry.acquisitionId,
				reason: "malformed_or_foreign",
			});
			refused += 1;
			reasons.malformed_or_foreign = (reasons.malformed_or_foreign ?? 0) + 1;
			continue;
		}
		const m = entry.marker;
		if (
			m.acquisitionId === input.currentAcquisitionId &&
			m.ownerId === input.currentOwnerId &&
			m.pid === input.currentPid &&
			m.incarnation === input.currentIncarnation
		) {
			// current owner — never signal
			continue;
		}
		// Skip markers whose pid/incarnation proves they are the current live owner
		if (m.pid === input.currentPid && m.incarnation === input.currentIncarnation) {
			decisions.push({ kind: "refused", pid: m.pid, acquisitionId: m.acquisitionId, reason: "current_incarnation" });
			refused += 1;
			reasons.current_incarnation = (reasons.current_incarnation ?? 0) + 1;
			continue;
		}
		// Open the stable process reference BEFORE the incarnation check.
		// This pins the exact process identity for all subsequent operations.
		const ref = deps.processReference?.(m.pid);

		// Require stable incarnation authority; if unavailable fail closed.
		// BUT: if pidAlive says absent, classify as inert (dead/zombie) without signaling.
		if (!deps.pidAlive(m.pid)) {
			// Process is dead or a zombie — inert, never signal.
			decisions.push({ kind: "inert", pid: m.pid, acquisitionId: m.acquisitionId });
			inert += 1;
			// Clean stale marker for absent/dead pid.
			await removeTelegramOwnerMarker(fsImpl, input.agentDir, m.acquisitionId).catch(() => undefined);
			continue;
		}
		const curIncarnation = deps.pidIncarnation(m.pid);
		if (!isProcessIncarnation(curIncarnation)) {
			// Without stable proof of incarnation, fail closed — do not signal.
			decisions.push({
				kind: "refused",
				pid: m.pid,
				acquisitionId: m.acquisitionId,
				reason: "incarnation_unavailable",
			});
			refused += 1;
			reasons.incarnation_unavailable = (reasons.incarnation_unavailable ?? 0) + 1;
			continue;
		}
		if (curIncarnation !== m.incarnation) {
			// PID reused — old owner is inert, marker is stale. Never signal a
			// live process that now belongs to a different incarnation.
			decisions.push({ kind: "inert", pid: m.pid, acquisitionId: m.acquisitionId });
			inert += 1;
			await removeTelegramOwnerMarker(fsImpl, input.agentDir, m.acquisitionId).catch(() => undefined);
			continue;
		}
		// Attempt bounded process-group TERM then KILL using the stable reference
		// opened before the incarnation check.
		const exited = await terminateOwnedProcessTree(m.pid, ref, deps);
		if (exited || !deps.pidAlive(m.pid)) {
			decisions.push({ kind: "reaped", pid: m.pid, acquisitionId: m.acquisitionId });
			terminated += 1;
			await removeTelegramOwnerMarker(fsImpl, input.agentDir, m.acquisitionId).catch(() => undefined);
		} else {
			decisions.push({ kind: "refused", pid: m.pid, acquisitionId: m.acquisitionId, reason: "termination_failed" });
			refused += 1;
			reasons.termination_failed = (reasons.termination_failed ?? 0) + 1;
		}
	}

	// If the registry exceeded the bound, record the overflow.
	if (candidates.length > MAX_REAP_CANDIDATES) {
		reasons.registry_overflow = candidates.length;
	}

	const receipt: TelegramOrphanRecoveryReceipt = {
		version: 1,
		agentDir: input.agentDir,
		currentOwnerId: input.currentOwnerId,
		currentAcquisitionId: input.currentAcquisitionId,
		currentPid: input.currentPid,
		createdAt: (deps.now ?? Date.now)(),
		candidates: candidates.length,
		terminated,
		refused,
		inert,
		reasons,
	};
	// Bound receipt: ensure secret-free (no tokens, no chatIds, no env)
	return { decisions, receipt };
}

export async function writeTelegramOrphanRecoveryReceipt(
	fsImpl: TelegramDaemonFs,
	agentDir: string,
	receipt: TelegramOrphanRecoveryReceipt,
): Promise<void> {
	const { daemonPaths } = await import("./daemon-paths");
	const file = daemonPaths(agentDir).recoveryReceipt;
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	// Bounded size: JSON stringify once, truncate to 4KiB if needed (secret-free so truncation is safe)
	let data = `${JSON.stringify(receipt, null, 2)}\n`;
	if (data.length > 4096) data = data.slice(0, 4096);
	await fsImpl.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }).catch(() => undefined);
	await fsImpl.writeFile(tmp, data, { mode: 0o600 });
	await fsImpl.chmod(tmp, 0o600).catch(() => undefined);
	await fsImpl.rename(tmp, file);
}
