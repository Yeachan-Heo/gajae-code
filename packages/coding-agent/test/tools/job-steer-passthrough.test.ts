import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import type { FoldAdapter } from "../../src/session/fold-coordinator";
import type { ToolSession } from "../../src/tools";
import { JobTool } from "../../src/tools/job";
import { createSteerHarness, type SteerHarness, textOf } from "../helpers/steer-fold-harness";

const INTERRUPTED = "Job await interrupted by a new user message";

describe("job await steer passthrough", () => {
	let harness: SteerHarness;
	const extraManagers: AsyncJobManager[] = [];

	beforeEach(() => {
		harness = createSteerHarness(process.cwd());
	});

	afterEach(async () => {
		await harness.manager.dispose({ timeoutMs: 200 });
		for (const manager of extraManagers.splice(0)) await manager.dispose({ timeoutMs: 200 });
		AsyncJobManager.resetForTests();
	});

	function registerHeldJob(label: string, manager: AsyncJobManager = harness.manager, type: "bash" | "task" = "bash") {
		const gate = Promise.withResolvers<string>();
		const id = manager.register(type, label, () => gate.promise);
		const job = manager.getJob(id);
		if (!job) throw new Error(`expected job ${id}`);
		manager.markStartedInBackground(id, job.generation);
		return { gate, id, job };
	}

	// The await must not hold the steer for a grace window: a message typed right
	// after the poll starts is handled at once, exactly like `subagent await`.
	it("ends the await immediately on a steer, with no grace window, and folds nothing", async () => {
		const first = registerHeldJob("first await");
		const second = registerHeldJob("second await");
		const registered: FoldAdapter[] = [];
		const session: ToolSession = {
			...harness.session,
			registerForegroundFoldParticipant: adapter => {
				registered.push(adapter);
				return harness.coordinator.registerParticipant(adapter);
			},
		};
		const startedAt = Date.now();
		const resultPromise = new JobTool(session).execute("job-await-steer", { poll: [first.id, second.id] });
		await Bun.sleep(20);
		harness.steer();
		const result = await resultPromise;

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		const text = textOf(result);
		expect(text).toContain(INTERRUPTED);
		expect(text).toContain(`\`${first.id}\`, \`${second.id}\` keep running`);
		expect(text).toContain("## Still Running (2)");
		expect(result.details?.jobs.map(job => job.status)).toEqual(["running", "running"]);
		// Nothing was folded: no participant, no fold event, no receipt slot, no fold reason.
		expect(registered).toHaveLength(0);
		expect(harness.folds).toHaveLength(0);
		expect(harness.coordinator.slotStateFor(first.job)).toBe("none");
		expect(harness.manager.getJob(first.id)?.metadata?.foldReason).toBeUndefined();

		first.gate.resolve("first result");
		second.gate.resolve("second result");
		await Promise.all([first.job.promise, second.job.promise]);
		const completed = await new JobTool(session).execute("job-await-complete", { poll: [first.id, second.id] });
		expect(textOf(completed)).toContain("first result");
		expect(textOf(completed)).toContain("second result");
		expect(textOf(completed)).not.toContain(INTERRUPTED);
	}, 10_000);

	it("still delivers the completion automatically after an interrupted await", async () => {
		const delivered: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});
		extraManagers.push(manager);
		const session: ToolSession = { ...harness.session, getAsyncJobManager: () => manager };
		const held = registerHeldJob("delivered later", manager);
		const resultPromise = new JobTool(session).execute("job-await-deliver", { poll: [held.id] });
		await Bun.sleep(20);
		harness.steer();
		expect(textOf(await resultPromise)).toContain(`\`${held.id}\` keeps running and its result will be delivered`);
		expect(delivered).toHaveLength(0);

		held.gate.resolve("late result");
		await held.job.promise;
		expect(await manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.jobId).toBe(held.id);
		expect(delivered[0]?.text).toContain("late result");
	}, 10_000);

	// `subagent await` parity has no `busyPromptMode` gate and no fold-hook
	// requirement: any steer admitted into the live run ends the wait.
	it("passes through regardless of busyPromptMode and without fold hooks", async () => {
		harness.setBusyPromptMode("queue");
		const held = registerHeldJob("queue-mode await");
		const session: ToolSession = {
			...harness.session,
			registerForegroundFoldParticipant: undefined,
			requestForegroundBashBackground: undefined,
		};
		const resultPromise = new JobTool(session).execute("job-await-queue", { poll: [held.id] });
		await Bun.sleep(20);
		harness.steer();
		const result = await resultPromise;

		expect(textOf(result)).toContain(INTERRUPTED);
		expect(harness.manager.getJob(held.id)?.status).toBe("running");
		held.gate.resolve("queue result");
		await held.job.promise;
	}, 10_000);

	// In queue mode, a follow-up message queued during the job await should
	// interrupt the wait just like a steer does in steer mode.
	it("interrupts on queued follow-up messages in queue mode", async () => {
		harness.setBusyPromptMode("queue");
		const held = registerHeldJob("queue-mode follow-up");
		const resultPromise = new JobTool(harness.session).execute("job-await-queue-followup", { poll: [held.id] });
		await Bun.sleep(20);
		harness.queueFollowUp("queued message");
		const result = await resultPromise;

		expect(textOf(result)).toContain(INTERRUPTED);
		expect(harness.manager.getJob(held.id)?.status).toBe("running");
		held.gate.resolve("follow-up result");
		await held.job.promise;
	}, 10_000);

	it("passes through an await over a task-backed job without cancelling it", async () => {
		const held = registerHeldJob("subagent task", harness.manager, "task");
		const resultPromise = new JobTool(harness.session).execute("job-await-task", { poll: [held.id] });
		await Bun.sleep(20);
		harness.steer();
		const result = await resultPromise;

		expect(textOf(result)).toContain(INTERRUPTED);
		expect(harness.manager.getJob(held.id)?.status).toBe("running");
		expect(harness.folds).toHaveLength(0);
		held.gate.resolve("task result");
		await held.job.promise;
	}, 10_000);

	// A steer queued before the poll started belongs to the ordinary tool
	// boundary; only a NEW arrival may cut the observation window short.
	it("ignores a steer admitted before the await started", async () => {
		const held = registerHeldJob("pre-steered await");
		harness.steer();
		const resultPromise = new JobTool(harness.session).execute("job-await-prequeued", { poll: [held.id] });
		await Bun.sleep(100);
		held.gate.resolve("pre-steered result");
		const result = await resultPromise;

		expect(textOf(result)).toContain("pre-steered result");
		expect(textOf(result)).not.toContain(INTERRUPTED);
	}, 10_000);

	it("reports a job that finished as the steer arrived as completed, not interrupted", async () => {
		const held = registerHeldJob("racing await");
		const resultPromise = new JobTool(harness.session).execute("job-await-race", { poll: [held.id] });
		await Bun.sleep(20);
		held.gate.resolve("racing result");
		await held.job.promise;
		harness.steer();
		const result = await resultPromise;

		expect(textOf(result)).toContain("racing result");
		expect(textOf(result)).not.toContain(INTERRUPTED);
	}, 10_000);

	it("waits for completion when the session cannot report steering", async () => {
		const held = registerHeldJob("hookless await");
		const session: ToolSession = { ...harness.session, waitForUserSteering: undefined };
		const resultPromise = new JobTool(session).execute("job-await-hookless", { poll: [held.id] });
		await Bun.sleep(20);
		harness.steer();
		await Bun.sleep(50);
		held.gate.resolve("hookless result");
		const result = await resultPromise;

		expect(textOf(result)).toContain("hookless result");
		expect(textOf(result)).not.toContain(INTERRUPTED);
	}, 10_000);
});
