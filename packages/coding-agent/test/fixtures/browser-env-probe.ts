// Prints the browser launch overrides this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`:
// the env module parses `projectEnv` at load time from `process.cwd()`, so the
// trust boundary can only be exercised from a separate process.
import { resolveBrowserEnvOverridesForTest } from "@gajae-code/coding-agent/tools/browser/launch";

console.log(JSON.stringify(resolveBrowserEnvOverridesForTest()));
