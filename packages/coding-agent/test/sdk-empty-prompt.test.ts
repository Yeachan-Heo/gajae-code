import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PublicCommandFailure, renderPublicCommandFailure } from "../src/cli/public-command-errors";
import { acpPromptPayload } from "../src/modes/acp/acp-agent";
import { readSecureJsonInputFile, runSdkSessionCli, SDK_JSON_INPUT_FILE_MAX_BYTES } from "../src/sdk/cli/session-cli";
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
		let failure: unknown;
		try {
			await runSdkSessionCli({ ...args, agentDir: "/definitely/not/used" }, value => outputs.push(value));
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(PublicCommandFailure);
		expect(outputs).toEqual([]);
		const rendered = await renderPublicCommandFailure(failure, { command: ["sdk", "session", "send"], json: true });
		expect(rendered.envelope).toMatchObject({
			ok: false,
			error: { code: "usage", category: "usage", outcomeCertainty: "not-applied" },
		});
		expect(rendered.envelope.error.references).not.toContainEqual({
			kind: "operationRef",
			value: expect.any(String),
		});
		expect(rendered.exitCode).toBe(2);
	}
});

test("secure JSON input files are bounded and descriptor-bound", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "gjc-json-input-"));
	try {
		const input = path.join(root, "input.json");
		await fs.writeFile(input, '{"text":"safe"}', { mode: 0o600 });
		expect(await readSecureJsonInputFile(input)).toBe('{"text":"safe"}');

		if (process.platform !== "win32") {
			const link = path.join(root, "input-link.json");
			await fs.symlink(input, link);
			await expect(readSecureJsonInputFile(link)).rejects.toMatchObject({ code: "input_file_unavailable" });
		}

		const oversized = path.join(root, "oversized.json");
		await fs.writeFile(oversized, Buffer.alloc(SDK_JSON_INPUT_FILE_MAX_BYTES + 1), { mode: 0o600 });
		await expect(readSecureJsonInputFile(oversized)).rejects.toMatchObject({ code: "usage" });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
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
