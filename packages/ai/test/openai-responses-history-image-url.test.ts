import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@gajae-code/ai/models";
import { streamOpenAICodexResponses } from "@gajae-code/ai/providers/openai-codex-responses";
import type { AssistantMessage, Context, Model } from "@gajae-code/ai/types";
import { createOpenAIResponsesHistoryPayload } from "../src/utils";

interface CapturedCodexPayload {
	readonly input?: unknown[];
}

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createCodexToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

function isCapturedCodexPayload(value: unknown): value is CapturedCodexPayload {
	return typeof value === "object" && value !== null;
}

function captureCodexPayload(model: Model<"openai-codex-responses">, context: Context): Promise<CapturedCodexPayload> {
	const { promise, resolve, reject } = Promise.withResolvers<CapturedCodexPayload>();
	streamOpenAICodexResponses(model, context, {
		apiKey: createCodexToken("acc_test"),
		signal: createAbortedSignal(),
		onPayload: payload => {
			if (isCapturedCodexPayload(payload)) {
				resolve(payload);
				return;
			}
			reject(new Error("Expected captured Codex payload to be an object"));
		},
	});
	return promise;
}

function makeCodexAssistantMessage(items: Record<string, unknown>[]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ignored" }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.2-codex",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		providerPayload: createOpenAIResponsesHistoryPayload("openai-codex", items, false),
		timestamp: Date.now(),
	};
}

const MISSING_IMAGE_URL_PLACEHOLDER = `[Session resident imageUrl blob missing: sha256:${"a".repeat(64)}; original content unavailable]`;

describe("OpenAI responses history image replay", () => {
	it("normalizes object-valued image_url fields before replaying openai-codex native history", async () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.2-codex");
		const imageUrl = "data:image/png;base64,AAA";
		const malformedHistoryItems: Record<string, unknown>[] = [
			{
				type: "message",
				role: "user",
				id: "msg_user_with_image",
				content: [
					{ type: "input_text", text: "Recovered user image" },
					{ type: "image_url", image_url: { url: imageUrl, detail: "high" }, detail: { leak: true } },
				],
			},
		];

		const payload = await captureCodexPayload(model, {
			messages: [
				{ role: "user", content: "generic history that should be replaced", timestamp: Date.now() },
				makeCodexAssistantMessage(malformedHistoryItems),
				{ role: "user", content: "follow-up user", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Recovered user image" },
					{ type: "input_image", image_url: imageUrl, detail: "high" },
				],
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("drops missing resident-blob image_url placeholders instead of replaying invalid URLs (#2924)", async () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.2-codex");
		const historyItems: Record<string, unknown>[] = [
			{
				type: "message",
				role: "user",
				id: "msg_user_missing_blob",
				content: [
					{ type: "input_text", text: "before image" },
					{
						type: "input_image",
						detail: "auto",
						file_id: null,
						image_url: MISSING_IMAGE_URL_PLACEHOLDER,
					},
					{ type: "input_text", text: "after image" },
				],
			},
		];

		const payload = await captureCodexPayload(model, {
			messages: [
				{ role: "user", content: "generic history that should be replaced", timestamp: Date.now() },
				makeCodexAssistantMessage(historyItems),
				{ role: "user", content: "follow-up user", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "before image" },
					{ type: "input_text", text: "after image" },
				],
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
		const serialized = JSON.stringify(payload.input);
		expect(serialized.includes("image_url")).toBe(false);
		expect(serialized.includes("blob missing")).toBe(false);
	});

	it("keeps file_id-only input_image when image_url is an invalid placeholder (#2924)", async () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.2-codex");
		const historyItems: Record<string, unknown>[] = [
			{
				type: "message",
				role: "user",
				id: "msg_user_file_id",
				content: [
					{
						type: "input_image",
						detail: "high",
						file_id: "file-abc123",
						image_url: MISSING_IMAGE_URL_PLACEHOLDER,
					},
				],
			},
		];

		const payload = await captureCodexPayload(model, {
			messages: [
				{ role: "user", content: "generic history that should be replaced", timestamp: Date.now() },
				makeCodexAssistantMessage(historyItems),
				{ role: "user", content: "follow-up user", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [{ type: "input_image", detail: "high", file_id: "file-abc123" }],
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("preserves valid https and data:image image_url values on replay", async () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.2-codex");
		const httpsUrl = "https://example.com/a.png";
		const dataUrl = "data:image/png;base64,AAA";
		const historyItems: Record<string, unknown>[] = [
			{
				type: "message",
				role: "user",
				id: "msg_user_valid_urls",
				content: [
					{ type: "input_image", image_url: httpsUrl, detail: "low" },
					{ type: "input_image", image_url: dataUrl },
				],
			},
		];

		const payload = await captureCodexPayload(model, {
			messages: [
				{ role: "user", content: "generic history that should be replaced", timestamp: Date.now() },
				makeCodexAssistantMessage(historyItems),
				{ role: "user", content: "follow-up user", timestamp: Date.now() },
			],
		});

		expect(payload.input).toEqual([
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_image", image_url: httpsUrl, detail: "low" },
					{ type: "input_image", image_url: dataUrl },
				],
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});
});
