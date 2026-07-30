import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter, pathIsWithin } from "@gajae-code/utils";
import {
	type InstalledPluginEntry,
	type InstalledPluginSummary,
	MarketplaceManager,
	type MarketplacePluginEntry,
	type MarketplaceRegistryEntry,
	parsePluginId,
} from "../../extensibility/plugins/marketplace";
import type { HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type CatalogRef = {
	marketplace: MarketplaceRegistryEntry;
	plugin: MarketplacePluginEntry;
	root: string;
};

type PluginSummary = RecordValue;

const invalid = (): HandlerResult => ({ ok: false, errorKey: "invalidParams" });
const notFound = (): HandlerResult => ({ ok: false, errorKey: "notFound" });
const internal = (): HandlerResult => ({ ok: false, errorKey: "internalError" });

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredAgentDirectory(): string {
	const configured = process.env.GJC_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	return path.resolve(configured ?? getAgentDir());
}

/**
 * The app-server's plugin lane owns an explicit, isolated root so tests and
 * embedded callers can redirect all marketplace state with GJC_AGENT_DIR.
 * A conventional `.../agent` override keeps the sibling config root shape.
 */
function pluginConfigRoot(): string {
	const agentDir = configuredAgentDirectory();
	return path.basename(agentDir) === "agent" ? path.dirname(agentDir) : agentDir;
}

function pluginPaths() {
	const root = pluginConfigRoot();
	const plugins = path.join(root, "plugins");
	return {
		root,
		plugins,
		marketplacesRegistryPath: path.join(root, "marketplaces.json"),
		installedRegistryPath: path.join(plugins, "installed_plugins.json"),
		marketplacesCacheDir: path.join(plugins, "cache", "marketplaces"),
		pluginsCacheDir: path.join(plugins, "cache", "plugins"),
	};
}

function manager(): MarketplaceManager {
	const paths = pluginPaths();
	return new MarketplaceManager({
		marketplacesRegistryPath: paths.marketplacesRegistryPath,
		installedRegistryPath: paths.installedRegistryPath,
		marketplacesCacheDir: paths.marketplacesCacheDir,
		pluginsCacheDir: paths.pluginsCacheDir,
	});
}

function marketplaceRoot(entry: MarketplaceRegistryEntry): string {
	if (entry.sourceType === "local") {
		return path.resolve(
			entry.sourceUri.startsWith("~/")
				? path.join(process.env.HOME ?? "", entry.sourceUri.slice(2))
				: entry.sourceUri,
		);
	}
	return path.dirname(entry.catalogPath);
}

function localPluginPath(ref: CatalogRef): string | undefined {
	if (typeof ref.plugin.source !== "string") return undefined;
	const candidate = path.resolve(ref.root, ref.plugin.source);
	return pathIsWithin(ref.root, candidate) ? candidate : undefined;
}

function sourceFor(ref: CatalogRef, pluginPath: string | undefined): RecordValue {
	const source = ref.plugin.source;
	if (typeof source === "string") {
		return { type: "local", path: pluginPath ?? path.resolve(ref.root, source) };
	}
	if (source.source === "npm") {
		return {
			type: "npm",
			package: source.package,
			registry: source.registry ?? null,
			version: source.version ?? null,
		};
	}
	if (source.source === "github") {
		return {
			type: "git",
			url: `https://github.com/${source.repo}.git`,
			path: null,
			refName: source.ref ?? null,
			sha: source.sha ?? null,
		};
	}
	return {
		type: "git",
		url: source.url,
		path: source.source === "git-subdir" ? source.path : null,
		refName: source.ref ?? null,
		sha: source.sha ?? null,
	};
}

function capabilityNames(plugin: MarketplacePluginEntry): string[] {
	const capabilities: string[] = [];
	if (plugin.commands) capabilities.push("commands");
	if (plugin.agents) capabilities.push("agents");
	if (plugin.hooks) capabilities.push("hooks");
	if (plugin.mcpServers) capabilities.push("mcpServers");
	if (plugin.lspServers) capabilities.push("lspServers");
	return capabilities;
}

async function readJson(filePath: string): Promise<RecordValue | undefined> {
	try {
		const value: unknown = await Bun.file(filePath).json();
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function readPluginManifest(pluginPath: string | undefined): Promise<RecordValue | undefined> {
	if (!pluginPath) return undefined;
	return (
		(await readJson(path.join(pluginPath, ".claude-plugin", "plugin.json"))) ??
		(await readJson(path.join(pluginPath, "package.json")))
	);
}

function entryForInstalled(id: string, entry: InstalledPluginEntry): CatalogRef | undefined {
	const parsed = parsePluginId(id);
	if (!parsed) return undefined;
	const pluginRoot = path.resolve(entry.installPath);
	const syntheticMarketplace: MarketplaceRegistryEntry = {
		name: parsed.marketplace,
		sourceType: "local",
		sourceUri: pluginRoot,
		catalogPath: path.join(pluginRoot, ".claude-plugin", "marketplace.json"),
		addedAt: entry.installedAt,
		updatedAt: entry.lastUpdated,
	};
	const syntheticPlugin: MarketplacePluginEntry = {
		name: parsed.name,
		source: "./",
		version: entry.version,
	};
	return { marketplace: syntheticMarketplace, plugin: syntheticPlugin, root: pluginRoot };
}

function installedEntryFor(installed: readonly InstalledPluginSummary[], id: string): InstalledPluginEntry | undefined {
	const found = installed.find(item => item.id === id);
	return found?.entries.find(entry => entry.enabled !== false) ?? found?.entries[0];
}

async function summarize(
	ref: CatalogRef,
	installed: readonly InstalledPluginSummary[],
	manifestOverride?: RecordValue,
): Promise<PluginSummary> {
	const id = `${ref.plugin.name}@${ref.marketplace.name}`;
	const pluginPath = localPluginPath(ref);
	const manifest = manifestOverride ?? (await readPluginManifest(pluginPath));
	const installedEntry = installedEntryFor(installed, id);
	const version =
		(typeof manifest?.version === "string" && manifest.version) ||
		ref.plugin.version ||
		installedEntry?.version ||
		null;
	const displayName = (typeof manifest?.name === "string" && manifest.name) || ref.plugin.name;
	const description =
		(typeof manifest?.description === "string" && manifest.description) || ref.plugin.description || null;
	return {
		id,
		name: displayName,
		version,
		localVersion: installedEntry?.version ?? null,
		installed: installedEntry !== undefined,
		enabled: installedEntry?.enabled !== false,
		authPolicy: "ON_USE",
		availability: "AVAILABLE",
		installPolicy: "AVAILABLE",
		installPolicySource: null,
		interface: {
			displayName,
			shortDescription: description,
			longDescription: null,
			developerName: ref.plugin.author?.name ?? null,
			category: ref.plugin.category ?? null,
			brandColor: null,
			capabilities: capabilityNames(ref.plugin),
			composerIcon: null,
			composerIconUrl: null,
			defaultPrompt: null,
			logo: null,
			logoDark: null,
			logoUrl: null,
			logoUrlDark: null,
			privacyPolicyUrl: null,
			screenshotUrls: [],
			screenshots: [],
			termsOfServiceUrl: null,
			websiteUrl: ref.plugin.homepage ?? null,
		},
		keywords: ref.plugin.keywords ?? ref.plugin.tags ?? [],
		mustShowInstallationInterstitial: null,
		remotePluginId: null,
		shareContext: null,
		source: sourceFor(ref, pluginPath),
	};
}

async function catalogRefs(mkt: MarketplaceManager): Promise<{ refs: CatalogRef[]; errors: RecordValue[] }> {
	const refs: CatalogRef[] = [];
	const errors: RecordValue[] = [];
	for (const marketplace of await mkt.listMarketplaces()) {
		try {
			const plugins = await mkt.listAvailablePlugins(marketplace.name);
			const root = marketplaceRoot(marketplace);
			for (const plugin of plugins) refs.push({ marketplace, plugin, root });
		} catch (error) {
			errors.push({
				marketplacePath: marketplace.catalogPath,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { refs, errors };
}

async function installedPlugins(mkt: MarketplaceManager): Promise<InstalledPluginSummary[]> {
	return mkt.listInstalledPlugins();
}

function marketplaceResponse(
	refs: CatalogRef[],
	summaries: Map<string, PluginSummary>,
	errors: RecordValue[],
): RecordValue {
	const groups = new Map<string, { marketplace: MarketplaceRegistryEntry; plugins: PluginSummary[] }>();
	for (const ref of refs) {
		const group = groups.get(ref.marketplace.name) ?? { marketplace: ref.marketplace, plugins: [] };
		const id = `${ref.plugin.name}@${ref.marketplace.name}`;
		const summary = summaries.get(id);
		if (summary) group.plugins.push(summary);
		groups.set(ref.marketplace.name, group);
	}
	return {
		marketplaces: [...groups.values()].map(group => ({
			name: group.marketplace.name,
			path: group.marketplace.sourceType === "local" ? marketplaceRoot(group.marketplace) : null,
			interface: null,
			plugins: group.plugins,
		})),
		marketplaceLoadErrors: errors,
	};
}

async function resolveRef(params: RecordValue, mkt: MarketplaceManager): Promise<CatalogRef | undefined> {
	const pluginName = params.pluginName;
	if (typeof pluginName !== "string" || pluginName.length === 0) return undefined;
	const parsed = pluginName.includes("@") ? parsePluginId(pluginName) : undefined;
	const name = parsed?.name ?? pluginName;
	const requestedMarketplace =
		parsed?.marketplace ??
		(typeof params.remoteMarketplaceName === "string" && params.remoteMarketplaceName.length > 0
			? params.remoteMarketplaceName
			: undefined);
	const pathHint = typeof params.marketplacePath === "string" ? path.resolve(params.marketplacePath) : undefined;
	const { refs } = await catalogRefs(mkt);
	return refs.find(ref => {
		if (ref.plugin.name !== name) return false;
		if (requestedMarketplace && ref.marketplace.name !== requestedMarketplace) return false;
		if (pathHint && path.resolve(ref.root) !== pathHint && path.resolve(ref.marketplace.catalogPath) !== pathHint)
			return false;
		return true;
	});
}

async function skillsFor(ref: CatalogRef): Promise<RecordValue[]> {
	const pluginPath = localPluginPath(ref);
	if (!pluginPath) return [];
	const skillsRoot = path.join(pluginPath, "skills");
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(skillsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const skills: RecordValue[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
		try {
			const content = await Bun.file(skillPath).text();
			const parsed = parseFrontmatter(content, { source: skillPath, level: "off" });
			const description =
				typeof parsed.frontmatter.description === "string" ? parsed.frontmatter.description : entry.name;
			skills.push({
				name: typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : entry.name,
				description,
				shortDescription: null,
				enabled: parsed.frontmatter.enabled !== false,
				interface: null,
				path: skillPath,
			});
		} catch {
			// Invalid skill files are not advertised as readable skills.
		}
	}
	return skills;
}

async function mcpServersFor(pluginPath: string | undefined): Promise<string[]> {
	if (!pluginPath) return [];
	const manifest = await readJson(path.join(pluginPath, ".mcp.json"));
	const servers = manifest?.mcpServers;
	return isRecord(servers) ? Object.keys(servers).sort() : [];
}

/** Enumerate the real local marketplace/plugin inventory. */
export const pluginListHandler: MethodHandler = async params => {
	if (!isRecord(params) || typeof params.forceRefetch !== "boolean") return invalid();
	try {
		const mkt = manager();
		const [{ refs, errors }, installed] = await Promise.all([catalogRefs(mkt), installedPlugins(mkt)]);
		const summaries = new Map<string, PluginSummary>();
		for (const ref of refs)
			summaries.set(`${ref.plugin.name}@${ref.marketplace.name}`, await summarize(ref, installed));
		return { ok: true, result: { ...marketplaceResponse(refs, summaries, errors), featuredPluginIds: [] } };
	} catch {
		return internal();
	}
};

/** Enumerate only plugins recorded by the real installed-plugin registry. */
export const pluginInstalledHandler: MethodHandler = async params => {
	if (params !== undefined && !isRecord(params)) return invalid();
	try {
		const mkt = manager();
		const [{ refs, errors }, installed] = await Promise.all([catalogRefs(mkt), installedPlugins(mkt)]);
		const refsById = new Map(refs.map(ref => [`${ref.plugin.name}@${ref.marketplace.name}`, ref]));
		const selected: CatalogRef[] = [];
		const summaries = new Map<string, PluginSummary>();
		for (const item of installed) {
			const ref =
				refsById.get(item.id) ?? (item.entries[0] ? entryForInstalled(item.id, item.entries[0]) : undefined);
			if (!ref) continue;
			selected.push(ref);
			summaries.set(item.id, await summarize(ref, installed));
		}
		return { ok: true, result: marketplaceResponse(selected, summaries, errors) };
	} catch {
		return internal();
	}
};

/** Read a real plugin manifest and project its on-disk capabilities. */
export const pluginReadHandler: MethodHandler = async params => {
	if (!isRecord(params) || typeof params.pluginName !== "string") return invalid();
	try {
		const mkt = manager();
		const ref = await resolveRef(params, mkt);
		if (!ref) return notFound();
		const installed = await installedPlugins(mkt);
		const pluginPath = localPluginPath(ref);
		const manifest = await readPluginManifest(pluginPath);
		const summary = await summarize(ref, installed, manifest);
		return {
			ok: true,
			result: {
				plugin: {
					summary,
					marketplaceName: ref.marketplace.name,
					marketplacePath: marketplaceRoot(ref.marketplace),
					description:
						typeof manifest?.description === "string" ? manifest.description : (ref.plugin.description ?? null),
					apps: [],
					appTemplates: [],
					hooks: [],
					mcpServers: await mcpServersFor(pluginPath),
					scheduledTasks: null,
					shareUrl: null,
					skills: await skillsFor(ref),
				},
			},
		};
	} catch {
		return internal();
	}
};

/** Install through MarketplaceManager's local/remote source resolver and cache. */
export const pluginInstallHandler: MethodHandler = async params => {
	if (!isRecord(params) || typeof params.pluginName !== "string") return invalid();
	try {
		const mkt = manager();
		const pluginName = params.pluginName;
		const parsed = pluginName.includes("@") ? parsePluginId(pluginName) : undefined;
		const marketplaceName =
			parsed?.marketplace ??
			(typeof params.remoteMarketplaceName === "string" && params.remoteMarketplaceName.length > 0
				? params.remoteMarketplaceName
				: undefined);
		const name = parsed?.name ?? pluginName;
		let marketplace = marketplaceName;
		if (!marketplace && typeof params.marketplacePath === "string") {
			const hint = path.resolve(params.marketplacePath);
			const entry = (await mkt.listMarketplaces()).find(
				candidate => path.resolve(candidate.sourceUri) === hint || path.resolve(candidate.catalogPath) === hint,
			);
			marketplace = entry?.name;
		}
		if (!marketplace) {
			const marketplaces = await mkt.listMarketplaces();
			if (marketplaces.length === 1) marketplace = marketplaces[0].name;
		}
		if (!marketplace) return notFound();
		const available = await mkt.getPluginInfo(name, marketplace);
		if (!available) return notFound();
		await mkt.installPlugin(name, marketplace, { scope: "user" });
		return { ok: true, result: { appsNeedingAuth: [], authPolicy: "ON_USE" } };
	} catch (error) {
		if (error instanceof Error && (error.message.includes("not found") || error.message.includes("not installed")))
			return notFound();
		return internal();
	}
};

/** Uninstall through MarketplaceManager's registry-safe cache deletion seam. */
export const pluginUninstallHandler: MethodHandler = async params => {
	if (!isRecord(params) || typeof params.pluginId !== "string") return invalid();
	try {
		await manager().uninstallPlugin(params.pluginId);
		return { ok: true, result: {} };
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.includes("not installed") || error.message.includes("Invalid plugin ID"))
		)
			return notFound();
		return internal();
	}
};

/** Read a real SKILL.md belonging to a locally installed marketplace plugin. */
export const pluginSkillReadHandler: MethodHandler = async params => {
	if (
		!isRecord(params) ||
		typeof params.remoteMarketplaceName !== "string" ||
		typeof params.remotePluginId !== "string" ||
		typeof params.skillName !== "string"
	)
		return invalid();
	try {
		const mkt = manager();
		const refs = (await catalogRefs(mkt)).refs;
		const pluginId = params.remotePluginId.includes("@")
			? params.remotePluginId
			: `${params.remotePluginId}@${params.remoteMarketplaceName}`;
		const ref = refs.find(candidate => `${candidate.plugin.name}@${candidate.marketplace.name}` === pluginId);
		if (!ref) return notFound();
		const pluginPath = localPluginPath(ref);
		if (!pluginPath) return notFound();
		const candidate = path.resolve(pluginPath, "skills", params.skillName, "SKILL.md");
		if (!pathIsWithin(pluginPath, candidate)) return notFound();
		try {
			const contents = await Bun.file(candidate).text();
			return { ok: true, result: { contents } };
		} catch {
			return notFound();
		}
	} catch {
		return internal();
	}
};

export const pluginHandlers: Record<string, MethodHandler> = {
	"plugin/list": pluginListHandler,
	"plugin/installed": pluginInstalledHandler,
	"plugin/read": pluginReadHandler,
	"plugin/install": pluginInstallHandler,
	"plugin/uninstall": pluginUninstallHandler,
	"plugin/skill/read": pluginSkillReadHandler,
};
