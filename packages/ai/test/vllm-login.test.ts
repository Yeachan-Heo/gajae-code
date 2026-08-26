import { describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
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

	it("does not replace a stored key on empty re-login and supports logout/re-login", async () => {
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const authStorage = new AuthStorage(store);
		let promptValue = "  first-vllm-key  ";
		const controller = {
			onAuth: () => {},
			onPrompt: async () => promptValue,
		};

		try {
			await authStorage.login("vllm", controller);
			expect(store.getApiKey("vllm")).toBe("first-vllm-key");

			promptValue = " \t ";
			await expect(authStorage.login("vllm", controller)).rejects.toThrow("vLLM API key is required");
			expect(store.getApiKey("vllm")).toBe("first-vllm-key");

			await authStorage.logout("vllm");
			expect(store.getApiKey("vllm")).toBeNull();

			promptValue = "  second-vllm-key  ";
			await authStorage.login("vllm", controller);
			expect(store.getApiKey("vllm")).toBe("second-vllm-key");
		} finally {
			store.close();
		}
	});
});
