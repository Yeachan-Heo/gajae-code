// Prints the OpenAI/Azure endpoint decisions this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the
// env module parses `projectEnv` at load time from `process.cwd()`, so the
// trust boundary can only be exercised from a separate process.
import { resolveOpenAIModelManagerBaseUrlForTest } from "@gajae-code/ai/provider-models/openai-compat";
import { resolveAzureConfigForTest } from "@gajae-code/ai/providers/azure-openai-responses";
import { resolveOpenAICompletionsBaseUrlForTest } from "@gajae-code/ai/providers/openai-completions";
import { resolveOpenAIProviderBaseUrlForTest } from "@gajae-code/ai/providers/openai-responses";
import type { Model } from "@gajae-code/ai/types";

const azureModel: Model<"azure-openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "azure-openai-responses",
	provider: "azure-openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 128000,
};

// Azure throws when nothing resolves a base URL, which is itself the
// "planted value was not used" signal.
function azureBaseUrl(): string | null {
	try {
		return resolveAzureConfigForTest(azureModel).baseUrl;
	} catch {
		return null;
	}
}

console.log(
	JSON.stringify({
		responses: resolveOpenAIProviderBaseUrlForTest(undefined, "api_key"),
		completions: resolveOpenAICompletionsBaseUrlForTest(undefined, "api_key"),
		modelManager: resolveOpenAIModelManagerBaseUrlForTest(),
		azure: azureBaseUrl(),
	}),
);
