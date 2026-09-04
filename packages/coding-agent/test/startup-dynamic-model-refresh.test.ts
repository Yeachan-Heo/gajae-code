import { describe, expect, test } from "bun:test";
import type { Model } from "@gajae-code/ai";
import { refreshMissingQualifiedModelProvider } from "../src/config/model-resolver";

const model = (provider: string, id: string): Model =>
	({ provider, id, name: id, api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 131_072 }) as Model;

function setup(options: { models?: Model[] } = {}) {
	const refreshCalls: Array<[string, string]> = [];
	const modelRegistry = {
		getAvailable: () => options.models ?? [],
		refreshProvider: async (provider: string, strategy: string) => {
			refreshCalls.push([provider, strategy]);
		},
	};
	return { modelRegistry, refreshCalls };
}

describe("startup dynamic model refresh", () => {
	test("refreshes the explicit provider when --model names a missing dynamic model", async () => {
		const fixture = setup();

		const refreshed = await refreshMissingQualifiedModelProvider(
			"dynamic-provider/new-model",
			fixture.modelRegistry as never,
		);

		expect(refreshed).toBe(true);
		expect(fixture.refreshCalls).toEqual([["dynamic-provider", "online-if-uncached"]]);
	});

	test("refreshes the configured default provider before a plain gjc launch", async () => {
		const fixture = setup();

		const refreshed = await refreshMissingQualifiedModelProvider(
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

		const refreshed = await refreshMissingQualifiedModelProvider(
			"glm-zcode/glm-5.3:xhigh",
			fixture.modelRegistry as never,
		);

		expect(refreshed).toBe(false);
		expect(fixture.refreshCalls).toEqual([]);
	});

	test("does not refresh an absent or unqualified selector", async () => {
		const fixture = setup();

		const absent = await refreshMissingQualifiedModelProvider(undefined, fixture.modelRegistry as never);
		const unqualified = await refreshMissingQualifiedModelProvider("glm-5.3", fixture.modelRegistry as never);

		expect(absent).toBe(false);
		expect(unqualified).toBe(false);
		expect(fixture.refreshCalls).toEqual([]);
	});
});
