#!/usr/bin/env bun

// Copilot model premium request multipliers by model identifier.
const COPILOT_PREMIUM_MULTIPLIERS: Record<string, number> = {
	"github-copilot/claude-haiku-4.5": 0.33,
	"github-copilot/claude-opus-4.6": 3,
	"github-copilot/gpt-4o": 0,
	"github-copilot/gpt-5.4-mini": 0.33,
	"github-copilot/grok-code-fast-1": 0.25,
};

import * as path from "node:path";
import { $env } from "@gajae-code/utils";
import { AuthStorage, type OAuthAccess, SqliteAuthCredentialStore } from "../src/auth-storage";
import { createModelManager } from "../src/model-manager";
import { RETIRED_MODEL_KEYS } from "../src/model-retirements";
import {
	applyGeneratedModelPolicies,
	CLOUDFLARE_FALLBACK_MODEL,
	linkOpenAIPromotionTargets,
} from "../src/model-thinking";
import prevModelsJson from "../src/models.json" with { type: "json" };
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogDiscoveryConfig,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
	PROVIDER_DESCRIPTORS,
} from "../src/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	UNK_CONTEXT_WINDOW,
	UNK_MAX_TOKENS,
} from "../src/provider-models/openai-compat";
import { getGitLabDuoModels } from "../src/providers/gitlab-duo";
import { JWT_CLAIM_PATH } from "../src/providers/openai-codex/constants";
import type { Model } from "../src/types";
import { fetchAntigravityDiscoveryModels } from "../src/utils/discovery/antigravity";
import { fetchCodexModels } from "../src/utils/discovery/codex";
import type { OAuthProvider } from "../src/utils/oauth/types";

const AZURE_OPENAI_CATALOG_MODEL_IDS = ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o3-mini"] as const;

function createAzureOpenAICatalogModels(): Model<"azure-openai-responses">[] {
	return AZURE_OPENAI_CATALOG_MODEL_IDS.map(modelId => {
		const reference = (prevModelsJson as Record<string, Record<string, Model>>).openai?.[modelId];
		return {
			...(reference ?? {
				name: modelId,
				reasoning: modelId.startsWith("o"),
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: UNK_CONTEXT_WINDOW,
				maxTokens: UNK_MAX_TOKENS,
			}),
			id: modelId,
			name: reference?.name ?? modelId,
			api: "azure-openai-responses",
			provider: "azure-openai",
			baseUrl: "",
		} as Model<"azure-openai-responses">;
	});
}

const packageRoot = path.join(import.meta.dir, "..");
// Keep retired selectors out of regenerated bundled catalogs.
const RETIRED_BUNDLED_MODEL_KEYS = new Set<string>(RETIRED_MODEL_KEYS);

function isRetiredBundledModel(model: Pick<Model, "provider" | "id">): boolean {
	return RETIRED_BUNDLED_MODEL_KEYS.has(`${model.provider}/${model.id}`);
}

/**
 * Inject dedicated image generation models into providers that support them.
 * gpt-image-2 is registered under openai and openai-codex so the image
 * generation tool can route through a dedicated model instead of the active
 * chat model. These entries are image-only and should be excluded from the
 * chat model browser UI.
 */
export function injectImageGenerationModels(models: Model[]): void {
	const imageModelBase = {
		id: "gpt-image-2",
		name: "GPT Image 2",
		reasoning: false,
		input: ["text"],
		output: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} satisfies Omit<Model, "api" | "provider" | "baseUrl">;
	const hasOpenAI = models.some(m => m.provider === "openai" && m.id === "gpt-image-2");
	if (!hasOpenAI) {
		const openAIImageModel: Model<"openai-responses"> = {
			...imageModelBase,
			api: "openai-responses",
			provider: "openai",
			baseUrl: "",
		};
		models.push(openAIImageModel);
	}
	const hasCodex = models.some(m => m.provider === "openai-codex" && m.id === "gpt-image-2");
	if (!hasCodex) {
		const codexImageModel: Model<"openai-codex-responses"> = {
			...imageModelBase,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "",
		};
		models.push(codexImageModel);
	}
}

/**
 * A first-party model transcribed from published provider documentation, kept as
 * a typed generator input instead of a hand-edit in the generated catalog.
 */
