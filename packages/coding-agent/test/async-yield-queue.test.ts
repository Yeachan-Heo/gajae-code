import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@gajae-code/agent-core";
import { type AsyncJob, AsyncJobManager } from "@gajae-code/coding-agent/async";
import type { CustomMessage } from "@gajae-code/coding-agent/session/messages";
import { YieldQueue } from "@gajae-code/coding-agent/session/yield-queue";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { JobTool } from "@gajae-code/coding-agent/tools/job";

type AsyncEntry = {
	jobId: string;
	generation?: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
};

type AsyncDetails = {
	jobs: Array<{
		jobId: string;
		type?: "bash" | "task";
		label?: string;
		durationMs?: number;
	}>;
};

function buildAsyncMessage(entries: AsyncEntry[]): CustomMessage<AsyncDetails> | null {
	if (entries.length === 0) return null;
	return {
		role: "custom",
		customType: "async-result",
		content: entries.map(entry => entry.result).join("\n"),
		display: true,
		attribution: "agent",
		details: {
			jobs: entries.map(entry => ({
				jobId: entry.jobId,
				type: entry.job?.type,
				label: entry.job?.label,
				durationMs: entry.durationMs,
			})),
		},
		timestamp: 0,
	};
}

function asyncDetails(message: AgentMessage): AsyncDetails {
	if (message.role !== "custom") throw new Error(`Expected custom message, got ${message.role}`);
	return (message as CustomMessage<AsyncDetails>).details ?? { jobs: [] };
}

function createToolSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: {
			get: (key: string) => (key === "async.pollWaitDuration" ? "5s" : undefined),
		},
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => null,
	} as unknown as ToolSession;
}

function createHarness(initialStreaming: boolean) {
	let streaming = initialStreaming;
	const followUps: AgentMessage[] = [];
	const prompts: AgentMessage[][] = [];
	const scheduledFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectStreaming: message => {
			followUps.push(message);
		},
		injectIdle: async messages => {
			prompts.push(messages);
		},
		scheduleIdleFlush: run => {
			scheduledFlushes.push(run);
		},
	});
	let manager!: AsyncJobManager;
	queue.register<AsyncEntry>("async-result", {
		isStale: entry => manager.isDeliverySuppressed(entry.jobId, entry.generation),
		build: buildAsyncMessage,
	});
	manager = new AsyncJobManager({
		onJobComplete: (jobId, result, job) => {
			if (manager.isDeliverySuppressed(jobId)) return;
			queue.enqueue<AsyncEntry>("async-result", {
				jobId,
				generation: job?.generation,
				result,
				job,
				durationMs: job ? Math.max(0, Date.now() - job.startTime) : undefined,
			});
		},
	});
	AsyncJobManager.setInstance(manager);
	return {
		manager,
		queue,
		followUps,
		prompts,
		scheduledFlushes,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(5);
	}
}

afterEach(async () => {
	const manager = AsyncJobManager.instance();
	if (manager) {
		await manager.dispose({ timeoutMs: 200 });
	}
	AsyncJobManager.resetForTests();
});

describe("async result yield queue delivery", () => {
	test("job poll acknowledgement suppresses already staged completion", async () => {
		const harness = createHarness(true);
		const jobId = harness.manager.register("bash", "race job", async () => "inline result");

		await harness.manager.waitForAll();
		await waitUntil(() => harness.queue.has("async-result"), "Timed out waiting for staged async result");

		const tool = new JobTool(createToolSession());
		const result = await tool.execute("tool-call", { poll: [jobId] });
		expect(result.details?.jobs.find(job => job.id === jobId)?.status).toBe("completed");

		await harness.queue.flush("streaming");

		expect(harness.followUps).toHaveLength(0);
	});

	test("multiple completions in one yield window become one follow-up", async () => {
		const harness = createHarness(true);
		const firstJobId = harness.manager.register("bash", "first", async () => "first result");
		const secondJobId = harness.manager.register("task", "second", async () => "second result");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
		await harness.queue.flush("streaming");

		expect(harness.followUps).toHaveLength(1);
		const deliveredIds = asyncDetails(harness.followUps[0]!)
			.jobs.map(job => job.jobId)
			.sort();
		expect(deliveredIds).toEqual([firstJobId, secondJobId].sort());
	});

	test("idle completion prompts once after scheduled idle flush", async () => {
		const harness = createHarness(false);
		const jobId = harness.manager.register("bash", "idle job", async () => "idle result");

		await harness.manager.waitForAll();
		expect(await harness.manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

		expect(harness.scheduledFlushes).toHaveLength(1);
		expect(harness.prompts).toHaveLength(0);
		await harness.scheduledFlushes[0]!();

		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]).toHaveLength(1);
		expect(asyncDetails(harness.prompts[0]![0]!).jobs.map(job => job.jobId)).toEqual([jobId]);
	});
});

test("flush builds one message per groupKey origin so owned drops cannot suppress other origins", async () => {
	const { queue, followUps } = createHarness(false);
	// Two entries from DIFFERENT ownership origins plus one ordinary entry.
	const g1 = { jobId: "j-1", result: "one", kind: "g1" };
	const g2 = { jobId: "j-2", result: "two", kind: "g2" };
	const ordinary = { jobId: "j-3", result: "three", kind: "ordinary" };
	queue.register("test-grouped", {
		groupKey: entry => entry.kind,
		build: (survivors: Array<{ jobId: string; result: string; kind: string }>) => ({
			role: "custom",
			customType: "async-result",
			content: survivors.map(s => s.result).join("+"),
			display: true,
			attribution: "agent",
			details: { jobs: survivors.map(s => s.jobId) },
			timestamp: 1,
		}),
	});
	queue.enqueue("test-grouped", g1);
	queue.enqueue("test-grouped", g2);
	queue.enqueue("test-grouped", ordinary);
	await queue.flush("streaming");
	// One message per origin (3 groups), each carrying only its own entries.
	const grouped = followUps as CustomMessage<{ jobs: string[] }>[];
	expect(grouped).toHaveLength(3);
	expect(grouped.map(m => m.content).sort()).toEqual(["one", "three", "two"]);
	expect(grouped.find(m => m.content === "one")?.details?.jobs).toEqual(["j-1"]);
	expect(grouped.find(m => m.content === "two")?.details?.jobs).toEqual(["j-2"]);
	expect(grouped.find(m => m.content === "three")?.details?.jobs).toEqual(["j-3"]);
	expect(grouped[0]?.details?.jobs).toBeDefined();
});

test("flush without a groupKey keeps the single-batch behavior", async () => {
	const { queue, followUps } = createHarness(false);
	queue.register("test-plain", {
		build: (survivors: string[]) => ({
			role: "custom",
			customType: "async-result",
			content: survivors.join("+"),
			display: true,
			attribution: "agent",
			details: {},
			timestamp: 1,
		}),
	});
	queue.enqueue("test-plain", "a");
	queue.enqueue("test-plain", "b");
	await queue.flush("streaming");
	const plain = followUps as CustomMessage<Record<string, never>>[];
	expect(plain).toHaveLength(1);
	expect(plain[0]?.content).toBe("a+b");
});
