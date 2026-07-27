import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOpenAICodexTransportDetails } from "@gajae-code/ai/providers/openai-codex-responses";
import type { Model } from "@gajae-code/ai/types";

/**
 * The provider was renamed Codex -> "OpenAI code" and the documented env names
 * followed (GJC_OPENAI_CODE_*), but the reads still used the legacy PI_CODEX_*
 * names. These pin the documented name working, the legacy alias still working,
 * and GJC-first precedence.
 */

const KEYS = ["GJC_OPENAI_CODE_WEBSOCKET", "PI_CODEX_WEBSOCKET"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of KEYS) {
		saved.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

// `preferWebsockets: false` on the model (and no caller option) leaves the env
// flag as the only thing that can turn websocket preference on, isolating it.
function envOnlyCodexModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	};
}

describe("OpenAI code websocket env flag", () => {
	it("is off when neither name is set", () => {
		expect(getOpenAICodexTransportDetails(envOnlyCodexModel()).websocketPreferred).toBe(false);
	});

	it("honors the documented GJC_OPENAI_CODE_WEBSOCKET", () => {
		Bun.env.GJC_OPENAI_CODE_WEBSOCKET = "1";
		expect(getOpenAICodexTransportDetails(envOnlyCodexModel()).websocketPreferred).toBe(true);
	});

	it("still honors the legacy PI_CODEX_WEBSOCKET alias", () => {
		Bun.env.PI_CODEX_WEBSOCKET = "1";
		expect(getOpenAICodexTransportDetails(envOnlyCodexModel()).websocketPreferred).toBe(true);
	});

	it("resolves GJC-first: an explicit GJC=0 wins over legacy PI=1", () => {
		Bun.env.GJC_OPENAI_CODE_WEBSOCKET = "0";
		Bun.env.PI_CODEX_WEBSOCKET = "1";
		expect(getOpenAICodexTransportDetails(envOnlyCodexModel()).websocketPreferred).toBe(false);
	});
});
