// Prints the provider base URLs the model registry resolves from the environment.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the env
// module parses `projectEnv` at load time from `process.cwd()`, so the trust
// boundary can only be exercised from a separate process.
//
// argv[2] is a scratch directory for the throwaway auth db / models.json.
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";

const scratch = process.argv[2];
if (!scratch) throw new Error("probe requires a scratch directory argument");

const authStorage = await AuthStorage.create(path.join(scratch, "probe-auth.db"));
const registry = new ModelRegistry(authStorage, path.join(scratch, "models.json"));

console.log(
	JSON.stringify({
		anthropic: registry.getProviderBaseUrl("anthropic") ?? null,
		openai: registry.getProviderBaseUrl("openai") ?? null,
		google: registry.getProviderBaseUrl("google") ?? null,
	}),
);
