import { describe, expect, test } from "bun:test";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import {
	ensureCatalogForProfile,
	ensureCatalogForSettings,
	profileSelectorsMissingFromCatalog,
} from "../src/profile-activation";

type FakeProfile = { modelMapping: Record<string, string | string[]> };

function fakeRegistry(
	models: string[],
	profiles: Record<string, FakeProfile>,
	refresh?: (strategy: string) => Promise<void>,
): ModelRegistry {
	return {
		// Catalog entries are `provider/model-id`, exactly as the registry reports them.
		getAll: () =>
			models.map(entry => {
				const [provider, ...rest] = entry.split("/");
				return { provider, id: rest.join("/") };
			}),
		getModelProfiles: () => new Map(Object.entries(profiles)),
		refresh: async (strategy: string) => refresh?.(strategy),
	} as unknown as ModelRegistry;
}

const profile = (mapping: Record<string, string | string[]>): FakeProfile => ({ modelMapping: mapping });

describe("profile catalog completion", () => {
	test("a qualified selector the catalog lacks is reported, with its reasoning suffix stripped", () => {
		const registry = fakeRegistry(["opengateway/static-a", "openrouter/other"], {
			mixed: profile({ default: "opengateway/dynamic:high", executor: "openrouter/other:xhigh" }),
		});
		expect(profileSelectorsMissingFromCatalog(registry, "mixed")).toEqual(["opengateway/dynamic:high"]);
		// Once the catalog carries the model the selector is satisfied, suffix included.
		const complete = fakeRegistry(["opengateway/dynamic", "openrouter/other"], {
			mixed: profile({ default: "opengateway/dynamic:high", executor: "openrouter/other" }),
		});
		expect(profileSelectorsMissingFromCatalog(complete, "mixed")).toEqual([]);
	});

	test("bare aliases and unknown profiles never demand a fetch", () => {
		const registry = fakeRegistry(["opengateway/static-a"], { bare: profile({ default: "some-alias:high" }) });
		expect(profileSelectorsMissingFromCatalog(registry, "bare")).toEqual([]);
		expect(profileSelectorsMissingFromCatalog(registry, "missing-profile")).toEqual([]);
	});

	test("the catalog is fetched only when a selector is actually missing, and a failed fetch is not fatal", async () => {
		const calls: string[] = [];
		const complete = fakeRegistry(
			["opengateway/dynamic"],
			{ p: profile({ default: "opengateway/dynamic" }) },
			async strategy => {
				calls.push(strategy);
			},
		);
		expect(await ensureCatalogForProfile(complete, "p")).toBe(false);
		expect(calls).toEqual([]);

		const incomplete = fakeRegistry(
			["opengateway/static-a"],
			{ p: profile({ default: "opengateway/dynamic" }) },
			async strategy => {
				calls.push(strategy);
			},
		);
		expect(await ensureCatalogForProfile(incomplete, "p")).toBe(true);
		// A forced fetch: a cached row from another discovery context can skip the network.
		expect(calls).toEqual(["online"]);

		const failing = fakeRegistry(
			["opengateway/static-a"],
			{ p: profile({ default: "opengateway/dynamic" }) },
			async () => {
				throw new Error("offline");
			},
		);
		expect(await ensureCatalogForProfile(failing, "p")).toBe(true);
	});
});

describe("catalog completion before a session is constructed", () => {
	const settings = (values: Record<string, unknown>) =>
		({ get: (key: string) => values[key] }) as unknown as Parameters<typeof ensureCatalogForSettings>[1];

	test("a resumed session's persisted role selector completes the catalog first", async () => {
		const calls: string[] = [];
		const registry = fakeRegistry(["opengateway/static-a"], {}, async strategy => {
			calls.push(strategy);
		});
		const target = settings({ modelRoles: { executor: "opengateway/dynamic:high" }, "task.agentModelOverrides": {} });
		expect(await ensureCatalogForSettings(registry, target)).toBe(true);
		expect(calls).toEqual(["online"]);
	});

	test("nothing missing means no fetch, so a warm open stays offline", async () => {
		const calls: string[] = [];
		const registry = fakeRegistry(
			["opengateway/static-a"],
			{ p: profile({ default: "opengateway/static-a" }) },
			async strategy => {
				calls.push(strategy);
			},
		);
		const target = settings({ "modelProfile.default": "p", modelRoles: { executor: "opengateway/static-a" } });
		expect(await ensureCatalogForSettings(registry, target)).toBe(false);
		expect(calls).toEqual([]);
	});

	test("the default profile's own selectors are covered too", async () => {
		const registry = fakeRegistry(["opengateway/static-a"], { p: profile({ executor: "opengateway/dynamic:high" }) });
		const target = settings({ "modelProfile.default": "p" });
		expect(await ensureCatalogForSettings(registry, target)).toBe(true);
	});
});
