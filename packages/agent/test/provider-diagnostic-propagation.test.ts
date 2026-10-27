import { afterEach, describe, expect, it, vi } from "bun:test";
import { APIError } from "@anthropic-ai/sdk";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AssistantMessage, Context, Model, StreamFunction } from "@gajae-code/ai";
import { streamAnthropic } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
// Minting is adapter-private: the package `exports` map blocks
// `@gajae-code/ai/adapter-internals/*`, so this test reaches the real adapter
// seam by path to prove that only the adapter can produce a carrier.
import {
	anthropicProviderDiagnosticFromSseErrorData,
	attachProviderDiagnostic,
} from "../../ai/src/adapter-internals/provider-diagnostic";
import { Agent } from "../src/agent";
import { agentLoopContinue } from "../src/agent-loop";
import type { AgentEvent } from "../src/types";

/**
 * The adapter diagnostic is only useful if it survives the Agent boundary on
 * BOTH terminal paths: a provider stream that ends with an error message, and
 * an error thrown into the run. Neither path may change the terminal outcome,
 * the fixed failure message, or the sanitized classifier code.
 */

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const SECRET_MARKER = "sk-ant-secret-DO-NOT-LEAK";

function apiError(status: number, type: string): APIError {
	const message = `provider rejected the request ${SECRET_MARKER}`;
	return APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
}

/** The real Anthropic adapter, driven by a mocked SDK transport. */
function anthropicStreamFn(): StreamFunction<"anthropic-messages"> {
	return (streamModel, context, options) =>
		streamAnthropic(streamModel as Model<"anthropic-messages">, context, {
			...options,
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
}

function createAgent(streamFn: StreamFunction<"anthropic-messages">): Agent {
	return new Agent({
		getApiKey: () => "sk-ant-test",
		initialState: { model, systemPrompt: ["test"], messages: [], tools: [] },
		streamFn: streamFn as never,
	});
}

async function runAgent(
	streamFn: StreamFunction<"anthropic-messages">,
	options?: { fallbackManaged?: boolean },
): Promise<AgentEvent[]> {
	const agent = createAgent(streamFn);
	const events: AgentEvent[] = [];
	const unsubscribe = agent.subscribe(event => events.push(event));
	await agent.prompt("hi", options);
	unsubscribe();
	return events;
}

const anthropicContext: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** Terminal assistant message produced by the REAL Anthropic adapter. */
async function realAdapterFailure(): Promise<AssistantMessage> {
	const stream = streamAnthropic(model, anthropicContext, {
		apiKey: "sk-ant-test",
		providerRetryWait: async () => {},
	});
	for await (const _ of stream) {
		// drain
	}
	return await stream.result();
}

/**
 * Terminal message as it leaves the managed attempt snapshot. Managed runs
 * rebuild every assistant message through `managedAssistantShell`, so this is
 * the seam where a provider-supplied field is either revalidated or copied
 * through raw.
 */
async function managedTerminalMessage(failure: AssistantMessage): Promise<AssistantMessage | undefined> {
	const streamFn = () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: failure });
			stream.push({ type: "error", reason: "error", error: failure });
			stream.end();
		});
		return stream;
	};
	const loop = agentLoopContinue(
		{
			systemPrompt: ["test"],
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [],
		} as never,
		{ model, convertToLlm: (messages: unknown) => messages, fallbackManaged: true } as never,
		undefined,
		streamFn as never,
	);
	let terminal: AssistantMessage | undefined;
	for await (const event of loop) {
		const candidate = event as { type: string; message?: AssistantMessage };
		if (candidate.type === "message_end") terminal = candidate.message;
	}
	await loop.result();
	return terminal;
}

/** A provider failure the managed policy terminalizes instead of retrying. */
function terminalizedAdapterFailure(failure: AssistantMessage): AssistantMessage {
	const message = { ...failure };
	delete (message as { transportFailure?: unknown }).transportFailure;
	delete (message as { errorStatus?: number }).errorStatus;
	return message;
}

function lastAssistantOf(events: AgentEvent[]): AssistantMessage | undefined {
	const end = [...events].reverse().find(event => event.type === "agent_end");
	if (end?.type !== "agent_end") return undefined;
	return [...end.messages].reverse().find(message => message.role === "assistant") as AssistantMessage | undefined;
}

