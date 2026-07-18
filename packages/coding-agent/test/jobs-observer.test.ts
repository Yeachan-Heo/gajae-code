import { afterEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";
import { JobsObserver } from "../src/modes/jobs-observer";
import { CronTool, calculateCronFireTimeMs, resetCronRegistryForTests } from "../src/tools/cron";
import type { ToolSession } from "../src/tools/index";

const OWNER = "0-Main";

function makeManager(): AsyncJobManager {
	return new AsyncJobManager({ onJobComplete: async () => {} });
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** A run that stays "running" until the job is cancelled (abort-aware, so dispose settles it). */
function abortable(signal: AbortSignal): Promise<string> {
	return new Promise<string>(resolve => {
		if (signal.aborted) return resolve("aborted");
		signal.addEventListener("abort", () => resolve("aborted"), { once: true });
	});
}

function registerMonitor(manager: AsyncJobManager, label: string, ownerId = OWNER): string {
	return manager.register("bash", label, async ({ signal }) => abortable(signal), {
		ownerId,
		metadata: { monitor: true },
	});
}

function createCronSession(ownerId = OWNER, delivery?: () => Promise<void>): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionId: () => "test-session",
		getAgentId: () => ownerId,
		steer: () => {},
		sendCustomMessage: async () => delivery?.(),
		allocateOutputArtifact: async () => ({}),
	} as unknown as ToolSession;
}

afterEach(() => {
	resetCronRegistryForTests();
	AsyncJobManager.setInstance(undefined);
	vi.useRealTimers();
});

