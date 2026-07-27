// Prints the Smithery origin, API base and env API key this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.

import { resolveSmitheryEnvForTest } from "../../src/runtime-mcp/smithery-auth";
import { getSmitheryApiBaseUrl } from "../../src/runtime-mcp/smithery-connect";

const resolved = resolveSmitheryEnvForTest();
console.log(
	JSON.stringify({ url: resolved.url, apiKey: resolved.apiKey ?? null, apiBaseUrl: getSmitheryApiBaseUrl() }),
);
