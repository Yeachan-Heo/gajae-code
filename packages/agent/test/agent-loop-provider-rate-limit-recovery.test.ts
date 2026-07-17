import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "@gajae-code/agent-core/types";
import type { AssistantMessage, Message, Model } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { trace } from "@opentelemetry/api";
import { createAssistantMessage, createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

function context(tools: AgentTool[] = []): AgentContext {
	return { systemPrompt: ["test"], messages: [], tools };
}

function responseStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		stream.end(message);
	});
	return stream;
}

function rateLimitMessage(model: Model): AssistantMessage {
	return {
		...createAssistantMessage([], "error"),
		provider: model.provider,
		model: model.id,
		errorMessage: "rate limited",
		errorStatus: 429,
		transportFailure: { kind: "transport", status: 429 },
	};
}

async function run(
	model: Model,
	scope: object,
	streamFn: StreamFn,
	tools: AgentTool[] = [],
	signal?: AbortSignal,
	overrides: Partial<AgentLoopConfig> = {},
) {
	const config: AgentLoopConfig = {
		...overrides,
		model,
		convertToLlm: identityConverter,
		providerRateLimitScope: scope,
	};
	const stream = agentLoop([createUserMessage("test")], context(tools), config, signal, streamFn);
	for await (const _event of stream) {
		// Drain the externally observable event path.
	}
	return await stream.result();
}

