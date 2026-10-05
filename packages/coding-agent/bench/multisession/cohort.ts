import type { Process } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { createDarwinAncestryTracker, type DarwinAncestryTracker } from "../../src/exec/bash-shell-guardian";
import {
	observeProcessIncarnation,
	type ProcessIncarnationObservation,
} from "../../src/sdk/broker/process-incarnation";
import {
	closeProcessInfo,
	listAllPids as readAllPids,
	processUniqueIdentity,
	processStartTimeMs,
	processUid,
	readProcessEnv as readEnvironment,
} from "./procinfo";
import { closeFootprintSampler, sampleProcess as readFootprint } from "./footprint";
import type { CohortExclusion, CohortMember, CohortSample, FootprintRead, OrphanReceipt, ProcessEnvRead } from "./types";

export const COHORT_MARKER_ENV = "GJC_BENCH_COHORT";
/** launchd's kernel unique id (`p_uniqueid` of pid 1). */
export const LAUNCHD_UNIQUE_ID = 1n;
/** Pause before re-reading a process identity that first read as unknown. */
const IDENTITY_RETRY_MS = 20;

type ProcessIdentity = { pid: number; incarnation: string };
type AncestrySnapshot = { members: ProcessIdentity[]; complete: boolean };

export interface CohortAncestry {
	registerRoot(root: ProcessIdentity): void;
	scan(): AncestrySnapshot;
	close?(): void;
}

export interface CohortDeps {
	listAllPids?: () => number[];
	readProcessEnv?: (pid: number) => ProcessEnvRead;
	sampleProcess?: (pid: number) => FootprintRead;
	processStartTimeMs?: (pid: number) => number | null;
	/** Kernel unique id and ORIGINAL-parent unique id (survives reparenting). */
	uniqueIdentity?: (pid: number) => { uniqueId: bigint; parentUniqueId: bigint } | null;
	processUid?: (pid: number) => number | null;
	observeProcessIncarnation?: (pid: number) => ProcessIncarnationObservation;
	ancestry?: CohortAncestry;
	now?: () => number;
}

export interface CohortOwnershipScan {
	members: CohortMember[];
	excluded: CohortExclusion[];
	unresolvedPids: number[];
	errors: string[];
}

type RootRegistration = ProcessIdentity;
type AncestryEvidence = "owned" | "non-owned" | "unknown";

function identityKey(pid: number, incarnation: string): string {
	return `${pid}:${incarnation}`;
}

function uniquePids(pids: number[]): number[] {
	return [...new Set(pids)];
}

function createNativeAncestry(): CohortAncestry {
	const owned = new Map<string, Process>();
	const tracker: DarwinAncestryTracker | undefined = createDarwinAncestryTracker(owned);
	if (!tracker) {
		return {
			registerRoot() {},
			scan: () => ({ members: [], complete: false }),
		};
	}
	return {
		registerRoot(root) {
			const processRef = nativeProcessBindings().Process.fromPid(root.pid);
			if (processRef?.incarnation === root.incarnation) tracker.track(processRef);
		},
		scan() {
			const complete = tracker.poll();
			return {
				members: [...owned.values()].map(processRef => ({
					pid: processRef.pid,
					incarnation: processRef.incarnation,
				})),
				complete,
			};
		},
		close() {
			tracker.close();
		},
	};
}

function checkedTotal(total: bigint): number | undefined {
	const value = Number(total);
	if (!Number.isSafeInteger(value) || BigInt(value) !== total) return undefined;
	return value;
}

/** Add the independently measured Broker baseline exactly once to an arm total. */
export function gatedTotal(armTotal: number, b: number): number {
	return armTotal + b;
}

export class Cohort {
	readonly #token: string;
	readonly #driverPid: number;
	readonly #driverIncarnation: string | undefined;
	readonly #runStartEpochMs: number;
	readonly #runStartMonotonicMs: number;
	readonly #deps: CohortDeps;
	readonly #roots = new Map<string, RootRegistration>();
	readonly #ancestry: CohortAncestry;
	#lastTick: number | undefined;
	#scanPids: number[] = [];
	#scanUniqueIndex: Map<bigint, ProcessIdentity> | undefined;

