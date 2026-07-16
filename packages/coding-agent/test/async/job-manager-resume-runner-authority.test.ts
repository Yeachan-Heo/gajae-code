import { describe, expect, test } from "bun:test";
import {
	AsyncJobManager,
	type ResumeDescriptor,
	type ResumeRunner,
	type SubagentRecord,
} from "@gajae-code/coding-agent/async/job-manager";

// Regression coverage for #2303: AsyncJobManager.setResumeRunner used to be a
// process-global, last-writer-wins slot, so resuming a completed nested
// orchestrator re-executed under whichever session launched a task most
// recently (the orchestrator's own spawn whitelist), dying at the pre-model
// spawn gate. The fix binds a per-descriptor in-memory runner at
// registerResumeDescriptor time so each resume runs under its originating
// parent's execution authority. These tests use plain test doubles: no real
// agent sessions, no timers, no interval-driven scheduling.

interface RunnerCall {
	label: string;
	subagentId: string;
	agent: string;
	allowed: boolean;
}

function agentOf(descriptor?: ResumeDescriptor): string {
	const data = descriptor?.data as { agent?: string } | undefined;
	return data?.agent ?? descriptor?.subagentId ?? "";
}

/**
 * Models the task/index.ts resume runner as evaluated inside a specific
 * session's spawn authority. A denial returns undefined, which the manager
 * surfaces as `resume_failed` with zero model turns — exactly the pre-model
 * spawn-gate death #2303 describes.
 */
function authorityRunner(label: string, spawns: string, calls: RunnerCall[]): ResumeRunner {
	const whitelist = spawns
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	return (subagentId, _message, descriptor) => {
		const agent = agentOf(descriptor);
		const allowed = spawns === "*" ? true : whitelist.includes(agent);
		calls.push({ label, subagentId, agent, allowed });
		return allowed ? `${label}:${subagentId}:job` : undefined;
	};
}

function completedRecord(subagentId: string, ownerId?: string): SubagentRecord {
	return {
		subagentId,
		ownerId,
		currentJobId: `${subagentId}-orig`,
		historicalJobIds: [],
		status: "completed",
		sessionFile: `/tmp/${subagentId}.jsonl`,
		resumable: true,
	};
}

function descriptorFor(subagentId: string, agent: string, ownerId?: string): ResumeDescriptor {
	return { subagentId, ownerId, data: { sessionFile: `/tmp/${subagentId}.jsonl`, agent } };
}

