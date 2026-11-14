// Run in a fresh process so the real env loader reads the planted project .env.
import * as path from "node:path";
import { rapidMlxModelManagerOptions } from "@gajae-code/ai/provider-models/openai-compat";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { $credentialEnv, hookFetch } from "@gajae-code/utils";

const scratch = process.argv[2];
if (!scratch) throw new Error("probe requires a scratch directory");
const requests: { url: string; authorization: string | null }[] = [];
using _hook = hookFetch((input, init) => {
	const url = String(input);
	const authorization = new Headers(init?.headers).get("Authorization");
	requests.push({ url, authorization });
	if (url === "http://localhost:8000/v1/models" || url === "http://127.0.0.1:8477/v1/models") {
		return Response.json({ data: [{ id: "trusted-model" }] });
	}
	return new Response(null, { status: 404 });
});
const auth = await AuthStorage.create(path.join(scratch, "probe-auth.db"));
try {
	const registry = new ModelRegistry(auth, path.join(scratch, "models.json"));
	await registry.refresh();
	await rapidMlxModelManagerOptions({ apiKey: $credentialEnv("RAPID_MLX_API_KEY") }).fetchDynamicModels?.();
	process.stdout.write(
		JSON.stringify({
			projectUrl: Bun.env.RAPID_MLX_BASE_URL,
			modelBaseUrl: registry.find("rapid-mlx", "trusted-model")?.baseUrl,
			requests,
		}),
	);
} finally {
	auth.close();
}
