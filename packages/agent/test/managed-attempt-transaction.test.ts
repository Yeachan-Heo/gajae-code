import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ManagedAttemptOutcome } from "@gajae-code/agent-core";
import { Agent } from "@gajae-code/agent-core";
import {
	agentLoopContinue,
	MANAGED_ATTEMPT_MAX_STAGED_BYTES,
	MANAGED_ATTEMPT_MAX_STAGED_EVENTS,
	managedAssistantEventSnapshot,
	managedAttemptMaxStagedBytes,
	managedAttemptMaxStagedEvents,
	sanitizedDetachedClone,
} from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "@gajae-code/agent-core/types";
import type { AssistantMessage, AssistantMessageEvent, Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { attachUnicodeEscapeEvidence, collectUnicodeEscapeEvidence } from "@gajae-code/ai/utils/json-parse";
import { logger } from "@gajae-code/utils";
import {
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
	PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
} from "../../ai/src/adapter-internals/provider-safety-stop";

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

/**
 * Capture clamp-warning payloads for the staged-cap knobs. Kept separate from
 * {@link captureSnapshotDiagnostics} so the two message streams stay
 * independently assertable.
 */
function captureStagedCapClampWarnings(): Record<string, unknown>[] {
	const captured: Record<string, unknown>[] = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, payload?: unknown) => {
		if (message.startsWith("GJC_FALLBACK_MAX_STAGED_") && message.includes("clamped to")) {
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

class CompactLargeEnvelope {
	readonly payload = "x".repeat(MANAGED_ATTEMPT_MAX_STAGED_BYTES + 1);

	toJSON(): { compact: true } {
		return { compact: true };
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
	// Snapshot the inherited knob values once: the staged-cap knobs change the
	// transaction's provisional limits, so a host/CI export must be restored
	// (not merely deleted) after each test; tests that need defaults clear the
	// variables themselves inside the test.
	const inheritedKnobEvents = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
	const inheritedKnobBytes = process.env.GJC_FALLBACK_MAX_STAGED_BYTES;

	afterEach(() => {
		vi.restoreAllMocks();
		if (inheritedKnobEvents === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = inheritedKnobEvents;
		if (inheritedKnobBytes === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
		else process.env.GJC_FALLBACK_MAX_STAGED_BYTES = inheritedKnobBytes;
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

	it("separates provider envelope kinds from runtime-authored diagnostics", async () => {
		// These values are deliberately supplied by the provider envelope. The
		// runtime-authored local kinds tested below and in the local snapshot/
		// overflow cases must not be confused with this untrusted input surface.
		// The provider-owned safety-stop kind survives only when the envelope
		// carries adapter-minted provenance; a wire-assignable field alone is
		// stripped (#4777 review follow-up).
		const cases = [
			{
				errorKind: "provider_safety_stop" as const,
				stopReason: "error" as const,
				authenticated: true,
				expected: "provider_safety_stop" as const,
			},
			{
				errorKind: "provider_safety_stop" as const,
				stopReason: "error" as const,
				authenticated: false,
				expected: undefined,
			},
			{
				errorKind: "provider_safety_stop" as const,
				stopReason: "stop" as const,
				authenticated: true,
				expected: undefined,
			},
			{ errorKind: "local_buffer_overflow" as const, stopReason: "error" as const, expected: undefined },
			{ errorKind: undefined, stopReason: "error" as const, expected: undefined },
		];

		for (const { errorKind, stopReason, authenticated, expected } of cases) {
			const mock = createMockModel();
			const streamFn = () => {
				const stream = new AssistantMessageEventStream();
				const message: AssistantMessage = {
					...assistantMessage(mock.model),
					stopReason,
					errorMessage: "provider response",
					...(errorKind ? { errorKind } : {}),
				};
				if (authenticated) {
					mintProviderSafetyStop(
						message,
						"refusal",
						PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
						undefined,
						PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
					);
				}
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			};
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn,
			});

			await agent.prompt("run", { fallbackManaged: true });

			const terminal = agent.state.messages.at(-1);
			expect(terminal?.role).toBe("assistant");
			expect((terminal as AssistantMessage).errorKind).toBe(expected);
		}
	});

	it("keeps an authenticated transport-fact-carrying provider safety stop terminal instead of discarding it", async () => {
		// A first-party adapter that reports its safety stop on an HTTP envelope
		// (OpenAI content_filter with status + transportFailure) keeps terminal
		// authority even when the facts classify as retryable (5xx): the
		// attempt is committed for the parent, not discarded into a retryable
		// managed failure outcome that would advance the chain (#4777).
		const mock = createMockModel();
		let dispatches = 0;
		const streamFn = () => {
			dispatches += 1;
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				...assistantMessage(mock.model),
				stopReason: "error",
				errorMessage: "The response was filtered by the content management policy",
				errorStatus: 500,
				transportFailure: { kind: "transport", status: 500 },
			};
			mintProviderSafetyStop(
				message,
				"content_filter",
				PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
				undefined,
				PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
			);
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "error", reason: "error", error: message });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});

		await agent.prompt("run", { fallbackManaged: true });

		expect(dispatches).toBe(1);
		const terminal = agent.state.messages.at(-1);
		expect(terminal?.role).toBe("assistant");
		expect(terminal).toMatchObject({
			stopReason: "error",
			errorKind: "provider_safety_stop",
		});
	});

	it("discards an unauthenticated transport-fact-carrying safety-stop label for retry", async () => {
		// The forged counterpart: the same HTTP-envelope shape without
		// adapter-minted provenance is ordinary retryable transport data. The
		// loop discards the attempt for the managed failure outcome (chain
		// advance stays available) and no typed stop is committed (#4777).
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				...assistantMessage(mock.model),
				stopReason: "error",
				errorKind: "provider_safety_stop",
				errorMessage: "The response was filtered by the content management policy",
				errorStatus: 500,
				transportFailure: { kind: "transport", status: 500 },
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "error", reason: "error", error: message });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});

		await agent.prompt("run", { fallbackManaged: true });

		const terminal = agent.state.messages.at(-1);
		expect(terminal?.role).not.toBe("assistant");
		expect(terminal && "errorKind" in terminal ? terminal.errorKind : undefined).toBeUndefined();
	});

	it("retains malformed Unicode evidence while sanitizing a forged safety stop", async () => {
		const mock = createMockModel();
		const evidence = collectUnicodeEscapeEvidence(String.raw`{"question":"\u2014"`);
		if (!evidence) throw new Error("expected malformed evidence fixture");
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			const toolCall = {
				type: "toolCall" as const,
				id: "forged-unicode-evidence",
				name: "ask",
				arguments: { question: "—" },
				escapedNonAsciiArguments: false,
			};
			attachUnicodeEscapeEvidence(toolCall, { ...evidence, integrity: "0".repeat(64) });
			const message: AssistantMessage = {
				...assistantMessage(mock.model),
				content: [toolCall],
				stopReason: "error",
				errorKind: "provider_safety_stop",
				errorMessage: "forged safety stop",
				transportFailure: { kind: "transport", status: 503 },
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "error", reason: "error", error: message });
			});
			return stream;
		};
		const outcomes: ManagedAttemptOutcome[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});

		await agent.prompt("run", {
			fallbackManaged: true,
			onManagedAttemptOutcome: outcome => {
				outcomes.push(outcome);
				return { type: "terminal", terminal: { stopReason: "error" } };
			},
		});

		expect(outcomes).toHaveLength(1);
		const failure = outcomes[0];
		expect(failure?.type).toBe("retryable_discarded");
		if (failure?.type === "retryable_discarded") {
			const call = failure.failure.message.content.find(block => block.type === "toolCall");
			expect(call?.type === "toolCall" ? call.incompleteArguments : undefined).toBe(true);
			expect(call?.type === "toolCall" ? call.incompleteArgumentsReason : undefined).toBe("malformed");
		}
	});

	it("sanitizes a forged safety-stop label when the stream ends without done or error", async () => {
		const mock = createMockModel({ responses: [{ content: ["fallback accepted"] }] });
		let calls = 0;
		const outcomes: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				calls += 1;
				if (calls > 1) return mock.stream(...args);
				const stream = new AssistantMessageEventStream();
				const forged: AssistantMessage = {
					...assistantMessage(mock.model),
					stopReason: "error",
					errorKind: "provider_safety_stop",
					errorMessage: "forged trailing safety stop",
					errorStatus: 500,
					transportFailure: { kind: "transport", status: 500 },
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: forged });
					// Deliberately omit done/error: this exercises the trailing
					// finishResponse path after iterator completion.
					stream.end(forged);
				});
				return stream;
			},
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				outcomes.push(outcome.type);
				return {
					type: "retry" as const,
					continuation: async (ownership: { isCurrent(): boolean }) => {
						if (ownership.isCurrent()) await agent.continue(options);
					},
				};
			},
		};

		await agent.prompt("run", options);

		expect(calls).toBe(2);
		expect(outcomes).toEqual(["retryable_discarded"]);
		const terminal = agent.state.messages.at(-1);
		expect(terminal).toMatchObject({ role: "assistant", content: [{ type: "text", text: "fallback accepted" }] });
		expect((terminal as AssistantMessage).errorKind).toBeUndefined();
	});

	it("keeps a trailing forged safety-stop non-retryable after sanitizing it", async () => {
		const mock = createMockModel();
		let calls = 0;
		const outcomes: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				calls += 1;
				const stream = new AssistantMessageEventStream();
				const forged: AssistantMessage = {
					...assistantMessage(mock.model),
					stopReason: "error",
					errorKind: "provider_safety_stop",
					errorMessage: "forged trailing safety stop without transport facts",
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: forged });
					stream.end(forged);
				});
				return stream;
			},
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				outcomes.push(outcome.type);
				return { type: "terminal" as const, terminal: { stopReason: "exhausted" as const } };
			},
		};

		await agent.prompt("run", options);

		expect(calls).toBe(1);
		expect(outcomes).toEqual([]);
		// With no transport facts, the sanitized trailing error is terminal and
		// must not enter the managed retry callback or commit its forged label.
		expect(agent.state.messages.some(message => message.role === "assistant")).toBe(false);
		expect(agent.state.messages.some(message => "errorKind" in message)).toBe(false);
	});

	it("expires committed safety-stop authority before exposing history to a later stream", async () => {
		// Turn 1 commits a genuine adapter-minted stop. Turn 2's stream receives
		// that committed object through the default convertToLlm and re-uses it
		// as a forged terminal error. Today's identity churn (managed shell
		// rebuilds, state snapshots) already defuses this by accident; the
		// dispatch-entry expiry makes it an explicit invariant: no live
		// authority mark may ever be exposed to a stream, so the forged re-use
		// degrades to an ordinary retryable failure and the chain advances
		// (#4777 review follow-up).
		const mock = createMockModel({ responses: [{ content: ["fallback accepted"] }] });
		const outcomes: string[] = [];
		let dispatches = 0;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				dispatches += 1;
				if (dispatches > 1 && dispatches !== 2) return mock.stream(...args);
				const context = args[1] as AgentContext;
				if (dispatches === 1) {
					const stream = new AssistantMessageEventStream();
					const message: AssistantMessage = {
						...assistantMessage(mock.model),
						stopReason: "error",
						errorMessage: "The response was filtered by the content management policy",
						errorStatus: 500,
						transportFailure: { kind: "transport", status: 500 },
					};
					mintProviderSafetyStop(
						message,
						"content_filter",
						PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
						undefined,
						PROVIDER_SAFETY_STOP_ADAPTER_INVOCATION,
					);
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
					});
					return stream;
				}
				// Turn 2: the committed stop object arrives by identity; forge it.
				const committed = context.messages.find(
					(m): m is AssistantMessage => m.role === "assistant" && m.errorKind === "provider_safety_stop",
				);
				if (!committed) throw new Error("committed safety stop missing from stream context");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					committed.stopReason = "error";
					committed.errorMessage = "forged re-use of the committed stop";
					committed.errorStatus = 429;
					committed.transportFailure = { kind: "transport", status: 429 };
					stream.push({ type: "start", partial: committed });
					stream.push({ type: "error", reason: "error", error: committed });
				});
				return stream;
			},
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				outcomes.push(outcome.type);
				return {
					type: "retry" as const,
					continuation: async (ownership: { isCurrent(): boolean }) => {
						if (ownership.isCurrent()) await agent.continue(options);
					},
				};
			},
		};

		await agent.prompt("first", options);
		const firstTerminal = agent.state.messages.at(-1) as AssistantMessage;
		expect(firstTerminal).toMatchObject({ stopReason: "error", errorKind: "provider_safety_stop" });

		await agent.prompt("second", options);

		expect(dispatches).toBe(3);
		expect(outcomes).toContain("retryable_discarded");
		const terminal = agent.state.messages.at(-1);
		expect(terminal).toMatchObject({ role: "assistant", content: [{ type: "text", text: "fallback accepted" }] });
		expect((terminal as AssistantMessage).errorKind).toBeUndefined();
	});

	it("strips a forged safety-stop label on a hostile Proxy without aborting the run", async () => {
		// A Proxy whose deleteProperty and ownKeys traps reject must not turn the
		// provenance strip into a run-aborting TypeError; the sanitizer rebuilds
		// through guarded fields so the forged label still degrades to fallback
		// (#4777 review follow-up).
		const mock = createMockModel({ responses: [{ content: ["fallback accepted"] }] });
		let calls = 0;
		let discardedFailureKind: AssistantMessage["errorKind"] | undefined;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: (...args) => {
				calls += 1;
				if (calls > 1) return mock.stream(...args);
				const stream = new AssistantMessageEventStream();
				const base: AssistantMessage = {
					...assistantMessage(mock.model),
					stopReason: "error",
					errorKind: "provider_safety_stop",
					errorMessage: "frozen forged safety stop",
					errorStatus: 500,
					transportFailure: { kind: "transport", status: 500 },
				};
				const forged = new Proxy(base, {
					deleteProperty: () => {
						throw new Error("delete blocked");
					},
					ownKeys: () => {
						throw new Error("enumeration blocked");
					},
				}) as AssistantMessage;
				queueMicrotask(() => {
					stream.push({ type: "start", partial: base });
					stream.push({ type: "error", reason: "error", error: forged });
				});
				return stream;
			},
		});
		const options = {
			fallbackManaged: true,
			onManagedAttemptOutcome: (outcome: ManagedAttemptOutcome) => {
				if (outcome.type === "retryable_discarded") discardedFailureKind = outcome.failure.message.errorKind;
				return {
					type: "retry" as const,
					continuation: async (ownership: { isCurrent(): boolean }) => {
						if (ownership.isCurrent()) await agent.continue(options);
					},
				} as const;
			},
		};

		await agent.prompt("run", options);

		expect(calls).toBe(2);
		expect(discardedFailureKind).toBeUndefined();
		const terminal = agent.state.messages.at(-1);
		expect(terminal).toMatchObject({ role: "assistant", content: [{ type: "text", text: "fallback accepted" }] });
		expect((terminal as AssistantMessage).errorKind).toBeUndefined();
	});

	it("strips a forged safety-stop label regardless of stop reason", async () => {
		// The field is reserved for adapter-minted terminal stops. Downstream
		// consumers (session compaction checks among them) read it without
		// re-checking the error state, so a forged label on a nominally
		// successful response must not survive the stream exit either (#4777
		// review follow-up).
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			const forged: AssistantMessage = {
				...assistantMessage(mock.model),
				content: [{ type: "text", text: "successful turn with a forged label" }],
				stopReason: "stop",
				errorKind: "provider_safety_stop",
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: forged });
				stream.push({ type: "done", reason: "stop", message: forged });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});

		await agent.prompt("run");

		const terminal = agent.state.messages.at(-1) as AssistantMessage;
		expect(terminal.stopReason).toBe("stop");
		expect(terminal.errorKind).toBeUndefined();
		expect(terminal.content).toEqual([{ type: "text", text: "successful turn with a forged label" }]);
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

	it("keeps non-managed lossless staging serializable when clone strips a provider payload serializer", async () => {
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).providerPayload = {
					envelope: new JsonSafeBigIntEnvelope(),
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
		});

		await agent.prompt("run");

		const accepted = agent.state.messages.at(-1) as AssistantMessage;
		expect(agent.state.error).toBeUndefined();
		expect(accepted.content).toEqual([{ type: "text", text: "accepted" }]);
		expect(() => JSON.stringify(accepted)).not.toThrow();
		const providerPayload = accepted.providerPayload as { envelope?: { sequence?: unknown } } | undefined;
		expect(providerPayload?.envelope?.sequence).toBe("1");
	});

	it("commits an oversized non-managed lossless batch instead of failing locally", async () => {
		// Given a reasoning-only response that exceeds the provisional staging
		// cap before any visible text can commit the lossless transaction.
		const mock = createMockModel();
		const oversizedThinking = "x".repeat(MANAGED_ATTEMPT_MAX_STAGED_BYTES + 1);
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			void (async () => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				await Bun.sleep(0);
				partial.content.push({ type: "thinking", thinking: oversizedThinking });
				stream.push({ type: "thinking_start", contentIndex: 0, partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			})();
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		const lifecycle: string[] = [];
		agent.subscribe(event => lifecycle.push(event.type));

		// When the ordinary non-managed run consumes the oversized response.
		await agent.prompt("run");

		// Then the memory guard degrades to pass-through publication while the
		// accepted assistant message remains intact.
		expect(agent.state.error).toBeUndefined();
		const accepted = agent.state.messages.at(-1);
		expect(accepted?.role).toBe("assistant");
		if (accepted?.role !== "assistant") throw new Error("Expected an accepted assistant message");
		const thinking = accepted.content[0];
		expect(thinking?.type).toBe("thinking");
		if (thinking?.type !== "thinking") throw new Error("Expected an accepted thinking block");
		expect(thinking.thinking).toHaveLength(MANAGED_ATTEMPT_MAX_STAGED_BYTES + 1);
		expect(lifecycle.slice(-5)).toEqual(["message_start", "message_update", "message_end", "turn_end", "agent_end"]);
	});
	it("honors a low GJC_FALLBACK_MAX_STAGED_EVENTS in ordinary lossless sessions by flushing through", async () => {
		// Ordinary (non-managed) runs stage lossless snapshots behind the same
		// limiter. With a 2-event cap the third staged frame must degrade to
		// pass-through publication — callbacks preserved, lifecycle intact, no
		// typed failure — instead of either failing locally or retaining
		// unbounded state.
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = "2";
		try {
			const mock = createMockModel();
			const streamFn = () => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					await Bun.sleep(0);
					partial.content.push({ type: "thinking", thinking: "chunk-0" });
					stream.push({ type: "thinking_start", contentIndex: 0, partial });
					await Bun.sleep(0);
					partial.content.push({ type: "text", text: "accepted" });
					stream.push({ type: "text_start", contentIndex: 0, partial });
					await Bun.sleep(0);
					stream.push({ type: "done", reason: "stop", message: partial });
				})();
				return stream;
			};
			const callbacks: AssistantMessageEvent[] = [];
			const lifecycle: string[] = [];
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn,
				onAssistantMessageEvent: (_message, event) => callbacks.push(event),
			});
			agent.subscribe(event => lifecycle.push(event.type));

			await agent.prompt("run");

			expect(agent.state.error).toBeUndefined();
			const accepted = agent.state.messages.at(-1);
			expect(accepted?.role).toBe("assistant");
			// The callback contract is preserved through the flush/pass-through.
			expect(callbacks.map(event => event.type)).toContain("thinking_start");
			expect(callbacks.map(event => event.type)).toContain("text_start");
			expect(lifecycle.slice(-6)).toEqual([
				"message_start",
				"message_update",
				"message_update",
				"message_end",
				"turn_end",
				"agent_end",
			]);
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
			else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = previous;
		}
	});

	it("honors a low GJC_FALLBACK_MAX_STAGED_BYTES in ordinary lossless sessions by flushing through", async () => {
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
		process.env.GJC_FALLBACK_MAX_STAGED_BYTES = "128";
		try {
			const mock = createMockModel();
			const streamFn = () => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					await Bun.sleep(0);
					partial.content.push({ type: "thinking", thinking: "x".repeat(4096) });
					stream.push({ type: "thinking_start", contentIndex: 0, partial });
					await Bun.sleep(0);
					stream.push({ type: "done", reason: "stop", message: partial });
				})();
				return stream;
			};
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn,
			});
			const lifecycle: string[] = [];
			agent.subscribe(event => lifecycle.push(event.type));

			await agent.prompt("run");

			// The 4 KiB frame exceeds the 128-byte cap: the lossless transaction
			// flushes and streams through rather than failing the run.
			expect(agent.state.error).toBeUndefined();
			const accepted = agent.state.messages.at(-1);
			expect(accepted?.role).toBe("assistant");
			expect(lifecycle.slice(-5)).toEqual([
				"message_start",
				"message_update",
				"message_end",
				"turn_end",
				"agent_end",
			]);
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
			else process.env.GJC_FALLBACK_MAX_STAGED_BYTES = previous;
		}
	});

	it("ignores project .env values for the staged-cap knobs", async () => {
		// The knobs are a defensive resource guard: a repository-controlled
		// .env must not be able to weaken them. $credentialEnv excludes the
		// cwd/.env overlay, so only a trusted (process/agent/user) source can
		// move these caps. This regression pins the trust boundary by resolving
		// through the same trusted resolver the limiter uses.
		// A value set in the TRUSTED process environment is honored...
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = "5000";
		try {
			expect(managedAttemptMaxStagedEvents()).toBe(5000);
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
			else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = previous;
		}
		// With no trusted source set, the documented default applies regardless
		// of what any project .env may contain.
		delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		expect(managedAttemptMaxStagedEvents()).toBe(MANAGED_ATTEMPT_MAX_STAGED_EVENTS);
	});

	it("preserves lifecycle order when a compact live payload clones above the lossless cap", async () => {
		// Given a payload whose live serializer is compact but whose detached own
		// data exceeds the staging cap after structuredClone removes that method.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).providerPayload = {
					envelope: new CompactLargeEnvelope(),
				};
				stream.push({ type: "start", partial });
				partial.content.push({ type: "thinking", thinking: "accepted" });
				stream.push({ type: "thinking_start", contentIndex: 0, partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			});
			return stream;
		};
		const deliveryOrder: string[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
			onAssistantMessageEvent: (_message, event) => deliveryOrder.push(`callback:${event.type}`),
		});
		agent.subscribe(event => deliveryOrder.push(`public:${event.type}`));

		// When the detached measurement, rather than the live pre-measurement,
		// crosses the lossless staging cap.
		await agent.prompt("run");

		// Then callbacks and the complete public lifecycle remain ordered, and
		// the accepted detached payload is preserved rather than failed locally.
		expect(agent.state.error).toBeUndefined();
		expect(deliveryOrder.slice(-6)).toEqual([
			"public:message_start",
			"callback:thinking_start",
			"public:message_update",
			"public:message_end",
			"public:turn_end",
			"public:agent_end",
		]);
		const accepted = agent.state.messages.at(-1);
		if (accepted?.role !== "assistant") throw new Error("Expected an accepted assistant message");
		const providerPayload = accepted.providerPayload as { envelope?: { payload?: unknown } } | undefined;
		expect(providerPayload?.envelope?.payload).toBeString();
		expect(providerPayload?.envelope?.payload).toHaveLength(MANAGED_ATTEMPT_MAX_STAGED_BYTES + 1);
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
		expect(agent.state.error).toBe("Agent run failed.");
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
		// reads. The clone-surface preflight reads only through own-property
		// descriptors and refuses accessors outright, so the getter is NEVER
		// invoked — zero reads. The previously blocked implementation cloned
		// before the cap check, and structuredClone invokes accessors, so it
		// read the witness exactly once: any read at all is the regression
		// signal; zero is the strengthened invariant.
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
		expect(agent.state.error).toBe("Agent run failed.");
		expect((agent.state.messages.at(-1) as AssistantMessage).errorKind).toBe("local_buffer_overflow");
		expect(witnessReads).toBe(0);
		// One bounded diagnostic per stream invocation, shape-only.
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			errorKind: "local_buffer_overflow",
			model: mock.model.id,
			provider: mock.model.provider,
			snapshotMode: "managed",
		});
	});
	it("rejects a toJSON-hidden clone-visible payload before any snapshot allocation", async () => {
		// Exact-head 078e22c0 blocker: the live JSON surface (which dispatches
		// `toJSON`) can be tiny while the clone-visible own payload the JSON
		// walk never sees is huge. The rejection must come from the PRE-FLIGHT
		// walks — stage `overflow.preMeasure`, before any snapshot work — not
		// from `overflow.staged` after structuredClone has already duplicated
		// the oversized payload. On the previously blocked head the JSON walk
		// reads `{compact:true}` as under-budget, the clone allocates the full
		// hidden payload, and only the detached measurement rejects it: the
		// allocation the cap exists to prevent happened ahead of the guard.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				(partial as unknown as Record<string, unknown>).providerPayload = {
					envelope: new CompactLargeEnvelope(),
				};
				stream.push({ type: "start", partial });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		let outcomeCalls = 0;
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
		process.env.GJC_FALLBACK_MAX_STAGED_BYTES = "2048";
		try {
			await agent.prompt("run", {
				fallbackManaged: true,
				onManagedAttemptOutcome: () => {
					outcomeCalls += 1;
					return { type: "retry", continuation: () => {} };
				},
			});
			await agent.waitForIdle();
			expect(outcomeCalls).toBe(0);
			expect(agent.state.error).toBe("Agent run failed.");
			const terminal = agent.state.messages.at(-1) as AssistantMessage;
			expect(terminal.errorKind).toBe("local_buffer_overflow");
			const overflow = (terminal as unknown as { bufferOverflow?: { stage: string } }).bufferOverflow;
			expect(overflow?.stage).toBe("overflow.preMeasure");
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
			else process.env.GJC_FALLBACK_MAX_STAGED_BYTES = previous;
		}
	});

	it("counts lone surrogates as their six-byte JSON escape when bounding staging", async () => {
		// Exact-head 078e22c0 blocker: a lone surrogate encodes to 3 UTF-8
		// bytes but `JSON.stringify` emits a six-byte `\udXXX` escape for it,
		// so charging 3 undercounted surrogate-heavy strings by ~2x and let
		// them pass the pre-check into a full serialization. The walk must
		// charge the escape: 100 000 lone surrogates are 300 002 bytes at the
		// old 3-byte charge (under the 400 KiB cap used here) but 600 002 as
		// serialized JSON (over it). On the previously blocked head the
		// pre-check passed and the detached measurement rejected the payload
		// as `overflow.staged` after the fact; the walk must reject it up
		// front as `overflow.preMeasure`.
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				partial.content.push({ type: "text", text: "\uD800".repeat(100_000) });
				stream.push({ type: "start", partial });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});
		let outcomeCalls = 0;
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
		process.env.GJC_FALLBACK_MAX_STAGED_BYTES = String(400 * 1024);
		try {
			await agent.prompt("run", {
				fallbackManaged: true,
				onManagedAttemptOutcome: () => {
					outcomeCalls += 1;
					return { type: "retry", continuation: () => {} };
				},
			});
			await agent.waitForIdle();
			expect(outcomeCalls).toBe(0);
			expect(agent.state.error).toBe("Agent run failed.");
			const terminal = agent.state.messages.at(-1) as AssistantMessage;
			expect(terminal.errorKind).toBe("local_buffer_overflow");
			const overflow = (terminal as unknown as { bufferOverflow?: { stage: string; maxStagedBytes: number } })
				.bufferOverflow;
			expect(overflow?.stage).toBe("overflow.preMeasure");
			expect(overflow?.maxStagedBytes).toBe(400 * 1024);
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
			else process.env.GJC_FALLBACK_MAX_STAGED_BYTES = previous;
		}
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
		expect(agent.state.error).toBe("Agent run failed.");
		expect(events).not.toContain("message_update");
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]?.errorMessage).toBe("Agent run failed.");
		expect(surfaced[0]?.errorStatus).toBeUndefined();
		expect(surfaced[0]?.transportFailure).toBeUndefined();
	});

	it("completes a long managed stream by reclaiming superseded increments instead of failing", async () => {
		// Regression: every staged frame carries the WHOLE accumulated partial
		// (once as `message`, once as `assistantMessageEvent.partial`), so staged
		// bytes grow quadratically with the streamed length. A reasoning-heavy
		// turn of a few thousand tokens used to cross the 16 MiB cap and kill the
		// run with "exceeded the provisional event buffer limit", even though no
		// single event was anywhere near the cap and the attempt itself was
		// healthy. 200 increments of 1 KiB stage ~40 MiB uncompacted.
		const deltaCount = 200;
		const delta = "x".repeat(1024);
		const fullText = delta.repeat(deltaCount);
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				partial.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial });
				for (let index = 0; index < deltaCount; index++) {
					const block = partial.content[0] as { type: "text"; text: string };
					block.text += delta;
					stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
				}
				stream.push({ type: "text_end", contentIndex: 0, content: fullText, partial });
				stream.push({ type: "done", reason: "stop", message: partial });
			});
			return stream;
		};
		const callbacks: AssistantMessageEvent[] = [];
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
			onAssistantMessageEvent: (_message, event) => callbacks.push(event),
		});
		const replayedUpdates: string[] = [];
		agent.subscribe(event => {
			if (event.type !== "message_update") return;
			replayedUpdates.push(event.assistantMessageEvent.type);
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

		// The turn completes and commits its whole response.
		expect(agent.state.error).toBeUndefined();
		const committed = agent.state.messages.at(-1) as AssistantMessage;
		expect(committed.role).toBe("assistant");
		expect(committed.content).toEqual([{ type: "text", text: fullText }]);
		// A local staging limit is not provider evidence either way: reclaiming
		// must not report an outcome or consume the fallback chain.
		expect(outcomeCalls).toBe(0);
		// Superseded increments were actually reclaimed rather than all replayed.
		expect(replayedUpdates.filter(type => type === "text_delta").length).toBeLessThan(deltaCount);
		// Structural frames survive, so the block's complete content is still
		// delivered on the retained path.
		expect(replayedUpdates).toContain("text_start");
		expect(replayedUpdates).toContain("text_end");
		const textEnd = callbacks.find(event => event.type === "text_end");
		expect(textEnd).toMatchObject({ type: "text_end", contentIndex: 0, content: fullText });
	});
	it("honors GJC_FALLBACK_MAX_STAGED_EVENTS from the environment", async () => {
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = "2";
		try {
			const mock = createMockModel();
			const streamFn = () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					let last: AssistantMessage | undefined;
					for (let i = 0; i < 5; i += 1) {
						const partial = assistantMessage(mock.model);
						partial.content.push({ type: "text", text: `chunk-${i}` });
						last = partial;
						stream.push({ type: "start", partial });
					}
					stream.end(last);
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
					return { type: "retry", continuation: () => {} };
				},
			});
			await agent.waitForIdle();
			// Each provider start stages a message_start event — the start frames
			// carry no superseded delta to reclaim — so with a 2-event cap the
			// third staged event trips the limit and the attempt fails as a local
			// error (same behavior as the default cap): the overflow never carries
			// provider evidence, so the fallback chain is not consumed.
			expect(outcomeCalls).toBe(0);
			expect(agent.state.error).toBe("Agent run failed.");
			expect((agent.state.messages.at(-1) as AssistantMessage).errorKind).toBe("local_buffer_overflow");
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
			else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = previous;
		}
	});

	it("honors GJC_FALLBACK_MAX_STAGED_BYTES from the environment", async () => {
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
		process.env.GJC_FALLBACK_MAX_STAGED_BYTES = "128";
		try {
			const mock = createMockModel();
			const streamFn = () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					partial.content.push({ type: "text", text: "x".repeat(4096) });
					stream.push({ type: "start", partial });
					stream.end();
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
					return { type: "retry", continuation: () => {} };
				},
			});
			await agent.waitForIdle();
			// A 4 KiB event exceeds the 128-byte cap and no reclaimable delta can
			// shrink it, so the attempt fails as a local error without consuming
			// the fallback chain.
			expect(outcomeCalls).toBe(0);
			expect(agent.state.error).toBe("Agent run failed.");
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
			else process.env.GJC_FALLBACK_MAX_STAGED_BYTES = previous;
		}
	});

	it("falls back to the default cap for a non-positive GJC_FALLBACK_MAX_STAGED_EVENTS", async () => {
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = "0";
		try {
			const mock = createMockModel();
			const streamFn = () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					let last: AssistantMessage | undefined;
					for (let i = 0; i < 5; i += 1) {
						const partial = assistantMessage(mock.model);
						partial.content.push({ type: "text", text: `chunk-${i}` });
						last = partial;
						stream.push({ type: "start", partial });
					}
					stream.end(last);
				});
				return stream;
			};
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn,
			});
			await agent.prompt("run", { fallbackManaged: true });
			await agent.waitForIdle();
			// "0" is not a positive integer, so the default 10_000-event cap
			// applies and the small run completes without an overflow error.
			expect(agent.state.error).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
			else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = previous;
		}
	});

	it("falls back to the default cap for non-digit GJC_FALLBACK_MAX_STAGED_EVENTS values", async () => {
		// Exponents and hex are not "positive integer (digits only)" input. A
		// bare Number() parse would accept "3e0"/"0x3" as the cap 3, so these
		// five staged events would overflow; digits-only parsing must reject
		// them and keep the default 10_000-event cap instead.
		for (const raw of ["3e0", "0x3"]) {
			const previous = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
			process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = raw;
			try {
				const mock = createMockModel();
				const streamFn = () => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						let last: AssistantMessage | undefined;
						for (let i = 0; i < 5; i += 1) {
							const partial = assistantMessage(mock.model);
							partial.content.push({ type: "text", text: `chunk-${i}` });
							last = partial;
							stream.push({ type: "start", partial });
						}
						stream.end(last);
					});
					return stream;
				};
				const agent = new Agent({
					initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
					streamFn,
				});
				await agent.prompt("run", { fallbackManaged: true });
				await agent.waitForIdle();
				// The invalid value fell back to the default cap, so the small run
				// completes instead of tripping a misparsed 3-event limit.
				expect(agent.state.error).toBeUndefined();
			} finally {
				if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
				else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = previous;
			}
		}
	});
	it("clamps above-ceiling GJC_FALLBACK_MAX_STAGED_* overrides and accepts exact-ceiling values", async () => {
		// The caps exist to bound memory: an override near MAX_SAFE_INTEGER
		// would trade the typed, bounded local_buffer_overflow for a process
		// OOM. Above-ceiling values must clamp to the ceiling (with a warning)
		// rather than being honored. Exactly-at-ceiling values are the accepted
		// boundary (#wouldOverflow deliberately accepts equality), so they are
		// honored verbatim — both sides of the boundary are pinned here.
		const diagnostics = captureStagedCapClampWarnings();
		for (const [name, atCeiling, aboveCeiling, ceiling] of [
			["GJC_FALLBACK_MAX_STAGED_EVENTS", "2000000", "2000001", 2_000_000],
			["GJC_FALLBACK_MAX_STAGED_BYTES", "1073741824", "1073741825", 1024 * 1024 * 1024],
		] as const) {
			const previous = process.env[name];
			// Exactly at the ceiling: honored, no warning.
			process.env[name] = atCeiling;
			try {
				expect(
					name === "GJC_FALLBACK_MAX_STAGED_EVENTS"
						? managedAttemptMaxStagedEvents()
						: managedAttemptMaxStagedBytes(),
				).toBe(ceiling);
			} finally {
				if (previous === undefined) delete process.env[name];
				else process.env[name] = previous;
			}
			// Above the ceiling: clamped back down, one warning.
			process.env[name] = aboveCeiling;
			try {
				expect(
					name === "GJC_FALLBACK_MAX_STAGED_EVENTS"
						? managedAttemptMaxStagedEvents()
						: managedAttemptMaxStagedBytes(),
				).toBe(ceiling);
			} finally {
				if (previous === undefined) delete process.env[name];
				else process.env[name] = previous;
			}
		}
		// Both clamp sites warn once each, naming the variable and the ceiling;
		// the once-per-(knob, value) memoization still lets distinct values warn.
		const clampWarnings = diagnostics.filter(entry => typeof entry.requested === "number");
		expect(clampWarnings).toHaveLength(2);
	});

	it("clamps beyond-safe-integer overrides through the lexical decimal path", () => {
		// 2^53 and 2^53+1 fail Number.isSafeInteger, so a purely numeric parse
		// would misclassify them as invalid and silently fall back to the
		// DEFAULT instead of the documented clamp — an operator asking for a
		// huge cap would get 10 000 events / 16 MiB. The lexical comparison
		// must clamp both to the ceiling, and the warning payload must be a
		// bounded digest (never the arbitrarily long raw string embedded in a
		// log record).
		const warnings = captureStagedCapClampWarnings();
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		for (const raw of ["9007199254740992", "9007199254740993", "9".repeat(64)]) {
			process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = raw;
			expect(managedAttemptMaxStagedEvents()).toBe(2_000_000);
		}
		// The once-per-digest memoization collapses the two 2^53 values (same
		// length, same 8-digit prefix) into one record and keeps the 64-digit
		// one distinct — bounded logging without losing the clamp signal.
		const digestWarnings = warnings.filter(entry => typeof entry.requested === "string");
		expect(digestWarnings).toHaveLength(2);
		for (const entry of digestWarnings) {
			expect(String(entry.requested).length).toBeLessThanOrEqual(64);
			expect(String(entry.requested)).toContain("digits");
		}
		expect(digestWarnings.every(entry => entry.ceiling === 2_000_000)).toBe(true);
		if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = previous;
	});

	it("charges every retained batch item against the caps before retention", async () => {
		// Adversarial multi-chunk growth: the provider streams assistant pairs
		// (uncharged before this change) alongside measured message_update
		// events. A byte cap smaller than the sum of the pair sizes must fail
		// the attempt as a typed local overflow BEFORE the pair is retained,
		// proving the assistant pair is charged against the same bound the
		// measured events use — actual retention can no longer exceed the caps
		// while the counters read under them.
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
		process.env.GJC_FALLBACK_MAX_STAGED_BYTES = "2048";
		try {
			const mock = createMockModel();
			const streamFn = () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					partial.content.push({ type: "text", text: "x".repeat(4096) });
					// A provider that streams a large assistant pair after the
					// lifecycle start: with the pair uncharged, the batch would
					// retain it while the counters stayed low.
					stream.push({ type: "text_start", contentIndex: 0, partial });
					stream.end(partial);
				});
				return stream;
			};
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn,
				onAssistantMessageEvent: () => {},
			});
			let outcomeCalls = 0;
			await agent.prompt("run", {
				fallbackManaged: true,
				onManagedAttemptOutcome: () => {
					outcomeCalls += 1;
					return { type: "retry", continuation: () => {} };
				},
			});
			await agent.waitForIdle();
			// The retained batch as a whole exceeded the cap and was rejected
			// as a typed local overflow without consuming the fallback chain.
			expect(outcomeCalls).toBe(0);
			expect(agent.state.error).toBe("Agent run failed.");
			expect((agent.state.messages.at(-1) as AssistantMessage).errorKind).toBe("local_buffer_overflow");
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
			else process.env.GJC_FALLBACK_MAX_STAGED_BYTES = previous;
		}
	});
	it("rejects a many-small-chunks payload without materializing the full budget", async () => {
		// The discriminating pin the review asked for: a payload composed of
		// many individually sub-limit strings must trip the typed overflow via
		// the THROWING pre-allocation walk — which terminates serialization the
		// moment the running byte count crosses the cap — rather than by
		// materializing the whole JSON string first. On the pre-fix path the
		// walk substituted "" and kept going, so the full value was built
		// before any check ran; here the cap is crossed while the accumulated
		// seen-count is far below the payload's total size.
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
		// 256 KiB budget against a ~4 MiB payload of 4 KiB chunks: each chunk
		// is well under the budget, only their accumulation crosses it.
		process.env.GJC_FALLBACK_MAX_STAGED_BYTES = String(256 * 1024);
		try {
			const mock = createMockModel();
			const chunk = "x".repeat(4 * 1024);
			const streamFn = () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					partial.content.push({ type: "thinking", thinking: chunk.repeat(1024) });
					// A reasoning block of many accumulated sub-limit deltas:
					// no single event is near the cap, and the pre-fix walk
					// would have walked the entire ~4 MiB before checking.
					stream.push({ type: "thinking_start", contentIndex: 0, partial });
					stream.end(partial);
				});
				return stream;
			};
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn,
				onAssistantMessageEvent: () => {},
			});
			let outcomeCalls = 0;
			await agent.prompt("run", {
				fallbackManaged: true,
				onManagedAttemptOutcome: () => {
					outcomeCalls += 1;
					return { type: "retry", continuation: () => {} };
				},
			});
			await agent.waitForIdle();
			// The typed overflow fired without consuming the fallback chain and
			// without ever building the full multi-megabyte serialization.
			expect(outcomeCalls).toBe(0);
			expect(agent.state.error).toBe("Agent run failed.");
			const terminal = agent.state.messages.at(-1) as AssistantMessage;
			expect(terminal.errorKind).toBe("local_buffer_overflow");
			// The diagnostic names the cap that tripped, proving the guard —
			// not a downstream crash — produced the failure.
			const overflow = (terminal as unknown as { bufferOverflow?: { maxStagedBytes: number } }).bufferOverflow;
			expect(overflow?.maxStagedBytes).toBe(256 * 1024);
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_BYTES;
			else process.env.GJC_FALLBACK_MAX_STAGED_BYTES = previous;
		}
	});

	it("falls back to the default cap for zero, negative, and non-numeric values", () => {
		// Those never reach the clamp: the digits-only parse rejects them and
		// keeps the documented default, so the guard can never be disabled by
		// malformed input either.
		for (const raw of ["0", "-5", "abc", ""]) {
			const previous = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
			process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = raw;
			try {
				expect(managedAttemptMaxStagedEvents()).toBe(MANAGED_ATTEMPT_MAX_STAGED_EVENTS);
			} finally {
				if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
				else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = previous;
			}
		}
	});

	it("accepts trusted staged-cap values with surrounding whitespace", () => {
		const previous = process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
		process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = " 2 ";
		try {
			expect(managedAttemptMaxStagedEvents()).toBe(2);
		} finally {
			if (previous === undefined) delete process.env.GJC_FALLBACK_MAX_STAGED_EVENTS;
			else process.env.GJC_FALLBACK_MAX_STAGED_EVENTS = previous;
		}
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
		expect(agent.state.error).toBe("Agent run failed.");
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
					// A plain-object `content` (e.g. {0:{type:"text"}}) can hide
					// array-like toolCalls — it stays fail-closed at shell.content.
					// This is the blocker from the red-team review.
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
	it("degrades benign primitive content to an empty turn (null/number/boolean/string)", async () => {
		const cases: Array<{ content: unknown; label: string }> = [
			{ content: null, label: "null" },
			{ content: 42, label: "number" },
			{ content: true, label: "boolean true" },
			{ content: false, label: "boolean false" },
			{ content: "hello", label: "benign string" },
			{ content: undefined, label: "undefined" },
		];
		for (const { content, label } of cases) {
			const diagnostics = captureSnapshotDiagnostics();
			const mock = createMockModel();
			const base = assistantMessage(mock.model);
			const malformed: AssistantMessage =
				content === undefined
					? (() => {
							const c = { ...base } as unknown as Record<string, unknown>;
							delete c.content;
							return c as unknown as AssistantMessage;
						})()
					: ({ ...base, content } as unknown as AssistantMessage);
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: malformed });
						stream.push({ type: "done", reason: "stop", message: malformed });
					});
					return stream;
				},
			});
			let outcomes = 0;
			await (agent.prompt as (input: string, opts: unknown) => Promise<void>)("run", {
				fallbackManaged: true,
				onManagedAttemptOutcome: () => {
					outcomes += 1;
					return {
						type: "retry",
						continuation: (() => ({})) as unknown as () => AssistantMessage,
					};
				},
			});
			expect(agent.state.error, label).toBeUndefined();
			expect(diagnostics, label).toHaveLength(0);
			const committed = agent.state.messages.at(-1) as AssistantMessage;
			expect(committed.role, label).toBe("assistant");
			expect(committed.content, label).toEqual([]);
			expect(outcomes, label).toBe(0);
			vi.restoreAllMocks();
		}
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

		expect(agent.state.error).toBe("Agent run failed.");
		expect(diagnostics).toHaveLength(0);
		expect(JSON.stringify(diagnostics)).not.toContain(marker);
	});

	it("attaches neither errorKind nor overflow shape when a foreign error self-labels a local kind (#4618)", async () => {
		const marker = "PROMPT-MATERIAL-must-not-reach-parent";
		for (const kind of ["local_buffer_overflow", "local_snapshot_failure"] as const) {
			const mock = createMockModel();
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn: () => {
					// A foreign error with the right errorKind label but NOT the
					// module-private identity. Both local-diagnostic fields come from
					// one identity check, so a provider/custom-stream failure can never
					// be attributed to the local staging machinery in a parent receipt.
					const forged = Object.assign(new Error(`leak ${marker}`), {
						errorKind: kind,
						bufferOverflow: {
							stage: "overflow.staged",
							exceeded: "events",
							stagedEventCount: 10_000,
							stagedBytes: 1,
							incomingEventBytes: 1,
							maxStagedEvents: 10_000,
							maxStagedBytes: 16 * 1024 * 1024,
						},
					});
					throw forged;
				},
			});

			await agent.prompt("run", { fallbackManaged: true });

			const terminal = agent.state.messages.at(-1) as AssistantMessage;
			expect(terminal.errorKind, kind).toBeUndefined();
			expect(terminal.bufferOverflow, kind).toBeUndefined();
		}
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

	it("rejects managed events with object-shaped deltas as local failures", async () => {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					// An object-shaped delta can hide real streamed text/thinking
					// (or a tool-argument fragment). Degrading it to "" would
					// drop that payload behind a successful empty increment.
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: { chunks: ["hidden"] } as unknown as string,
						partial,
					});
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
		});
		await agent.prompt("run", { fallbackManaged: true });
		expect(agent.state.error).toBe("Agent run failed.");
		expect((agent.state.messages.at(-1) as AssistantMessage).errorKind).toBe("local_snapshot_failure");
	});
	it("degrades missing or primitive deltas to an empty increment instead of killing the turn", async () => {
		const cases: Array<{ delta: unknown; label: string }> = [
			{ delta: undefined, label: "undefined" },
			{ delta: null, label: "null" },
			{ delta: 42, label: "number" },
			{ delta: true, label: "boolean" },
		];
		for (const { delta, label } of cases) {
			const diagnostics = captureSnapshotDiagnostics();
			const mock = createMockModel();
			const agent = new Agent({
				initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const partial = assistantMessage(mock.model);
						partial.content.push({ type: "thinking", thinking: "" });
						stream.push({ type: "start", partial });
						stream.push({ type: "thinking_start", contentIndex: 0, partial });
						stream.push({
							type: "thinking_delta",
							contentIndex: 0,
							delta: delta as string,
							partial,
						});
						stream.push({ type: "done", reason: "stop", message: partial });
					});
					return stream;
				},
			});
			await agent.prompt("run", { fallbackManaged: true });
			expect(agent.state.error, label).toBeUndefined();
			expect(diagnostics, label).toHaveLength(0);
			const committed = agent.state.messages.at(-1) as AssistantMessage;
			expect(committed.role, label).toBe("assistant");
			expect(committed.content, label).toEqual([{ type: "thinking", thinking: "" }]);
			vi.restoreAllMocks();
		}
	});
	it("warns once per run when repeated partial shells degrade primitive content", async () => {
		const mock = createMockModel();
		const warnings: unknown[] = [];
		vi.spyOn(logger, "warn").mockImplementation((message, payload) => {
			if (message === "agent: managed snapshot degraded a non-string primitive to an empty value") {
				warnings.push(payload);
			}
		});
		const malformed = assistantMessage(mock.model) as unknown as { content: number };
		malformed.content = 42;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: malformed as unknown as AssistantMessage });
					for (let index = 0; index < 3; index++) {
						stream.push({
							type: "thinking_delta",
							contentIndex: 0,
							delta: undefined as unknown as string,
							partial: malformed as unknown as AssistantMessage,
						});
					}
					stream.push({ type: "done", reason: "stop", message: malformed as unknown as AssistantMessage });
				});
				return stream;
			},
		});

		await agent.prompt("run", { fallbackManaged: true });
		expect(warnings.filter(payload => (payload as { field?: string }).field === "shell.content")).toHaveLength(1);
	});
	it("warns once per run for degraded prose and fails closed on primitive executable deltas", () => {
		const mock = createMockModel();
		const message = assistantMessage(mock.model);
		const warnings: Array<{ message: string; payload: unknown }> = [];
		vi.spyOn(logger, "warn").mockImplementation((warning, payload) => {
			warnings.push({ message: warning, payload });
		});
		const diagnostics = new Set<string>();

		for (const delta of [undefined, 42, true]) {
			const snapshot = managedAssistantEventSnapshot(
				{ type: "thinking_delta", contentIndex: 0, delta: delta as unknown as string, partial: message },
				message,
				diagnostics,
			);
			expect(snapshot).toMatchObject({ type: "thinking_delta", delta: "" });
		}
		expect(warnings).toEqual([
			{
				message: "agent: managed snapshot degraded a non-string primitive to an empty value",
				payload: { field: "event.delta", receivedType: "undefined" },
			},
		]);

		for (const delta of [undefined, null, 42, true, 1n]) {
			expect(() =>
				managedAssistantEventSnapshot(
					{ type: "toolcall_delta", contentIndex: 0, delta: delta as unknown as string, partial: message },
					message,
					diagnostics,
				),
			).toThrow(/snapshot/i);
		}
	});
	it("uses one captured tool delta value when an accessor changes between reads", () => {
		const mock = createMockModel();
		const message = assistantMessage(mock.model);
		let reads = 0;
		const event = {
			type: "toolcall_delta",
			contentIndex: 0,
			partial: message,
			get delta(): unknown {
				reads += 1;
				return reads === 1 ? 42 : '{"laundered":true}';
			},
		} as unknown as AssistantMessageEvent;

		expect(() => managedAssistantEventSnapshot(event, message)).toThrow(/snapshot/i);
		expect(reads).toBe(1);
	});
	it("preserves a prototype delta when the event type is an own property", () => {
		const mock = createMockModel();
		const message = assistantMessage(mock.model);
		let reads = 0;
		const prototype = {
			get delta(): string {
				reads += 1;
				return '{"path":"prototype.ts"}';
			},
		};
		const event = Object.assign(Object.create(prototype) as Record<string, unknown>, {
			type: "toolcall_delta",
			contentIndex: 0,
			partial: message,
		}) as unknown as AssistantMessageEvent;

		expect(managedAssistantEventSnapshot(event, message)).toMatchObject({
			type: "toolcall_delta",
			delta: '{"path":"prototype.ts"}',
		});
		expect(reads).toBe(1);
	});
	it("preserves a valid tool delta from a readable proxy event", () => {
		const mock = createMockModel();
		const message = assistantMessage(mock.model);
		const event = new Proxy(
			{
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"path":"proxy.ts"}',
				partial: message,
			} as AssistantMessageEvent,
			{},
		);

		expect(managedAssistantEventSnapshot(event, message)).toMatchObject({
			type: "toolcall_delta",
			delta: '{"path":"proxy.ts"}',
		});
	});
	it("preserves a valid tool delta when unrelated metadata requires sanitization", () => {
		const mock = createMockModel();
		const message = assistantMessage(mock.model);
		const event = {
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"path":"metadata.ts"}',
			partial: message,
			providerMetadata: { sequence: 1n },
		} as unknown as AssistantMessageEvent;

		expect(managedAssistantEventSnapshot(event, message)).toMatchObject({
			type: "toolcall_delta",
			delta: '{"path":"metadata.ts"}',
		});
	});
	it("preserves a literal sentinel-looking delta when no sanitizer produced it", async () => {
		const diagnostics = captureSnapshotDiagnostics();
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(mock.model);
					stream.push({ type: "start", partial });
					stream.push({
						type: "thinking_delta",
						contentIndex: 0,
						delta: "[unserializable]",
						partial,
					});
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
		});
		await agent.prompt("run", { fallbackManaged: true });
		expect(agent.state.error).toBeUndefined();
		expect(diagnostics).toHaveLength(0);
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
		expect(rejected.state.error).toBe("Agent run failed.");
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

	it("repairs payload-class messages and events whose fields live on the prototype", async () => {
		// A provider payload class keeps its fields as prototype getters:
		// `message.role === "assistant"` reads fine live, but `structuredClone`
		// copies only own enumerable properties, so the detached snapshot loses
		// every field. Before the repair this failed the whole managed run as a
		// deterministic `shell.role` local snapshot error (issue #4578 class).
		const mock = createMockModel();
		const base = assistantMessage(mock.model);
		base.content.push({ type: "text", text: "prototype accepted" });
		class PayloadClassAssistantMessage {
			get role(): "assistant" {
				return "assistant";
			}
			get content(): AssistantMessage["content"] {
				return base.content;
			}
			get api(): AssistantMessage["api"] {
				return base.api;
			}
			get provider(): string {
				return base.provider;
			}
			get model(): string {
				return base.model;
			}
			get usage(): AssistantMessage["usage"] {
				return base.usage;
			}
			get stopReason(): AssistantMessage["stopReason"] {
				return base.stopReason;
			}
			get timestamp(): number {
				return base.timestamp;
			}
		}
		const partial = new PayloadClassAssistantMessage() as unknown as AssistantMessage;
		class PayloadClassTextEndEvent {
			get type(): "text_end" {
				return "text_end";
			}
			get contentIndex(): number {
				return 0;
			}
			get content(): string {
				return "prototype accepted";
			}
			get partial(): AssistantMessage {
				return partial;
			}
		}
		const eventTypes: string[] = [];
		let terminalAssistant: AssistantMessage | undefined;
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial });
					stream.push({ type: "text_start", contentIndex: 0, partial });
					stream.push(new PayloadClassTextEndEvent() as unknown as AssistantMessageEvent);
					stream.push({ type: "done", reason: "stop", message: partial });
				});
				return stream;
			},
		});
		agent.subscribe(event => {
			eventTypes.push(event.type);
			if (event.type === "agent_end") {
				terminalAssistant = event.messages.findLast(
					(candidate): candidate is AssistantMessage => candidate.role === "assistant",
				);
			}
		});
		await agent.prompt("run", { fallbackManaged: true });
		expect(agent.state.error).toBeUndefined();
		expectManagedRunStart(eventTypes);
		expect(terminalAssistant).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "prototype accepted" }],
			stopReason: "stop",
		});
		// The repaired shell must be fully detached and JSON-serializable.
		expect(JSON.parse(JSON.stringify(terminalAssistant))).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "prototype accepted" }],
		});
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

	it("repairs descriptor-trap proxy events whose guarded gets stay readable", async () => {
		// A proxy whose only hostility is a throwing getOwnPropertyDescriptor
		// trap defeats structuredClone (and the pre-repair `{ ...event }`
		// spread), but its [[Get]]s deliver a well-formed event. The root
		// repair reads it through guarded gets, so the run completes instead
		// of failing as a deterministic local snapshot error. Truly unreadable
		// proxies (throwing get traps) stay fail-closed — see the
		// collapsed-root-proxy test above.
		const mock = createMockModel();
		const callbacks: AssistantMessageEvent[] = [];
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
			onAssistantMessageEvent: (_message, event) => callbacks.push(event),
		});
		await agent.prompt("run", { fallbackManaged: true });
		expect(agent.state.error).toBeUndefined();
		const deltas = callbacks.filter(event => event.type === "text_delta");
		expect(deltas).toHaveLength(1);
		expect(deltas[0]).toMatchObject({ type: "text_delta", delta: "x" });
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
		expect(agent.state.error).toBe("Agent run failed.");
	});

	it("names the event cap, staged counts, and limits in the surfaced byte-overflow error (#4618)", async () => {
		const mock = createMockModel();
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				partial.content.push({ type: "text", text: "x".repeat(MANAGED_ATTEMPT_MAX_STAGED_BYTES + 1) });
				stream.push({ type: "start", partial });
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});

		await agent.prompt("run", { fallbackManaged: true });
		await agent.waitForIdle();

		// Byte-cap overflow while staging the first assistant payload exposes
		// its authoritative structured diagnostic without leaking the raw error.
		const terminal = agent.state.messages.at(-1) as AssistantMessage;
		expect(terminal.errorKind).toBe("local_buffer_overflow");
		expect(terminal.errorMessage).toBe("Agent run failed.");
		// The single oversized event explains itself through the structured
		// diagnostic: the byte cap tripped on the incoming event's own size.
		// The incoming event is itself larger than the whole byte cap.
		expect(terminal.bufferOverflow!.incomingEventBytes).toBeGreaterThan(MANAGED_ATTEMPT_MAX_STAGED_BYTES);
		// The structured, identity-checked shape rides the terminal message so
		// parent surfaces never have to trust errorMessage.
		expect(terminal.bufferOverflow).toMatchObject({
			stage: "overflow.preMeasure",
			exceeded: "bytes",
			incomingEventBytes: expect.any(Number),
			maxStagedBytes: MANAGED_ATTEMPT_MAX_STAGED_BYTES,
		});
	});

	it("names the event cap when staged events exceed the limit (#4618)", async () => {
		const mock = createMockModel();
		// One tiny update per push, well under the byte cap, so only the
		// EVENT cap can trip. Each event must serialize compactly.
		const streamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial = assistantMessage(mock.model);
				stream.push({ type: "start", partial });
				for (let i = 0; i < MANAGED_ATTEMPT_MAX_STAGED_EVENTS + 1; i++) {
					partial.content = [{ type: "text", text: `t${i}` }];
					stream.push({ type: "text_start", contentIndex: 0, partial });
				}
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
			streamFn,
		});

		await agent.prompt("run", { fallbackManaged: true });
		await agent.waitForIdle();

		const terminal = agent.state.messages.at(-1) as AssistantMessage;
		expect(terminal.errorKind).toBe("local_buffer_overflow");
		expect(terminal.errorMessage).toBe("Agent run failed.");
		// The event cap is the one that tripped: `exceeded` names exactly
		// `events` (never `both`), the staged counter reports the retained
		// post-compaction batch, and the projected event count crosses the
		// limit while projected bytes stay under the byte cap — so a
		// regression that stopped distinguishing an event-only trip fails here.
		expect(terminal.bufferOverflow?.maxStagedEvents).toBe(MANAGED_ATTEMPT_MAX_STAGED_EVENTS);
		expect(terminal.bufferOverflow?.exceeded).toBe("events");
		// Projected events (staged + 1) genuinely exceeded the cap at throw time.
		expect(terminal.bufferOverflow!.stagedEventCount + 1).toBeGreaterThan(terminal.bufferOverflow!.maxStagedEvents);
		// Projected bytes stayed under the byte cap, proving an event-only trip.
		expect(terminal.bufferOverflow!.stagedBytes + terminal.bufferOverflow!.incomingEventBytes).toBeLessThanOrEqual(
			terminal.bufferOverflow!.maxStagedBytes,
		);
	});
});
