import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { transportFailureFacts } from "@gajae-code/ai/utils/fallback-transport";
import { classifyContextOverflow, isContextOverflow } from "@gajae-code/ai/utils/overflow";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow - model_context_window_exceeded", () => {
	it("detects model_context_window_exceeded in finish_reason error message", () => {
		const message = createErrorMessage("Provider finish_reason: model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects raw model_context_window_exceeded in error message", () => {
		const message = createErrorMessage("model_context_window_exceeded");
		expect(isContextOverflow(message)).toBe(true);
	});
});

describe("isContextOverflow - HTTP 413 variants", () => {
	it("detects generic 413 payload-too-large errors", () => {
		const message = createErrorMessage("413 Request Entity Too Large: payload too large for request body");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("detects Anthropic request size overflow wording", () => {
		const message = createErrorMessage("Request exceeds the maximum size allowed by this model");
		expect(isContextOverflow(message)).toBe(true);
	});

	it("does not classify unrelated 413 errors as overflow", () => {
		const message = createErrorMessage("413 Forbidden");
		expect(isContextOverflow(message)).toBe(false);
	});
});

describe("isContextOverflow - 400/413 no-body (Cerebras, Mistral, proxy wrappers)", () => {
	it("detects bare '400 status code (no body)'", () => {
		expect(isContextOverflow(createErrorMessage("400 status code (no body)"))).toBe(true);
	});

	it("detects bare '413 status code (no body)'", () => {
		expect(isContextOverflow(createErrorMessage("413 status code (no body)"))).toBe(true);
	});

	it("detects '400 (no body)' without 'status code' word", () => {
		expect(isContextOverflow(createErrorMessage("400 (no body)"))).toBe(true);
	});

	// Regression: api.synthetic.new wraps upstream HF 400-no-body in a JSON envelope.
	// finalizeErrorMessage transforms the response to "400 status code: {JSON}" where
	// the JSON value contains the inner "400 status code (no body)" text.
	it('detects wrapped proxy envelope: \'400 status code: {"error":"... 400 status code (no body)"}\'', () => {
		const errorMessage = '400 status code: {"error":"Error from inference backend: 400 status code (no body)"}';
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it("detects when status code phrase is embedded deeper in the message", () => {
		const errorMessage = "Upstream rejected request: 400 status code (no body)";
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it("does not classify unrelated 400 errors as overflow", () => {
		expect(isContextOverflow(createErrorMessage("400 Bad Request: invalid API key"))).toBe(false);
	});

	it("does not classify 429 (rate limit) as overflow", () => {
		expect(isContextOverflow(createErrorMessage("429 status code (no body)"))).toBe(false);
	});
});

describe("isContextOverflow - empty response with low usage (proxy-level overflow)", () => {
	function createEmptyStopMessage(input = 1, output = 1): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "spac-litellm",
			model: "zai-org/GLM-5.2",
			usage: {
				input,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("detects empty content with fabricated near-zero usage (LiteLLM proxy)", () => {
		const message = createEmptyStopMessage(1, 1);
		expect(isContextOverflow(message)).toBe(true);
	});

	it("disables only the empty-response heuristic while preserving typed and measured overflow", () => {
		const message = createEmptyStopMessage(1, 1);
		const options = { allowEmptyResponseHeuristic: false };
		expect(classifyContextOverflow(message, undefined, 32768)).toBe(true);
		expect(classifyContextOverflow(message, undefined, 32768, options)).toBe(false);
		for (const providerCode of ["context_length_exceeded", "request_too_large"]) {
			expect(classifyContextOverflow(message, { kind: "transport", providerCode }, 32768, options)).toBe(true);
		}
		expect(classifyContextOverflow(message, { kind: "transport", status: 429 }, 32768, options)).toBe(false);
		expect(classifyContextOverflow(createEmptyStopMessage(32769, 0), undefined, 32768, options)).toBe(true);
	});

	it("detects empty content at threshold boundary (total = 5)", () => {
		const message = createEmptyStopMessage(3, 2);
		expect(isContextOverflow(message)).toBe(true);
	});

	it("does not classify empty content with realistic usage as overflow", () => {
		const message = createEmptyStopMessage(5000, 100);
		expect(isContextOverflow(message)).toBe(false);
	});

	it("does not classify non-empty content with low usage as overflow", () => {
		const message: AssistantMessage = {
			...createEmptyStopMessage(1, 1),
			content: [{ type: "text", text: "ok" }],
		};
		expect(isContextOverflow(message)).toBe(false);
	});

	it("does not classify empty content with non-stop stopReason as overflow", () => {
		const message: AssistantMessage = {
			...createEmptyStopMessage(1, 1),
			stopReason: "length",
		};
		expect(isContextOverflow(message)).toBe(false);
	});
});

describe("classifyContextOverflow - authoritative transport facts", () => {
	it("detects opaque OpenAI context_length_exceeded without relying on provider prose", () => {
		const message = createErrorMessage("");
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				openaiErrorCode: "context_length_exceeded",
			}),
		).toBe(true);
	});

	it.each([
		{ status: 400, openaiErrorCode: "invalid_request_error" },
		{ status: 429, openaiErrorCode: "rate_limit_exceeded" },
	])("does not upgrade typed non-overflow $status failures with hostile overflow prose", transportFailure => {
		const message = createErrorMessage("context_length_exceeded: context window exceeded");
		message.errorStatus = transportFailure.status;
		expect(classifyContextOverflow(message, { kind: "transport", ...transportFailure })).toBe(false);
	});

	it("keeps authoritative rate-limit status ahead of a contradictory overflow provider code", () => {
		const message = createErrorMessage("context window exceeded");
		message.errorStatus = 429;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 429,
				providerCode: "request_too_large",
			}),
		).toBe(false);
	});

	it.each([
		{
			label: "Anthropic request_too_large",
			transportFailure: { status: 413, anthropicErrorType: "request_too_large" },
		},
		{ label: "provider request_too_large", transportFailure: { status: 413, providerCode: "request_too_large" } },
	])("detects opaque typed $label", ({ transportFailure }) => {
		const message = createErrorMessage("");
		message.errorStatus = transportFailure.status;
		expect(classifyContextOverflow(message, { kind: "transport", ...transportFailure })).toBe(true);
	});

	it.each([400, 413])("detects typed status-only %i no-body overflow", status => {
		const message = createErrorMessage("");
		message.errorStatus = status;
		expect(classifyContextOverflow(message, { kind: "transport", status })).toBe(true);
	});

	it("allows unknown typed transport facts to use overflow prose", () => {
		const message = createErrorMessage("context_length_exceeded: context window exceeded");
		message.errorStatus = 418;
		expect(classifyContextOverflow(message, { kind: "transport", status: 418 })).toBe(true);
	});
});

describe("classifyContextOverflow - generic invalid_request_error envelope", () => {
	it("classifies Anthropic prompt-too-long wrapped in invalid_request_error as overflow", () => {
		const message = createErrorMessage(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1158066 tokens > 1000000 maximum"}}',
		);
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
				providerCode: "invalid_request_error",
			}),
		).toBe(true);
	});

	it("keeps a genuine invalid_request_error without overflow prose non-overflow", () => {
		const message = createErrorMessage(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.5.content.1: Invalid `signature` in `thinking` block"}}',
		);
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
				providerCode: "invalid_request_error",
			}),
		).toBe(false);
	});

	it("keeps a specific non-overflow cause authoritative over overflow prose", () => {
		const message = createErrorMessage("rate limited; prompt is too long");
		message.errorStatus = 429;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "rate_limit_error",
			}),
		).toBe(false);
	});
	it("does not let loose overflow prose override the envelope", () => {
		// `too many tokens` is in OVERFLOW_PATTERNS but carries no measurement,
		// so a tool result or model-authored string cannot flip classification.
		const message = createErrorMessage("Tool failed: too many tokens in the uploaded document");
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
			}),
		).toBe(false);
	});

	it("rejects a measurement that does not verify against itself", () => {
		// Injected text mimicking the measured form, but the numbers assert no overage.
		const message = createErrorMessage("prompt is too long: 10 tokens > 1000000 maximum");
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
			}),
		).toBe(false);
	});
	it("accepts a measurement with numbers beyond safe-integer range", () => {
		// Float coercion keeps the comparison true; precision loss cannot flip an overage into equality.
		const message = createErrorMessage("prompt is too long: 99999999999999999999 tokens > 1000000 maximum");
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
			}),
		).toBe(true);
	});

	it.each([
		{ label: "equal used and maximum", text: "prompt is too long: 1000 tokens > 1000 maximum" },
		{ label: "zero maximum", text: "prompt is too long: 5 tokens > 0 maximum" },
	])("rejects a measurement that does not state an overage: $label", ({ text }) => {
		const message = createErrorMessage(text);
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
			}),
		).toBe(false);
	});

	it("accepts a measurement with irregular token-count spacing", () => {
		const message = createErrorMessage("prompt is too long: 12   tokens  >  10  maximum");
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
			}),
		).toBe(true);
	});

	it("extracts a nested measured overflow from quoted or fenced error text", () => {
		const message = createErrorMessage("upstream said:\n```\nprompt is too long: 99 tokens > 98 maximum\n```");
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
			}),
		).toBe(true);
	});

	it("keeps a typed quota code authoritative over the measured overflow form", () => {
		const message = createErrorMessage("prompt is too long: 9 tokens > 8 maximum");
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
				providerCode: "quota_exceeded",
			}),
		).toBe(false);
	});

	it("does not let a non-error stopReason satisfy the measured overflow form", () => {
		const message = createErrorMessage("prompt is too long: 9 tokens > 8 maximum");
		message.stopReason = "stop";
		message.errorStatus = 400;
		expect(
			classifyContextOverflow(message, {
				kind: "transport",
				status: 400,
				anthropicErrorType: "invalid_request_error",
			}),
		).toBe(false);
	});

	it("keeps silent usage accounting overflow detection intact", () => {
		const message = createErrorMessage("");
		message.stopReason = "stop";
		message.usage.input = 1158066;
		expect(classifyContextOverflow(message, undefined, 1000000)).toBe(true);
	});
	it("transport-provenance end-to-end: real transportFailureFacts from an Anthropic-shaped error object", () => {
		// The provider path builds errors as { status, error: { type, message } };
		// facts extraction must surface anthropicErrorType for the classifier.
		const facts = transportFailureFacts({
			status: 400,
			error: { type: "invalid_request_error", message: "prompt is too long: 1158066 tokens > 1000000 maximum" },
		});
		expect(facts?.anthropicErrorType).toBe("invalid_request_error");
		const message = createErrorMessage(
			'{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1158066 tokens > 1000000 maximum"}}',
		);
		message.errorStatus = 400;
		expect(classifyContextOverflow(message, facts)).toBe(true);
	});
});
