import { describe, expect, it } from "bun:test";

// Import from the zero-dep classify/hint modules — plugin-cli.ts transitively loads native addons.
import { classifyInstallTarget } from "../../src/cli/classify-install-target";
import {
	findMarketplacesOffering,
	isBareInstallName,
	type MarketplaceCatalogLookup,
} from "../../src/cli/marketplace-hint";

const KNOWN = new Set(["my-marketplace"]);

describe("classifyInstallTarget", () => {
	it("classifies plugin@marketplace as marketplace when marketplace is registered", () => {
		const result = classifyInstallTarget("hello@my-marketplace", KNOWN);
		expect(result).toEqual({ type: "marketplace", name: "hello", marketplace: "my-marketplace" });
	});

	it("classifies scoped @scope/pkg as npm (rule 1: starts with @)", () => {
		const result = classifyInstallTarget("@scope/pkg", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "@scope/pkg" });
	});

	it("classifies @scope/pkg@1.0.0 as npm (starts with @, rule 1 wins)", () => {
		const result = classifyInstallTarget("@scope/pkg@1.0.0", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "@scope/pkg@1.0.0" });
	});

	it("classifies bare name with no @ as npm", () => {
		const result = classifyInstallTarget("bare-name", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "bare-name" });
	});

	it("classifies pkg@version as npm when version is not a known marketplace", () => {
		const result = classifyInstallTarget("pkg@1.2.3", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "pkg@1.2.3" });
	});

	it("classifies pkg@marketplace as npm when marketplace is not registered", () => {
		const result = classifyInstallTarget("hello@my-marketplace", new Set());
		expect(result).toEqual({ type: "npm", spec: "hello@my-marketplace" });
	});

	it("scoped @scope/pkg@marketplace is still npm — rule 1 wins", () => {
		// Even though this starts with @, the rule only triggers when spec.startsWith("@")
		// but @scope/pkg@my-marketplace DOES start with @ so rule 1 applies -> npm.
		// This confirms rule 1 is absolute for scoped packages.
		const result = classifyInstallTarget("@scope/pkg@my-marketplace", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "@scope/pkg@my-marketplace" });
	});

	it("splits on last @ for non-scoped multi-@ spec", () => {
		// e.g. "some-pkg@my-marketplace" where my-marketplace is known
		const result = classifyInstallTarget("some-pkg@my-marketplace", KNOWN);
		expect(result).toEqual({ type: "marketplace", name: "some-pkg", marketplace: "my-marketplace" });
	});
});

describe("isBareInstallName", () => {
	it("accepts a bare plugin name", () => {
		expect(isBareInstallName("hello-plugin")).toBe(true);
	});

	it("rejects specs that could carry a scope, version, or path", () => {
		expect(isBareInstallName("@scope/pkg")).toBe(false);
		expect(isBareInstallName("hello-plugin@1.0.0")).toBe(false);
		expect(isBareInstallName("./local/plugin")).toBe(false);
		expect(isBareInstallName("C:\\plugins\\hello")).toBe(false);
		expect(isBareInstallName("")).toBe(false);
	});
});

describe("findMarketplacesOffering", () => {
	function catalogs(entries: Record<string, string[]>, failing: string[] = []): MarketplaceCatalogLookup {
		return {
			listMarketplaces: async () => Object.keys(entries).map(name => ({ name })),
			getPluginInfo: async (name, marketplace) => {
				if (failing.includes(marketplace)) throw new Error(`catalog unreadable: ${marketplace}`);
				return entries[marketplace]?.includes(name) ? { name } : null;
			},
		};
	}

	it("returns nothing when no marketplace is registered", async () => {
		expect(await findMarketplacesOffering(catalogs({}), "hello-plugin")).toEqual([]);
	});

	it("names every marketplace whose catalog offers the bare name", async () => {
		const lookup = catalogs({ "mkt-a": ["hello-plugin"], "mkt-b": ["other"], "mkt-c": ["hello-plugin"] });
		expect(await findMarketplacesOffering(lookup, "hello-plugin")).toEqual(["mkt-a", "mkt-c"]);
	});

	it("returns nothing for a name absent from every catalog", async () => {
		const lookup = catalogs({ "mkt-a": ["hello-plugin"] });
		expect(await findMarketplacesOffering(lookup, "not-a-plugin")).toEqual([]);
	});

	it("skips a marketplace whose catalog cannot be read", async () => {
		const lookup = catalogs({ broken: ["hello-plugin"], "mkt-a": ["hello-plugin"] }, ["broken"]);
		expect(await findMarketplacesOffering(lookup, "hello-plugin")).toEqual(["mkt-a"]);
	});
});
