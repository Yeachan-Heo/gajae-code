/**
 * List available models with optional fuzzy search
 */
import { type Api, getSupportedEfforts, type Model } from "@gajae-code/ai";
import { fuzzyFilter } from "@gajae-code/tui";
import { formatNumber } from "@gajae-code/utils";
import type { ModelRegistry } from "../config/model-registry";
import {
	discoverAndLoadExtensions,
	type ExtensionFactory,
	loadExtensionFromFactory,
	loadExtensions,
} from "../extensibility/extensions";
import { EventBus } from "../utils/event-bus";

interface ProviderRow {
	provider: string;
	model: string;
	context: string;
	maxOut: string;
	thinking: string;
	images: string;
}

interface CanonicalRow {
	canonical: string;
	selected: string;
	variants: string;
	context: string;
	maxOut: string;
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function renderTable<T extends Record<string, string>>(rows: T[], headers: T): void {
	const widths = Object.fromEntries(
		Object.keys(headers).map(key => [key, Math.max(headers[key]!.length, ...rows.map(row => row[key]!.length))]),
	) as Record<keyof T, number>;

	const headerLine = Object.keys(headers)
		.map(key => headers[key as keyof T]!.padEnd(widths[key as keyof T]))
		.join("  ");
	writeLine(headerLine);

	for (const row of rows) {
		const line = Object.keys(headers)
			.map(key => row[key as keyof T]!.padEnd(widths[key as keyof T]))
			.join("  ");
		writeLine(line);
	}
}

/**
 * List available models, optionally filtered by search pattern
 */
export async function listModels(modelRegistry: ModelRegistry, searchPattern?: string): Promise<void> {
	const models = modelRegistry.getAvailable();

	if (models.length === 0) {
		writeLine("No models available. Set API keys in environment variables.");
		return;
	}

	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, model => `${model.provider} ${model.id}`);
	}

	const filteredCanonical = modelRegistry
		.getCanonicalModels({ availableOnly: true, candidates: filteredModels })
		.map(record => {
			const selected = modelRegistry.resolveCanonicalModel(record.id, {
				availableOnly: true,
				candidates: filteredModels,
			});
			if (!selected) return undefined;
			return {
				canonical: record.id,
				selected: `${selected.provider}/${selected.id}`,
				variants: String(record.variants.length),
				context: formatNumber(selected.contextWindow),
				maxOut: formatNumber(selected.maxTokens),
			} satisfies CanonicalRow;
		})
		.filter((row): row is CanonicalRow => row !== undefined)
		.sort((left, right) => left.canonical.localeCompare(right.canonical));

	if (filteredModels.length === 0 && filteredCanonical.length === 0) {
		writeLine(`No models matching "${searchPattern}"`);
		return;
	}

	filteredModels.sort((left, right) => {
		const providerCmp = left.provider.localeCompare(right.provider);
		if (providerCmp !== 0) return providerCmp;
		return left.id.localeCompare(right.id);
	});

	const providerRows = filteredModels.map(model => ({
		provider: model.provider,
		model: model.id,
		context: formatNumber(model.contextWindow),
		maxOut: formatNumber(model.maxTokens),
		thinking: model.thinking ? getSupportedEfforts(model).join(",") : model.reasoning ? "yes" : "-",
		images: model.input.includes("image") ? "yes" : "no",
	})) satisfies ProviderRow[];

	if (filteredCanonical.length > 0) {
		writeLine("Canonical models");
		renderTable(filteredCanonical, {
			canonical: "canonical",
			selected: "selected",
			variants: "variants",
			context: "context",
			maxOut: "max-out",
		});
		if (providerRows.length > 0) {
			writeLine();
		}
	}

	if (providerRows.length > 0) {
		writeLine("Provider models");
		renderTable(providerRows, {
			provider: "provider",
			model: "model",
			context: "context",
			maxOut: "max-out",
			thinking: "thinking",
			images: "images",
		});
	}
}

/**
 * Options for the `--list-models` command entry point.
 */
export interface RunListModelsOptions {
	modelRegistry: ModelRegistry;
	cwd: string;
	/** CLI-supplied extension paths (e.g. from `-e <path>`). */
	additionalExtensionPaths?: string[];
	/** In-process extension factories to load without filesystem discovery. */
	extensionFactories?: Array<{ factory: ExtensionFactory; name: string }>;
	/** Extension paths configured under `extensions:` in user settings. */
	settingsExtensions?: string[];
	/** Disabled extension ids from settings (`disabledExtensions`). */
	disabledExtensionIds?: string[];
	/** When true, skip discovery and only load `additionalExtensionPaths`. */
	disableExtensionDiscovery?: boolean;
	searchPattern?: string;
}

/**
 * Loads extensions (CLI `-e` paths and `settings.extensions`) and surfaces
 * any provider/model registrations on the supplied `modelRegistry` before
 * delegating to {@link listModels}. This is the single entry point used by
 * `--list-models` and exists to ensure extension-contributed providers are
 * visible in the listing (issue #905). The load is intentionally narrow:
 * no agent loop, no MCP servers, no custom-tool registration.
 */
export async function runListModelsCommand(options: RunListModelsOptions): Promise<void> {
	const {
		modelRegistry,
		cwd,
		additionalExtensionPaths = [],
		extensionFactories = [],
		settingsExtensions = [],
		disabledExtensionIds = [],
		disableExtensionDiscovery = false,
		searchPattern,
	} = options;

	const eventBus = new EventBus();
	const extensionsResult = disableExtensionDiscovery
		? await loadExtensions(additionalExtensionPaths, cwd, eventBus)
		: await discoverAndLoadExtensions(
				[...additionalExtensionPaths, ...settingsExtensions],
				cwd,
				eventBus,
				disabledExtensionIds,
			);
	for (const { factory, name } of extensionFactories) {
		const extension = await loadExtensionFromFactory(factory, cwd, eventBus, extensionsResult.runtime, name);
		extensionsResult.extensions.push(extension);
	}

	for (const { path: extPath, error } of extensionsResult.errors) {
		process.stderr.write(`Failed to load extension: ${extPath}: ${error}\n`);
	}

	// Mirror sdk/session.ts: drain pending provider registrations into the registry.
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];

	await listModels(modelRegistry, searchPattern);
}
