// Prints the Kimi OAuth host this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import { resolveKimiOAuthHostForTest } from "@gajae-code/ai/utils/oauth/kimi";

console.log(JSON.stringify({ host: resolveKimiOAuthHostForTest() }));
