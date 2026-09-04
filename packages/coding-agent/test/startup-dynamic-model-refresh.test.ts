import { describe, expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { refreshMissingQualifiedModelProviders } from "../src/config/model-resolver";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 131_072 }) as Model;

function setup(options: { models?: Model[]; providers?: string[] } = {}) {
	const refreshCalls: Array<[string, string]> = [];
	const modelRegistry = {
		getAvailable: () => options.models ?? [],
		getDiscoverableProviders: () => options.providers ?? ["dynamic-provider", "glm-zcode"],
		refreshProvider: async (provider: string, strategy: string) => {
			refreshCalls.push([provider, strategy]);
		},
	};
	return { modelRegistry, refreshCalls };
}

describe("startup dynamic model refresh", () => {
	test("refreshes the explicit provider when --model names a missing dynamic model", async () => {
		const fixture = setup();

		const refreshed = await refreshMissingQualifiedModelProviders(
			"dynamic-provider/new-model",
			fixture.modelRegistry as never,
		);

		expect(refreshed).toBe(true);
		expect(fixture.refreshCalls).toEqual([["dynamic-provider", "online-if-uncached"]]);
	});

	test("refreshes the configured default provider before a plain gjc launch", async () => {
		const fixture = setup();

		const refreshed = await refreshMissingQualifiedModelProviders(
			"glm-zcode/glm-5.3:xhigh",
			fixture.modelRegistry as never,
		);

		expect(refreshed).toBe(true);
		expect(fixture.refreshCalls).toEqual([["glm-zcode", "online-if-uncached"]]);
	});

	test("does not refresh when the startup model is already available", async () => {
		const fixture = setup({
			models: [model("glm-zcode", "glm-5.3")],
		});

		const refreshed = await refreshMissingQualifiedModelProviders(
			"glm-zcode/glm-5.3:xhigh",
			fixture.modelRegistry as never,
		);

		expect(refreshed).toBe(false);
		expect(fixture.refreshCalls).toEqual([]);
	});

	test("does not refresh an absent or unqualified selector", async () => {
		const fixture = setup();

		const absent = await refreshMissingQualifiedModelProviders(undefined, fixture.modelRegistry as never);
		const unqualified = await refreshMissingQualifiedModelProviders("glm-5.3", fixture.modelRegistry as never);

		expect(absent).toBe(false);
		expect(unqualified).toBe(false);
		expect(fixture.refreshCalls).toEqual([]);
	});

	test("refreshes each missing provider in a configured fallback chain exactly once", async () => {
		const fixture = setup({ providers: ["primary-provider", "fallback-provider"] });

		const refreshed = await refreshMissingQualifiedModelProviders(
			["primary-provider/new-model:high", "fallback-provider/fallback-model", "primary-provider/another-model"],
			fixture.modelRegistry as never,
		);

		expect(refreshed).toBe(true);
		expect(fixture.refreshCalls).toEqual([
			["primary-provider", "online-if-uncached"],
			["fallback-provider", "online-if-uncached"],
		]);
	});

	test("canonicalizes provider casing and ignores unknown qualified providers", async () => {
		const fixture = setup({ providers: ["glm-zcode"] });

		const refreshed = await refreshMissingQualifiedModelProviders(
			["GLM-ZCODE/glm-5.3:xhigh", "unknown-provider/model"],
			fixture.modelRegistry as never,
		);

		expect(refreshed).toBe(true);
		expect(fixture.refreshCalls).toEqual([["glm-zcode", "online-if-uncached"]]);
	});
});
