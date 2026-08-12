import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager, type SubagentRunOutcome } from "../src/async";
import {
	type AttentionEventIdentity,
	AttentionEventStore,
	type AttentionObservation,
	type AttentionStoreSnapshot,
} from "../src/modes/attention-event-store";
import { getAttentionLedgerPath } from "../src/modes/interactive-mode";
import { JobsObserver } from "../src/modes/jobs-observer";
import { SessionObserverRegistry } from "../src/modes/session-observer-registry";
import { TasksAggregator } from "../src/modes/tasks-aggregator";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../src/task";
import { EventBus } from "../src/utils/event-bus";

async function temporaryStatePath(): Promise<{ root: string; file: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-attention-aggregator-"));
	return { root, file: path.join(root, "attention.json") };
}

function observation(overrides: Partial<AttentionObservation> = {}): AttentionObservation {
	return {
		kind: "bash",
		sourceId: "job-1",
		generation: "generation-1",
		label: "Build",
		status: "failed",
		startedAt: 100,
		...overrides,
	};
}

function findEvent(
	snapshot: AttentionStoreSnapshot,
	sourceId: string,
): AttentionStoreSnapshot["events"][number] | undefined {
	return snapshot.events.find((event: AttentionStoreSnapshot["events"][number]) => event.sourceId === sourceId);
}

