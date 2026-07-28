// Prints the SearXNG endpoint and auth material this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import { resolveSearxngConfigForTest } from "../../src/web/search/providers/searxng";

console.log(JSON.stringify(resolveSearxngConfigForTest()));