interface FirstPartyCatalogSeed {
	/** Upstream-shaped entry; normalization (name scrub, thinking, limits) runs later. */
	readonly model: Model;
	/** Published documentation the fields were transcribed from. */
	readonly provenance: {
		readonly sources: readonly string[];
		readonly retrievedAt: string;
	};
}

/**
 * Typed catalog seeds for first-party models that live upstream sources do not
 * return yet.
 *
 * models.dev and provider discovery stay the primary sources: a seed is skipped
 * whenever a live source returned the same provider/model key. A seed does
 * outrank the previously generated `src/models.json` row, so correcting a seed
 * field corrects the regenerated catalog instead of losing to the stale row it
 * bootstrapped. The seed is upstream-shaped and flows through the same pipeline
 * as every other entry (`applyGlobalModelsDevFallback`,
 * `applyGeneratedModelPolicies`, name scrubbing, thinking inference), and the
 * emitted row carries `catalogProvenance` so the artifact records which
 * documentation produced its fields.
 */
export const FIRST_PARTY_CATALOG_SEEDS: readonly FirstPartyCatalogSeed[] = [
	{
		// Claude Opus 5: GA on the Claude API, announced 2026-07-24.
		model: {
			id: "claude-opus-5",
			name: "Claude Opus 5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		} satisfies Model<"anthropic-messages">,
		provenance: {
			sources: [
				"https://platform.claude.com/docs/en/about-claude/models/overview",
				"https://platform.claude.com/docs/en/about-claude/pricing",
			],
			retrievedAt: "2026-07-25",
		},
	},
];

function modelKey(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Merge typed catalog seeds for provider/model keys the live sources did not
 * return, binding each seed's provenance into the emitted row. Idempotent: a key
 * already present in `models` is left untouched, so live upstream metadata wins.
 */
export function injectFirstPartyCatalogSeeds(models: Model[]): void {
	const present = new Set(models.map(modelKey));
	for (const seed of FIRST_PARTY_CATALOG_SEEDS) {
		if (present.has(modelKey(seed.model))) {
			continue;
		}
		present.add(modelKey(seed.model));
		models.push({
			...seed.model,
			input: [...seed.model.input],
			cost: { ...seed.model.cost },
			catalogProvenance: {
				sources: [...seed.provenance.sources],
				retrievedAt: seed.provenance.retrievedAt,
			},
		});
	}
}

/** Provider/model keys the typed seed table owns. */
export function firstPartyCatalogSeedKeys(): ReadonlySet<string> {
	return new Set(FIRST_PARTY_CATALOG_SEEDS.map(seed => modelKey(seed.model)));
}

async function resolveProviderApiKey(providerId: string, catalog: CatalogDiscoveryConfig): Promise<string | undefined> {
	for (const envVar of catalog.envVars) {
		const value = $env[envVar as keyof typeof $env];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	try {
		const store = await SqliteAuthCredentialStore.open();
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.reload();
			const storedApiKey = await authStorage.getApiKey(providerId);
			if (storedApiKey) {
				return storedApiKey;
			}
			if (catalog.oauthProvider) {
				// AuthStorage.getApiKey refreshes through the broker-aware
				// single-flighted machinery, so a build-time invocation no
				// longer silently falls back to bundled models when an
				// expired-but-refreshable OAuth credential is on disk.
				const oauthKey = await authStorage.getApiKey(catalog.oauthProvider);
				if (oauthKey) {
					return oauthKey;
				}
			}
		} finally {
			store.close();
		}
	} catch {
		// Ignore missing/unreadable auth storage.
	}

	return undefined;
}

async function fetchProviderModelsFromCatalog(descriptor: CatalogProviderDescriptor): Promise<Model[]> {
	const apiKey = await resolveProviderApiKey(descriptor.providerId, descriptor.catalogDiscovery);

	if (!apiKey && !allowsUnauthenticatedCatalogDiscovery(descriptor)) {
		console.log(`No ${descriptor.catalogDiscovery.label} credentials found (env or agent.db), using fallback models`);
		return [];
	}

	try {
		console.log(`Fetching models from ${descriptor.catalogDiscovery.label} model manager...`);
		const manager = createModelManager(descriptor.createModelManagerOptions({ apiKey }));
		const result = await manager.refresh("online");
		const models = result.models.filter(model => model.provider === descriptor.providerId);
		if (models.length === 0) {
			console.warn(`${descriptor.catalogDiscovery.label} discovery returned no models, using fallback models`);
			return [];
		}
		console.log(`Fetched ${models.length} models from ${descriptor.catalogDiscovery.label} model manager`);
		return models;
	} catch (error) {
		console.error(`Failed to fetch ${descriptor.catalogDiscovery.label} models:`, error);
		return [];
	}
}

async function loadModelsDevData(): Promise<Model[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		const data = await response.json();
		const models = mapModelsDevToModels(data as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS);
		models.sort((a, b) => a.id.localeCompare(b.id));
		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		return [];
	}
}

function createGlobalModelsDevReferenceMap(modelsDevModels: readonly Model[]): Map<string, Model> {
	const references = new Map<string, Model>();
	for (const model of modelsDevModels) {
		const existing = references.get(model.id);
		if (!existing) {
			references.set(model.id, model);
			continue;
		}
		if (model.contextWindow > existing.contextWindow) {
			references.set(model.id, model);
			continue;
		}
		if (model.contextWindow === existing.contextWindow && model.maxTokens > existing.maxTokens) {
			references.set(model.id, model);
		}
	}
	return references;
}

function inheritModelsDevLimit(value: number, referenceValue: number, unspecifiedValue: number): number {
	return value === unspecifiedValue ? referenceValue : value;
}

function applyGlobalModelsDevFallback(models: readonly Model[], modelsDevModels: readonly Model[]): Model[] {
	const providerScopedKeys = new Set(modelsDevModels.map(model => `${model.provider}/${model.id}`));
	const globalReferences = createGlobalModelsDevReferenceMap(modelsDevModels);
	return models.map(model => {
		if (providerScopedKeys.has(`${model.provider}/${model.id}`)) {
			return model;
		}
		const reference = globalReferences.get(model.id);
		if (!reference) {
			return model;
		}
		return {
			...model,
			name: reference.name,
			reasoning: reference.reasoning,
			input: reference.input,
			// Fill unknown endpoint limits from same-id models.dev references, but keep
			// provider-specific values when discovery returned them explicitly.
			contextWindow: inheritModelsDevLimit(model.contextWindow, reference.contextWindow, UNK_CONTEXT_WINDOW),
			maxTokens: inheritModelsDevLimit(model.maxTokens, reference.maxTokens, UNK_MAX_TOKENS),
		};
	});
}

function applyPremiumMultiplierOverrides(models: readonly Model[]): Model[] {
	return models.map(model => {
		const premiumMultiplier = COPILOT_PREMIUM_MULTIPLIERS[`${model.provider}/${model.id}`];
		if (premiumMultiplier === undefined) {
			return model;
		}
		if (model.premiumMultiplier === premiumMultiplier) {
			return model;
		}
		return {
			...model,
			premiumMultiplier,
		};
	});
}
function hasBillableCost(cost: Model["cost"]): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

function applyCodexPricingFallback(models: readonly Model[]): Model[] {
	const openAIModels = new Map(
		models
			.filter(model => model.provider === "openai" && hasBillableCost(model.cost))
			.map(model => [model.id, model.cost]),
	);

	return models.map(model => {
		if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
			return model;
		}
		if (hasBillableCost(model.cost)) {
			return model;
		}

		const openAICost = openAIModels.get(model.id);
		if (!openAICost) {
			return model;
		}

		return {
			...model,
			cost: { ...openAICost },
		};
	});
}

