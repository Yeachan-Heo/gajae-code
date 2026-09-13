import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage, AgentTool } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel, type MockHandler } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import type { QueuedInputSubmission } from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir, withTimeout } from "@gajae-code/utils";
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
		sessionManager = SessionManager.inMemory(),
		extensionRunner?: unknown,
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
		return new AgentSession({
			agent,
			sessionManager,
			settings,
			...(extensionRunner ? { extensionRunner: extensionRunner as never } : {}),
			modelRegistry,
		});
	}

	function buildAbortableTrackedTransitionFixture(
		sessionManager = SessionManager.inMemory(),
		extensionRunner?: unknown,
		abortFirstTool = false,
	) {
		const firstGate = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		const firstToolStarted = Promise.withResolvers<void>();
		const secondToolStarted = Promise.withResolvers<void>();
		let toolCallCount = 0;
		const transitionTool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, _params, signal) {
				toolCallCount += 1;
				if (toolCallCount === 1) {
					firstToolStarted.resolve();
					if (!abortFirstTool) {
						await firstGate.promise;
					} else {
						const aborted = Promise.withResolvers<void>();
						const onAbort = () => aborted.resolve();
						if (signal?.aborted) aborted.resolve();
						else signal?.addEventListener("abort", onAbort, { once: true });
						await Promise.race([firstGate.promise, aborted.promise]);
						signal?.removeEventListener("abort", onAbort);
					}
				} else {
					secondToolStarted.resolve();
					const aborted = Promise.withResolvers<void>();
					const onAbort = () => aborted.resolve();
					if (signal?.aborted) aborted.resolve();
					else signal?.addEventListener("abort", onAbort, { once: true });
					await Promise.race([secondGate.promise, aborted.promise]);
					signal?.removeEventListener("abort", onAbort);
				}
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		return {
			session: buildSession(
				[
					{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
					{ content: [{ type: "toolCall", name: "echo", arguments: { value: "second" } }] },
					{ content: ["done"] },
				],
				transitionTool,
				undefined,
				sessionManager,
				extensionRunner,
			),
			firstGate,
			secondGate,
			firstToolStarted,
			secondToolStarted,
		};
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
		const submission = await session.submitUserMessage("queued steer", {
			deliverAs: "steer",
			trackSubmission: true,
			onQueuedPromoted: promotion => {
				if (promotion.removed) removals.push(promotion);
			},
		});
		// Remove the queued message through the real editing API.
		const entries = session.getQueuedMessageEntries();
		expect(entries.length).toBeGreaterThan(0);
		const removedText = session.removeQueuedMessageForEditing(entries[0]!.id);
		expect(removedText).toBe("queued steer");
		// The removal disposition must have fired exactly once for it.
		expect(removals).toEqual([{ startsOwnRun: false, removed: true }]);
		expect(await submission.execution).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "removed",
		});
		expect(await submission.terminal).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "removed",
		});
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

	it("continues a follow-up admitted during prompt unwind", async () => {
		// A raw Agent subscriber runs before AgentSession's listener and can submit
		// from the narrow interval after the loop emits agent_end but before the
		// session publishes its terminal event. The follow-up must not be stranded
		// merely because AgentSession.isStreaming still includes that unwind.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ content: ["initial answer"] }, { content: ["follow-up answer"] }] });
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const rawAgentEnd = Promise.withResolvers<void>();
		const followUpAccepted = Promise.withResolvers<void>();
		let followUpPromise: Promise<void> | undefined;
		let promoted = false;
		agent.subscribe(event => {
			if (event.type !== "agent_end" || followUpPromise) return;
			rawAgentEnd.resolve();
			followUpPromise = session!.sendUserMessage("follow-up during unwind", {
				deliverAs: "followUp",
				queuedAtDispatch: true,
				onPreflightAccepted: () => followUpAccepted.resolve(),
				onQueuedPromoted: () => {
					promoted = true;
				},
			});
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const prompt = session.prompt("initial prompt");
		await rawAgentEnd.promise;
		if (!followUpPromise) throw new Error("Expected raw agent_end subscriber to submit a follow-up");
		await Promise.all([prompt, followUpPromise, followUpAccepted.promise]);
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(promoted).toBe(true);
		expect(session.pendingMessageCounts.followUp).toBe(0);
	});

	it("returns a stable handle for same-run steering and its terminal scope", async () => {
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
			],
			tool,
		);

		const prompt = session.prompt("first task");
		await toolStarted.promise;
		const submission: QueuedInputSubmission = await session.submitUserMessage("same-run steer", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		const admission = await submission.admitted;
		expect(admission).toMatchObject({
			submissionId: submission.submissionId,
			delivery: "steer",
			queuePolicy: "respect-mode",
		});

		gate.resolve();
		const execution = await submission.execution;
		const terminal = await submission.terminal;
		if (execution.disposition === "removed") throw new Error("Expected same-run execution");
		expect(execution).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "joined-current-run",
		});
		expect(terminal).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "completed",
			attemptScope: execution.attemptScope,
		});
		await prompt;
	});

	it("correlates successor-run follow-ups without message-text matching", async () => {
		session = buildSession([{ content: ["first answer"] }, { content: ["successor answer"] }], {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed: ${params.value}` }] };
			},
		});

		await session.prompt("first task");
		const submission = await session.submitUserMessage("duplicate text", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		const execution = await submission.execution;
		const terminal = await submission.terminal;
		if (execution.disposition === "removed") throw new Error("Expected successor execution");
		expect(execution).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "promoted-to-run",
		});
		expect(terminal).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "completed",
			attemptScope: execution.attemptScope,
		});
		await session.waitForIdle();
	});

	it("keeps identical sequential submissions independently ordered", async () => {
		session = buildSession([{ content: ["first"] }, { content: ["second"] }, { content: ["third"] }], {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed: ${params.value}` }] };
			},
		});
		await session.prompt("first task");
		const first = await session.submitUserMessage("identical", {
			deliverAs: "followUp",
			queuePolicy: "sequential",
			trackSubmission: true,
		});
		const second = await session.submitUserMessage("identical", {
			deliverAs: "followUp",
			queuePolicy: "sequential",
			trackSubmission: true,
		});
		expect(first.submissionId).not.toBe(second.submissionId);
		expect((await first.admitted).queuePolicy).toBe("sequential");
		expect((await second.admitted).queuePolicy).toBe("sequential");

		const terminalOrder: string[] = [];
		void first.terminal.then(() => terminalOrder.push(first.submissionId));
		void second.terminal.then(() => terminalOrder.push(second.submissionId));
		const firstExecution = await first.execution;
		const secondExecution = await second.execution;
		await Promise.all([first.terminal, second.terminal]);
		if (firstExecution.disposition === "removed" || secondExecution.disposition === "removed")
			throw new Error("Expected both sequential submissions to execute");
		expect(["joined-current-run", "promoted-to-run"]).toContain(firstExecution.disposition);
		expect(["joined-current-run", "promoted-to-run"]).toContain(secondExecution.disposition);
		expect(firstExecution.attemptScope.generation).toBeLessThanOrEqual(secondExecution.attemptScope.generation);
		expect(terminalOrder).toEqual([first.submissionId, second.submissionId]);
	});

	it("settles exact cancellation without waiting for a later terminal", async () => {
		const gate = Promise.withResolvers<void>();
		const toolStarted = Promise.withResolvers<void>();
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
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
			[{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] }, { content: ["done"] }],
			tool,
		);
		const prompt = session.prompt("first task");
		await toolStarted.promise;
		const submission = await session.submitUserMessage("cancel me", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		expect(submission.cancel()).toBe(true);
		expect(await submission.execution).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "cancelled",
		});
		expect(await submission.terminal).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "cancelled",
		});
		gate.resolve();
		await prompt;
	});

	it("settles a queued follow-up removed by successor startup failure", async () => {
		session = buildSession([{ content: ["first answer"] }], {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed: ${params.value}` }] };
			},
		});
		await session.prompt("first task");
		const submission = await session.submitUserMessage("startup failure", {
			deliverAs: "followUp",
			trackSubmission: true,
		});
		session.agent.setModel(undefined);
		await expect(submission.execution).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "removed",
		});
		await expect(submission.terminal).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "removed",
		});
	});

	it("releases the next deferred SDK follow-up when an earlier one is cancelled (#5460)", async () => {
		// Exact-head review P1: the deferred cancellation branch spliced
		// #deferredSdkFollowUps without releasing the successor, so a second
		// accepted deferred submission stayed outside the Agent queue forever.
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
				{ content: ["second answer"] },
			],
			blockingTool,
		);
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		// A streaming run plus an SDK run token parks both follow-ups in the
		// DEFERRED store, outside the Agent live queue.
		const first = await session.submitUserMessage("deferred one", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("deferred-one-token"),
			onQueuedPromoted: () => {
				throw new Error("synthetic removal callback failure");
			},
		} as never);
		const second = await session.submitUserMessage("deferred two", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("deferred-two-token"),
		} as never);
		expect(session.agent.snapshotFollowUp()).toHaveLength(0);

		expect(first.cancel()).toBe(true);
		// The live queue was already empty, so the successor must be released into
		// it immediately — not left waiting for an agent_end that a still-streaming
		// run has not produced yet.
		expect(session.agent.snapshotFollowUp()).toHaveLength(1);
		await expect(first.execution).resolves.toMatchObject({
			submissionId: first.submissionId,
			disposition: "removed",
			reason: "cancelled",
		});

		gate.resolve();
		await promptDone;
		const settled = await Promise.race([
			second.execution.then(() => "settled" as const),
			Bun.sleep(5_000).then(() => "timeout" as const),
		]);
		expect(settled).toBe("settled");
		expect((await second.execution).disposition).not.toBe("removed");
		await expect(second.terminal).resolves.toMatchObject({
			submissionId: second.submissionId,
			disposition: "completed",
		});
		await session.waitForIdle();
	});

	it("releases the next deferred SDK follow-up when an earlier one is removed by editing (#5460)", async () => {
		// Exact-head review P1: identity-based deferred removal spliced
		// #deferredSdkFollowUps without invoking the deferred-release path, so
		// removing one displayed row stranded every later accepted submission.
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
				{ content: ["second answer"] },
			],
			blockingTool,
		);
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		const first = await session.submitUserMessage("deferred one", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("deferred-one-token"),
		} as never);
		const second = await session.submitUserMessage("deferred two", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("deferred-two-token"),
		} as never);
		expect(session.agent.snapshotFollowUp()).toHaveLength(0);

		const firstRow = session.getQueuedMessageEntries().find(entry => entry.text === "deferred one");
		expect(firstRow).toBeDefined();
		expect(session.removeQueuedMessageForEditing(firstRow?.id ?? "")).toBe("deferred one");
		// The successor must be released immediately: the run is still streaming, so
		// no agent_end will fire to rescue it before the caller observes the state.
		expect(session.agent.snapshotFollowUp()).toHaveLength(1);
		await expect(first.execution).resolves.toMatchObject({
			submissionId: first.submissionId,
			disposition: "removed",
		});

		gate.resolve();
		await promptDone;
		const settled = await Promise.race([
			second.execution.then(() => "settled" as const),
			Bun.sleep(5_000).then(() => "timeout" as const),
		]);
		expect(settled).toBe("settled");
		expect((await second.execution).disposition).not.toBe("removed");
		await expect(second.terminal).resolves.toMatchObject({
			submissionId: second.submissionId,
			disposition: "completed",
		});
		await session.waitForIdle();
	});

	it("delivers a released deferred follow-up from a tool-result tail", async () => {
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.value }] };
			},
		};
		session = buildSession([{ content: ["tool-tail continuation"] }], tool);
		session.agent.replaceMessages([
			{
				role: "toolResult",
				toolCallId: "tail-call",
				toolName: "echo",
				content: [{ type: "text", text: "tail result" }],
				isError: false,
				timestamp: 1,
			},
		] satisfies AgentMessage[]);
		await session.followUp("blocking follow-up");
		const submission = await session.submitUserMessage("released from tool tail", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("tool-tail-release-token"),
		} as never);
		const blockingEntry = session.getQueuedMessageEntries().find(entry => entry.text === "blocking follow-up");
		if (!blockingEntry) throw new Error("Expected the blocking follow-up");
		expect(session.removeQueuedMessageForEditing(blockingEntry.id)).toBe("blocking follow-up");
		await expect(withTimeout(submission.execution, 5_000, "tool-tail deferred execution")).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "promoted-to-run",
		});
		await expect(withTimeout(submission.terminal, 5_000, "tool-tail deferred terminal")).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "completed",
		});
	});

	it("preserves FIFO when ordinary follow-up follows deferred SDK work", async () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "old context ".repeat(100), timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "recent context", timestamp: 2 });
		let ordinary: QueuedInputSubmission | undefined;
		const extensionRunner = {
			hasHandlers: vi.fn(
				(eventType: string) => eventType === "session_before_compact" || eventType === "session_compact",
			),
			hasToolResultMediation: vi.fn().mockReturnValue(false),
			emitBeforeAgentStart: vi.fn().mockResolvedValue({ messages: [] }),
			emit: vi.fn().mockImplementation(async (event: unknown) => {
				const typedEvent = event as {
					type?: string;
					preparation?: { firstKeptEntryId: string; tokensBefore: number };
				};
				if (typedEvent.type === "session_compact") {
					ordinary = await session!.submitUserMessage("ordinary after deferred SDK", {
						deliverAs: "followUp",
						trackSubmission: true,
					});
					return undefined;
				}
				if (!typedEvent.preparation) return undefined;
				return {
					compaction: {
						summary: "mixed FIFO summary",
						shortSummary: "mixed FIFO",
						firstKeptEntryId: typedEvent.preparation.firstKeptEntryId,
						tokensBefore: typedEvent.preparation.tokensBefore,
						details: {},
					},
				};
			}),
		};
		const fixture = buildAbortableTrackedTransitionFixture(sessionManager, extensionRunner, true);
		session = fixture.session;
		session.settings.override("compaction.keepRecentTokens", 1);
		const promptDone = session.prompt("first task").catch(() => {});
		await fixture.firstToolStarted.promise;
		const deferred = await session.submitUserMessage("deferred SDK", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("mixed-deferred-fifo"),
		} as never);
		expect(session.agent.snapshotFollowUp()).toHaveLength(0);

		await expect(session.compact()).resolves.toMatchObject({ summary: "mixed FIFO summary" });
		expect(ordinary).toBeDefined();
		const ordinarySubmission = ordinary!;
		const executionOrder: string[] = [];
		void deferred.execution.then(() => executionOrder.push("deferred"));
		void ordinarySubmission.execution.then(() => executionOrder.push("ordinary"));
		await withTimeout(fixture.secondToolStarted.promise, 5_000, "mixed FIFO deferred successor start");
		expect(
			await Promise.race([ordinarySubmission.execution.then(() => "settled"), Bun.sleep(20).then(() => "pending")]),
		).toBe("pending");
		fixture.secondGate.resolve();
		await expect(withTimeout(deferred.terminal, 5_000, "mixed FIFO deferred terminal")).resolves.toMatchObject({
			submissionId: deferred.submissionId,
			disposition: "completed",
		});
		await expect(
			withTimeout(ordinarySubmission.terminal, 5_000, "mixed FIFO ordinary terminal"),
		).resolves.toMatchObject({
			submissionId: ordinarySubmission.submissionId,
			disposition: "completed",
		});
		expect(executionOrder).toEqual(["deferred", "ordinary"]);
		await promptDone;
	});

	it("preserves deferred FIFO for custom follow-ups", async () => {
		const sessionManager = SessionManager.inMemory();
		const fixture = buildAbortableTrackedTransitionFixture(sessionManager, undefined, true);
		session = fixture.session;
		const customStarted = Promise.withResolvers<void>();
		const unsubscribe = session.agent.subscribe(event => {
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "custom-fifo"
			) {
				customStarted.resolve();
			}
		});
		const promptDone = session.prompt("first task").catch(() => {});
		await fixture.firstToolStarted.promise;
		const deferred = await session.submitUserMessage("deferred SDK", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("custom-fifo-deferred"),
		} as never);
		await session.sendCustomMessage(
			{ customType: "custom-fifo", content: "ordinary custom follow-up", display: true },
			{ deliverAs: "followUp" },
		);
		await session.abort({ cause: "user_interrupt" });
		await promptDone;
		await withTimeout(fixture.secondToolStarted.promise, 5_000, "custom FIFO deferred successor start");
		expect(
			await Promise.race([customStarted.promise.then(() => "started"), Bun.sleep(20).then(() => "pending")]),
		).toBe("pending");
		fixture.secondGate.resolve();
		await withTimeout(deferred.terminal, 5_000, "custom FIFO deferred terminal");
		await withTimeout(customStarted.promise, 5_000, "custom FIFO ordinary follow-up start");
		unsubscribe();
		await session.waitForIdle();
	});

	it("holds public follow-up admission behind a tracked acceptance reservation", async () => {
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			execute: async () => ({ content: [{ type: "text", text: "done" }] }),
		};
		session = buildSession([{ content: ["sdk done"] }, { content: ["ordinary done"] }], tool);
		const commitEntered = Promise.withResolvers<void>();
		const commitRelease = Promise.withResolvers<void>();
		const trackedPromise = session.submitUserMessage("sdk follow-up", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("reservation-ordering"),
			onPreflightAcceptCommit: async () => {
				commitEntered.resolve();
				await commitRelease.promise;
			},
		} as never);
		await commitEntered.promise;
		const ordinaryPromise = session.followUp("ordinary follow-up");
		await Bun.sleep(20);
		expect(session.agent.snapshotFollowUp()).toHaveLength(0);
		commitRelease.resolve();
		const tracked = await withTimeout(trackedPromise, 5_000, "reservation tracked admission");
		await withTimeout(ordinaryPromise, 5_000, "reservation ordinary admission");
		expect(tracked.submissionId).toMatch(/^queued-/u);
		expect(
			session.agent
				.snapshotFollowUp()
				.map(message =>
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content.map(part => (part.type === "text" ? part.text : "")).join("")
						: "",
				),
		).toEqual(["sdk follow-up", "ordinary follow-up"]);
	});

	it("holds prompt follow-up admission behind a tracked acceptance reservation", async () => {
		const fixture = buildAbortableTrackedTransitionFixture(SessionManager.inMemory(), undefined, true);
		session = fixture.session;
		const promptFollowUpConsumed = Promise.withResolvers<void>();
		const unsubscribe = session.agent.subscribe(event => {
			if (event.type !== "message_start" || event.message.role !== "user") return;
			const content =
				typeof event.message.content === "string"
					? event.message.content
					: event.message.content.map(part => (part.type === "text" ? part.text : "")).join("");
			if (content === "prompt follow-up") promptFollowUpConsumed.resolve();
		});
		const firstPrompt = session.prompt("first task").catch(() => {});
		await fixture.firstToolStarted.promise;
		const commitEntered = Promise.withResolvers<void>();
		const commitRelease = Promise.withResolvers<void>();
		const trackedPromise = session.submitUserMessage("sdk follow-up", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("prompt-reservation-ordering"),
			onPreflightAcceptCommit: async () => {
				commitEntered.resolve();
				await commitRelease.promise;
			},
		} as never);
		await commitEntered.promise;
		const promptFollowUp = session.prompt("prompt follow-up", { streamingBehavior: "followUp" });
		await Bun.sleep(20);
		expect(session.agent.snapshotFollowUp()).toHaveLength(0);
		commitRelease.resolve();
		await withTimeout(trackedPromise, 5_000, "prompt reservation tracked admission");
		await withTimeout(promptFollowUp, 5_000, "prompt reservation prompt admission");
		await session.abort({ cause: "user_interrupt" });
		await firstPrompt;
		await withTimeout(fixture.secondToolStarted.promise, 5_000, "prompt reservation tracked successor start");
		expect(
			await Promise.race([
				promptFollowUpConsumed.promise.then(() => "started"),
				Bun.sleep(20).then(() => "pending"),
			]),
		).toBe("pending");
		fixture.secondGate.resolve();
		await withTimeout(promptFollowUpConsumed.promise, 5_000, "prompt reservation prompt successor start");
		unsubscribe();
		await session.waitForIdle();
	});

	it("admits tracked work from the committed session_compact hook", async () => {
		const sessionManager = SessionManager.inMemory();
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "old context ".repeat(100),
			timestamp: 1,
		});
		sessionManager.appendMessage({ role: "user", content: "recent context", timestamp: 2 });
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.value }] };
			},
		};
		let submission: QueuedInputSubmission | undefined;
		let ordinaryPromptRejected = false;
		let customPromptRejected = false;
		let customSendRejected = false;
		const extensionRunner = {
			hasHandlers: vi.fn(
				(eventType: string) => eventType === "session_before_compact" || eventType === "session_compact",
			),
			hasToolResultMediation: vi.fn().mockReturnValue(false),
			emitBeforeAgentStart: vi.fn().mockResolvedValue({ messages: [] }),
			emit: vi.fn().mockImplementation(async (event: unknown) => {
				const typedEvent = event as {
					type?: string;
					preparation?: { firstKeptEntryId: string; tokensBefore: number };
				};
				if (typedEvent.type === "session_compact") {
					try {
						await session!.prompt("ordinary prompt from compact hook");
					} catch (error) {
						ordinaryPromptRejected = (error as { code?: string }).code === "busy";
					}
					try {
						await session!.promptCustomMessage(
							{ customType: "compact-hook-custom", content: "custom prompt from compact hook", display: true },
							{ streamingBehavior: "followUp" },
						);
					} catch (error) {
						customPromptRejected = (error as { code?: string }).code === "busy";
					}
					try {
						await session!.sendCustomMessage(
							{
								customType: "compact-hook-send-custom",
								content: "custom send from compact hook",
								display: true,
							},
							{ deliverAs: "followUp" },
						);
					} catch (error) {
						customSendRejected = (error as { code?: string }).code === "busy";
					}
					submission = await session!.submitUserMessage("queued by compact hook", {
						deliverAs: "followUp",
						trackSubmission: true,
					});
					return undefined;
				}
				if (!typedEvent.preparation) return undefined;
				return {
					compaction: {
						summary: "compacted summary",
						shortSummary: "compacted",
						firstKeptEntryId: typedEvent.preparation.firstKeptEntryId,
						tokensBefore: typedEvent.preparation.tokensBefore,
						details: {},
					},
				};
			}),
		};
		session = buildSession(
			[{ content: ["unused response"] }],
			tool,
			Settings.isolated({ "compaction.enabled": false }),
			sessionManager,
			extensionRunner,
		);
		session.settings.override("compaction.keepRecentTokens", 1);

		await expect(session.compact()).resolves.toMatchObject({ summary: "compacted summary" });
		expect(submission).toBeDefined();
		expect(ordinaryPromptRejected).toBe(true);
		expect(customPromptRejected).toBe(true);
		expect(customSendRejected).toBe(true);
		const accepted = submission!;
		expect(accepted.submissionId).toMatch(/^queued-/);
		if (session.getQueuedMessageEntries().length > 0) session.clearQueue();
		await expect(accepted.terminal).resolves.toMatchObject({
			submissionId: accepted.submissionId,
			disposition: expect.any(String),
		});
		void firstKeptEntryId;
	});

	it("admits tracked work from the committed session_tree hook", async () => {
		const sessionManager = SessionManager.inMemory();
		const firstUserId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const tool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.value }] };
			},
		};
		let submission: QueuedInputSubmission | undefined;
		let ordinaryPromptRejected = false;
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_tree"),
			emit: vi.fn().mockImplementation(async (event: { type?: string }) => {
				if (event.type === "session_tree") {
					try {
						await session!.prompt("ordinary prompt from tree hook");
					} catch (error) {
						ordinaryPromptRejected = (error as { code?: string }).code === "busy";
					}
					submission = await session!.submitUserMessage("queued by tree hook", {
						deliverAs: "followUp",
						trackSubmission: true,
					});
				}
			}),
		};
		session = buildSession([{ content: ["unused response"] }], tool, undefined, sessionManager, extensionRunner);

		await expect(session.navigateTree(firstUserId, { summarize: false })).resolves.toMatchObject({
			cancelled: false,
		});
		expect(submission).toBeDefined();
		expect(ordinaryPromptRejected).toBe(true);
		const accepted = submission!;
		if (session.getQueuedMessageEntries().length > 0) session.clearQueue();
		await expect(accepted.terminal).resolves.toMatchObject({
			submissionId: accepted.submissionId,
			disposition: expect.any(String),
		});
	});

	it("cancels an admitted explicit steer when its preflight signal aborts (#5460)", async () => {
		// Exact-head review P1: the explicit steer path never installed the
		// one-shot preflight-abort cancellation used by follow-ups, so an aborted
		// invocation's steer stayed executable and could not be settled through
		// that signal.
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
		const controller = new AbortController();
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		const submission = await session.submitUserMessage("abortable steer", {
			deliverAs: "steer",
			trackSubmission: true,
			preflightSignal: controller.signal,
		});
		// Admission into the live run makes the steer executable; the abort must
		// cancel exactly that queued message.
		expect(session.agent.snapshotSteering()).toHaveLength(1);
		controller.abort();
		await expect(submission.execution).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
		});
		await expect(submission.terminal).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
		});
		expect(session.agent.snapshotSteering()).toHaveLength(0);
		gate.resolve();
		await promptDone;
		await session.waitForIdle();
	});

	it("cancels a steer after abort re-arms it as a follow-up", async () => {
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
				{ content: ["rearmed steer must not execute"] },
			],
			blockingTool,
		);
		const promptDone = session.prompt("first task");
		await toolStarted.promise;
		const submission = await session.submitUserMessage("rearmable steer", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		expect(session.agent.snapshotSteering()).toHaveLength(1);

		const cancellation = Promise.withResolvers<boolean>();
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "agent_end" || event.disownedSteering?.length !== 1) return;
			cancellation.resolve(submission.cancel());
		});
		const abort = session.abort({ cause: "user_interrupt" });
		gate.resolve();

		expect(await Promise.race([cancellation.promise, Bun.sleep(5_000).then(() => false)])).toBe(true);
		unsubscribe();
		await expect(submission.execution).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "cancelled",
		});
		await expect(submission.terminal).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "cancelled",
		});
		await abort;
		await promptDone;
		await session.waitForIdle();
	});

	it("settles tracked steering when one logical run rotates attempt scopes", async () => {
		const firstGate = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		const firstToolStarted = Promise.withResolvers<void>();
		const secondToolStarted = Promise.withResolvers<void>();
		let toolCallCount = 0;
		const blockingTool: AgentTool<typeof echoSchema, EchoParams> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute() {
				toolCallCount += 1;
				if (toolCallCount === 1) {
					firstToolStarted.resolve();
					await firstGate.promise;
				} else if (toolCallCount === 2) {
					secondToolStarted.resolve();
					await secondGate.promise;
				}
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		session = buildSession(
			[
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "first" } }] },
				{ content: [{ type: "toolCall", name: "echo", arguments: { value: "second" } }] },
				{ content: ["steering answer"] },
			],
			blockingTool,
		);
		const observedScopes: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (
				(event.type === "agent_start" ||
					event.type === "turn_start" ||
					event.type === "turn_end" ||
					event.type === "agent_end") &&
				event.scope
			)
				observedScopes.push(`${event.type}:${event.scope.generation}`);
		});
		const promptDone = session.prompt("first task");
		await firstToolStarted.promise;
		firstGate.resolve();
		await secondToolStarted.promise;
		const submission = await session.submitUserMessage("same-run steer", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		secondGate.resolve();

		const execution = await submission.execution;
		if (execution.disposition === "removed") throw new Error("Expected same-run execution");
		expect(execution.disposition).toBe("joined-current-run");
		const terminalStatus = await Promise.race([
			submission.terminal.then(() => "settled" as const),
			Bun.sleep(5_000).then(() => "timeout" as const),
		]);
		expect(terminalStatus).toBe("settled");
		const terminal = await submission.terminal;
		expect(terminal).toMatchObject({
			submissionId: submission.submissionId,
			disposition: "completed",
		});
		if (terminal.disposition !== "completed") throw new Error("Expected completed terminal receipt");
		expect(observedScopes).toContain("turn_start:2");
		unsubscribe();
		await promptDone;
		await session.waitForIdle();
	});

	it("terminalizes a consumed tracked submission before disposal disconnects Agent events", async () => {
		const fixture = buildAbortableTrackedTransitionFixture();
		session = fixture.session;
		const promptDone = session.prompt("first task").catch(() => {});
		await fixture.firstToolStarted.promise;
		const submission = await session.submitUserMessage("same-run steer", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		fixture.firstGate.resolve();
		await expect(submission.execution).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "joined-current-run",
		});
		await fixture.secondToolStarted.promise;

		const dispose = session.dispose();
		await expect(submission.terminal).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "removed",
		});
		fixture.secondGate.resolve();
		await dispose;
		await promptDone;
	});

	it("terminalizes a consumed tracked submission before manual compaction disconnects Agent events", async () => {
		const fixture = buildAbortableTrackedTransitionFixture();
		session = fixture.session;
		const promptDone = session.prompt("first task").catch(() => {});
		await fixture.firstToolStarted.promise;
		const submission = await session.submitUserMessage("same-run steer", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		fixture.firstGate.resolve();
		await expect(submission.execution).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "joined-current-run",
		});
		await fixture.secondToolStarted.promise;

		const compaction = session.compact().catch(() => {});
		await expect(submission.terminal).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "removed",
		});
		fixture.secondGate.resolve();
		await compaction;
		await promptDone;
	});

	it("preserves a still-queued tracked steer through manual compaction", async () => {
		const sessionManager = SessionManager.inMemory();
		const history: Array<Parameters<SessionManager["appendMessage"]>[0]> = [
			{ role: "user", content: "old context ".repeat(100), timestamp: 1 },
			{ role: "user", content: "recent context", timestamp: 2 },
		];
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_compact"),
			hasToolResultMediation: vi.fn().mockReturnValue(false),
			emitBeforeAgentStart: vi.fn().mockImplementation(async () => {
				return { messages: [] };
			}),
			emit: vi.fn().mockImplementation(async (event: unknown) => {
				const preparation = (event as { preparation?: { firstKeptEntryId: string; tokensBefore: number } })
					.preparation;
				if (!preparation) return undefined;
				return {
					compaction: {
						summary: "compacted summary",
						shortSummary: "compacted",
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: {},
					},
				};
			}),
		};
		const fixture = buildAbortableTrackedTransitionFixture(sessionManager, extensionRunner, true);
		session = fixture.session;
		for (const message of history) sessionManager.appendMessage(message);
		session.settings.override("compaction.keepRecentTokens", 1);

		const promptDone = session.prompt("first task").catch(() => {});
		await withTimeout(fixture.firstToolStarted.promise, 5_000, "compaction queued test first tool");
		const submission = await session.submitUserMessage("queued through compact", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		expect(session.agent.snapshotSteering()).toHaveLength(1);

		const compaction = session.compact();
		await Bun.sleep(1);
		fixture.firstGate.resolve();
		await expect(withTimeout(compaction, 5_000, "compaction queued test compact")).resolves.toMatchObject({
			summary: "compacted summary",
		});
		expect(session.messages.some(message => message.role === "compactionSummary")).toBe(true);
		await expect(withTimeout(submission.execution, 5_000, "compaction queued test execution")).resolves.toMatchObject(
			{
				submissionId: submission.submissionId,
				disposition: "promoted-to-run",
			},
		);
		fixture.secondGate.resolve();
		await expect(withTimeout(submission.terminal, 5_000, "compaction queued test terminal")).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "completed",
		});
		await promptDone;
	});

	it("restores queued tracked steering when compaction abort fails", async () => {
		const fixture = buildAbortableTrackedTransitionFixture(undefined, undefined, true);
		session = fixture.session;
		const activeSession = session;
		const promptDone = session.prompt("first task").catch(() => {});
		await withTimeout(fixture.firstToolStarted.promise, 5_000, "compaction abort-error test first tool");
		const submission = await session.submitUserMessage("restore after abort error", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		expect(session.agent.snapshotSteering()).toHaveLength(1);
		expect(
			session.getQueuedMessageEntries().filter(entry => entry.text === "restore after abort error"),
		).toHaveLength(1);
		vi.spyOn(activeSession, "abort").mockImplementationOnce(async () => {
			activeSession.agent.clearSteeringQueue();
			throw new Error("synthetic compaction abort failure");
		});

		await expect(session.compact()).rejects.toThrow("synthetic compaction abort failure");
		expect(session.agent.snapshotSteering()).toHaveLength(1);
		expect(
			session.getQueuedMessageEntries().filter(entry => entry.text === "restore after abort error"),
		).toHaveLength(1);
		expect(submission.cancel()).toBe(true);
		await expect(submission.terminal).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "cancelled",
		});
		fixture.firstGate.resolve();
		await withTimeout(fixture.secondToolStarted.promise, 5_000, "compaction abort-error test second tool");
		fixture.secondGate.resolve();
		await promptDone;
	});

	it("releases deferred tracked follow-ups after manual compaction", async () => {
		const sessionManager = SessionManager.inMemory();
		const history: Array<Parameters<SessionManager["appendMessage"]>[0]> = [
			{ role: "user", content: "old context ".repeat(100), timestamp: 1 },
			{ role: "user", content: "recent context", timestamp: 2 },
		];
		for (const message of history) sessionManager.appendMessage(message);
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_compact"),
			hasToolResultMediation: vi.fn().mockReturnValue(false),
			emitBeforeAgentStart: vi.fn().mockResolvedValue({ messages: [] }),
			emit: vi.fn().mockImplementation(async (event: unknown) => {
				const preparation = (event as { preparation?: { firstKeptEntryId: string; tokensBefore: number } })
					.preparation;
				if (!preparation) return undefined;
				return {
					compaction: {
						summary: "compacted summary",
						shortSummary: "compacted",
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: {},
					},
				};
			}),
		};
		const fixture = buildAbortableTrackedTransitionFixture(sessionManager, extensionRunner, true);
		session = fixture.session;
		session.settings.override("compaction.keepRecentTokens", 1);
		const promptDone = session.prompt("first task").catch(() => {});
		await withTimeout(fixture.firstToolStarted.promise, 5_000, "deferred compaction test first tool");
		const submission = await session.submitUserMessage("deferred through compact", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("deferred-compaction-token"),
		} as never);
		expect(session.agent.snapshotFollowUp()).toHaveLength(0);

		const compaction = session.compact();
		await expect(withTimeout(compaction, 5_000, "deferred compaction test compact")).resolves.toMatchObject({
			summary: "compacted summary",
		});
		await expect(
			withTimeout(submission.execution, 5_000, "deferred compaction test execution"),
		).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "promoted-to-run",
		});
		await withTimeout(fixture.secondToolStarted.promise, 5_000, "deferred compaction test second tool");
		fixture.secondGate.resolve();
		await expect(withTimeout(submission.terminal, 5_000, "deferred compaction test terminal")).resolves.toMatchObject(
			{
				submissionId: submission.submissionId,
				disposition: "completed",
			},
		);
		await promptDone;
	});

	it("keeps sequential steering policy across manual compaction", async () => {
		const sessionManager = SessionManager.inMemory();
		for (const message of [
			{ role: "user" as const, content: "old context ".repeat(100), timestamp: 1 },
			{ role: "user" as const, content: "recent context", timestamp: 2 },
		])
			sessionManager.appendMessage(message);
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_compact"),
			hasToolResultMediation: vi.fn().mockReturnValue(false),
			emitBeforeAgentStart: vi.fn().mockResolvedValue({ messages: [] }),
			emit: vi.fn().mockImplementation(async (event: unknown) => {
				const preparation = (event as { preparation?: { firstKeptEntryId: string; tokensBefore: number } })
					.preparation;
				if (!preparation) return undefined;
				return {
					compaction: {
						summary: "compacted summary",
						shortSummary: "compacted",
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: {},
					},
				};
			}),
		};
		const fixture = buildAbortableTrackedTransitionFixture(sessionManager, extensionRunner, true);
		session = fixture.session;
		session.settings.override("compaction.keepRecentTokens", 1);
		const promptDone = session.prompt("first task").catch(() => {});
		await withTimeout(fixture.firstToolStarted.promise, 5_000, "sequential compaction test first tool");
		const first = await session.submitUserMessage("sequential compact one", {
			deliverAs: "steer",
			trackSubmission: true,
			queuePolicy: "sequential",
		});
		const second = await session.submitUserMessage("sequential compact two", {
			deliverAs: "steer",
			trackSubmission: true,
			queuePolicy: "sequential",
		});
		expect(session.agent.snapshotSteering()).toHaveLength(2);

		await expect(withTimeout(session.compact(), 5_000, "sequential compaction test compact")).resolves.toMatchObject({
			summary: "compacted summary",
		});
		await expect(withTimeout(first.execution, 5_000, "sequential compaction first execution")).resolves.toMatchObject(
			{
				submissionId: first.submissionId,
				disposition: "promoted-to-run",
			},
		);
		expect(await Promise.race([second.execution.then(() => "settled"), Bun.sleep(20).then(() => "pending")])).toBe(
			"pending",
		);
		await withTimeout(fixture.secondToolStarted.promise, 5_000, "sequential compaction test second tool");
		fixture.secondGate.resolve();
		await expect(withTimeout(first.terminal, 5_000, "sequential compaction first terminal")).resolves.toMatchObject({
			submissionId: first.submissionId,
			disposition: "completed",
		});
		await expect(
			withTimeout(second.execution, 5_000, "sequential compaction second execution"),
		).resolves.toMatchObject({
			submissionId: second.submissionId,
			disposition: "joined-current-run",
		});
		await expect(withTimeout(second.terminal, 5_000, "sequential compaction second terminal")).resolves.toMatchObject(
			{
				submissionId: second.submissionId,
				disposition: "completed",
			},
		);
		await promptDone;
	});

	it("rejects tracked preflight that crosses a session transition", async () => {
		const fixture = buildAbortableTrackedTransitionFixture(undefined, undefined, true);
		session = fixture.session;
		const promptDone = session.prompt("first task").catch(() => {});
		await withTimeout(fixture.firstToolStarted.promise, 5_000, "transition admission test first tool");
		const preflightEntered = Promise.withResolvers<void>();
		const releasePreflight = Promise.withResolvers<void>();
		const submission = session.submitUserMessage("must not cross transition", {
			deliverAs: "followUp",
			trackSubmission: true,
			onPreflightAcceptCommit: async () => {
				preflightEntered.resolve();
				await releasePreflight.promise;
			},
		} as never);
		await preflightEntered.promise;
		const compaction = session.compact().catch(() => undefined);
		await expect(session.prompt("ordinary prompt during compaction")).rejects.toMatchObject({ code: "busy" });
		releasePreflight.resolve();
		await expect(submission).rejects.toMatchObject({ code: "busy" });
		await compaction;
		fixture.firstGate.resolve();
		fixture.secondGate.resolve();
		await promptDone;
	});

	it("removes tracked queue state when post-admission callback fails", async () => {
		session = buildAbortableTrackedTransitionFixture().session;
		await expect(
			session.submitUserMessage("callback failure", {
				deliverAs: "followUp",
				trackSubmission: true,
				onPreflightAccepted: () => {
					throw new Error("synthetic post-admission failure");
				},
			} as never),
		).rejects.toThrow("synthetic post-admission failure");
		expect(session.agent.snapshotQueues()).toEqual({ steering: [], followUp: [] });
		expect(session.getQueuedMessageEntries()).toEqual([]);
	});

	it("isolates a throwing promotion callback after tracked settlement", async () => {
		session = buildSession([{ content: ["initial answer"] }, { content: ["follow-up answer"] }], {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.value }] };
			},
		});
		await session.prompt("initial prompt");
		const submission = await session.submitUserMessage("throwing promotion callback", {
			deliverAs: "followUp",
			trackSubmission: true,
			onQueuedPromoted: () => {
				throw new Error("synthetic promotion callback failure");
			},
		});
		await expect(submission.execution).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "promoted-to-run",
		});
		await expect(submission.terminal).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "completed",
		});
	});

	it("terminalizes a consumed tracked submission during session replacement", async () => {
		const fixture = buildAbortableTrackedTransitionFixture();
		session = fixture.session;
		const promptDone = session.prompt("first task").catch(() => {});
		await fixture.firstToolStarted.promise;
		const submission = await session.submitUserMessage("same-run steer", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		fixture.firstGate.resolve();
		await expect(submission.execution).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "joined-current-run",
		});
		await fixture.secondToolStarted.promise;

		const replacement = session.newSession();
		await expect(submission.terminal).resolves.toMatchObject({
			submissionId: submission.submissionId,
			disposition: "removed",
			reason: "removed",
		});
		fixture.secondGate.resolve();
		await expect(replacement).resolves.toBe(true);
		await promptDone;
	});

	it("drops queued and consumed tracked submissions at the committed fork boundary", async () => {
		const fixture = buildAbortableTrackedTransitionFixture(SessionManager.create(tempDir.path(), tempDir.path()));
		session = fixture.session;
		const previousSessionId = session.sessionId;
		const promptDone = session.prompt("first task").catch(() => {});
		await fixture.firstToolStarted.promise;
		const consumed = await session.submitUserMessage("same-run steer", {
			deliverAs: "steer",
			trackSubmission: true,
		});
		fixture.firstGate.resolve();
		await expect(consumed.execution).resolves.toMatchObject({
			submissionId: consumed.submissionId,
			disposition: "joined-current-run",
		});
		await fixture.secondToolStarted.promise;
		const queued = await session.submitUserMessage("deferred follow-up", {
			deliverAs: "followUp",
			trackSubmission: true,
			sdkRunCapability: createSdkRunCapability("fork-deferred-follow-up"),
		} as never);
		expect(session.agent.snapshotFollowUp()).toHaveLength(0);

		const fork = session.fork();
		await expect(consumed.terminal).resolves.toMatchObject({
			submissionId: consumed.submissionId,
			disposition: "removed",
			reason: "removed",
		});
		await expect(queued.terminal).resolves.toMatchObject({
			submissionId: queued.submissionId,
			disposition: "removed",
			reason: "removed",
		});
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.getQueuedMessageEntries()).toHaveLength(0);
		fixture.secondGate.resolve();
		await expect(fork).resolves.toBe(true);
		expect(session.sessionId).not.toBe(previousSessionId);
		await promptDone;
	});

	it("rejects invalid tracked submission options before dispatch", async () => {
		session = buildSession([{ content: ["must not dispatch"] }], {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: echoSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed: ${params.value}` }] };
			},
		});
		const invalidOptions: unknown[] = [
			undefined,
			{ deliverAs: "followUp" },
			{ deliverAs: "followUp", trackSubmission: false },
			{ deliverAs: "unsupported", trackSubmission: true },
			{ deliverAs: "followUp", trackSubmission: true, queuePolicy: "bogus" },
		];
		for (const options of invalidOptions) {
			await expect(session.submitUserMessage("invalid options", options as never)).rejects.toMatchObject({
				code: "invalid_input",
			});
			expect(session.agent.hasQueuedMessages()).toBe(false);
			expect(session.agent.state.messages).toHaveLength(0);
			expect(session.isStreaming).toBe(false);
		}
		await expect(
			session.sendUserMessage("legacy invalid queue policy", {
				deliverAs: "followUp",
				queuePolicy: "bogus",
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.state.messages).toHaveLength(0);
		expect(session.isStreaming).toBe(false);
		await expect(
			session.sendUserMessage("legacy tracked input", {
				deliverAs: "followUp",
				trackSubmission: true,
			} as never),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.state.messages).toHaveLength(0);
		expect(session.isStreaming).toBe(false);
	});
});
