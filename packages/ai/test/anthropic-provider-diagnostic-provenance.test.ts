import { afterEach, describe, expect, it, vi } from "bun:test";
import { APIError } from "@anthropic-ai/sdk";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { withProviderSafetyStopAdapterInvocation } from "../src/adapter-internals/provider-safety-stop";
import { streamAnthropic as streamAnthropicProvider } from "../src/providers/anthropic";
import type { AssistantMessage, Context, Model } from "../src/types";

/**
 * Provenance, not shape: only a failure raised by the SDK's own
 * request/response transport may be classified. A `status`/`type`-bearing
 * object thrown from an adapter callback never crossed the wire, and
 * `instanceof APIError` cannot tell the difference — the public SDK
 * constructor and `APIError.generate` are callable by anyone, and a forged
 * prototype passes the same check.
 */

type AnthropicStreamOptions = NonNullable<Parameters<typeof streamAnthropicProvider>[2]>;

function trustedStreamAnthropic(model: Model<"anthropic-messages">, context: Context, options: AnthropicStreamOptions) {
	return streamAnthropicProvider(model, context, withProviderSafetyStopAdapterInvocation(options));
}

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

const context: Context = { messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }] };
const SECRET_MARKER = "sk-ant-secret-PROVENANCE";

function genuineApiError(status: number, type: string): APIError {
	const message = `provider rejected the request ${SECRET_MARKER}`;
	return APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
}

/** An object that passes `instanceof APIError` without ever being thrown by the SDK. */
function forgedApiError(status: number, type: string): object {
	const forged = Object.create(APIError.prototype) as Record<string, unknown>;
	forged.status = status;
	forged.type = type;
	forged.error = { type: "error", error: { type, message: `forged ${SECRET_MARKER}` } };
	forged.message = `forged ${SECRET_MARKER}`;
	return forged;
}

function rejectedTransport(error: unknown): { withResponse(): Promise<never> } {
	return {
		async withResponse(): Promise<never> {
			throw error;
		},
	};
}

function rawSseRequest(frames: string[]): { asResponse(): Promise<Response> } {
	const body = new TextEncoder().encode(frames.join(""));
	return {
		async asResponse() {
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream", "request-id": "req_raw_mock" },
			});
		},
	};
}

async function runAdapter(options: AnthropicStreamOptions, request?: unknown): Promise<AssistantMessage> {
	if (request !== undefined) {
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => request as never);
	}
	const stream = trustedStreamAnthropic(model, context, {
		apiKey: "sk-ant-test",
		providerRetryWait: async () => {},
		...options,
	});
	for await (const _ of stream) {
		// drain
	}
	return await stream.result();
}

function diagnosticOf(message: AssistantMessage): unknown {
	return (message as AssistantMessage & { providerDiagnostic?: unknown }).providerDiagnostic;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic provider diagnostic provenance", () => {
	it("does not classify an SDK APIError thrown by the onPayload callback", async () => {
		let requested = 0;
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			requested += 1;
			return rejectedTransport(new Error("unused")) as never;
		});

		const result = await runAdapter({
			onPayload: () => {
				throw genuineApiError(401, "authentication_error");
			},
		});

		// The request never happened, so there is no HTTP evidence to classify.
		expect(requested).toBe(0);
		expect(result.stopReason).toBe("error");
		expect(diagnosticOf(result)).toBeUndefined();
	});

	it("does not classify an SDK APIError thrown by the onStreamCreated callback", async () => {
		const result = await runAdapter(
			{
				onStreamCreated: () => {
					throw genuineApiError(429, "rate_limit_error");
				},
			},
			rejectedTransport(new Error("unused")),
		);

		expect(result.stopReason).toBe("error");
		expect(diagnosticOf(result)).toBeUndefined();
	});

	it("does not classify a forged APIError prototype thrown from a callback", async () => {
		const result = await runAdapter({
			onStreamCreated: () => {
				throw forgedApiError(401, "authentication_error");
			},
		});

		expect(result.stopReason).toBe("error");
		expect(diagnosticOf(result)).toBeUndefined();
		expect(JSON.stringify(diagnosticOf(result) ?? null)).not.toContain(SECRET_MARKER);
	});

	it("does not classify an SDK APIError thrown by a stream-consumption callback", async () => {
		// The SSE pipeline is the adapter's own; a caller callback invoked while it
		// runs is not transport evidence, even though it throws the same type.
		//
		// Honest scope: this is a REGRESSION CONFIRMATION, not an R5-sensitive
		// assertion. The SSE reader swallows the callback failure and the adapter
		// surfaces its own envelope error ("stream ended before message_stop"), so
		// no HTTP-shaped error reaches the outer catch either way — verified by
		// re-running this test against the pre-R5 outer-catch classification, where
		// it also passes (evidence/mutation-R5-stream-callback.log). It exists to
		// keep that path undiagnosed if the pipeline ever starts propagating the
		// raw callback error.
		const frames = [
			`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
		];
		let callbackInvocations = 0;
		const result = await runAdapter(
			{
				client: { messages: { create: () => rawSseRequest(frames) } } as never,
				onSseEvent: () => {
					callbackInvocations += 1;
					throw genuineApiError(401, "authentication_error");
				},
			},
			rawSseRequest(frames),
		);

		// The assertion below is only meaningful if the callback actually ran.
		expect(callbackInvocations).toBeGreaterThan(0);
		expect(result.stopReason).toBe("error");
		expect(diagnosticOf(result)).toBeUndefined();
		expect(JSON.stringify(diagnosticOf(result) ?? null)).not.toContain(SECRET_MARKER);
	});

	it("still classifies a genuine transport rejection, direct and nested", async () => {
		const direct = await runAdapter({}, rejectedTransport(genuineApiError(401, "authentication_error")));
		expect(diagnosticOf(direct)).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});

		// Nested-only: the SDK's `type` is absent but the response body carries it.
		const nestedOnly = APIError.generate(
			429,
			{ type: "error", error: { type: "rate_limit_error", message: "slow down" } },
			"slow down",
			new Headers(),
		);
		Object.defineProperty(nestedOnly, "type", { value: null, configurable: true });
		const nested = await runAdapter({}, rejectedTransport(nestedOnly));
		expect(diagnosticOf(nested)).toEqual({
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_error",
			evidence: "structured_code",
		});
	});

	it("keeps the SSE protocol envelope classification and its legacy negative", async () => {
		const sse = await runAdapter(
			{},
			rawSseRequest([
				`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } })}\n\n`,
			]),
		);
		expect(diagnosticOf(sse)).toEqual({
			category: "provider_unavailable",
			code: "overloaded_error",
			evidence: "structured_code",
		});

		const legacy = await runAdapter({}, rejectedTransport(new Error(`HTTP 401 unauthorized ${SECRET_MARKER}`)));
		expect(diagnosticOf(legacy)).toBeUndefined();
		expect(legacy.errorStatus).toBe(401);
	});

	it("refuses a malformed nested response record from a genuine transport error", async () => {
		const malformedNested = APIError.generate(
			401,
			{ type: "error", error: ["not", "a", "record"] },
			"bad",
			new Headers(),
		);
		Object.defineProperty(malformedNested, "type", { value: null, configurable: true });
		const result = await runAdapter({}, rejectedTransport(malformedNested));

		// No usable code; the status alone is still trustworthy transport evidence.
		expect(diagnosticOf(result)).toEqual({ category: "auth", httpStatus: 401, evidence: "structured_status" });
	});
});
