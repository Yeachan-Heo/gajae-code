// Prints the auth-broker configuration this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
import { resolveAuthBrokerConfig } from "@gajae-code/coding-agent/session/auth-broker-config";

try {
	const config = await resolveAuthBrokerConfig();
	console.log(JSON.stringify({ config: config ?? null, error: null }));
} catch (err) {
	console.log(JSON.stringify({ config: null, error: (err as Error).message }));
}
