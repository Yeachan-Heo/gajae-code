import { createRequire } from "node:module";
import { applyGeneratedModelPolicies, enrichModelThinking } from "./model-thinking";
import type { Api, KnownProvider, Model, Usage } from "./types";
import { isClaudeForcedToolChoiceIncapableModelId } from "./utils/tool-choice-capability";

/**
 * Static bundled model registry loaded lazily from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, models.dev overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
type BundledCatalog = typeof import("./models.json");

const require = createRequire(import.meta.url);
const COMPILED_MODELS_PATH = "./packages/ai/src/models.json";
let bundledCatalog: BundledCatalog | undefined;
let providerNames: KnownProvider[] | undefined;
const providerModelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

function getBundledCatalog(): BundledCatalog {
	bundledCatalog ??= require(
		process.env.PI_COMPILED === "true" ? COMPILED_MODELS_PATH : "./models.json",
	) as BundledCatalog;
	return bundledCatalog;
}

function getProviderModels(provider: GeneratedProvider): Map<string, Model<Api>> | undefined {
	const cached = providerModelRegistry.get(provider);
	if (cached) return cached;
	const models = getBundledCatalog()[provider];
	if (!models) return undefined;
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, applyBundledCompatDefaults(enrichModelThinking(model as Model<Api>)));
	}
	providerModelRegistry.set(provider, providerModels);
	return providerModels;
}

/**
 * Bundled-catalog compat defaults applied at load time so stale committed
 * models.json snapshots still receive policy-critical fields (e.g. Claude
 * Mythos rejecting forced tool use) without a full regeneration.
 */
function applyBundledCompatDefaults(model: Model<Api>): Model<Api> {
	let normalized = model;
	if (normalized.id === "minimax-m3" && normalized.name === "MiniMax M3") {
		normalized = { ...normalized, name: "MiniMax-M3" };
	}
	if (
		(normalized.api === "anthropic-messages" || normalized.api === "bedrock-converse-stream") &&
		isClaudeForcedToolChoiceIncapableModelId(normalized.id) &&
		(normalized.compat as { toolChoiceSupport?: string } | undefined)?.toolChoiceSupport === undefined
	) {
		return {
			...normalized,
			compat: { ...(normalized.compat ?? {}), toolChoiceSupport: "auto" } as Model<Api>["compat"],
		};
	}
	const policyModels = [normalized];
	applyGeneratedModelPolicies(policyModels);
	return policyModels[0] ?? normalized;
}

export type GeneratedProvider = keyof BundledCatalog;

export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = getProviderModels(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

export function getBundledProviders(): KnownProvider[] {
	// Defensive copy: the old eager path returned a fresh Array.from(...), so
	// callers may freely mutate their result without corrupting enumeration.
	providerNames ??= Object.keys(getBundledCatalog()) as KnownProvider[];
	return providerNames.slice();
}

export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = getProviderModels(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}
/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
