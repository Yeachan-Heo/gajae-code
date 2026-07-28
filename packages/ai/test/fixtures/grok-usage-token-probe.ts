// Prints the Grok usage access token this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import type { UsageFetchParams } from "@gajae-code/ai/usage";
import { resolveGrokAccessTokenForTest } from "@gajae-code/ai/usage/grok-cli";

function params(credential: Record<string, unknown>): UsageFetchParams {
	return { credential } as unknown as UsageFetchParams;
}

console.log(
	JSON.stringify({
		fromEnv: resolveGrokAccessTokenForTest(params({})) ?? null,
		storedWins: resolveGrokAccessTokenForTest(params({ accessToken: "stored-token" })) ?? null,
	}),
);
