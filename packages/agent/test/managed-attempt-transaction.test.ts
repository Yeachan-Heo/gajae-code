import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ManagedAttemptOutcome } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import {
	agentLoopContinue,
	managedAssistantEventSnapshot,
	sanitizedDetachedClone,
} from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "@gajae-code/agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Message } from "@gajae-code/ai";

import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { logger } from "@gajae-code/utils";

/**
 * Capture the bounded local-failure diagnostics emitted for one run. Returns
 * only the diagnostic payloads for `agent: managed fallback attempt rejected a
 * local snapshot`, so assertions can prove shape-only fields are present and
 * content-bearing fields are absent.
 */
function captureSnapshotDiagnostics(): Record<string, unknown>[] {
	const captured: Record<string, unknown>[] = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, payload?: unknown) => {
		if (message === "agent: managed fallback attempt rejected a local snapshot") {
			captured.push((payload ?? {}) as Record<string, unknown>);
		}
	});
	return captured;
}

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

class JsonSafeBigIntEnvelope {
	sequence = 1n;

	toJSON(): { sequence: string } {
		return { sequence: this.sequence.toString() };
	}
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
	afterEach(() => {
		vi.restoreAllMocks();
	});

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

	it("publishes JSON-serializable snapshots when structuredClone removes a payload class serializer", async () => {
		const mock = createMockModel();
		const liveEnvelope = new JsonSafeBigIntEnvelope();
		const callbackValues: Array<{ path: string; value: unknown }> = [];
		const publicValues: Array<{ path: string; value: unknown }> = [];
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).providerPayload = {
					envelope: liveEnvelope,
				};
				stream.push({ type: "start", partial });
				partial.content.push({ type: "text", text: "accepted" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
			onAssistantMessageEvent: (message, event) => {
				callbackValues.push({ path: `callback.${event.type}.message`, value: message });
				callbackValues.push({ path: `callback.${event.type}.event`, value: event });
			},
		});
		agent.subscribe(event => publicValues.push({ path: `public.${event.type}`, value: event }));

		await agent.prompt("run", { fallbackManaged: true });
		liveEnvelope.sequence = 2n;

		const failures = [...callbackValues, ...publicValues].flatMap(candidate => {
			try {
				JSON.stringify(candidate.value);
				return [];
			} catch {
				return [
					{
						path: `${candidate.path}.providerPayload.envelope.sequence`,
						valueClass: JsonSafeBigIntEnvelope.name,
						valueType: "bigint",
					},
				];
			}
		});
		expect(failures).toEqual([]);
		const callbackMessage = callbackValues.find(candidate => candidate.path === "callback.text_start.message")!
			.value as Record<string, unknown>;
		const callbackEvent = callbackValues.find(candidate => candidate.path === "callback.text_start.event")!
			.value as Extract<AssistantMessageEvent, { type: "text_start" }>;
		const turnEnd = publicValues.find(candidate => candidate.path === "public.turn_end")!.value as Extract<
			AgentEvent,
			{ type: "turn_end" }
		>;
		const agentEnd = publicValues.find(candidate => candidate.path === "public.agent_end")!.value as Extract<
			AgentEvent,
			{ type: "agent_end" }
		>;
		const agentEndAssistant = agentEnd.messages.find(message => message.role === "assistant");
		const sequence = (value: unknown): unknown => {
			if (value === null || typeof value !== "object") return undefined;
			const providerPayload = (value as Record<string, unknown>).providerPayload;
			if (providerPayload === null || typeof providerPayload !== "object") return undefined;
			const envelope = (providerPayload as Record<string, unknown>).envelope;
			return envelope !== null && typeof envelope === "object"
				? (envelope as Record<string, unknown>).sequence
				: undefined;
		};
		expect([
			sequence(callbackMessage),
			sequence(callbackEvent.partial),
			sequence(turnEnd.message),
			sequence(agentEndAssistant),
		]).toEqual(["1", "1", "1", "1"]);
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

	it("clears managed ownership before terminal observers run", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: async () => {
				throw Object.assign(new Error(""), {
					transportFailure: { kind: "transport", status: 400, openaiErrorCode: "context_length_exceeded" },
				});
			},
		});
		let ownerBeforeTerminal: number | undefined;
		let ownerAtMessageEnd: number | undefined;
		let ownerAtAgentEnd: number | undefined;
		agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				ownerAtMessageEnd = agent.currentManagedLogicalRunId;
			}
			if (event.type === "agent_end") {
				ownerAtAgentEnd = agent.currentManagedLogicalRunId;
			}
		});

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				if (outcome.type !== "context_overflow_discarded") {
					throw new Error(`Expected discarded overflow, received ${outcome.type}`);
				}
				return {
					type: "maintenance",
					continuation: ownership => {
						ownerBeforeTerminal = agent.currentManagedLogicalRunId;
						agent.requestRunTerminal(ownership.logicalRunId, {
							stopReason: "error",
							messages: [outcome.message],
						});
					},
				};
			},
		});

		expect(ownerBeforeTerminal).toBeDefined();
		expect(ownerAtMessageEnd).toBeUndefined();
		expect(ownerAtAgentEnd).toBeUndefined();
		expect(agent.currentManagedLogicalRunId).toBeUndefined();
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
		const diagnostics = captureSnapshotDiagnostics();
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
		expect((agent.state.messages.at(-1) as AssistantMessage).errorKind).toBe("local_buffer_overflow");
		expect(witnessReads).toBe(1);
		// One bounded diagnostic per stream invocation, shape-only.
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			errorKind: "local_buffer_overflow",
			model: mock.model.id,
			provider: mock.model.provider,
			snapshotMode: "managed",
		});
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

	it("fails a collapsed root proxy locally and reports a bounded shape-only diagnostic", async () => {
		const diagnostics = captureSnapshotDiagnostics();
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
		expect((agent.state.messages.at(-1) as AssistantMessage).errorKind).toBe("local_snapshot_failure");
		expect(agent.state.messages.filter(message => message.role === "assistant")).toHaveLength(1);
		// The diagnostic names the exact failing site and carries shape only:
		// no raw text, thinking, tool arguments, or provider payload content.
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			stage: "shell.role",
			errorKind: "local_snapshot_failure",
			model: mock.model.id,
			provider: mock.model.provider,
			snapshotMode: "managed",
		});
		expect(typeof diagnostics[0].stagedEventCount).toBe("number");
		expect(typeof diagnostics[0].stagedBytes).toBe("number");
		expect(Object.keys(diagnostics[0]).sort()).toEqual([
			"errorKind",
			"model",
			"provider",
			"snapshotMode",
			"stage",
			"stagedBytes",
			"stagedEventCount",
		]);
	});
	it("names the content stage and its block count when the assistant content shape is rejected", async () => {
		const diagnostics = captureSnapshotDiagnostics();
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					// A non-array `content` cannot be normalized into the managed
					// assistant shell, so staging rejects it at the content stage.
					const malformed = assistantMessage(mock.model) as unknown as { content: unknown };
					malformed.content = { 0: { type: "text", text: "not an array" } };
					stream.push({ type: "start", partial: malformed as unknown as AssistantMessage });
				});
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
		expect((agent.state.messages.at(-1) as AssistantMessage).errorKind).toBe("local_snapshot_failure");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ stage: "shell.content", errorKind: "local_snapshot_failure" });
		expect(typeof diagnostics[0].contentBlockCount).toBe("number");
	});
	it("keeps sanitizer-sentinel content fail-closed instead of degrading it to an empty turn", async () => {
		const diagnostics = captureSnapshotDiagnostics();
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					// A proxy-wrapped content array makes the whole-message
					// structuredClone fail, so the sanitizer replaces the content
					// node with the "[unserializable]" sentinel string. That
					// sentinel must never be mistaken for benign provider string
					// content: degrading it to content: [] would silently drop the
					// (possibly tool-call-bearing) payload behind a successful
					// empty turn. It stays a local snapshot failure at the content
					// stage.
					const malformed = assistantMessage(mock.model) as unknown as { content: unknown };
					malformed.content = new Proxy([{ type: "text", text: "hidden payload" }], {});
					stream.push({ type: "start", partial: malformed as unknown as AssistantMessage });
				});
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
		expect((agent.state.messages.at(-1) as AssistantMessage).errorKind).toBe("local_snapshot_failure");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ stage: "shell.content", errorKind: "local_snapshot_failure" });
	});
	it("ignores a foreign error that self-labels a local failure kind", async () => {
		const diagnostics = captureSnapshotDiagnostics();
		const mock = createMockModel();
		const marker = "SECRET-PROMPT-MATERIAL-do-not-log";
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				// A stream-side error that claims a local failure kind and tries to
				// smuggle content through `stage`. Only the module-private local
				// error identities may reach the diagnostic, so this logs nothing.
				const forged = Object.assign(new Error("forged local failure"), {
					errorKind: "local_snapshot_failure",
					stage: marker,
				});
				throw forged;
			},
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(agent.state.error).toContain("forged local failure");
		expect(diagnostics).toHaveLength(0);
		expect(JSON.stringify(diagnostics)).not.toContain(marker);
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

	it("preserves reasoning summary events through managed replay", async () => {
		const mock = createMockModel();
		const callbacks: AssistantMessageEvent[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					partial.content.push({ type: "thinking", thinking: "safe summary" });
					stream.push({ type: "start", partial });
					stream.push({ type: "reasoning_summary_start", contentIndex: 0, partial });
					stream.push({
						type: "reasoning_summary_delta",
						contentIndex: 0,
						delta: "safe summary",
						partial,
					});
					stream.push({
						type: "reasoning_summary_end",
						contentIndex: 0,
						content: "safe summary",
						partial,
					});
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
			onAssistantMessageEvent: (_message, event) => callbacks.push(event),
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(agent.state.error).toBeUndefined();
		expect(callbacks.map(event => event.type)).toEqual([
			"reasoning_summary_start",
			"reasoning_summary_delta",
			"reasoning_summary_end",
		]);
		expect(callbacks[0]).toMatchObject({ type: "reasoning_summary_start", contentIndex: 0 });
		expect(callbacks[1]).toMatchObject({
			type: "reasoning_summary_delta",
			contentIndex: 0,
			delta: "safe summary",
		});
		expect(callbacks[2]).toMatchObject({
			type: "reasoning_summary_end",
			contentIndex: 0,
			content: "safe summary",
		});
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "thinking", thinking: "safe summary" }],
		});
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

