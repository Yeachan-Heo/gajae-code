// Prints the Google credential material this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import { resolveAdcCredentialsPathForTest } from "@gajae-code/ai/providers/google-auth";
import { resolveVertexApiKeyForTest } from "@gajae-code/ai/providers/google-vertex";

console.log(
	JSON.stringify({
		adcPath: resolveAdcCredentialsPathForTest() ?? null,
		vertexApiKey: resolveVertexApiKeyForTest() ?? null,
		callerKeyWins: resolveVertexApiKeyForTest({ apiKey: "caller-key" }) ?? null,
	}),
);
