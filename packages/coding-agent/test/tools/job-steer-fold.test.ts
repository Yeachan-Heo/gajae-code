import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import type { FoldAdapter } from "../../src/session/fold-coordinator";
import type { ToolSession } from "../../src/tools";
import { JobTool } from "../../src/tools/job";
import { STEER_FOLD_GRACE_MS } from "../../src/tools/steer-fold";
import { createSteerHarness, type SteerHarness, textOf } from "../helpers/steer-fold-harness";

describe("steer-triggered job await fold", () => {
	let harness: SteerHarness | undefined;

	beforeEach(() => {
		harness = createSteerHarness(process.cwd());
	});

	afterEach(async () => {
		await harness?.manager.dispose({ timeoutMs: 200 });
		harness = undefined;
		AsyncJobManager.resetForTests();
	});

	function registerHeldJob(label: string) {
		if (!harness) throw new Error("expected steer harness");
		const gate = Promise.withResolvers<string>();
		const id = harness.manager.register("bash", label, () => gate.promise);
		const job = harness.manager.getJob(id);
		if (!job) throw new Error(`expected job ${id}`);
		harness.manager.markStartedInBackground(id, job.generation);
		return { gate, id, job };
	}

	it("folds a post-grace await, keeps every watched job running, and records steer", async () => {
		if (!harness) throw new Error("expected steer harness");
		const first = registerHeldJob("first await");
		const second = registerHeldJob("second await");
		const tool = new JobTool(harness.session);
		const resultPromise = tool.execute("job-await-fold", { poll: [first.id, second.id] });

		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;

		expect(textOf(result)).toContain("Folded the job await");
		expect(textOf(result)).toContain(first.id);
		expect(textOf(result)).toContain(second.id);
		expect(textOf(result)).toContain("original deadlines");
		expect(textOf(result)).toContain("wake a later turn");
		expect(harness.folds).toEqual([
			{ jobId: first.id, generation: first.job.generation, reason: "steer" },
			{ jobId: second.id, generation: second.job.generation, reason: "steer" },
		]);
		expect(harness.manager.getJob(first.id)?.status).toBe("running");
		expect(harness.manager.getJob(second.id)?.status).toBe("running");
		expect(harness.manager.getJob(first.id)?.metadata).toMatchObject({ backgrounded: true, foldReason: "steer" });
		expect(harness.manager.getJob(second.id)?.metadata).toMatchObject({ backgrounded: true, foldReason: "steer" });

		first.gate.resolve("first result");
		second.gate.resolve("second result");
		await Promise.all([first.job.promise, second.job.promise]);
		const completed = await tool.execute("job-await-complete", { poll: [first.id, second.id] });
		expect(textOf(completed)).toContain("first result");
		expect(textOf(completed)).toContain("second result");
	}, 10_000);

	// Regression: before this guard the chord and the SDK `bash.background`
	// control resolved to the newest registration, which during a `job poll` was
	// the job-await adapter. That fold never settled the await (only the steer
	// callback did), told the model a steer arrived when none had, and left a
	// receipt slot behind so the completion was delivered twice.
	it("chord and SDK-control folds never target a job await", async () => {
		if (!harness) throw new Error("expected steer harness");
		const held = registerHeldJob("chord-immune await");
		const tool = new JobTool(harness.session);
		const resultPromise = tool.execute("job-await-chord", { poll: [held.id] });
		await Bun.sleep(50);

		expect(harness.session.hasForegroundBashBackgroundRequestHandler?.()).toBe(false);
		expect(await harness.session.requestForegroundBashBackground?.("chord")).toBe(false);
		expect(await harness.session.requestForegroundBashBackground?.("sdk_control")).toBe(false);
		expect(harness.folds).toHaveLength(0);
		expect(harness.coordinator.slotStateFor(held.job)).toBe("none");
		expect(harness.manager.getJob(held.id)?.metadata?.foldReason).toBeUndefined();

		held.gate.resolve("chord-immune result");
		const result = await resultPromise;
		expect(textOf(result)).toContain("chord-immune result");
		expect(textOf(result)).not.toContain("Folded the job await");
		// No receipt slot survives, so the completion is an ordinary delivery, not a second receipt-bearing wake.
		expect(harness.coordinator.onDelivery(held.job, "chord-immune result")).toEqual({ kind: "ordinary" });
	}, 10_000);

	it("reports the real fold reason when a watched wait is folded explicitly", async () => {
		if (!harness) throw new Error("expected steer harness");
		const held = registerHeldJob("explicit chord await");
		const registered: FoldAdapter[] = [];
		const coordinator = harness.coordinator;
		const session: ToolSession = {
			...harness.session,
			registerForegroundFoldParticipant: adapter => {
				registered.push(adapter);
				return coordinator.registerParticipant(adapter);
			},
		};
		const resultPromise = new JobTool(session).execute("job-await-explicit", { poll: [held.id] });
		await Bun.sleep(50);
		const adapter = registered.find(candidate => candidate.jobId === held.id);
		if (!adapter) throw new Error("expected the job await to be registered");

		expect(await harness.session.requestForegroundBashBackground?.("chord", adapter)).toBe(true);
		const result = await resultPromise;

		expect(textOf(result)).toContain("Folded the job await");
		expect(textOf(result)).toContain("because the user pressed the fold chord");
		expect(textOf(result)).not.toContain("user steer");
		expect(harness.folds).toEqual([{ jobId: held.id, generation: held.job.generation, reason: "chord" }]);
		expect(harness.manager.getJob(held.id)?.metadata).toMatchObject({ backgrounded: true, foldReason: "chord" });
		held.gate.resolve("explicit result");
		await held.job.promise;
	}, 10_000);

	// A job that a foreground fold already moved owns a receipt slot until it
	// completes, so the coordinator refuses a second fold for it. The await must
	// still be released so the steer is delivered, and the original receipt (not
	// a second one) must carry the completion.
	it("releases a steered await over a job that an earlier fold already moved", async () => {
		if (!harness) throw new Error("expected steer harness");
		const held = registerHeldJob("previously folded");
		const priorFold: FoldAdapter = {
			kind: "bash-managed",
			jobId: held.id,
			jobGeneration: held.job.generation,
			label: held.job.label,
			cwdSensitive: true,
			originatingTurn: false,
			outputRef: { jobId: held.id, generation: held.job.generation, instruction: "tail it" },
			getJob: () => harness?.manager.getJob(held.id),
			detachObserver: receipt => {
				harness?.manager.markBackgrounded(held.id, held.job.generation, receipt.reason);
				return "resolved";
			},
			resolveForegroundObserver: () => "already-settled",
		};
		expect((await harness.coordinator.requestFold(priorFold, "chord")).status).toBe("folded");
		expect(harness.coordinator.slotStateFor(held.job)).toBe("present");
		expect(harness.folds).toHaveLength(1);

		const resultPromise = new JobTool(harness.session).execute("job-await-refold", { poll: [held.id] });
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;

		expect(textOf(result)).toContain("Folded the job await");
		expect(textOf(result)).toContain("because a user steer arrived");
		expect(harness.manager.getJob(held.id)?.status).toBe("running");
		// The first fold's reason and receipt survive; no second fold event or slot was minted.
		expect(harness.manager.getJob(held.id)?.metadata?.foldReason).toBe("chord");
		expect(harness.folds).toHaveLength(1);
		expect(harness.coordinator.slotStateFor(held.job)).toBe("present");
		held.gate.resolve("refold result");
		await held.job.promise;
	}, 10_000);

	it("watches task-backed jobs without folding them", async () => {
		if (!harness) throw new Error("expected steer harness");
		const gate = Promise.withResolvers<string>();
		const taskId = harness.manager.register("task", "subagent task", () => gate.promise);
		const taskJob = harness.manager.getJob(taskId);
		if (!taskJob) throw new Error(`expected task job ${taskId}`);
		const resultPromise = new JobTool(harness.session).execute("job-await-task", { poll: [taskId] });
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		expect(harness.session.hasForegroundBashBackgroundRequestHandler?.()).toBe(false);
		harness.steer();
		await Bun.sleep(100);
		expect(harness.folds).toHaveLength(0);
		expect(harness.manager.getJob(taskId)?.metadata?.foldReason).toBeUndefined();
		expect(harness.coordinator.slotStateFor(taskJob)).toBe("none");
		gate.resolve("task result");
		const result = await resultPromise;
		expect(textOf(result)).toContain("task result");
		expect(textOf(result)).not.toContain("Folded the job await");
	}, 10_000);

	it("does not fold a steer inside the grace window", async () => {
		if (!harness) throw new Error("expected steer harness");
		const held = registerHeldJob("early await");
		const resultPromise = new JobTool(harness.session).execute("job-await-early", { poll: [held.id] });
		await Bun.sleep(100);
		harness.steer();
		held.gate.resolve("early result");
		const result = await resultPromise;

		expect(textOf(result)).not.toContain("Folded the job await");
		expect(harness.folds).toHaveLength(0);
		expect(harness.manager.getJob(held.id)?.metadata?.foldReason).toBeUndefined();
	}, 10_000);

	it("does not fold when busyPromptMode is not steer", async () => {
		if (harness) {
			await harness.manager.dispose({ timeoutMs: 200 });
			harness = createSteerHarness(process.cwd(), { busyPromptMode: "queue" });
		}
		if (!harness) throw new Error("expected steer harness");
		const held = registerHeldJob("queue-mode await");
		const resultPromise = new JobTool(harness.session).execute("job-await-queue", { poll: [held.id] });
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		await Bun.sleep(100);
		expect(harness.manager.getJob(held.id)?.status).toBe("running");
		expect(harness.folds).toHaveLength(0);
		held.gate.resolve("queue result");
		const result = await resultPromise;
		expect(textOf(result)).toContain("queue result");
	}, 10_000);

	it("does not fold without steer and fold hooks", async () => {
		if (!harness) throw new Error("expected steer harness");
		const held = registerHeldJob("hookless await");
		const session = {
			...harness.session,
			waitForUserSteering: undefined,
			requestForegroundBashBackground: undefined,
		};
		const resultPromise = new JobTool(session).execute("job-await-hookless", { poll: [held.id] });
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		held.gate.resolve("hookless result");
		const result = await resultPromise;
		expect(textOf(result)).toContain("hookless result");
		expect(harness.folds).toHaveLength(0);
	}, 10_000);
});
