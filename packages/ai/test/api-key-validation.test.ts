import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	validateApiKeyAgainstModelsEndpoint,
	validateOpenAICompatibleApiKey,
} from "@gajae-code/ai/utils/oauth/api-key-validation";

const realFetch = globalThis.fetch;

/** Install a fetch stub answering the models endpoint with `response`. */
function stubFetch(response: () => Response, capture?: { url?: string; authorization?: string }): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		if (capture) {
			capture.url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			capture.authorization = new Headers(init?.headers).get("authorization") ?? "";
		}
		return response();
	}) as typeof globalThis.fetch;
}

function validate(): Promise<void> {
	return validateApiKeyAgainstModelsEndpoint({
		provider: "Synthetic",
		apiKey: "sk-test",
		modelsUrl: "https://example.invalid/v1/models",
	});
}

function validateChatCompletions(): Promise<void> {
	return validateOpenAICompatibleApiKey({
		provider: "Cerebras",
		apiKey: "csk-test",
		baseUrl: "https://example.invalid/v1",
		model: "test-model",
	});
}

function validateInferenceProbe(): Promise<void> {
	return validateOpenAICompatibleApiKey({
		provider: "Command Code GOAT",
		apiKey: "cmd-test",
		baseUrl: "https://example.invalid/v1",
		model: "zai-org/GLM-5.3",
		requireInferenceResponse: true,
	});
}