describe("JobsObserver", () => {
	test("AC6 counts active monitor jobs only; ignores plain bash + task jobs", async () => {
		const manager = makeManager();
		const observer = new JobsObserver(manager, OWNER);

		registerMonitor(manager, "tail log");
		manager.register("bash", "plain", async ({ signal }) => abortable(signal), { ownerId: OWNER });
		manager.register("task", "agent", async ({ signal }) => abortable(signal), { ownerId: OWNER });

		const snapshot = observer.getSnapshot();
		expect(snapshot.activeMonitorCount).toBe(1);
		expect(snapshot.monitors.map(m => m.label)).toEqual(["tail log"]);
		expect(snapshot.worstState).toBe("running");

		observer.dispose();
		await manager.dispose();
	});

	test("AC2/AC3 failure latches red until acknowledged; completed/failed not counted active", async () => {
		const manager = makeManager();
		const observer = new JobsObserver(manager, OWNER);

		manager.register(
			"bash",
			"bad monitor",
			async () => {
				throw new Error("boom");
			},
			{ ownerId: OWNER, metadata: { monitor: true } },
		);
		await flush();

		let snapshot = observer.getSnapshot();
		expect(snapshot.activeMonitorCount).toBe(0);
		expect(snapshot.worstState).toBe("failed");
		expect(snapshot.failedUnacknowledged).toBe(true);

		observer.acknowledgeFailures();
		snapshot = observer.getSnapshot();
		expect(snapshot.failedUnacknowledged).toBe(false);
		expect(snapshot.worstState).toBe("none");

		observer.dispose();
		await manager.dispose();
	});

	test("failure already present at construction is latched immediately", async () => {
		const manager = makeManager();
		manager.register(
			"bash",
			"bad monitor",
			async () => {
				throw new Error("boom");
			},
			{ ownerId: OWNER, metadata: { monitor: true } },
		);
		await flush();

		// Observer constructed AFTER the monitor already failed.
		const observer = new JobsObserver(manager, OWNER);
		const snapshot = observer.getSnapshot();
		expect(snapshot.worstState).toBe("failed");
		expect(snapshot.failedUnacknowledged).toBe(true);

		observer.dispose();
		await manager.dispose();
	});

	test("AC5/AC13 onChange fires (debounced) when a monitor registers", async () => {
		const manager = makeManager();
		const observer = new JobsObserver(manager, OWNER);
		let fires = 0;
		observer.onChange(() => {
			fires += 1;
		});

		registerMonitor(manager, "m1");
		registerMonitor(manager, "m2");
		await flush();

		expect(fires).toBeGreaterThanOrEqual(1);
		observer.dispose();
		await manager.dispose();
	});

	test("dispose unsubscribes: no notifications after dispose", async () => {
		const manager = makeManager();
		const observer = new JobsObserver(manager, OWNER);
		let fires = 0;
		observer.onChange(() => {
			fires += 1;
		});
		observer.dispose();

		registerMonitor(manager, "after dispose");
		await flush();
		expect(fires).toBe(0);

		await manager.dispose();
	});

	test("AC6 cron jobs counted via the cron change hook + listing accessor", async () => {
		const manager = makeManager();
		AsyncJobManager.setInstance(manager);
		const observer = new JobsObserver(manager, OWNER);
		let fires = 0;
		observer.onChange(() => {
			fires += 1;
		});

		const tool = new CronTool(createCronSession());
		await tool.execute("call-1", {
			op: "create",
			cron_expression: "*/5 * * * *",
			prompt: "/review-pr 1",
			recurring: true,
		});
		await flush();

		const snapshot = observer.getSnapshot();
		expect(snapshot.activeCronCount).toBe(1);
		expect(snapshot.crons[0]?.recurring).toBe(true);
		expect(snapshot.worstState).toBe("running");
		expect(fires).toBeGreaterThanOrEqual(1);

		observer.dispose();
		await manager.dispose();
	});

	test("cron firing state remains visible to observers until delivery settles", async () => {
		const now = new Date("2026-06-02T12:00:10");
		vi.useFakeTimers({ now });
		const manager = makeManager();
		AsyncJobManager.setInstance(manager);
		const observer = new JobsObserver(manager, OWNER);
		const delivery = Promise.withResolvers<void>();
		const tool = new CronTool(createCronSession(OWNER, () => delivery.promise));
		const result = await tool.execute("call", {
			op: "create",
			cron_expression: "1 12 * * *",
			prompt: "pending delivery",
			recurring: true,
		});
		if (!result.details?.id) throw new Error("Expected cron id");
		const fireAt = calculateCronFireTimeMs({
			id: result.details.id,
			cronExpression: "1 12 * * *",
			baseMatchMs: new Date("2026-06-02T12:01:00").getTime(),
			recurring: true,
			nowMs: now.getTime(),
		});
		vi.advanceTimersByTime(fireAt - now.getTime());
		await Promise.resolve();
		expect(observer.getSnapshot().crons[0]?.firing).toBe(true);
		delivery.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(observer.getSnapshot().crons[0]?.firing).toBe(false);
		observer.dispose();
		await manager.dispose();
	});

	test("deleteCron only removes jobs owned by the observer", async () => {
		const manager = makeManager();
		AsyncJobManager.setInstance(manager);
		const observer = new JobsObserver(manager, OWNER);
		const ownTool = new CronTool(createCronSession(OWNER));
		const otherTool = new CronTool(createCronSession("0-Other"));

		const own = await ownTool.execute("own", {
			op: "create",
			cron_expression: "*/5 * * * *",
			prompt: "own",
			recurring: true,
		});
		const other = await otherTool.execute("other", {
			op: "create",
			cron_expression: "*/5 * * * *",
			prompt: "other",
			recurring: true,
		});
		if (!own.details || !other.details) throw new Error("Expected cron create details");
		await flush();

		expect(observer.getSnapshot().crons.map(cron => cron.id)).toEqual([own.details.id!]);
		expect(observer.deleteCron(other.details.id!)).toBe(false);
		expect(observer.getSnapshot().crons.map(cron => cron.id)).toEqual([own.details.id!]);
		expect(observer.deleteCron(own.details.id!)).toBe(true);
		await flush();
		expect(observer.getSnapshot().crons).toHaveLength(0);

		const otherObserver = new JobsObserver(manager, "0-Other");
		expect(otherObserver.getSnapshot().crons.map(cron => cron.id)).toEqual([other.details.id!]);
		otherObserver.dispose();
		observer.dispose();
		await manager.dispose();
	});
});
