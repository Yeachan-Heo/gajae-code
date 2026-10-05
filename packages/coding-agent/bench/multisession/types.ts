/**
 * Shared contract for the RFC #6247 Phase A multi-session memory experiment.
 *
 * Bench-only: nothing here is shipped or imported by `src/`.
 */

/** Result of one per-process footprint read (S1). */
export type FootprintRead =
	| { status: "ok"; pid: number; incarnation: string; physFootprint: number; rss: number }
	/** Process confirmed gone (incarnation observation says absent). */
	| { status: "absent"; pid: number }
	/** Read failed or identity changed between the bracketing observations. */
	| { status: "unresolved" | "raced"; pid: number; reason: string };

/** Environment visibility classification for one process (S4, Revision 4). */
export type ProcessEnvRead =
	| { status: "complete"; argv: string[]; env: Record<string, string> }
	| { status: "argv-only"; argv: string[] }
	| { status: "truncated" | "malformed"; reason: string }
	| { status: "failed"; errno: number };

/** Why a process is (or is not) a cohort member. */
export type MembershipReason =
	| "root"
	| "driver"
	| "marker"
	| "ancestry"
	| "marker-missing"
	| "ancestry-gap"
	| "unresolved-ownership";

export interface CohortMember {
	pid: number;
	incarnation: string;
	reason: MembershipReason;
	flags: string[];
}

export interface CohortExclusion {
	pid: number;
	reason: "pre-run" | "non-owned-ancestry" | "marker-free" | "pid-reused";
}

/**
 * Post-shutdown orphan receipt. `complete` is false when the final process
 * enumeration or ancestry scan failed; an incomplete receipt never proves zero.
 */
export interface OrphanReceipt {
	owned: number[];
	unresolved: number[];
	complete: boolean;
	errors: string[];
}

/** One 1Hz cohort sample. */
export interface CohortSample {
	/** Monotonic ms since run start (performance.now() of the driver). */
	t: number;
	/** Scheduled tick index; a missed tick has no sample and counts as incomplete. */
	tick: number;
	phase: string;
	complete: boolean;
	/** Reasons this sample is incomplete (empty when complete). */
	incompleteReasons: string[];
	members: Array<CohortMember & { read: FootprintRead }>;
	excluded: CohortExclusion[];
	/** Σ physFootprint over owned incarnations incl. driver; null when incomplete. */
	armTotal: number | null;
	armRssTotal: number | null;
	driverFootprint: number | null;
}

/** Phase markers emitted by a session runner (S2). */
export type RunnerPhase =
	| "constructed"
	| "ready"
	| `active:${string}`
	| "idle"
	| "disposing"
	| "disposed";

/** Messages a runner emits to its launcher (stdout JSONL in process mode, postMessage in Worker mode). */
export type RunnerEvent =
	| { type: "phase"; sessionIndex: number; phase: RunnerPhase; t: number }
	| { type: "turn"; sessionIndex: number; turn: number; startedAt: number; endedAt: number; ok: boolean }
	| { type: "workload"; sessionIndex: number; event: WorkloadEventKind }
	| { type: "lag"; sessionIndex: number; samplesMs: number[] }
	| { type: "heap"; sessionIndex: number; heapSize: number; heapCapacity: number; extraMemory: number }
	| { type: "error"; sessionIndex: number; message: string }
	| { type: "done"; sessionIndex: number; evidenceDir: string };

/** Workload facts that must be observed for a rep to count as equivalent completed work. */
export type WorkloadEventKind = "streamed-text" | "tool:bash" | "tool:read" | "tool:grep" | "task-completed" | "compaction";

export const REQUIRED_WORKLOAD_EVENTS: readonly WorkloadEventKind[] = [
	"streamed-text",
	"tool:bash",
	"tool:read",
	"tool:grep",
	"task-completed",
	"compaction",
];

/** Messages a launcher sends to a runner. */
export type RunnerCommand = { type: "ack" } | { type: "start" } | { type: "close" };

export type ArmKind = "standalone" | "worker";

/** Raw output of one repetition of one arm at one concurrency. */
export interface RepRecord {
	arm: ArmKind;
	n: number;
	rep: number;
	samples: CohortSample[];
	/** Expected scheduled ticks in the gated window. */
	gatedWindowTicks: number[];
	/** Tick index of the post-close teardown sample (10s after the last close). */
	teardownTick: number | null;
	runnerEvents: RunnerEvent[];
	/** Cold readiness per session in ms (driver spawn → ready). */
	coldReadyMs: number[];
	/** Warm Worker admission per session (Worker arm only, non-gating). */
	warmAdmissionMs: number[];
	visibilityCheck: { passed: boolean; reason?: string };
	orphans: OrphanReceipt;
	invalidReason?: string;
}

/** Raw output of one churn run (one resident Worker host / repeated standalone cycles). */
export interface ChurnRecord {
	arm: ArmKind;
	/** Footprint sample taken 10s after the 5th close of each cycle (index 0 = cycle 1). */
	cycleSamples: CohortSample[];
	/** Host-only footprint (Worker arm) at the same phase point, per cycle. */
	hostFootprints: Array<number | null>;
	/** Session failures per cycle (index 0 = cycle 1); a cycle is valid only when empty. */
	cycleErrors: string[][];
	/** Cycles completed before the run stopped; fewer than requested is insufficient evidence. */
	completedCycles: number;
	orphans: OrphanReceipt;
}

export interface BrokerBaselineRecord {
	reps: Array<{ samples: Array<number | null>; complete: boolean }>;
	/** Median of per-rep means; null when insufficient evidence. */
	b: number | null;
}

export type GateVerdict = "pass" | "fail" | "insufficient-evidence";

/**
 * Cross-process comparable millisecond clock (performance.timeOrigin + now).
 * Every timestamp in RunnerEvent and driver records uses this clock so phase
 * windows, turn timings, and cold readiness compare across processes and
 * Worker isolates, whose `performance.now()` origins differ.
 */
export function benchNow(): number {
	return performance.timeOrigin + performance.now();
}
