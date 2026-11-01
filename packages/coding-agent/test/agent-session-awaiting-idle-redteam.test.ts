import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel } from "@gajae-code/ai/models";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

// Red-team for `AgentSession.isAwaitingIdle`. The /model selector shows its queued
// notice from this getter, so it must agree with what `waitForIdle()` actually
// blocks on. A false negative hides a deferred activation; a false positive shows
// a stale notice for an activation that runs immediately.
function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as AssistantMessage;
}

async function drainMicrotasks(rounds = 50): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Whether `waitForIdle()` is still pending after the microtask queue drains. */
async function waitForIdleBlocks(session: AgentSession): Promise<boolean> {
	let settled = false;
	void session.waitForIdle().then(() => {
		settled = true;
	});
	await drainMicrotasks();
	return !settled;
}

describe("AgentSession.isAwaitingIdle red-team", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let disposed = false;

	beforeEach(async () => {
		disposed = false;
		tempDir = TempDir.createSync("@gjc-awaiting-idle-redteam-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		if (!disposed) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function holdPrompt() {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			started.resolve();
			await release.promise;
			const message = assistantMessage();
			sessionManager.appendMessage(message);
			session.agent.emitExternalEvent({ type: "message_end", message });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [message] });
		});
		return { started: started.promise, release: () => release.resolve() };
	}

	it("agrees with waitForIdle() when idle", async () => {
		expect(session.isAwaitingIdle).toBe(false);
		expect(await waitForIdleBlocks(session)).toBe(false);
	});

	it("agrees with waitForIdle() during a streaming turn", async () => {
		const turn = holdPrompt();
		const prompt = session.prompt("work");
		await turn.started;
		expect(session.isAwaitingIdle).toBe(true);
		expect(await waitForIdleBlocks(session)).toBe(true);
		turn.release();
		await prompt;
		await session.waitForIdle();
		expect(session.isAwaitingIdle).toBe(false);
	});

	it("agrees with waitForIdle() for direct agent streaming outside a session prompt", async () => {
		// `waitForIdle()` keeps a streaming fallback for agent activity that is not a
		// tracked session prompt or post-prompt task. Only the `isStreaming` clause
		// covers it, so it is pinned separately from the prompt-driven cases.
		const idle = Promise.withResolvers<void>();
		vi.spyOn(session.agent, "waitForIdle").mockImplementation(() => idle.promise);
		session.agent.state.isStreaming = true;
		try {
			expect(session.hasPostPromptWork).toBe(false);
			expect(session.isAwaitingIdle).toBe(true);
			expect(await waitForIdleBlocks(session)).toBe(true);
		} finally {
			session.agent.state.isStreaming = false;
			idle.resolve();
		}
		await session.waitForIdle();
		expect(session.isAwaitingIdle).toBe(false);
	});

	it("agrees with waitForIdle() for post-prompt work alone", async () => {
		const delivery = Promise.withResolvers<void>();
		session.trackPostPromptTaskForTests(delivery.promise);
		expect(session.isStreaming).toBe(false);
		expect(session.isAwaitingIdle).toBe(true);
		expect(await waitForIdleBlocks(session)).toBe(true);
		delivery.resolve();
		await session.waitForIdle();
		expect(session.isAwaitingIdle).toBe(false);
	});

	it("never reports idle while post-prompt work from a finished turn is pending", async () => {
		const turn = holdPrompt();
		const delivery = Promise.withResolvers<void>();
		const prompt = session.prompt("work");
		await turn.started;
		session.trackPostPromptTaskForTests(delivery.promise);
		try {
			turn.release();
			// Step through the turn's teardown. A task tracked during a live prompt keeps
			// the prompt in flight, so `isStreaming` may stay true; either way the getter
			// must not drop to false while the delivery is pending.
			for (let i = 0; i < 500; i++) {
				expect(session.isAwaitingIdle).toBe(true);
				await Promise.resolve();
			}
		} finally {
			delivery.resolve();
		}
		await prompt;
		await session.waitForIdle();
		expect(session.isAwaitingIdle).toBe(false);
	});

	it("clears after the post-prompt task rejects, and the queued mutation still runs", async () => {
		const delivery = Promise.withResolvers<void>();
		session.trackPostPromptTaskForTests(delivery.promise.catch(() => {}));
		let ran = false;
		const mutation = session.withSdkControlMutation(async () => {
			ran = true;
		});
		delivery.reject(new Error("delivery failed"));
		await mutation;
		expect(ran).toBe(true);
		expect(session.isAwaitingIdle).toBe(false);
	});

	it("clears after an aborted turn, and the queued mutation runs once", async () => {
		const turn = holdPrompt();
		const prompt = session.prompt("work").catch(() => {});
		await turn.started;
		let runs = 0;
		const mutation = session.withSdkControlMutation(async () => {
			runs++;
		});
		expect(session.isAwaitingIdle).toBe(true);
		const abort = session.abort();
		turn.release();
		await abort;
		await prompt;
		await mutation;
		expect(runs).toBe(1);
		expect(session.isAwaitingIdle).toBe(false);
	});

	it("does not run a mutation queued behind a turn when the session is disposed", async () => {
		const turn = holdPrompt();
		const prompt = session.prompt("work").catch(() => {});
		await turn.started;
		let ran = false;
		const mutation = session
			.withSdkControlMutation(async () => {
				ran = true;
			})
			.then(
				() => "resolved",
				() => "rejected",
			);
		turn.release();
		await prompt;
		const disposing = session.dispose();
		disposed = true;
		const outcome = await mutation;
		await disposing;
		// Either the mutation finished before disposal or it was refused; it never hangs.
		expect(["resolved", "rejected"]).toContain(outcome);
		if (outcome === "rejected") expect(ran).toBe(false);
	});

	it("is a pure read: polling it does not change idle state", async () => {
		const delivery = Promise.withResolvers<void>();
		session.trackPostPromptTaskForTests(delivery.promise);
		for (let i = 0; i < 1000; i++) expect(session.isAwaitingIdle).toBe(true);
		expect(session.hasPostPromptWork).toBe(true);
		delivery.resolve();
		await session.waitForIdle();
		for (let i = 0; i < 1000; i++) expect(session.isAwaitingIdle).toBe(false);
	});
});
