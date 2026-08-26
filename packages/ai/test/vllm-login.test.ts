import { describe, expect, it } from "bun:test";
import { loginVllm } from "../src/utils/oauth/vllm";

describe("vLLM login", () => {
	it("stores a trimmed API key and opens the current official server docs", async () => {
		let authUrl = "";
		let allowEmpty: boolean | undefined;
		const apiKey = await loginVllm({
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async prompt => {
				allowEmpty = prompt.allowEmpty;
				return "  test-vllm-key  ";
			},
		});

		expect(authUrl).toBe("https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html");
		expect(allowEmpty).toBe(false);
		expect(apiKey).toBe("test-vllm-key");
	});

	it("rejects an empty value instead of persisting a no-auth sentinel", async () => {
		await expect(
			loginVllm({
				onAuth: () => {},
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("vLLM API key is required");
	});
});
