import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
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