	constructor(options: { token: string; driverPid: number; runStartEpochMs: number; deps?: CohortDeps }) {
		if (options.token.length === 0) throw new Error("Cohort token must not be empty");
		if (!Number.isSafeInteger(options.driverPid) || options.driverPid <= 0)
			throw new Error("Cohort driver pid must be a positive integer");
		if (!Number.isFinite(options.runStartEpochMs)) throw new Error("Cohort run start must be finite");
		this.#token = options.token;
		this.#driverPid = options.driverPid;
		this.#runStartEpochMs = options.runStartEpochMs;
		this.#deps = options.deps ?? {};
		this.#runStartMonotonicMs = performance.now() - (Date.now() - options.runStartEpochMs);
		const driverObservation = this.#observe(this.#driverPid);
		this.#driverIncarnation = driverObservation.status === "present" ? driverObservation.incarnation : undefined;
		this.#ancestry = this.#deps.ancestry ?? createNativeAncestry();
	}

	registerRoot(pid: number, incarnation: string): void {
		if (!Number.isSafeInteger(pid) || pid <= 0 || incarnation.length === 0)
			throw new Error("Cohort root requires a positive pid and non-empty incarnation");
		const root = { pid, incarnation };
		this.#roots.set(identityKey(pid, incarnation), root);
		this.#ancestry.registerRoot(root);
	}

	unregisterRoot(pid: number): void {
		for (const [key, root] of this.#roots) {
			if (root.pid === pid) this.#roots.delete(key);
		}
	}

	scanOwnership(): CohortOwnershipScan {
		const result: CohortOwnershipScan = { members: [], excluded: [], unresolvedPids: [], errors: [] };
		const members = new Map<string, CohortMember>();
		const exclusions = new Map<string, CohortExclusion>();
		let listedPids: number[] = [];
		try {
			listedPids = uniquePids(this.#listAllPids());
		} catch (error) {
			result.errors.push(`process-list-failed:${error instanceof Error ? error.message : String(error)}`);
		}
		this.#scanPids = listedPids;
		this.#scanUniqueIndex = undefined;

		let ancestrySnapshot: AncestrySnapshot;
		try {
			ancestrySnapshot = this.#ancestry.scan();
		} catch (error) {
			ancestrySnapshot = { members: [], complete: false };
			result.errors.push(`ancestry-scan-failed:${error instanceof Error ? error.message : String(error)}`);
		}
		if (!ancestrySnapshot.complete) result.errors.push("ancestry-scan-incomplete");
		const tracked = new Set(ancestrySnapshot.members.map(root => identityKey(root.pid, root.incarnation)));
		const rootsByPid = new Map<number, RootRegistration[]>();
		for (const root of this.#roots.values()) {
			const roots = rootsByPid.get(root.pid) ?? [];
			roots.push(root);
			rootsByPid.set(root.pid, roots);
		}
		const listed = new Set(listedPids);

		for (const pid of listedPids) {
			// launchd (the reparent target) and the kernel are never cohort members.
			if (pid <= 1) continue;
			const rootsForPid = rootsByPid.get(pid) ?? [];
			const uid = this.#processUid(pid);
			const ownUid = typeof process.getuid === "function" ? process.getuid() : undefined;
			const knownForeignUid = uid !== null && ownUid !== undefined && uid !== ownUid;
			if (knownForeignUid && rootsForPid.length === 0 && pid !== this.#driverPid) continue;
			let observation = this.#observe(pid);
			// A process caught mid-exit (or mid-exec) can briefly read as unknown; one
			// short re-read separates that transient from a live unreadable process.
			if (observation.status === "unknown") {
				Bun.sleepSync(IDENTITY_RETRY_MS);
				observation = this.#observe(pid);
			}
			if (observation.status === "absent") continue;
			if (observation.status === "unknown") {
				if (!knownForeignUid) {
					result.errors.push(`identity-unresolved:${pid}:${observation.reasonCode}`);
					result.unresolvedPids.push(pid);
				}
				continue;
			}
			const incarnation = observation.incarnation;
			const key = identityKey(pid, incarnation);
			const matchingRoot = rootsForPid.find(root => root.incarnation === incarnation);
			if (rootsForPid.length > 0 && !matchingRoot) {
				exclusions.set(`${pid}:pid-reused`, { pid, reason: "pid-reused" });
				continue;
			}
			if (knownForeignUid) continue;
			const isDriver = pid === this.#driverPid && incarnation === this.#driverIncarnation;
			const isTracked = tracked.has(key);

			const environment = this.#readProcessEnv(pid);
			const markerMatches = environment.status === "complete" && environment.env[COHORT_MARKER_ENV] === this.#token;
			if (isDriver) {
				this.#addMember(members, { pid, incarnation, reason: "driver", flags: markerMatches && !isTracked ? ["ancestry-gap"] : [] });
				continue;
			}
			if (matchingRoot) {
				const flags = markerMatches ? [] : ["marker-missing"];
				if (markerMatches && !isTracked) flags.push("ancestry-gap");
				this.#addMember(members, { pid, incarnation, reason: "root", flags });
				continue;
			}
			if (markerMatches) {
				this.#addMember(members, {
					pid,
					incarnation,
					reason: "marker",
					flags: isTracked ? [] : ["ancestry-gap"],
				});
				continue;
			}
			if (environment.status === "complete") {
				if (isTracked) {
					this.#addMember(members, { pid, incarnation, reason: "ancestry", flags: ["marker-missing"] });
				} else if (uid === null) {
					this.#addMember(members, {
						pid,
						incarnation,
						reason: "unresolved-ownership",
						flags: ["uid-unresolved"],
					});
				} else {
					const startTime = this.#processStartTimeMs(pid);
					const ancestorEvidence =
						startTime === null || startTime >= this.#runStartEpochMs
							? this.#ancestryEvidence(pid, incarnation, rootsByPid, tracked)
							: "non-owned";
					if (ancestorEvidence === "owned") {
						this.#addMember(members, { pid, incarnation, reason: "ancestry", flags: ["marker-missing"] });
					} else {
						exclusions.set(`${pid}:marker-free`, { pid, reason: "marker-free" });
					}
				}
				continue;
			}

