import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Model, ToolResultMessage } from "@gajae-code/ai/types";

/**
 * A resident image externalized to a content-addressed blob is referenced by a
 * `blob:sha256:` sentinel. When the blob goes missing, session materialization
 * bakes a human-readable placeholder into the image block's `data`. The
 * Anthropic adapter previously forwarded that placeholder as `source.data`,
 * yielding `400 invalid base64 data` on every request — the session bricks,
 * even for a plain text turn. A non-base64 image payload must degrade to text.
 */

const model: Model<"anthropic-messages"> = {
	api: "anthropic-messages",
	id: "claude-3-5-sonnet-20241022",
	name: "Claude 3.5 Sonnet",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8192,
	contextWindow: 200000,
	reasoning: false,
};

const MISSING_IMAGE_PLACEHOLDER = `[Session resident imageData blob missing: sha256:${"0".repeat(64)}; original content unavailable]`;

function assistantCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-3-5-sonnet-20241022",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(id: string, content: ToolResultMessage["content"]): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: Date.now() };
}

function lastToolResultBlock(params: ReturnType<typeof convertAnthropicMessages>): Record<string, unknown> {
	const last = params.at(-1);
	expect(last?.role).toBe("user");
	const blocks = last?.content as unknown as Array<Record<string, unknown>>;
	expect(Array.isArray(blocks)).toBe(true);
	const block = blocks.find(b => b.type === "tool_result");
	expect(block).toBeDefined();
	return block as Record<string, unknown>;
}

describe("missing resident image blob degrades to text (no invalid base64 image)", () => {
	it("degrades a non-base64 image payload to text so the request stays valid", () => {
		const id = "toolu_missing";
		const params = convertAnthropicMessages(
			[
				assistantCall(id),
				toolResult(id, [
					{ type: "text", text: "Read image file [image/webp]" },
					{ type: "image", data: MISSING_IMAGE_PLACEHOLDER, mimeType: "image/webp" },
				]),
			],
			model,
			false,
		);
		const block = lastToolResultBlock(params);
		const serialized = JSON.stringify(block.content);
		// No image block survives, and no placeholder leaks into a base64 source.
		expect(serialized).not.toContain('"type":"image"');
		expect(serialized).not.toContain('"source"');
		// The placeholder is preserved as text so the model still sees the context.
		expect(serialized).toContain("blob missing");
	});

	it("preserves a valid base64 image as an image block", () => {
		const id = "toolu_ok";
		const data = Buffer.from("fake image bytes").toString("base64");
		const params = convertAnthropicMessages(
			[assistantCall(id), toolResult(id, [{ type: "image", data, mimeType: "image/png" }])],
			model,
			false,
		);
		const block = lastToolResultBlock(params);
		const inner = block.content as Array<Record<string, unknown>>;
		expect(Array.isArray(inner)).toBe(true);
		const image = inner.find(b => b.type === "image") as { source: Record<string, unknown> } | undefined;
		expect(image).toBeDefined();
		expect(image?.source.type).toBe("base64");
		expect(image?.source.data).toBe(data);
		expect(image?.source.media_type).toBe("image/png");
	});
});
