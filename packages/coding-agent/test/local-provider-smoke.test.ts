import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runLocalProviderSmoke } from "@gajae-code/coding-agent/cli/local-provider-smoke";
import { hookFetch, Snowflake } from "@gajae-code/utils";

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
