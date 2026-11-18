// Run in a fresh process so Bun resolves the planted proxy variables at startup,
// exactly as it does for a real user session.
import { rapidMlxModelManagerOptions } from "@gajae-code/ai/provider-models/openai-compat";
import { stream } from "@gajae-code/ai/stream";
import type { Model } from "@gajae-code/ai/types";

const mode = process.argv[2];
const baseUrl = Bun.env.PROBE_BASE_URL;
const apiKey = Bun.env.PROBE_API_KEY;
if (!mode || !baseUrl) throw new Error("probe requires a mode and PROBE_BASE_URL");

// Control: a plain `fetch` to the same origin must be routed through the planted
// proxy, so the caller can prove the proxy was live for this process and that the
// provider's own request deliberately did not use it.
await fetch(`${baseUrl}/control`).catch(() => undefined);

if (mode === "discovery") {
	// Keyless descriptor discovery is the path a `gjc` session runs before any
	// credential exists. It must not consult the proxy either.
	const models = await rapidMlxModelManagerOptions({ baseUrl }).fetchDynamicModels?.();
	process.stdout.write(JSON.stringify({ ids: (models ?? []).map(model => model.id) }));
} else if (mode === "responses") {
	// Rapid-MLX documents a working `/v1/responses`; a configured `providers.rapid-mlx`
	// entry may select that api, so the loopback transport must cover it too.
	const model: Model<"openai-responses"> = {
		id: "mlx-community/Qwen3.5-4B-MLX-4bit",
		name: "mlx-community/Qwen3.5-4B-MLX-4bit",
		api: "openai-responses",
		provider: "rapid-mlx",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 1024,
	};
	const events: string[] = [];
	const s = stream(
		model,
		{ messages: [{ role: "user", content: Bun.env.PROBE_PROMPT ?? "probe", timestamp: Date.now() }] },
		{ apiKey },
	);
	for await (const event of s) {
		if (event.type === "text_delta") events.push(event.delta);
	}
	const message = await s.result();
	process.stdout.write(
		JSON.stringify({ text: events.join(""), stopReason: message.stopReason, errorMessage: message.errorMessage }),
	);
} else if (mode === "completion") {
	const model: Model<"openai-completions"> = {
		id: "mlx-community/Qwen3.5-4B-MLX-4bit",
		name: "mlx-community/Qwen3.5-4B-MLX-4bit",
		api: "openai-completions",
		provider: "rapid-mlx",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 1024,
	};
	const events: string[] = [];
	let firstDeltaAt: number | undefined;
	const s = stream(
		model,
		{ messages: [{ role: "user", content: Bun.env.PROBE_PROMPT ?? "probe", timestamp: Date.now() }] },
		{ apiKey },
	);
	for await (const event of s) {
		if (event.type === "text_delta") {
			firstDeltaAt ??= performance.now();
			events.push(event.delta);
		}
	}
	const message = await s.result();
	process.stdout.write(
		JSON.stringify({
			text: events.join(""),
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
			// Time from the first streamed delta to the terminal result. A buffered
			// transport would collapse this to ~0 even though both deltas exist.
			streamingGapMs: firstDeltaAt === undefined ? 0 : performance.now() - firstDeltaAt,
		}),
	);
} else {
	throw new Error(`unknown probe mode ${mode}`);
}
