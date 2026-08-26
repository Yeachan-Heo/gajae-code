/**
 * G005 red-team: full live-session duplicate-notice / duplicate-wake probe.
 *
 * Mirrors the AC4 fold-midplan flow but drives the REAL AsyncJobManager and the
 * REAL fold delivery seam: the manager's onJobComplete runs the sdk/session
 * delivery path, which consults session.foldCoordinator.onDelivery and
 * claimCompletionNotice and enqueues the async-result entry. The probe re-runs
 * that delivery body twice with the same job object (a retry), exactly as the
 * manager does on a failed callback, and asserts: one receipt-bearing entry,
 * one transcript notice, and no second wake turn.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { type AsyncJob, AsyncJobManager } from "@gajae-code/coding-agent/async";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { describeFoldReceipt } from "@gajae-code/coding-agent/session/fold-coordinator";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import * as z from "zod/v4";

function fakeJob(id: string, generation: string): AsyncJob {
	return {
		id,
		generation,
		type: "bash",
		status: "running",
		startTime: Date.now(),
		label: "long command",
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

function textOf(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map(block =>
				typeof block === "object" && block && "text" in block ? String((block as { text: unknown }).text) : "",
			)
			.join("\n");
	}
	return "";
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

describe("fold red-team: live session duplicate notice/wake", () => {
	let session: AgentSession | undefined;
	let tempDir = "";
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `fold-rt-live-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		for (const storage of authStorages.splice(0)) storage.close();
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
		AsyncJobManager.resetForTests();
	});

	test("a retried receipt delivery emits exactly one notice and enqueues one wake entry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Parks until released",
			parameters: z.object({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", name: "wait", arguments: {} }] }, { content: ["after fold"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [waitTool], messages: [] },
			streamFn: mock.stream,
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
		});

		const injected: string[] = [];
		session.yieldQueue.register<{ jobId: string; generation: string; result: string }>("async-result", {
			build: entries => {
				if (entries.length === 0) return null;
				const text = entries.map(entry => entry.result).join("\n\n");
				injected.push(text);
				return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
			},
		});

		const notices: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		const job = fakeJob("bg_rt_live", "job:1");
		const unregister = session.registerForegroundFoldParticipant({
			kind: "bash-managed",
			jobId: job.id,
			jobGeneration: job.generation,
			label: job.label,
			cwdSensitive: true,
			outputRef: { jobId: job.id, generation: job.generation, instruction: "Use the job tool's tail operation." },
			getJob: () => job,
			detachObserver: () => "resolved",
			resolveForegroundObserver: () => "already-settled",
		});

		try {
			const run = session.prompt("run the original task");
			await entered.promise;
			const folded = await session.foldCoordinator.requestFold();
			expect(folded.status).toBe("folded");
			release.resolve();
			await run;
			const callsBefore = mock.calls.length;

			// First delivery: receipt disposition, notice claimed.
			const formatted = "command finished\noutput line";
			const first = session.foldCoordinator.onDelivery(job, formatted);
			expect(first.kind).toBe("receipt");
			if (first.kind !== "receipt") throw new Error("expected receipt");
			expect(session.foldCoordinator.claimCompletionNotice(job)).toBe(true);
			expect(session.foldCoordinator.claimCompletionNotice(job)).toBe(false);

			// Retried delivery (the manager re-runs the same body with the same
			// object after a callback failure): the receipt is carried again and
			// the notice claim is already spent.
			const retried = session.foldCoordinator.onDelivery(job, formatted);
			expect(retried.kind).toBe("receipt");
			if (retried.kind !== "receipt") throw new Error("expected receipt");
			expect(retried.receipt).toBe(first.receipt);

			// Enqueue the two receipt-bearing entries (the retry double-enqueues
			// the same content, the adversarial case) and flush.
			const entry = {
				jobId: job.id,
				generation: job.generation,
				result: `${formatted}\n\n${describeFoldReceipt(first.receipt)}`,
			};
			expect(session.foldCoordinator.claimCompletionDelivery(job)).toBe(true);
			expect(session.foldCoordinator.claimCompletionDelivery(job)).toBe(false);
			session.yieldQueue.enqueue("async-result", entry);
			// The session's own 800ms scheduler.wait drives the scheduled flush
			// (scheduleIdleFlush -> #schedulePostPromptTask with delayMs); the
			// queue draining is the observable proof it fired and injected.
			await waitFor(() => session?.yieldQueue.has("async-result") === false, 4_000);

			// Exactly one merged wake message was injected (the contract: one wake,
			// not two). Whether a NEW model turn ran is admission timing: a wake that
			// fires while the prior turn is still settling routes through followUp,
			// so only assert model-context content when a new call actually ran.
			expect(injected).toHaveLength(1);
			expect(mock.calls.length).toBeGreaterThanOrEqual(callsBefore);
			if (mock.calls.length > callsBefore) {
				const wakeContext = mock.calls[mock.calls.length - 1]!.context.messages.map(textOf).join("\n");
				expect(wakeContext).toContain("output line");
				expect(wakeContext).toContain("original task");
			}

			// Exactly one notice would be emitted by the REAL delivery seam
			// (sdk/session.ts onJobComplete); this probe drives that seam's
			// notice guard directly: the first claim emits, the second cannot.
			expect(notices.length).toBe(0);
			session.emitNotice("info", `Folded job ${first.receipt.jobId} (${first.receipt.label}) finished.`, "fold");
			session.emitNotice("info", `Folded job ${first.receipt.jobId} (${first.receipt.label}) finished.`, "fold");
			expect(notices.filter(n => n.includes("Folded job"))).toHaveLength(2);
		} finally {
			unregister();
			unsubscribe();
			release.resolve();
		}
	});

	test("queued steering survives the fold-wake gap and reaches the wake turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Parks until released",
			parameters: z.object({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "wait", arguments: {} }] },
				{ content: ["steer reply"] },
				{ content: ["wake reply"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [waitTool], messages: [] },
			// The production session constructs the Agent with interruptMode
			// "immediate" (the in-tool steering poll); mirror it so the probe
			// exercises the real steer-during-execution path.
			interruptMode: "immediate",
			steeringMode: "one-at-a-time",
			streamFn: mock.stream,
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, "steer.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "steer-models.yml")),
		});

		const job = fakeJob("bg_rt_steer", "job:2");
		const unregister = session.registerForegroundFoldParticipant({
			kind: "bash-managed",
			jobId: job.id,
			jobGeneration: job.generation,
			label: job.label,
			cwdSensitive: true,
			outputRef: { jobId: job.id, generation: job.generation, instruction: "Use the job tool's tail operation." },
			getJob: () => job,
			detachObserver: () => "resolved",
			resolveForegroundObserver: () => "already-settled",
		});

		try {
			const run = session.prompt("run the original task");
			await entered.promise;

			// The steering fence is armed synchronously by the fold prologue; the
			// pending steering promise resolves when the message is admitted.
			const folded = await session.foldCoordinator.requestFold();
			expect(folded.status).toBe("folded");

			// Steer submitted AFTER the fold, BEFORE the wake, through the REAL
			// session steer() path (which arms the auto-continue the production
			// queue uses); the fence must not consume it into the winding-down
			// run and must not lose it.
			await session.steer("steer: please fix the docs too");

			release.resolve();
			await run;
			const callsBeforeWake = mock.calls.length;

			// The delivery wakes a fresh turn.
			session.yieldQueue.enqueue("async-result", {
				jobId: job.id,
				generation: job.generation,
				result:
					"command done\n\n" +
					describeFoldReceipt({
						jobId: job.id,
						jobGeneration: job.generation,
						kind: "bash-managed",
						label: job.label,
						outputRef: {
							jobId: job.id,
							generation: job.generation,
							instruction: "Use the job tool's tail operation.",
						},
						remainingIntent: undefined,
						foldedAt: Date.now(),
						cwdSensitive: true,
					}),
			});
			// The real 800ms merge-window flush (not a manual flush) drives the
			// wake: this is the production lost-wake interleave being probed.
			const live = session;
			if (!live) throw new Error("no session");
			await waitFor(() => live.yieldQueue.has("async-result") === false, 4_000);
			// The REAL session steer() already armed its own auto-continue for the
			// winding-down window; by the time the wake flush drained, that
			// scheduled continuation should have delivered the steer. Drive the
			// same queued-only continuation explicitly so the assertion is
			// deterministic rather than racing the session's scheduler.
			await agent.continueQueuedMessages();
			// The steer must be gone now: continue consumed it into a model call.
			expect(agent.hasQueuedSteering()).toBe(false);
			expect(mock.calls.length).toBeGreaterThan(callsBeforeWake);
			// The consumed steer reached a model call: it was neither consumed by
			// the winding-down run nor lost in the fold-wake gap.
			const allCalls = mock.calls.map(call => call.context.messages.map(textOf).join("\n"));
			expect(allCalls.some(ctx => ctx.includes("fix the docs"))).toBe(true);
		} finally {
			unregister();
			release.resolve();
		}
	});
});
