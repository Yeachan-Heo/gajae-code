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
});