// Catalog sources occasionally omit image input for Claude Opus 4.8 variants
// (e.g. kilo/venice "-fast" entries) even though every Claude Opus model is
// vision-capable. Correct those so capability advertising stays consistent
// across providers. Runs after the dynamic merge so it survives regeneration.
function applyClaudeOpusVisionCorrections(models: readonly Model[]): Model[] {
	return models.map(model => {
		const normalizedId = model.id.toLowerCase().replace(/\./g, "-");
		if (!normalizedId.includes("claude-opus-4-8")) {
			return model;
		}
		if (model.input.includes("image")) {
			return model;
		}
		return { ...model, input: [...model.input, "image"] };
	});
}

const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

async function getOAuthAccessFromStorage(provider: OAuthProvider): Promise<OAuthAccess | null> {
	try {
		const store = await SqliteAuthCredentialStore.open();
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.reload();
			// `getOAuthAccess` runs the full AuthStorage refresh pipeline so an
			// expired-but-refreshable credential gets rotated before discovery,
			// and identity metadata (accountId/projectId/email) flows through
			// for OpenAI code backend/Antigravity downstream calls.
			return (await authStorage.getOAuthAccess(provider)) ?? null;
		} finally {
			store.close();
		}
	} catch {
		return null;
	}
}

/**
 * Fetch available Antigravity models from the API using the discovery module.
 * Returns empty array if no auth is available (previous models used as fallback).
 */
