import { describe, expect, it } from "bun:test";
import { ModelsConfigSchema } from "../../../src/config/models-config-schema";
import { SETTINGS_SCHEMA } from "../../../src/config/settings-schema";
import { isConfigurableSearchProviderId, isSearchProviderPreference } from "../../../src/web/search/types";

describe("web search config schema", () => {
	it("accepts provider webSearch mode enum and rejects invalid modes", () => {
		expect(ModelsConfigSchema.safeParse({ providers: { custom: { webSearch: "on" } } }).success).toBe(true);
		expect(ModelsConfigSchema.safeParse({ providers: { custom: { webSearch: "off" } } }).success).toBe(true);
		expect(ModelsConfigSchema.safeParse({ providers: { custom: { webSearch: "auto" } } }).success).toBe(true);
		expect(ModelsConfigSchema.safeParse({ providers: { custom: { webSearch: "maybe" } } }).success).toBe(false);
	});

	it("fallback item metadata rejects the internal openai-compatible provider", () => {
		const fallback = SETTINGS_SCHEMA["web_search.fallback"];
		expect(fallback.type).toBe("array");
		expect(fallback.items?.enum).toContain("exa");
		expect(fallback.items?.enum).not.toContain("openai-compatible");
		expect(isConfigurableSearchProviderId("openai-compatible")).toBe(false);
		expect(isSearchProviderPreference("openai-compatible")).toBe(false);
	});
});
