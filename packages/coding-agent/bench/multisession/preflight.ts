/**
 * Worker feasibility preflight (S5).
 *
 * Two Workers in one host run the shortened native-backed script (bash, grep,
 * and one long in-flight model turn). Worker 0 disposes and is closed while a
 * Worker 1 turn is in flight (proven from turn timestamps, not sampled state);
 * Worker 1 must complete, both evidence sets must equal the same
 * script run as standalone processes, the host identity must be unchanged, and
 * no owned process may remain after shutdown.
 *
 * The decision logic runs against an injected adapter so every failure branch
 * is testable; the real adapter drives actual processes and Workers. A real
 * failure is an experiment outcome ("stop at Phase A"), not a harness bug.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { observeProcessIncarnation } from "../../src/sdk/broker/process-incarnation";
import { createArm } from "./arms";
import { Cohort } from "./cohort";
import type { PreflightRecord } from "./contract";
import { compareEvidence } from "./normalize";
import type { Provenance } from "./provenance";
import type { OrphanReceipt, RunnerEvent } from "./types";

export type PreflightCheckName =
	| "host-started"
	| "close-barrier"
	| "survivor-completed"
	| "fidelity"
	| "host-identity-unchanged"
	| "zero-orphans";

export interface PreflightCheck {
	name: PreflightCheckName;
	passed: boolean;
	detail?: string;
}

export interface PreflightAdapter {
	/** Start the Worker host with sessions 0 and 1 staggered; returns host identity. */
	startHost(): Promise<{ pid: number; incarnation: string }>;
	/** Wait until session 0 completed (evidence persisted); returns when it began disposing, on the bench clock. */
	waitFirstDisposed(): Promise<{ disposingAt: number }>;
	/** Close a session; resolves with the bench-clock time its termination was confirmed. */
	closeSession(index: number): Promise<number>;
	/** Wait for session 1 to finish; ok=false with the runner error otherwise. */
	waitSurvivor(): Promise<{ ok: boolean; error?: string }>;
	/** Session 1's completed turn intervals on the bench clock. */
	survivorTurns(): Array<{ startedAt: number; endedAt: number }>;
	/** Current identity of the host pid ("absent"/"unknown" when it died or cannot be observed). */
	hostIdentity(pid: number): { status: "present"; incarnation: string } | { status: "absent" | "unknown" };
	shutdown(): Promise<void>;
	orphanCheck(): OrphanReceipt;
	/** Evidence directories for sessions 0 and 1 in the Worker host. */
	workerEvidence(): string[];
	/** Run the same script as standalone processes; returns evidence dirs for sessions 0 and 1. */
	standaloneEvidence(): Promise<string[]>;
	compare(a: string, b: string): Promise<{ equal: boolean; diffs: string[] }>;
	abort(): void;
}

export interface PreflightOutcome {
	checks: PreflightCheck[];
	result: "pass" | "fail";
}

