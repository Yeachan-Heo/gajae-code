import { describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { type Model, PROVIDER_DESCRIPTORS } from "@gajae-code/ai";
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

function setup(options: { models?: Model[]; providers?: string[]; refreshableProviders?: string[] } = {}) {
	const refreshCalls: Array<[string, string]> = [];
	const modelRegistry = {
		getAvailable: () => options.models ?? [],
		getDiscoverableProviders: () => options.providers ?? ["dynamic-provider", "glm-zcode"],
		getRefreshableProviders: () =>
			options.refreshableProviders ?? [
				...new Set([
					...(options.providers ?? ["dynamic-provider", "glm-zcode"]),
					...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
				]),
			],
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
	test("refreshes a runtime-descriptor provider the discovery manager does not list", async () => {
		const fixture = setup({ providers: ["dynamic-provider"] });

		const refreshed = await refreshMissingQualifiedModelProviders("devin/swe-2-max", fixture.modelRegistry as never);

		expect(refreshed).toBe(true);
		expect(fixture.refreshCalls).toEqual([["devin", "online-if-uncached"]]);
	});

	test("canonicalizes descriptor provider casing and still ignores unknown providers", async () => {
		const fixture = setup({ providers: [] });

		const refreshed = await refreshMissingQualifiedModelProviders(
			["DEVIN/adaptive", "not-a-descriptor/model"],
			fixture.modelRegistry as never,
		);

		expect(refreshed).toBe(true);
		expect(fixture.refreshCalls).toEqual([["devin", "online-if-uncached"]]);
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
	test("lists known built-in dynamic providers as refreshable even when configured discovery is empty", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-builtin-dynamic-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		try {
			expect(registry.getDiscoverableProviders()).not.toContain("google-antigravity");
			expect(registry.getRefreshableProviders()).toContain("google-antigravity");
			expect(registry.getRefreshableProviders()).not.toContain("unknown-provider");
			const exactSelector = "google-antigravity/gemini-3.8-flash-tiered";
			expect(registry.find("google-antigravity", "gemini-3.8-flash-tiered")).toBeUndefined();
			const refreshSpy = vi.spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
			const refreshed = await refreshMissingQualifiedModelProviders(exactSelector, registry);
			expect(refreshed).toBe(true);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(refreshSpy).toHaveBeenCalledWith("google-antigravity", "online-if-uncached");
		} finally {
			await registry.dispose();
			authStorage.close();
		}
	});

	test("does not refresh an unknown qualified provider", async () => {
		const fixture = setup();
		const refreshed = await refreshMissingQualifiedModelProviders(
			"unknown-provider/model",
			fixture.modelRegistry as never,
		);
		expect(refreshed).toBe(false);
		expect(fixture.refreshCalls).toEqual([]);
	});

	test("disabled built-in dynamic providers are omitted from refreshable ids and suppress refresh", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-builtin-disabled-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ disabledProviders: ["google-antigravity"] });
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), settings);
		try {
			expect(registry.getRefreshableProviders()).not.toContain("google-antigravity");
			const refreshSpy = vi.spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
			const refreshed = await refreshMissingQualifiedModelProviders(
				"google-antigravity/gemini-3.8-flash-tiered",
				registry,
			);
			expect(refreshed).toBe(false);
			expect(refreshSpy).not.toHaveBeenCalled();
		} finally {
			await registry.dispose();
			authStorage.close();
		}
	});

	test("credential-less antigravity refresh does not prune the existing catalog", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-builtin-noauth-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		try {
			const beforeAll = registry.getAll().map(entry => `${entry.provider}/${entry.id}`);
			const beforeAvailable = registry.getAvailable().map(entry => `${entry.provider}/${entry.id}`);
			expect(beforeAll).not.toEqual([]);
			await registry.refreshProvider("google-antigravity", "online-if-uncached");
			const afterAll = registry.getAll().map(entry => `${entry.provider}/${entry.id}`);
			const afterAvailable = registry.getAvailable().map(entry => `${entry.provider}/${entry.id}`);
			expect(afterAll).toEqual(beforeAll);
			expect(afterAvailable).toEqual(beforeAvailable);
			expect(registry.find("google-antigravity", "gemini-3.8-flash-tiered")).toBeUndefined();
		} finally {
			await registry.dispose();
			authStorage.close();
		}
	});
});
