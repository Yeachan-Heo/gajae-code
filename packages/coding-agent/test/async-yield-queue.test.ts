import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { type AsyncJob, AsyncJobManager } from "@gajae-code/coding-agent/async";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { createAgentSession } from "@gajae-code/coding-agent/sdk";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { CustomMessage } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import {
	lookupOwnedRegistration,
	registerOwnedRegistration,
	type TurnRegistrationKey,
} from "@gajae-code/coding-agent/session/terminal-abort";
import { YieldQueue } from "@gajae-code/coding-agent/session/yield-queue";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { JobTool } from "@gajae-code/coding-agent/tools/job";
import { TempDir } from "@gajae-code/utils";

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

	test("acknowledgement during formatting settles only the stale owned registration", async () => {
		const tempDir = TempDir.createSync("@gjc-async-yield-race-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
		let staleRegistration: TurnRegistrationKey | undefined;
		let liveRegistration: TurnRegistrationKey | undefined;
		const formattingStarted = Promise.withResolvers<void>();
		const releaseFormatting = Promise.withResolvers<{ id?: string; path?: string }>();
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model to exist");
			created = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				settings: Settings.isolated({ "async.enabled": true, "compaction.enabled": false }),
				model,
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				notificationHostModeSupported: false,
				sdkHostModeSupported: false,
			});
			const manager = AsyncJobManager.instance();
			if (!manager) throw new Error("Expected the SDK session to own an async job manager");
			const endpointId = AsyncJobManager.endpointIdOf(manager);
			if (!endpointId) throw new Error("Expected the async job manager endpoint to be registered");

			vi.spyOn(created.session.sessionManager, "allocateArtifactPath").mockImplementation(async () => {
				formattingStarted.resolve();
				return await releaseFormatting.promise;
			});
			const staleResult = Promise.withResolvers<string>();
			const staleJobId = manager.register("bash", "formatting race", async () => staleResult.promise);
			const staleJob = manager.getJob(staleJobId);
			if (!staleJob) throw new Error("Expected the formatting-race job to be registered");
			staleRegistration = {
				endpointId,
				endpointGeneration: 0,
				lineageIdHash: "formatting-race-lineage",
				promptAttemptEpoch: 1,
				jobId: staleJob.id,
				jobGeneration: staleJob.generation,
			};
			registerOwnedRegistration(staleRegistration);

			staleResult.resolve("x".repeat(12_001));
			await formattingStarted.promise;
			// The callback has passed its initial suppression check and is now
			// awaiting artifact formatting. Acknowledgement suppresses the job
			// before the callback can enqueue its async-result entry.
			manager.acknowledgeDeliveries([staleJobId]);

			const liveResult = Promise.withResolvers<string>();
			const liveJobId = manager.register("task", "live job", async () => liveResult.promise);
			const liveJob = manager.getJob(liveJobId);
			if (!liveJob) throw new Error("Expected the live job to be registered");
			liveRegistration = {
				endpointId,
				endpointGeneration: 0,
				lineageIdHash: "live-lineage",
				promptAttemptEpoch: 2,
				jobId: liveJob.id,
				jobGeneration: liveJob.generation,
			};
			registerOwnedRegistration(liveRegistration);

			releaseFormatting.resolve({});
			await waitUntil(
				() =>
					created!.session.yieldQueue.has("async-result") &&
					manager.getDeliveryState().pendingJobIds.includes(staleJobId),
				"stale completion to enqueue with its retained claim",
			);
			await created.session.yieldQueue.flush("streaming");

			expect(manager.getDeliveryState().pendingJobIds).not.toContain(staleJobId);
			expect(lookupOwnedRegistration(staleJob.id, staleJob.generation, endpointId)).toBeUndefined();
			expect(lookupOwnedRegistration(liveJob.id, liveJob.generation, endpointId)).toEqual(liveRegistration);
			expect(manager.getJob(liveJob.id)?.status).toBe("running");
			liveResult.resolve("settle live job");
		} finally {
			releaseFormatting.resolve({});
			if (staleRegistration) {
				const manager = AsyncJobManager.forEndpoint(staleRegistration.endpointId);
				if (manager) manager.acknowledgeDeliveries([staleRegistration.jobId]);
			}
			if (created) await created.session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
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

test("flush preserves the queued FIFO chronology across contiguous origin runs", async () => {
	// Entries arrive as A1, B1, A2: a map grouping every A together would
	// deliver A2 before the earlier B1, changing the observable chronology
	// of async results. Contiguous origin runs keep the arrival order
	// (review thread P2).
	const { queue, followUps } = createHarness(false);
	const a1 = { jobId: "j-1", result: "a1", kind: "origin-a" };
	const b1 = { jobId: "j-2", result: "b1", kind: "origin-b" };
	const a2 = { jobId: "j-3", result: "a2", kind: "origin-a" };
	queue.register("test-fifo", {
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
	queue.enqueue("test-fifo", a1);
	queue.enqueue("test-fifo", b1);
	queue.enqueue("test-fifo", a2);
	await queue.flush("streaming");
	const grouped = followUps as CustomMessage<{ jobs: string[] }>[];
	expect(grouped.map(m => m.content)).toEqual(["a1", "b1", "a2"]);
	expect(grouped.map(m => m.details?.jobs)).toEqual([["j-1"], ["j-2"], ["j-3"]]);
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
