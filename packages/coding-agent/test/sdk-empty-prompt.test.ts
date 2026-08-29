import { expect, test } from "bun:test";
import { acpPromptPayload } from "../src/modes/acp/acp-agent";
import { runSdkSessionCli } from "../src/sdk/cli/session-cli";
import { dispatchControl } from "../src/sdk/host/control/dispatch";
import { validateRequiredPromptText } from "../src/sdk/protocol/adapter-validation";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry";

const promptOperations = ["turn.prompt", "turn.steer", "turn.follow_up", "turn.abort_and_prompt"] as const;

test("required prompt validation rejects empty and whitespace-only text", () => {
	for (const operation of promptOperations) {
		for (const text of ["", " ", "\n", " \n\t "]) {
			expect(validateRequiredPromptText(operation, { text })).toEqual({
				code: "invalid_input",
				message: "Prompt must not be empty.",
			});
		}
		expect(validateRequiredPromptText(operation, { text: "\n  こんにちは\n" })).toBeUndefined();
	}
	expect(validateRequiredPromptText("turn.prompt", { text: "", images: [{ data: "image-bytes" }] })).toBeUndefined();
	expect(
		validateRequiredPromptText("turn.prompt", {
			text: " \n",
			images: [{ data: "image-bytes", mimeType: "image/png" }],
		}),
	).toBeUndefined();
	expect(validateRequiredPromptText("turn.prompt", { text: "", images: [{ data: "" }] })).toMatchObject({
		code: "invalid_input",
	});
	expect(validateRequiredPromptText("turn.prompt", { text: "", images: [{ mimeType: "image/png" }] })).toMatchObject({
		code: "invalid_input",
	});
});

test("SDK session send rejects empty text before broker startup and operation allocation", async () => {
	for (const args of [
		{ action: "send", sessionId: "missing", text: " \n\t " },
		{ action: "send", sessionId: "missing", jsonInput: JSON.stringify({ text: "\n  \t" }) },
	] as const) {
		const outputs: unknown[] = [];
		const exitCodes: number[] = [];
		await runSdkSessionCli(
			{ ...args, agentDir: "/definitely/not/used" },
			value => outputs.push(value),
			code => exitCodes.push(code),
		);
		expect(outputs).toEqual([{ ok: false, error: { code: "invalid_input", message: "Prompt must not be empty." } }]);
		expect(exitCodes).toEqual([2]);
	}
});

test("control dispatch rejects empty prompts before invoking the surface", async () => {
	let calls = 0;
	const surface = {
		prompt: () => {
			calls++;
			return { accepted: true };
		},
		steer: () => ({ accepted: true }),
		followUp: () => ({ accepted: true }),
		abort: () => ({ aborted: true }),
		abortAndPrompt: () => ({ accepted: true }),
		installedOperations: new Set(promptOperations),
	} as never;
	const row = OPERATIONS.find(operation => operation.sdkId === "turn.prompt");
	const response = await dispatchControl(surface, row, {
		id: "empty",
		operation: "turn.prompt",
		input: { text: "\n\t" },
	});
	expect(response).toMatchObject({
		ok: false,
		error: { code: "invalid_input", message: "Prompt must not be empty." },
	});
	expect(calls).toBe(0);
});

test("direct control preserves non-empty Unicode and multiline prompts", async () => {
	let prompt = "";
	const surface = {
		prompt: (text: string) => {
			prompt = text;
			return { accepted: true };
		},
		steer: () => ({ accepted: true }),
		followUp: () => ({ accepted: true }),
		abort: () => ({ aborted: true }),
		abortAndPrompt: () => ({ accepted: true }),
		installedOperations: new Set(promptOperations),
	} as never;
	const row = OPERATIONS.find(operation => operation.sdkId === "turn.prompt");
	const response = await dispatchControl(surface, row, {
		id: "unicode",
		operation: "turn.prompt",
		input: { text: "第一行\n第二行 — café" },
	});
	expect(response).toMatchObject({ ok: true, result: { accepted: true } });
	expect(prompt).toBe("第一行\n第二行 — café");
});

test("direct control accepts image-only prompts and rejects empty prompts without usable images", async () => {
	let calls = 0;
	const surface = {
		prompt: () => {
			calls++;
			return { accepted: true };
		},
		steer: () => ({ accepted: true }),
		followUp: () => ({ accepted: true }),
		abort: () => ({ aborted: true }),
		abortAndPrompt: () => ({ accepted: true }),
		installedOperations: new Set(promptOperations),
	} as never;
	const row = OPERATIONS.find(operation => operation.sdkId === "turn.prompt");
	const imageOnly = await dispatchControl(surface, row, {
		id: "image-only",
		operation: "turn.prompt",
		input: { text: "\n", images: [{ data: "image-bytes" }] },
	});
	const malformed = await dispatchControl(surface, row, {
		id: "malformed-image",
		operation: "turn.prompt",
		input: { text: "\t", images: [{ data: "" }] },
	});
	expect(imageOnly).toMatchObject({ ok: true, result: { accepted: true } });
	expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_input" } });
	expect(calls).toBe(1);
});

test("ACP image URI metadata cannot make malformed image data usable", () => {
	const payload = acpPromptPayload([
		{ type: "image", data: "", mimeType: "image/png", uri: "https://example.invalid/image.png" },
	] as never);
	expect(validateRequiredPromptText("turn.prompt", payload)).toMatchObject({ code: "invalid_input" });
});
