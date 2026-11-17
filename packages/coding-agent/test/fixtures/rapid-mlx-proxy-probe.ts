// Run in a fresh process so Bun resolves the planted proxy variables at startup,
// exactly as it does for a real user session.
import * as path from "node:path";
import { rapidMlxModelManagerOptions } from "@gajae-code/ai/provider-models/openai-compat";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { $credentialEnv } from "@gajae-code/utils";

const scratch = process.argv[2];
if (!scratch) throw new Error("probe requires a scratch directory");
const baseUrl = Bun.env.RAPID_MLX_BASE_URL ?? "http://127.0.0.1:1/v1";
// Control: a plain `fetch` to the same loopback origin must be routed through the
// planted proxy, so the caller can prove the proxy was live for this process and
// that the registry's credentialed discovery deliberately did not use it.
await fetch(`${baseUrl}/control`).catch(() => undefined);
// Bun caches a proxy it has already used, so clearing the variables afterwards
// must not change which transport the credential takes.
const proxyVariables = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
for (const name of proxyVariables) delete Bun.env[name];
const auth = await AuthStorage.create(path.join(scratch, "proxy-probe-auth.db"));
try {
	const registry = new ModelRegistry(auth, path.join(scratch, "models.json"));
	await registry.refresh();
	// The descriptor is the library-level path a consumer would call directly.
	await rapidMlxModelManagerOptions({ apiKey: $credentialEnv("RAPID_MLX_API_KEY") }).fetchDynamicModels?.();
	const models = registry.getAll().filter(model => model.provider === "rapid-mlx");
	const discovery = registry.getProviderDiscoveryState("rapid-mlx");
	process.stdout.write(
		JSON.stringify({
			proxyVariablesCleared: proxyVariables.every(name => Bun.env[name] === undefined),
			modelIds: models.map(model => model.id),
			baseUrl: models[0]?.baseUrl,
			discoveryStatus: discovery?.status,
			discoveryError: discovery?.error,
		}),
	);
} finally {
	auth.close();
}
