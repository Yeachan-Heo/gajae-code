import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { Settings } from "../src/config/settings";
import type { CustomMessage } from "../src/session/messages";
import type { ToolSession } from "../src/tools/index";
import { JobTool } from "../src/tools/job";
import { MonitorTool } from "../src/tools/monitor";

type QueuedMessage = { customType: string; content: string; details?: unknown };

function detailsOf(entry: QueuedMessage): { taskId?: string; notificationId?: string; coalescedCount?: number } {
	return (entry.details ?? {}) as { taskId?: string; notificationId?: string; coalescedCount?: number };
}

function makeSession(ownerId: string, queue: QueuedMessage[], settings: Settings): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => `session-${ownerId}`,
		getAgentId: () => ownerId,
		steer: (msg: { customType: string; content: string; details?: unknown }) => queue.push(msg as QueuedMessage),
		sendCustomMessage: async (msg: { customType: string; content: string; details?: unknown }) => {
			queue.push(msg as QueuedMessage);
		},
		purgeQueuedCustomMessages: (predicate: (message: CustomMessage) => boolean) => {
			let removed = 0;
			for (let i = queue.length - 1; i >= 0; i -= 1) {
				const candidate = queue[i];
				if (candidate && predicate(candidate as never)) {
					queue.splice(i, 1);
					removed += 1;
				}
			}
			return {
				agentSteering: 0,
				agentFollowUp: removed,
				pendingNextTurn: 0,
				displaySteering: 0,
				displayFollowUp: 0,
				totalExecutable: removed,
			};
		},
		allocateOutputArtifact: async () => ({}),
	} as unknown as ToolSession;
}

