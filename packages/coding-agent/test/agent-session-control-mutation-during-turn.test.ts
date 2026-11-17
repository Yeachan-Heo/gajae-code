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

// The /model selector closes before a queued profile activation and announces the
// queue from `session.isAwaitingIdle`. These tests pin the real session contract that
// decision relies on: the flag is set whenever `waitForIdle()` would block (a running
// turn or post-prompt work), and control mutations do not run until it clears.
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

describe("AgentSession control mutation during a running turn", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@gjc-profile-select-turn-");
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
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function blockFirstPrompt() {
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

	it("reports streaming and defers the mutation body until the turn ends", async () => {
		const turn = blockFirstPrompt();
		const activePrompt = session.prompt("active work");
		await turn.started;
		expect(session.isStreaming).toBe(true);
		expect(session.isAwaitingIdle).toBe(true);

		let bodyRan = false;
		const mutation = session.withSdkControlMutation(async () => {
			bodyRan = true;
			return session.isAwaitingIdle;
		});
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(bodyRan).toBe(false);

		turn.release();
		await activePrompt;
		expect(await mutation).toBe(false);
		expect(bodyRan).toBe(true);
	});

	it("is not awaiting idle when idle, so an idle pick shows no queued notice", async () => {
		expect(session.isStreaming).toBe(false);
		expect(session.isAwaitingIdle).toBe(false);
		expect(await session.withSdkControlMutation(async () => "ran")).toBe("ran");
	});

	it("reports awaiting idle for post-prompt work after the turn stops streaming", async () => {
		// Mirrors an idle-flush delivery queued after the foreground prompt settles:
		// `isStreaming` is false, but `waitForIdle()` still blocks on the task.
		const delivery = Promise.withResolvers<void>();
		session.trackPostPromptTaskForTests(delivery.promise);
		expect(session.isStreaming).toBe(false);
		expect(session.hasPostPromptWork).toBe(true);
		expect(session.isAwaitingIdle).toBe(true);

		let bodyRan = false;
		const mutation = session.withSdkControlMutation(async () => {
			bodyRan = true;
		});
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(bodyRan).toBe(false);

		delivery.resolve();
		await mutation;
		expect(bodyRan).toBe(true);
		expect(session.isAwaitingIdle).toBe(false);
	});

	it("runs mutations queued behind one turn in submission order", async () => {
		const turn = blockFirstPrompt();
		const activePrompt = session.prompt("active work");
		await turn.started;

		const order: string[] = [];
		const first = session.withSdkControlMutation(async () => {
			order.push("first");
		});
		const second = session.withSdkControlMutation(async () => {
			order.push("second");
		});
		turn.release();
		await activePrompt;
		await Promise.all([first, second]);
		expect(order).toEqual(["first", "second"]);
	});
});