describe("managed snapshot benign degradation (PR #4538 salvage)", () => {
	it("degrades non-array content to an empty content array instead of killing the run", async () => {
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				stream.push({ type: "done", reason: "stop", message: { ...partial, content: "raw string" as never } });
			});
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "run", timestamp: Date.now() }],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => messages as Message[],
			fallbackManaged: true,
		};
		const stream = agentLoopContinue(context, config, undefined, streamFn);
		for await (const _event of stream) void _event;
		const result = await stream.result();
		expect(result).toHaveLength(1);
		const committed = result[0] as AssistantMessage;
		expect(committed.role).toBe("assistant");
		expect(committed.content).toEqual([]);
		expect(committed.stopReason).toBe("stop");
	});

	it("degrades a missing content array the same way as a non-array content value", async () => {
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				const noContent = { ...partial } as { content?: unknown };
				delete noContent.content;
				stream.push({ type: "done", reason: "stop", message: noContent as unknown as AssistantMessage });
			});
			return stream;
		};
		const context: AgentContext = {
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "run", timestamp: Date.now() }],
			tools: [],
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => messages as Message[],
			fallbackManaged: true,
		};
		const stream = agentLoopContinue(context, config, undefined, streamFn);
		for await (const _event of stream) void _event;
		const result = await stream.result();
		expect(result).toHaveLength(1);
		expect((result[0] as AssistantMessage).content).toEqual([]);
	});

	it("degrades unknown event reasons to schema-valid values in staged snapshots", async () => {
		// managedAssistantEventSnapshot is the managed-snapshot contract for
		// staged assistant message events. An unknown done/error reason or
		// unknown string type must degrade to a schema-valid value rather than
		// throw, matching the closed StopReason vocabulary already normalized
		// by managedAssistantShell.
		const mock = createMockModel();
		const callbacks: AssistantMessageEvent[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					// A text_delta that carries a valid-looking shape is the
					// reachable staged-snapshot path. This confirms the benign
					// proxy-wrapped event degrades cleanly through the snapshot.
					stream.push(
						new Proxy(
							{ type: "text_delta" as const, contentIndex: 0, delta: "x", partial },
							{},
						) as AssistantMessageEvent,
					);
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
			onAssistantMessageEvent: (_message, event) => callbacks.push(event),
		});
		await agent.prompt("run", { fallbackManaged: true });
		expect(agent.state.error).toBeUndefined();
		const deltas = callbacks.filter(event => event.type === "text_delta");
		expect(deltas).toHaveLength(1);
		expect(deltas[0]).toMatchObject({ type: "text_delta", delta: "x" });
	});

	it("normalizes malformed terminal and unknown-typed events at the staged snapshot boundary", () => {
		// Terminal done/error events are consumed by streamAssistantResponse
		// before the staged-event callback fires, so the normalization contract
		// is asserted directly on managedAssistantEventSnapshot — the exact
		// function the managed attempt transaction stages every assistant
		// message event through (#assistantEventSnapshot -> this function).
		// Unknown done/error reasons degrade into the closed vocabulary;
		// unknown STRING event types degrade to a terminal done/stop; a
		// non-string type stays fail-closed as malformed provider output.
		const mock = createMockModel();
		const message = assistantMessage(mock.model);

		const done = managedAssistantEventSnapshot(
			{ type: "done", reason: "out-of-vocabulary", message } as unknown as AssistantMessageEvent,
			message,
		);
		expect(done).toMatchObject({ type: "done", reason: "stop", message });

		const errored = managedAssistantEventSnapshot(
			{ type: "error", reason: "kaboom", error: message } as unknown as AssistantMessageEvent,
			message,
		);
		expect(errored).toMatchObject({ type: "error", reason: "error", error: message });

		const unknown = managedAssistantEventSnapshot(
			{ type: "totally-unknown-kind", message } as unknown as AssistantMessageEvent,
			message,
		);
		expect(unknown).toMatchObject({ type: "done", reason: "stop", message });

		let thrown: unknown;
		try {
			managedAssistantEventSnapshot({ type: 42, message } as unknown as AssistantMessageEvent, message);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).name).toBe("ManagedAttemptSnapshotError");
		expect((thrown as { errorKind?: string }).errorKind).toBe("local_snapshot_failure");
		expect((thrown as { stage?: string }).stage).toBe("event.unknownType");
	});

	it("keeps hostile collapsed-root-proxy events failing fast without managed retry authority", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push(
						new Proxy({ type: "text_delta", contentIndex: 0, delta: "x", partial } as AssistantMessageEvent, {
							get() {
								throw new Error("collapsed");
							},
						}) as AssistantMessageEvent,
					);
					stream.push({ type: "done", reason: "stop", message: partial });
				});
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
		expect(agent.state.error).toBeDefined();
	});

	it("keeps hostile getOwnPropertyDescriptor-trap events failing fast", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push(
						new Proxy({ type: "text_delta", contentIndex: 0, delta: "x", partial } as AssistantMessageEvent, {
							getOwnPropertyDescriptor() {
								throw new Error("hostile descriptor");
							},
						}) as AssistantMessageEvent,
					);
					stream.push({ type: "done", reason: "stop", message: partial });
				});
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
		expect(agent.state.error).toBeDefined();
	});

	it("keeps non-string event types failing fast as malformed provider output", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push(new Proxy({ type: 7, contentIndex: 0, partial } as unknown as AssistantMessageEvent, {}));
					stream.push({ type: "done", reason: "stop", message: partial });
				});
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
	});

	it("fails fast when a hostile role getter throws, without managed retry authority", async () => {
		// A live proxy whose role getter throws must fail the managed attempt
		// fast. managedProperty catches the throw and degrades to undefined,
		// so the role guard fails. The throw is contained — it never escapes
		// to stream.fail — but the run fails as a local snapshot error with
		// no transport facts and thus no retry authority.
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const hostile = new Proxy(assistantMessage(mock.model), {
						get(target, key) {
							if (key === "role") throw new Error("getter side effect");
							return Reflect.get(target, key);
						},
					});
					stream.push({ type: "done", reason: "stop", message: hostile });
				});
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
	});
});
