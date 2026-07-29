// Prints the Azure client API key this process resolves when the caller passes none.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import { resolveAzureClientApiKeyForTest } from "@gajae-code/ai/providers/azure-openai-responses";

console.log(
	JSON.stringify({
		resolved: resolveAzureClientApiKeyForTest("") ?? null,
		callerWins: resolveAzureClientApiKeyForTest("caller-supplied-key") ?? null,
	}),
);
