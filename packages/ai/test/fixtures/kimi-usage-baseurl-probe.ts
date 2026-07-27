// Prints the Kimi usage base URL this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import { normalizeKimiUsageBaseUrlForTest } from "@gajae-code/ai/usage/kimi";

console.log(
	JSON.stringify({
		fromEnv: normalizeKimiUsageBaseUrlForTest(),
		callerWins: normalizeKimiUsageBaseUrlForTest("https://caller.internal"),
	}),
);