async function fetchAntigravityModels(): Promise<Model<"google-gemini-cli">[]> {
	const access = await getOAuthAccessFromStorage("google-antigravity");
	if (!access) {
		console.log("No Antigravity credentials found, will use previous models");
		return [];
	}
	try {
		console.log("Fetching models from Antigravity API...");
		const discovered = await fetchAntigravityDiscoveryModels({
			token: access.accessToken,
			endpoint: ANTIGRAVITY_ENDPOINT,
		});
		if (discovered === null) {
			console.warn("Antigravity API fetch failed, will use previous models");
			return [];
		}
		if (discovered.length > 0) {
			console.log(`Fetched ${discovered.length} models from Antigravity API`);
			return discovered;
		}
		console.warn("Antigravity API returned no models, will use previous models");
		return [];
	} catch (error) {
		console.error("Failed to fetch Antigravity models:", error);
		return [];
	}
}

/**
 * Extract accountId from a OpenAI code backend JWT access token.
 */
function extractCodexAccountId(accessToken: string): string | null {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
		const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
	} catch {
		return null;
	}
}

async function fetchCodexDiscoveryModels(): Promise<Model<"openai-codex-responses">[]> {
	const access = await getOAuthAccessFromStorage("openai-codex");
	if (!access) {
		return [];
	}
	try {
		console.log("Fetching models from OpenAI code API...");
		const accessToken = access.accessToken;
		const accountId = access.accountId ?? extractCodexAccountId(accessToken);
		const codexDiscovery = await fetchCodexModels({
			accessToken,
			accountId: accountId ?? undefined,
		});
		if (codexDiscovery === null) {
			console.warn("OpenAI code API fetch failed");
			return [];
		}
		if (codexDiscovery.models.length > 0) {
			console.log(`Fetched ${codexDiscovery.models.length} models from OpenAI code API`);
			return codexDiscovery.models;
		}
		return [];
	} catch (error) {
		console.error("Failed to fetch OpenAI code models:", error);
		return [];
	}
}

/** Inputs the deterministic catalog composition consumes. */
export interface ComposeCatalogInput {
	/** Everything live sources returned this run (models.dev, catalog descriptors, discovery). */
	readonly liveModels: readonly Model[];
	/** models.dev rows only; used for the same-id metadata fallback. */
	readonly modelsDevModels: readonly Model[];
	/** Previously generated catalog, used as the last-resort fallback. */
	readonly previousCatalog: Record<string, Record<string, Model>>;
}

// Discovery-only providers (local inference servers) — never bundle static models.
const DISCOVERY_ONLY_PROVIDERS = new Set(["ollama", "vllm"]);

/**
 * Compose the bundled catalog from live sources, typed seeds, and the previously
 * generated catalog. Pure: no network, no credentials, no filesystem — same
 * inputs always yield the same output, which is what the generation tests assert.
 *
 * Precedence, highest first:
 *   1. live sources (models.dev, catalog descriptors, provider discovery)
 *   2. `FIRST_PARTY_CATALOG_SEEDS` (documented transcriptions)
 *   3. the previously generated catalog (static-only and auth-gated providers)
 */