export async function decidePreflight(adapter: PreflightAdapter): Promise<PreflightOutcome> {
	const checks: PreflightCheck[] = [];
	const finish = (): PreflightOutcome => ({ checks, result: checks.every(check => check.passed) ? "pass" : "fail" });
	let host: { pid: number; incarnation: string };
	try {
		host = await adapter.startHost();
		checks.push({ name: "host-started", passed: true, detail: `pid ${host.pid}` });
	} catch (error) {
		checks.push({ name: "host-started", passed: false, detail: String(error) });
		adapter.abort();
		return finish();
	}
	let window: { disposingAt: number; closedAt: number } | undefined;
	try {
		const { disposingAt } = await adapter.waitFirstDisposed();
		window = { disposingAt, closedAt: await adapter.closeSession(0) };
		const survivor = await adapter.waitSurvivor();
		checks.push({ name: "survivor-completed", passed: survivor.ok, ...(survivor.error ? { detail: survivor.error } : {}) });
	} catch (error) {
		checks.push({ name: "survivor-completed", passed: false, detail: String(error) });
	}
	// The barrier holds only if a session 1 turn was in flight from session 0's
	// dispose start through its confirmed Worker termination; judged from
	// recorded turn intervals after the fact.
	const overlapping = window
		? adapter.survivorTurns().find(turn => turn.startedAt <= window.disposingAt && turn.endedAt >= window.closedAt)
		: undefined;
	checks.push({
		name: "close-barrier",
		passed: overlapping !== undefined,
		detail: !window
			? "session 0 never completed"
			: overlapping
				? `session 1 turn [${overlapping.startedAt.toFixed(0)}, ${overlapping.endedAt.toFixed(0)}] spans session 0 dispose→close [${window.disposingAt.toFixed(0)}, ${window.closedAt.toFixed(0)}]`
				: `no session 1 turn spans session 0 dispose→close [${window.disposingAt.toFixed(0)}, ${window.closedAt.toFixed(0)}]`,
	});

	const identity = adapter.hostIdentity(host.pid);
	const sameHost = identity.status === "present" && identity.incarnation === host.incarnation;
	checks.push({
		name: "host-identity-unchanged",
		passed: sameHost,
		...(sameHost ? {} : { detail: `host observation: ${identity.status}` }),
	});

	try {
		await adapter.shutdown();
	} catch (error) {
		adapter.abort();
		checks.push({ name: "zero-orphans", passed: false, detail: `shutdown failed: ${String(error)}` });
	}
	if (!checks.some(check => check.name === "zero-orphans")) {
		const orphans = adapter.orphanCheck();
		const clean = orphans.complete && orphans.owned.length === 0 && orphans.unresolved.length === 0;
		checks.push({
			name: "zero-orphans",
			passed: clean,
			...(clean
				? {}
				: {
						detail: `owned=${orphans.owned.join(",")} unresolved=${orphans.unresolved.join(",")}${orphans.complete ? "" : ` incomplete=${orphans.errors.join(",")}`}`,
					}),
		});
	}

	if (checks.find(check => check.name === "survivor-completed")?.passed) {
		const workerDirs = adapter.workerEvidence();
		const standaloneDirs = await adapter.standaloneEvidence();
		const diffs: string[] = [];
		for (const index of [0, 1]) {
			const a = workerDirs[index];
			const b = standaloneDirs[index];
			if (!a || !b) {
				diffs.push(`session ${index}: missing evidence`);
				continue;
			}
			const comparison = await adapter.compare(a, b);
			if (!comparison.equal) diffs.push(...comparison.diffs.map(diff => `session ${index}: ${diff}`));
		}
		checks.push({ name: "fidelity", passed: diffs.length === 0, ...(diffs.length ? { detail: diffs.slice(0, 20).join("\n") } : {}) });
	} else {
		checks.push({ name: "fidelity", passed: false, detail: "not evaluated: survivor did not complete" });
	}
	return finish();
}

// Timing budget: session 1 starts once session 0 streams (after its first tool
// turn) and pays ~1 s of Worker cold start; with no idle, session 0 disposes right
// after its PREFLIGHT_IN_FLIGHT_MS turn, while session 1's own in-flight turn
// (started ~1 s later) is still running. The barrier check verifies the overlap.
const PREFLIGHT_IDLE_MS = 0;
const SESSION_TIMEOUT_MS = 120_000;

