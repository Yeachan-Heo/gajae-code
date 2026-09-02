import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import type { AgentMessage, AgentTool } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockHandler } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { z } from "zod";
import { createSdkRunCapability } from "../src/sdk/host/sdk-run-capability";

/**
 * Issue #4668 — production-path coverage for queued-promotion run identity.
 *
 * The SDK zero-progress contract depends on the promotion hook reporting
 * whether the consumed batch starts its own run ({ startsOwnRun: true }) or
 * is consumed inside the current run ({ startsOwnRun: false }). These tests
 * drive the REAL dispatch paths (agent loop consumption, continuation
 * promotion) instead of invoking the hook manually.
 */
describe("queued promotion run identity (#4668)", () => {
	setDefaultTimeout(60_000);

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-promotion-identity-");
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

	const echoSchema = z.object({ value: z.string() });
	type EchoParams = z.infer<typeof echoSchema>;

	function buildSession(
		responses: MockHandler[],
		tool: AgentTool<typeof echoSchema, EchoParams>,
		settings = Settings.isolated({ "compaction.enabled": false }),
	): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: mock.stream,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	it("fires startsOwnRun:false when a follow-up is consumed inside the current run", async () => {
		// The loop's in-run follow-up poll consumes the queued message WITHOUT a
		// new agent_start; the promotion must report in-run consumption so the
		// SDK attaches the submitter to the current run instead of parking the
		// correlation for an unrelated later agent_start.
		const gate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				toolStarted.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: `echoed: ${params.value}` }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["first answer"] },
				{ content: ["follow-up answer"] },
			],
			tool,
		);
		const promotions: boolean[] = [];
		const promptDone = session.prompt("first task");
		// Queue the follow-up while the tool call is still blocked: the loop's
		// in-run follow-up poll consumes it inside the current run.
		await toolStarted.promise;
		const followUpDone = session.sendUserMessage("queued follow-up", {
			deliverAs: "followUp",
			onQueuedPromoted: promotion => promotions.push(promotion.startsOwnRun === true),
		});
		gate.resolve();
		await Promise.all([promptDone, followUpDone]);
		await session.waitForIdle();
		expect(promotions).toEqual([false]);
	});

	it("fires startsOwnRun:false when steering is consumed mid-run at the real dequeue boundary", async () => {
		// Agent#getSteeringMessages dequeues mid-run steering for the CURRENT
		// turn. Before the fix no hook fired here at all, leaving the accepted
		// submission without a run identity or terminalization path.
		const gate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				toolStarted.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: `echoed: ${params.value}` }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["handled steering"] },
			],
			tool,
		);
		const promotions: boolean[] = [];
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		const steerDone = session.sendUserMessage("steer now", {
			deliverAs: "steer",
			onQueuedPromoted: promotion => promotions.push(promotion.startsOwnRun === true),
		});
		gate.resolve();
		await Promise.all([promptDone, steerDone]);
		await session.waitForIdle();
		expect(promotions).toEqual([false]);
	});

	it("fires startsOwnRun:false synchronously when a plain prompt is diverted to steering mid-dispatch", async () => {
		// Dispatch-race (#4668 review P1): the SDK snapshots isIdle() before
		// dispatch, but the session starts streaming before sendUserMessage
		// runs, so the plain prompt is diverted into the steering queue. The
		// submission promise resolves at queue time — before any consumption
		// hook fires — so the divert must report the in-run disposition
		// synchronously, or the SDK terminalizes the accepted request as an
		// own-run completion before it is consumed.
		const gate = Promise.withResolvers<void>();
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				await gate.promise;
				return { content: [{ type: "text", text: `echoed: ${params.value}` }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["handled steering"] },
			],
			tool,
		);
		const promotions: boolean[] = [];
		const dispatchDispositions: boolean[] = [];
		const promptDone = session.prompt("first task");
		while (!session.isStreaming) await Bun.sleep(5);
		// A PLAIN prompt: no deliverAs, no queuedAtDispatch snapshot — the exact
		// SDK dispatch-race shape.
		await session.sendUserMessage("raced prompt", {
			onDispatchDisposition: promotion => dispatchDispositions.push(promotion.startsOwnRun === true),
			onQueuedPromoted: promotion => promotions.push(promotion.startsOwnRun === true),
		});
		// The divert disposition must already be reported: the submission has
		// resolved, so a synchronous settlement reading the disposition now must
		// see in-run consumption, not an unknown (own-run) outcome.
		expect(dispatchDispositions[0]).toBe(false);
		gate.resolve();
		await promptDone;
		await session.waitForIdle();
		// The public promotion callback fires once at actual consumption and stays in-run.
		expect(promotions.length).toBe(1);
		expect(promotions.every(startsOwnRun => startsOwnRun === false)).toBe(true);
	});

	it("removes the selected deferred SDK follow-up by identity, never a live sibling (#4668)", async () => {
		// Exact-head review HIGH: positional removal indexed the Agent live queue
		// with a display index that includes deferred entries held outside it, so
		// selecting a deferred row could delete a different live message while
		// the selected message stayed executable.
		const gate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		const blockingTool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute() {
				toolStarted.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["first answer"] },
			],
			blockingTool,
		);
		const removals: string[] = [];
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		// Pre-existing queued work makes the SDK follow-up DEFERRED (held outside
		// the Agent live queue), while a plain follow-up lands in the live queue.
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "live sibling" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		const queuedDone = session.sendUserMessage("deferred target", {
			deliverAs: "followUp",
			sdkRunCapability: createSdkRunCapability("deferred-target-token"),
			onQueuedPromoted: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => {
				if (promotion.removed) removals.push("deferred target");
			},
		} as never);
		await queuedDone;
		// The deferred target is displayed but NOT in the Agent live queue.
		const entries = session.getQueuedMessageEntries();
		const target = entries.find(entry => entry.text === "deferred target");
		expect(target).toBeDefined();
		const removedText = session.removeQueuedMessageForEditing(target!.id);
		expect(removedText).toBe("deferred target");
		expect(removals).toEqual(["deferred target"]);
		// The live sibling must survive untouched.
		expect(session.agent.snapshotFollowUp().some(m => JSON.stringify(m).includes("live sibling"))).toBe(true);
		gate.resolve();
		await promptDone;
	});

	it("clearQueue fires removal dispositions for deferred SDK follow-ups (#4668)", async () => {
		// Exact-head review HIGH: clearQueue dropped #deferredSdkFollowUps without
		// firing their promotion hooks, leaving callbacks and reconciliation rows
		// non-terminal forever.
		const gate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		const blockingTool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute() {
				toolStarted.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["first answer"] },
			],
			blockingTool,
		);
		const removals: string[] = [];
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "live follow-up" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		const queuedDone = session.sendUserMessage("deferred follow-up", {
			deliverAs: "followUp",
			sdkRunCapability: createSdkRunCapability("deferred-clear-token"),
			onQueuedPromoted: (promotion: { startsOwnRun?: boolean; removed?: boolean }) => {
				if (promotion.removed) removals.push("deferred follow-up");
			},
		} as never);
		await queuedDone;
		expect(session.agent.snapshotFollowUp()).toHaveLength(1);
		const cleared = session.clearQueue();
		expect(cleared.followUp).toContain("deferred follow-up");
		// BOTH the live and the deferred entries must receive dispositions.
		expect(removals).toEqual(["deferred follow-up"]);
		gate.resolve();
		await promptDone;
	});

	it("reorders deferred SDK follow-ups within their own store and refuses cross-store moves", async () => {
		// A deferred SDK follow-up is held OUTSIDE the Agent queue, so its display
		// row has no Agent index. Reordering must act on the deferred store, and a
		// move that would cross stores must be refused rather than silently moving
		// an unrelated live message.
		const gate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		const blockingTool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute() {
				toolStarted.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["first answer"] },
			],
			blockingTool,
		);
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		// Public API so the live follow-up gets a DISPLAY row too: a cross-store
		// move needs two adjacent rows backed by different stores.
		await session.followUp("live follow-up");
		for (const text of ["deferred one", "deferred two"]) {
			await session.sendUserMessage(text, {
				deliverAs: "followUp",
				sdkRunCapability: createSdkRunCapability(`deferred-move-${text}`),
			} as never);
		}
		const entries = session.getQueuedMessageEntries();
		const deferredRows = entries.filter(entry => entry.text.startsWith("deferred "));
		expect(deferredRows.map(entry => entry.text)).toEqual(["deferred one", "deferred two"]);

		// Both endpoints deferred: the move applies inside the deferred store.
		expect(session.moveQueuedMessageForEditing(deferredRows[1]?.id ?? "", "up")).toBe(true);
		expect(
			session
				.getQueuedMessageEntries()
				.filter(entry => entry.text.startsWith("deferred "))
				.map(entry => entry.text),
		).toEqual(["deferred two", "deferred one"]);
		// The live follow-up kept its own slot.
		expect(session.agent.snapshotFollowUp().map(message => JSON.stringify(message))).toHaveLength(1);
		expect(JSON.stringify(session.agent.snapshotFollowUp()[0])).toContain("live follow-up");

		// A cross-store move is refused, and nothing is reordered anywhere. Pin the
		// neighbour first: the refusal must come from the STORE split, not from a
		// bounds check on the first row.
		const rowsBefore = session.getQueuedMessageEntries().map(entry => entry.text);
		// Layout: the live row precedes the deferred rows, so moving the first
		// deferred row UP crosses stores. Pin that neighbour so the refusal cannot
		// come from a bounds check.
		const crossIndex = rowsBefore.findIndex(text => text.startsWith("deferred "));
		expect(crossIndex).toBeGreaterThan(0);
		expect(rowsBefore[crossIndex - 1]).toBe("live follow-up");
		const crossId = session.getQueuedMessageEntries()[crossIndex]?.id;
		expect(session.moveQueuedMessageForEditing(crossId ?? "", "up")).toBe(false);
		expect(session.getQueuedMessageEntries().map(entry => entry.text)).toEqual(rowsBefore);

		// Behavioural proof that the DEFERRED BACKING STORE was reordered and not
		// just its display mirror: the store is released when the run ends, so the
		// order the two messages are DELIVERED in is observable in history.
		gate.resolve();
		await promptDone;
		for (let i = 0; i < 20; i++) {
			const seen = session.agent.state.messages.filter(message => JSON.stringify(message).includes("deferred "));
			if (seen.length >= 2) break;
			await session.waitForIdle();
			await Bun.sleep(20);
		}
		const deliveredOrder = session.agent.state.messages
			.map(message => JSON.stringify(message))
			.filter(text => text.includes("deferred "))
			.map(text => (text.includes("deferred two") ? "deferred two" : "deferred one"));
		expect(deliveredOrder.slice(0, 2)).toEqual(["deferred two", "deferred one"]);
	});

	it("does not fire removal for external SDK follow-ups preserved by the abort purge (#4668)", async () => {
		// Exact-head review: the abort purge preserves external SDK follow-ups
		// (they independently requested the next root turn), so their promotion
		// hooks must NOT fire a removal disposition — the submission still
		// executes later through its preserved message.
		const gate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		const blockingTool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute() {
				toolStarted.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["first answer"] },
			],
			blockingTool,
		);
		const events: Array<{ removed?: boolean; startsOwnRun?: boolean }> = [];
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		const queuedDone = session.sendUserMessage("external sdk follow-up", {
			deliverAs: "followUp",
			onQueuedPromoted: promotion => {
				events.push(promotion);
			},
		});
		// Let the durable enqueue complete before aborting: the abort cancels
		// in-flight preflights, and this test targets the post-enqueue purge.
		await queuedDone;
		session.abort();
		gate.resolve();
		await promptDone;
		// The abort purge preserved the external follow-up, so no removal
		// disposition may have fired for it.
		expect(events.filter(event => event.removed)).toEqual([]);
	});

	it("fires a removal disposition when a queued message is removed before consumption (#4668)", async () => {
		// Lifecycle review P1: a queued submission removed without consumption
		// (queue.message.remove / positional editing) must report the removal so
		// the SDK terminalizes its accepted record boundedly instead of leaving
		// it accepted forever.
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed: ${params.value}` }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["first answer"] },
			],
			tool,
		);
		const removals: Array<{ startsOwnRun?: boolean; removed?: boolean }> = [];
		const gate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		// Rebuild with a blocking tool so the queue stays unconsumed.
		const blockingTool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute() {
				toolStarted.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: ["first answer"] },
			],
			blockingTool,
		);
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		const queuedDone = session.sendUserMessage("queued steer", {
			onQueuedPromoted: promotion => {
				if (promotion.removed) removals.push(promotion);
			},
		});
		void queuedDone;
		// Remove the queued message through the real editing API.
		const entries = session.getQueuedMessageEntries();
		expect(entries.length).toBeGreaterThan(0);
		const removedText = session.removeQueuedMessageForEditing(entries[0]!.id);
		expect(removedText).toBe("queued steer");
		// The removal disposition must have fired exactly once for it.
		expect(removals).toEqual([{ startsOwnRun: false, removed: true }]);
		gate.resolve();
		await promptDone;
	});

	it("fires startsOwnRun:true when a queued follow-up is promoted to its own run via continueQueuedMessages", async () => {
		// The continuation path promotes the queued batch to a NEW run (its own
		// agent_start); the promotion must report own-run so the SDK creates the
		// pending ownership entry that agent_start drains.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ content: ["promoted answer"] }] });
		const promotions: boolean[] = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		agent.onFollowUpConsumed = (_messages, promotion = { startsOwnRun: false }) =>
			promotions.push(promotion.startsOwnRun);
		const followUpMessage = {
			role: "user",
			content: "queued follow-up",
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		agent.followUp(followUpMessage);
		await agent.continueQueuedMessages();
		expect(promotions).toEqual([true]);
	});
});
