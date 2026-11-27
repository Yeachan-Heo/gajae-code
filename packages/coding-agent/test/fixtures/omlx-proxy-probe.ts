// Run in a fresh process so Bun resolves and caches the planted proxy variables
// at startup, exactly as it does for a real user session.
import * as path from "node:path";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";

const scratch = process.argv[2];
if (!scratch) throw new Error("probe requires a scratch directory");
const auth = await AuthStorage.create(path.join(scratch, "omlx-proxy-probe-auth.db"));
try {
	const registry = new ModelRegistry(auth, path.join(scratch, "models.json"));
	// Scope the probe to the credential-bearing implicit oMLX provider: the
	// endpoint and key come from OMLX_BASE_URL / OMLX_API_KEY in this process's
	// startup environment.
	await registry.refreshProvider("omlx", "online");
	process.stdout.write(
		JSON.stringify({
			modelIds: registry
				.getAll()
				.filter(model => model.provider === "omlx")
				.map(model => model.id),
		}),
	);
} finally {
	auth.close();
}
