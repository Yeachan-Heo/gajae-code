import { describe, expect, it } from "bun:test";
import { isReasoningContentReplayError, stripUnusableReasoningItems } from "../src/utils";

// DeepSeek-family reasoning-content replay rejection: the encrypted reasoning
// blob was proxy-stripped to "", so replaying it 400s deterministically with
// "reasoning_content ... must be passed back to the API". The classifier and the
// strip repair are the shared contract the agent-loop circuit breaker keys on.

describe("isReasoningContentReplayError shared classifier", () => {
	it("detects the exact DeepSeek-family error across message carrier shapes", () => {
		const exact =
			"400 Error from provider (Console): Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.";
		expect(isReasoningContentReplayError(exact)).toBe(true);
		expect(isReasoningContentReplayError({ errorMessage: exact })).toBe(true);
		expect(isReasoningContentReplayError({ message: exact })).toBe(true);
	});

	it("detects the message-form variants (reasoning_content vs reasoning content)", () => {
		expect(
			isReasoningContentReplayError("The reasoning_content in the thinking mode must be passed back to the API."),
		).toBe(true);
		expect(
			isReasoningContentReplayError("The reasoning content in the thinking mode must be passed back to the API."),
		).toBe(true);
	});

	it("matches even when the phrase spans newlines (multi-line upstream errors)", () => {
		const multiline =
			"Upstream request failed:\n[invalid_request_error] The `reasoning_content`\nin the thinking mode\nmust be passed back to the API.";
		expect(isReasoningContentReplayError(multiline)).toBe(true);
	});

	it("does NOT fire on other error classes (negative)", () => {
		expect(isReasoningContentReplayError("The server had an error (code=server_error)")).toBe(false);
		expect(isReasoningContentReplayError("Request blocked (code=invalid_prompt)")).toBe(false);
		expect(isReasoningContentReplayError({ errorMessage: "rate limit exceeded" })).toBe(false);
		expect(isReasoningContentReplayError({ code: "invalid_request_error", message: "max_tokens too low" })).toBe(
			false,
		);
	});

	it("does NOT fire on empty / non-error inputs (negative)", () => {
		expect(isReasoningContentReplayError(undefined)).toBe(false);
		expect(isReasoningContentReplayError(null)).toBe(false);
		expect(isReasoningContentReplayError("")).toBe(false);
		expect(isReasoningContentReplayError(42)).toBe(false);
	});
});

describe("stripUnusableReasoningItems", () => {
	it("removes reasoning items with empty encrypted_content", () => {
		const items = [
			{ type: "reasoning", encrypted_content: "", summary: [{ type: "summary_text", text: "x" }] },
			{ type: "output_text", text: "hello" },
		];
		const { result, removed } = stripUnusableReasoningItems(items);
		expect(removed).toBe(1);
		expect(result).toEqual([{ type: "output_text", text: "hello" }]);
	});

	it("removes reasoning items with missing encrypted_content", () => {
		const items = [
			{ type: "reasoning", summary: [{ type: "summary_text", text: "no blob" }] },
			{ type: "function_call", name: "read", arguments: "{}" },
		];
		const { result, removed } = stripUnusableReasoningItems(items);
		expect(removed).toBe(1);
		expect(result).toEqual([{ type: "function_call", name: "read", arguments: "{}" }]);
	});

	it("removes reasoning items with null encrypted_content", () => {
		const items = [{ type: "reasoning", encrypted_content: null }];
		const { result, removed } = stripUnusableReasoningItems(items);
		expect(removed).toBe(1);
		expect(result).toEqual([]);
	});

	it("preserves reasoning items that have non-empty encrypted_content", () => {
		const reasoning = {
			type: "reasoning",
			encrypted_content: "OpaqueBlobSignature==",
			summary: [{ type: "summary_text", text: "valid" }],
		};
		const items = [reasoning, { type: "output_text", text: "hello" }];
		const { result, removed } = stripUnusableReasoningItems(items);
		expect(removed).toBe(0);
		expect(result).toEqual(items);
	});

	it("preserves all non-reasoning items verbatim (order, identity)", () => {
		const items = [
			{ type: "reasoning", encrypted_content: "" },
			{ type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
			{ type: "reasoning", encrypted_content: "" },
			{ type: "function_call_output", call_id: "c1", output: "ok" },
			{ type: "output_text", text: "done" },
		];
		const { result, removed } = stripUnusableReasoningItems(items);
		expect(removed).toBe(2);
		expect(result).toEqual([
			{ type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "c1", output: "ok" },
			{ type: "output_text", text: "done" },
		]);
	});

	it("returns removed=0 for an empty array", () => {
		const { result, removed } = stripUnusableReasoningItems([]);
		expect(removed).toBe(0);
		expect(result).toEqual([]);
	});

	it("reports removed=0 when nothing is strip-eligible", () => {
		const items = [{ type: "output_text", text: "only text" }];
		const { result, removed } = stripUnusableReasoningItems(items);
		expect(removed).toBe(0);
		expect(result).toEqual(items);
	});
});
