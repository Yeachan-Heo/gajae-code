import { beforeAll, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "../src/async";
import { buildJobsListItems } from "../src/modes/components/jobs-overlay-model";
import { renderSegment, type SegmentContext } from "../src/modes/components/status-line/segments";
import { type AsyncJobsSnapshot, EMPTY_JOBS_SNAPSHOT, JobsObserver } from "../src/modes/jobs-observer";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function fakeManager(snapshot: AsyncJobsSnapshot): AsyncJobManager {
	const listeners = new Set<() => void>();
	return {
		onChange: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getJobsSnapshot: () => snapshot,
	} as unknown as AsyncJobManager;
}

function segmentContext(jobs: SegmentContext["jobs"]): SegmentContext {
	return {
		session: { state: {} } as unknown as SegmentContext["session"],
		width: 120,
		options: {},
		planMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("folded jobs surfacing", () => {
	test("consumes the authoritative snapshot, counts folded work, and keeps rows read-only", () => {
		const sourceSnapshot: AsyncJobsSnapshot = {
			jobs: [
				{
					id: "folded-failed",
					kind: "bash",
					label: "echo\tfailed output",
					status: "completed",
					generation: "generation-1",
					backgrounded: true,
					deliveryState: "failed-visible",
				},
				{
					id: "folded-pending",
					kind: "task",
					label: "pending task",
					status: "running",
					generation: "generation-2",
					backgrounded: true,
					deliveryState: "pending",
				},
				{
					id: "delivered-folded",
					kind: "bash",
					label: "delivered background job",
					status: "completed",
					generation: "generation-3",
					backgrounded: true,
					deliveryState: "delivered",
				},
				{
					id: "ordinary-failed",
					kind: "bash",
					label: "ordinary failed command",
					status: "failed",
					generation: "generation-ordinary",
					backgrounded: false,
					deliveryState: "failed-visible",
				},
			],
			deadLettered: [
				{
					jobId: "evicted-failed",
					generation: "generation-4",
					backgrounded: true,
					attempt: 3,
					lastError: "delivery\tfailed",
					recordedAt: 1,
				},
				{
					jobId: "evicted-ordinary",
					generation: "generation-ordinary-evicted",
					backgrounded: false,
					attempt: 3,
					lastError: "ordinary delivery failed",
					recordedAt: 2,
				},
			],
		};
		const observer = new JobsObserver(fakeManager(sourceSnapshot), "owner-1");
		const observed = observer.getSnapshot();

		const folded = observed.foldedJobs ?? [];
		expect(folded.map(job => job.id)).toEqual([
			"folded-failed",
			"folded-pending",
			"delivered-folded",
			"ordinary-failed",
			"evicted-failed",
			"evicted-ordinary",
		]);
		// The observer preserves the manager's contradictory-but-authoritative
		// state instead of deriving delivery from status or dead-letter presence.
		expect(folded.find(job => job.id === "folded-failed")).toMatchObject({
			status: "completed",
			deliveryState: "failed-visible",
			backgrounded: true,
		});

		const items = buildJobsListItems(observed);
		const foldedItems = items.filter(item => item.value.startsWith("folded:"));
		expect(foldedItems).toHaveLength(6);
		expect(new Set(foldedItems.map(item => item.value)).size).toBe(6);
		const failedItem = foldedItems.find(item => item.value.startsWith("folded:folded-failed:"));
		expect(failedItem).toMatchObject({
			description: "failed-visible",
			value: "folded:folded-failed:generation-1",
			hint: "failed",
			disabled: true,
		});
		expect(failedItem?.label).not.toContain("\t");

		const rendered = renderSegment("jobs", segmentContext(observed));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toContain("4 folded");
		expect(Bun.stripANSI(rendered.content)).not.toContain("5 folded");
		expect(observed.worstState).toBe("failed");

		observer.dispose();
	});

	test("does not drop a failed-visible scalar dead letter", () => {
		const sourceSnapshot: AsyncJobsSnapshot = {
			jobs: [],
			deadLettered: [
				{
					jobId: "gone",
					generation: "generation-gone",
					attempt: 3,
					lastError: "terminal failure",
					recordedAt: 1,
				},
			],
		};
		const observer = new JobsObserver(fakeManager(sourceSnapshot), undefined);
		const observed = observer.getSnapshot();
		const items = buildJobsListItems(observed);

		expect(observed.foldedJobs).toHaveLength(1);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			label: "dead-letter · gone",
			description: "failed-visible · attempt 3 · error: terminal failure",
			hint: "failed",
			disabled: true,
			value: "folded:gone:generation-gone",
		});
		expect(observed.worstState).toBe("failed");
		expect(observed.monitors).toEqual(EMPTY_JOBS_SNAPSHOT.monitors);

		observer.dispose();
	});

	test("renders bounded dead-letter attempt and error metadata in folded rows", () => {
		const sourceSnapshot: AsyncJobsSnapshot = {
			jobs: [],
			deadLettered: [
				{
					jobId: "bounded-dead-letter",
					generation: "generation-bounded-dead-letter",
					attempt: 3,
					lastError: `delivery failed\t${"x".repeat(10_000)}`,
					recordedAt: 1,
				},
			],
		};
		const observer = new JobsObserver(fakeManager(sourceSnapshot), undefined);
		const item = buildJobsListItems(observer.getSnapshot())[0];
		const description = item?.description ?? "";

		expect(description).toContain("attempt 3");
		expect(description).toContain("error: delivery failed");
		expect(description).not.toContain("\t");
		expect(description.length).toBeLessThanOrEqual(80);

		observer.dispose();
	});

	test("renders an existing folded row's retained error text without dead-letter duplication", () => {
		const items = buildJobsListItems({
			...EMPTY_JOBS_SNAPSHOT,
			foldedJobs: [
				{
					id: "retained-error",
					kind: "bash",
					label: "retained error",
					status: "failed",
					generation: "generation-retained-error",
					backgrounded: true,
					deliveryState: "failed-visible",
					errorText: "callback failed",
				},
			],
		});

		expect(items[0]?.description).toContain("error: callback failed");
		expect(items[0]?.description).not.toContain("attempt");
	});

	test("surfaces an in-flight zero-retention delivery after its job record is evicted", async () => {
		const deliveryStarted = Promise.withResolvers<void>();
		const releaseDelivery = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async () => {
				deliveryStarted.resolve();
				await releaseDelivery.promise;
			},
		});
		const observer = new JobsObserver(manager, "owner-folded");

		try {
			const jobId = manager.register("bash", "evicted folded delivery", async () => "payload", {
				ownerId: "owner-folded",
				metadata: { backgrounded: true },
			});
			const generation = manager.getJob(jobId)?.generation ?? "";
			await deliveryStarted.promise;

			expect(manager.getJob(jobId)).toBeUndefined();
			expect(observer.getSnapshot().foldedJobs).toContainEqual({
				id: jobId,
				kind: "bash",
				label: "evicted folded delivery",
				status: "completed",
				generation,
				backgrounded: true,
				deliveryState: "pending",
			});
		} finally {
			releaseDelivery.resolve();
			observer.dispose();
			await manager.dispose({ timeoutMs: 250 });
		}
	});

	// AC6 asserted as a partition PROPERTY rather than case by case: every
	// terminal job must land in exactly one public delivery state, and the silent
	// set -- terminal work surfaced in no state at all -- must be empty. A
	// case-by-case test can pass while some status/deliveryState combination
	// still falls through.
	test("partitions every terminal job into exactly one public delivery state", () => {
		const terminalStatuses = ["completed", "failed", "cancelled"] as const;
		const deliveryStates = ["pending", "delivered", "failed-visible"] as const;
		const jobs = terminalStatuses.flatMap(status =>
			deliveryStates.map(deliveryState => ({
				id: `${status}-${deliveryState}`,
				kind: "bash",
				label: `${status} job with ${deliveryState} delivery`,
				status,
				generation: `generation-${status}-${deliveryState}`,
				backgrounded: true,
				deliveryState,
			})),
		);
		const sourceSnapshot: AsyncJobsSnapshot = { jobs, deadLettered: [] };

		const observer = new JobsObserver(fakeManager(sourceSnapshot), "owner-1");
		const observed = observer.getSnapshot();
		const folded = observed.foldedJobs ?? [];

		// Exactly one row per terminal job: no duplication, no omission.
		expect(folded).toHaveLength(jobs.length);
		expect(new Set(folded.map(job => job.id)).size).toBe(jobs.length);

		// Classification is copied verbatim, so the observer cannot disagree with
		// the manager about which single state a job is in.
		for (const job of jobs) {
			const row = folded.find(candidate => candidate.id === job.id);
			expect(row).toMatchObject({ status: job.status, deliveryState: job.deliveryState });
		}

		// The silent set is empty: every terminal job that has not been delivered
		// is visible as pending or failed, never absent.
		const undelivered = jobs.filter(job => job.deliveryState !== "delivered");
		const visibleUndelivered = folded.filter(job => job.deliveryState !== "delivered");
		expect(visibleUndelivered.map(job => job.id).sort()).toEqual(undelivered.map(job => job.id).sort());

		// And the buckets are mutually exclusive.
		for (const row of folded) {
			const matches = deliveryStates.filter(state => row.deliveryState === state);
			expect(matches).toHaveLength(1);
		}

		observer.dispose();
	});
});
