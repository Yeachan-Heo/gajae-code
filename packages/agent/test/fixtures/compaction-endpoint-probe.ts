// Prints the remote-compaction endpoint this process resolves.
// Spawned with a controlled cwd so the caller can plant a project `.env`: the
// env module parses `projectEnv` at load time from `process.cwd()`, so the
// trust boundary can only be exercised from a separate process.
import type { Model } from "@gajae-code/ai";
import { resolveOpenAiCompactEndpointForTest } from "../../src/compaction/openai";

const model = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 128000,
} as unknown as Model;

console.log(JSON.stringify({ endpoint: resolveOpenAiCompactEndpointForTest(model, "api_key") }));
