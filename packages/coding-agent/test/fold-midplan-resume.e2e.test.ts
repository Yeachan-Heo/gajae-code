/**
 * AC4 gate: folding mid-plan must end the turn cleanly and then WAKE a fresh
 * turn that completes the original task from the fold receipt -- not merely
 * report that a command finished.
 *
 * The plan requires this to pass before any PTY ownership work begins.
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
import { describeFoldReceipt, type FoldReceipt } from "@gajae-code/coding-agent/session/fold-coordinator";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { Snowflake } from "@gajae-code/utils";
import * as z from "zod/v4";

const ORIGINAL_TASK = "migrate the reviewer CSV importer and then update its docs";

function fakeJob(id: string, generation: string): AsyncJob {
	return {
		id,
		generation,
		type: "bash",
		status: "running",
		startTime: Date.now(),
		label: "bun run migrate",
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

describe("AC4 mid-plan fold and resume", () => {
	let session: AgentSession | undefined;
	let tempDir = "";
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `fold-ac4-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) await session.dispose();
		session = undefined;
		for (const storage of authStorages.splice(0)) storage.close();
		if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
		AsyncJobManager.resetForTests();
	});

	test("folds mid-plan, ends the turn idle, and wakes to finish the original task", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			name: "run_migration",
			label: "Run migration",
			description: "Long-running migration step",
			parameters: z.object({}),
			execute: async () => {
				entered.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "migration still running" }] };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "run_migration", arguments: {} }] },
				{ content: ["acknowledged the fold"] },
				{ content: ["docs updated; original task complete"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [waitTool], messages: [] },
			streamFn: mock.stream,
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
		});

		// Mirror the production async-result dispatcher shape. Ownership
		// partitioning is covered separately; what AC4 needs is that the delivered
		// text reaches a fresh turn intact.
		const injected: string[] = [];
		session.yieldQueue.register<{ jobId: string; generation: string; result: string }>("async-result", {
			build: entries => {
				if (entries.length === 0) return null;
				const text = entries.map(entry => entry.result).join("\n\n");
				injected.push(text);
				return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
			},
		});

		const stopReasons: string[] = [];
		const unsubscribe = agent.subscribe(event => {
			if (event.type === "agent_end") stopReasons.push(String(event.stopReason));
		});

		const job = fakeJob("bg_1", "job:1");
		let settled = 0;
		let captured: FoldReceipt | undefined;
		const unregister = session.registerForegroundFoldParticipant({
			kind: "bash-managed",
			jobId: job.id,
			jobGeneration: job.generation,
			label: job.label,
			cwdSensitive: true,
			outputRef: {
				jobId: job.id,
				generation: job.generation,
				instruction: "Use the job tool's tail operation for bg_1.",
			},
			getJob: () => job,
			detachObserver: receipt => {
				settled += 1;
				captured = receipt;
				return settled === 1 ? "resolved" : "already-settled";
			},
			resolveForegroundObserver: () => (settled === 0 ? "resolved" : "already-settled"),
		});

		try {
			// A plan is underway: the model called a long-running tool.
			const run = session.prompt(ORIGINAL_TASK);
			await entered.promise;

			const folded = await session.foldCoordinator.requestFold();
			expect(folded.status).toBe("folded");
			release.resolve();
			await run;

			// The turn ended as a clean pause, and the session is idle.
			expect(stopReasons).toContain("paused");
			expect(stopReasons).not.toContain("aborted");
			expect(session.isStreaming).toBe(false);
			const callsBeforeWake = mock.calls.length;

			// The folded job finishes. Its delivery carries the receipt, exactly as
			// the delivery seam composes it.
			expect(captured).toBeDefined();
			const receipt = captured!;
			const deliveredResult = `bg_1 finished with exit code 0\nmigration applied\n\n${describeFoldReceipt(receipt)}`;
			session.yieldQueue.enqueue("async-result", {
				jobId: receipt.jobId,
				generation: receipt.jobGeneration,
				result: deliveredResult,
			});
			await session.yieldQueue.flush("idle");

			// A fresh turn ran, and it saw the result AND the remaining intent, so it
			// can finish the original task rather than just report output.
			expect(mock.calls.length).toBeGreaterThan(callsBeforeWake);
			expect(injected).toHaveLength(1);
			const wakeCall = mock.calls[mock.calls.length - 1]!;
			const wakeContext = wakeCall.context.messages.map(textOf).join("\n");
			expect(wakeContext).toContain("migration applied");
			expect(wakeContext).toContain(ORIGINAL_TASK);
			expect(wakeContext).toContain("job tool");

			// Exactly-once injection: the queue drained, so a second flush wakes
			// nothing and cannot replay the receipt.
			const callsAfterWake = mock.calls.length;
			await session.yieldQueue.flush("idle");
			expect(injected).toHaveLength(1);
			expect(mock.calls.length).toBe(callsAfterWake);
		} finally {
			unregister();
			unsubscribe();
			release.resolve();
		}
	});
});
