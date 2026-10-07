import { afterEach, describe, expect, it, vi } from "bun:test";
import { APIError } from "@anthropic-ai/sdk";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import { withProviderSafetyStopAdapterInvocation } from "../src/adapter-internals/provider-safety-stop";
import { streamAnthropic as streamAnthropicProvider } from "../src/providers/anthropic";
import type { AssistantMessage, Context, Model } from "../src/types";

/**
 * Provenance rule under test: only trusted Anthropic adapter metadata (a real
 * SDK `APIError` or an explicit SSE protocol error envelope) may produce
 * `providerDiagnostic`. Message text and the legacy heuristic `errorStatus`
 * never do.
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

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

const SECRET_MARKER = "sk-ant-secret-DO-NOT-LEAK";

function apiError(status: number, type: string, message = "provider rejected the request"): APIError {
	return APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
}

function rejectedRequest(error: unknown): { withResponse(): Promise<never> } {
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

function sseErrorFrame(data: string): string {
	return `event: error\ndata: ${data}\n\n`;
}

async function runAdapter(request: unknown): Promise<AssistantMessage> {
	vi.spyOn(Messages.prototype, "create").mockImplementation(() => request as never);
	const stream = trustedStreamAnthropic(model, context, {
		apiKey: "sk-ant-test",
		providerRetryWait: async () => {},
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

describe("anthropic adapter provider diagnostic", () => {
	it("classifies a real 401 SDK APIError from its structured code", async () => {
		const result = await runAdapter(rejectedRequest(apiError(401, "authentication_error")));

		expect(result.stopReason).toBe("error");
		expect(diagnosticOf(result)).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});
	});

	it("classifies structured 400 invalid_request and 5xx api/overloaded errors", async () => {
		expect(diagnosticOf(await runAdapter(rejectedRequest(apiError(400, "invalid_request_error"))))).toEqual({
			category: "invalid_request",
			httpStatus: 400,
			code: "invalid_request_error",
			evidence: "structured_code",
		});
		expect(diagnosticOf(await runAdapter(rejectedRequest(apiError(500, "api_error"))))).toEqual({
			category: "provider_unavailable",
			httpStatus: 500,
			code: "api_error",
			evidence: "structured_code",
		});
		expect(diagnosticOf(await runAdapter(rejectedRequest(apiError(529, "overloaded_error"))))).toEqual({
			category: "provider_unavailable",
			httpStatus: 529,
			code: "overloaded_error",
			evidence: "structured_code",
		});
	});

	it("keeps 402 billing and 403 permission ambiguous instead of guessing quota or auth", async () => {
		expect(diagnosticOf(await runAdapter(rejectedRequest(apiError(402, "billing_error"))))).toEqual({
			category: "unknown",
			httpStatus: 402,
			code: "billing_error",
			evidence: "structured_code",
		});
		expect(diagnosticOf(await runAdapter(rejectedRequest(apiError(403, "permission_error"))))).toEqual({
			category: "unknown",
			httpStatus: 403,
			code: "permission_error",
			evidence: "structured_code",
		});
	});

	it("classifies a structured 429 rate_limit_error but leaves a bare 429 unknown", async () => {
		expect(diagnosticOf(await runAdapter(rejectedRequest(apiError(429, "rate_limit_error"))))).toEqual({
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_error",
			evidence: "structured_code",
		});

		const bare = APIError.generate(
			429,
			{ type: "error", error: { message: "slow down" } },
			"slow down",
			new Headers(),
		);
		expect(diagnosticOf(await runAdapter(rejectedRequest(bare)))).toEqual({
			category: "unknown",
			httpStatus: 429,
			evidence: "structured_status",
		});
	});

	it("discards unsupported codes, including fabricated quota and context tokens", async () => {
		for (const fake of ["insufficient_quota", "context_length_exceeded", SECRET_MARKER]) {
			const result = await runAdapter(rejectedRequest(apiError(429, fake)));
			expect(diagnosticOf(result)).toEqual({
				category: "unknown",
				httpStatus: 429,
				evidence: "structured_status",
			});
			expect(JSON.stringify(diagnosticOf(result))).not.toContain(SECRET_MARKER);
		}
	});

	it("omits the whole diagnostic when status and structured code disagree", async () => {
		expect(diagnosticOf(await runAdapter(rejectedRequest(apiError(401, "rate_limit_error"))))).toBeUndefined();
		expect(diagnosticOf(await runAdapter(rejectedRequest(apiError(500, "authentication_error"))))).toBeUndefined();
	});

	it("omits the diagnostic when the direct and nested structured codes conflict", async () => {
		const conflicting = apiError(401, "authentication_error");
		Object.defineProperty(conflicting, "type", { value: "rate_limit_error", configurable: true });

		expect(diagnosticOf(await runAdapter(rejectedRequest(conflicting)))).toBeUndefined();
	});

	it("omits the diagnostic for an out-of-range or non-integer supplied status", async () => {
		for (const status of [200, 99, 600, 401.5, Number.NaN]) {
			const error = apiError(401, "authentication_error");
			Object.defineProperty(error, "status", { value: status, configurable: true });
			expect(diagnosticOf(await runAdapter(rejectedRequest(error)))).toBeUndefined();
		}

		const stringStatus = apiError(401, "authentication_error");
		Object.defineProperty(stringStatus, "status", { value: "401", configurable: true });
		expect(diagnosticOf(await runAdapter(rejectedRequest(stringStatus)))).toBeUndefined();
	});

	it("omits the diagnostic when reading provider metadata throws", async () => {
		const throwing = apiError(401, "authentication_error");
		Object.defineProperty(throwing, "type", {
			get() {
				throw new Error("hostile getter");
			},
			configurable: true,
		});

		const result = await runAdapter(rejectedRequest(throwing));
		expect(diagnosticOf(result)).toBeUndefined();
		expect(result.stopReason).toBe("error");
	});

	it("refuses structured fields from an error that is not a supported SDK HTTP error", async () => {
		const forged = Object.assign(new Error("compat iterable failed"), {
			status: 401,
			type: "authentication_error",
			error: { type: "error", error: { type: "authentication_error", message: "nope" } },
		});
		expect(diagnosticOf(await runAdapter(rejectedRequest(forged)))).toBeUndefined();
		expect(
			diagnosticOf(await runAdapter(rejectedRequest({ status: 429, type: "rate_limit_error", message: "slow" }))),
		).toBeUndefined();
	});

	it("survives a revoked proxy thrown by the transport without classifying it", async () => {
		const { proxy, revoke } = Proxy.revocable(new Error("revoked"), {});
		revoke();

		const result = await runAdapter(rejectedRequest(proxy));
		expect(diagnosticOf(result)).toBeUndefined();
		expect(result.stopReason).toBe("error");
	});

	it("produces no diagnostic for message-only or legacy-status provider errors", async () => {
		const messageOnly = new Error(`HTTP 401 unauthorized ${SECRET_MARKER}`);
		const messageOnlyResult = await runAdapter(rejectedRequest(messageOnly));
		expect(diagnosticOf(messageOnlyResult)).toBeUndefined();

		const legacyStatusOnly = Object.assign(new Error("request failed"), { errorStatus: 401 });
		expect(diagnosticOf(await runAdapter(rejectedRequest(legacyStatusOnly)))).toBeUndefined();
	});

	it("classifies an explicit SSE error envelope without inventing an HTTP status", async () => {
		const result = await runAdapter(
			rawSseRequest([
				sseErrorFrame(
					JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }),
				),
			]),
		);

		expect(result.stopReason).toBe("error");
		expect(diagnosticOf(result)).toEqual({
			category: "provider_unavailable",
			code: "overloaded_error",
			evidence: "structured_code",
		});
	});

	it("leaves malformed, oversized and unsupported SSE error envelopes undiagnosed", async () => {
		expect(diagnosticOf(await runAdapter(rawSseRequest([sseErrorFrame("{not json")])))).toBeUndefined();
		expect(
			diagnosticOf(
				await runAdapter(
					rawSseRequest([
						sseErrorFrame(
							JSON.stringify({ type: "error", error: { type: "insufficient_quota", message: SECRET_MARKER } }),
						),
					]),
				),
			),
		).toBeUndefined();

		const oversize = JSON.stringify({
			type: "error",
			error: { type: "overloaded_error", message: "x".repeat(70_000) },
		});
		expect(diagnosticOf(await runAdapter(rawSseRequest([sseErrorFrame(oversize)])))).toBeUndefined();
	});

	it("keeps legacy failure fields and retry behaviour byte-identical alongside the diagnostic", async () => {
		let attempts = 0;
		const error = apiError(401, "authentication_error", "invalid x-api-key");
		vi.spyOn(Messages.prototype, "create").mockImplementation(() => {
			attempts += 1;
			return rejectedRequest(error) as never;
		});

		const stream = trustedStreamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			providerRetryWait: async () => {},
		});
		for await (const _ of stream) {
			// drain
		}
		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
		expect(result.errorMessage).toContain("invalid x-api-key");
		expect(diagnosticOf(result)).toEqual({
			category: "auth",
			httpStatus: 401,
			code: "authentication_error",
			evidence: "structured_code",
		});
		expect(new TextEncoder().encode(JSON.stringify(diagnosticOf(result))).length).toBeLessThanOrEqual(512);
	});
});
