import { describe, expect, it } from "bun:test";
import { applyCliRuntimeApiKeyOverride } from "../src/runtime-api-key";

describe("applyCliRuntimeApiKeyOverride", () => {
	it("applies the CLI runtime API key once a model resolves", () => {
		const calls: Array<{ provider: string; apiKey: string }> = [];
		const target = {
			setRuntimeApiKey(provider: string, apiKey: string) {
				calls.push({ provider, apiKey });
			},
		};

		applyCliRuntimeApiKeyOverride(target, "cli-runtime-key", { provider: "runtime-provider" });

		expect(calls).toEqual([{ provider: "runtime-provider", apiKey: "cli-runtime-key" }]);
	});

	it("does nothing when the model has not resolved yet", () => {
		const calls: Array<{ provider: string; apiKey: string }> = [];
		const target = {
			setRuntimeApiKey(provider: string, apiKey: string) {
				calls.push({ provider, apiKey });
			},
		};

		applyCliRuntimeApiKeyOverride(target, "cli-runtime-key", undefined);

		expect(calls).toEqual([]);
	});

	it("does nothing when no CLI runtime API key was supplied", () => {
		const calls: Array<{ provider: string; apiKey: string }> = [];
		const target = {
			setRuntimeApiKey(provider: string, apiKey: string) {
				calls.push({ provider, apiKey });
			},
		};

		applyCliRuntimeApiKeyOverride(target, undefined, { provider: "runtime-provider" });

		expect(calls).toEqual([]);
	});
});
