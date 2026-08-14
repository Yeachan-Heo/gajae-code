import * as path from "node:path";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { $ } from "bun";
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

/**
 * A pinned reference that can additionally prove the process's kernel-derived
 * launch arguments. Used only by the legacy-stray sweep: candidate PIDs come
 * from an untrusted enumeration, but every authorization fact (incarnation,
 * argv) is read from this pinned reference, never from the enumeration.
 */
export interface TelegramStrayProcessRef extends TelegramOrphanProcessRef {
	/** Launch arguments reported by the kernel for the pinned incarnation. */
	args(): string[];
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
	/**
	 * Enumerates candidate PIDs for the legacy-stray sweep. The list is
	 * untrusted discovery input only; authorization derives exclusively from
	 * the pinned {@link TelegramStrayProcessRef}. Defaults to a bounded POSIX
	 * `ps` listing; returns nothing on Windows or enumeration failure.
	 */
	listCandidatePids?: () => Promise<number[]>;
	/** Opens a pinned argv-capable reference for stray verification. */
	strayReference?: (pid: number) => TelegramStrayProcessRef | undefined;
	/**
	 * First-sighting ledger for stray confirmation, keyed by
	 * `pid|incarnation` with the first-seen timestamp. Injectable for tests;
	 * defaults to a process-lifetime module ledger.
	 */
	straySightings?: Map<string, number>;
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

/** Maximum PIDs the legacy-stray enumeration will inspect per sweep. */
const MAX_STRAY_SCAN_PIDS = 4096;
/** Maximum stray terminations per sweep; the rest wait for the next cadence. */
const MAX_STRAY_TERMINATIONS = 8;
/**
 * A stray must be sighted twice with the same pinned incarnation at least this
 * far apart before it may be terminated. A legitimate successor daemon reaches
 * ownership (and writes its marker) within seconds of spawning, so it can
 * never accumulate a confirmed unmarked sighting; a pre-registry zombie
 * persists across sweeps and is confirmed on the second one.
 */
const STRAY_CONFIRMATION_MS = 45_000;
/** Bounded size of the first-sighting ledger. */
const MAX_STRAY_SIGHTINGS = 256;

/** Process-lifetime default first-sighting ledger for the stray sweep. */
const moduleStraySightings = new Map<string, number>();

/**
 * Exact invocation-signature test for a legacy Telegram daemon owner:
 * a `notify daemon-internal` subcommand bound to exactly this agent dir.
 * This is deliberately an exact-token match on kernel-reported argv from a
 * pinned reference — never a substring similarity over an untrusted dump.
 */
export function isLegacyStrayDaemonArgs(args: readonly string[], agentDir: string): boolean {
	const resolvedAgentDir = path.resolve(agentDir);
	let hasSubcommand = false;
	let agentDirMatches = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "notify" && args[i + 1] === "daemon-internal") hasSubcommand = true;
		if (args[i] === "--agent-dir") {
			const value = args[i + 1];
			if (typeof value === "string" && path.resolve(value) === resolvedAgentDir) agentDirMatches = true;
		}
	}
	return hasSubcommand && agentDirMatches;
}

/** Bounded POSIX PID enumeration; empty on Windows or on any failure. */
async function defaultListCandidatePids(platform: NodeJS.Platform): Promise<number[]> {
	if (platform === "win32") return [];
	try {
		const out = await $`ps -axo pid=`.quiet().text();
		const pids: number[] = [];
		for (const line of out.split("\n")) {
			const pid = Number.parseInt(line.trim(), 10);
			if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
			if (pids.length >= MAX_STRAY_SCAN_PIDS) break;
		}
		return pids;
	} catch {
		return [];
	}
}

/** Default pinned argv-capable reference over the native process bindings. */
function defaultStrayReference(pid: number): TelegramStrayProcessRef | undefined {
	try {
		const ref = nativeProcessBindings().Process.fromPid(pid);
		if (!ref || !isProcessIncarnation(ref.incarnation)) return undefined;
		return {
			incarnation: ref.incarnation,
			args: () => {
				try {
					return ref.args();
				} catch {
					return [];
				}
			},
			terminateTree: (signal?: NodeJS.Signals) => {
				try {
					return ref.killTree(signal === "SIGKILL" ? 9 : 15) > 0;
				} catch {
					return false;
				}
			},
		};
	} catch {
		return undefined;
	}
}

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

	// Legacy-stray sweep: daemons spawned by builds that predate the marker
	// registry never registered a marker and may not own the state file, so the
	// marker sweep above cannot see them — they keep polling getUpdates and
	// 409-starve every fresh owner. Candidate PIDs come from an untrusted
	// enumeration; ALL authorization facts (incarnation, argv) come from the
	// pinned native reference. Termination additionally requires a confirmed
	// second sighting of the same pinned incarnation, so a legitimate successor
	// mid-handoff (which reaches ownership and writes its marker within
	// seconds) can never be killed.
	try {
		const markerPids = new Set<number>();
		for (const entry of candidates) if (entry.marker) markerPids.add(entry.marker.pid);
		const clock = deps.now ?? Date.now;
		const sightings = deps.straySightings ?? moduleStraySightings;
		const listPids = deps.listCandidatePids ?? (() => defaultListCandidatePids(deps.platform ?? process.platform));
		const strayRef = deps.strayReference ?? defaultStrayReference;
		const liveKeys = new Set<string>();
		let strayTerminations = 0;
		for (const pid of (await listPids()).slice(0, MAX_STRAY_SCAN_PIDS)) {
			if (pid === input.currentPid || pid === process.pid || markerPids.has(pid)) continue;
			const ref = strayRef(pid);
			if (!ref || !isProcessIncarnation(ref.incarnation)) continue;
			if (ref.incarnation === input.currentIncarnation) continue;
			if (!isLegacyStrayDaemonArgs(ref.args(), input.agentDir)) continue;
			const key = `${pid}|${ref.incarnation}`;
			liveKeys.add(key);
			const firstSeenAt = sightings.get(key);
			if (firstSeenAt === undefined) {
				if (sightings.size < MAX_STRAY_SIGHTINGS) sightings.set(key, clock());
				reasons.legacy_stray_pending_confirmation = (reasons.legacy_stray_pending_confirmation ?? 0) + 1;
				continue;
			}
			if (clock() - firstSeenAt < STRAY_CONFIRMATION_MS) {
				reasons.legacy_stray_pending_confirmation = (reasons.legacy_stray_pending_confirmation ?? 0) + 1;
				continue;
			}
			if (strayTerminations >= MAX_STRAY_TERMINATIONS) break;
			const acquisitionId = `legacy-stray:${pid}`;
			const exited = await terminateOwnedProcessTree(pid, ref, deps);
			if (exited || !deps.pidAlive(pid)) {
				decisions.push({ kind: "reaped", pid, acquisitionId });
				terminated += 1;
				strayTerminations += 1;
				sightings.delete(key);
				liveKeys.delete(key);
				reasons.legacy_stray_reaped = (reasons.legacy_stray_reaped ?? 0) + 1;
			} else {
				decisions.push({ kind: "refused", pid, acquisitionId, reason: "termination_failed" });
				refused += 1;
				reasons.legacy_stray_termination_failed = (reasons.legacy_stray_termination_failed ?? 0) + 1;
			}
		}
		// Drop ledger entries whose process no longer matched this sweep, so the
		// bounded ledger cannot fill with dead incarnations.
		for (const key of [...sightings.keys()]) if (!liveKeys.has(key)) sightings.delete(key);
	} catch {
		reasons.legacy_stray_scan_failed = (reasons.legacy_stray_scan_failed ?? 0) + 1;
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
