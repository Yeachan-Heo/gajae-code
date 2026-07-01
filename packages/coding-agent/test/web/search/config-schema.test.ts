import { describe, expect, it } from "bun:test";
import { ModelsConfigSchema } from "../../../src/config/models-config-schema";
import { Settings } from "../../../src/config/settings";
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
		expect(fallback.items?.enum).toContain("insane");
		expect(fallback.items?.enum).not.toContain("openai-compatible");
		expect(isConfigurableSearchProviderId("openai-compatible")).toBe(false);
		expect(isSearchProviderPreference("openai-compatible")).toBe(false);
		expect(isConfigurableSearchProviderId("xai")).toBe(true);
		expect(isSearchProviderPreference("xai")).toBe(true);
		expect(CONFIGURABLE_SEARCH_PROVIDER_IDS).toContain("xai");
		expect(CONFIGURABLE_SEARCH_PROVIDER_IDS).toContain("insane");
		expect(isSearchProviderId("xai")).toBe(true);
		expect(isSearchProviderId("openai-compatible")).toBe(true);
	});

	it("accepts xAI as a selectable web search provider", () => {
		const webSearch = SETTINGS_SCHEMA["providers.webSearch"];
		expect(webSearch.type).toBe("enum");
		expect(webSearch.values).toContain("xai");
		expect(webSearch.ui?.options).toContainEqual(expect.objectContaining({ value: "xai", label: "xAI" }));
		expect(webSearch.values).toContain("insane");
		expect(webSearch.ui?.options).toContainEqual(expect.objectContaining({ value: "insane", label: "Insane" }));
		expect(webSearch.values).toContain("tavily");
		expect(webSearch.ui?.options).toContainEqual(expect.objectContaining({ value: "tavily", label: "Tavily" }));
	});

	it("accepts web_search.provider as a compatibility alias", () => {
		const webSearchProvider = SETTINGS_SCHEMA["web_search.provider"];
		expect(webSearchProvider.type).toBe("enum");
		expect(webSearchProvider.values).toContain("insane");
		expect(webSearchProvider.values).toContain("duckduckgo");
		expect(webSearchProvider.default).toBe("auto");
		expect(Settings.isolated({ "web_search.provider": "insane" }).get("web_search.provider")).toBe("insane");
	});

	it("defines web.insaneFallback as a boolean defaulting to false", () => {
		const setting = SETTINGS_SCHEMA["web.insaneFallback"];
		expect(setting.type).toBe("boolean");
		expect(setting.default).toBe(false);
		expect(setting.ui?.tab).toBe("tools");
		expect(Settings.isolated().get("web.insaneFallback")).toBe(false);
		expect(Settings.isolated({ "web.insaneFallback": true }).get("web.insaneFallback")).toBe(true);
	});
});