/** Adapter driving real processes, Workers, and the ownership cohort. */
export function createRealPreflightAdapter(options: { workDir: string; runId: string; driverStartEpochMs: number }): PreflightAdapter {
	const workerRoot = path.join(options.workDir, "worker");
	const standaloneRoot = path.join(options.workDir, "standalone");
	const token = `${options.runId}:preflight:worker`;
	const cohort = new Cohort({ token, driverPid: process.pid, runStartEpochMs: options.driverStartEpochMs });
	const arm = createArm({ kind: "worker", rootDir: workerRoot, idleMs: PREFLIGHT_IDLE_MS, variant: "preflight", token, cohort });
	const streamed = (index: number): boolean =>
		arm.events.some(event => event.type === "workload" && event.sessionIndex === index && event.event === "streamed-text");
	const phaseAt = (index: number, phase: string): number | undefined => {
		for (const event of arm.events) {
			if (event.type === "phase" && event.sessionIndex === index && event.phase === phase) return event.t;
		}
		return undefined;
	};
	const failed = (index: number): string | undefined => arm.sessions.get(index)?.error;

	return {
		async startHost() {
			await fs.mkdir(workerRoot, { recursive: true });
			arm.createSessions([0]);
			const root = arm.roots()[0];
			if (!root) throw new Error("worker host did not start");
			// Stagger: session 1 starts once session 0 is streaming, so session 0
			// disposes while session 1 is mid-script.
			await arm.waitFor(() => streamed(0) || failed(0) !== undefined, SESSION_TIMEOUT_MS);
			if (failed(0)) throw new Error(`session 0 failed: ${failed(0)}`);
			arm.createSessions([1]);
			return { pid: root.pid, incarnation: root.incarnation };
		},
		async waitFirstDisposed() {
			// Settled means `done` (with the evidence directory) arrived; closing the
			// session before that would lose session 0's evidence.
			await arm.waitDisposed([0], SESSION_TIMEOUT_MS);
			if (failed(0)) throw new Error(`session 0 failed: ${failed(0)}`);
			const disposingAt = phaseAt(0, "disposing");
			if (disposingAt === undefined) throw new Error("session 0 disposing phase was not observed");
			return { disposingAt };
		},
		async closeSession(index) {
			await arm.closeSession(index);
			const closedAt = arm.sessions.get(index)?.closedAt;
			if (closedAt === undefined) throw new Error(`session ${index} termination was not confirmed`);
			return closedAt;
		},
		async waitSurvivor() {
			try {
				await arm.waitDisposed([1], SESSION_TIMEOUT_MS);
			} catch (error) {
				return { ok: false, error: String(error) };
			}
			const error = failed(1);
			return error ? { ok: false, error } : { ok: true };
		},
		survivorTurns: () =>
			arm.events
				.filter((event): event is Extract<RunnerEvent, { type: "turn" }> => event.type === "turn" && event.sessionIndex === 1)
				.map(event => ({ startedAt: event.startedAt, endedAt: event.endedAt })),
		hostIdentity(pid) {
			const observation = observeProcessIncarnation(pid);
			return observation.status === "present" ? observation : { status: observation.status };
		},
		async shutdown() {
			await arm.shutdown();
			await Bun.sleep(500);
		},
		orphanCheck() {
			cohort.scanOwnership();
			return cohort.orphanCheck();
		},
		workerEvidence: () => [0, 1].map(index => arm.sessions.get(index)?.evidenceDir ?? ""),
		async standaloneEvidence() {
			await fs.mkdir(standaloneRoot, { recursive: true });
			const standaloneToken = `${options.runId}:preflight:standalone`;
			const standaloneCohort = new Cohort({
				token: standaloneToken,
				driverPid: process.pid,
				runStartEpochMs: options.driverStartEpochMs,
			});
			const reference = createArm({
				kind: "standalone",
				rootDir: standaloneRoot,
				idleMs: PREFLIGHT_IDLE_MS,
				variant: "preflight",
				token: standaloneToken,
				cohort: standaloneCohort,
			});
			try {
				reference.createSessions([0, 1]);
				await reference.waitDisposed([0, 1], SESSION_TIMEOUT_MS);
				await reference.shutdown();
			} catch (error) {
				reference.abort();
				throw error;
			}
			return [0, 1].map(index => reference.sessions.get(index)?.evidenceDir ?? "");
		},
		compare: compareEvidence,
		abort: () => arm.abort(),
	};
}

export function preflightRecord(outcome: PreflightOutcome, provenance: Provenance, contractDigest: string): PreflightRecord {
	return {
		sourceSha: provenance.sourceSha,
		dirty: provenance.dirty,
		workloadDigest: provenance.workloadDigest,
		bootstrapDigest: provenance.bootstrapDigest,
		bunVersion: provenance.bunVersion,
		osVersion: provenance.osVersion,
		contractDigest,
		checks: outcome.checks,
		result: outcome.result,
	};
}