describe("AsyncJobManager per-descriptor resume authority (#2303)", () => {
	// Assertion 1 — repro guard: the pre-fix global-slot behavior denies.
	test("repro: global-slot behavior denies resuming a completed nested orchestrator (zero model turns)", () => {
		const calls: RunnerCall[] = [];
		const manager = new AsyncJobManager({ onJobComplete: () => {} });

		// Orchestrator was launched by main, then spawned a child which rebound
		// the global runner to the orchestrator's own (self-excluding) whitelist.
		manager.registerSubagentRecord(completedRecord("wf0-orchestrator"));
		// Pre-fix reproduction: descriptor registered WITHOUT a per-descriptor
		// runner, so resolution falls back to the last global runner.
		manager.registerResumeDescriptor(descriptorFor("wf0-orchestrator", "wf0-orchestrator"));
		manager.setResumeRunner(authorityRunner("orchestrator", "worker-a,worker-b", calls));

		const result = manager.resumeSubagent("wf0-orchestrator", undefined, "please continue");

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("resume_failed");
		// The runner was reached but denied at the spawn gate: no job, no turns.
		expect(calls).toEqual([
			{ label: "orchestrator", subagentId: "wf0-orchestrator", agent: "wf0-orchestrator", allowed: false },
		]);
	});

	// Assertion 3 — the fix: nested launch after descriptor registration keeps
	// the originating parent's runner even though the global slot was rebound.
	test("nested launch after descriptor registration: resume(X) uses main's authority, not the rebound global runner", () => {
		const calls: RunnerCall[] = [];
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const mainRunner = authorityRunner("main", "*", calls);
		const orchestratorRunner = authorityRunner("orchestrator", "worker-a,worker-b", calls);

		// Main launches the orchestrator and binds the descriptor to main's runner.
		manager.registerSubagentRecord(completedRecord("wf0-orchestrator", "main"));
		manager.registerResumeDescriptor(descriptorFor("wf0-orchestrator", "wf0-orchestrator", "main"), mainRunner);
		manager.setResumeRunner(mainRunner);

		// Orchestrator later spawns a worker — this rebinds the GLOBAL slot.
		manager.setResumeRunner(orchestratorRunner);

		const result = manager.resumeSubagent("wf0-orchestrator", undefined, "continue");

		expect(result.ok).toBe(true);
		expect(result.jobId).toBe("main:wf0-orchestrator:job");
		expect(calls).toEqual([
			{ label: "main", subagentId: "wf0-orchestrator", agent: "wf0-orchestrator", allowed: true },
		]);
	});

	// Assertion 2 — two parent sessions each resume under their own authority.
	test("two parents: each descriptor resumes under its own originating parent's spawn authority", () => {
		const calls: RunnerCall[] = [];
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const p1Runner = authorityRunner("P1", "*", calls);
		const p2Runner = authorityRunner("P2", "worker-a", calls);

		manager.registerSubagentRecord(completedRecord("sub-from-p1", "P1"));
		manager.registerResumeDescriptor(descriptorFor("sub-from-p1", "wf0-orchestrator", "P1"), p1Runner);

		manager.registerSubagentRecord(completedRecord("sub-from-p2", "P2"));
		manager.registerResumeDescriptor(descriptorFor("sub-from-p2", "worker-a", "P2"), p2Runner);

		// Global slot ends up bound to whoever launched last (P2).
		manager.setResumeRunner(p2Runner);

		const r1 = manager.resumeSubagent("sub-from-p1");
		const r2 = manager.resumeSubagent("sub-from-p2");

		expect(r1.ok).toBe(true);
		expect(r1.jobId).toBe("P1:sub-from-p1:job");
		expect(r2.ok).toBe(true);
		expect(r2.jobId).toBe("P2:sub-from-p2:job");
		// P1's subagent must never be evaluated under P2's whitelist.
		expect(calls).toEqual([
			{ label: "P1", subagentId: "sub-from-p1", agent: "wf0-orchestrator", allowed: true },
			{ label: "P2", subagentId: "sub-from-p2", agent: "worker-a", allowed: true },
		]);
	});

	// Assertion 4 — interleaved registrations/launches never cross-bind runners.
	test("interleaving: interleaved registration and global rebinding never cross-bind runners", () => {
		const calls: RunnerCall[] = [];
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const mainRunner = authorityRunner("main", "*", calls);
		const orchRunner = authorityRunner("orchestrator", "worker-a,worker-b", calls);

		// Interleave: register X (main), rebind global to orchestrator, register
		// worker-a (orchestrator), rebind global back to main.
		manager.registerSubagentRecord(completedRecord("wf0-orchestrator", "main"));
		manager.registerResumeDescriptor(descriptorFor("wf0-orchestrator", "wf0-orchestrator", "main"), mainRunner);
		manager.setResumeRunner(orchRunner);
		manager.registerSubagentRecord(completedRecord("worker-a", "wf0-orchestrator"));
		manager.registerResumeDescriptor(descriptorFor("worker-a", "worker-a", "wf0-orchestrator"), orchRunner);
		manager.setResumeRunner(mainRunner);

		const rWorker = manager.resumeSubagent("worker-a");
		const rOrch = manager.resumeSubagent("wf0-orchestrator");

		// Each resumed under its own launcher's authority regardless of the
		// current global slot value.
		expect(rWorker.jobId).toBe("orchestrator:worker-a:job");
		expect(rOrch.jobId).toBe("main:wf0-orchestrator:job");
		expect(calls).toEqual([
			{ label: "orchestrator", subagentId: "worker-a", agent: "worker-a", allowed: true },
			{ label: "main", subagentId: "wf0-orchestrator", agent: "wf0-orchestrator", allowed: true },
		]);
	});

	// Assertion 5 — descriptor cleanup drops the per-descriptor runner (no leak).
	test("descriptor cleanup: runOwnerCleanups drops the per-descriptor runner (no stale reuse)", () => {
		const calls: RunnerCall[] = [];
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const originalRunner = authorityRunner("original", "*", calls);
		const replacementRunner = authorityRunner("replacement", "*", calls);

		manager.registerSubagentRecord(completedRecord("wf0-orchestrator", "main"));
		manager.registerResumeDescriptor(descriptorFor("wf0-orchestrator", "wf0-orchestrator", "main"), originalRunner);

		// Owner cleanup purges the subagent record, descriptor, and its runner.
		manager.runOwnerCleanups({ ownerId: "main" });
		expect(manager.getResumeDescriptor("wf0-orchestrator")).toBeUndefined();

		// Re-register the same id WITHOUT a per-descriptor runner and install a
		// distinct global runner. If cleanup had leaked the original per-descriptor
		// runner, it would win here; instead resolution must fall back to global.
		manager.registerSubagentRecord(completedRecord("wf0-orchestrator", "main"));
		manager.registerResumeDescriptor(descriptorFor("wf0-orchestrator", "wf0-orchestrator", "main"));
		manager.setResumeRunner(replacementRunner);

		const result = manager.resumeSubagent("wf0-orchestrator");

		expect(result.ok).toBe(true);
		expect(result.jobId).toBe("replacement:wf0-orchestrator:job");
		expect(calls.map(c => c.label)).toEqual(["replacement"]);
	});

	// Assertion 6 — restart / no-runner fails closed.
	test("restart/no-runner: a fresh manager with only persistable state fails closed with no_runner", () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });

		// Simulated restart: persistable state (record + descriptor) is replayed,
		// but the in-memory runners (global + per-descriptor) are gone.
		manager.registerSubagentRecord(completedRecord("wf0-orchestrator", "main"));
		manager.registerResumeDescriptor(descriptorFor("wf0-orchestrator", "wf0-orchestrator", "main"));

		const result = manager.resumeSubagent("wf0-orchestrator", undefined, "continue");

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("no_runner");
	});

	// Assertion 7 — self-recursion / whitelist gates still deny genuinely
	// disallowed spawns (authority is bound, not broadened).
	test("whitelist gate: a genuinely disallowed spawn still fails under the originating parent's authority", () => {
		const calls: RunnerCall[] = [];
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		// Originating parent's whitelist legitimately excludes the resumed agent.
		const parentRunner = authorityRunner("parent", "worker-a,worker-b", calls);

		manager.registerSubagentRecord(completedRecord("worker-c", "parent"));
		manager.registerResumeDescriptor(descriptorFor("worker-c", "worker-c", "parent"), parentRunner);
		manager.setResumeRunner(parentRunner);

		const result = manager.resumeSubagent("worker-c");

		// The fix must not broaden permission: a real denial still denies.
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("resume_failed");
		expect(calls).toEqual([{ label: "parent", subagentId: "worker-c", agent: "worker-c", allowed: false }]);
	});
});
