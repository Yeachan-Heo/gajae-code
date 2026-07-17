import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/**
 * Steer-on-interrupt contract (deep-interview spec, AC-1/AC-4):
 *  - a user interrupt (Esc) with queued steering resumes by draining the
 *    steering queue instead of going idle;
 *  - any non-user (lifecycle/teardown) abort suppresses the resume.
 */
describe("AgentSession steer-on-interrupt", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-steer-interrupt-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function buildSession(responses: Array<{ content: string[] }>): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	function assistantCount(s: AgentSession): number {
		return s.agent.state.messages.filter(m => m.role === "assistant").length;
	}

	async function promptAndWaitForAssistant(s: AgentSession, text: string): Promise<void> {
		const assistantEnded = Promise.withResolvers<void>();
		const unsubscribe = s.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") assistantEnded.resolve();
		});
		try {
			await Promise.all([s.prompt(text), assistantEnded.promise]);
			await s.waitForIdle();
		} finally {
			unsubscribe();
		}
	}

	it("resumes queued steering after a user interrupt", async () => {
		session = buildSession([{ content: ["first done"] }, { content: ["handled steering"] }]);

		await promptAndWaitForAssistant(session, "first task");
		expect(assistantCount(session)).toBe(1);

		// User queues a steer, then interrupts.
		session.agent.steer(userMessage("also handle the steer"));
		expect(session.agent.hasQueuedSteering()).toBe(true);

		await session.abort({ cause: "user_interrupt" });
		await session.waitForIdle();

		// The queued steering was drained and produced a second turn.
		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(assistantCount(session)).toBe(2);
	});

	it("delivers a steer queued while the agent is idle without a user interrupt", async () => {
		session = buildSession([{ content: ["first done"] }, { content: ["handled steering"] }]);

		await promptAndWaitForAssistant(session, "first task");
		expect(assistantCount(session)).toBe(1);

		// A steer lands while no live agent loop is running (the busy/unwind window
		// the interactive composer routes through). It must be delivered promptly
		// instead of stalling until the user presses Esc.
		await session.steer("also handle the steer");
		await session.waitForIdle();

		expect(session.agent.hasQueuedSteering()).toBe(false);
		expect(assistantCount(session)).toBe(2);
		expect(
			session.agent.state.messages.some(
				m => m.role === "user" && JSON.stringify(m.content).includes("also handle the steer"),
			),
		).toBe(true);
	});

	it("does not resume queued steering after a non-user abort", async () => {
		session = buildSession([{ content: ["first done"] }, { content: ["should not run"] }]);

		await promptAndWaitForAssistant(session, "first task");
		expect(assistantCount(session)).toBe(1);

		session.agent.steer(userMessage("queued steer"));

		// Default cause is a teardown/internal abort: must NOT resume.
		await session.abort();
		await session.waitForIdle();

		expect(session.agent.hasQueuedSteering()).toBe(true);
		expect(assistantCount(session)).toBe(1);
	});
});
