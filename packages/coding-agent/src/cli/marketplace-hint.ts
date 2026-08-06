/**
 * Install-failure hints for marketplace-shaped plugin names.
 *
 * A bare spec (no `@marketplace`) is always classified as npm, so a user who
 * copies a plugin name out of `plugin discover` gets an npm resolution failure
 * with no hint that the same name is offered by a registered marketplace.
 *
 * Kept dependency-free — the marketplace barrel loads native addons — so this
 * takes the narrow catalog surface it actually reads instead of the manager.
 */

/** The catalog lookups this module needs; `MarketplaceManager` satisfies it. */
export interface MarketplaceCatalogLookup {
	listMarketplaces(): Promise<ReadonlyArray<{ name: string }>>;
	getPluginInfo(name: string, marketplace: string): Promise<unknown | null>;
}

/**
 * A bare name carries no `@scope`, version specifier, or path separator, so it
 * is the only install spec shape that is safe to echo back in an error.
 */
export function isBareInstallName(spec: string): boolean {
	return spec.length > 0 && !spec.includes("@") && !spec.includes("/") && !spec.includes("\\");
}

/**
 * Names of registered marketplaces whose catalog offers a plugin under exactly
 * `name`. Only marketplace names are returned: they are user-chosen registry
 * labels, never the plugin source, so they carry no credentials or home paths.
 */
export async function findMarketplacesOffering(catalogs: MarketplaceCatalogLookup, name: string): Promise<string[]> {
	const marketplaces = await catalogs.listMarketplaces();
	const offering: string[] = [];
	for (const marketplace of marketplaces) {
		const info = await catalogs.getPluginInfo(name, marketplace.name).catch(() => null);
		if (info) offering.push(marketplace.name);
	}
	return offering;
}
