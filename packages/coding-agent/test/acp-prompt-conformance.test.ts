import { describe, expect, test } from "bun:test";
import { acpPromptPayload } from "../src/modes/acp/acp-agent";
import { validateRequiredPromptText } from "../src/sdk/protocol/adapter-validation";

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

	test("image-only prompts retain the image and accept staged IDs only on turn.prompt", () => {
		const payload = acpPromptPayload([{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] as never);
		expect(payload).toEqual({ text: "", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] });
		expect(
			validateRequiredPromptText("turn.prompt", { text: payload.text, stagedImages: [{ id: "host-owned" }] }),
		).toBeUndefined();
		expect(validateRequiredPromptText("turn.prompt", { text: "", stagedImages: [{ id: "" }] })).toMatchObject({
			code: "invalid_input",
		});
		expect(
			validateRequiredPromptText("turn.steer", { text: "", stagedImages: [{ id: "host-owned" }] }),
		).toMatchObject({ code: "invalid_input" });
	});
});