			// Environment visibility is unproven (argv-only / truncated / malformed /
			// failed — e.g. XNU redacts the env of platform binaries such as /bin/sh).
			// Ownership must then be settled by independent evidence: retained
			// ancestry or the original-parent chain admits it; a pre-run start or a
			// non-owned original-parent chain excludes it; anything else is unresolved.
			const unprovenFlags = ["marker-missing", `env-${environment.status}`];
			if (isTracked) {
				this.#addMember(members, { pid, incarnation, reason: "ancestry", flags: unprovenFlags });
				continue;
			}
			const startTime = this.#processStartTimeMs(pid);
			if (startTime !== null && startTime < this.#runStartEpochMs) {
				exclusions.set(`${pid}:pre-run`, { pid, reason: "pre-run" });
				continue;
			}
			const ancestry = this.#ancestryEvidence(pid, incarnation, rootsByPid, tracked);
			if (ancestry === "owned") {
				this.#addMember(members, { pid, incarnation, reason: "ancestry", flags: unprovenFlags });
			} else if (ancestry === "non-owned") {
				exclusions.set(`${pid}:non-owned-ancestry`, { pid, reason: "non-owned-ancestry" });
			} else {
				this.#addMember(members, {
					pid,
					incarnation,
					reason: "unresolved-ownership",
					flags: [`env-${environment.status}`],
				});
			}
		}

		for (const root of this.#roots.values()) {
			if (!listed.has(root.pid)) continue;
			const current = this.#observe(root.pid);
			if (current.status === "present" && current.incarnation !== root.incarnation) {
				exclusions.set(`${root.pid}:pid-reused`, { pid: root.pid, reason: "pid-reused" });
			}
		}

		if (this.#driverIncarnation !== undefined) {
			const key = identityKey(this.#driverPid, this.#driverIncarnation);
			if (!members.has(key)) {
				this.#addMember(members, { pid: this.#driverPid, incarnation: this.#driverIncarnation, reason: "driver", flags: [] });
			}
		}
		result.members = [...members.values()];
		result.excluded = [...exclusions.values()];
		result.unresolvedPids = uniquePids(result.unresolvedPids.concat(
			result.members.filter(member => member.reason === "unresolved-ownership").map(member => member.pid),
		));
		return result;
	}

	sample(tick: number, phase: string): CohortSample {
		const ownership = this.scanOwnership();
		const incompleteReasons = [...ownership.errors];
		const memberPids = new Set(ownership.members.map(member => member.pid));
		for (const pid of ownership.unresolvedPids) {
			if (!memberPids.has(pid)) incompleteReasons.push("unresolved-ownership");
		}
		if (!Number.isSafeInteger(tick) || tick < 0) incompleteReasons.push("invalid-tick");
		if (this.#lastTick !== undefined) {
			if (tick > this.#lastTick + 1) incompleteReasons.push(`missing-tick:${this.#lastTick + 1}-${tick - 1}`);
			else if (tick <= this.#lastTick) incompleteReasons.push(`non-monotonic-tick:${tick}`);
		}
		if (Number.isSafeInteger(tick) && tick >= 0) this.#lastTick = tick;

		let physTotal = 0n;
		let rssTotal = 0n;
		let driverFootprint: number | null = null;
		const members: CohortSample["members"] = [];
		for (const member of ownership.members) {
			const read = this.#sampleProcess(member.pid);
			members.push({ ...member, read });
			// OS-confirmed exit between the ownership scan and this read: the process
			// holds no memory any more, so it contributes nothing to this sample
			// whoever owned it. Its unresolved ownership cannot affect the total.
			if (read.status === "absent" && member.reason !== "driver") continue;
			if (member.reason === "unresolved-ownership") {
				incompleteReasons.push("unresolved-ownership", `unresolved-ownership:${member.pid}`);
			}
			if (
				read.status !== "ok" ||
				read.pid !== member.pid ||
				read.incarnation !== member.incarnation ||
				!Number.isSafeInteger(read.physFootprint) ||
				!Number.isSafeInteger(read.rss) ||
				read.physFootprint < 0 ||
				read.rss < 0
			) {
				incompleteReasons.push(`footprint-${read.status}:${member.pid}`);
				continue;
			}
			physTotal += BigInt(read.physFootprint);
			rssTotal += BigInt(read.rss);
			if (member.reason === "driver") driverFootprint = read.physFootprint;
		}
		if (driverFootprint === null) incompleteReasons.push("driver-read-unresolved");
		const armTotal = checkedTotal(physTotal);
		const armRssTotal = checkedTotal(rssTotal);
		if (armTotal === undefined || armRssTotal === undefined) incompleteReasons.push("total-out-of-safe-range");
		const uniqueReasons = [...new Set(incompleteReasons)];
		const complete = uniqueReasons.length === 0;
		const now = this.#deps.now?.() ?? performance.now();
		return {
			t: Math.max(0, now - this.#runStartMonotonicMs),
			tick,
			phase,
			complete,
			incompleteReasons: uniqueReasons,
			members,
			excluded: ownership.excluded,
			armTotal: complete ? armTotal ?? null : null,
			armRssTotal: complete ? armRssTotal ?? null : null,
			driverFootprint,
		};
	}

	orphanCheck(): OrphanReceipt {
		const scan = this.scanOwnership();
		// An orphan is a process that is still alive: a pid the OS confirms exited
		// after the scan (typically a short-lived host process caught mid-enumeration)
		// holds nothing and cannot leak, whatever its ownership verdict was.
		const alive = (pid: number): boolean => pid !== this.#driverPid && this.#observe(pid).status !== "absent";
		const owned = uniquePids(
			scan.members.filter(member => member.reason !== "unresolved-ownership").map(member => member.pid),
		).filter(alive);
		const unresolved = uniquePids(scan.unresolvedPids).filter(alive);
		// identity-unresolved pids are already listed in `unresolved`; any other scan
		// error means the enumeration itself cannot prove that nothing remains.
		const errors = scan.errors.filter(error => !error.startsWith("identity-unresolved:"));
		return { owned, unresolved, complete: errors.length === 0, errors };
	}

	visibilityCheck(): { passed: boolean; reason?: string } {
		if (this.#roots.size === 0) return { passed: false, reason: "marker-not-visible:no-registered-roots" };
		for (const root of this.#roots.values()) {
			const observation = this.#observe(root.pid);
			if (observation.status !== "present" || observation.incarnation !== root.incarnation) {
				return { passed: false, reason: `marker-not-visible:root-identity:${root.pid}` };
			}
			const env = this.#readProcessEnv(root.pid);
			if (env.status !== "complete" || env.env[COHORT_MARKER_ENV] !== this.#token) {
				return { passed: false, reason: `marker-not-visible:${root.pid}:${env.status}` };
			}
		}
		return { passed: true };
	}

	close(): void {
		this.#ancestry.close?.();
		closeProcessInfo();
		closeFootprintSampler();
	}

	#observe(pid: number): ProcessIncarnationObservation {
		return (this.#deps.observeProcessIncarnation ?? observeProcessIncarnation)(pid);
	}

	#listAllPids(): number[] {
		return (this.#deps.listAllPids ?? readAllPids)();
	}

	#readProcessEnv(pid: number): ProcessEnvRead {
		return (this.#deps.readProcessEnv ?? readEnvironment)(pid);
	}

	#sampleProcess(pid: number): FootprintRead {
		return (this.#deps.sampleProcess ?? readFootprint)(pid);
	}

	#processStartTimeMs(pid: number): number | null {
		return (this.#deps.processStartTimeMs ?? processStartTimeMs)(pid);
	}

	#uniqueIdentity(pid: number): { uniqueId: bigint; parentUniqueId: bigint } | null {
		return (this.#deps.uniqueIdentity ?? processUniqueIdentity)(pid);
	}

	/** Kernel unique id → live identity for every listed process; built once per scan, on demand. */
	#uniqueIndex(): Map<bigint, ProcessIdentity> {
		if (this.#scanUniqueIndex) return this.#scanUniqueIndex;
		const index = new Map<bigint, ProcessIdentity>();
		for (const pid of this.#scanPids) {
			const before = this.#observe(pid);
			if (before.status !== "present") continue;
			const identity = this.#uniqueIdentity(pid);
			const after = this.#observe(pid);
			if (!identity || after.status !== "present" || after.incarnation !== before.incarnation) continue;
			index.set(identity.uniqueId, { pid, incarnation: before.incarnation });
		}
		this.#scanUniqueIndex = index;
		return index;
	}

	#processUid(pid: number): number | null {
		return (this.#deps.processUid ?? processUid)(pid);
	}

	#addMember(members: Map<string, CohortMember>, member: CohortMember): void {
		const key = identityKey(member.pid, member.incarnation);
		const previous = members.get(key);
		if (!previous) {
			members.set(key, { ...member, flags: [...member.flags] });
			return;
		}
		const flags = [...new Set(previous.flags.concat(member.flags))];
		const reason = previous.reason === "driver" || member.reason === "driver"
			? "driver"
			: previous.reason === "root" || member.reason === "root"
				? "root"
				: previous.reason === "unresolved-ownership" || member.reason === "unresolved-ownership"
					? "unresolved-ownership"
					: previous.reason;
		members.set(key, { ...previous, reason, flags });
	}

	/**
	 * Ownership evidence from the ORIGINAL-parent chain (`p_puniqueid`, fixed at
	 * fork, unaffected by reparenting to launchd):
	 * - reaches a registered root, tracked descendant, or the driver → owned;
	 * - spawned directly by launchd, or by a live process that started before
	 *   this run and is not owned → non-owned (a cohort descendant can only be
	 *   reparented to launchd, never adopted by an unrelated process, and its
	 *   original parent is always a cohort process);
	 * - original parent no longer exists, or identity cannot be read → unknown.
	 */
	#ancestryEvidence(
		pid: number,
		incarnation: string,
		rootsByPid: Map<number, RootRegistration[]>,
		tracked: Set<string>,
	): AncestryEvidence {
		const owned = (identity: ProcessIdentity): boolean =>
			(identity.pid === this.#driverPid && identity.incarnation === this.#driverIncarnation) ||
			rootsByPid.get(identity.pid)?.some(root => root.incarnation === identity.incarnation) === true ||
			tracked.has(identityKey(identity.pid, identity.incarnation));
		let current: ProcessIdentity = { pid, incarnation };
		const visited = new Set<string>();
		for (let depth = 0; depth < 256; depth++) {
			const key = identityKey(current.pid, current.incarnation);
			if (visited.has(key)) return "unknown";
			visited.add(key);
			if (owned(current)) return "owned";
			const before = this.#observe(current.pid);
			if (before.status !== "present" || before.incarnation !== current.incarnation) return "unknown";
			const identity = this.#uniqueIdentity(current.pid);
			const after = this.#observe(current.pid);
			if (!identity || after.status !== "present" || after.incarnation !== current.incarnation) return "unknown";
			if (identity.parentUniqueId === LAUNCHD_UNIQUE_ID) return "non-owned";
			const parent = this.#uniqueIndex().get(identity.parentUniqueId);
			if (!parent) return "unknown";
			if (owned(parent)) return "owned";
			const parentStart = this.#processStartTimeMs(parent.pid);
			if (parentStart !== null && parentStart < this.#runStartEpochMs) return "non-owned";
			current = parent;
		}
		return "unknown";
	}
}
