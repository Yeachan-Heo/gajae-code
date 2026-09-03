/**
 * Adversarial regression coverage for steer-triggered Bash folds.
 *
 * Each probe starts from the spec's acceptance criteria and tries to break the
 * contract at a race, an ordering edge, or a gate flip. The harness isolates
 * enqueue-time arrival ordering; a live AgentSession test covers admission.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@gajae-code/coding-agent/async";
import {
	resolveActivityIndicatorMessage,
	tallyBackgroundActivity,
} from "@gajae-code/coding-agent/modes/interactive-mode";
import type { AsyncJobSnapshotItem } from "@gajae-code/coding-agent/session/agent-session";
import { BashTool, STEER_FOLD_GRACE_MS, steerFoldReasonLine } from "@gajae-code/coding-agent/tools/bash";
import { Snowflake } from "@gajae-code/utils";
import { createSteerHarness, type SteerHarness, textOf, turnContext } from "./helpers/steer-fold-harness";

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

describe("steer-fold red team", () => {
	let cwd = "";
	let harness: SteerHarness | undefined;

	beforeEach(() => {
		cwd = path.join(os.tmpdir(), `bash-steer-fold-redteam-${Snowflake.next()}`);
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		await harness?.manager.dispose();
		harness = undefined;
		AsyncJobManager.resetForTests();
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("steer-after-completion-race: a steer queued in final progress after completion wins cannot fold or emit bash_folded", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		let steeredFromFinalProgress = false;
		// The command finishes inside the grace window, so a steer queued at the
		// completion boundary can never be a qualifying (post-grace) arrival.
		const result = await tool.execute("completion-race", { command: "sleep 0.5", timeout: 30 }, undefined, () => {
			if (!steeredFromFinalProgress) {
				steeredFromFinalProgress = true;
				harness?.steer();
			}
		});
		expect(steeredFromFinalProgress).toBe(true);
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.foldReason).toBeUndefined();
		expect(harness.folds).toEqual([]);
	}, 10_000);

	it("double-steer: two post-grace steers produce exactly one fold notification with reason steer", async () => {
		harness = createSteerHarness(cwd);
		const tool = new BashTool(harness.session);
		const resultPromise = tool.execute(
			"double-steer",
			{ command: "sleep 5; printf 'double steer completed\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		harness.steer();
		const result = await resultPromise;
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected a folded job after duplicate steering");
		const job = harness.manager.getJob(jobId);
		if (!job) throw new Error("expected duplicate-steer job to remain registered");
		expect(result.details?.foldReason).toBe("steer");
		expect(harness.folds).toEqual([{ jobId, generation: job.generation, reason: "steer" }]);
		await job.promise;
	}, 10_000);

	it("two foreground bash calls in one turn fold once each and keep distinct output ownership", async () => {
		harness = createSteerHarness(cwd);
		const first = new BashTool(harness.session).execute(
			"parallel-fold-a",
			{ command: "sleep 3; printf 'parallel-a-complete\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		const second = new BashTool(harness.session).execute(
			"parallel-fold-b",
			{ command: "sleep 3; printf 'parallel-b-complete\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const results = await Promise.all([first, second]);
		const jobIds = results.map(result => result.details?.async?.jobId);
		expect(jobIds.every(Boolean)).toBe(true);
		expect(new Set(jobIds).size).toBe(2);
		expect(harness.folds).toHaveLength(2);
		expect(new Set(harness.folds.map(fold => fold.jobId))).toEqual(new Set(jobIds as string[]));

		await Promise.all(jobIds.map(id => harness?.manager.getJob(id!)?.promise));
		expect(harness.manager.getJob(jobIds[0]!)?.resultText).toContain("parallel-a-complete");
		expect(harness.manager.getJob(jobIds[1]!)?.resultText).toContain("parallel-b-complete");
	}, 10_000);

	it("chord-then-steer: a chord fold stays chord and a later steer cannot refold it", async () => {
		harness = createSteerHarness(cwd);
		const resultPromise = new BashTool(harness.session).execute(
			"chord-then-steer",
			{ command: "sleep 1; printf 'chord completed\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		await waitFor(() => harness?.session.hasForegroundBashBackgroundRequestHandler?.() === true);
		expect(await harness.session.requestForegroundBashBackground?.("chord")).toBe(true);
		const result = await resultPromise;
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected chord fold background job");
		const job = harness.manager.getJob(jobId);
		if (!job) throw new Error("expected chord-folded job to stay registered");

		harness.steer();
		await Bun.sleep(0);
		expect(await harness.session.requestForegroundBashBackground?.("steer")).toBe(false);
		expect(result.details?.foldReason).toBe("chord");
		expect(job.metadata?.foldReason).toBe("chord");
		expect(harness.folds).toEqual([{ jobId, generation: job.generation, reason: "chord" }]);
		await job.promise;
	});

	it("timer fold crosses the coordinator boundary and stops the originating turn", async () => {
		harness = createSteerHarness(cwd, { autoBackgroundEnabled: true, autoBackgroundThresholdMs: 50 });
		const result = await new BashTool(harness.session).execute(
			"timer-fold",
			{ command: "sleep 1; printf 'timer completed\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected timer-folded job");
		const job = harness.manager.getJob(jobId);
		if (!job) throw new Error("expected timer-folded job to remain registered");
		expect(result.details?.foldReason).toBe("timer");
		expect(harness.fenceArmed()).toBe(true);
		expect(harness.stopRequested()).toBe(true);
		expect(harness.folds).toEqual([{ jobId, generation: job.generation, reason: "timer" }]);
		await job.promise;
	}, 10_000);

	it("steer-then-abort: aborting the old foreground signal after a steer fold leaves the manager-owned job running", async () => {
		harness = createSteerHarness(cwd);
		const abort = new AbortController();
		const resultPromise = new BashTool(harness.session).execute(
			"steer-then-abort",
			{ command: "sleep 4; printf 'survived stale abort\\n'", timeout: 30 },
			abort.signal,
			undefined,
			turnContext(),
		);
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected steer fold before abort");
		const job = harness.manager.getJob(jobId);
		if (!job) throw new Error("expected folded job to remain registered");

		abort.abort();
		await Bun.sleep(200);
		expect(job.status).toBe("running");
		await job.promise;
		expect(job.status).toBe("completed");
		expect(job.resultText).toContain("survived stale abort");
	}, 10_000);

	it("gate-flip-mid-command: a busyPromptMode flip to queue after wait start disarms the fold at the moment the steer arrives", async () => {
		harness = createSteerHarness(cwd);
		const resultPromise = new BashTool(harness.session).execute(
			"gate-flip",
			{ command: "sleep 2.6; printf 'gate flip completed\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		await waitFor(() => harness?.session.hasForegroundBashBackgroundRequestHandler?.() === true);
		harness.setBusyPromptMode("queue");
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;
		expect(result.details?.async).toBeUndefined();
		expect(textOf(result)).toContain("gate flip completed");
		expect(harness.folds).toHaveLength(0);
	}, 10_000);

	it("foldReason-projection: a steer reason survives live, parked-delivery, and receipt-claim snapshot projections", async () => {
		harness = createSteerHarness(cwd, { retentionMs: 0 });
		const resultPromise = new BashTool(harness.session).execute(
			"projection",
			{ command: "sleep 5; printf 'projection completed\\n'", timeout: 30 },
			undefined,
			undefined,
			turnContext(),
		);
		await Bun.sleep(STEER_FOLD_GRACE_MS + 100);
		harness.steer();
		const result = await resultPromise;
		const jobId = result.details?.async?.jobId;
		if (!jobId) throw new Error("expected steer-folded projection job");
		const job = harness.manager.getJob(jobId);
		if (!job) throw new Error("expected projection job to remain registered before completion");

		expect(harness.manager.getJobsSnapshot().jobs).toContainEqual(
			expect.objectContaining({ id: jobId, backgrounded: true, foldReason: "steer" }),
		);
		harness.manager.retainParkedDelivery(job, "parked steer output");
		harness.manager.retainDeliveryClaim(job);
		await job.promise;
		await waitFor(() => harness?.manager.getJob(jobId) === undefined);

		const projected = { id: jobId, generation: job.generation, backgrounded: true, foldReason: "steer" };
		expect(harness.manager.getJobsSnapshot().jobs).toContainEqual(expect.objectContaining(projected));
		harness.manager.clearParkedDelivery(job.generation);
		expect(harness.manager.getJobsSnapshot().jobs).toContainEqual(expect.objectContaining(projected));
	}, 10_000);

	it("indicator-tally: itemized activity keeps the three locked categories in order; unclassified task jobs are omitted", () => {
		const running: AsyncJobSnapshotItem[] = [
			{
				id: "subagent",
				type: "task",
				status: "running",
				label: "subagent",
				startTime: 0,
				metadata: { subagent: { id: "subagent", agent: "executor", agentSource: "bundled" } },
			},
			{
				id: "bash",
				type: "bash",
				status: "running",
				label: "bash",
				startTime: 0,
				metadata: { backgrounded: true },
			},
			{ id: "foreground-bash", type: "bash", status: "running", label: "foreground bash", startTime: 0 },
			{
				id: "monitor",
				type: "bash",
				status: "running",
				label: "monitor",
				startTime: 0,
				metadata: { monitor: true },
			},
			{ id: "batch", type: "task", status: "running", label: "batch", startTime: 0 },
		];
		const tally = tallyBackgroundActivity(running);
		expect(tally).toEqual({ subagents: 1, backgroundBash: 1, monitors: 1 });
		expect(resolveActivityIndicatorMessage(false, tally, "Working…")).toBe(
			"Background: 1 subagent, 1 background bash, 1 monitor…",
		);
		expect(resolveActivityIndicatorMessage(true, tally, "Working…")).toBe(
			"Working… · 1 subagent, 1 background bash, 1 monitor",
		);
	});

	it("task and subagent waits expose no foreground Bash fold registration path", () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		for (const relative of ["packages/coding-agent/src/task", "packages/coding-agent/src/tools/subagent.ts"]) {
			const absolute = path.join(repoRoot, relative);
			const sources = fs.statSync(absolute).isDirectory()
				? fs
						.readdirSync(absolute, { recursive: true })
						.map(entry => String(entry))
						.filter(entry => entry.endsWith(".ts"))
						.map(entry => fs.readFileSync(path.join(absolute, entry), "utf8"))
				: [fs.readFileSync(absolute, "utf8")];
			expect(sources.join("\n")).not.toContain("registerForegroundFoldParticipant");
		}
	});

	it("guidance-contract: docs/tools/bash.md and job.md carry the fixed steer result reason line", () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const expectedReasonLine = steerFoldReasonLine("<id>");
		expect(fs.readFileSync(path.join(repoRoot, "docs/tools/bash.md"), "utf8")).toContain(expectedReasonLine);
		expect(fs.readFileSync(path.join(repoRoot, "docs/tools/job.md"), "utf8")).toContain(expectedReasonLine);
	});
});
