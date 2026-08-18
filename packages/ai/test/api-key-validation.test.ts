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
});
