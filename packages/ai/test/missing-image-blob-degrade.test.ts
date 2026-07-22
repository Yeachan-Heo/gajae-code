import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@gajae-code/ai/providers/anthropic";
import type { AssistantMessage, Model, ToolResultMessage } from "@gajae-code/ai/types";

/**
 * A resident image externalized to a content-addressed blob is referenced by a
 * `blob:sha256:` sentinel. When the blob goes missing, session materialization
 * bakes a human-readable placeholder into the image content block's `data`
 * (`{type:"image", data:"[Session resident imageData blob missing: …]", mimeType}`).
 *
 * The Anthropic adapter previously forwarded `data` straight into `source.data`,
 * so a non-base64 payload triggered `400 invalid base64 data` on every request —
 * the session bricks, even for a plain text turn. `convertContentBlocks` must
 * accept only standard (RFC 4648) base64 image data and degrade anything else to
 * text, without disturbing valid images (order / MIME preserved).
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

/** Run one tool_result through the production converter and return its content. */
function convertToolResultContent(content: ToolResultMessage["content"]): string | Array<Record<string, unknown>> {
	const id = "toolu_test";
	const params = convertAnthropicMessages([assistantCall(id), toolResult(id, content)], model, false);
	const last = params.at(-1);
	expect(last?.role).toBe("user");
	const blocks = last?.content as unknown as Array<Record<string, unknown>>;
	expect(Array.isArray(blocks)).toBe(true);
	const block = blocks.find(b => b.type === "tool_result");
	expect(block).toBeDefined();
	return block!.content as string | Array<Record<string, unknown>>;
}

function imageBlockOf(content: string | Array<Record<string, unknown>>): Record<string, unknown> | undefined {
	if (typeof content === "string") return undefined;
	return content.find(b => b.type === "image");
}

// Legitimate base64 that must be forwarded unchanged as an image.
const PADDED = Buffer.from("fake image bytes").toString("base64"); // e.g. "ZmFrZSBpbWFnZSBieXRlcw=="
const UNPADDED = PADDED.replace(/=+$/, ""); // same payload, no padding
const KEEP: Record<string, string> = {
	"canonical padded": PADDED,
	"unpadded equivalent": UNPADDED,
	"single-byte padded (YQ==)": "YQ==",
	"single-byte unpadded (YQ)": "YQ",
	"oversized valid": Buffer.from("x".repeat(9000)).toString("base64"),
};

// Payloads that are NOT standard base64 and must degrade to text.
const DEGRADE: Record<string, string> = {
	"missing-blob placeholder": MISSING_IMAGE_PLACEHOLDER,
	"embedded whitespace": "ZmFrZSBp bWFnZSBieXRlcw==",
	"data URL": "data:image/png;base64,ZmFrZQ==",
	"URL-safe alphabet": "abc-_def",
	"length % 4 === 1 (one char)": "a",
	"length % 4 === 1 (five chars)": "abcde",
	"misplaced padding": "ab=c",
	"overlong padding": "YQ===",
	prose: "not base64 at all!!",
	"oversized invalid": `${"prose ".repeat(2000)}!!`,
};

describe("Anthropic image data must be standard base64 (invalid payloads degrade to text)", () => {
	for (const [name, data] of Object.entries(KEEP)) {
		it(`preserves a valid image payload: ${name}`, () => {
			const content = convertToolResultContent([{ type: "image", data, mimeType: "image/png" }]);
			const image = imageBlockOf(content);
			expect(image).toBeDefined();
			const source = image!.source as Record<string, unknown>;
			expect(source.type).toBe("base64");
			expect(source.media_type).toBe("image/png");
			expect(source.data).toBe(data);
		});
	}

	for (const [name, data] of Object.entries(DEGRADE)) {
		it(`degrades a non-base64 image payload to text: ${name}`, () => {
			const content = convertToolResultContent([
				{ type: "text", text: "context" },
				{ type: "image", data, mimeType: "image/webp" },
			]);
			const serialized = JSON.stringify(content);
			expect(imageBlockOf(content)).toBeUndefined();
			expect(serialized).not.toContain('"type":"image"');
			expect(serialized).not.toContain('"source"');
			expect(serialized).toContain("context");
			// Non-empty placeholder text is preserved so the model keeps the context.
			if (data.trim().length > 0) expect(serialized).toContain(data.slice(0, 12).replace(/"/g, ""));
		});
	}

	it("drops an empty image payload without emitting an image block", () => {
		const content = convertToolResultContent([
			{ type: "text", text: "only text" },
			{ type: "image", data: "", mimeType: "image/png" },
		]);
		expect(imageBlockOf(content)).toBeUndefined();
		expect(JSON.stringify(content)).toContain("only text");
	});

	it("preserves block order and MIME for a valid image alongside text", () => {
		const data = PADDED;
		const content = convertToolResultContent([
			{ type: "text", text: "before" },
			{ type: "image", data, mimeType: "image/gif" },
		]);
		expect(Array.isArray(content)).toBe(true);
		const blocks = content as Array<Record<string, unknown>>;
		const textIdx = blocks.findIndex(b => b.type === "text" && String(b.text).includes("before"));
		const imageIdx = blocks.findIndex(b => b.type === "image");
		expect(textIdx).toBeGreaterThanOrEqual(0);
		expect(imageIdx).toBeGreaterThan(textIdx); // text precedes image (existing behavior)
		expect((blocks[imageIdx].source as Record<string, unknown>).media_type).toBe("image/gif");
	});
});
