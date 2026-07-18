import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { type AbortOutcome, AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { logger, TempDir } from "@gajae-code/utils";

type Scenario = "mid-streaming" | "active tool" | "auto-retry" | "pre-existing steering+follow-up entries";
type RollbackOutcome = Extract<AbortOutcome, { kind: "timeout" | "error" }>;

function messageText(message: AgentMessage): string {
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") return content;
	return (
		content
			?.filter(part => part.type === "text")
			.map(part => part.text ?? "")
			.join("") ?? ""
	);
}

function makeAssistantMessage(text: string, stopReason: "stop" | "aborted" = "stop") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} as never;
}

describe("AgentSession.cancelAndSubmit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@cancel-and-submit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.useRealTimers();
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function buildSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const mock = createMockModel({ responses: [{ content: ["sent"] }] });
		const contexts: unknown[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				contexts.push(context);
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		return { agent, contexts, session };
	}

	function buildGatedStreamingSession() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		let streamCalls = 0;
		const streamFn: StreamFn = (_requestedModel, _context, options) => {
			streamCalls++;
			const stream = new AssistantMessageEventStream();
			if (streamCalls > 1) {
				queueMicrotask(() => {
					const message = makeAssistantMessage("sent");
					stream.push({ type: "start", partial: message });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "sent", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "sent", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			}
			queueMicrotask(() => {
				stream.push({ type: "start", partial: makeAssistantMessage("") });
				options?.signal?.addEventListener(
					"abort",
					() =>
						stream.push({ type: "error", reason: "aborted", error: makeAssistantMessage("Aborted", "aborted") }),
					{ once: true },
				);
			});
			return stream;
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		return { agent, session };
	}

	async function waitForStreaming(s: AgentSession): Promise<void> {
		const deadline = Date.now() + 1_000;
		while (!s.isStreaming || s.agent.state.streamMessage === null) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the provider stream");
			await Bun.sleep(1);
		}
	}

	async function seedQueues(s: AgentSession, scenario: Scenario): Promise<void> {
		await s.steer(`${scenario}: steer`);
		await s.followUp(`${scenario}: follow-up`);
		s.queueDeferredMessageForTests(
			{ role: "custom", customType: "test", content: `${scenario}: aside`, display: false, timestamp: 1 },
			false,
		);
	}

	function stores(s: AgentSession) {
		const agentQueues = s.agent.snapshotQueues();
		return {
			agent: {
				steering: agentQueues.steering.map(messageText),
				followUp: agentQueues.followUp.map(messageText),
			},
			display: s.getQueuedMessages(),
			pendingNextTurn: s.getPendingNextTurnMessagesForTests(),
		};
	}

	async function assertRollback(scenario: Scenario, outcome: RollbackOutcome): Promise<void> {
		const { agent, session: s } = buildSession();
		await seedQueues(s, scenario);
		const before = stores(s);
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		s.setCancelAndSubmitAbortOutcomeProviderForTests(async () => outcome);

		await expect(s.cancelAndSubmit(`${scenario}: send now`)).resolves.toEqual({ kind: "rolled_back", outcome });
		expect(stores(s)).toEqual(before);
		if (outcome.kind === "error") {
			expect(errorSpy).toHaveBeenCalledWith("Cancel-and-submit abort failed", { cause: outcome.cause });
		}
		// No continuation was started: the rollback restored both Agent queues and their UI mirrors.
		expect(agent.snapshotQueues().steering.map(messageText)).toEqual(before.agent.steering);
	}

	for (const scenario of [
		"mid-streaming",
		"active tool",
		"auto-retry",
		"pre-existing steering+follow-up entries",
	] as const) {
		it(`${scenario} × seam-injected rollback(timeout) restores every queue store`, async () => {
			await assertRollback(scenario, { kind: "timeout" });
		});

		it(`${scenario} × seam-injected rollback(error) restores every queue store and logs the original cause`, async () => {
			const cause = new Error(`${scenario} abort failure`);
			await assertRollback(scenario, { kind: "error", cause });
		});
	}

	describe("production abort/finalization", () => {
		it("rolls back and preserves the finalization failure cause", async () => {
			const { session: s } = buildSession();
			await seedQueues(s, "mid-streaming");
			const before = stores(s);
			const cause = new Error("goal persistence failed");
			vi.spyOn(s.goalRuntime, "onTaskAborted").mockRejectedValueOnce(cause);

			await expect(s.cancelAndSubmit("send now")).resolves.toEqual({
				kind: "rolled_back",
				outcome: { kind: "error", cause },
			});
			expect(stores(s)).toEqual(before);
		});
	});

	it("active provider stream × commit(settled) aborts the live run and submits without an outcome seam", async () => {
		const { agent, session: s } = buildGatedStreamingSession();
		const activePrompt = s.prompt("active stream");
		await waitForStreaming(s);

		await expect(s.cancelAndSubmit("send now")).resolves.toEqual({ kind: "submitted" });
		await activePrompt;
		await s.waitForIdle();
		expect(agent.state.messages.map(messageText)).toContain("send now");
		expect(agent.state.messages.map(messageText)).toContain("sent");
		expect(s.isStreaming).toBe(false);
	});

	it("active provider stream × rollback(finalization failure) restores queues without an outcome seam", async () => {
		const { session: s } = buildGatedStreamingSession();
		const cause = new Error("finalization failed");
		vi.spyOn(s.goalRuntime, "onTaskAborted").mockRejectedValueOnce(cause);
		const activePrompt = s.prompt("active stream");
		await waitForStreaming(s);
		await seedQueues(s, "mid-streaming");
		const before = stores(s);

		await expect(s.cancelAndSubmit("send now")).resolves.toEqual({
			kind: "rolled_back",
			outcome: { kind: "error", cause },
		});
		await activePrompt;
		expect(stores(s)).toEqual(before);
	});

	describe("seam-injected abort outcomes", () => {
		it("pre-existing steering+follow-up entries × commit(settled) converts steering behind the sent prompt and consumes next-turn context once", async () => {
			const { agent, session: s } = buildSession();
			await seedQueues(s, "pre-existing steering+follow-up entries");
			const restoreQueues = vi.spyOn(agent, "restoreQueues");
			const promptSpy = vi.spyOn(agent, "prompt");

			expect(await s.cancelAndSubmit("send now")).toEqual({ kind: "submitted" });
			expect(restoreQueues).toHaveBeenCalledWith({
				steering: [],
				followUp: expect.arrayContaining([
					expect.objectContaining({ role: "user" }),
					expect.objectContaining({ role: "user" }),
				]),
			});
			expect(s.pendingMessageCounts.nextTurn).toBe(0);
			expect(s.getPendingNextTurnMessagesForTests()).toEqual([]);
			const sentMessages = promptSpy.mock.calls[0]?.[0] as unknown as AgentMessage[];
			expect(
				sentMessages.filter(message => messageText(message) === "pre-existing steering+follow-up entries: aside"),
			).toHaveLength(1);
			const after = stores(s);
			expect(after.agent.steering).toEqual([...after.display.steering]);
			expect(after.agent.followUp).toEqual([...after.display.followUp]);
		});

		it("mid-streaming × commit(settled) consumes next-turn context exactly once", async () => {
			const { agent, session: s } = buildSession();
			s.queueDeferredMessageForTests(
				{ role: "custom", customType: "test", content: "once-only aside", display: false, timestamp: 1 },
				false,
			);
			const promptSpy = vi.spyOn(agent, "prompt");
			expect(await s.cancelAndSubmit("send now")).toEqual({ kind: "submitted" });
			const sentMessages = promptSpy.mock.calls[0]?.[0] as unknown as AgentMessage[];
			expect(sentMessages.filter(message => messageText(message) === "once-only aside")).toHaveLength(1);
			expect(s.getPendingNextTurnMessagesForTests()).toEqual([]);
		});

		it("active tool × commit(settled) keeps Agent and display queues consistent", async () => {
			const { session: s } = buildSession();
			await seedQueues(s, "active tool");
			expect(await s.cancelAndSubmit("send now")).toEqual({ kind: "submitted" });
			const after = stores(s);
			expect(after.agent.steering).toEqual([...after.display.steering]);
			expect(after.agent.followUp).toEqual([...after.display.followUp]);
		});

		it("auto-retry × commit(settled) keeps Agent and display queues consistent", async () => {
			const { session: s } = buildSession();
			await seedQueues(s, "auto-retry");
			expect(await s.cancelAndSubmit("send now")).toEqual({ kind: "submitted" });
			const after = stores(s);
			expect(after.agent.steering).toEqual([...after.display.steering]);
			expect(after.agent.followUp).toEqual([...after.display.followUp]);
		});
	});

	it("committed queue-head sends submit the selected text exactly once", async () => {
		const { agent, session: s } = buildSession();
		await seedQueues(s, "mid-streaming");
		const [head] = s.getQueuedMessageEntries();
		if (!head) throw new Error("Expected a queue head");
		const promptSpy = vi.spyOn(agent, "prompt");

		expect(await s.cancelAndSubmit(head.text, { queuedEntryId: head.id })).toEqual({ kind: "submitted" });
		const submittedMessages = promptSpy.mock.calls.flatMap(([messages]) => messages as unknown as AgentMessage[]);
		expect(submittedMessages.filter(message => messageText(message) === head.text)).toHaveLength(1);
		expect(s.getQueuedMessageEntries().map(entry => entry.id)).not.toContain(head.id);
	});

	it("committed queue-head removes only the selected duplicate-text display", async () => {
		const { session: s } = buildSession();
		await s.steer("duplicate queued text");
		await s.steer("duplicate queued text");
		const [selected, remaining] = s.getQueuedMessageEntries();
		if (!selected || !remaining) throw new Error("expected duplicate queued entries");

		expect(await s.cancelAndSubmit(selected.text, { queuedEntryId: selected.id })).toEqual({ kind: "submitted" });
		expect(s.getQueuedMessageEntries()).toEqual([
			expect.objectContaining({ text: remaining.text, mode: "followUp" }),
		]);
	});

	it("committed queue-head preserves the original image-bearing queued message", async () => {
		const { agent, session: s } = buildSession();
		await s.steer("rich queued content", [{ type: "image", data: "image-data", mimeType: "image/png" }]);
		const [head] = s.getQueuedMessageEntries();
		if (!head) throw new Error("Expected a queue head");
		const promptSpy = vi.spyOn(agent, "prompt");

		expect(await s.cancelAndSubmit(head.text, { queuedEntryId: head.id })).toEqual({ kind: "submitted" });
		const submittedMessages = promptSpy.mock.calls.flatMap(([messages]) => messages as unknown as AgentMessage[]);
		expect(submittedMessages).toContainEqual(
			expect.objectContaining({
				role: "user",
				attribution: "user",
				content: [
					{ type: "text", text: "rich queued content" },
					{ type: "image", data: "image-data", mimeType: "image/png" },
				],
			}),
		);
	});

	it("provider failure before run acceptance restores every queue without duplication", async () => {
		const { agent, session: s } = buildSession();
		await seedQueues(s, "mid-streaming");
		const before = stores(s);
		s.setCancelAndSubmitAbortOutcomeProviderForTests(async () => ({ kind: "settled" }));
		vi.spyOn(agent, "prompt").mockRejectedValueOnce(new Error("provider unavailable"));

		await expect(s.cancelAndSubmit("send now")).resolves.toMatchObject({
			kind: "rolled_back",
			outcome: { kind: "error" },
		});
		expect(stores(s)).toEqual(before);
	});

	it("holds the duplicate token through prompt preflight and rolls back a preflight failure", async () => {
		const { session: s } = buildSession();
		await seedQueues(s, "mid-streaming");
		const before = stores(s);
		const preflight = Promise.withResolvers<void>();
		vi.spyOn(s, "refreshGjcSubskillTools").mockImplementationOnce(() => preflight.promise);
		s.setCancelAndSubmitAbortOutcomeProviderForTests(async () => ({ kind: "settled" }));

		const first = s.cancelAndSubmit("send now");
		await Promise.resolve();
		expect(await s.cancelAndSubmit("send now again")).toEqual({ kind: "refused", reason: "duplicate" });
		preflight.reject(new Error("preflight failed"));
		await expect(first).resolves.toMatchObject({ kind: "rolled_back", outcome: { kind: "error" } });
		expect(stores(s)).toEqual(before);
	});

	it("restores hidden next-turn context consumed before failed preflight, then drains it exactly once on commit", async () => {
		const { agent, session: s } = buildSession();
		const firstAside = {
			role: "custom" as const,
			customType: "test",
			content: "first aside",
			display: false,
			timestamp: 1,
		};
		const secondAside = {
			role: "custom" as const,
			customType: "test",
			content: "second aside",
			display: false,
			timestamp: 2,
		};
		const inWindowAside = {
			role: "custom" as const,
			customType: "test",
			content: "in-window aside",
			display: false,
			timestamp: 3,
		};
		s.queueDeferredMessageForTests(firstAside, false);
		s.queueDeferredMessageForTests(secondAside, false);
		const hiddenSnapshot = s.getPendingNextTurnMessagesForTests();
		s.setCancelAndSubmitAbortOutcomeProviderForTests(async () => ({ kind: "settled" }));
		vi.spyOn(agent, "setSystemPrompt").mockImplementationOnce(() => {
			s.queueDeferredMessageForTests(inWindowAside, false);
			throw new Error("preflight failure after hidden queue drain");
		});

		await expect(s.cancelAndSubmit("send now")).resolves.toMatchObject({
			kind: "rolled_back",
			outcome: { kind: "error" },
		});
		expect(s.getPendingNextTurnMessagesForTests()).toEqual([...hiddenSnapshot, inWindowAside]);
		expect(s.getPendingNextTurnMessagesForTests()[0]).toBe(firstAside);
		expect(s.getPendingNextTurnMessagesForTests()[1]).toBe(secondAside);
		expect(s.getPendingNextTurnMessagesForTests()[2]).toBe(inWindowAside);

		const promptSpy = vi.spyOn(agent, "prompt");
		await expect(s.cancelAndSubmit("send now")).resolves.toEqual({ kind: "submitted" });
		const sentMessages = promptSpy.mock.calls[0]?.[0] as unknown as AgentMessage[];
		expect(sentMessages.filter(message => messageText(message) === "first aside")).toHaveLength(1);
		expect(sentMessages.filter(message => messageText(message) === "second aside")).toHaveLength(1);
		expect(sentMessages.filter(message => messageText(message) === "in-window aside")).toHaveLength(1);
		expect(s.getPendingNextTurnMessagesForTests()).toEqual([]);
	});

	it("preserves a message queued during the atomic window through commit", async () => {
		const { contexts, session: s } = buildSession();
		const preflight = Promise.withResolvers<void>();
		vi.spyOn(s, "refreshGjcSubskillTools").mockImplementationOnce(() => preflight.promise);
		s.setCancelAndSubmitAbortOutcomeProviderForTests(async () => ({ kind: "settled" }));

		const cancelling = s.cancelAndSubmit("send now");
		await Promise.resolve();
		await s.steer("queued during committed atomic window");
		preflight.resolve();
		await expect(cancelling).resolves.toEqual({ kind: "submitted" });
		const modelInputs = contexts.flatMap(context => (context as { messages: AgentMessage[] }).messages);
		expect(
			modelInputs.filter(message => messageText(message) === "queued during committed atomic window"),
		).toHaveLength(1);
	});

	it("mid-streaming × rollback(timeout) warns about forced recovery", async () => {
		const { agent, session: s } = buildSession();
		const notices: string[] = [];
		s.subscribe(event => {
			if (event.type === "notice" && event.level === "warning") notices.push(event.message);
		});
		vi.spyOn(agent, "waitForIdle").mockImplementationOnce(() => new Promise<void>(() => {}));
		vi.useFakeTimers();
		const cancelling = s.cancelAndSubmit("send now");
		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(5_000);
		await Promise.resolve();
		await expect(cancelling).resolves.toEqual({ kind: "rolled_back", outcome: { kind: "timeout" } });
		expect(notices).toContainEqual(expect.stringContaining("forced session recovery"));
		vi.useRealTimers();
	});

	// Refusal scenarios have no abort outcome: compaction and duplicate-token calls must leave all stores untouched.
	it("compaction-refused × refusal leaves queues and hidden context untouched", async () => {
		const { session: s } = buildSession();
		await seedQueues(s, "mid-streaming");
		const before = stores(s);
		Object.defineProperty(s, "isCompacting", { get: () => true });
		expect(await s.cancelAndSubmit("send now")).toEqual({ kind: "refused", reason: "compaction" });
		expect(stores(s)).toEqual(before);
	});

	it("chord mash × refusal permits only one in-flight token and suppresses queued draining", async () => {
		const { agent, session: s } = buildSession();
		await seedQueues(s, "mid-streaming");
		const before = stores(s);
		const deferred = Promise.withResolvers<AbortOutcome>();
		s.setCancelAndSubmitAbortOutcomeProviderForTests(() => deferred.promise);
		const continueSpy = vi.spyOn(agent, "continue");
		const first = s.cancelAndSubmit("send now");
		await Promise.resolve();
		await s.steer("queued during atomic window");
		expect(continueSpy).not.toHaveBeenCalled();
		expect(await s.cancelAndSubmit("send now again")).toEqual({ kind: "refused", reason: "duplicate" });
		deferred.resolve({ kind: "timeout" });
		await expect(first).resolves.toEqual({ kind: "rolled_back", outcome: { kind: "timeout" } });
		expect(stores(s)).toEqual({
			...before,
			agent: { ...before.agent, steering: [...before.agent.steering, "queued during atomic window"] },
			display: { ...before.display, steering: [...before.display.steering, "queued during atomic window"] },
		});
	});

	it("no live token × steer-on-interrupt remains unchanged", async () => {
		const { agent, session: s } = buildSession();
		await s.prompt("seed");
		await s.waitForIdle();
		agent.steer({ role: "user", content: "idle steer", timestamp: 1 });
		expect(s.hasQueuedSteering).toBe(true);
		await s.abort({ cause: "user_interrupt" });
		await s.waitForIdle();
		expect(agent.snapshotQueues().steering).toEqual([]);
	});
});
