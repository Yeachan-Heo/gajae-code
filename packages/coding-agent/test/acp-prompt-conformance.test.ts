import { describe, expect, test } from "bun:test";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { acpPromptPayload } from "../src/modes/acp/acp-agent";

/**
 * ACP conformance regressions found while smoke-testing GJC against the Paseo
 * ACP client (CLI/daemon 0.2.5).
 */
describe("ACP prompt conformance", () => {
	test("prompt payload keeps image blocks so attachments reach the model", () => {
		const payload = acpPromptPayload([
			{ type: "text", text: "what colors?" },
			{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
		] as never);

		expect(payload.text).toBe("what colors?");
		expect(payload.images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
	});

	test("standard image-only prompts preserve ordered bytes and MIME without private upload descriptors", () => {
		const first = Buffer.from([0, 255, 1, 254]);
		const second = Buffer.from([128, 0, 129]);
		const request: PromptRequest = {
			sessionId: "standard-acp-session",
			prompt: [
				{
					type: "image",
					mimeType: "image/png",
					data: first.toString("base64"),
					uri: "file:///client-only.png",
					_meta: { id: "not-an-upload-id" },
				},
				{ type: "image", mimeType: "image/webp", data: second.toString("base64") },
			],
		};
		const payload = acpPromptPayload(request.prompt);
		expect(payload).toEqual({
			text: "",
			images: [
				{ data: first.toString("base64"), mimeType: "image/png" },
				{ data: second.toString("base64"), mimeType: "image/webp" },
			],
		});
		expect(payload.images.map(image => Buffer.from(image.data, "base64"))).toEqual([first, second]);
	});

	test("an oversize prompt frame is refused before it reaches the 256 KiB transport cap", () => {
		// The SDK WebSocket server sets max_message_size/max_frame_size to
		// REQUEST_FRAME_BYTES (crates/gjc-sdk/src/query.rs) and answers an oversize
		// frame by closing the socket, which reaches the client as an opaque
		// connection_closed. The prompt must be measured against the same ceiling.
		const limit = 256 * 1024;
		const oversize = acpPromptPayload([
			{ type: "image", mimeType: "image/png", data: "A".repeat(limit + 1_000) },
		] as never);
		const frameBytes = Buffer.byteLength(JSON.stringify({ text: oversize.text, images: oversize.images }));
		expect(frameBytes).toBeGreaterThan(limit);

		const withinLimit = acpPromptPayload([
			{ type: "image", mimeType: "image/png", data: "A".repeat(1_000) },
		] as never);
		const smallBytes = Buffer.byteLength(JSON.stringify({ text: withinLimit.text, images: withinLimit.images }));
		expect(smallBytes).toBeLessThan(limit);
	});
});
