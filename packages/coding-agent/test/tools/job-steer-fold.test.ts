import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async";
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