async function tickMicrotasks(times = 4): Promise<void> {
	for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("monitor backlog red-team public surfaces", () => {
	const previousInstance = AsyncJobManager.instance();
	let settings: Settings;
	let manager: AsyncJobManager;

	beforeEach(async () => {
		settings = await Settings.init();
		manager = new AsyncJobManager({ retentionMs: 1000, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
	});

	afterEach(async () => {
		await manager.dispose({ timeoutMs: 200 });
		AsyncJobManager.setInstance(previousInstance);
	});

	it("cancel of a persistent monitor purges queued task-notifications and suppresses trailing output", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		const monitor = new MonitorTool(session);
		const job = new JobTool(session);
		const result = await monitor.execute("call", {
			command: "printf 'before-cancel\\n'; sleep 30; printf 'after-cancel\\n'",
			kind: "poll",
			description: "cancel purge redteam",
			persistent: true,
		});
		const taskId = result.details?.taskId;
		expect(taskId).toBeString();

		const deadline = Date.now() + 2_000;
		while (!queue.some(entry => detailsOf(entry).taskId === taskId)) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for initial monitor notification");
			await Bun.sleep(5);
		}
		expect(queue.filter(entry => detailsOf(entry).taskId === taskId).length).toBe(1);

		const cancelResult = await job.execute("job", { cancel: [taskId!] });
		expect(cancelResult.details?.cancelled?.[0]?.status).toBe("cancelled");
		await manager.waitForAll();
		await tickMicrotasks();

		expect(queue.filter(entry => detailsOf(entry).taskId === taskId)).toHaveLength(0);
		const jobRecord = manager.getJob(taskId!);
		const captured = jobRecord?.resultText ?? jobRecord?.errorText ?? "";
		expect(captured).toContain("before-cancel");
		expect(captured).not.toContain("after-cancel");
	});

	it("post-eviction job cancel purges via owner-scoped tombstone and unknown ids stay not_found", async () => {
		await manager.dispose({ timeoutMs: 200 });
		manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		const queue: QueuedMessage[] = [];
		const ownerSession = makeSession("0-Owner", queue, settings);
		const otherSession = makeSession("9-Other", queue, settings);
		const monitor = new MonitorTool(ownerSession);
		const ownerJob = new JobTool(ownerSession);
		const otherJob = new JobTool(otherSession);
		const result = await monitor.execute("call", {
			command: "printf 'retained-line\\n'",
			kind: "log",
			description: "tombstone redteam",
			persistent: true,
		});
		const taskId = result.details!.taskId;
		await manager.waitForAll();
		await tickMicrotasks();
		queue.push({ customType: "task-notification", content: "late residual", details: { taskId } });
		expect(manager.getJob(taskId)).toBeUndefined();
		expect(queue.filter(entry => detailsOf(entry).taskId === taskId).length).toBeGreaterThan(0);

		const wrongOwner = await otherJob.execute("job", { cancel: [taskId] });
		expect(wrongOwner.details?.cancelled?.[0]?.status).toBe("not_found");
		expect(queue.filter(entry => detailsOf(entry).taskId === taskId).length).toBeGreaterThan(0);

		const ownerCancel = await ownerJob.execute("job", { cancel: [taskId] });
		expect(ownerCancel.details?.cancelled?.[0]?.status).not.toBe("not_found");
		expect(ownerCancel.content[0]?.type === "text" ? ownerCancel.content[0].text : "").toContain(
			"purged queued notifications",
		);
		expect(queue.filter(entry => detailsOf(entry).taskId === taskId)).toHaveLength(0);

		const unknown = await ownerJob.execute("job", { cancel: ["bg_does_not_exist"] });
		expect(unknown.details?.cancelled?.[0]?.status).toBe("not_found");
	});

	it("persistent coalescing keeps newest failed state while bounding pending notifications", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		const result = await new MonitorTool(session).execute("call", {
			command:
				"for i in $(seq 1 80); do printf '0 passed, 2 pending, 0 failed\\n'; done; printf '0 passed, 0 pending, 2 failed\\n'; exit 7",
			kind: "poll",
			description: "coalescing cap redteam",
			persistent: true,
		});
		const taskId = result.details!.taskId;
		await manager.waitForAll();
		await tickMicrotasks();

		const entries = queue.filter(entry => detailsOf(entry).taskId === taskId);
		expect(entries.length).toBeLessThanOrEqual(3);
		expect(entries.some(entry => entry.content.includes("0 passed, 0 pending, 2 failed"))).toBe(true);
		expect(entries.some(entry => (detailsOf(entry).coalescedCount ?? 0) > 0)).toBe(true);
		expect(manager.getJob(taskId)?.status).toBe("failed");
	});

	it("non-persistent monitor delivers exactly one notification and terminal eviction does not purge it", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		const result = await new MonitorTool(session).execute("call", {
			command: "printf 'first\\nsecond\\n'",
			kind: "log",
			description: "non persistent redteam",
			persistent: false,
		});
		const taskId = result.details!.taskId;
		await manager.waitForAll();
		await tickMicrotasks();

		const entries = queue.filter(entry => detailsOf(entry).taskId === taskId);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.content).toContain("first");
		expect(entries[0]?.content).not.toContain("second");
		expect(manager.getJob(taskId)?.status).toBe("cancelled");
		expect(queue.filter(entry => detailsOf(entry).taskId === taskId)).toHaveLength(1);
	});

	it("captured AsyncJobManager output is byte-faithful despite notification coalescing", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		const expected = "α\nrepeat\nrepeat\nemoji-🙂\n";
		const result = await new MonitorTool(session).execute("call", {
			command: "printf 'α\\nrepeat\\nrepeat\\nemoji-🙂\\n'",
			kind: "log",
			description: "byte faithful redteam",
			persistent: true,
		});
		const taskId = result.details!.taskId;
		await manager.waitForAll();
		await tickMicrotasks();

		const slice = manager.readOutputSince(taskId, 0, { ownerId: "0-Owner" });
		expect(slice?.text).toBe(expected);
		expect(Buffer.byteLength(slice?.text ?? "", "utf8")).toBe(Buffer.byteLength(expected, "utf8"));
		expect(queue.filter(entry => detailsOf(entry).taskId === taskId).length).toBeLessThan(
			expected.split("\n").length - 1,
		);
	});

	it("lifecycle cleanup is at-most-once per phase and tombstone purge is idempotent", async () => {
		await manager.dispose({ timeoutMs: 200 });
		manager = new AsyncJobManager({ retentionMs: 0, onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		const phases: string[] = [];
		const jobId = manager.register(
			"bash",
			"lifecycle monitor",
			async ({ signal }) => {
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				return "cancelled";
			},
			{
				ownerId: "0-Owner",
				metadata: { monitor: true },
				lifecycle: {
					onCancel: () => phases.push("cancel"),
					onTerminal: () => phases.push("terminal"),
					onEvict: () => phases.push("evict"),
				},
			},
		);

		expect(manager.cancel(jobId, { ownerId: "9-Other" })).toBe(false);
		expect(manager.cancel(jobId, { ownerId: "0-Owner" })).toBe(true);
		expect(manager.cancel(jobId, { ownerId: "0-Owner" })).toBe(false);
		await manager.waitForAll();
		expect(manager.purgeMonitorTombstone(jobId, { ownerId: "9-Other" })).toEqual({ found: false });
		expect(manager.purgeMonitorTombstone(jobId, { ownerId: "0-Owner" })).toEqual({
			found: true,
			status: "cancelled",
		});
		expect(manager.purgeMonitorTombstone(jobId, { ownerId: "0-Owner" })).toEqual({ found: false });

		expect(phases.filter(phase => phase === "cancel")).toHaveLength(1);
		expect(phases.filter(phase => phase === "terminal")).toHaveLength(1);
		expect(phases.filter(phase => phase === "evict")).toHaveLength(2);
	});
});
