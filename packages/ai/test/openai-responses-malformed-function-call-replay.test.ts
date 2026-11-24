// Regression: a `function_call` whose `arguments` stream was cut off mid-JSON
// is persisted verbatim in the native Responses history
// (`AssistantMessage.providerPayload`) and replayed on every subsequent turn
// via `buildResponsesInput()`. The gateway rejects the whole request with a
// 400 JSON parse error (parse position == truncated arguments length), and
// the session stays wedged until the item is dropped.
//
// `sanitizeOpenAIResponsesHistoryItemsForReplay` is the canonical replay
// boundary for native Responses history, so the defensive check lives there.
// Related: #3909 (same missing arguments-validation on the chat-completions
// surface).
import { describe, expect, it } from "bun:test";
import { sanitizeOpenAIResponsesHistoryItemsForReplay } from "@gajae-code/ai/utils";

function sanitized(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return sanitizeOpenAIResponsesHistoryItemsForReplay(items) as unknown as Array<Record<string, unknown>>;
}

describe("sanitizeOpenAIResponsesHistoryItemsForReplay drops malformed function_call arguments", () => {
	it("drops a truncated function_call and keeps the surrounding replay items", () => {
		const fullArguments = JSON.stringify({ command: "ls -la /very/deep/path && echo done", i: "List directory" });
		// A stream cut mid-JSON: a true prefix of a valid arguments string.
		const truncatedArguments = fullArguments.slice(0, fullArguments.length - 6);
		expect(() => JSON.parse(truncatedArguments)).toThrow();

		const items = sanitized([
			{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc_1" },
			{
				type: "function_call",
				id: "fc_poisoned",
				call_id: "call_poisoned",
				name: "bash",
				arguments: truncatedArguments,
			},
			{ type: "function_call_output", call_id: "call_poisoned", output: "executed from the durable copy" },
		]);

		// The poisoned call never reaches the next request; its output and the
		// turn's reasoning survive so context is not lost.
		expect(items.some(item => item.type === "function_call")).toBe(false);
		expect(items.map(item => String(item.type))).toEqual(["reasoning", "function_call_output"]);
	});

	it("drops function_call items with missing, empty, or non-string arguments", () => {
		const malformed: Array<Record<string, unknown>> = [
			{ type: "function_call", id: "item_missing", call_id: "call_missing", name: "bash" },
			{ type: "function_call", id: "item_empty", call_id: "call_empty", name: "bash", arguments: "" },
			{ type: "function_call", id: "item_blank", call_id: "call_blank", name: "bash", arguments: "   " },
			{ type: "function_call", id: "item_nonstring", call_id: "call_nonstring", name: "bash", arguments: {} },
		];

		for (const item of malformed) {
			expect(sanitized([item])).toEqual([]);
		}
	});

	it("keeps parseable-JSON arguments byte-for-byte, including no-param and scalar forms", () => {
		const validArguments = [
			JSON.stringify({ command: "echo ok", i: "Say ok" }),
			"{}", // a real no-param provider call
			"null", // JSON scalar
			"42", // JSON scalar
		];

		for (const args of validArguments) {
			const item = { type: "function_call", id: "item_ok", call_id: "call_ok", name: "bash", arguments: args };
			const result = sanitized([item]);
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({ arguments: args });
		}
	});

	it("drops a truncated function_call even when its pair has a completed output", () => {
		const fullTruncated = JSON.stringify({
			command: "curl https://example.com | jq . | sort",
			i: "Endpoints",
		});
		const truncatedArguments = fullTruncated.slice(0, fullTruncated.length - 10);

		const items = sanitized([
			{ type: "function_call", id: "item_ok", call_id: "call_ok", name: "bash", arguments: "{}" },
			{
				type: "function_call",
				id: "item_bad",
				call_id: "call_bad",
				name: "bash",
				arguments: truncatedArguments,
			},
			{ type: "function_call_output", call_id: "call_ok", output: "Mon" },
			{ type: "function_call_output", call_id: "call_bad", output: "result from the durable copy" },
		]);

		const calls = items.filter(item => item.type === "function_call");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ call_id: "call_ok", arguments: "{}" });
		// Orphaned outputs of dropped calls survive this boundary; the
		// downstream orphan repair folds them into an assistant note
		// before the request reaches the wire.
		expect(items.filter(item => item.type === "function_call_output")).toHaveLength(2);
	});
});
