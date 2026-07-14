import { describe, expect, it } from "bun:test";
import type { ManagedAttemptOutcome } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";

function assistantMessage(model: ReturnType<typeof createMockModel>["model"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function expectManagedRunStart(events: string[]): void {
	expect(events.filter(type => type === "agent_start")).toHaveLength(1);
	const start = events.indexOf("agent_start");
	for (const lifecycleType of ["message_start", "turn_start", "agent_end"]) {
		const lifecycleIndex = events.indexOf(lifecycleType);
		if (lifecycleIndex >= 0) expect(start).toBeLessThan(lifecycleIndex);
	}
}

describe("managed attempt transaction", () => {
	it("flushes a successful assistant lifecycle once and in provider order", async () => {
		const mock = createMockModel({ responses: [{ content: ["accepted"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));

		await agent.prompt("run", { fallbackManaged: true });

		const assistantStart = events.lastIndexOf("message_start");
		const assistantBatch = events.slice(assistantStart);
		expect(assistantBatch[0]).toBe("message_start");
		expect(assistantBatch.filter(type => type === "message_update").length).toBeGreaterThan(0);
		expect(assistantBatch.slice(-3)).toEqual(["message_end", "turn_end", "agent_end"]);
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
		expectManagedRunStart(events);
	});

	it("replays mutating provider partials as event-time snapshots with callbacks first", async () => {
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				(partial.content[0] as { type: "text"; text: string }).text = "a";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial });
				await Bun.sleep(0);
				(partial.content[0] as { type: "text"; text: string }).text = "ab";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const order: string[] = [];
		const eventContents: string[] = [];
		const startContentLengths: number[] = [];
		const callbackContents: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
			onAssistantMessageEvent: (message, event) => {
				const text = (message.content[0] as { type: "text"; text: string } | undefined)?.text ?? "";
				callbackContents.push(text);
				order.push(`callback:${event.type}:${text}`);
			},
		});
		agent.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				startContentLengths.push(event.message.content.length);
				return;
			}
			if (event.type !== "message_update") return;
			const text =
				((event.message as AssistantMessage).content[0] as { type: "text"; text: string } | undefined)?.text ?? "";
			eventContents.push(text);
			order.push(`event:${event.assistantMessageEvent.type}:${text}`);
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(startContentLengths).toEqual([0]);
		expect(eventContents).toEqual(["", "a", "ab"]);
		expect(callbackContents).toEqual(["", "a", "ab"]);
		for (const [index, text] of ["", "a", "ab"].entries()) {
			expect(order.indexOf(`callback:${index === 0 ? "text_start" : "text_delta"}:${text}`)).toBeLessThan(
				order.indexOf(`event:${index === 0 ? "text_start" : "text_delta"}:${text}`),
			);
		}
	});

	it("discards a cancelled provisional assistant lifecycle and settles once", async () => {
		const mock = createMockModel();
		const pending = new AssistantMessageEventStream();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => pending,
		});
		const events: Array<{ type: string; stopReason?: string }> = [];
		agent.subscribe(event =>
			events.push({ type: event.type, stopReason: event.type === "agent_end" ? event.stopReason : undefined }),
		);

		const run = agent.prompt("run", { fallbackManaged: true });
		for (let i = 0; i < 20 && !agent.state.isStreaming; i += 1) await Bun.sleep(1);
		agent.abort();
		await run;

		expect(events.filter(event => event.type === "agent_end")).toEqual([
			{ type: "agent_end", stopReason: "cancelled" },
		]);
		expectManagedRunStart(events.map(event => event.type));
		expect(events.filter(event => event.type === "message_update")).toHaveLength(0);
		expect(events.filter(event => event.type === "turn_end")).toHaveLength(0);
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
		expect(agent.state.isStreaming).toBe(false);
	});

	it("keeps non-managed streaming behavior live", async () => {
		const mock = createMockModel({ responses: [{ content: ["live"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));

		await agent.prompt("run");

		expect(events).toContain("message_update");
		expect(events.at(-1)).toBe("agent_end");
	});

	it("discards retryable managed failures before any assistant lifecycle escapes", async () => {
		const mock = createMockModel();
		const streamFn = async () => {
			throw Object.assign(new Error("rate limit exceeded"), { status: 429 });
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const events: string[] = [];
		const outcomes: string[] = [];
		agent.subscribe(event => {
			if (
				event.type === "agent_end" ||
				event.type === "turn_end" ||
				("message" in event && event.message.role === "assistant")
			) {
				events.push(event.type);
			}
		});

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				outcomes.push(
					outcome.type === "retryable_discarded" ? (outcome.failure.message.errorMessage ?? "") : outcome.reason,
				);
				return { type: "retry", continuation: () => {} };
			},
		} as any);

		expect(outcomes).toEqual(["rate limit exceeded"]);
		expect(events).not.toContain("message_start");
		expect(events).not.toContain("message_update");
		expect(events).not.toContain("message_end");
		expect(events).not.toContain("turn_end");
		expect(events).not.toContain("agent_end");
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
	});

	it("discards an over-limit provisional batch and reports a retryable private outcome", async () => {
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(16 * 1024 * 1024 + 1) }],
					api: mock.model.api,
					provider: mock.model.provider,
					model: mock.model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const events: string[] = [];
		const outcomes: AssistantMessage[] = [];
		agent.subscribe(event => {
			if (
				event.type === "agent_end" ||
				event.type === "turn_end" ||
				("message" in event && event.message.role === "assistant")
			) {
				events.push(event.type);
			}
		});

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				if (outcome.type === "retryable_discarded") outcomes.push(outcome.failure.message);
				return { type: "retry", continuation: () => {} };
			},
		} as any);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ stopReason: "error", errorStatus: 503 });
		expect(outcomes[0]?.errorMessage).toContain("provisional event buffer limit");
		expect(events).not.toContain("message_start");
		expect(events).not.toContain("message_update");
		expect(events).not.toContain("message_end");
		expect(events).not.toContain("turn_end");
		expect(events).not.toContain("agent_end");
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
	});

	it("retains queued follow-up input when its managed attempt is discarded for retry", async () => {
		const mock = createMockModel({ responses: [{ content: ["initial"] }, { content: ["retried"] }] });
		let calls = 0;
		const queuedFollowUp = { role: "user" as const, content: "queued follow-up", timestamp: Date.now() };
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				calls += 1;
				if (calls === 2) throw Object.assign(new Error("limited"), { status: 429 });
				return mock.stream(...args);
			},
		});
		agent.followUp(queuedFollowUp);
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async (ownership: { isCurrent(): boolean }) => {
					if (ownership.isCurrent()) await agent.continue(options);
				},
			}),
		};

		await agent.prompt("run", options);

		expect(calls).toBe(3);
		expect(agent.state.messages).toContainEqual(queuedFollowUp);
		expect(
			agent.state.messages.filter(message => message.role === "assistant").map(message => message.content),
		).toHaveLength(2);
	});
});

