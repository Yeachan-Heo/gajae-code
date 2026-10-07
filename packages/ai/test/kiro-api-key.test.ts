import { afterEach, describe, expect, test } from "bun:test";
import { getBundledModels } from "../src/models";
import {
	fetchKiroApiModels,
	isKiroApiKey,
	kiroApiStaticModels,
	parseKiroApiEvents,
	toKiroModelId,
} from "../src/providers/kiro-api-key";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("isKiroApiKey", () => {
	test("accepts ksk_ keys", () => {
		expect(isKiroApiKey("ksk_abc")).toBe(true);
		expect(isKiroApiKey("  ksk_abc")).toBe(true);
	});
	test("rejects oauth bearers and empty values", () => {
		expect(isKiroApiKey(undefined)).toBe(false);
		expect(isKiroApiKey("")).toBe(false);
		expect(isKiroApiKey("eyJhbGciOi")).toBe(false);
		expect(isKiroApiKey("AWS_BEARER")).toBe(false);
		expect(isKiroApiKey("ksk_valid\nforged-header")).toBe(false);
	});
});

test("discovers models with the API-key endpoint contract", async () => {
	let request: { url: string; headers: Headers; body: string } | undefined;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		request = {
			url: String(input),
			headers: new Headers(init?.headers),
			body: String(init?.body),
		};
		return new Response(JSON.stringify({ models: [{ modelId: "claude-opus-4.8", modelName: "Opus" }] }), {
			status: 200,
		});
	}) as unknown as typeof fetch;

	const models = await fetchKiroApiModels("ksk_test-secret", "eu-west-1");
	expect(request?.url).toBe("https://q.eu-west-1.amazonaws.com/");
	expect(request?.headers.get("authorization")).toBe("Bearer ksk_test-secret");
	expect(request?.headers.get("tokentype")).toBe("API_KEY");
	expect(request?.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
	expect(JSON.parse(request?.body ?? "{}")).toEqual({ origin: "AI_EDITOR" });
	expect(models.map(model => model.id)).toEqual(["claude-opus-4.8", "claude-opus-4-8"]);
});

test("does not advertise image input for static or bundled Kiro Opus 5.5 models", () => {
	const opus55Ids = ["claude-opus-5-5", "claude-opus-5.5"];
	for (const catalog of [kiroApiStaticModels(), getBundledModels("kiro")]) {
		const opus55Models = catalog.filter(model => opus55Ids.includes(model.id));
		expect(opus55Models.map(model => model.id).sort()).toEqual(opus55Ids);
		for (const model of opus55Models) expect(model.input).toEqual(["text"]);
	}
});

test("redacts the API key from discovery errors", async () => {
	globalThis.fetch = (async () =>
		new Response("authorization=ksk_test-secret", { status: 401 })) as unknown as typeof fetch;
	await expect(fetchKiroApiModels("ksk_test-secret")).rejects.toThrow("authorization=[redacted]");
});

describe("toKiroModelId", () => {
	test("converts dash versions to Kiro dot form", () => {
		expect(toKiroModelId("claude-opus-4-8")).toBe("claude-opus-4.8");
		expect(toKiroModelId("claude-opus-4.8")).toBe("claude-opus-4.8");
		expect(toKiroModelId("auto")).toBe("auto");
	});
});

describe("parseKiroApiEvents", () => {
	test("parses content frames and leaves incomplete JSON", () => {
		const { events, remaining } = parseKiroApiEvents('{"content":"hi"}{"content":');
		expect(events).toEqual([{ type: "content", data: "hi" }]);
		expect(remaining).toBe('{"content":');
	});
	test("parses toolUse frames", () => {
		const { events } = parseKiroApiEvents('{"name":"read","toolUseId":"t1","input":"{}","stop":true}');
		expect(events[0]).toEqual({
			type: "toolUse",
			data: { name: "read", toolUseId: "t1", input: "{}", stop: true },
		});
	});
});
