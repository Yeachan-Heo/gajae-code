// Run in a fresh process so Bun resolves the planted proxy variables at startup,
// exactly as it does for a real user session.
import { stream } from "@gajae-code/ai/stream";
import type { Model } from "@gajae-code/ai/types";

const mode = process.argv[2];
const provider = Bun.env.PROBE_PROVIDER;
const baseUrl = Bun.env.PROBE_BASE_URL;
const apiKey = Bun.env.PROBE_API_KEY;
const prompt = Bun.env.PROBE_PROMPT ?? "probe";
if (!mode || !provider || !baseUrl) throw new Error("probe requires a mode, PROBE_PROVIDER, and PROBE_BASE_URL");

// Control: a plain `fetch` to the same origin must be routed through the planted
// proxy, so the caller can prove the proxy was live for this process.
await fetch(`${baseUrl}/control`).catch(() => undefined);

if (mode !== "completion") throw new Error(`unknown probe mode ${mode}`);

const model: Model<"openai-completions"> = {
	id: "test/local-model",
	name: "test/local-model",
	api: "openai-completions",
	provider,
	baseUrl,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
};
const events: string[] = [];
const s = stream(model, { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { apiKey });
for await (const event of s) {
	if (event.type === "text_delta") events.push(event.delta);
}
const message = await s.result();
process.stdout.write(
	JSON.stringify({ text: events.join(""), stopReason: message.stopReason, errorMessage: message.errorMessage }),
);
