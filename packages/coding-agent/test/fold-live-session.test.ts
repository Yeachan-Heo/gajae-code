/**
 * AC3: a real fold through a live AgentSession must end the turn as a clean
 * stop-after-result -- `agent_end` with stopReason "paused" -- and never via
 * abort, because an abort-recorded terminal scope classifies the folded job's
 * own completion as dropped and silently kills auto-wake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { type AsyncJob, AsyncJobManager } from "@gajae-code/coding-agent/async";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { FoldReceipt } from "@gajae-code/coding-agent/session/fold-coordinator";
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
		label: id,
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out waiting for condition");
}

describe("live session fold", () => {
	let session: AgentSession | undefined;
	let tempDir = "";
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `fold-live-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		for (const storage of authStorages.splice(0)) storage.close();
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
		AsyncJobManager.resetForTests();
	});

	test("ends the turn with stopReason paused and settles the foreground caller once", async () => {
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
			responses: [{ content: [{ type: "toolCall", name: "wait", arguments: {} }] }, { content: ["after the fold"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [waitTool], messages: [] },
			streamFn: mock.stream,
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		const stopReasons: string[] = [];
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "agent_end") stopReasons.push(String(event.stopReason));
		});

		// Stand in for the managed bash adapter: the same settle-once contract, so
		// exactly one party may settle the foreground caller.
		const job = fakeJob("bg_1", "job:1");
		let settled = 0;
		const detached: FoldReceipt[] = [];
		const unregister = session.registerForegroundFoldParticipant({
			kind: "bash-managed",
			jobId: job.id,
			jobGeneration: job.generation,
			label: "sleep 100",
			cwdSensitive: true,
			outputRef: {
				jobId: job.id,
				generation: job.generation,
				instruction: "Use the job tool's tail operation for bg_1.",
			},
			getJob: () => job,
			detachObserver: receipt => {
				settled += 1;
				detached.push(receipt);
				return settled === 1 ? "resolved" : "already-settled";
			},
			resolveForegroundObserver: () => (settled === 0 ? "resolved" : "already-settled"),
		});

		try {
			// Fail fast and legibly when the checkout cannot see its own agent package.
			// A worktree whose node_modules is a symlink to another checkout resolves
			// @gajae-code/agent-core there instead, so this method goes missing and the
			// fold path throws deep inside the coordinator.
			expect(typeof (agent as unknown as { setSteeringAdmissionFence?: unknown }).setSteeringAdmissionFence).toBe(
				"function",
			);
			expect(session.hasForegroundBashBackgroundRequestHandler()).toBe(true);

			const run = session.prompt("run the tool");
			await entered.promise;

			// Drive the transaction directly so a failure surfaces as a reason rather
			// than a timeout; the chord path is the same call behind a sync boolean.
			const folded = await session.foldCoordinator.requestFold();
			expect(folded.status).toBe("folded");
			expect(session.foldCoordinator.slotStateFor(job)).toBe("present");
			await waitFor(() => detached.length === 1);

			release.resolve();
			await run;

			// The foreground caller was settled exactly once, by the fold.
			expect(settled).toBe(1);
			expect(detached[0]).toMatchObject({ jobId: "bg_1", kind: "bash-managed" });
			// The receipt carries what the interrupted turn was asked to do.
			expect(detached[0]?.remainingIntent).toContain("run the tool");

			// Stop-after-result, not abort: the turn paused.
			expect(stopReasons).toContain("paused");
			expect(stopReasons).not.toContain("aborted");
		} finally {
			unregister();
			unsubscribe();
			release.resolve();
		}
	});

	test("reports no foldable wait when nothing is registered", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses: [{ content: ["idle"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth2.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models2.yml")),
		});

		expect(session.hasForegroundBashBackgroundRequestHandler()).toBe(false);
		expect(session.requestForegroundBashBackground()).toBe(false);
	});
});