describe("TasksAggregator attention integration", () => {
	test("observes stable generations, keeps failure truth, and persists acknowledgement across restart", async () => {
		const state = await temporaryStatePath();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobsObserver = new JobsObserver(manager, undefined);
		const sessions = new SessionObserverRegistry();
		const store = new AttentionEventStore({ path: state.file, rootDir: state.root, now: () => 200 });
		const aggregator = new TasksAggregator(manager, jobsObserver, sessions, store);
		let restarted: AttentionEventStore | undefined;

		try {
			const id = manager.register(
				"bash",
				"Compile",
				async (): Promise<SubagentRunOutcome> => ({ kind: "failed", text: "compile failed" }),
				{ id: "compile", metadata: { monitor: true } },
			);
			const failedJob = manager.getAllJobs().find(job => job.id === id);
			if (!failedJob) throw new Error("registered job was not retained");
			await failedJob.promise;
			await store.flush();

			const firstEvent = findEvent(store.getSnapshot(), id);
			expect(firstEvent?.generation).toBe(failedJob.generation);
			expect(firstEvent?.revision).toBe(2);
			expect(aggregator.getSnapshot().rows.find(row => row.id === `bash:${id}`)?.status).toBe("failed");
			expect(aggregator.getSnapshot().failedUnacknowledged).toBe(true);

			jobsObserver.acknowledgeFailures();
			expect(jobsObserver.getSnapshot().failedUnacknowledged).toBe(false);
			expect(aggregator.getSnapshot().failedUnacknowledged).toBe(true);

			const acknowledgement = await aggregator.acknowledgeFailures();
			expect(acknowledgement.ok).toBe(true);
			await store.flush();
			expect(store.getSnapshot().failedUnacknowledged).toBe(false);
			expect(aggregator.getSnapshot().failedUnacknowledged).toBe(false);

			const identity: AttentionEventIdentity = {
				kind: "bash",
				sourceId: id,
				generation: failedJob.generation,
			};
			const retry = observation({
				sourceId: id,
				generation: failedJob.generation,
				label: "Compile retry",
				status: "failed",
				startedAt: failedJob.startTime,
			});
			await store.observe(retry);
			await store.observe(retry);
			await store.flush();
			const retriedEvent = findEvent(store.getSnapshot(), id);
			expect(retriedEvent?.revision).toBe(3);
			expect(store.getSnapshot().failedUnacknowledged).toBe(true);

			restarted = new AttentionEventStore({ path: state.file, rootDir: state.root });
			expect(restarted.getSnapshot().failedUnacknowledged).toBe(true);
			expect((await restarted.acknowledgeFailures([{ ...identity, revision: 2 }])).ok).toBe(false);
			expect((await restarted.acknowledgeFailures([{ ...identity, revision: 3 }])).ok).toBe(true);
			await restarted.flush();
			expect(restarted.getSnapshot().failedUnacknowledged).toBe(false);
		} finally {
			await aggregator.dispose();
			jobsObserver.dispose();
			sessions.dispose();
			restarted?.dispose();
			await manager.dispose({ timeoutMs: 0 });
			await fs.rm(state.root, { recursive: true, force: true });
		}
	});

	test("isolates same source IDs by task kind and generation", async () => {
		const store = new AttentionEventStore();
		await store.observe(observation({ sourceId: "shared", generation: "generation-1" }));
		await store.observe(observation({ sourceId: "shared", generation: "generation-2" }));
		await store.observe(observation({ kind: "subagent", sourceId: "shared", generation: "generation-1" }));
		await store.observe(observation({ sourceId: "shared", generation: "generation-1" }));
		await store.flush();

		const snapshot = store.getSnapshot();
		expect(snapshot.events).toHaveLength(3);
		expect(snapshot.events.filter(event => event.kind === "bash")).toHaveLength(2);
		expect(snapshot.events.filter(event => event.kind === "subagent")).toHaveLength(1);
		expect(
			snapshot.events.find(event => event.kind === "bash" && event.generation === "generation-1")?.revision,
		).toBe(1);
		expect(
			snapshot.events.find(event => event.kind === "bash" && event.generation === "generation-2")?.revision,
		).toBe(1);
	});

	test("does not claim acknowledgement when persistence fails", async () => {
		const state = await temporaryStatePath();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobsObserver = new JobsObserver(manager, undefined);
		const sessions = new SessionObserverRegistry();
		const store = new AttentionEventStore({ path: state.file, rootDir: state.root });
		const aggregator = new TasksAggregator(manager, jobsObserver, sessions, store);
		try {
			const id = manager.register(
				"bash",
				"Fails to persist",
				async (): Promise<SubagentRunOutcome> => ({ kind: "failed", text: "failure" }),
				{ id: "persist-failure", metadata: { monitor: true } },
			);
			const failedJob = manager.getAllJobs().find(job => job.id === id);
			if (!failedJob) throw new Error("registered job was not retained");
			await failedJob.promise;
			await store.flush();
			expect(store.getSnapshot().failedUnacknowledged).toBe(true);

			await fs.rm(state.file);
			await fs.mkdir(state.file);
			const receipt = await aggregator.acknowledgeFailures();
			expect(receipt.ok).toBe(false);
			expect(receipt.status).toBe("invalid_path");
			expect(store.getSnapshot().failedUnacknowledged).toBe(true);
		} finally {
			await aggregator.dispose();
			jobsObserver.dispose();
			sessions.dispose();
			await manager.dispose({ timeoutMs: 0 });
			await fs.rm(state.root, { recursive: true, force: true });
		}
	});

	test("deduplicates observations while retaining active attention within terminal bounds", async () => {
		const store = new AttentionEventStore({ maxTerminalHistory: 1, now: () => 500 });
		const active = observation({ sourceId: "active", generation: "active-generation", status: "running" });
		await store.observe(active);
		await store.observe(active);
		await store.observe(observation({ sourceId: "done-1", status: "done", startedAt: 101 }));
		await store.observe(observation({ sourceId: "done-2", status: "done", startedAt: 102 }));

		const snapshot = store.getSnapshot();
		expect(snapshot.events).toHaveLength(2);
		expect(snapshot.events.map(event => event.sourceId)).toEqual(expect.arrayContaining(["active", "done-2"]));
		expect(snapshot.events.map(event => event.sourceId)).not.toContain("done-1");
		expect(snapshot.events.find(event => event.sourceId === "active")?.revision).toBe(1);
	});
	test("preserves the jobs failure latch when the attention store is corrupt", async () => {
		const state = await temporaryStatePath();
		await fs.writeFile(state.file, "{not-json", "utf8");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobsObserver = new JobsObserver(manager, undefined);
		const sessions = new SessionObserverRegistry();
		const store = new AttentionEventStore({ path: state.file, rootDir: state.root });
		const aggregator = new TasksAggregator(manager, jobsObserver, sessions, store);
		try {
			const id = manager.register(
				"bash",
				"Corrupt state failure",
				async (): Promise<SubagentRunOutcome> => ({ kind: "failed", text: "failure" }),
				{ id: "corrupt-state", metadata: { monitor: true } },
			);
			const failedJob = manager.getAllJobs().find(job => job.id === id);
			if (!failedJob) throw new Error("registered job was not retained");
			await failedJob.promise;
			expect(store.getSnapshot().status).toBe("corrupt");
			expect(aggregator.getSnapshot().failedUnacknowledged).toBe(true);
			const receipt = await aggregator.acknowledgeFailures();
			expect(receipt.ok).toBe(false);
			expect(receipt.status).toBe("corrupt");
			expect(jobsObserver.getSnapshot().failedUnacknowledged).toBe(true);
			expect(aggregator.getSnapshot().failedUnacknowledged).toBe(true);
		} finally {
			await aggregator.dispose();
			jobsObserver.dispose();
			sessions.dispose();
			await manager.dispose({ timeoutMs: 0 });
			await fs.rm(state.root, { recursive: true, force: true });
		}
	});
	test("bounds provisional sessions to 500 rows and observations without a fabricated failure", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobsObserver = new JobsObserver(manager, undefined);
		const sessions = new SessionObserverRegistry();
		const eventBus = new EventBus();
		sessions.subscribeToEventBus(eventBus);
		for (let index = 0; index < 501; index++) {
			eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: `provisional-${index}`,
				agent: "worker",
				agentSource: "bundled",
				status: "started",
				index,
			});
		}
		const store = new AttentionEventStore({ maxIdentities: 500, maxTerminalHistory: 100 });
		const aggregator = new TasksAggregator(manager, jobsObserver, sessions, store);
		try {
			await aggregator.flush();
			const snapshot = aggregator.getSnapshot();
			expect(snapshot.rows.length).toBeLessThanOrEqual(500);
			expect(snapshot.rows).toHaveLength(500);
			expect(snapshot.overflowCount).toBe(1);
			expect(snapshot.failedUnacknowledged).toBe(false);
			expect(snapshot.attentionStatus === undefined || snapshot.attentionStatus === "overflow").toBe(true);
			expect(store.getSnapshot().events.length).toBeLessThanOrEqual(500);
			expect(store.getSnapshot().status).toBe("memory_only");
			expect(store.getSnapshot().failedUnacknowledged).toBe(false);
		} finally {
			await aggregator.dispose();
			jobsObserver.dispose();
			sessions.dispose();
			await manager.dispose({ timeoutMs: 0 });
		}
	});
	test("derives distinct bounded session ledger paths without exposing session ids", () => {
		const projectRoot = path.join(os.tmpdir(), "attention-ledger-project");
		const ledgerDirectory = path.join(projectRoot, ".gjc", "state", "attention-events");
		const first = getAttentionLedgerPath(projectRoot, "session-secret-alpha");
		const second = getAttentionLedgerPath(projectRoot, "session-secret-beta");
		expect(first).not.toBe(second);
		expect(first.startsWith(`${ledgerDirectory}${path.sep}`)).toBe(true);
		expect(second.startsWith(`${ledgerDirectory}${path.sep}`)).toBe(true);
		expect(first).not.toContain("session-secret-alpha");
		expect(second).not.toContain("session-secret-beta");
		expect(path.basename(first)).toMatch(/^[0-9a-f]{64}\.json$/u);
	});
});
