import { beforeAll, describe, expect, test } from "bun:test";
import type { AsyncJobManager } from "../src/async";
import {
	buildJobsListItems,
} from "../src/modes/components/jobs-overlay-model";
import { renderSegment, type SegmentContext } from "../src/modes/components/status-line/segments";
import { initTheme } from "../src/modes/theme/theme";
import {
	EMPTY_JOBS_SNAPSHOT,
	JobsObserver,
	type AsyncJobsSnapshot,
} from "../src/modes/jobs-observer";

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
});
