import { describe, expect, it } from "bun:test";
import { ModelsConfigSchema } from "../../../src/config/models-config-schema";
import { SETTINGS_SCHEMA } from "../../../src/config/settings-schema";
import {
	CONFIGURABLE_SEARCH_PROVIDER_IDS,
	isConfigurableSearchProviderId,
	isSearchProviderId,
	isSearchProviderPreference,
} from "../../../src/web/search/types";

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
		expect(fallback.items?.enum).toContain("xai");
		expect(fallback.items?.enum).not.toContain("openai-compatible");
		expect(isConfigurableSearchProviderId("openai-compatible")).toBe(false);
		expect(isSearchProviderPreference("openai-compatible")).toBe(false);
		expect(isConfigurableSearchProviderId("xai")).toBe(true);
		expect(isSearchProviderPreference("xai")).toBe(true);
		expect(CONFIGURABLE_SEARCH_PROVIDER_IDS).toContain("xai");
		expect(isSearchProviderId("xai")).toBe(true);
		expect(isSearchProviderId("openai-compatible")).toBe(true);
	});

	it("accepts xAI as a selectable web search provider", () => {
		const webSearch = SETTINGS_SCHEMA["providers.webSearch"];
		expect(webSearch.type).toBe("enum");
		expect(webSearch.values).toContain("xai");
		expect(webSearch.ui?.options).toContainEqual(expect.objectContaining({ value: "xai", label: "xAI" }));
	});
});
