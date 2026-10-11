// Prints the Foundry headers `buildAnthropicClientOptions()` actually sends.
// Spawned with a controlled cwd so a planted project `.env` is what this
// process loads. The drop runs after imports so the startup snapshot has
// already recorded the file.
import * as fs from "node:fs";
import * as os from "node:os";
import { buildAnthropicClientOptions } from "@gajae-code/ai/providers/anthropic";
import type { Model } from "@gajae-code/ai/types";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const drop = process.env.GJC_FOUNDRY_HEADER_PROBE_DROP;
if (drop === "unlink") {
	fs.rmSync(".env", { force: true });
} else if (drop === "chdir") {
	process.chdir(os.tmpdir());
}

try {
	const options = buildAnthropicClientOptions({
		model,
		apiKey: "foundry-token",
		extraBetas: [],
		stream: true,
		interleavedThinking: false,
		dynamicHeaders: {},
	});
	const headers = new Headers(options.defaultHeaders);
	console.log(
		JSON.stringify({
			error: null,
			userId: headers.get("user-id"),
			route: headers.get("x-route"),
			authorization: headers.get("authorization"),
		}),
	);
} catch (error) {
	console.log(
		JSON.stringify({
			error: error instanceof Error ? error.message : String(error),
			userId: null,
			route: null,
			authorization: null,
		}),
	);
}
