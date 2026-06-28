import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runLocalProviderDiscover,
	runLocalProviderDiscoverCommand,
	runLocalProviderSmoke,
} from "@gajae-code/coding-agent/cli/local-provider-smoke";
import { hookFetch, Snowflake } from "@gajae-code/utils";
import { LOCAL_PROVIDER_ACTIONS, LOCAL_PROVIDER_DEFAULT_ACTION } from "../src/commands/local-provider";

describe("local provider streaming smoke", () => {
	let tempDir: string;
	let modelsPath: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `gjc-local-provider-smoke-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("reports a clear configuration failure when local openaiCompat is not configured", async () => {
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }));

		const result = await runLocalProviderSmoke({ modelsPath, model: "local-model" });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("No local OpenAI-compatible endpoint configured");
	});

	test("discovers configured local OpenAI-compatible models without a chat completion request", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		const requestedUrls: string[] = [];
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url !== "http://127.0.0.1:1234/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			expect(init?.method ?? "GET").toBe("GET");
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer local-key");
			return new Response(JSON.stringify({ data: [{ id: "z-local" }, { id: "a-local" }, { id: "a-local" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await runLocalProviderDiscover({ modelsPath });

		expect(result.ok).toBe(true);
		expect(result.provider).toBe("local");
		expect(result.baseUrl).toBe("http://127.0.0.1:1234/v1");
		expect(result.models).toEqual(["a-local", "z-local"]);
		expect(requestedUrls).toEqual(["http://127.0.0.1:1234/v1/models"]);
	});

	test("prints local discovery provider, base URL, and model ids", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(
			() =>
				new Response(JSON.stringify({ data: [{ id: "local-alpha" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const captured: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;
		try {
			await runLocalProviderDiscoverCommand({ modelsPath });
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = captured.join("");
		expect(output).toContain("provider=local");
		expect(output).toContain("baseUrl=http://127.0.0.1:1234/v1");
		expect(output).toContain("local-alpha");
	});

	test("keeps bare local-provider command defaulting to streaming smoke while exposing discovery actions", () => {
		expect(LOCAL_PROVIDER_DEFAULT_ACTION).toBe("smoke");
		expect(LOCAL_PROVIDER_ACTIONS).toEqual(["discover", "models", "smoke"]);
	});

	test("reports local discovery network failures clearly", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:65535/v1", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(() => {
			throw new Error("connection refused");
		});

		const result = await runLocalProviderDiscover({ modelsPath, timeoutMs: 25 });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("model discovery failed");
		expect(result.baseUrl).toBe("http://127.0.0.1:65535/v1");
		expect(result.error).toContain("connection refused");
	});

	test("reports malformed local discovery JSON clearly", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(() => new Response("not json", { status: 200 }));

		const result = await runLocalProviderDiscover({ modelsPath });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("Failed to parse /models JSON");
	});

	test("reports malformed local discovery response shape clearly", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(
			() => new Response(JSON.stringify({ models: [{ id: "not-openai-shape" }] }), { status: 200 }),
		);

		const result = await runLocalProviderDiscover({ modelsPath });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("/models response did not include a data array");
	});

	test("does not throw when the configured local endpoint cannot be reached", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:65535/v1", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch(() => {
			throw new Error("connection refused");
		});

		const result = await runLocalProviderSmoke({ modelsPath, model: "local-model", timeoutMs: 25 });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("smoke request failed");
		expect(result.error).toContain("connection refused");
	});

	test("sends a streaming chat completion request to the configured endpoint", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					local: { openaiCompat: { baseUrl: "http://127.0.0.1:1234", apiKey: "local-key" } },
				},
			}),
		);
		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url !== "http://127.0.0.1:1234/v1/chat/completions") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			expect(init?.method).toBe("POST");
			expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer local-key");
			const body = JSON.parse(String(init?.body)) as { model: string; stream: boolean };
			expect(body.model).toBe("local-model");
			expect(body.stream).toBe(true);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						controller.close();
					},
				}),
				{ status: 200 },
			);
		});

		const result = await runLocalProviderSmoke({ modelsPath, model: "local-model" });

		expect(result.ok).toBe(true);
		expect(result.baseUrl).toBe("http://127.0.0.1:1234/v1");
		expect(result.model).toBe("local-model");
	});
});