function failureOf(events: AgentEvent[]): { code: string; message: string; providerDiagnostic?: unknown } | undefined {
	const failed = events.find(event => event.type === "agent_failed");
	return failed?.type === "agent_failed" ? failed.error : undefined;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("provider diagnostic propagation through the Agent", () => {
	it("keeps the adapter diagnostic on the terminal assistant message of an errored stream", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				({
					async withResponse(): Promise<never> {
						throw apiError(429, "rate_limit_error");
					},
				}) as never,
		);

		const events = await runAgent(anthropicStreamFn());
		const assistant = lastAssistantOf(events);

		expect(assistant?.stopReason).toBe("error");
		expect((assistant as { providerDiagnostic?: unknown } | undefined)?.providerDiagnostic).toEqual({
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_error",
			evidence: "structured_code",
		});
	});

	it("carries an adapter-minted diagnostic onto agent_failed when the run throws", async () => {
		const envelope = JSON.stringify({
			type: "error",
			error: { type: "overloaded_error", message: `overloaded ${SECRET_MARKER}` },
		});
		const thrown = attachProviderDiagnostic(
			new Error(envelope),
			anthropicProviderDiagnosticFromSseErrorData(envelope),
		);

		const events = await runAgent((() => {
			throw thrown;
		}) as never);
		const failure = failureOf(events);

		expect(failure?.message).toBe("Agent run failed.");
		expect(failure?.providerDiagnostic).toEqual({
			category: "provider_unavailable",
			code: "overloaded_error",
			evidence: "structured_code",
		});
		expect(JSON.stringify(failure)).not.toContain(SECRET_MARKER);

		const assistant = lastAssistantOf(events);
		expect((assistant as { providerDiagnostic?: unknown } | undefined)?.providerDiagnostic).toEqual({
			category: "provider_unavailable",
			code: "overloaded_error",
			evidence: "structured_code",
		});
	});

	it("revalidates the diagnostic across the managed attempt snapshot", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				({
					async withResponse(): Promise<never> {
						throw apiError(401, "authentication_error");
					},
				}) as never,
		);
		const adapterFailure = terminalizedAdapterFailure(await realAdapterFailure());
		expect(adapterFailure.providerDiagnostic).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});

		const preserved = await managedTerminalMessage(adapterFailure);
		expect(preserved?.stopReason).toBe("error");
		expect(preserved?.providerDiagnostic).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});

		// A stream payload that tampers with the field cannot smuggle a forged
		// classification or raw text through the snapshot's metadata copy.
		const tampered = await managedTerminalMessage({
			...adapterFailure,
			providerDiagnostic: {
				category: "quota",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
				detail: `raw ${SECRET_MARKER}`,
			} as never,
		});
		expect(tampered?.stopReason).toBe("error");
		expect(tampered?.providerDiagnostic).toBeUndefined();
		// Scoped to the new field: the legacy `errorMessage` still carries raw
		// provider text here, which is pre-existing behaviour this change neither
		// introduces nor claims to sanitize.
		expect(JSON.stringify(tampered?.providerDiagnostic ?? null)).not.toContain(SECRET_MARKER);
	});

	it("never accepts a self-declared diagnostic from an untrusted thrown error", async () => {
		const forged = Object.assign(new Error("boom"), {
			providerDiagnostic: {
				category: "auth",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
			},
		});

		const events = await runAgent((() => {
			throw forged;
		}) as never);

		expect(failureOf(events)?.providerDiagnostic).toBeUndefined();
		expect(
			(lastAssistantOf(events) as { providerDiagnostic?: unknown } | undefined)?.providerDiagnostic,
		).toBeUndefined();
	});

	it("leaves message-only provider failures undiagnosed and the legacy failure intact", async () => {
		vi.spyOn(Messages.prototype, "create").mockImplementation(
			() =>
				({
					async withResponse(): Promise<never> {
						throw new Error(`HTTP 401 unauthorized ${SECRET_MARKER}`);
					},
				}) as never,
		);

		const events = await runAgent(anthropicStreamFn());
		const assistant = lastAssistantOf(events);

		expect(assistant?.stopReason).toBe("error");
		expect((assistant as { providerDiagnostic?: unknown } | undefined)?.providerDiagnostic).toBeUndefined();
		expect(assistant?.errorStatus).toBe(401);
	});
});