async function validationErrorMessage(validation: () => Promise<void>): Promise<string> {
	try {
		await validation();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected validation to fail");
}

describe("validateApiKeyAgainstModelsEndpoint", () => {
	beforeEach(() => {
		globalThis.fetch = realFetch;
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("sends the key as a bearer token to the models endpoint", async () => {
		const capture: { url?: string; authorization?: string } = {};
		stubFetch(() => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }), capture);
		await validate();
		expect(capture.url).toBe("https://example.invalid/v1/models");
		expect(capture.authorization).toBe("Bearer sk-test");
	});

	it("accepts an OpenAI-compatible list, including an empty one", async () => {
		stubFetch(() => new Response(JSON.stringify({ object: "list", data: [{ id: "m" }] }), { status: 200 }));
		await validate();
		stubFetch(() => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }));
		await validate();
	});

	it("accepts gateway list variants: bare array and models field", async () => {
		stubFetch(() => new Response(JSON.stringify([{ id: "m" }]), { status: 200 }));
		await validate();
		stubFetch(() => new Response(JSON.stringify({ models: [{ id: "m" }] }), { status: 200 }));
		await validate();
	});

	it("accepts a catalog response ending exactly at the body limit", async () => {
		const prefix = JSON.stringify({ object: "list", data: [] });
		const body = `${prefix}${" ".repeat(64 * 1024 - prefix.length)}`;
		expect(new TextEncoder().encode(body).byteLength).toBe(64 * 1024);
		stubFetch(() => new Response(body, { status: 200 }));
		await validate();
	});

	it("rejects a catalog response over the body limit", async () => {
		const prefix = JSON.stringify({ object: "list", data: [] });
		const body = `${prefix}${" ".repeat(64 * 1024 + 1 - prefix.length)}`;
		expect(new TextEncoder().encode(body).byteLength).toBe(64 * 1024 + 1);
		stubFetch(() => new Response(body, { status: 200 }));
		await expect(validate()).rejects.toThrow(/validation limit/);
	});

	it("rejects a 200 with a non-JSON body instead of accepting on status alone", async () => {
		stubFetch(() => new Response("<html>captive portal</html>", { status: 200 }));
		await expect(validate()).rejects.toThrow(/non-JSON body.*status alone/s);
	});

	it("rejects malformed JSON returned with 200", async () => {
		stubFetch(() => new Response('{"data":[', { status: 200 }));
		await expect(validate()).rejects.toThrow(/non-JSON body.*status alone/s);
	});

	it("reports the actual status for another successful dataless response", async () => {
		stubFetch(() => new Response(null, { status: 204 }));
		await expect(validate()).rejects.toThrow(/returned 204 with a non-JSON body/);
	});

	it("rejects a 200 whose JSON carries no recognizable model list", async () => {
		stubFetch(() => new Response(JSON.stringify({ object: "list" }), { status: 200 }));
		await expect(validate()).rejects.toThrow(/without a recognizable model list/);
		stubFetch(() => new Response(JSON.stringify({ data: "nope" }), { status: 200 }));
		await expect(validate()).rejects.toThrow(/without a recognizable model list/);
		stubFetch(() => new Response(JSON.stringify(null), { status: 200 }));
		await expect(validate()).rejects.toThrow(/without a recognizable model list/);
	});

	it("rejects an unauthorized key with status and bounded details", async () => {
		stubFetch(() => new Response("invalid api key", { status: 401 }));
		await expect(validate()).rejects.toThrow(/validation failed \(401\): invalid api key/);
	});

	it("bounds huge upstream bodies echoed into error messages", async () => {
		stubFetch(() => new Response("x".repeat(5000), { status: 500 }));
		const message = await validationErrorMessage(validate);
		expect(message).toContain("(500)");
		expect(message.length).toBeLessThan(400);
	});

	it("bounds a huge non-JSON 200 body echoed into the refusal", async () => {
		stubFetch(() => new Response(`<html>${"x".repeat(5000)}</html>`, { status: 200 }));
		const message = await validationErrorMessage(validate);
		expect(message).toContain("non-JSON body");
		expect(message).toContain("status alone");
		expect(message.length).toBeLessThan(500);
	});

	it("bounds upstream bodies echoed by chat-completions validation", async () => {
		stubFetch(() => new Response("x".repeat(5000), { status: 500 }));
		const message = await validationErrorMessage(validateChatCompletions);
		expect(message).toContain("Cerebras API key validation failed (500)");
		expect(message.length).toBeLessThan(400);
	});

	it("propagates network failures without accepting the key", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof globalThis.fetch;
		await expect(validate()).rejects.toThrow("network down");
	});

	it("requires an inference response instead of accepting a public catalog-shaped body", async () => {
		stubFetch(() => new Response(JSON.stringify({ object: "list", data: [{ id: "m" }] }), { status: 200 }));
		await expect(validateInferenceProbe()).rejects.toThrow(/no choices/);
		stubFetch(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
		await expect(validateInferenceProbe()).rejects.toThrow(/no choices/);
		stubFetch(() => new Response(JSON.stringify({ choices: [{}] }), { status: 200 }));
		await expect(validateInferenceProbe()).rejects.toThrow(/choices without a valid message/);
		stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), { status: 200 }));
		await expect(validateInferenceProbe()).rejects.toThrow(/choices with empty content/);
		stubFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "   " } }] }), { status: 200 }));
		await expect(validateInferenceProbe()).rejects.toThrow(/choices with empty content/);
	});

	it("accepts reasoning-only output and token-limit completions", async () => {
		const choices = [
			{
				index: 0,
				message: {
					role: "assistant",
					content: "",
					reasoning_content: "Let me consider how to respond to this",
				},
				finish_reason: "length",
			},
			{ message: { content: "", reasoning_content: "reasoning output" } },
			{ message: { content: "" }, finish_reason: "length" },
		];
		for (const choice of choices) {
			stubFetch(() => new Response(JSON.stringify({ choices: [choice] }), { status: 200 }));
			await validateInferenceProbe();
		}
	});

	it("rejects forbidden inference entitlement", async () => {
		stubFetch(() => new Response('{"error":"forbidden"}', { status: 403 }));
		await expect(validateInferenceProbe()).rejects.toThrow(/validation failed \(403\)/);
	});

	it("rejects malformed and oversized inference responses with bounded diagnostics", async () => {
		stubFetch(() => new Response(`<html>${"x".repeat(100_000)}</html>`, { status: 200 }));
		const malformed = await validationErrorMessage(validateInferenceProbe);
		expect(malformed).toContain("validation limit");
		expect(malformed.length).toBeLessThan(400);

		stubFetch(() => new Response("x".repeat(100_000), { status: 200 }));
		const oversized = await validationErrorMessage(validateInferenceProbe);
		expect(oversized).toContain("validation limit");
		expect(oversized.length).toBeLessThan(400);
	});

	it("propagates inference probe aborts without accepting the key", async () => {
		const controller = new AbortController();
		globalThis.fetch = (async (_input, init) => {
			controller.abort();
			init?.signal?.throwIfAborted();
			return new Response(null, { status: 200 });
		}) as typeof globalThis.fetch;
		await expect(
			validateOpenAICompatibleApiKey({
				provider: "Command Code GOAT",
				apiKey: "cmd-test",
				baseUrl: "https://example.invalid/v1",
				model: "zai-org/GLM-5.3",
				requireInferenceResponse: true,
				signal: controller.signal,
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("aborts a hanging response body", async () => {
		const controller = new AbortController();
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					start(stream) {
						stream.enqueue(new TextEncoder().encode('{"choices":['));
					},
				}),
				{ status: 200 },
			)) as unknown as typeof globalThis.fetch;
		const pending = validateOpenAICompatibleApiKey({
			provider: "Command Code GOAT",
			apiKey: "cmd-test",
			baseUrl: "https://example.invalid/v1",
			model: "zai-org/GLM-5.3",
			requireInferenceResponse: true,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 10);
		await expect(pending).rejects.toThrow("Login cancelled");
	});

	it("reports an internal deadline separately from caller cancellation", async () => {
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					start(stream) {
						stream.enqueue(new TextEncoder().encode('{"choices":['));
					},
				}),
				{ status: 200 },
			)) as unknown as typeof globalThis.fetch;
		const error = await validationErrorMessage(() =>
			validateOpenAICompatibleApiKey({
				provider: "Command Code GOAT",
				apiKey: "cmd-test",
				baseUrl: "https://example.invalid/v1",
				model: "zai-org/GLM-5.3",
				requireInferenceResponse: true,
				timeoutMs: 10,
			}),
		);
		expect(error).toContain("validation request timed out");
		expect(error).not.toContain("cmd-test");
	});
});