export function composeCatalog(input: ComposeCatalogInput): Record<string, Record<string, Model>> {
	let allModels = applyGlobalModelsDevFallback([...input.liveModels], input.modelsDevModels);

	if (!allModels.some(model => model.provider === "cloudflare-ai-gateway")) {
		allModels.push(CLOUDFLARE_FALLBACK_MODEL);
	}

	// Typed seeds outrank the previously generated rows they bootstrapped, so a
	// seed correction reaches the regenerated catalog; live sources still win.
	injectFirstPartyCatalogSeeds(allModels);

	// Merge previous models.json entries as fallback for any provider/model
	// not fetched dynamically. This replaces all hardcoded fallback lists —
	// static-only providers (vertex, gemini-cli), auth-gated providers when
	// credentials are unavailable, and ad-hoc model additions all persist
	// through the existing models.json seed.
	const resolvedKeys = new Set(allModels.map(modelKey));

	for (const models of Object.values(input.previousCatalog)) {
		for (const model of Object.values(models)) {
			if (
				!resolvedKeys.has(modelKey(model)) &&
				!DISCOVERY_ONLY_PROVIDERS.has(model.provider) &&
				!isRetiredBundledModel(model)
			) {
				allModels.push(model.provider === "openai" ? { ...model, baseUrl: "" } : model);
			}
		}
	}
	allModels = allModels.filter(model => !isRetiredBundledModel(model));

	allModels = applyGlobalModelsDevFallback(allModels, input.modelsDevModels);
	allModels = applyPremiumMultiplierOverrides(allModels);
	allModels = applyCodexPricingFallback(allModels);
	allModels = applyClaudeOpusVisionCorrections(allModels);
	applyGeneratedModelPolicies(allModels);
	linkOpenAIPromotionTargets(allModels);
	injectImageGenerationModels(allModels);

	// Group by provider and sort each provider's models
	const providers: Record<string, Record<string, Model>> = {};
	for (const model of allModels) {
		if (DISCOVERY_ONLY_PROVIDERS.has(model.provider)) continue;
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// Use model ID as key to automatically deduplicate
		// Only add if not already present (models.dev takes priority over endpoint discovery)
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	// Sort providers alphabetically and models within each provider by ID
	const sortObj = <V>(o: Record<string, V>): Record<string, V> => {
		return Object.fromEntries(
			Object.entries(o)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([id, model]) => [id, model]),
		);
	};

	const MODELS: Record<string, Record<string, Model>> = sortObj(providers);
	for (const key in MODELS) {
		MODELS[key] = sortObj(MODELS[key]);
	}
	return MODELS;
}

async function generateModels() {
	// Fetch models from dynamic sources
	const modelsDevModels = await loadModelsDevData();
	const catalogProviderModels = (
		await Promise.all(
			PROVIDER_DESCRIPTORS.filter(isCatalogDescriptor).map(descriptor => fetchProviderModelsFromCatalog(descriptor)),
		)
	).flat();
	const gitLabDuoModels = getGitLabDuoModels();
	const liveModels: Model[] = [
		...modelsDevModels,
		...catalogProviderModels,
		...gitLabDuoModels,
		...createAzureOpenAICatalogModels(),
	];

	const specialDiscoverySources = [
		{ label: "Antigravity", fetch: fetchAntigravityModels },
		{ label: "OpenAI code", fetch: fetchCodexDiscoveryModels },
	] as const;
	const specialDiscoveries = await Promise.all(
		specialDiscoverySources.map(async source => ({
			label: source.label,
			models: await source.fetch(),
		})),
	);
	for (const discovery of specialDiscoveries) {
		if (discovery.models.length > 0) {
			console.log(`Added ${discovery.models.length} models from ${discovery.label} discovery`);
			liveModels.push(...discovery.models);
		}
	}

	const MODELS = composeCatalog({
		liveModels,
		modelsDevModels,
		previousCatalog: prevModelsJson as Record<string, Record<string, Model>>,
	});

	// Generate JSON file
	await Bun.write(path.join(packageRoot, "src/models.json"), JSON.stringify(MODELS, null, "	"));
	console.log("Generated src/models.json");

	// Print statistics
	const allModels = Object.values(MODELS).flatMap(models => Object.values(models));
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`
Model Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(MODELS)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

if (import.meta.main) {
	generateModels().catch(console.error);
}