describe("agent loop provider rate-limit recovery integration", () => {
	it("keeps twelve healthy model streams unrestricted and strips opaque scope before StreamFn", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		let dispatched = 0;
		const streamFn: StreamFn = (_model, _context, options) => {
			dispatched += 1;
			expect(options).toBeDefined();
			expect(Object.hasOwn(options ?? {}, "providerRateLimitScope")).toBe(false);
			return responseStream(createAssistantMessage([{ type: "text", text: "ok" }]));
		};

		await Promise.all(Array.from({ length: 12 }, () => run(model, scope, streamFn)));
		expect(dispatched).toBe(12);
	});

	it("turns twelve post-429 logical streams into one probe and settles it before returning", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		await run(model, scope, () => responseStream(rateLimitMessage(model)));

		const probe = new AssistantMessageEventStream();
		let dispatched = 0;
		const probeDispatched = Promise.withResolvers<void>();
		const streamFn: StreamFn = () => {
			dispatched += 1;
			if (dispatched === 1) {
				probeDispatched.resolve();
				return probe;
			}
			return responseStream(createAssistantMessage([{ type: "text", text: "recovered" }]));
		};
		const pending = Array.from({ length: 12 }, () => run(model, scope, streamFn));
		await probeDispatched.promise;

		expect(dispatched).toBe(1);
		expect(((12 - dispatched) / 12) * 100).toBeCloseTo(91.7, 1);
		const recovered = createAssistantMessage([{ type: "text", text: "probe succeeded" }]);
		probe.push({ type: "done", reason: "stop", message: recovered });
		probe.end(recovered);

		await Promise.all(pending);
		expect(dispatched).toBe(12);
	});

	it("does not dispatch a pre-aborted acquisition while a same-key probe is in flight", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		await run(model, scope, () => responseStream(rateLimitMessage(model)));

		const probe = new AssistantMessageEventStream();
		let dispatched = 0;
		const streamFn: StreamFn = () => {
			dispatched += 1;
			return probe;
		};
		const activeProbe = run(model, scope, streamFn);
		await Promise.resolve();
		const controller = new AbortController();
		controller.abort();
		const aborted = await run(model, scope, streamFn, [], controller.signal);

		expect(dispatched).toBe(1);
		const final = aborted[aborted.length - 1];
		expect(final?.role).toBe("assistant");
		if (final?.role === "assistant") expect(final.stopReason).toBe("aborted");
		const success = createAssistantMessage([{ type: "text", text: "probe succeeded" }]);
		probe.push({ type: "done", reason: "stop", message: success });
		probe.end(success);
		await activeProbe;
	});

	it("does not hold the model-stream recovery gate during local tool execution", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		await run(model, scope, () => responseStream(rateLimitMessage(model)));

		const toolEntered = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		const tool: AgentTool = {
			name: "local",
			label: "local",
			description: "A deliberately held local operation.",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				toolEntered.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		let dispatched = 0;
		const siblingDispatched = Promise.withResolvers<void>();
		const streamFn: StreamFn = () => {
			dispatched += 1;
			if (dispatched === 1) {
				return responseStream(
					createAssistantMessage([{ type: "toolCall", id: "local-1", name: "local", arguments: {} }], "toolUse"),
				);
			}
			siblingDispatched.resolve();
			return responseStream(createAssistantMessage([{ type: "text", text: "ok" }]));
		};

		const toolRun = run(model, scope, streamFn, [tool]);
		await toolEntered.promise;
		const siblingRun = run(model, scope, streamFn);
		await siblingDispatched.promise;
		expect(dispatched).toBe(2);

		releaseTool.resolve();
		await Promise.all([toolRun, siblingRun]);
	});

	it("isolates recovery by opaque scope, provider, and model key", async () => {
		const base = createMockModel().model;
		const scope = Object.freeze({});
		await run(base, scope, () => responseStream(rateLimitMessage(base)));
		const alternateScope = Object.freeze({});
		const alternateProvider = { ...base, provider: `${base.provider}-alternate` };
		const alternateModel = { ...base, id: `${base.id}-alternate` };
		let dispatched = 0;
		const streamFn: StreamFn = () => {
			dispatched += 1;
			return responseStream(createAssistantMessage([{ type: "text", text: "isolated" }]));
		};

		await Promise.all([
			run(base, alternateScope, streamFn),
			run(alternateProvider, scope, streamFn),
			run(alternateModel, scope, streamFn),
		]);
		expect(dispatched).toBe(3);
	});
	it("settles a rejected credential resolver and promotes exactly one queued successor", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		await run(model, scope, () => responseStream(rateLimitMessage(model)));

		const resolverEntered = Promise.withResolvers<void>();
		const rejectResolver = Promise.withResolvers<string | undefined>();
		let dispatched = 0;
		const streamFn: StreamFn = () => {
			dispatched += 1;
			return responseStream(createAssistantMessage([{ type: "text", text: "recovered" }]));
		};
		const failed = run(model, scope, streamFn, [], undefined, {
			getApiKey: () => {
				resolverEntered.resolve();
				return rejectResolver.promise;
			},
		});
		await resolverEntered.promise;
		const successor = run(model, scope, streamFn);
		rejectResolver.reject(new Error("credential lookup failed"));
		await expect(failed).rejects.toThrow("credential lookup failed");
		await successor;

		expect(dispatched).toBe(1);
	});

	it("settles an abort during credential lookup without dispatching the aborted probe", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		await run(model, scope, () => responseStream(rateLimitMessage(model)));

		const resolverEntered = Promise.withResolvers<void>();
		const credential = Promise.withResolvers<string | undefined>();
		const controller = new AbortController();
		let dispatched = 0;
		const streamFn: StreamFn = () => {
			dispatched += 1;
			return responseStream(createAssistantMessage([{ type: "text", text: "recovered" }]));
		};
		const aborted = run(model, scope, streamFn, [], controller.signal, {
			getApiKey: () => {
				resolverEntered.resolve();
				return credential.promise;
			},
		});
		await resolverEntered.promise;
		const successor = run(model, scope, streamFn);
		controller.abort();
		await aborted;
		credential.resolve("late-token");
		await successor;

		expect(dispatched).toBe(1);
	});

	it("promotes one queued successor after a probe's terminal 429", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		await run(model, scope, () => responseStream(rateLimitMessage(model)));

		const probe = new AssistantMessageEventStream();
		const probeDispatched = Promise.withResolvers<void>();
		let dispatched = 0;
		const streamFn: StreamFn = () => {
			dispatched += 1;
			if (dispatched === 1) {
				probeDispatched.resolve();
				return probe;
			}
			return responseStream(createAssistantMessage([{ type: "text", text: "recovered" }]));
		};
		const active = run(model, scope, streamFn);
		await probeDispatched.promise;
		const successor = run(model, scope, streamFn);
		const terminal = rateLimitMessage(model);
		probe.push({ type: "done", reason: "stop", message: terminal });
		probe.end(terminal);
		await Promise.all([active, successor]);

		expect(dispatched).toBe(2);
	});

	it("promotes one queued successor after a probe's terminal non-429 error", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		await run(model, scope, () => responseStream(rateLimitMessage(model)));

		const probe = new AssistantMessageEventStream();
		const probeDispatched = Promise.withResolvers<void>();
		const terminal = {
			...createAssistantMessage([], "error"),
			provider: model.provider,
			model: model.id,
			errorStatus: 503,
		};
		let dispatched = 0;
		const streamFn: StreamFn = () => {
			dispatched += 1;
			if (dispatched === 1) {
				probeDispatched.resolve();
				return probe;
			}
			return responseStream(createAssistantMessage([{ type: "text", text: "recovered" }]));
		};
		const active = run(model, scope, streamFn);
		await probeDispatched.promise;
		const successor = run(model, scope, streamFn);
		probe.push({ type: "done", reason: "stop", message: terminal });
		probe.end(terminal);
		await Promise.all([active, successor]);

		expect(dispatched).toBe(2);
	});

	it("settles synchronous post-admission setup failures and promotes a queued successor", async () => {
		const model = createMockModel().model;
		const delegateTracer = trace.getTracer("provider-rate-limit-recovery-test");
		const scenarios: Array<{
			name: string;
			overrides(error: Error): Partial<AgentLoopConfig>;
			streamThrows?: boolean;
		}> = [
			{
				name: "auth credential type",
				overrides: error => ({
					getAuthCredentialType: () => {
						throw error;
					},
				}),
			},
			{
				name: "metadata",
				overrides: error => ({
					metadataResolver: () => {
						throw error;
					},
				}),
			},
			{
				name: "chat telemetry",
				overrides: error => ({
					telemetry: {
						tracer: {
							startSpan: (name: string, options: never, activeContext: never) => {
								if (name.startsWith("chat ")) throw error;
								return delegateTracer.startSpan(name, options, activeContext);
							},
						} as never,
					},
				}),
			},
			{
				name: "synchronous stream",
				overrides: () => ({}),
				streamThrows: true,
			},
		];

		for (const scenario of scenarios) {
			const scope = Object.freeze({});
			await run(model, scope, () => responseStream(rateLimitMessage(model)));
			const credentialEntered = Promise.withResolvers<void>();
			const releaseCredential = Promise.withResolvers<string | undefined>();
			const error = new Error(`${scenario.name} setup failed`);
			let dispatched = 0;
			const streamFn: StreamFn = () => {
				dispatched += 1;
				if (scenario.streamThrows && dispatched === 1) throw error;
				return responseStream(createAssistantMessage([{ type: "text", text: "recovered" }]));
			};
			const failed = run(model, scope, streamFn, [], undefined, {
				...scenario.overrides(error),
				getApiKey: () => {
					credentialEntered.resolve();
					return releaseCredential.promise;
				},
			});
			const failure = failed.catch(reason => reason);
			await credentialEntered.promise;
			const successor = run(model, scope, streamFn);
			releaseCredential.resolve("token");

			expect(await failure).toBe(error);
			await successor;
			expect(dispatched).toBe(scenario.streamThrows ? 2 : 1);
		}
	});
	it("settles a rejected stream setup and promotes exactly one queued successor", async () => {
		const model = createMockModel().model;
		const scope = Object.freeze({});
		await run(model, scope, () => responseStream(rateLimitMessage(model)));

		const rejectSetup = Promise.withResolvers<AssistantMessageEventStream>();
		let dispatched = 0;
		const streamFn: StreamFn = () => {
			dispatched += 1;
			return dispatched === 1
				? rejectSetup.promise
				: responseStream(createAssistantMessage([{ type: "text", text: "recovered" }]));
		};
		const failed = run(model, scope, streamFn);
		const successor = run(model, scope, streamFn);
		rejectSetup.reject(new Error("stream setup failed"));
		await expect(failed).rejects.toThrow("stream setup failed");
		await successor;

		expect(dispatched).toBe(2);
	});
});
