import { beforeAll, describe, expect, test } from "bun:test";
import type { AsyncJobManager } from "../src/async";
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
			],
			deadLettered: [
				{
					jobId: "evicted-failed",
					generation: "generation-4",
					attempt: 3,
					lastError: "delivery\tfailed",
					recordedAt: 1,
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
			"evicted-failed",
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
		expect(foldedItems).toHaveLength(4);
		expect(new Set(foldedItems.map(item => item.value)).size).toBe(4);
		const failedItem = foldedItems.find(item => item.value.startsWith("folded:folded-failed:"));
		expect(failedItem).toMatchObject({
			description: "failed-visible",
			hint: "failed",
			disabled: true,
		});
		expect(failedItem?.label).not.toContain("\t");

		const rendered = renderSegment("jobs", segmentContext(observed));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toContain("4 folded");
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
			description: "failed-visible",
			hint: "failed",
			disabled: true,
		});
		expect(observed.worstState).toBe("failed");
		expect(observed.monitors).toEqual(EMPTY_JOBS_SNAPSHOT.monitors);

		observer.dispose();
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
