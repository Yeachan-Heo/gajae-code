import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@gajae-code/ai";
import { createRegistrySelectorIndex, registrySelectorResolvesToModel } from "../src/config/model-registry";

function model(provider: string, id: string): Model<Api> {
	return { provider, id } as Model<Api>;
}

describe("registry selector index", () => {
	const index = createRegistrySelectorIndex([
		model("OpenRouter", "Anthropic/Claude-Sonnet-4"),
		model("openai", "gpt-5"),
	]);

	it("matches bare ids and provider/id case-insensitively", () => {
		expect(registrySelectorResolvesToModel("GPT-5", index)).toBe(true);
		expect(registrySelectorResolvesToModel(" openai/gpt-5 ", index)).toBe(true);
		expect(registrySelectorResolvesToModel("openrouter/anthropic/claude-sonnet-4", index)).toBe(true);
	});

	it("matches a provider/id selector only for that provider", () => {
		expect(registrySelectorResolvesToModel("anthropic/gpt-5", index)).toBe(false);
	});

	it("matches a trailing id segment after a slash", () => {
		expect(registrySelectorResolvesToModel("claude-sonnet-4", index)).toBe(true);
	});

	it("strips a thinking suffix before matching", () => {
		expect(registrySelectorResolvesToModel("gpt-5:high", index)).toBe(true);
		expect(registrySelectorResolvesToModel("openai/gpt-5:high", index)).toBe(true);
	});

	it("keeps provider/id pairs distinct even when a part contains NUL", () => {
		// provider "a" + id "b\0c" must not collide with provider "a\0b" + id "c".
		const nulIndex = createRegistrySelectorIndex([model("a", "b\u0000c")]);
		expect(registrySelectorResolvesToModel("a/b\u0000c", nulIndex)).toBe(true);
		expect(registrySelectorResolvesToModel("a\u0000b/c", nulIndex)).toBe(false);
	});

	it("rejects unknown selectors and partial id prefixes", () => {
		expect(registrySelectorResolvesToModel("gpt-4o", index)).toBe(false);
		expect(registrySelectorResolvesToModel("sonnet-4", index)).toBe(false);
	});
});
