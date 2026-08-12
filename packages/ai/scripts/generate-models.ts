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
	Effort,
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
 * Keep the Alibaba Token Plan DeepSeek V4 Flash executor and non-preview
 * Qwen3.8 Max models available when authenticated catalog discovery is
 * unavailable during generation.
 */
export function injectAlibabaTokenPlanModels(models: Model[]): void {
	const deepseek: Model<"openai-completions"> = {
		id: "deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
		api: "openai-completions",
		provider: "alibaba-token-plan",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		compat: { supportsDeveloperRole: false },
	};
	const qwen: Model<"openai-responses"> = {
		id: "qwen3.8-max",
		name: "Qwen3.8 Max",
		api: "openai-responses",
		provider: "alibaba-token-plan",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		compat: { supportsDeveloperRole: false },
	};
	for (let index = models.length - 1; index >= 0; index--) {
		const model = models[index]!;
		if (model.provider === "alibaba-token-plan" && model.id === "qwen-3.8-max") {
			models.splice(index, 1);
		}
	}
	for (const metadata of [deepseek, qwen]) {
		const existing = models.find(model => model.provider === "alibaba-token-plan" && model.id === metadata.id);
		if (existing) {
			Object.assign(existing, metadata);
		} else {
			models.push(metadata);
		}
	}
}

/**
 * Keep Muse Spark 1.2 available through OpenRouter when live catalog
 * regeneration is unavailable or the bundled seed predates the release.
 *
 * Meta's model catalog and reasoning documentation are authoritative for the
 * model id, context window, and effort range. OpenRouter's public catalog is
 * authoritative for this provider route and pricing.
 */
export function injectMuseSparkModels(models: Model[]): void {
	const metadata: Model<"openai-completions"> = {
		id: "meta/muse-spark-1.2",
		name: "Meta: Muse Spark 1.2",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		// GJC's current Model.input contract represents only text/image. Meta and
		// OpenRouter also accept video, audio, and PDF/file inputs for this model;
		// those modalities remain intentionally unadvertised until the shared model
		// contract and request pipelines can represent them end to end.
		input: ["text", "image"],
		cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinking: {
			mode: "effort",
			minLevel: Effort.Minimal,
			maxLevel: Effort.XHigh,
		},
	};
	const existing = models.find(model => model.provider === metadata.provider && model.id === metadata.id);
	if (existing) {
		Object.assign(existing, metadata);
	} else {
		models.push(metadata);
	}
}

/**
 * JetBrains AI (Junie) is not published on models.dev and exposes no model-list
 * endpoint, so its catalog is declared statically.
 *
 * The ids are the CLI's own authoritative list (`junie --model <invalid>` prints
 * it), cross-checked against the model constants compiled into the Junie CLI
 * 2470.4 jar. The CLI additionally offers bare `opus`/`sonnet`/`gpt`/`grok`
 * aliases, but those are client-side shorthands the gateway rejects with
 * `Model not found for tag`, so they are deliberately excluded.
 *
 * The gateway multiplexes transports by family, selected with the `X-LLM-Model`
 * routing header, all captured from live traffic:
 *   - Claude  -> `X-LLM-Model: anthropic`, Anthropic Messages on `/v1/messages`
 *   - GPT     -> `X-LLM-Model: openai`, Chat Completions on `/v1/chat/completions`,
 *                except `gpt-5.3-codex` which is Responses-only (Chat Completions
 *                rejects it with `OpenAI Completions Proxy API is not supported`)
 *   - Gemini  -> `X-LLM-Model: google`, proprietary Grazie translation protocol
 *   - Grok    -> `X-LLM-Model: grok`
 *
 * Claude and GPT are verified end to end against the live gateway. Gemini and
 * Grok are listed from the same authoritative source but their transports are
 * not implemented here, so they are intentionally NOT bundled — shipping a
 * catalog entry GJC cannot dispatch would fail at request time instead of being
 * absent from `/model`.
 *
 * `contextWindow` and `maxTokens` are the gateway's enforced ceilings, probed
 * directly rather than copied from Junie CLI's request values (the CLI sends much
 * smaller per-model budgets, which are its own policy, not the endpoint limit).
 * Claude rejects with `prompt is too long: N tokens > 1000000 maximum`; GPT with
 * `Input tokens exceed the configured limit of 922000 tokens`. Both families cap
 * output at 128000.
 */
export const JETBRAINS_JUNIE_BASE_URL = "https://ingrazzio-cloud-prod.labs.jb.gg";

/**
 * The OpenAI transports append a bare `/chat/completions` (or `/responses`) to
 * `baseUrl`, whereas the Anthropic transport supplies its own `/v1` prefix. The
 * gateway only serves the `/v1`-prefixed routes, so the GPT lane pins it here.
 */
const JETBRAINS_JUNIE_OPENAI_BASE_URL = `${JETBRAINS_JUNIE_BASE_URL}/v1`;

