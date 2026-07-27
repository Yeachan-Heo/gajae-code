// Prints the image-generation endpoint and key fallback this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import type { Model } from "@gajae-code/ai";
import {
	getOpenAIImageBaseUrlForTest,
	googleImageApiKeyFromEnvForTest,
} from "@gajae-code/coding-agent/tools/image-gen";

const model = {
	id: "gpt-image-1",
	name: "GPT Image 1",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 128000,
} as unknown as Model;

console.log(
	JSON.stringify({
		baseUrl: getOpenAIImageBaseUrlForTest(model, "api_key"),
		googleKey: googleImageApiKeyFromEnvForTest() ?? null,
	}),
);
