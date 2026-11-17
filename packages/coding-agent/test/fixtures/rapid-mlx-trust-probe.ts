// Run in a fresh process so the real env loader reads the planted project .env.
import * as path from "node:path";
import { rapidMlxModelManagerOptions } from "@gajae-code/ai/provider-models/openai-compat";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { $credentialEnv } from "@gajae-code/utils";

const scratch = process.argv[2];
if (!scratch) throw new Error("probe requires a scratch directory");
const auth = await AuthStorage.create(path.join(scratch, "probe-auth.db"));
try {
	const registry = new ModelRegistry(auth, path.join(scratch, "models.json"));
	await registry.refresh();
	// The descriptor path in this process uses the same credential and endpoint
	// resolution as a library consumer would.
	await rapidMlxModelManagerOptions({ apiKey: $credentialEnv("RAPID_MLX_API_KEY") }).fetchDynamicModels?.();
	process.stdout.write(
		JSON.stringify({
			projectUrl: Bun.env.RAPID_MLX_BASE_URL,
			trustedUrl: $credentialEnv("RAPID_MLX_BASE_URL"),
			modelBaseUrl: registry.find("rapid-mlx", "trusted-model")?.baseUrl,
		}),
	);
} finally {
	auth.close();
}