const JETBRAINS_JUNIE_ANTHROPIC_HEADERS: Record<string, string> = {
	"X-LLM-Model": "anthropic",
	"X-Keep-Path": "true",
};

const JETBRAINS_JUNIE_OPENAI_HEADERS: Record<string, string> = {
	"X-LLM-Model": "openai",
	"X-Keep-Path": "true",
};

/** Gateway-enforced output ceiling, probed against the live endpoint. */
const JETBRAINS_JUNIE_MAX_TOKENS = 128_000;
/** Gateway-enforced prompt ceiling for the Claude lane, probed live. */
const JETBRAINS_JUNIE_ANTHROPIC_CONTEXT_WINDOW = 1_000_000;
/** Gateway-enforced prompt ceiling for the GPT lane, probed live. */
const JETBRAINS_JUNIE_OPENAI_CONTEXT_WINDOW = 922_000;

export function injectJetBrainsJunieModels(models: Model[]): void {
	const claudeModels: Model<"anthropic-messages">[] = [
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Junie)" },
		{ id: "claude-sonnet-5", name: "Claude Sonnet 5 (Junie)" },
		{ id: "claude-opus-4-6", name: "Claude Opus 4.6 (Junie)" },
		{ id: "claude-opus-4-7", name: "Claude Opus 4.7 (Junie)" },
		{ id: "claude-opus-4-8", name: "Claude Opus 4.8 (Junie)" },
		{ id: "claude-opus-5", name: "Claude Opus 5 (Junie)" },
		{ id: "claude-fable-5", name: "Claude Fable 5 (Junie)" },
	].map(({ id, name }) => ({
		id,
		name,
		api: "anthropic-messages",
		provider: "jetbrains-junie",
		baseUrl: JETBRAINS_JUNIE_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		// JetBrains bills these through a JetBrains AI subscription, not per token.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: JETBRAINS_JUNIE_ANTHROPIC_CONTEXT_WINDOW,
		maxTokens: JETBRAINS_JUNIE_MAX_TOKENS,
		// `applyGeneratedModelPolicies` derives the adaptive thinking config from the model id.
		headers: JETBRAINS_JUNIE_ANTHROPIC_HEADERS,
	}));

	const gptCompletionsModels: Model<"openai-completions">[] = [
		{ id: "gpt-5-2025-08-07", name: "GPT-5 (Junie)" },
		{ id: "gpt-5.2-2025-12-11", name: "GPT-5.2 (Junie)" },
		{ id: "gpt-5.4", name: "GPT-5.4 (Junie)" },
		{ id: "gpt-5.5", name: "GPT-5.5 (Junie)" },
		{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna (Junie)" },
		{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol (Junie)" },
		{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra (Junie)" },
	].map(({ id, name }) => ({
		id,
		name,
		api: "openai-completions",
		provider: "jetbrains-junie",
		baseUrl: JETBRAINS_JUNIE_OPENAI_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: JETBRAINS_JUNIE_OPENAI_CONTEXT_WINDOW,
		maxTokens: JETBRAINS_JUNIE_MAX_TOKENS,
		headers: JETBRAINS_JUNIE_OPENAI_HEADERS,
	}));

	// Responses-only: the Chat Completions route rejects this id outright.
	const gptResponsesModels: Model<"openai-responses">[] = [{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex (Junie)" }].map(
		({ id, name }) => ({
			id,
			name,
			api: "openai-responses",
			provider: "jetbrains-junie",
			baseUrl: JETBRAINS_JUNIE_OPENAI_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: JETBRAINS_JUNIE_OPENAI_CONTEXT_WINDOW,
			maxTokens: JETBRAINS_JUNIE_MAX_TOKENS,
			headers: JETBRAINS_JUNIE_OPENAI_HEADERS,
		}),
	);

	const junieModels: Model[] = [...claudeModels, ...gptCompletionsModels, ...gptResponsesModels];

	for (const metadata of junieModels) {
		const existing = models.find(model => model.provider === "jetbrains-junie" && model.id === metadata.id);
		if (existing) {
			Object.assign(existing, metadata);
		} else {
			models.push(metadata);
		}
	}
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

// Catalog sources occasionally omit image input for recent Claude Opus variants
// (e.g. kilo/venice "-fast" entries) even though every Claude Opus model is
// vision-capable. Correct those so capability advertising stays consistent
// across providers. Runs after the dynamic merge so it survives regeneration.
//
// The list is an explicit allowlist of reviewed generations rather than a
// `claude-opus-*` prefix match: a future generation must be reviewed before we
// assert capabilities for it. `claude-opus-vision.test.ts` imports this list and
// fails when the catalog bundles a newer Opus generation than any declared here.
export const VISION_CORRECTED_CLAUDE_OPUS_GENERATIONS: readonly number[] = [4.8, 5];

/**
 * Known separator-less generation aliases. Upstream normally writes
 * `claude-opus-4-5`, but a few catalogs collapse it to `claude-opus-45`. This is
 * an explicit list so a future two-digit major (`claude-opus-10`) is read as
 * generation 10 rather than silently as 1.0.
 */
const COMPACT_CLAUDE_OPUS_ALIASES: Readonly<Record<string, number>> = {
	"41": 4.1,
	"45": 4.5,
	"46": 4.6,
	"47": 4.7,
	"48": 4.8,
};

/**
 * Extract the Claude Opus generation from a model id, ignoring provider
 * prefixes, region prefixes, and trailing aliases or date suffixes:
 * `claude-opus-4-8` and `anthropic.claude-opus-4-8` -> 4.8, `claude-opus-5-fast`
 * -> 5, `claude-opus-45` -> 4.5, `claude-opus-4-20250514` -> 4,
 * `claude-opus-10` -> 10. Returns undefined when the id is not a Claude Opus
 * model.
 */
export function claudeOpusGeneration(modelId: string): number | undefined {
	const match = modelId
		.toLowerCase()
		.replace(/\./g, "-")
		.match(/claude-opus-(\d+)(?:-(\d)(?![\d]))?/);
	if (!match) return undefined;
	const [, major, minor] = match;
	if (minor !== undefined) return Number(major) + Number(minor) / 10;
	return COMPACT_CLAUDE_OPUS_ALIASES[major] ?? Number(major);
}

function applyClaudeOpusVisionCorrections(models: readonly Model[]): Model[] {
	return models.map(model => {
		const generation = claudeOpusGeneration(model.id);
		if (generation === undefined || !VISION_CORRECTED_CLAUDE_OPUS_GENERATIONS.includes(generation)) {
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

async function generateModels() {
	// Fetch models from dynamic sources
	const modelsDevModels = await loadModelsDevData();
	const catalogProviderModels = (
		await Promise.all(
			PROVIDER_DESCRIPTORS.filter(isCatalogDescriptor).map(descriptor => fetchProviderModelsFromCatalog(descriptor)),
		)
	).flat();
	const gitLabDuoModels = getGitLabDuoModels();
	// Combine models (models.dev has priority)
	let allModels = applyGlobalModelsDevFallback(
		[...modelsDevModels, ...catalogProviderModels, ...gitLabDuoModels, ...createAzureOpenAICatalogModels()],
		modelsDevModels,
	);

	if (!allModels.some(model => model.provider === "cloudflare-ai-gateway")) {
		allModels.push(CLOUDFLARE_FALLBACK_MODEL);
	}

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
			allModels.push(...discovery.models);
		}
	}

	// Merge previous models.json entries as fallback for any provider/model
	// not fetched dynamically. This replaces all hardcoded fallback lists —
	// static-only providers (vertex, gemini-cli), auth-gated providers when
	// credentials are unavailable, and ad-hoc model additions all persist
	// through the existing models.json seed.
	// Discovery-only providers (local inference servers) — never bundle static models.
	const discoveryOnlyProviders = new Set(["ollama", "vllm"]);
	const fetchedKeys = new Set(allModels.map(model => `${model.provider}/${model.id}`));

	for (const models of Object.values(prevModelsJson as Record<string, Record<string, Model>>)) {
		for (const model of Object.values(models)) {
			if (
				!fetchedKeys.has(`${model.provider}/${model.id}`) &&
				!discoveryOnlyProviders.has(model.provider) &&
				!isRetiredBundledModel(model)
			) {
				allModels.push(model.provider === "openai" ? { ...model, baseUrl: "" } : model);
			}
		}
	}
	allModels = allModels.filter(model => !isRetiredBundledModel(model));

	allModels = applyGlobalModelsDevFallback(allModels, modelsDevModels);
	allModels = applyPremiumMultiplierOverrides(allModels);
	allModels = applyCodexPricingFallback(allModels);
	allModels = applyClaudeOpusVisionCorrections(allModels);
	injectAlibabaTokenPlanModels(allModels);
	injectJetBrainsJunieModels(allModels);
	applyGeneratedModelPolicies(allModels);
	// This provider-specific correction must run after generic policy inference,
	// which otherwise caps unknown OpenAI-compatible models at `high`.
	injectMuseSparkModels(allModels);
	linkOpenAIPromotionTargets(allModels);
	injectImageGenerationModels(allModels);

	// Group by provider and sort each provider's models
	const providers: Record<string, Record<string, Model>> = {};
	for (const model of allModels) {
		if (discoveryOnlyProviders.has(model.provider)) continue;
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

	// Generate JSON file
	await Bun.write(path.join(packageRoot, "src/models.json"), JSON.stringify(MODELS, null, "	"));
	console.log("Generated src/models.json");

	// Print statistics
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
