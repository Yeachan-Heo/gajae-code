import { describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import type { Model } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import {
	refreshMissingQualifiedModelProviders,
	resolveStartupModelRefreshSelectors,
} from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";

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

	test("does not refresh an available concrete selector whose suffix resembles thinking", async () => {
		const fixture = setup({
			models: [model("dynamic-provider", "new-model:high")],
		});

		const refreshed = await refreshMissingQualifiedModelProviders(
			"dynamic-provider/new-model:high",
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

	test("preserves explicit provider qualifiers and suppresses credential, profile, and resume refreshes", () => {
		const settings = Settings.isolated({ modelRoles: { default: "dynamic-provider/default-model" } });

		expect(
			resolveStartupModelRefreshSelectors(
				{ model: "new-model", provider: "dynamic-provider", hasStartupProfile: false },
				settings,
			),
		).toBe("dynamic-provider/new-model");
		expect(
			resolveStartupModelRefreshSelectors(
				{ model: "dynamic-provider/new-model", provider: "dynamic-provider", hasStartupProfile: true },
				settings,
			),
		).toBe("dynamic-provider/new-model");
		expect(
			resolveStartupModelRefreshSelectors(
				{ credential: "dynamic-provider/id:1", hasStartupProfile: false },
				settings,
			),
		).toBeUndefined();
		expect(resolveStartupModelRefreshSelectors({ hasStartupProfile: true }, settings)).toBeUndefined();
		expect(resolveStartupModelRefreshSelectors({ resume: true, hasStartupProfile: false }, settings)).toBeUndefined();
	});

	test("provider-scoped refresh does not resolve unrelated provider credentials", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-provider-scope-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("google", "test-key");
		const credentialProviders: string[] = [];
		const peekSpy = vi.spyOn(authStorage, "peekApiKey").mockImplementation(async provider => {
			credentialProviders.push(provider);
			return provider === "google" ? "test-key" : undefined;
		});
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		try {
			await registry.refreshProvider("google", "offline");
			expect(credentialProviders).toEqual(["google"]);
		} finally {
			peekSpy.mockRestore();
			authStorage.close();
		}
	});
});