describe("managed retry ownership", () => {
	it("publishes only the accepted attempt lifecycle after discarded retries", async () => {
		const mock = createMockModel({ responses: [{ content: ["accepted"] }] });
		let attempt = 0;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				attempt++;
				if (attempt < 3)
					throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
				return mock.stream(...args);
			},
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async (ownership: { isCurrent(): boolean }) => {
					if (ownership.isCurrent()) await agent.continue(options);
				},
			}),
		};

		await agent.prompt("run", options);

		expect(attempt).toBe(3);
		expect(events.filter(type => type === "agent_start")).toHaveLength(1);
		expect(events.filter(type => type === "turn_start")).toHaveLength(1);
		expectManagedRunStart(events);
	});

	it("dedupes a logical terminal request after an accepted retry", async () => {
		const mock = createMockModel({ responses: [{ content: ["accepted"] }] });
		let attempts = 0;
		let logicalRunId: number | undefined;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				attempts++;
				if (attempts === 1)
					throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
				return mock.stream(...args);
			},
		});
		const terminalEvents: Array<{ stopReason?: string }> = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") terminalEvents.push({ stopReason: event.stopReason });
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async (ownership: { isCurrent(): boolean }) => {
					logicalRunId = agent.currentManagedLogicalRunId;
					if (ownership.isCurrent()) await agent.continue(options);
				},
			}),
		};

		await agent.prompt("run", options);

		expect(attempts).toBe(2);
		expect(logicalRunId).toBeDefined();
		expect(agent.requestRunTerminal(logicalRunId!, { stopReason: "cancelled" })).toBeFalse();
		expect(terminalEvents).toEqual([{ stopReason: "completed" }]);
	});

	it("starts and settles a superseding managed prompt while a discarded retry continuation is pending", async () => {
		const mock = createMockModel({ responses: [{ content: ["accepted"] }] });
		let attempts = 0;
		const continuationStarted = Promise.withResolvers<void>();
		const rejectContinuation = Promise.withResolvers<void>();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				attempts++;
				if (attempts === 1)
					throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
				return mock.stream(...args);
			},
		});
		const terminalEvents: Array<{ type: "agent_start" | "agent_end"; stopReason?: string }> = [];
		agent.subscribe(event => {
			if (event.type === "agent_start" || event.type === "agent_end") {
				terminalEvents.push({
					type: event.type,
					...(event.type === "agent_end" && event.stopReason ? { stopReason: event.stopReason } : {}),
				});
			}
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async () => {
					continuationStarted.resolve();
					await rejectContinuation.promise;
				},
			}),
		};

		const firstRun = agent.prompt("first", options);
		await continuationStarted.promise;
		await agent.prompt("second", options);
		rejectContinuation.reject(new Error("displaced retry failed"));
		await firstRun;

		expect(terminalEvents).toEqual([
			{ type: "agent_start" },
			{ type: "agent_end", stopReason: "cancelled" },
			{ type: "agent_start" },
			{ type: "agent_end", stopReason: "completed" },
		]);
	});

	it("does not terminalize a displaced continuation after its run id is evicted", async () => {
		const mock = createMockModel({ responses: Array.from({ length: 257 }, () => ({ content: ["accepted"] })) });
		let attempts = 0;
		const continuationStarted = Promise.withResolvers<void>();
		const rejectContinuation = Promise.withResolvers<void>();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				attempts++;
				if (attempts === 1)
					throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
				return mock.stream(...args);
			},
		});
		const ends: Array<{ stopReason?: string }> = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") ends.push({ stopReason: event.stopReason });
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry" as const,
				continuation: async () => {
					continuationStarted.resolve();
					await rejectContinuation.promise;
				},
			}),
		};

		const firstRun = agent.prompt("first", options);
		await continuationStarted.promise;
		for (let i = 0; i < 257; i++) await agent.prompt(`superseding ${i}`, options);
		const endsBeforeRejection = ends.length;
		expect(endsBeforeRejection).toBe(258);

		rejectContinuation.reject(new Error("displaced retry failed"));
		await firstRun;

		expect(ends).toHaveLength(endsBeforeRejection);
		expect(agent.state.error).toBeUndefined();
	});

	it("passes provider-code transport facts and emits a run start before a simulated resolution-context terminal", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error("quota"), {
					transportFailure: {
						kind: "transport",
						providerCode: "insufficient_quota",
						headers: { "retry-after": "2" },
					},
				});
			},
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));
		let facts: unknown;
		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				if (outcome.type === "retryable_discarded") facts = outcome.failure.transportFailure;
				return { type: "terminal", terminal: { stopReason: "exhausted" } };
			},
		});
		expect(facts).toEqual({ kind: "transport", providerCode: "insufficient_quota", headers: { "retry-after": "2" } });
		expectManagedRunStart(events);
	});

	it("suppresses a force-aborted continuation and settles a throwing continuation once", async () => {
		const mock = createMockModel();
		let continued = 0;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
			},
		});
		const ends: string[] = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") ends.push(event.type);
		});
		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				agent.forceAbort();
				return {
					type: "retry",
					continuation: () => {
						continued++;
						throw new Error("must not run");
					},
				};
			},
		});
		await agent.waitForIdle();
		expect(continued).toBe(0);
		expect(ends).toHaveLength(1);
	});

	it("settles a rejected continuation with one terminal completion", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error("limited"), { transportFailure: { kind: "transport", status: 429 } });
			},
		});
		const ends: string[] = [];
		agent.subscribe(event => {
			if (event.type === "agent_end") ends.push(event.type);
		});
		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => ({
				type: "retry",
				continuation: async () => {
					throw new Error("retry failed");
				},
			}),
		});
		await agent.waitForIdle();
		expect(ends).toHaveLength(1);
	});
});

it("emits an exhaustion diagnostic lifecycle once before terminal completion", async () => {
	const mock = createMockModel();
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: async () => {
			throw Object.assign(new Error("overloaded"), { status: 503 });
		},
	});
	const events: string[] = [];
	agent.subscribe(event => events.push(event.type));
	const diagnostic = {
		...assistantMessage(mock.model),
		stopReason: "error" as const,
		errorMessage: "fallback chain exhausted",
	};

	await agent.prompt("run", {
		fallbackManaged: true,
		onManagedAttemptOutcome: () => ({
			type: "terminal",
			terminal: { stopReason: "exhausted", messages: [diagnostic] },
		}),
	});

	expect(events.filter(type => type === "agent_end")).toEqual(["agent_end"]);
	expect(events.slice(-3)).toEqual(["message_start", "message_end", "agent_end"]);
	expect(agent.state.messages).toContainEqual(diagnostic);
	expectManagedRunStart(events);
});
