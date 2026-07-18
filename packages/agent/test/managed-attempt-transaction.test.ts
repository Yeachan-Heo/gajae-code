import { describe, expect, it } from "bun:test";
import type { ManagedAttemptOutcome } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import { agentLoopContinue, sanitizedDetachedClone } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "@gajae-code/agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Message } from "@gajae-code/ai";

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

	it("commits a detached accepted message when a managed partial is not structured-cloneable", async () => {
		const mock = createMockModel();
		let liveMessage: AssistantMessage | undefined;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				liveMessage = partial;
				(partial as unknown as Record<string, unknown>).probe = () => {};
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "accepted" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "run", timestamp: Date.now() }],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages =>
				messages.filter(
					message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				) as Message[],
			fallbackManaged: true,
		};
		const stream = agentLoopContinue(context, config, undefined, streamFn);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const messageUpdate = events.find(
			(event): event is Extract<AgentEvent, { type: "message_update" }> => event.type === "message_update",
		);
		const messageEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "assistant",
		);
		const turnEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "turn_end" }> => event.type === "turn_end",
		);
		const agentEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "agent_end" }> => event.type === "agent_end",
		);
		const committed = context.messages.at(-1) as AssistantMessage;

		expect(messageUpdate).toBeDefined();
		expect(messageEnd).toBeDefined();
		expect(turnEnd).toBeDefined();
		expect(agentEnd).toBeDefined();
		expect(result).toHaveLength(1);
		const accepted = turnEnd!.message;
		expect(accepted).toBe(committed);
		expect(agentEnd!.messages[0]).toBe(accepted);
		expect(result[0]).toBe(accepted);
		expect(messageUpdate!.message).toEqual(accepted);
		expect(messageEnd!.message).toEqual(accepted);
		for (const message of [messageUpdate!.message, messageEnd!.message, accepted, agentEnd!.messages[0], result[0]]) {
			expect(() => structuredClone(message)).not.toThrow();
			expect(() => JSON.stringify(message)).not.toThrow();
			expect(message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "accepted" }] });
		}

		(liveMessage!.content[0] as { type: "text"; text: string }).text = "mutated after commit";
		(liveMessage as unknown as Record<string, unknown>).probe = () => "mutated";
		for (const message of [messageUpdate!.message, messageEnd!.message, accepted, agentEnd!.messages[0], result[0]]) {
			expect((message as AssistantMessage).content[0]).toEqual({ type: "text", text: "accepted" });
		}
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

	it("classifies an opaque typed OpenAI overflow as discarded maintenance without leaking a lifecycle", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error(""), {
					transportFailure: { kind: "transport", status: 400, openaiErrorCode: "context_length_exceeded" },
				});
			},
		});
		const events: AgentEvent[] = [];
		const outcomes: ManagedAttemptOutcome[] = [];
		let maintenanceRuns = 0;
		agent.subscribe(event => events.push(event));

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				outcomes.push(outcome);
				return {
					type: "maintenance",
					continuation: () => {
						maintenanceRuns += 1;
					},
				};
			},
		});

		expect(outcomes).toEqual([
			expect.objectContaining({
				type: "context_overflow_discarded",
				message: expect.objectContaining({ errorMessage: "" }),
			}),
		]);
		expect(maintenanceRuns).toBe(1);
		expect(
			events.filter(
				event =>
					event.type === "message_update" ||
					((event.type === "message_start" || event.type === "message_end") &&
						event.message.role === "assistant") ||
					event.type === "turn_end" ||
					event.type === "agent_end",
			),
		).toEqual([]);
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
	});

	it("discards retryable managed failures before any assistant lifecycle escapes", async () => {
		const mock = createMockModel();
		const streamFn = async () => {
			throw Object.assign(new Error("rate limit exceeded"), {
				transportFailure: { kind: "transport", status: 429 },
			});
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
					outcome.type === "run_terminal"
						? outcome.reason
						: outcome.type === "retryable_discarded"
							? (outcome.failure.message.errorMessage ?? "")
							: (outcome.message.errorMessage ?? ""),
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

	it("does not authorize managed fallback from raw status or hostile transport wrappers", async () => {
		const mock = createMockModel();
		const localFailure = Object.assign(new Error("local status only"), { status: 429 });
		Object.defineProperty(localFailure, "transportFailure", {
			get() {
				throw new Error("hostile transport getter");
			},
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw localFailure;
			},
		});
		let outcomeCalls = 0;

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomeCalls += 1;
				return { type: "retry", continuation: () => {} };
			},
		} as any);
		await agent.waitForIdle();

		expect(outcomeCalls).toBe(0);
		expect(agent.state.error).toContain("local status only");
		expect(agent.state.messages.find(message => message.role === "assistant")).toBeDefined();
	});

	it("stages a non-cloneable provider failure without masking it as a DataCloneError", async () => {
		// Regression: a provider error message whose payload is not
		// structured-cloneable (e.g. a live `Headers` in `transportFailure`)
		// must not turn into a local "The object can not be cloned." attempt
		// failure that hides the real provider outcome and burns the chain.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const failure: AssistantMessage = {
					...assistantMessage(mock.model),
					stopReason: "error",
					errorMessage: "rate limited",
					errorStatus: 429,
					transportFailure: {
						kind: "transport",
						status: 429,
						headers: new Headers({ "retry-after": "0" }) as unknown as Record<string, string>,
					},
				};
				stream.push({ type: "error", reason: "error", error: failure });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const outcomes: string[] = [];
		const facts: unknown[] = [];

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				outcomes.push(
					outcome.type === "run_terminal"
						? outcome.reason
						: outcome.type === "retryable_discarded"
							? (outcome.failure.message.errorMessage ?? "")
							: (outcome.message.errorMessage ?? ""),
				);
				if (outcome.type === "retryable_discarded") facts.push(outcome.failure.transportFailure);
				return { type: "terminal", terminal: { stopReason: "exhausted" } };
			},
		} as any);

		expect(outcomes).toEqual(["rate limited"]);
		// The outcome facts must be the normalized plain-record form (retry
		// delay survives; no live Headers escapes to the fallback controller).
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({ kind: "transport", status: 429 });
		expect((facts[0] as { headers?: unknown }).headers).toEqual({ "retry-after": "0" });
		expect(() => structuredClone(facts[0])).not.toThrow();
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(0);
	});

	it("keeps degraded snapshots event-time distinct when the partial is not structured-cloneable", async () => {
		// The provider mutates one partial in place while it also carries a
		// non-structured-cloneable leaf (a function). The sanitizing snapshot
		// fallback must still detach every staged value: replaying a live
		// reference would surface "ab" three times instead of "", "a", "ab".
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).probe = () => {};
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
		const eventContents: string[] = [];
		const callbackContents: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
			onAssistantMessageEvent: message => {
				callbackContents.push((message.content[0] as { type: "text"; text: string } | undefined)?.text ?? "");
			},
		});
		agent.subscribe(event => {
			if (event.type !== "message_update") return;
			eventContents.push(
				((event.message as AssistantMessage).content[0] as { type: "text"; text: string } | undefined)?.text ?? "",
			);
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(eventContents).toEqual(["", "a", "ab"]);
		expect(callbackContents).toEqual(["", "a", "ab"]);
	});

	it("stages a cyclic payload without converting it into an over-limit attempt failure", async () => {
		// structuredClone handles cycles, but JSON.stringify does not: the byte
		// accounting gate must fall back to a cycle-safe sanitized snapshot
		// instead of mislabeling the event as a retryable 503 buffer overflow.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				const cyclic: Record<string, unknown> = { note: "cyclic" };
				cyclic.self = cyclic;
				(partial as unknown as Record<string, unknown>).probe = cyclic;
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "accepted" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));

		await agent.prompt("run", { fallbackManaged: true });

		expect(events).toContain("message_end");
		expect(events.at(-1)).toBe("agent_end");
		expect(agent.state.error).toBeUndefined();
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	});

	it("defeats a payload-controlled array map override that returns the live array", async () => {
		// Adversarial regression: if the sanitizer dispatched through
		// `input.map`, this override would hand back the provider's live
		// array and later mutations would rewrite already-staged snapshots.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).probe = () => {};
				const content = partial.content as unknown[];
				Object.defineProperty(content, "map", { value: () => content });
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				(content[0] as { type: "text"; text: string }).text = "a";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "a", partial });
				await Bun.sleep(0);
				(content[0] as { type: "text"; text: string }).text = "ab";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "b", partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const eventContents: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		agent.subscribe(event => {
			if (event.type !== "message_update") return;
			eventContents.push(
				((event.message as AssistantMessage).content[0] as { type: "text"; text: string } | undefined)?.text ?? "",
			);
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(eventContents).toEqual(["", "a", "ab"]);
	});

	it("stages a cyclic array with a map override without throwing or masking the run", async () => {
		// Second adversarial mode: the override returns the same cyclic array,
		// so a map-dispatching sanitizer would re-produce the cycle and the
		// byte-accounting JSON.stringify would throw outside any catch.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).probe = () => {};
				const content = partial.content as unknown[];
				content.push({ type: "text", text: "accepted" });
				content.push(content);
				Object.defineProperty(content, "map", { value: () => content });
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const events: string[] = [];
		agent.subscribe(event => events.push(event.type));

		await agent.prompt("run", { fallbackManaged: true });

		expect(events).toContain("message_end");
		expect(events.at(-1)).toBe("agent_end");
		expect(agent.state.error).toBeUndefined();
	});

	it("replaces throwing accessors with a placeholder instead of invoking or failing", async () => {
		// The degraded snapshot must never invoke accessors (observable side
		// effects) nor let a throwing getter fail the attempt: the property is
		// replaced with "[accessor]" via descriptor inspection.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				const poisoned: Record<string, unknown> = {};
				Object.defineProperty(poisoned, "secret", {
					enumerable: true,
					get() {
						throw new Error("boom");
					},
				});
				(partial as unknown as Record<string, unknown>).probe = poisoned;
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "text", text: "accepted" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				await Bun.sleep(0);
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const replayedProbes: unknown[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		agent.subscribe(event => {
			if (event.type !== "message_update") return;
			replayedProbes.push(
				((event.message as unknown as Record<string, unknown>).probe as Record<string, unknown>).secret,
			);
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(replayedProbes.length).toBeGreaterThan(0);
		expect(replayedProbes.every(probe => probe === "[accessor]")).toBeTrue();
		expect(agent.state.error).toBeUndefined();
	});

	it("bounds sparse and length-poisoned arrays without densifying holes", () => {
		// A sparse array (or a huge `length` with one element) must not force
		// an allocation proportional to its declared length: the degraded
		// clone enumerates only present entries and degrades sparse arrays to
		// a record of their indices. A densifying implementation would blow
		// past this test's timeout allocating millions of slots.
		// (Direct unit test: at the transaction level a measurable sparse
		// event is rejected by the byte cap from its JSON size alone — the
		// same pre-clone measurement upstream always used — so the sanitizer's
		// shape guarantees are asserted on the exported function.)
		const sparse: unknown[] = [];
		sparse[9_999_999] = { note: "sparse-x" };
		const lengthPoisoned: unknown[] = [];
		lengthPoisoned.length = 10_000_000;
		lengthPoisoned[0] = () => {};

		const out = sanitizedDetachedClone({ sparse, lengthPoisoned }) as Record<string, unknown>;

		// Sparse array degrades to a record of present indices only.
		expect(out.sparse).toEqual({ "9999999": { note: "sparse-x" } } as never);
		// Length-poisoned array keeps only its single present element.
		expect(out.lengthPoisoned).toEqual(["[unserializable]"] as never);
		// The degraded form is JSON-safe and small — no hole densification.
		expect(JSON.stringify(out).length).toBeLessThan(200);
	});

	it("charges the budget for every enumerated key, including accessors and shared-object revisits", () => {
		// Round-4 counterexample: N references to one wide accessor-bearing
		// child. Without per-key debits, each revisit would emit its accessor
		// placeholders "for free" (accessors never enter walk()), allowing
		// ~N*M descriptor reads while consuming only ~N budget units.
		const child: Record<string, unknown> = {};
		for (let accessorIndex = 0; accessorIndex < 50; accessorIndex++) {
			Object.defineProperty(child, `accessor${accessorIndex}`, {
				enumerable: true,
				get() {
					throw new Error("must not be invoked");
				},
			});
		}
		const root: Record<string, unknown> = {};
		for (let refIndex = 0; refIndex < 50; refIndex++) root[`ref${refIndex}`] = child;

		const budget = 120;
		const out = sanitizedDetachedClone(root, budget) as Record<string, unknown>;

		// Output is detached, JSON-safe, and bounded by the budget.
		const serialized = JSON.stringify(out);
		expect(serialized.length).toBeGreaterThan(0);
		const accessorCount = serialized.split('"[accessor]"').length - 1;
		const truncatedCount = serialized.split('"[truncated]"').length - 1;
		expect(accessorCount).toBeLessThanOrEqual(budget);
		expect(accessorCount).toBeGreaterThan(0);
		expect(truncatedCount).toBeGreaterThan(0);
	});

	it("collapses proxies before any reflective enumeration", () => {
		let trapDispatches = 0;
		const hostileArrayProxy = new Proxy([] as unknown[], {
			ownKeys() {
				trapDispatches += 1;
				return ["2", "1", "length"];
			},
			getOwnPropertyDescriptor() {
				trapDispatches += 1;
				return { value: "x", enumerable: true, configurable: true };
			},
			get() {
				trapDispatches += 1;
				return 0;
			},
		});
		const { proxy: revoked, revoke } = Proxy.revocable({}, {});
		revoke();

		const out = sanitizedDetachedClone({ hostileArrayProxy, revoked, plain: { ok: true } }) as Record<
			string,
			unknown
		>;

		expect(out.hostileArrayProxy).toBe("[unserializable]");
		expect(out.revoked).toBe("[unserializable]");
		expect(out.plain).toEqual({ ok: true } as never);
		// No ownKeys/descriptor/get trap was ever dispatched.
		expect(trapDispatches).toBe(0);
	});

	it("never walks the prototype chain: a proxy prototype dispatches zero traps", () => {
		// `instanceof Date` would invoke a proxy prototype's getPrototypeOf
		// trap while walking the chain; the brand check must use the internal
		// slot (`util.types.isDate`) instead.
		let getPrototypeDispatches = 0;
		const hostilePrototype: object = new Proxy(
			{},
			{
				getPrototypeOf() {
					getPrototypeDispatches += 1;
					return null;
				},
			},
		);
		const ordinary = Object.create(hostilePrototype) as Record<string, unknown>;
		ordinary.ok = true;

		const out = sanitizedDetachedClone({ ordinary, when: new Date(1234567890) }) as Record<string, unknown>;

		expect(out.ordinary).toEqual({ ok: true } as never);
		expect(out.when).toEqual(new Date(1234567890));
		expect(getPrototypeDispatches).toBe(0);
	});

	it("rejects an oversized event before duplicating it with a snapshot", async () => {
		// The staged-byte cap exists to bound memory: an over-limit event must
		// be rejected from its measurement pass alone, WITHOUT first being
		// duplicated by structuredClone. The nested witness getter counts deep
		// reads: measurement reads it exactly once; a snapshot taken before
		// the cap check would read it a second time.
		const mock = createMockModel();
		let witnessReads = 0;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				partial.content.push({ type: "text", text: "x".repeat(16 * 1024 * 1024 + 1) });
				const witness: Record<string, unknown> = {};
				Object.defineProperty(witness, "read", {
					enumerable: true,
					get() {
						witnessReads += 1;
						return true;
					},
				});
				(partial as unknown as Record<string, unknown>).witness = witness;
				stream.push({ type: "start", partial });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		let outcomeCalls = 0;

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomeCalls += 1;
				return { type: "terminal", terminal: { stopReason: "exhausted" } };
			},
		} as any);
		await agent.waitForIdle();

		// Local overflow is not provider evidence: the fallback chain must not
		// be consumed, and the failure surfaces as an explicit local error.
		expect(outcomeCalls).toBe(0);
		expect(agent.state.error).toContain("provisional event buffer limit");
		expect(witnessReads).toBe(1);
	});

	it("fails an over-limit provisional batch as a local error without consuming the chain", async () => {
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
		let outcomeCalls = 0;
		const surfaced: AssistantMessage[] = [];
		agent.subscribe(event => {
			if (
				event.type === "agent_end" ||
				event.type === "turn_end" ||
				("message" in event && event.message.role === "assistant")
			) {
				events.push(event.type);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				surfaced.push(event.message as AssistantMessage);
			}
		});

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomeCalls += 1;
				return { type: "retry", continuation: () => {} };
			},
		} as any);
		await agent.waitForIdle();

		// Only original typed provider transport facts may authorize provider
		// fallback: the local buffer-limit error must not synthesize a
		// provider-like 503 and must not rotate/consume the chain. It surfaces
		// as an explicit local error message carrying no provider evidence,
		// and no provisional streamed content leaks (no message_update).
		expect(outcomeCalls).toBe(0);
		expect(agent.state.error).toContain("provisional event buffer limit");
		expect(events).not.toContain("message_update");
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]?.errorMessage).toContain("provisional event buffer limit");
		expect(surfaced[0]?.errorStatus).toBeUndefined();
		expect(surfaced[0]?.transportFailure).toBeUndefined();
	});

	it("retains queued follow-up input when its managed attempt is discarded for retry", async () => {
		const mock = createMockModel({ responses: [{ content: ["initial"] }, { content: ["retried"] }] });
		let calls = 0;
		const queuedFollowUp = { role: "user" as const, content: "queued follow-up", timestamp: Date.now() };
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				calls += 1;
				if (calls === 2)
					throw Object.assign(new Error("limited"), {
						transportFailure: { kind: "transport", status: 429 },
					});
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
	it("repairs a root-proxied managed assistant shell across published surfaces", async () => {
		const mock = createMockModel();
		let live: AssistantMessage | undefined;
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = assistantMessage(mock.model);
				message.content.push({ type: "text", text: "accepted" });
				live = new Proxy(message, {});
				stream.push({ type: "start", partial: live });
				stream.push({ type: "text_start", contentIndex: 0, partial: live });
				stream.push({ type: "done", reason: "stop", message: live });
			});
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "run", timestamp: Date.now() }],
			tools: [],
		};
		const callbacks: AssistantMessageEvent[] = [];
		const stream = agentLoopContinue(
			context,
			{
				model: mock.model,
				convertToLlm: messages => messages as Message[],
				fallbackManaged: true,
				onAssistantMessageEvent: (_message, event) => callbacks.push(event),
			},
			undefined,
			streamFn,
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		(live!.content[0] as { type: "text"; text: string }).text = "mutated";
		const messages = [
			context.messages.at(-1),
			result[0],
			...events.flatMap(event => {
				if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end")
					return [event.message];
				if (event.type === "message_update") return [event.message];
				if (event.type === "agent_end") return event.messages;
				return [];
			}),
		];
		for (const message of messages) {
			expect(message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "accepted" }] });
			expect(() => structuredClone(message)).not.toThrow();
		}
		expect(callbacks).toHaveLength(1);
		expect(callbacks[0]).toMatchObject({ type: "text_start", contentIndex: 0, partial: { role: "assistant" } });
	});

	it("fails a collapsed root proxy locally without managed retry authority", async () => {
		const mock = createMockModel();
		const collapsed = new Proxy(assistantMessage(mock.model), {
			get() {
				throw new Error("collapsed root");
			},
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "start", partial: collapsed }));
				return stream;
			},
		});
		let outcomes = 0;
		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: () => {
				outcomes += 1;
				return { type: "retry", continuation: () => {} };
			},
		});
		expect(outcomes).toBe(0);
		expect(agent.state.error).toContain("local snapshot");
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	});
	it("normalizes null and incomplete tool-call blocks before managed dispatch", async () => {
		const mock = createMockModel();
		const malformed = assistantMessage(mock.model) as unknown as { content: unknown[] };
		malformed.content = [null, { type: "toolCall", id: "call", name: "danger" }];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: malformed as AssistantMessage }));
				return stream;
			},
		});
		await agent.prompt("run", { fallbackManaged: true });
		const message = agent.state.messages.at(-1) as AssistantMessage;
		expect(message.content).toEqual([]);
	});

	it("preserves a complete detached toolcall_end event", async () => {
		const mock = createMockModel();
		const toolCall = {
			type: "toolCall" as const,
			id: "call",
			name: "safe",
			arguments: { value: 1 },
			thoughtSignature: "signature",
			intent: "inspect safely",
			customWireName: "custom_safe",
			incompleteArguments: true,
		};
		const callbacks: AssistantMessageEvent[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
			onAssistantMessageEvent: (_message, event) => callbacks.push(event),
		});
		await agent.prompt("run", { fallbackManaged: true });
		const ended = callbacks.find(event => event.type === "toolcall_end");
		expect(ended).toMatchObject({ toolCall });
		expect(ended).not.toBeUndefined();
		expect(ended?.type === "toolcall_end" ? ended.toolCall : undefined).toMatchObject({
			thoughtSignature: "signature",
			intent: "inspect safely",
			customWireName: "custom_safe",
			incompleteArguments: true,
		});
	});

	it("rejects managed events with hidden required fields as local failures", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push(
						new Proxy(
							{ type: "text_delta", contentIndex: 0, partial },
							{ get: (target, key) => (key === "delta" ? undefined : Reflect.get(target, key)) },
						) as AssistantMessageEvent,
					);
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
		});
		await agent.prompt("run", { fallbackManaged: true });
		expect(agent.state.error).toContain("local snapshot");
	});
	it("normalizes invalid stop reasons and rejects invalid event indices", async () => {
		const mock = createMockModel();
		const invalidMessage = {
			...assistantMessage(mock.model),
			stopReason: "invalid",
			timestamp: Number.POSITIVE_INFINITY,
			errorStatus: Number.NaN,
		} as unknown as AssistantMessage;
		const accepted = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: invalidMessage }));
				return stream;
			},
		});
		const published: AssistantMessage[] = [];
		accepted.subscribe(event => {
			if ((event.type === "message_end" || event.type === "turn_end") && event.message.role === "assistant")
				published.push(event.message as AssistantMessage);
			if (event.type === "agent_end") {
				published.push(...(event.messages.filter(message => message.role === "assistant") as AssistantMessage[]));
			}
		});
		await accepted.prompt("run", { fallbackManaged: true });
		const committed = accepted.state.messages.at(-1) as AssistantMessage;
		expect(committed.stopReason).toBe("stop");
		expect(Number.isFinite(committed.timestamp)).toBe(true);
		expect(committed.errorStatus).toBeUndefined();
		for (const message of published) {
			expect(["stop", "length", "toolUse", "error", "aborted"]).toContain(message.stopReason);
			expect(Number.isFinite(message.timestamp)).toBe(true);
			expect(message.errorStatus).toBeUndefined();
		}

		const rejected = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push({ type: "text_delta", contentIndex: -1, delta: "x", partial });
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
		});
		await rejected.prompt("run", { fallbackManaged: true });
		expect(rejected.state.error).toContain("local snapshot");
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

	it("preserves one managed logical lifecycle across maintenance continuation", async () => {
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "missing-tool", arguments: {} }] },
				{ content: ["accepted after maintenance"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		let maintenanceCalls = 0;
		agent.setMaintainContext(() => (maintenanceCalls++ === 0 ? "compacted" : "not-needed"));
		const events: Array<{ type: string; stopReason?: string }> = [];
		const resumed = Promise.withResolvers<void>();
		const options = { fallbackManaged: true } as const;
		agent.subscribe(event => {
			events.push({ type: event.type, stopReason: event.type === "agent_end" ? event.stopReason : undefined });
			if (event.type === "agent_end" && event.stopReason === "maintenance") {
				queueMicrotask(() => {
					void agent.continue(options).then(resumed.resolve, resumed.reject);
				});
			}
		});

		await agent.prompt("run", options);
		await resumed.promise;

		expect(events.filter(event => event.type === "agent_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end" && event.stopReason === "maintenance")).toHaveLength(1);
		expect(events.filter(event => event.type === "agent_end" && event.stopReason !== "maintenance")).toEqual([
			{ type: "agent_end", stopReason: "completed" },
		]);
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
			throw Object.assign(new Error("overloaded"), {
				transportFailure: { kind: "transport", status: 503 },
			});
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
