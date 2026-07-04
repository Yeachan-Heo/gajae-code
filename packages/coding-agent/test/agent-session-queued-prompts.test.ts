import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel, type TextContent } from "@gajae-code/ai";
import { createMockModel, type MockHandler } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

/**
 * Issue #434 — queued prompts while the agent is busy.
 *
 * A prompt submitted while the agent is streaming can either steer the active
 * turn (interrupt now) or be queued to run after the active turn completes.
 * These tests pin the two distinct behaviors and prove the two queues do not
 * conflate: steering goes to the steering queue, queued-next-turn prompts go to
 * the follow-up queue, and the queued prompts run in submission order.
 */
describe("AgentSession queued prompts (issue #434)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queued-prompts-");
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

	function buildSession(responses: MockHandler[]): AgentSession {
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

	function messageText(m: Extract<AgentMessage, { role: "user" }>): string {
		if (typeof m.content === "string") return m.content;
		return m.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("");
	}

	function userTexts(s: AgentSession): string[] {
		return s.agent.state.messages
			.filter((m): m is Extract<AgentMessage, { role: "user" }> => m.role === "user")
			.map(messageText);
	}

	function assistantCount(s: AgentSession): number {
		return s.agent.state.messages.filter(m => m.role === "assistant").length;
	}

	async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
		const start = Date.now();
		while (!predicate()) {
			if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
			await Bun.sleep(5);
		}
	}

	it("runs prompts queued while busy after the active turn, in submission order", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["turn 1"] };
			},
			{ content: ["turn 2"] },
			{ content: ["turn 3"] },
		]);

		// Start the first turn but do not await — it blocks on the gate so the
		// session stays busy while we queue.
		const first = session.prompt("p1");
		await waitUntil(() => session!.isStreaming);

		// Queue two prompts as next-turn work (the "queue" busy behavior).
		await session.prompt("p2", { streamingBehavior: "followUp" });
		await session.prompt("p3", { streamingBehavior: "followUp" });

		// They are queued, not delivered yet, and live in the follow-up queue.
		expect(session.getQueuedMessages().followUp).toEqual(["p2", "p3"]);
		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(assistantCount(session)).toBe(0);

		gate.resolve();
		await first;
		await session.waitForIdle();

		expect(userTexts(session)).toEqual(["p1", "p2", "p3"]);
		expect(assistantCount(session)).toBe(3);
		expect(session.queuedMessageCount).toBe(0);
	});

	it("keeps steering and queued-next-turn prompts in separate queues", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["turn 1"] };
			},
			{ content: ["after steer"] },
			{ content: ["after queue"] },
		]);

		const first = session.prompt("p1");
		await waitUntil(() => session!.isStreaming);

		await session.prompt("steer me", { streamingBehavior: "steer" });
		await session.prompt("queue me", { streamingBehavior: "followUp" });

		// Separation: the steer landed only in the steering queue, the queued
		// prompt only in the follow-up queue.
		expect(session.getQueuedMessages().steering).toEqual(["steer me"]);
		expect(session.getQueuedMessages().followUp).toEqual(["queue me"]);
		expect(session.hasQueuedSteering).toBe(true);

		gate.resolve();
		await first;
		await session.waitForIdle();

		// Steering interrupted/continued the active turn; the queued prompt ran
		// after it. Submission order across both is preserved.
		expect(userTexts(session)).toEqual(["p1", "steer me", "queue me"]);
	});

	it("removes an arbitrary queued prompt selected for editing", async () => {
		const gate = Promise.withResolvers<void>();
		session = buildSession([
			async () => {
				await gate.promise;
				return { content: ["turn 1"] };
			},
			{ content: ["after steer"] },
			{ content: ["after remaining queue"] },
		]);

		const first = session.prompt("p1");
		await waitUntil(() => session!.isStreaming);

		await session.prompt("steer me", { streamingBehavior: "steer" });
		await session.prompt("queue older", { streamingBehavior: "followUp" });
		await session.prompt("queue newest", { streamingBehavior: "followUp" });

		const entries = session.getQueuedMessageEntries();
		expect(entries.map(entry => entry.text)).toEqual(["queue newest", "queue older", "steer me"]);
		const removed = session.removeQueuedMessageForEditing(entries[1]?.id ?? "");

		expect(removed).toBe("queue older");
		expect(session.getQueuedMessages().steering).toEqual(["steer me"]);
		expect(session.getQueuedMessages().followUp).toEqual(["queue newest"]);

		gate.resolve();
		await first;
		await session.waitForIdle();

		expect(userTexts(session)).toEqual(["p1", "steer me", "queue newest"]);
	});
});
