import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { Settings } from "../src/config/settings";
import type { CustomMessage } from "../src/session/messages";
import type { ToolSession } from "../src/tools/index";
import { MonitorTool } from "../src/tools/monitor";

type QueuedMessage = {
	customType: string;
	content: string;
	details?: unknown;
	triggerTurn?: boolean;
};

function detailsOf(entry: QueuedMessage): { taskId?: string; coalescedCount?: number } {
	return (entry.details ?? {}) as { taskId?: string; coalescedCount?: number };
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
		steer: (msg: { customType: string; content: string; details?: unknown }) =>
			queue.push({ ...msg, triggerTurn: true } as QueuedMessage),
		sendCustomMessage: async (
			msg: { customType: string; content: string; details?: unknown },
			options?: { triggerTurn?: boolean },
		) => {
			queue.push({
				customType: msg.customType,
				content: msg.content,
				details: msg.details,
				triggerTurn: options?.triggerTurn,
			});
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

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

describe("persistent monitor notify policy", () => {
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

	it("coalesces identical lines across separate ticks within the debounce window (default on_change)", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		// Ten identical lines on separate ticks, then hold open so intermediate debounce can fire
		// before terminal flush.
		const result = await new MonitorTool(session).execute("call", {
			command:
				"for i in $(seq 1 10); do printf 'GET /api/jobs/abc 200\\n'; sleep 0.02; done; sleep 3",
			kind: "log",
			description: "debounce coalesce",
			persistent: true,
		});
		const taskId = result.details!.taskId;

		// Intermediate debounce is 2000ms; allow margin for scheduling.
		await waitFor(
			() => queue.some(entry => detailsOf(entry).taskId === taskId),
			3_500,
			"intermediate debounce notification",
		);
		const intermediate = queue.filter(entry => detailsOf(entry).taskId === taskId);
		expect(intermediate.length).toBe(1);
		expect(intermediate[0]?.content).toContain("GET /api/jobs/abc 200");
		expect(intermediate[0]?.triggerTurn).toBe(false);
		expect((detailsOf(intermediate[0]!).coalescedCount ?? 0) > 0).toBe(true);

		await manager.waitForAll();
		const all = queue.filter(entry => detailsOf(entry).taskId === taskId);
		// Intermediate + terminal (same content still wakes on exit)
		expect(all.length).toBeLessThanOrEqual(2);
		const terminal = all.at(-1);
		expect(terminal?.triggerTurn).toBe(true);
		expect(terminal?.content).toContain("GET /api/jobs/abc 200");
	});

	it("default persistent intermediate notifications do not set triggerTurn true", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		const result = await new MonitorTool(session).execute("call", {
			command: "printf 'healthy\\n'; sleep 2.5; printf 'still-healthy\\n'; sleep 0.1",
			kind: "poll",
			description: "no intermediate turn",
			persistent: true,
		});
		const taskId = result.details!.taskId;

		await waitFor(
			() => queue.some(entry => detailsOf(entry).taskId === taskId && entry.triggerTurn === false),
			3_500,
			"display-only intermediate",
		);
		const intermediate = queue.filter(
			entry => detailsOf(entry).taskId === taskId && entry.triggerTurn === false,
		);
		expect(intermediate.length).toBeGreaterThanOrEqual(1);
		for (const entry of intermediate) {
			expect(entry.triggerTurn).toBe(false);
		}

		await manager.waitForAll();
		const terminal = queue.filter(entry => detailsOf(entry).taskId === taskId).at(-1);
		expect(terminal?.triggerTurn).toBe(true);
	});

	it("every_line mode preserves triggerTurn true on flushes", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		const result = await new MonitorTool(session).execute("call", {
			command: "printf 'a\\nb\\nc\\n'",
			kind: "log",
			description: "every line legacy",
			persistent: true,
			notify: "every_line",
		});
		const taskId = result.details!.taskId;
		await manager.waitForAll();
		// Microtask flushes may still coalesce same-tick bursts; terminal also flushes.
		const entries = queue.filter(entry => detailsOf(entry).taskId === taskId);
		expect(entries.length).toBeGreaterThanOrEqual(1);
		expect(entries.every(entry => entry.triggerTurn === true)).toBe(true);
	});

	it("on_change skips intermediate enqueue when content is unchanged after a prior delivery", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		// Deliver "same" once via debounce, then emit more identical lines in a later window;
		// the second intermediate flush should be suppressed; terminal still wakes.
		const result = await new MonitorTool(session).execute("call", {
			command:
				"printf 'same\\n'; sleep 2.2; for i in $(seq 1 5); do printf 'same\\n'; sleep 0.02; done; sleep 2.2",
			kind: "poll",
			description: "on_change skip duplicate",
			persistent: true,
			notify: "on_change",
		});
		const taskId = result.details!.taskId;

		await waitFor(
			() => queue.filter(entry => detailsOf(entry).taskId === taskId).length >= 1,
			3_500,
			"first intermediate",
		);
		const afterFirst = queue.filter(entry => detailsOf(entry).taskId === taskId).length;

		// Wait past the second debounce window while process is still alive.
		await Bun.sleep(2_500);
		const afterSecondWindow = queue.filter(entry => detailsOf(entry).taskId === taskId).length;
		// No additional intermediate for identical content.
		expect(afterSecondWindow).toBe(afterFirst);

		await manager.waitForAll();
		const all = queue.filter(entry => detailsOf(entry).taskId === taskId);
		// Terminal still delivers with triggerTurn true even for unchanged content.
		expect(all.at(-1)?.triggerTurn).toBe(true);
		expect(all.length).toBeLessThanOrEqual(afterFirst + 1);
	});

	it("terminal flush cancels pending debounce and wakes promptly without waiting full window", async () => {
		const queue: QueuedMessage[] = [];
		const session = makeSession("0-Owner", queue, settings);
		const started = Date.now();
		const result = await new MonitorTool(session).execute("call", {
			command: "printf 'final-state\\n'",
			kind: "log",
			description: "terminal prompt flush",
			persistent: true,
		});
		const taskId = result.details!.taskId;
		await manager.waitForAll();
		const elapsed = Date.now() - started;
		const entries = queue.filter(entry => detailsOf(entry).taskId === taskId);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.content).toContain("final-state");
		expect(entries[0]?.triggerTurn).toBe(true);
		// Must not wait the full 2s debounce solely to deliver on exit.
		expect(elapsed).toBeLessThan(1_500);
	});
});
