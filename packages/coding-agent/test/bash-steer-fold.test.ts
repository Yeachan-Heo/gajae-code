/**
 * Steer-triggered bash fold — managed non-PTY surface.
 *
 * A user steer that ARRIVES after a foreground bash call has run for
 * STEER_FOLD_GRACE_MS folds it into a background job, mirroring the way a
 * queued steer ends a subagent await. The five parity points:
 *  1. steer after the grace window -> fold with a `steer` reason line, the job
 *     keeps running and its completion is delivered later;
 *  2. steer inside the grace window (or already queued at start) -> no fold,
 *     the command finishes normally and that steer is left for the boundary;
 *  3. the fold does not arm the turn-ending fence/stop, so the SAME run
 *     consumes the steer (the loop's batch-skip is covered by agent-loop tests);
 *  4. abort still aborts (a steer never kills the command);
 *  5. busyPromptMode=queue / toolInterruptPolicy=finish_tools -> no fold.
 * Plus the manager-level contract every fold path relies on: `foldReason` on
 * the job/snapshot and exactly one `onFold` notification per fold.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager, type JobFoldEvent } from "@gajae-code/coding-agent/async";
import { BashTool, STEER_FOLD_GRACE_MS, steerFoldReasonLine } from "@gajae-code/coding-agent/tools/bash";
import { Snowflake } from "@gajae-code/utils";
import {
	createSteerHarness,
	ptyTurnContext,
	type SteerHarness,
	textOf,
	turnContext,
} from "./helpers/steer-fold-harness";

describe("steer-triggered bash fold", () => {
	let cwd = "";
	let harness: SteerHarness | undefined;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `bash-steer-fold-${Snowflake.next()}`);
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		await harness?.manager.dispose();
		harness = undefined;
		AsyncJobManager.resetForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	}, 10_000);

	it("exports the fixed grace window", () => {
		expect(STEER_FOLD_GRACE_MS).toBe(2_000);
	}, 10_000);

	it("parity 1: a steer arriving after the grace window folds the managed wait with a steer reason line and keeps the job running", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const startedAt = Date.now();
		const resultPromise = tool.execute(
			"steer-fold-1",
			{ command: "printf 'start\\n'; sleep 5; printf 'done\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;
		expect(Date.now() - startedAt).toBeLessThan(4_500);

		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected a background job id");
		expect(result.details?.async?.state).toBe("running");
		expect(result.details?.foldReason).toBe("steer");
		const text = textOf(result);
		expect(text).toContain(`Background job ${jobId} started`);
		expect(text).toContain(steerFoldReasonLine(jobId));
		expect(text).toContain("start");

		const job = harness.manager.getJob(jobId);
		expect(job?.status).toBe("running");
		expect(job?.metadata?.backgrounded).toBe(true);
		expect(job?.metadata?.foldReason).toBe("steer");
		const snapshot = harness.manager.getJobsSnapshot().jobs.find(entry => entry.id === jobId);
		expect(snapshot?.backgrounded).toBe(true);
		expect(snapshot?.foldReason).toBe("steer");
		expect(harness.folds).toEqual([{ jobId, generation: job!.generation, reason: "steer" }]);

		// Parity 3: the same run must consume the steer. A steer fold neither
		// fences steering admission nor arms the cooperative stop, and the steer
		// itself is still queued for the loop's tool boundary.
		expect(harness.fenceArmed()).toBe(false);
		expect(harness.stopRequested()).toBe(false);
		expect(harness.hasQueuedSteering()).toBe(true);

		await job?.promise;
		expect(harness.manager.getJob(jobId)?.status).toBe("completed");
	}, 15_000);

	it("parity 2: a steer arriving inside the grace window never folds; the command finishes normally", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const startedAt = Date.now();
		const resultPromise = tool.execute("steer-early", { command: "sleep 2.6; printf 'done\\n'", timeout: 30 });
		await Bun.sleep(200);
		harness.steer();
		const result = await resultPromise;
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_500);
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.foldReason).toBeUndefined();
		expect(textOf(result)).toContain("done");
		expect(harness.folds).toHaveLength(0);
		expect(harness.hasQueuedSteering()).toBe(true);
	}, 10_000);

	it("parity 2: a steer already queued when the command starts never folds it", async () => {
		harness = createSteerHarness(cwd);
		harness.steer();
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute("steer-prequeued", { command: "sleep 2.6; printf 'done\\n'", timeout: 30 });
		const result = await resultPromise;
		expect(result.details?.async).toBeUndefined();
		expect(harness.folds).toHaveLength(0);
	}, 10_000);

	it("parity 2: an early steer does not blind the watcher to a later qualifying steer", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute(
			"steer-early-then-late",
			{ command: "sleep 4; printf 'done\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		await Bun.sleep(200);
		harness.steer("early");
		await Bun.sleep(STEER_FOLD_GRACE_MS);
		harness.steer("late");
		const result = await resultPromise;
		expect(result.details?.foldReason).toBe("steer");
		expect(harness.folds.map(fold => fold.reason)).toEqual(["steer"]);
		await harness.manager.getJob(result.details!.async!.jobId)?.promise;
	}, 15_000);

	it("parity 2: a command that finishes inside the grace window is never folded", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute("steer-no-fold-short", { command: "printf 'quick\\n'", timeout: 30 });
		harness.steer();
		const result = await resultPromise;
		expect(result.details?.async).toBeUndefined();
		expect(textOf(result)).toContain("quick");
		expect(harness.folds).toHaveLength(0);
	}, 10_000);

	it("parity 4: an abort still kills the command and never becomes a fold", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const abort = new AbortController();
		const resultPromise = tool.execute("steer-abort", { command: "sleep 30", timeout: 60 }, abort.signal);
		await Bun.sleep(100);
		harness.steer();
		abort.abort();
		await expect(resultPromise).rejects.toThrow();
		expect(harness.folds).toHaveLength(0);
		expect(harness.manager.getRunningJobs()).toHaveLength(0);
	}, 10_000);

	it("parity 5: busyPromptMode=queue never folds on steer", async () => {
		harness = createSteerHarness(cwd, { busyPromptMode: "queue" });
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute("steer-gate-queue", { command: "sleep 2.4; printf 'done\\n'", timeout: 30 });
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;
		expect(result.details?.async).toBeUndefined();
		expect(textOf(result)).toContain("done");
		expect(harness.folds).toHaveLength(0);
	}, 10_000);

	it("parity 5: toolInterruptPolicy=finish_tools never folds on steer", async () => {
		harness = createSteerHarness(cwd, { toolInterruptPolicy: "finish_tools" });
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute("steer-gate-wait", { command: "sleep 2.4; printf 'done\\n'", timeout: 30 });
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;
		expect(result.details?.async).toBeUndefined();
		expect(harness.folds).toHaveLength(0);
	}, 10_000);

	it("parity 5: a session that cannot prove its interrupt mode is not steer-foldable (fail closed)", async () => {
		harness = createSteerHarness(cwd, { omitToolInterruptPolicy: true });
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute("steer-gate-unknown", { command: "sleep 2.4; printf 'done\\n'", timeout: 30 });
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;
		expect(result.details?.async).toBeUndefined();
		expect(harness.folds).toHaveLength(0);
	}, 10_000);

	it("parity 5: a session without a steering-arrival waiter is not steer-foldable (fail closed)", async () => {
		harness = createSteerHarness(cwd, { omitSteeringWait: true });
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute("steer-gate-no-seq", { command: "sleep 2.4; printf 'done\\n'", timeout: 30 });
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;
		expect(result.details?.async).toBeUndefined();
		expect(harness.folds).toHaveLength(0);
	}, 10_000);

	it("a chord fold inside a turn ends the turn and records a chord reason without the steer line", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute(
			"chord-fold",
			{ command: "sleep 2; printf 'done\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		await Bun.sleep(100);
		expect(await harness.session.requestForegroundBashBackground?.()).toBe(true);
		const result = await resultPromise;
		const jobId = result.details!.async!.jobId;
		expect(result.details?.foldReason).toBe("chord");
		expect(textOf(result)).not.toContain(steerFoldReasonLine(jobId));
		expect(harness.manager.getJob(jobId)?.metadata?.foldReason).toBe("chord");
		expect(harness.folds.map(fold => fold.reason)).toEqual(["chord"]);
		expect(harness.fenceArmed()).toBe(true);
		expect(harness.stopRequested()).toBe(true);
		await harness.manager.getJob(jobId)?.promise;
	}, 10_000);

	it("an explicit SDK control fold records sdk_control and nothing is foldable afterwards", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute("sdk-fold", { command: "sleep 2; printf 'done\\n'", timeout: 30 });
		await Bun.sleep(100);
		expect(await harness.session.requestForegroundBashBackground?.("sdk_control")).toBe(true);
		const result = await resultPromise;
		const jobId = result.details!.async!.jobId;
		expect(harness.manager.getJob(jobId)?.metadata?.foldReason).toBe("sdk_control");
		expect(harness.session.hasForegroundBashBackgroundRequestHandler?.()).toBe(false);
		expect(await harness.session.requestForegroundBashBackground?.("sdk_control")).toBe(false);
		await harness.manager.getJob(jobId)?.promise;
	}, 10_000);

	it("PTY surface: a post-grace steer folds the PTY wait with the reason line, foldReason=steer, and output-only continuation", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const marker = path.join(cwd, "pty-after-fold.txt");
		const resultPromise = tool.execute(
			"pty-steer-fold",
			{ command: `printf 'PTY-BEFORE\\n'; sleep 4; printf 'PTY-AFTER\\n' > ${marker}`, pty: true, timeout: 30 },
			undefined,
			undefined,
			ptyTurnContext(),
		);
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;

		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected a steer-folded PTY job id");
		expect(result.details?.foldReason).toBe("steer");
		expect(textOf(result)).toContain(steerFoldReasonLine(jobId));
		expect(harness.manager.getJob(jobId)?.metadata).toMatchObject({ backgrounded: true, foldReason: "steer" });
		expect(harness.folds.map(fold => fold.reason)).toEqual(["steer"]);

		// Output-only continuation: the process was never killed by the fold, so
		// its post-fold side effect still lands and the job completes on its own.
		await harness.manager.getJob(jobId)?.promise;
		expect(harness.manager.getJob(jobId)?.status).toBe("completed");
		expect(fs.existsSync(marker)).toBe(true);
	}, 15_000);
});

describe("AsyncJobManager fold bookkeeping", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
	});

	it("records the first reason, notifies once, and ignores repeats", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register("bash", "probe", async () => {
			await release.promise;
			return "done";
		});
		const job = manager.getJob(jobId)!;
		const folds: JobFoldEvent[] = [];
		manager.onFold(event => folds.push(event));

		expect(manager.markBackgrounded(jobId, job.generation, "steer")).toBe(true);
		expect(manager.markBackgrounded(jobId, job.generation, "chord")).toBe(true);
		expect(job.metadata?.foldReason).toBe("steer");
		expect(folds).toEqual([{ jobId, generation: job.generation, reason: "steer" }]);
		expect(manager.markBackgrounded(jobId, "wrong-generation", "timer")).toBe(false);

		release.resolve();
		await job.promise;
		await manager.dispose();
	}, 10_000);

	it("an async-started job is backgrounded without a fold reason or fold event", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const folds: JobFoldEvent[] = [];
		manager.onFold(event => folds.push(event));
		const jobId = manager.register("bash", "async", async () => "done");
		const job = manager.getJob(jobId)!;
		expect(manager.markStartedInBackground(jobId, job.generation)).toBe(true);
		expect(job.metadata?.backgrounded).toBe(true);
		expect(job.metadata?.foldReason).toBeUndefined();
		expect(folds).toHaveLength(0);
		await job.promise;
		await manager.dispose();
	});
});
