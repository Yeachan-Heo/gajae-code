import { describe, expect, test } from "bun:test";
import {
	AsyncJobManager,
	type ResumeDescriptor,
	type SubagentRecord,
} from "@gajae-code/coding-agent/async/job-manager";

function subagentRecord(subagentId: string, currentJobId: string, status: SubagentRecord["status"]): SubagentRecord {
	return {
		subagentId,
		currentJobId,
		historicalJobIds: [],
		status,
		sessionFile: `/tmp/${subagentId}.jsonl`,
		resumable: true,
	};
}

function resumeDescriptor(subagentId: string): ResumeDescriptor {
	return { subagentId, data: { sessionFile: `/tmp/${subagentId}.jsonl` } };
}

describe("AsyncJobManager bounded dispose and delivery", () => {
	test("dispose timeout applies to never-settling jobs and records stuck ids", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		manager.register("task", "stuck", () => new Promise(() => {}), { id: "stuck-job" });

		const started = Date.now();
		const disposed = await manager.dispose({ timeoutMs: 25 });
		const elapsed = Date.now() - started;

		expect(disposed).toBe(false);
		expect(elapsed).toBeLessThan(250);
		expect(manager.getLastDisposeDiagnostics().stuckJobIds).toEqual(["stuck-job"]);
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("late completion after dispose timeout runs terminal lifecycle without rescheduling eviction", async () => {
		let resolveJob!: (value: string) => void;
		let terminalCalls = 0;
		let changeCalls = 0;
		const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 60_000 });
		manager.onChange(() => {
			changeCalls += 1;
		});
		manager.register(
			"task",
			"late resolver",
			() =>
				new Promise<string>(resolve => {
					resolveJob = resolve;
				}),
			{
				id: "late-resolver",
				lifecycle: {
					onTerminal: () => {
						terminalCalls += 1;
					},
				},
			},
		);

		const disposed = await manager.dispose({ timeoutMs: 25 });
		const changesAfterDispose = changeCalls;
		resolveJob("late done");
		await Bun.sleep(25);

		expect(disposed).toBe(false);
		expect(terminalCalls).toBe(1);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.getDeliveryState().queued).toBe(0);
		expect(changeCalls).toBe(changesAfterDispose);
	});

	test("multibyte delivery previews stay within utf8 byte head and tail budgets", async () => {
		let delivered = "";
		const manager = new AsyncJobManager({
			onJobComplete: (_jobId, text) => {
				delivered = text;
			},
		});
		const text = `${"界".repeat(12_000)}${"🙂".repeat(12_000)}`;
		manager.register("task", "multibyte", async () => text, { id: "multibyte-preview" });

		await manager.waitForAll();
		const drained = await manager.drainDeliveries({ timeoutMs: 1_000 });
		const [head = "", tail = ""] = delivered.split(/\n\n\[async delivery output truncated from \d+ bytes\]\n\n/);

		expect(drained).toBe(true);
		expect(delivered).toContain("[async delivery output truncated from ");
		expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(32 * 1024);
		expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(32 * 1024);
	});

	test("misaligned multibyte delivery preview tail stays within utf8 byte budget", async () => {
		let delivered = "";
		const manager = new AsyncJobManager({
			onJobComplete: (_jobId, text) => {
				delivered = text;
			},
		});
		const text = `${"🙂".repeat(16_385)}a`;
		manager.register("task", "misaligned multibyte", async () => text, { id: "misaligned-preview" });

		await manager.waitForAll();
		const drained = await manager.drainDeliveries({ timeoutMs: 1_000 });
		const [head = "", tail = ""] = delivered.split(/\n\n\[async delivery output truncated from \d+ bytes\]\n\n/);

		expect(drained).toBe(true);
		expect(delivered).toContain("[async delivery output truncated from 65541 bytes]");
		expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(32 * 1024);
		expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(32 * 1024);
		expect(delivered).not.toContain("\ufffd");
	});

	test("delivery queue is bounded and failing deliveries stop at retry cap", async () => {
		let attempts = 0;
		const manager = new AsyncJobManager({
			onJobComplete: () => {
				attempts += 1;
				throw new Error("persistent delivery failure");
			},
			maxRunningJobs: 150,
			retentionMs: 10_000,
		});

		for (let i = 0; i < 120; i += 1) {
			manager.register("task", `job ${i}`, async () => `done ${i}`, { id: `job-${i}` });
		}

		await Bun.sleep(25);
		expect(manager.getDeliveryState().queued).toBeLessThanOrEqual(100);
		expect(manager.getDeliveryState().deadLettered).toBeGreaterThan(0);

		for (let i = 0; i < 15 && manager.getDeliveryState().queued > 0; i += 1) {
			await Bun.sleep(550);
		}
		const state = manager.getDeliveryState();
		expect(state.queued).toBe(0);
		expect(state.deadLettered).toBe(50);
		expect(attempts).toBeLessThanOrEqual(120 * 3);
	});

	test("eviction removes dead-letter records for retained jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: () => new Promise<void>(() => {}),
			maxRunningJobs: 102,
			retentionMs: 0,
		});
		try {
			for (let i = 0; i < 102; i += 1) {
				manager.register("task", `evicted ${i}`, async () => "done", { id: `evicted-${i}` });
			}
			await manager.waitForAll();

			expect(manager.getDeliveryState().deadLettered).toBe(0);
		} finally {
			await manager.dispose({ timeoutMs: 50 });
		}
	});

	test("terminal eviction purges live terminal state while retaining durable resume metadata", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 0, maxRunningJobs: 2 });

		const terminalJobId = manager.register("task", "terminal", async () => "done", { id: "terminal-job" });
		manager.registerSubagentRecord(subagentRecord("terminal-sub", terminalJobId, "running"));
		manager.registerResumeDescriptor(resumeDescriptor("terminal-sub"));
		manager.registerLiveHandle("terminal-sub", {
			requestPause: () => {},
			injectMessage: async () => {},
		});
		manager.recordSubagentProgress("terminal-sub", { currentTool: "test" } as never);

		await manager.waitForAll();
		expect(manager.getSubagentRecord("terminal-sub")?.resumable).toBe(true);
		expect(manager.getResumeDescriptor("terminal-sub")).toEqual(resumeDescriptor("terminal-sub"));
		expect(manager.getLiveHandle("terminal-sub")).toBeUndefined();
		expect(manager.getSubagentProgress("terminal-sub")).toBeUndefined();

		const pausedJobId = manager.register("task", "paused", async () => ({ kind: "paused", note: "safe boundary" }), {
			id: "paused-job",
		});
		manager.registerSubagentRecord(subagentRecord("paused-sub", pausedJobId, "running"));
		manager.registerResumeDescriptor(resumeDescriptor("paused-sub"));
		manager.registerLiveHandle("paused-sub", {
			requestPause: () => {},
			injectMessage: async () => {},
		});
		manager.recordSubagentProgress("paused-sub", { currentTool: "test" } as never);

		await manager.waitForAll();
		expect(manager.getSubagentRecord("paused-sub")?.status).toBe("paused");
		expect(manager.getResumeDescriptor("paused-sub")).toEqual(resumeDescriptor("paused-sub"));
		expect(manager.getLiveHandle("paused-sub")).toBeUndefined();
		expect(manager.getSubagentProgress("paused-sub")).toBeUndefined();
	});
});
