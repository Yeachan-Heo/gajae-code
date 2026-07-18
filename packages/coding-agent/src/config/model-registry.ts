import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessageEventStream,
	type AuthCredentialSelector,
	applyFinalCodexGpt56ContextCap,
	type CacheRetention,
	type Context,
	createModelManager,
	enrichModelThinking,
	getBundledModels,
	getBundledProviders,
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	type Model,
	type ModelManagerOptions,
	type ModelRefreshStrategy,
	type ModelRequestTransform,
	openaiCodexModelManagerOptions,
	PROVIDER_DESCRIPTORS,
	readModelCache,
	registerCustomApi,
	type SimpleStreamOptions,
	type ThinkingConfig,
	UNK_CONTEXT_WINDOW,
	UNK_MAX_TOKENS,
	unregisterCustomApis,
} from "@gajae-code/ai";

// Sentinel for local-only OAuth token (LM Studio, vLLM) — declared inline to avoid loading
// any provider module at startup. Must match `DEFAULT_LOCAL_TOKEN` in oauth/lm-studio.ts.
const DEFAULT_LOCAL_TOKEN = "lm-studio-local";

import { registerOAuthProvider, unregisterOAuthProviders } from "@gajae-code/ai/utils/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@gajae-code/ai/utils/oauth/types";
import { $pickenv, isRecord, logger } from "@gajae-code/utils";
import { parseModelString, resolveProviderModelReference } from "../config/model-resolver";
import { isValidThemeColor, type ThemeColor } from "../modes/theme/theme";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";
import type { ActiveSearchModelContext, WebSearchMode } from "../web/search/types";
import { type ConfigError, ConfigFile } from "./config-file";
import { isAuthenticated, kNoAuth } from "./model-auth";
import { ModelBindingsApplier } from "./model-bindings-applier";
import { ModelDiscoveryManager, type ProviderDiscoveryState } from "./model-discovery-manager";

export type { ProviderDiscoveryState, ProviderDiscoveryStatus } from "./model-discovery-manager";

import {
	buildCanonicalModelIndex,
	type CanonicalModelIndex,
	type CanonicalModelRecord,
	type CanonicalModelVariant,
	compareEquivalentModelVariants,
	formatCanonicalVariantSelector,
	type ModelEquivalenceConfig,
} from "./model-equivalence";
import {
	aggregateModelProfileRequiredProviders,
	type ModelProfileDefinition,
	mergeModelProfiles,
} from "./model-profiles";
import {
	GJC_MODEL_ASSIGNMENT_TARGET_IDS,
	type ModelOverride,
	type ModelProfileConfig,
	type ModelsConfig,
	ModelsConfigSchema,
	ProfileDefinitionSchema,
	type ProviderAuthMode,
	type ProviderDiscovery,
} from "./models-config-schema";
import { type Settings, settings } from "./settings";

export type { CanonicalModelIndex, CanonicalModelRecord, CanonicalModelVariant, ModelEquivalenceConfig };

export { isAuthenticated, kNoAuth };

const MAX_SESSION_CANONICAL_VARIANTS = 64;

function envAvailabilityFingerprint(): string {
	return Object.entries(process.env)
		.filter(
			([name]) =>
				/(?:_API_KEY|_OAUTH_TOKEN|_ACCESS_TOKEN)$/.test(name) ||
				/^(?:GH_TOKEN|GITHUB_TOKEN|HF_TOKEN|COPILOT_GITHUB_TOKEN)$/.test(name),
		)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, value]) => `${name}=${value ?? ""}`)
		.join("\u0000");
}

export type ModelRole = "default";

export interface ModelRoleInfo {
	tag?: string;
	name: string;
	color?: ThemeColor;
}

export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
	default: { tag: "DEFAULT", name: "Default", color: "success" },
};

export const MODEL_ROLE_IDS: ModelRole[] = ["default"];
export const MODEL_PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const MODEL_PROFILE_NAME_PATTERN_DESCRIPTION = "lowercase letters, numbers, dots, underscores, or hyphens";
export type GjcModelAssignmentTargetId = (typeof GJC_MODEL_ASSIGNMENT_TARGET_IDS)[number];

export interface GjcModelAssignmentTargetInfo extends ModelRoleInfo {
	id: GjcModelAssignmentTargetId;
	settingsPath: "modelRoles" | "task.agentModelOverrides";
}

export { GJC_MODEL_ASSIGNMENT_TARGET_IDS };

export const GJC_MODEL_ASSIGNMENT_TARGETS: Record<GjcModelAssignmentTargetId, GjcModelAssignmentTargetInfo> = {
	default: { id: "default", tag: "DEFAULT", name: "Default", color: "success", settingsPath: "modelRoles" },
	executor: {
		id: "executor",
		tag: "EXECUTOR",
		name: "Executor",
		color: "accent",
		settingsPath: "task.agentModelOverrides",
	},
	architect: {
		id: "architect",
		tag: "ARCHITECT",
		name: "Architect",
		color: "muted",
		settingsPath: "task.agentModelOverrides",
	},
	planner: {
		id: "planner",
		tag: "PLANNER",
		name: "Planner",
		color: "warning",
		settingsPath: "task.agentModelOverrides",
	},
	critic: { id: "critic", tag: "CRITIC", name: "Critic", color: "error", settingsPath: "task.agentModelOverrides" },
};

/** Alias for ModelRoleInfo - used for both built-in and custom roles */
export type RoleInfo = ModelRoleInfo;

/**
 * Return the canonical set of known roles for selector/carousel UI.
 *
 * Built-ins always come first. Configured cycle order, model assignments, and
 * tag metadata can introduce additional custom roles without requiring duplicate
 * entries across settings.
 */
export function getKnownRoleIds(settings: Settings): string[] {
	const roles = [...MODEL_ROLE_IDS] as string[];
	const seen = new Set<string>(roles);
	const addRole = (role: string) => {
		if (seen.has(role)) return;
		seen.add(role);
		roles.push(role);
	};

	for (const role of settings.get("cycleOrder")) addRole(role);
	for (const role of Object.keys(settings.getModelRoles())) addRole(role);
	for (const role of Object.keys(settings.get("modelTags"))) addRole(role);

	return roles;
}

/**
 * Get role info for a role name (built-in or custom).
 * Configured metadata overrides built-in defaults when present.
 */
export function getRoleInfo(role: string, settings: Settings): RoleInfo {
	const builtIn = role in MODEL_ROLES ? MODEL_ROLES[role as ModelRole] : undefined;
	const configured = settings.get("modelTags")[role];

	if (configured) {
		return {
			tag: builtIn?.tag,
			name: configured.name || builtIn?.name || role,
			color: configured.color && isValidThemeColor(configured.color) ? configured.color : builtIn?.color,
		};
	}

	if (builtIn) return builtIn;

	return { name: role, color: "muted" };
}

type ProviderValidationMode = "models-config" | "runtime-register";

const OPENAI_REQUEST_TRANSFORM_APIS = new Set<Api>(["openai-completions", "openai-responses"]);

function getKnownProviderApis(providerName: string): Set<Api> {
	const apis = new Set<Api>();
	for (const model of getBundledModels(providerName as Parameters<typeof getBundledModels>[0])) {
		apis.add((model as Model<Api>).api);
	}
	return apis;
}

function isRequestTransformApi(api: Api): boolean {
	return OPENAI_REQUEST_TRANSFORM_APIS.has(api);
}

function assertRequestTransformSupportedForKnownProvider(providerName: string, source: string): void {
	const apis = getKnownProviderApis(providerName);
	if (apis.size === 0) {
		throw new Error(
			`Provider ${providerName}: ${source} requires an OpenAI-compatible "api" when the provider is not built in.`,
		);
	}
	for (const api of apis) {
		if (!isRequestTransformApi(api)) {
			throw new Error(
				`Provider ${providerName}: ${source} is only supported with openai-completions or openai-responses APIs.`,
			);
		}
	}
}

function assertRequestTransformSupportedForModelApi(
	providerName: string,
	modelId: string,
	api: Api,
	source: string,
): void {
	if (!isRequestTransformApi(api)) {
		throw new Error(
			`Provider ${providerName}, model ${modelId}: ${source} is only supported with openai-completions or openai-responses APIs.`,
		);
	}
}

function getKnownProviderModelApi(providerName: string, modelId: string): Api | undefined {
	return getBundledModels(providerName as Parameters<typeof getBundledModels>[0]).find(model => model.id === modelId)
		?.api as Api | undefined;
}

interface ProviderValidationModel {
	id: string;
	api?: Api;
	contextWindow?: number;
	maxTokens?: number;
	requestTransform?: ModelRequestTransform;
}

interface ProviderValidationConfig {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	apiKeyEnv?: string;
	api?: Api;
	auth?: ProviderAuthMode;
	oauthConfigured?: boolean;
	discovery?: ProviderDiscovery;
	compat?: Model<Api>["compat"];
	requestTransform?: ModelRequestTransform;
	disableStrictTools?: boolean;
	cacheRetention?: CacheRetention;
	openaiCompat?: { baseUrl: string; apiKey?: string; apiKeyEnv?: string };
	modelOverrides?: Record<string, unknown>;
	models: ProviderValidationModel[];
}

function usesAwsCredentialChain(api: Api | undefined): boolean {
	return api === "bedrock-converse-stream";
}

function validateProviderConfiguration(
	providerName: string,
	config: ProviderValidationConfig,
	mode: ProviderValidationMode,
): void {
	const hasProviderApi = !!config.api;
	const models = config.models;

	if (models.length === 0) {
		if (mode === "models-config") {
			const hasModelOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
			if (
				!config.baseUrl &&
				!config.headers &&
				!config.compat &&
				!config.apiKey &&
				!config.apiKeyEnv &&
				!config.disableStrictTools &&
				!config.requestTransform &&
				!config.cacheRetention &&
				!config.openaiCompat &&
				!hasModelOverrides &&
				!config.discovery
			) {
				throw new Error(
					`Provider ${providerName}: must specify "baseUrl", "headers", "apiKey", "compat", "requestTransform", "cacheRetention", "disableStrictTools", "modelOverrides", "discovery", "openaiCompat", or "models"`,
				);
			}
		}
	} else {
		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
		}
		const usesProviderCredentialChain = usesAwsCredentialChain(config.api);
		const requiresAuth =
			mode === "runtime-register"
				? !usesProviderCredentialChain && !config.apiKey && !config.oauthConfigured
				: !usesProviderCredentialChain &&
					!config.apiKey &&
					!config.apiKeyEnv &&
					(config.auth ?? "apiKey") !== "none";
		if (requiresAuth) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`
					: `Provider ${providerName}: "apiKey" or "apiKeyEnv" is required when defining custom models unless auth is "none".`,
			);
		}
	}

	if (mode === "models-config" && config.discovery && !config.api) {
		throw new Error(`Provider ${providerName}: "api" is required when discovery is enabled at provider level.`);
	}
	for (const [modelId, rawOverride] of Object.entries(config.modelOverrides ?? {})) {
		const override = rawOverride as ModelOverride;
		if (!override.requestTransform) continue;
		const effectiveApi =
			models.find(model => model.id === modelId)?.api ??
			config.api ??
			getKnownProviderModelApi(providerName, modelId);
		if (effectiveApi) {
			assertRequestTransformSupportedForModelApi(
				providerName,
				modelId,
				effectiveApi,
				'modelOverrides "requestTransform"',
			);
		} else {
			assertRequestTransformSupportedForKnownProvider(providerName, 'modelOverrides "requestTransform"');
		}
	}
	if (config.requestTransform) {
		if (config.api && !isRequestTransformApi(config.api)) {
			throw new Error(
				`Provider ${providerName}: "requestTransform" is only supported with openai-completions or openai-responses APIs.`,
			);
		}
		if (!config.api && models.length === 0) {
			assertRequestTransformSupportedForKnownProvider(providerName, '"requestTransform"');
		}
	}

	for (const modelDef of models) {
		if (!hasProviderApi && !modelDef.api) {
			throw new Error(
				mode === "runtime-register"
					? `Provider ${providerName}, model ${modelDef.id}: no "api" specified.`
					: `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
			);
		}
		if (!modelDef.id) {
			throw new Error(`Provider ${providerName}: model missing "id"`);
		}
		const effectiveApi = modelDef.api ?? config.api;
		if (config.requestTransform && effectiveApi) {
			assertRequestTransformSupportedForModelApi(
				providerName,
				modelDef.id,
				effectiveApi,
				'provider "requestTransform"',
			);
		}
		if (modelDef.requestTransform && effectiveApi) {
			assertRequestTransformSupportedForModelApi(
				providerName,
				modelDef.id,
				effectiveApi,
				'model "requestTransform"',
			);
		}
		if (mode === "models-config") {
			if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
			}
			if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}
}

export const ModelsConfigFile = new ConfigFile<ModelsConfig>("models", ModelsConfigSchema).withValidation(
	"models",
	config => {
		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			validateProviderConfiguration(
				providerName,
				{
					baseUrl: providerConfig.baseUrl,
					headers: providerConfig.headers,
					apiKey: providerConfig.apiKey,
					apiKeyEnv: providerConfig.apiKeyEnv,
					api: providerConfig.api as Api | undefined,
					auth: (providerConfig.auth ?? "apiKey") as ProviderAuthMode,
					discovery: providerConfig.discovery as ProviderDiscovery | undefined,
					compat: providerConfig.compat,
					requestTransform: providerConfig.requestTransform,
					disableStrictTools: providerConfig.disableStrictTools,
					cacheRetention: providerConfig.cacheRetention,
					openaiCompat: providerConfig.openaiCompat,
					modelOverrides: providerConfig.modelOverrides,
					models: (providerConfig.models ?? []) as ProviderValidationModel[],
				},
				"models-config",
			);
		}
	},
);

/** Provider override config (baseUrl, headers, apiKey, compat, transport) without custom models */
interface ProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	authHeader?: boolean;
	compat?: Model<Api>["compat"];
	transport?: Model<Api>["transport"];
	requestTransform?: ModelRequestTransform;
	cacheRetention?: CacheRetention;
}

const PROVIDER_BASE_URL_ENV_ALIASES: Record<string, readonly string[]> = {
	anthropic: ["ANTHROPIC_BASE_URL"],
	google: ["GOOGLE_BASE_URL", "GEMINI_BASE_URL"],
	"google-antigravity": ["GOOGLE_ANTIGRAVITY_BASE_URL", "GOOGLE_BASE_URL", "GEMINI_BASE_URL"],
	"google-gemini-cli": ["GOOGLE_GEMINI_CLI_BASE_URL", "GOOGLE_BASE_URL", "GEMINI_BASE_URL"],
	"google-vertex": ["GOOGLE_VERTEX_BASE_URL", "GOOGLE_BASE_URL", "GEMINI_BASE_URL"],
	openai: ["OPENAI_BASE_URL"],
};

function getProviderBaseUrlEnvKeys(provider: string): string[] {
	const normalized = provider
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
	const providerKey = normalized ? `${normalized}_BASE_URL` : undefined;
	const keys = [...(PROVIDER_BASE_URL_ENV_ALIASES[provider] ?? [])];
	if (providerKey && !keys.includes(providerKey)) {
		keys.push(providerKey);
	}
	return keys;
}

function resolveProviderBaseUrlFromEnv(provider: string): string | undefined {
	return $pickenv(...getProviderBaseUrlEnvKeys(provider));
}

function normalizeLocalOpenAICompatBaseUrl(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
		parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		const trimmed = baseUrl.replace(/\/+$/g, "");
		return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
	}
}

/**
 * Merge a freshly discovered model with the matching bundled/configured entry
 * (or a runtime provider override when no bundled entry exists).
 *
 * `baseUrl` resolution priority:
 *   1. User-set `providerOverride.baseUrl` (explicit override in models.json)
 *   2. Discovered baseUrl (xiaomi `tp-` token-plan keys resolve to
 *      `token-plan-sgp.xiaomimimo.com` at discovery time)
 *   3. Existing bundled baseUrl (the host baked into `models.json`)
 *
 * Without (1), the user's override would lose to discovery; without (2)
 * preferred over (3), the bundled `api.xiaomimimo.com` would shadow the
 * tp- token-plan host and produce 401s on the first stream call.
 * See `xiaomi-tp-discovery-merge.test.ts` and the `refresh()` baseUrl-override
 * regression in `model-registry.test.ts`.
 */
export function mergeDiscoveredModel<TApi extends Api>(
	model: Model<TApi>,
	existing: Model<Api> | undefined,
	providerOverride?: Pick<
		ProviderOverride,
		"baseUrl" | "headers" | "transport" | "requestTransform" | "cacheRetention"
	>,
): Model<TApi> {
	if (existing) {
		return {
			...model,
			baseUrl: providerOverride?.baseUrl ?? model.baseUrl ?? existing.baseUrl,
			headers: existing.headers ? { ...existing.headers, ...model.headers } : model.headers,
			requestTransform: mergeRequestTransform(
				mergeRequestTransform(existing.requestTransform, model.requestTransform),
				providerOverride?.requestTransform,
			),
			cacheRetention: model.cacheRetention ?? existing.cacheRetention ?? providerOverride?.cacheRetention,
		};
	}
	if (providerOverride) {
		return {
			...model,
			baseUrl: providerOverride.baseUrl ?? model.baseUrl,
			headers: providerOverride.headers ? { ...model.headers, ...providerOverride.headers } : model.headers,
			...(providerOverride.transport !== undefined ? { transport: providerOverride.transport } : {}),
			requestTransform: mergeRequestTransform(model.requestTransform, providerOverride.requestTransform),
		};
	}
	return model;
}

interface DiscoveryProviderConfig {
	provider: string;
	api: Api;
	baseUrl?: string;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	requestTransform?: ModelRequestTransform;
	cacheRetention?: CacheRetention;
	discovery: ProviderDiscovery;
	optional?: boolean;
}

export interface CanonicalModelQueryOptions {
	availableOnly?: boolean;
	candidates?: readonly Model<Api>[];
	/** Stable session identity used to keep a canonical variant sticky within a session. */
	sessionId?: string;
}

/** Result of loading custom models from models.json */
interface CustomModelsResult {
	models?: CustomModelOverlay[];
	overrides?: Map<string, ProviderOverride>;
	modelOverrides?: Map<string, Map<string, ModelOverride>>;
	keylessProviders?: Set<string>;
	discoverableProviders?: DiscoveryProviderConfig[];
	configuredProviders?: Set<string>;
	equivalence?: ModelEquivalenceConfig;
	modelBindings?: NonNullable<ModelsConfig["modelBindings"]>;
	profiles?: ModelsConfig["profiles"];
	error?: ConfigError;
	found: boolean;
}

type OllamaDiscoveredModelMetadata = {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow?: number;
};

type LlamaCppDiscoveredServerMetadata = {
	contextWindow?: number;
	input?: ("text" | "image")[];
};

/**
 * Resolve an API key config value to an actual key.
 * Checks environment variable first, then treats as literal.
 */
function resolveApiKeyConfig(keyConfig: string): string | undefined {
	const envValue = Bun.env[keyConfig];
	if (envValue) return envValue;
	return keyConfig;
}

function resolveApiKeyEnvConfig(envKey: string | undefined): string | undefined {
	if (!envKey) return undefined;
	return Bun.env[envKey];
}

function toPositiveNumberOrUndefined(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

function extractOllamaContextWindow(payload: Record<string, unknown>): number | undefined {
	const modelInfo = payload.model_info;
	if (isRecord(modelInfo)) {
		for (const [key, value] of Object.entries(modelInfo)) {
			if (key === "context_length" || key.endsWith(".context_length")) {
				const contextWindow = toPositiveNumberOrUndefined(value);
				if (contextWindow !== undefined) {
					return contextWindow;
				}
			}
		}
	}

	const parameters = payload.parameters;
	if (typeof parameters !== "string") {
		return undefined;
	}
	const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:$|\n)/m);
	return match ? toPositiveNumberOrUndefined(match[1]) : undefined;
}

function extractLlamaCppContextWindow(payload: Record<string, unknown>): number | undefined {
	const generationSettings = payload.default_generation_settings;
	if (isRecord(generationSettings)) {
		const contextWindow = toPositiveNumberOrUndefined(generationSettings.n_ctx);
		if (contextWindow !== undefined) {
			return contextWindow;
		}
	}
	return toPositiveNumberOrUndefined(payload.n_ctx);
}

function extractLlamaCppInputCapabilities(payload: Record<string, unknown>): ("text" | "image")[] | undefined {
	const modalities = payload.modalities;
	if (!isRecord(modalities)) {
		return undefined;
	}
	return modalities.vision === true ? ["text", "image"] : ["text"];
}

function extractGoogleOAuthToken(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { token?: unknown };
		if (Object.hasOwn(parsed, "token")) {
			if (typeof parsed.token !== "string") {
				return undefined;
			}
			const token = parsed.token.trim();
			return token.length > 0 ? token : undefined;
		}
	} catch {
		// OAuth values for Google providers are expected to be JSON, but custom setups may already provide raw token.
	}
	return value;
}

function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.getAll()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

function resolveOAuthAccountIdForAccessToken(
	authStorage: AuthStorage,
	provider: string,
	accessToken: string,
): string | undefined {
	const oauthCredentials = getOAuthCredentialsForProvider(authStorage, provider);
	const matchingCredential = oauthCredentials.find(credential => credential.access === accessToken);
	if (matchingCredential) {
		return matchingCredential.accountId;
	}
	if (oauthCredentials.length === 1) {
		return oauthCredentials[0].accountId;
	}
	return undefined;
}

function mergeCompat<TBase extends object, TOverride extends object>(
	baseCompat: TBase | null | undefined,
	overrideCompat: TOverride | null | undefined,
): (TBase & TOverride) | TBase | TOverride | undefined {
	if (!baseCompat) return overrideCompat ?? undefined;
	if (!overrideCompat) return baseCompat;

	const merged: Record<string, unknown> = { ...(baseCompat as Record<string, unknown>) };
	for (const [key, overrideValue] of Object.entries(overrideCompat)) {
		const baseValue = (baseCompat as Record<string, unknown>)[key];
		merged[key] =
			isRecord(baseValue) && isRecord(overrideValue) ? mergeCompat(baseValue, overrideValue) : overrideValue;
	}
	return merged as TBase & TOverride;
}

function mergeRequestTransform(
	base: ModelRequestTransform | undefined,
	override: ModelRequestTransform | undefined,
): ModelRequestTransform | undefined {
	if (!base) return override ? { ...override } : undefined;
	if (!override) return { ...base };
	return {
		...base,
		...override,
		stripHeaders: override.stripHeaders ?? base.stripHeaders,
		setHeaders: override.setHeaders ? { ...(base.setHeaders ?? {}), ...override.setHeaders } : base.setHeaders,
		extraBody:
			base.extraBody || override.extraBody
				? { ...(base.extraBody ?? {}), ...(override.extraBody ?? {}) }
				: undefined,
	};
}

function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.thinking !== undefined) result.thinking = override.thinking as ThinkingConfig;
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.output !== undefined) result.output = override.output as ("text" | "image")[];
	if (override.cacheRetention !== undefined) result.cacheRetention = override.cacheRetention;
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;
	if (override.contextPromotionTarget !== undefined) result.contextPromotionTarget = override.contextPromotionTarget;
	if (override.wireModelId !== undefined) result.wireModelId = override.wireModelId;
	result.requestTransform = mergeRequestTransform(model.requestTransform, override.requestTransform);
	if (override.premiumMultiplier !== undefined) result.premiumMultiplier = override.premiumMultiplier;
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}
	if (override.headers) {
		result.headers = { ...model.headers, ...override.headers };
	}
	result.compat = mergeCompat(model.compat, override.compat);
	return enrichModelThinking(result);
}

interface CustomModelDefinitionLike {
	id: string;
	name?: string;
	api?: Api;
	baseUrl?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
	output?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	contextPromotionTarget?: string;
	premiumMultiplier?: number;
	wireModelId?: string;
	requestTransform?: ModelRequestTransform;
	cacheRetention?: CacheRetention;
}

interface CustomModelBuildOptions {
	useDefaults: boolean;
}

type CustomModelOverlay = {
	id: string;
	provider: string;
	api: Api;
	baseUrl: string;
	name?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
	output?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	contextPromotionTarget?: string;
	premiumMultiplier?: number;
	wireModelId?: string;
	requestTransform?: ModelRequestTransform;
	cacheRetention?: CacheRetention;
	isOAuth?: boolean;
};

function mergeCustomModelHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	return mergeAuthHeader({ ...providerHeaders, ...modelHeaders }, authHeader, apiKeyConfig);
}

function mergeAuthHeader(
	headers: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	const nextHeaders = headers && Object.keys(headers).length > 0 ? { ...headers } : undefined;
	if (!authHeader || !apiKeyConfig) {
		return nextHeaders;
	}
	const resolvedKey = resolveApiKeyConfig(apiKeyConfig);
	return resolvedKey ? { ...nextHeaders, Authorization: `Bearer ${resolvedKey}` } : nextHeaders;
}

/**
 * Decide whether a custom-yaml model should force OAuth-style request shaping.
 * - Explicit `auth: oauth` → force on.
 * - Explicit `auth: apiKey` / `auth: none` → leave unset (auto-detect by key prefix).
 * - No `auth` specified and `api: anthropic-messages` → default on. Custom Anthropic
 *   endpoints are typically Anthropic-code-style proxies (e.g. CLIProxyAPI) that expect
 *   the cloaked request shape regardless of how the proxy itself is authenticated.
 * - Otherwise → unset.
 */
function resolveCustomModelIsOAuth(api: Api, providerAuth: ProviderAuthMode | undefined): boolean | undefined {
	if (providerAuth === "oauth") return true;
	if (providerAuth !== undefined) return undefined;
	if (api === "anthropic-messages") return true;
	return undefined;
}

function buildCustomModelOverlay(
	providerName: string,
	providerBaseUrl: string,
	providerApi: Api | undefined,
	providerHeaders: Record<string, string> | undefined,
	providerApiKey: string | undefined,
	authHeader: boolean | undefined,
	providerCompat: Model<Api>["compat"] | undefined,
	providerRequestTransform: ModelRequestTransform | undefined,
	providerAuth: ProviderAuthMode | undefined,
	providerCacheRetention: CacheRetention | undefined,
	modelDef: CustomModelDefinitionLike,
): CustomModelOverlay | undefined {
	const api = modelDef.api ?? providerApi;
	if (!api) return undefined;
	return {
		id: modelDef.id,
		provider: providerName,
		api,
		baseUrl: modelDef.baseUrl ?? providerBaseUrl,
		name: modelDef.name,
		reasoning: modelDef.reasoning,
		thinking: modelDef.thinking as ThinkingConfig | undefined,
		input: modelDef.input as ("text" | "image")[] | undefined,
		output: modelDef.output as ("text" | "image")[] | undefined,
		cost: modelDef.cost,
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		headers: mergeCustomModelHeaders(providerHeaders, modelDef.headers, authHeader, providerApiKey),
		compat: mergeCompat(providerCompat, modelDef.compat),
		requestTransform: mergeRequestTransform(providerRequestTransform, modelDef.requestTransform),
		wireModelId: modelDef.wireModelId,
		contextPromotionTarget: modelDef.contextPromotionTarget,
		premiumMultiplier: modelDef.premiumMultiplier,
		cacheRetention: modelDef.cacheRetention ?? providerCacheRetention,
		isOAuth: resolveCustomModelIsOAuth(api, providerAuth),
	};
}

// Custom provider entries often front a known upstream model through a local proxy.
// Use bundled metadata for missing pricing/capability fields, but keep the custom transport.
function shouldReplaceCustomReference(existing: Model<Api> | undefined, candidate: Model<Api>): boolean {
	if (!existing) return true;
	if (candidate.contextWindow !== existing.contextWindow) {
		return candidate.contextWindow > existing.contextWindow;
	}
	if (candidate.maxTokens !== existing.maxTokens) {
		return candidate.maxTokens > existing.maxTokens;
	}
	const existingHasCachePricing = existing.cost.cacheRead > 0 || existing.cost.cacheWrite > 0;
	const candidateHasCachePricing = candidate.cost.cacheRead > 0 || candidate.cost.cacheWrite > 0;
	if (candidateHasCachePricing !== existingHasCachePricing) {
		return candidateHasCachePricing;
	}
	return existing.provider !== "openai" && candidate.provider === "openai";
}

function buildCustomReferenceMap(): Map<string, Model<Api>> {
	const references = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const candidate = model as Model<Api>;
			if (shouldReplaceCustomReference(references.get(candidate.id), candidate)) {
				references.set(candidate.id, candidate);
			}
		}
	}
	return references;
}

const customReferenceMap = buildCustomReferenceMap();

function getCustomReferenceCandidateIds(modelId: string): string[] {
	const candidates = new Set<string>();
	const minimaxM = /^minimax-m(\d+(?:\.\d+)*)$/i.exec(modelId.trim());
	const queue = minimaxM ? [`MiniMax-M${minimaxM[1]}`, modelId] : [modelId];
	if (minimaxM) {
		// MiniMax catalogs include lowercase wire ids plus display-cased aliases.
		// Custom providers should keep the lowercase wire id while inheriting the
		// canonical display casing when the alias exists.
	}
	for (let index = 0; index < queue.length; index += 1) {
		const candidate = queue[index]?.trim();
		if (!candidate || candidates.has(candidate)) continue;
		candidates.add(candidate);

		for (const suffix of [":cloud", "-cloud"] as const) {
			if (candidate.toLowerCase().endsWith(suffix)) {
				queue.push(candidate.slice(0, -suffix.length));
			}
		}

		const colonToDash = candidate.replace(/:/g, "-");
		if (colonToDash !== candidate) {
			queue.push(colonToDash);
		}
	}
	return [...candidates];
}

function resolveCustomModelReference(modelId: string): Model<Api> | undefined {
	for (const candidate of getCustomReferenceCandidateIds(modelId)) {
		const reference = customReferenceMap.get(candidate);
		if (reference) return reference;
	}
	return undefined;
}

function applyStandaloneCustomModelPolicies(model: CustomModelOverlay): CustomModelOverlay {
	if (model.contextWindow !== undefined) {
		return model;
	}
	if (model.id === "gpt-5.4" && model.provider !== "github-copilot") {
		return { ...model, contextWindow: 1_000_000 };
	}
	// Custom GPT-5.5 endpoints that are not first-party `openai-responses` are
	// typically Codex passthrough proxies (e.g. CLIProxyAPI fronting
	// chatgpt.com/backend-api/codex), where the request path enforces the 272K
	// prompt budget even though the model advertises a 1M total window.
	// Without this default the bundled reference resolves to 1M, compaction
	// never fires in time, and requests die with context_length_exceeded.
	if (model.id === "gpt-5.5" && model.api !== "openai-responses") {
		return { ...model, contextWindow: 272_000 };
	}
	return model;
}

function finalizeCustomModel(model: CustomModelOverlay, options: CustomModelBuildOptions): Model<Api> {
	const resolvedModel = options.useDefaults ? applyStandaloneCustomModelPolicies(model) : model;
	const reference = options.useDefaults ? resolveCustomModelReference(resolvedModel.id) : undefined;
	const cost =
		resolvedModel.cost ??
		reference?.cost ??
		(options.useDefaults ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
	const input = resolvedModel.input ?? reference?.input ?? (options.useDefaults ? ["text"] : undefined);
	const output = resolvedModel.output ?? reference?.output;
	return enrichModelThinking({
		id: resolvedModel.id,
		name: resolvedModel.name ?? reference?.name ?? (options.useDefaults ? resolvedModel.id : undefined),
		api: resolvedModel.api,
		provider: resolvedModel.provider,
		baseUrl: resolvedModel.baseUrl,
		reasoning: resolvedModel.reasoning ?? reference?.reasoning ?? (options.useDefaults ? false : undefined),
		thinking: resolvedModel.thinking ?? reference?.thinking,
		input: input as ("text" | "image")[],
		output: output as ("text" | "image")[] | undefined,
		cost,
		contextWindow:
			resolvedModel.contextWindow ?? reference?.contextWindow ?? (options.useDefaults ? 128000 : undefined),
		maxTokens: resolvedModel.maxTokens ?? reference?.maxTokens ?? (options.useDefaults ? 16384 : undefined),
		headers: resolvedModel.headers,
		compat: mergeCompat(reference?.compat, resolvedModel.compat),
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		wireModelId: resolvedModel.wireModelId,
		requestTransform: resolvedModel.requestTransform,
		cacheRetention: resolvedModel.cacheRetention ?? reference?.cacheRetention,
		premiumMultiplier: resolvedModel.premiumMultiplier,
		isOAuth: resolvedModel.isOAuth,
	} as Model<Api>);
}

function normalizeSuppressedSelector(selector: string): string {
	const trimmed = selector.trim();
	if (!trimmed) return trimmed;
	const parsed = parseModelString(trimmed);
	if (!parsed) return trimmed;
	return `${parsed.provider}/${parsed.id}`;
}

function getDisabledProviderIdsFromSettings(): Set<string> {
	try {
		return new Set(settings.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

function getConfiguredProviderOrderFromSettings(): string[] {
	try {
		return settings.get("modelProviderOrder");
	} catch {
		return [];
	}
}

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	#models: Model<Api>[] = [];
	#canonicalIndex: CanonicalModelIndex = { records: [], byId: new Map(), bySelector: new Map() };
	#availableModelsCache: Model<Api>[] | undefined;
	#availableModelsDisabledProviders: string | undefined;
	#availableModelsEnvFingerprint: string | undefined;
	#sessionCanonicalVariants = new Map<string, string>();
	#customProviderApiKeys: Map<string, string> = new Map();
	#providerWebSearchModes: Map<string, WebSearchMode> = new Map();
	#keylessProviders: Set<string> = new Set();
	#discoveryManager = new ModelDiscoveryManager<DiscoveryProviderConfig>();
	#customModelOverlays: CustomModelOverlay[] = [];
	#providerOverrides: Map<string, ProviderOverride> = new Map();
	#modelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	#equivalenceConfig: ModelEquivalenceConfig | undefined;
	#modelBindingsApplier = new ModelBindingsApplier();
	#modelProfiles: Map<string, ModelProfileDefinition> = mergeModelProfiles();
	#configError: ConfigError | undefined = undefined;
	#modelsConfigFile: ConfigFile<ModelsConfig>;
	#lastStaticLoadMtime: number | null = null;
	#registeredProviderSources: Set<string> = new Set();
	#cacheDbPath?: string;
	#suppressedSelectors: Map<string, number> = new Map();
	#backgroundRefresh?: Promise<void>;
	// Runtime extension model overlays — persist across refresh() cycles so that
	// models registered by extensions survive the model selector's offline reload.
	#runtimeModelOverlays: CustomModelOverlay[] = [];
	#runtimeProviderApiKeys: Map<string, string> = new Map();
	#runtimeProviderOverrides: Map<string, ProviderOverride> = new Map();
	#runtimeProvidersBySource: Map<string, Set<string>> = new Map();
	#runtimeProviderSourceByName: Map<string, string> = new Map();
	#rebuildPending: boolean = false;
	#rebuildSuspended: number = 0;

	/**
	 * @param authStorage - Auth storage for API key resolution
	 */
	constructor(
		readonly authStorage: AuthStorage,
		modelsPath?: string,
	) {
		this.#modelsConfigFile = ModelsConfigFile.relocate(modelsPath);
		this.#cacheDbPath = modelsPath ? path.join(path.dirname(modelsPath), "models.db") : undefined;
		// Set up fallback resolver for custom provider API keys
		this.authStorage.setFallbackResolver(provider => {
			const keyConfig = this.#customProviderApiKeys.get(provider);
			return keyConfig;
		});
		this.authStorage.onGenerationChanged(() => this.#invalidateAvailableModels());
		// Load models synchronously in constructor
		this.#loadModels();
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	async refresh(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		this.#suspendRebuild();
		try {
			this.#reloadStaticModels();
			this.#suppressedSelectors.clear();
			await this.#refreshRuntimeDiscoveries(strategy);
			this.#modelBindingsApplier.apply();
		} finally {
			this.#resumeRebuild();
		}
	}

	refreshInBackground(strategy: ModelRefreshStrategy = "online-if-uncached"): void {
		if (this.#backgroundRefresh) {
			return;
		}
		const refreshPromise = this.refresh(strategy)
			.catch(error => {
				logger.warn("background model refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				if (this.#backgroundRefresh === refreshPromise) {
					this.#backgroundRefresh = undefined;
				}
			});
		this.#backgroundRefresh = refreshPromise;
	}

	async refreshProvider(providerId: string, strategy: ModelRefreshStrategy = "online"): Promise<void> {
		this.#suspendRebuild();
		try {
			this.#reloadStaticModels();
			for (const selector of this.#suppressedSelectors.keys()) {
				if (selector.startsWith(`${providerId}/`)) {
					this.#suppressedSelectors.delete(selector);
				}
			}
			await this.#refreshRuntimeDiscoveries(strategy, new Set([providerId]));
			this.#modelBindingsApplier.apply();
		} finally {
			this.#resumeRebuild();
		}
	}

	#reloadStaticModels(): void {
		const currentMtime = this.#modelsConfigFile.getMtimeMs();
		if (currentMtime !== null && currentMtime === this.#lastStaticLoadMtime) {
			// models.json unchanged since last load; reload + canonical rebuild would be redundant.
			return;
		}
		this.#modelsConfigFile.invalidate();
		this.#customProviderApiKeys.clear();
		this.#providerWebSearchModes.clear();
		this.#keylessProviders.clear();
		this.#discoveryManager.reset();
		// Drop config-sourced apiKeys from AuthStorage before reload; entries
		// removed from models.yml must actually disappear from the resolver, not
		// linger from the previous parse. The post-load setters below repopulate.
		this.authStorage.clearConfigApiKeys();
		// Restore runtime API keys before #loadModels — survives because
		// #loadModels only calls .set() on #customProviderApiKeys, never reassigns it.
		for (const [k, v] of this.#runtimeProviderApiKeys) {
			this.#customProviderApiKeys.set(k, v);
		}
		this.#providerOverrides.clear();
		this.#modelOverrides.clear();
		this.#equivalenceConfig = undefined;
		this.#modelBindingsApplier.setBindings(undefined);
		this.#configError = undefined;
		this.#loadModels();
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): ConfigError | undefined {
		return this.#configError;
	}

	#loadModels() {
		// Load custom models from models.json first (to know which providers to override)
		const {
			models: customModels = [],
			overrides = new Map(),
			modelOverrides = new Map(),
			keylessProviders = new Set(),
			discoverableProviders = [],
			configuredProviders = new Set(),
			equivalence,
			modelBindings,
			profiles,
			error: configError,
		} = this.#loadCustomModels();
		this.#configError = configError;
		this.#keylessProviders = keylessProviders;
		this.#discoveryManager.setProviders(discoverableProviders);
		this.#customModelOverlays = customModels;
		this.#providerOverrides = overrides;
		this.#modelOverrides = modelOverrides;
		this.#equivalenceConfig = equivalence;
		this.#modelBindingsApplier.setBindings(modelBindings);
		this.#modelProfiles = mergeModelProfiles(profiles);

		this.#addImplicitDiscoverableProviders(configuredProviders);
		const builtInModels = this.#applyHardcodedModelPolicies(this.#loadBuiltInModels(overrides));
		const cachedStandardModels = this.#applyHardcodedModelPolicies(this.#loadCachedStandardProviderModels());
		const cachedDiscoveries = this.#applyHardcodedModelPolicies(this.#loadCachedDiscoverableModels());
		const resolvedDefaults = this.#mergeResolvedModels(
			this.#mergeResolvedModels(builtInModels, cachedStandardModels),
			cachedDiscoveries,
		);
		const withConfigModels = this.#mergeCustomModels(resolvedDefaults, this.#customModelOverlays);
		// Merge runtime extension models so they survive refresh() cycles
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(combined, this.#modelOverrides);
		this.#models = applyFinalCodexGpt56ContextCap(this.#applyRuntimeProviderOverrides(withModelOverrides));
		this.#rebuildCanonicalIndex();
		this.#lastStaticLoadMtime = this.#modelsConfigFile.getMtimeMs();
	}

	/** Load built-in models, applying provider-level overrides only.
	 *  Per-model overrides are applied later by #applyModelOverrides. */
	#loadBuiltInModels(overrides: Map<string, ProviderOverride>): Model<Api>[] {
		return getBundledProviders().flatMap(provider => {
			const models = getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[];
			const providerOverride = this.#resolveProviderOverride(provider, overrides);

			return models.map(m => {
				if (!providerOverride) return m;
				const withTransportOverride = this.#applyProviderTransportOverride(m, providerOverride);
				return {
					...withTransportOverride,
					compat: mergeCompat(m.compat, providerOverride.compat),
					cacheRetention: m.cacheRetention ?? providerOverride.cacheRetention,
				};
			});
		});
	}

	#mergeResolvedModels(baseModels: Model<Api>[], replacementModels: Model<Api>[]): Model<Api>[] {
		const merged = [...baseModels];
		const indexByKey = new Map<string, number>();
		for (let i = 0; i < merged.length; i += 1) {
			const m = merged[i];
			indexByKey.set(`${m.provider}\u0000${m.id}`, i);
		}
		for (const replacementModel of replacementModels) {
			const key = `${replacementModel.provider}\u0000${replacementModel.id}`;
			const existingIndex = indexByKey.get(key);
			if (existingIndex !== undefined) {
				const existing = merged[existingIndex];
				merged[existingIndex] = {
					...replacementModel,
					contextWindow:
						replacementModel.contextWindow === UNK_CONTEXT_WINDOW
							? existing.contextWindow
							: replacementModel.contextWindow,
					maxTokens:
						replacementModel.maxTokens === UNK_MAX_TOKENS ? existing.maxTokens : replacementModel.maxTokens,
				};
			} else {
				merged.push(replacementModel);
				indexByKey.set(key, merged.length - 1);
			}
		}
		return merged;
	}

	/** Merge custom models with built-in, replacing by provider+id match */
	#mergeCustomModels(builtInModels: Model<Api>[], customModels: CustomModelOverlay[]): Model<Api>[] {
		const merged = [...builtInModels];
		const indexByKey = new Map<string, number>();
		for (let i = 0; i < merged.length; i += 1) {
			const m = merged[i];
			indexByKey.set(`${m.provider}\u0000${m.id}`, i);
		}
		for (const customModel of customModels) {
			const key = `${customModel.provider}\u0000${customModel.id}`;
			const existingIndex = indexByKey.get(key);
			if (existingIndex !== undefined) {
				const existingModel = merged[existingIndex];
				const referenceModel = resolveCustomModelReference(customModel.id);
				merged[existingIndex] = enrichModelThinking({
					...existingModel,
					id: customModel.id,
					provider: customModel.provider,
					api: customModel.api,
					baseUrl: customModel.baseUrl,
					name: customModel.name ?? referenceModel?.name ?? existingModel.name,
					reasoning: customModel.reasoning ?? existingModel.reasoning,
					thinking: customModel.thinking ?? existingModel.thinking,
					input: customModel.input ?? existingModel.input,
					output: customModel.output ?? existingModel.output,
					cost: customModel.cost ?? existingModel.cost,
					contextWindow: customModel.contextWindow ?? existingModel.contextWindow,
					maxTokens: customModel.maxTokens ?? existingModel.maxTokens,
					// Same-id custom definitions replace bundled transport behavior. Provider-level
					// headers/compat were already folded into customModel during parsing; do not
					// re-merge bundled transport metadata here.
					headers: customModel.headers,
					compat: customModel.compat,
					contextPromotionTarget: customModel.contextPromotionTarget ?? existingModel.contextPromotionTarget,
					wireModelId: customModel.wireModelId,
					requestTransform: customModel.requestTransform,
					premiumMultiplier: customModel.premiumMultiplier ?? existingModel.premiumMultiplier,
				} as Model<Api>);
			} else {
				merged.push(finalizeCustomModel(customModel, { useDefaults: true }));
				indexByKey.set(key, merged.length - 1);
			}
		}
		return merged;
	}

	#loadCachedStandardProviderModels(): Model<Api>[] {
		const configuredDiscoveryProviders = new Set(this.#discoveryManager.providers.map(provider => provider.provider));
		const cachedModels: Model<Api>[] = [];
		for (const descriptor of PROVIDER_DESCRIPTORS) {
			if (configuredDiscoveryProviders.has(descriptor.providerId)) {
				continue;
			}
			const cache = readModelCache<Api>(descriptor.providerId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			if (!cache) {
				continue;
			}
			const models = cache.models.map(model =>
				model.provider === descriptor.providerId ? model : { ...model, provider: descriptor.providerId },
			);
			const providerOverride = this.#resolveProviderOverride(descriptor.providerId);
			const withTransport = providerOverride
				? models.map(model => this.#applyProviderTransportOverride(model, providerOverride))
				: models;
			const withCompat = providerOverride?.compat
				? withTransport.map(model => ({ ...model, compat: mergeCompat(model.compat, providerOverride.compat) }))
				: withTransport;
			cachedModels.push(...this.#applyProviderModelOverrides(descriptor.providerId, withCompat));
		}
		return cachedModels;
	}

	#loadCachedDiscoverableModels(): Model<Api>[] {
		const cachedModels: Model<Api>[] = [];
		for (const providerConfig of this.#discoveryManager.providers) {
			const models = this.#discoveryManager.loadCached(providerConfig, this.#cacheDbPath);
			const normalized = this.#applyProviderModelOverrides(
				providerConfig.provider,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(providerConfig.compat, [...models]),
				),
			);
			cachedModels.push(...normalized);
		}
		return cachedModels;
	}

	#applyProviderCompat(compat: Model<Api>["compat"] | undefined, models: Model<Api>[]): Model<Api>[] {
		if (!compat) return models;
		return models.map(model => ({ ...model, compat: mergeCompat(model.compat, compat) }));
	}

	#normalizeDiscoverableModels(providerConfig: DiscoveryProviderConfig, models: Model<Api>[]): Model<Api>[] {
		return models.map(model => {
			const normalized =
				providerConfig.provider === "ollama" &&
				providerConfig.api === "openai-responses" &&
				model.api === "openai-completions"
					? ({ ...model, api: "openai-responses" } as Model<Api>)
					: model;
			return {
				...normalized,
				requestTransform: providerConfig.requestTransform
					? mergeRequestTransform(undefined, providerConfig.requestTransform)
					: undefined,
				cacheRetention: normalized.cacheRetention ?? providerConfig.cacheRetention,
			};
		});
	}

	#addImplicitDiscoverableProviders(configuredProviders: Set<string>): void {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		if (!configuredProviders.has("ollama") && !disabledProviders.has("ollama")) {
			this.#discoveryManager.addProvider({
				provider: "ollama",
				api: "openai-responses",
				baseUrl: Bun.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
				discovery: { type: "ollama" },
				optional: true,
			});
			this.#keylessProviders.add("ollama");
		}
		if (!configuredProviders.has("llama.cpp") && !disabledProviders.has("llama.cpp")) {
			this.#discoveryManager.addProvider({
				provider: "llama.cpp",
				api: "openai-responses",
				baseUrl: Bun.env.LLAMA_CPP_BASE_URL || "http://127.0.0.1:8080",
				discovery: { type: "llama.cpp" },
				optional: true,
			});
			// Only mark as keyless if no API key is configured
			if (!this.authStorage.hasAuth("llama.cpp")) {
				this.#keylessProviders.add("llama.cpp");
			}
		}
		if (!configuredProviders.has("lm-studio") && !disabledProviders.has("lm-studio")) {
			this.#discoveryManager.addProvider({
				provider: "lm-studio",
				api: "openai-completions",
				baseUrl: Bun.env.LM_STUDIO_BASE_URL || "http://127.0.0.1:1234/v1",
				discovery: { type: "lm-studio" },
				optional: true,
			});
			this.#keylessProviders.add("lm-studio");
		}
	}

	#loadCustomModels(): CustomModelsResult {
		const { value, error, status } = this.#modelsConfigFile.tryLoad();

		if (status === "error") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				error,
				profiles: undefined,
				found: true,
			};
		} else if (status === "not-found") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				profiles: undefined,
				found: false,
			};
		}

		const overrides = new Map<string, ProviderOverride>();
		const allModelOverrides = new Map<string, Map<string, ModelOverride>>();
		const keylessProviders = new Set<string>();
		const discoverableProviders: DiscoveryProviderConfig[] = [];
		const providerEntries = Object.entries(value.providers ?? {});
		const configuredProviders = new Set(Object.keys(value.providers ?? {}));

		for (const [providerName, providerConfig] of providerEntries) {
			if (providerConfig.webSearch) this.#providerWebSearchModes.set(providerName, providerConfig.webSearch);
			const providerApiKeyConfig = providerConfig.apiKey ?? resolveApiKeyEnvConfig(providerConfig.apiKeyEnv);
			const localOpenAICompat = providerConfig.openaiCompat;
			const localOpenAICompatApiKeyConfig = localOpenAICompat
				? (localOpenAICompat.apiKey ?? resolveApiKeyEnvConfig(localOpenAICompat.apiKeyEnv))
				: undefined;
			if (localOpenAICompat) {
				const localOpenAICompatBaseUrl = normalizeLocalOpenAICompatBaseUrl(localOpenAICompat.baseUrl);
				const localCompatResolvedKey = localOpenAICompat.apiKeyEnv
					? resolveApiKeyEnvConfig(localOpenAICompat.apiKeyEnv)
					: localOpenAICompat.apiKey
						? resolveApiKeyConfig(localOpenAICompat.apiKey)
						: undefined;
				overrides.set(providerName, {
					baseUrl: localOpenAICompatBaseUrl,
					apiKey: localOpenAICompatApiKeyConfig,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				});
				discoverableProviders.push({
					provider: providerName,
					api: "openai-completions",
					baseUrl: localOpenAICompatBaseUrl,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
					discovery: { type: "openai-models-list" },
					optional: false,
				});
				if (localCompatResolvedKey) {
					this.#customProviderApiKeys.set(providerName, localCompatResolvedKey);
					this.authStorage.setConfigApiKey(providerName, localCompatResolvedKey);
				} else {
					keylessProviders.add(providerName);
				}
			}
			// Always set overrides when baseUrl/headers/apiKey/authHeader/compat/disableStrictTools/transport are present
			if (
				providerConfig.baseUrl ||
				providerConfig.headers ||
				providerConfig.apiKey ||
				providerConfig.apiKeyEnv ||
				providerConfig.authHeader !== undefined ||
				providerConfig.compat ||
				providerConfig.disableStrictTools ||
				providerConfig.requestTransform ||
				providerConfig.transport ||
				providerConfig.cacheRetention
			) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				overrides.set(providerName, {
					baseUrl: providerConfig.baseUrl,
					headers: providerConfig.headers,
					apiKey: providerApiKeyConfig,
					authHeader: providerConfig.authHeader,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					transport: providerConfig.transport,
					requestTransform: providerConfig.requestTransform,
					cacheRetention: providerConfig.cacheRetention,
				});
			}

			const authMode = (providerConfig.auth ?? "apiKey") as ProviderAuthMode;
			if (authMode === "none") {
				keylessProviders.add(providerName);
			}

			if (providerConfig.discovery && providerConfig.api) {
				discoverableProviders.push({
					provider: providerName,
					api: providerConfig.api as Api,
					baseUrl: providerConfig.baseUrl ?? resolveProviderBaseUrlFromEnv(providerName),
					headers: providerConfig.headers,
					compat: providerConfig.compat,
					requestTransform: providerConfig.requestTransform,
					cacheRetention: providerConfig.cacheRetention,
					discovery: providerConfig.discovery,
					optional: false,
				});
			}

			// Store API key for fallback resolver AND register as config override
			// so it wins over OAuth tokens from the broker — when the user pins a
			// bearer in models.yml (e.g. for an auth-gateway baseUrl), that bearer
			// must authenticate the outbound request.
			if (providerConfig.apiKey || providerConfig.apiKeyEnv) {
				const resolved = providerConfig.apiKeyEnv
					? resolveApiKeyEnvConfig(providerConfig.apiKeyEnv)
					: providerConfig.apiKey
						? resolveApiKeyConfig(providerConfig.apiKey)
						: undefined;
				if (resolved) this.#customProviderApiKeys.set(providerName, resolved);
				if (resolved) this.authStorage.setConfigApiKey(providerName, resolved);
			}

			// Parse per-model overrides
			if (providerConfig.modelOverrides) {
				const perModel = new Map<string, ModelOverride>();
				for (const [modelId, override] of Object.entries(providerConfig.modelOverrides)) {
					perModel.set(modelId, override);
				}
				allModelOverrides.set(providerName, perModel);
			}
		}

		return {
			models: this.#parseModels(value),
			overrides,
			modelOverrides: allModelOverrides,
			keylessProviders,
			discoverableProviders,
			configuredProviders,
			equivalence: value.equivalence,
			modelBindings: value.modelBindings,
			profiles: value.profiles,
			found: true,
		};
	}

	getModelProfiles(): Map<string, ModelProfileDefinition> {
		return new Map(this.#modelProfiles);
	}

	getModelProfile(name: string): ModelProfileDefinition | undefined {
		return this.#modelProfiles.get(name);
	}

	getAvailableModelProfileNames(): string[] {
		return [...this.#modelProfiles.keys()].sort((a, b) => a.localeCompare(b));
	}

	async saveCustomModelProfile(name: string, definition: ModelProfileConfig): Promise<ModelProfileDefinition> {
		const normalizedName = name.trim();
		if (!normalizedName) throw new Error("Profile name is required.");
		const checkedDefinition = ProfileDefinitionSchema.safeParse(definition);
		if (!checkedDefinition.success) {
			const first = checkedDefinition.error.issues[0];
			const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
			throw new Error(`Custom model profile is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
		}
		const loaded = this.#modelsConfigFile.tryLoad();
		if (loaded.status === "error") {
			throw new Error(
				`Cannot create custom model profile because ${this.#modelsConfigFile.path()} is invalid. Fix the existing config before saving a new preset.`,
			);
		}
		const current = loaded.value ?? this.#modelsConfigFile.createDefault();
		if (mergeModelProfiles(current.profiles).has(normalizedName)) {
			throw new Error(`Custom model profile already exists: ${normalizedName}. Choose a unique preset id.`);
		}
		const next: ModelsConfig = {
			...current,
			profiles: {
				...(current.profiles ?? {}),
				[normalizedName]: definition,
			},
		};
		const checkedConfig = ModelsConfigSchema.safeParse(next);
		if (!checkedConfig.success) {
			const first = checkedConfig.error.issues[0];
			const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
			throw new Error(`Generated models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
		}
		await this.#writeCheckedModelsConfig(checkedConfig.data);
		const modelMapping = { ...definition.model_mapping };
		const profile: ModelProfileDefinition = {
			name: normalizedName,
			displayName: definition.display_name,
			requiredProviders: aggregateModelProfileRequiredProviders(definition.required_providers, { modelMapping }),
			modelMapping,
			source: "user",
		};
		return profile;
	}

	async renameCustomModelProfile(name: string, displayName: string): Promise<ModelProfileDefinition> {
		const normalizedName = name.trim();
		const nextDisplayName = displayName.trim();
		if (!normalizedName) throw new Error("Profile name is required.");
		if (!nextDisplayName) throw new Error("Profile display name is required.");
		const { current, profile } = this.#loadCustomProfileForMutation(normalizedName, "rename");
		const nextProfiles = {
			...(current.profiles ?? {}),
			[normalizedName]: {
				...profile,
				display_name: nextDisplayName,
			},
		};
		const checkedConfig = ModelsConfigSchema.safeParse({ ...current, profiles: nextProfiles });
		if (!checkedConfig.success) {
			const first = checkedConfig.error.issues[0];
			const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
			throw new Error(`Generated models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
		}
		await this.#writeCheckedModelsConfig(checkedConfig.data);
		const modelMapping = { ...profile.model_mapping };
		return {
			name: normalizedName,
			displayName: nextDisplayName,
			requiredProviders: aggregateModelProfileRequiredProviders(profile.required_providers, { modelMapping }),
			modelMapping,
			source: "user",
		};
	}

	async deleteCustomModelProfile(name: string): Promise<ModelProfileConfig> {
		const normalizedName = name.trim();
		if (!normalizedName) throw new Error("Profile name is required.");
		const { current, profile } = this.#loadCustomProfileForMutation(normalizedName, "delete");
		const nextProfiles = { ...(current.profiles ?? {}) };
		delete nextProfiles[normalizedName];
		const checkedConfig = ModelsConfigSchema.safeParse({
			...current,
			profiles: Object.keys(nextProfiles).length > 0 ? nextProfiles : undefined,
		});
		if (!checkedConfig.success) {
			const first = checkedConfig.error.issues[0];
			const where = first?.path.length ? `/${first.path.map(String).join("/")}` : "root";
			throw new Error(`Generated models config is invalid at ${where}: ${first?.message ?? "unknown schema error"}`);
		}
		await this.#writeCheckedModelsConfig(checkedConfig.data);
		return profile;
	}

	#loadCustomProfileForMutation(
		normalizedName: string,
		action: "rename" | "delete",
	): { current: ModelsConfig; profile: ModelProfileConfig } {
		const loaded = this.#modelsConfigFile.tryLoad();
		if (loaded.status === "error") {
			throw new Error(
				`Cannot ${action} custom model profile because ${this.#modelsConfigFile.path()} is invalid. Fix the existing config before modifying presets.`,
			);
		}
		const current = loaded.value ?? this.#modelsConfigFile.createDefault();
		const profile = current.profiles?.[normalizedName];
		if (!profile) {
			const existing = this.#modelProfiles.get(normalizedName);
			if (existing && existing.source !== "user") {
				throw new Error(`Cannot ${action} bundled model profile: ${normalizedName}.`);
			}
			throw new Error(`Custom model profile does not exist: ${normalizedName}.`);
		}
		return { current, profile };
	}

	async #writeCheckedModelsConfig(config: ModelsConfig): Promise<void> {
		await fs.mkdir(path.dirname(this.#modelsConfigFile.path()), { recursive: true });
		await Bun.write(this.#modelsConfigFile.path(), Bun.YAML.stringify(config, null, 2));
		this.#modelsConfigFile.invalidate();
		this.#reloadStaticModels();
	}
	applyConfiguredModelBindings(targetSettings: Settings): void {
		this.#modelBindingsApplier.applyTo(targetSettings);
	}

	async #refreshRuntimeDiscoveries(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<void> {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const selectedDiscoverableProviders = (
			providerFilter
				? this.#discoveryManager.providers.filter(provider => providerFilter.has(provider.provider))
				: this.#discoveryManager.providers
		).filter(provider => !disabledProviders.has(provider.provider));
		const configuredDiscoveriesPromise =
			selectedDiscoverableProviders.length === 0
				? Promise.resolve<Model<Api>[]>([])
				: Promise.all(
						selectedDiscoverableProviders.map(provider => this.#discoverProviderModels(provider, strategy)),
					).then(results => results.flat());
		const [configuredDiscovered, builtInDiscovered] = await Promise.all([
			configuredDiscoveriesPromise,
			this.#discoverBuiltInProviderModels(strategy, providerFilter),
		]);
		const discovered = [...configuredDiscovered, ...builtInDiscovered];
		if (discovered.length === 0) {
			return;
		}
		const discoveredModels = this.#applyHardcodedModelPolicies(
			discovered.map(model =>
				mergeDiscoveredModel(
					model,
					this.find(model.provider, model.id),
					this.#resolveProviderOverride(model.provider),
				),
			),
		);
		const resolved = this.#mergeResolvedModels(this.#models, discoveredModels);
		const withConfigModels = this.#mergeCustomModels(resolved, this.#customModelOverlays);
		// Merge runtime extension models so they survive online discovery completion
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(combined, this.#modelOverrides);
		this.#models = applyFinalCodexGpt56ContextCap(this.#applyRuntimeProviderOverrides(withModelOverrides));
		this.#rebuildCanonicalIndex();
	}

	async #discoverProviderModels(
		providerConfig: DiscoveryProviderConfig,
		strategy: ModelRefreshStrategy,
	): Promise<Model<Api>[]> {
		const mergeInput = await this.#discoveryManager.discover(providerConfig, strategy, {
			cacheDbPath: this.#cacheDbPath,
			requiresAuth: provider => !this.#keylessProviders.has(provider.provider),
			peekApiKey: provider => this.#peekApiKeyForProvider(provider.provider),
			isAuthenticated,
			fetchModels: provider => this.#discoverModelsByProviderType(provider),
		});
		if (!mergeInput.current) return [];
		if (mergeInput.warning) {
			logger.warn("model discovery failed for provider", {
				provider: providerConfig.provider,
				url: providerConfig.baseUrl,
				error: mergeInput.warning,
			});
		}
		return this.#applyProviderModelOverrides(
			providerConfig.provider,
			this.#normalizeDiscoverableModels(
				providerConfig,
				this.#applyProviderCompat(providerConfig.compat, [...mergeInput.models]),
			),
		);
	}

	#discoverModelsByProviderType(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		switch (providerConfig.discovery.type) {
			case "ollama":
				return this.#discoverOllamaModels(providerConfig);
			case "llama.cpp":
				return this.#discoverLlamaCppModels(providerConfig);
			case "lm-studio":
			case "openai-models-list":
				return this.#discoverOpenAIModelsList(providerConfig);
		}
	}

	async #discoverBuiltInProviderModels(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<Model<Api>[]> {
		// Skip providers already handled by configured discovery (e.g. user-configured ollama with discovery.type)
		const configuredDiscoveryProviders = new Set(this.#discoveryManager.providers.map(p => p.provider));
		const managerOptions = (await this.#collectBuiltInModelManagerOptions()).filter(opts => {
			if (configuredDiscoveryProviders.has(opts.providerId)) {
				return false;
			}
			return providerFilter ? providerFilter.has(opts.providerId) : true;
		});
		if (managerOptions.length === 0) {
			return [];
		}
		const discoveries = await Promise.all(
			managerOptions.map(options => this.#discoverWithModelManager(options, strategy)),
		);
		return discoveries.flat();
	}

	async #collectBuiltInModelManagerOptions(): Promise<ModelManagerOptions<Api>[]> {
		const specialProviderDescriptors: Array<{
			providerId: string;
			resolveKey: (value: string | undefined) => string | undefined;
			createOptions: (key: string) => ModelManagerOptions<Api>;
		}> = [
			{
				providerId: "google-antigravity",
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleAntigravityModelManagerOptions({
						oauthToken,
						endpoint: this.getProviderBaseUrl("google-antigravity"),
					}),
			},
			{
				providerId: "google-gemini-cli",
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleGeminiCliModelManagerOptions({
						oauthToken,
						endpoint: this.getProviderBaseUrl("google-gemini-cli"),
					}),
			},
			{
				providerId: "openai-codex",
				resolveKey: value => value,
				createOptions: accessToken => {
					const accountId = resolveOAuthAccountIdForAccessToken(this.authStorage, "openai-codex", accessToken);
					return openaiCodexModelManagerOptions({
						accessToken,
						accountId,
					});
				},
			},
		];
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const standardProviderDescriptors = PROVIDER_DESCRIPTORS.filter(
			descriptor => !disabledProviders.has(descriptor.providerId),
		);
		const enabledSpecialProviderDescriptors = specialProviderDescriptors.filter(
			descriptor => !disabledProviders.has(descriptor.providerId),
		);
		// Use peekApiKey to avoid OAuth token refresh during discovery.
		// The token is only needed if the dynamic fetch fires (cache miss),
		// and failures there are handled gracefully.
		const peekKey = (descriptor: { providerId: string }) => this.#peekApiKeyForProvider(descriptor.providerId);
		const [standardProviderKeys, specialKeys] = await Promise.all([
			Promise.all(standardProviderDescriptors.map(peekKey)),
			Promise.all(enabledSpecialProviderDescriptors.map(peekKey)),
		]);
		const options: ModelManagerOptions<Api>[] = [];
		for (let i = 0; i < standardProviderDescriptors.length; i++) {
			const descriptor = standardProviderDescriptors[i];
			const apiKey = standardProviderKeys[i];
			if (isAuthenticated(apiKey) || descriptor.allowUnauthenticated) {
				options.push(
					descriptor.createModelManagerOptions({
						apiKey: isAuthenticated(apiKey) ? apiKey : undefined,
						baseUrl: this.#getProviderBaseUrlForDiscovery(descriptor.providerId),
					}),
				);
			}
		}

		for (let i = 0; i < enabledSpecialProviderDescriptors.length; i++) {
			const descriptor = enabledSpecialProviderDescriptors[i];
			const key = descriptor.resolveKey(specialKeys[i]);
			if (!isAuthenticated(key)) {
				continue;
			}
			options.push(descriptor.createOptions(key));
		}
		return options;
	}

	async #discoverWithModelManager(
		options: ModelManagerOptions<Api>,
		strategy: ModelRefreshStrategy,
	): Promise<Model<Api>[]> {
		try {
			const manager = createModelManager({ ...options, cacheDbPath: this.#cacheDbPath });
			const result = await manager.refresh(strategy);
			return result.models.map(model =>
				model.provider === options.providerId ? model : { ...model, provider: options.providerId },
			);
		} catch (error) {
			logger.warn("model discovery failed for provider", {
				provider: options.providerId,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}

	async #discoverOllamaModelMetadata(
		endpoint: string,
		modelId: string,
		headers: Record<string, string> | undefined,
	): Promise<OllamaDiscoveredModelMetadata | null> {
		const showUrl = `${endpoint}/api/show`;
		try {
			const response = await fetch(showUrl, {
				method: "POST",
				headers: { ...(headers ?? {}), "Content-Type": "application/json" },
				body: JSON.stringify({ model: modelId }),
				signal: AbortSignal.timeout(150),
			});
			if (!response.ok) {
				return null;
			}
			const payload = (await response.json()) as unknown;
			if (!isRecord(payload)) {
				return null;
			}
			const contextWindow = extractOllamaContextWindow(payload);
			const capabilities = payload.capabilities;
			if (Array.isArray(capabilities)) {
				const normalized = new Set(
					capabilities.flatMap(capability => (typeof capability === "string" ? [capability.toLowerCase()] : [])),
				);
				const supportsVision = normalized.has("vision") || normalized.has("image");
				return {
					reasoning: normalized.has("thinking"),
					input: supportsVision ? ["text", "image"] : ["text"],
					contextWindow,
				};
			}
			if (!isRecord(capabilities)) {
				return {
					reasoning: false,
					input: ["text"],
					contextWindow,
				};
			}
			const supportsVision = capabilities.vision === true || capabilities.image === true;
			return {
				reasoning: capabilities.thinking === true,
				input: supportsVision ? ["text", "image"] : ["text"],
				contextWindow,
			};
		} catch {
			return null;
		}
	}

	async #discoverOllamaModels(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		const endpoint = this.#normalizeOllamaBaseUrl(providerConfig.baseUrl);
		const tagsUrl = `${endpoint}/api/tags`;
		const headers = { ...(providerConfig.headers ?? {}) };
		const response = await fetch(tagsUrl, {
			headers,
			signal: AbortSignal.timeout(250),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${tagsUrl}`);
		}
		const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
		const entries = (payload.models ?? []).flatMap(item => {
			const id = item.model || item.name;
			return id ? [{ id, name: item.name || id }] : [];
		});
		const metadataById = new Map(
			await Promise.all(
				entries.map(
					async entry => [entry.id, await this.#discoverOllamaModelMetadata(endpoint, entry.id, headers)] as const,
				),
			),
		);
		const discovered = entries.map(entry => {
			const metadata = metadataById.get(entry.id);
			return enrichModelThinking({
				id: entry.id,
				name: entry.name,
				api: providerConfig.api,
				provider: providerConfig.provider,
				baseUrl: `${endpoint}/v1`,
				reasoning: metadata?.reasoning ?? false,
				input: metadata?.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata?.contextWindow ?? 128000,
				maxTokens: Math.min(metadata?.contextWindow ?? Number.POSITIVE_INFINITY, 8192),
				headers: providerConfig.headers,
			});
		});
		return this.#applyProviderModelOverrides(providerConfig.provider, discovered);
	}

	async #discoverLlamaCppServerMetadata(
		baseUrl: string,
		headers: Record<string, string> | undefined,
	): Promise<LlamaCppDiscoveredServerMetadata | null> {
		const propsUrl = `${this.#toLlamaCppNativeBaseUrl(baseUrl)}/props`;
		try {
			const response = await fetch(propsUrl, {
				headers,
				signal: AbortSignal.timeout(150),
			});
			if (!response.ok) {
				return null;
			}
			const payload = (await response.json()) as unknown;
			if (!isRecord(payload)) {
				return null;
			}
			return {
				contextWindow: extractLlamaCppContextWindow(payload),
				input: extractLlamaCppInputCapabilities(payload),
			};
		} catch {
			return null;
		}
	}

	async #discoverLlamaCppModels(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		const baseUrl = this.#normalizeLlamaCppBaseUrl(providerConfig.baseUrl);
		const modelsUrl = `${baseUrl}/models`;

		const headers: Record<string, string> = { ...(providerConfig.headers ?? {}) };
		const apiKey = await this.authStorage.getApiKey(providerConfig.provider);
		if (apiKey && apiKey !== DEFAULT_LOCAL_TOKEN && apiKey !== kNoAuth) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const [response, serverMetadata] = await Promise.all([
			fetch(modelsUrl, {
				headers,
				signal: AbortSignal.timeout(250),
			}),
			this.#discoverLlamaCppServerMetadata(baseUrl, headers),
		]);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${modelsUrl}`);
		}
		const payload = (await response.json()) as { data?: Array<{ id: string }> };
		const models = payload.data ?? [];
		const discovered: Model<Api>[] = [];
		for (const item of models) {
			const id = item.id;
			if (!id) continue;
			discovered.push(
				enrichModelThinking({
					id,
					name: id,
					api: providerConfig.api,
					provider: providerConfig.provider,
					baseUrl,
					reasoning: false,
					input: serverMetadata?.input ?? ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: serverMetadata?.contextWindow ?? 128000,
					maxTokens: Math.min(serverMetadata?.contextWindow ?? Number.POSITIVE_INFINITY, 8192),
					headers,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				}),
			);
		}
		return this.#applyProviderModelOverrides(providerConfig.provider, discovered);
	}

	async #discoverOpenAIModelsList(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		const baseUrl = this.#normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
		const modelsUrl = `${baseUrl}/models`;

		const headers: Record<string, string> = { ...(providerConfig.headers ?? {}) };
		const apiKey = await this.authStorage.getApiKey(providerConfig.provider);
		if (apiKey && apiKey !== DEFAULT_LOCAL_TOKEN && apiKey !== kNoAuth) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		const response = await fetch(modelsUrl, {
			headers,
			signal: AbortSignal.timeout(250),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${modelsUrl}`);
		}
		const payload = (await response.json()) as { data?: Array<{ id: string }> };
		const models = payload.data ?? [];
		const discovered: Model<Api>[] = [];
		for (const item of models) {
			const id = item.id;
			if (!id) continue;
			discovered.push(
				enrichModelThinking({
					id,
					name: id,
					api: providerConfig.api,
					provider: providerConfig.provider,
					baseUrl,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					headers,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				}),
			);
		}
		return this.#applyProviderModelOverrides(providerConfig.provider, discovered);
	}

	#normalizeLlamaCppBaseUrl(baseUrl?: string): string {
		const defaultBaseUrl = "http://127.0.0.1:8080";
		const raw = baseUrl || defaultBaseUrl;
		try {
			const parsed = new URL(raw);
			const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
			return `${parsed.protocol}//${parsed.host}${trimmedPath}`;
		} catch {
			return raw;
		}
	}

	#toLlamaCppNativeBaseUrl(baseUrl: string): string {
		try {
			const parsed = new URL(baseUrl);
			const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
			parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath.slice(0, -3) || "/" : trimmedPath || "/";
			const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
			return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
		} catch {
			return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
		}
	}

	#normalizeOpenAIModelsListBaseUrl(baseUrl?: string): string {
		const defaultBaseUrl = "http://127.0.0.1:1234/v1";
		const raw = baseUrl || defaultBaseUrl;
		try {
			const parsed = new URL(raw);
			const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
			parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
			return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
		} catch {
			return raw;
		}
	}
	#normalizeOllamaBaseUrl(baseUrl?: string): string {
		const raw = baseUrl || "http://127.0.0.1:11434";
		try {
			const parsed = new URL(raw);
			return `${parsed.protocol}//${parsed.host}`;
		} catch {
			return "http://127.0.0.1:11434";
		}
	}

	#applyProviderModelOverrides(provider: string, models: Model<Api>[]): Model<Api>[] {
		const overrides = this.#modelOverrides.get(provider);
		if (!overrides || overrides.size === 0) return models;
		return models.map(model => {
			const override = overrides.get(model.id);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}

	#resolveProviderOverride(
		provider: string,
		overrides: Map<string, ProviderOverride> = this.#providerOverrides,
	): ProviderOverride | undefined {
		const explicitOverride = overrides.get(provider);
		if (explicitOverride?.baseUrl) {
			return explicitOverride;
		}
		const envBaseUrl = resolveProviderBaseUrlFromEnv(provider);
		if (!envBaseUrl) {
			return explicitOverride;
		}
		return {
			...explicitOverride,
			baseUrl: envBaseUrl,
		};
	}

	#getProviderBaseUrlForDiscovery(provider: string): string | undefined {
		return (
			this.#providerOverrides.get(provider)?.baseUrl ??
			resolveProviderBaseUrlFromEnv(provider) ??
			this.getProviderBaseUrl(provider)
		);
	}

	#mergeProviderOverride(baseOverride: ProviderOverride | undefined, override: ProviderOverride): ProviderOverride {
		return {
			baseUrl: override.baseUrl ?? baseOverride?.baseUrl,
			apiKey: override.apiKey ?? baseOverride?.apiKey,
			authHeader: override.authHeader ?? baseOverride?.authHeader,
			headers: override.headers ? { ...(baseOverride?.headers ?? {}), ...override.headers } : baseOverride?.headers,
			compat: override.compat ? mergeCompat(baseOverride?.compat, override.compat) : baseOverride?.compat,
			transport: override.transport ?? baseOverride?.transport,
			requestTransform: mergeRequestTransform(baseOverride?.requestTransform, override.requestTransform),
			cacheRetention: override.cacheRetention ?? baseOverride?.cacheRetention,
		};
	}
	#applyProviderTransportOverride<
		T extends { baseUrl?: string; headers?: Record<string, string>; cacheRetention?: CacheRetention },
	>(
		entry: T,
		override: Pick<
			ProviderOverride,
			"baseUrl" | "headers" | "authHeader" | "apiKey" | "transport" | "requestTransform" | "cacheRetention"
		>,
	): T {
		const headers = mergeAuthHeader(
			override.headers ? { ...entry.headers, ...override.headers } : entry.headers,
			override.authHeader,
			override.apiKey,
		);
		return {
			...entry,
			baseUrl: override.baseUrl ?? entry.baseUrl,
			headers,
			// Preserve the model's existing transport when the override omits one;
			// providers without a `transport` field keep the default per-API dispatch.
			...(override.transport !== undefined ? { transport: override.transport } : {}),
			requestTransform: mergeRequestTransform(
				(entry as { requestTransform?: ModelRequestTransform }).requestTransform,
				override.requestTransform,
			),
			cacheRetention: entry.cacheRetention ?? override.cacheRetention,
		};
	}
	#applyRuntimeProviderOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeProviderOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#runtimeProviderOverrides.get(model.provider);
			if (!override) return model;
			return this.#applyProviderTransportOverride(model, override);
		});
	}
	#applyModelOverrides(models: Model<Api>[], overrides: Map<string, Map<string, ModelOverride>>): Model<Api>[] {
		if (overrides.size === 0) return models;
		return models.map(model => {
			const providerOverrides = overrides.get(model.provider);
			if (!providerOverrides) return model;
			const override = providerOverrides.get(model.id);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}
	#applyHardcodedModelPolicies(models: Model<Api>[]): Model<Api>[] {
		return models.map(model => {
			if (model.id !== "gpt-5.4" || model.provider === "github-copilot") {
				return model;
			}
			const overrides = this.#modelOverrides.get(model.provider)?.get(model.id);
			if (!overrides) {
				return applyModelOverride(model, { contextWindow: 1_000_000 });
			}
			return applyModelOverride(model, {
				contextWindow: overrides.contextWindow ?? 1_000_000,
				...overrides,
			});
		});
	}

	#rebuildCanonicalIndex(): void {
		if (this.#rebuildSuspended > 0) {
			this.#rebuildPending = true;
			return;
		}
		this.#canonicalIndex = buildCanonicalModelIndex(this.#models, this.#equivalenceConfig);
		this.#invalidateAvailableModels();
		this.#rebuildPending = false;
	}

	#invalidateAvailableModels(): void {
		this.#availableModelsCache = undefined;
		this.#availableModelsDisabledProviders = undefined;
		this.#availableModelsEnvFingerprint = undefined;
	}

	#suspendRebuild(): void {
		this.#rebuildSuspended += 1;
	}

	#resumeRebuild(): void {
		if (this.#rebuildSuspended > 0) {
			this.#rebuildSuspended -= 1;
		}
		if (this.#rebuildSuspended === 0 && this.#rebuildPending) {
			this.#rebuildPending = false;
			this.#canonicalIndex = buildCanonicalModelIndex(this.#models, this.#equivalenceConfig);
			this.#invalidateAvailableModels();
		}
	}

	#parseModels(config: ModelsConfig): CustomModelOverlay[] {
		const models: CustomModelOverlay[] = [];

		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models
			if (providerConfig.apiKey || providerConfig.apiKeyEnv) {
				const resolved = providerConfig.apiKeyEnv
					? resolveApiKeyEnvConfig(providerConfig.apiKeyEnv)
					: providerConfig.apiKey
						? resolveApiKeyConfig(providerConfig.apiKey)
						: undefined;
				if (resolved) this.#customProviderApiKeys.set(providerName, resolved);
				if (resolved) this.authStorage.setConfigApiKey(providerName, resolved);
			}
			for (const modelDef of modelDefs) {
				const providerCompat = providerConfig.disableStrictTools
					? mergeCompat(providerConfig.compat, { disableStrictTools: true })
					: providerConfig.compat;
				const model = buildCustomModelOverlay(
					providerName,
					providerConfig.baseUrl!,
					providerConfig.api as Api | undefined,
					providerConfig.headers,
					providerConfig.apiKeyEnv ? resolveApiKeyEnvConfig(providerConfig.apiKeyEnv) : providerConfig.apiKey,
					providerConfig.authHeader,
					providerCompat,
					providerConfig.requestTransform,
					(providerConfig.auth as ProviderAuthMode | undefined) ?? undefined,
					providerConfig.cacheRetention,
					modelDef as CustomModelDefinitionLike,
				);
				if (!model) continue;
				models.push(model);
			}
		}
		return models;
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		return this.#models;
	}

	#isModelAvailable(model: Model<Api>, disabledProviders = getDisabledProviderIdsFromSettings()): boolean {
		return (
			!disabledProviders.has(model.provider) &&
			(this.#keylessProviders.has(model.provider) || this.authStorage.hasAuth(model.provider))
		);
	}

	#filterCanonicalVariants(
		record: CanonicalModelRecord,
		options: CanonicalModelQueryOptions | undefined,
	): CanonicalModelVariant[] {
		const candidateKeys = options?.candidates
			? new Set(options.candidates.map(candidate => formatCanonicalVariantSelector(candidate)))
			: undefined;
		const disabledProviders = options?.availableOnly ? getDisabledProviderIdsFromSettings() : undefined;
		return record.variants.filter(variant => {
			if (candidateKeys && !candidateKeys.has(variant.selector)) return false;
			if (options?.availableOnly && !this.#isModelAvailable(variant.model, disabledProviders)) return false;
			return true;
		});
	}

	#providerRank(models: readonly Model<Api>[]): Map<string, number> {
		const configuredProviders = getConfiguredProviderOrderFromSettings();
		const result = new Map<string, number>();
		let nextRank = 0;
		for (const provider of configuredProviders) {
			const normalized = provider.trim().toLowerCase();
			if (!normalized || result.has(normalized)) {
				continue;
			}
			result.set(normalized, nextRank);
			nextRank += 1;
		}
		for (const model of models) {
			const normalized = model.provider.toLowerCase();
			if (result.has(normalized)) {
				continue;
			}
			result.set(normalized, nextRank);
			nextRank += 1;
		}
		return result;
	}

	#rememberCanonicalVariant(sessionId: string, selector: string): void {
		this.#sessionCanonicalVariants.delete(sessionId);
		this.#sessionCanonicalVariants.set(sessionId, selector);
		if (this.#sessionCanonicalVariants.size > MAX_SESSION_CANONICAL_VARIANTS) {
			this.#sessionCanonicalVariants.delete(this.#sessionCanonicalVariants.keys().next().value!);
		}
	}
	#resolveCanonicalVariant(
		variants: readonly CanonicalModelVariant[],
		allCandidates: readonly Model<Api>[],
		sessionId?: string,
	): CanonicalModelVariant | undefined {
		if (variants.length === 0) return undefined;
		const stickySelector = sessionId ? this.#sessionCanonicalVariants.get(sessionId) : undefined;
		const stickyVariant = stickySelector ? variants.find(variant => variant.selector === stickySelector) : undefined;
		if (stickyVariant) {
			this.#rememberCanonicalVariant(sessionId!, stickyVariant.selector);
			return stickyVariant;
		}
		if (sessionId && stickySelector) this.#sessionCanonicalVariants.delete(sessionId);
		const providerRank = this.#providerRank(allCandidates);
		const modelOrder = new Map<string, number>();
		for (let index = 0; index < allCandidates.length; index += 1) {
			modelOrder.set(formatCanonicalVariantSelector(allCandidates[index]!), index);
		}
		const sourceRank: Record<CanonicalModelVariant["source"], number> = {
			override: 1,
			bundled: 1,
			heuristic: 2,
			fallback: 3,
		};
		return [...variants].sort((left, right) =>
			compareEquivalentModelVariants(left.model, right.model, {
				providerRank,
				canonicalId: left.canonicalId === right.canonicalId ? left.canonicalId : undefined,
				leftSourceRank: sourceRank[left.source],
				rightSourceRank: sourceRank[right.source],
				includeCost: true,
				modelOrder,
			}),
		)[0];
	}

	getCanonicalModels(options?: CanonicalModelQueryOptions): CanonicalModelRecord[] {
		const records: CanonicalModelRecord[] = [];
		for (const record of this.#canonicalIndex.records) {
			const variants = this.#filterCanonicalVariants(record, options);
			if (variants.length === 0) {
				continue;
			}
			records.push({
				id: record.id,
				name: record.name,
				variants,
			});
		}
		return records;
	}

	getCanonicalVariants(canonicalId: string, options?: CanonicalModelQueryOptions): CanonicalModelVariant[] {
		const record = this.#canonicalIndex.byId.get(canonicalId.trim().toLowerCase());
		if (!record) {
			return [];
		}
		return this.#filterCanonicalVariants(record, options);
	}

	resolveCanonicalModel(canonicalId: string, options?: CanonicalModelQueryOptions): Model<Api> | undefined {
		const variants = this.getCanonicalVariants(canonicalId, options);
		if (variants.length === 0) return undefined;
		const candidates = options?.candidates ?? (options?.availableOnly ? this.getAvailable() : this.getAll());
		const resolved = this.#resolveCanonicalVariant(variants, candidates, options?.sessionId);
		if (resolved && options?.sessionId) this.#rememberCanonicalVariant(options.sessionId, resolved.selector);
		return resolved?.model;
	}

	getCanonicalId(model: Model<Api>): string | undefined {
		return this.#canonicalIndex.bySelector.get(formatCanonicalVariantSelector(model).toLowerCase());
	}

	/**
	 * Seed a child canonical scope from a concrete parent model without touching
	 * the parent's canonical selection.
	 */
	seedCanonicalVariant(sessionId: string, model: Model<Api>): boolean {
		const scope = sessionId.trim();
		if (!scope) return false;
		const selector = formatCanonicalVariantSelector(model);
		if (!this.#canonicalIndex.bySelector.has(selector.toLowerCase())) return false;
		this.#rememberCanonicalVariant(scope, selector);
		return true;
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const disabledProviderKey = [...disabledProviders].sort().join("\u0000");
		const envFingerprint = envAvailabilityFingerprint();
		if (
			this.#availableModelsCache &&
			this.#availableModelsDisabledProviders === disabledProviderKey &&
			this.#availableModelsEnvFingerprint === envFingerprint
		) {
			return this.#availableModelsCache;
		}
		this.#availableModelsCache = this.#models.filter(model => this.#isModelAvailable(model, disabledProviders));
		this.#availableModelsDisabledProviders = disabledProviderKey;
		this.#availableModelsEnvFingerprint = envFingerprint;
		return this.#availableModelsCache;
	}

	/**
	 * Check whether auth is configured for a model's provider.
	 *
	 * Mirrors the upstream `@mariozechner/gajae-code` API surface so that
	 * external plugins/extensions and downstream wrappers (e.g. subagent launch
	 * paths that pre-flight auth before model resolution) can probe a model
	 * without resolving an API key. Returns true for keyless providers as well
	 * as providers with stored credentials. See issue #993.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.#keylessProviders.has(model.provider) || this.authStorage.hasAuth(model.provider);
	}

	getDiscoverableProviders(): string[] {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		return this.#discoveryManager.providers
			.filter(provider => !disabledProviders.has(provider.provider))
			.map(provider => provider.provider);
	}

	getProviderDiscoveryState(provider: string): ProviderDiscoveryState | undefined {
		return this.#discoveryManager.getState(provider);
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return resolveProviderModelReference(provider, modelId, this.#models);
	}

	/**
	 * Get the base URL associated with a provider, if any model defines one.
	 */
	getProviderBaseUrl(provider: string): string | undefined {
		return (
			this.#models.find(m => m.provider === provider && m.baseUrl)?.baseUrl ??
			resolveProviderBaseUrlFromEnv(provider)
		);
	}

	getProviderWebSearchMode(provider: string): WebSearchMode | undefined {
		return this.#providerWebSearchModes.get(provider);
	}

	getActiveSearchModelContext(model: Model<Api>): ActiveSearchModelContext {
		return {
			provider: model.provider,
			modelId: model.id,
			wireModelId: model.wireModelId,
			api: model.api,
			baseUrl: model.baseUrl,
			headers: model.headers,
			webSearch: this.getProviderWebSearchMode(model.provider),
		};
	}

	async #getApiKeyOrNoAuth(provider: string, lookup: () => Promise<string | undefined>): Promise<string | undefined> {
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return lookup();
	}

	/**
	 * Get API key for a model.
	 */
	async getApiKey(
		model: Model<Api>,
		sessionId?: string,
		options: { credentialSelector?: AuthCredentialSelector } = {},
	): Promise<string | undefined> {
		return this.#getApiKeyOrNoAuth(model.provider, () =>
			this.authStorage.getApiKey(model.provider, sessionId, {
				baseUrl: model.baseUrl,
				modelId: model.id,
				credentialSelector: options.credentialSelector,
			}),
		);
	}

	/**
	 * Get API key for a provider (e.g., "openai").
	 */
	async getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		baseUrl?: string,
		options: { credentialSelector?: AuthCredentialSelector } = {},
	): Promise<string | undefined> {
		return this.#getApiKeyOrNoAuth(provider, () =>
			this.authStorage.getApiKey(provider, sessionId, {
				baseUrl,
				credentialSelector: options.credentialSelector,
			}),
		);
	}

	async #peekApiKeyForProvider(provider: string): Promise<string | undefined> {
		return this.#getApiKeyOrNoAuth(provider, () => this.authStorage.peekApiKey(provider));
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		return this.authStorage.hasOAuth(model.provider);
	}

	getSessionCredentialType(provider: string, sessionId?: string): "api_key" | "oauth" | undefined {
		return this.authStorage.getSessionCredentialType(provider, sessionId);
	}

	#clearRuntimeProviderState(providerName: string): void {
		this.#runtimeProviderApiKeys.delete(providerName);
		this.#runtimeProviderOverrides.delete(providerName);
		this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(overlay => overlay.provider !== providerName);
		this.authStorage.removeConfigApiKey(providerName);
	}

	/**
	 * Remove custom API/OAuth registrations for a specific extension source.
	 */
	clearSourceRegistrations(sourceId: string): void {
		unregisterCustomApis(sourceId);
		unregisterOAuthProviders(sourceId);
		const sourceProviders = this.#runtimeProvidersBySource.get(sourceId);
		if (!sourceProviders || sourceProviders.size === 0) {
			return;
		}
		this.#runtimeProvidersBySource.delete(sourceId);
		for (const providerName of sourceProviders) {
			if (this.#runtimeProviderSourceByName.get(providerName) !== sourceId) {
				continue;
			}
			this.#runtimeProviderSourceByName.delete(providerName);
			this.#clearRuntimeProviderState(providerName);
		}
		this.#lastStaticLoadMtime = null;
		this.#reloadStaticModels();
		this.#rebuildCanonicalIndex();
	}

	/**
	 * Remove registrations for extension sources that are no longer active.
	 */
	syncExtensionSources(activeSourceIds: string[]): void {
		const activeSources = new Set(activeSourceIds);
		for (const sourceId of this.#registeredProviderSources) {
			if (activeSources.has(sourceId)) {
				continue;
			}
			this.clearSourceRegistrations(sourceId);
			this.#registeredProviderSources.delete(sourceId);
		}
	}

	/**
	 * Register a provider dynamically (from extensions).
	 *
	 * If provider has models: replaces all existing models for this provider.
	 * If provider has only baseUrl/headers: overrides existing models' URLs.
	 * If provider has streamSimple: registers a custom API streaming function.
	 * If provider has oauth: registers OAuth provider for /login support.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput, sourceId?: string): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		validateProviderConfiguration(
			providerName,
			{
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				api: config.api,
				oauthConfigured: Boolean(config.oauth),
				requestTransform: config.requestTransform,
				models: (config.models ?? []) as ProviderValidationModel[],
			},
			"runtime-register",
		);

		if (config.streamSimple && config.api) {
			const streamSimple = config.streamSimple;
			registerCustomApi(config.api, streamSimple, sourceId, (model, context, options) =>
				streamSimple(model, context, options as SimpleStreamOptions),
			);
		}

		if (config.oauth) {
			registerOAuthProvider({
				...config.oauth,
				id: providerName,
				sourceId,
			});
		}

		let sourceHandoff = false;
		if (sourceId) {
			this.#registeredProviderSources.add(sourceId);
			const previousSourceId = this.#runtimeProviderSourceByName.get(providerName);
			if (previousSourceId && previousSourceId !== sourceId) {
				const previousProviders = this.#runtimeProvidersBySource.get(previousSourceId);
				previousProviders?.delete(providerName);
				if (previousProviders && previousProviders.size === 0) {
					this.#runtimeProvidersBySource.delete(previousSourceId);
				}
				this.#clearRuntimeProviderState(providerName);
				sourceHandoff = true;
			}
			const sourceProviders = this.#runtimeProvidersBySource.get(sourceId) ?? new Set<string>();
			sourceProviders.add(providerName);
			this.#runtimeProvidersBySource.set(sourceId, sourceProviders);
			this.#runtimeProviderSourceByName.set(providerName, sourceId);
		}
		if (sourceHandoff) {
			this.#lastStaticLoadMtime = null;
			this.#reloadStaticModels();
		}

		if (config.apiKey) {
			this.#customProviderApiKeys.set(providerName, config.apiKey);
			// Persist runtime API keys so they survive #reloadStaticModels() cycles
			this.#runtimeProviderApiKeys.set(providerName, config.apiKey);
			const resolved = resolveApiKeyConfig(config.apiKey);
			if (resolved) this.authStorage.setConfigApiKey(providerName, resolved);
		}

		if (config.models && config.models.length > 0) {
			// Build model overlays that persist across refresh() cycles
			const newOverlays: CustomModelOverlay[] = [];
			for (const modelDef of config.models) {
				const overlay = buildCustomModelOverlay(
					providerName,
					config.baseUrl!,
					config.api,
					config.headers,
					config.apiKey,
					config.authHeader,
					config.compat,
					config.requestTransform,
					undefined,
					undefined,
					modelDef as CustomModelDefinitionLike,
				);
				if (!overlay) {
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
				}
				newOverlays.push(overlay);
			}
			// Store as runtime overlays so they survive #reloadStaticModels()
			this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(m => m.provider !== providerName);
			this.#runtimeModelOverlays.push(...newOverlays);

			// Also update #models immediately for the current cycle
			const nextModels = this.#models.filter(m => m.provider !== providerName);
			for (const overlay of newOverlays) {
				nextModels.push(finalizeCustomModel(overlay, { useDefaults: true }));
			}
			const runtimeTransportOverride = this.#runtimeProviderOverrides.get(providerName);
			const withRuntimeTransportOverride = runtimeTransportOverride
				? nextModels.map(model => {
						if (model.provider !== providerName) return model;
						return this.#applyProviderTransportOverride(model, runtimeTransportOverride);
					})
				: nextModels;

			if (config.oauth?.modifyModels) {
				const credential = this.authStorage.getOAuthCredential(providerName);
				if (credential) {
					this.#models = applyFinalCodexGpt56ContextCap(
						config.oauth.modifyModels(withRuntimeTransportOverride, credential),
					);
					this.#rebuildCanonicalIndex();
					return;
				}
			}

			this.#models = applyFinalCodexGpt56ContextCap(withRuntimeTransportOverride);
			this.#rebuildCanonicalIndex();
			return;
		}

		if (
			config.baseUrl ||
			config.headers ||
			config.apiKey ||
			config.authHeader !== undefined ||
			config.requestTransform !== undefined ||
			config.transport !== undefined
		) {
			const transportOverride = {
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				authHeader: config.authHeader,
				requestTransform: config.requestTransform,
				transport: config.transport,
			};
			const nextRuntimeOverride = this.#mergeProviderOverride(
				this.#runtimeProviderOverrides.get(providerName),
				transportOverride,
			);
			this.#runtimeProviderOverrides.set(providerName, nextRuntimeOverride);
			this.#models = this.#models.map(m => {
				if (m.provider !== providerName) return m;
				return this.#applyProviderTransportOverride(m, transportOverride);
			});
			this.#rebuildCanonicalIndex();
		}
	}

	/**
	 * Suppress a specific model selector (e.g., "provider/id") until a specific timestamp.
	 */
	suppressSelector(selector: string, untilMs: number): void {
		this.#suppressedSelectors.set(normalizeSuppressedSelector(selector), untilMs);
	}

	/**
	 * Check if a model selector is currently suppressed due to rate limits.
	 */
	isSelectorSuppressed(selector: string): boolean {
		const normalizedSelector = normalizeSuppressedSelector(selector);
		const suppressedUntil = this.#suppressedSelectors.get(normalizedSelector);
		if (!suppressedUntil) return false;
		if (suppressedUntil <= Date.now()) {
			this.#suppressedSelectors.delete(normalizedSelector);
			return false;
		}
		return true;
	}

	/** Return whether a selector has an active, expired, or no rate-limit suppression. */
	getSelectorSuppressionStatus(selector: string): "active" | "expired" | "none" {
		const normalizedSelector = normalizeSuppressedSelector(selector);
		const suppressedUntil = this.#suppressedSelectors.get(normalizedSelector);
		if (!suppressedUntil) return "none";
		if (suppressedUntil <= Date.now()) {
			this.#suppressedSelectors.delete(normalizedSelector);
			return "expired";
		}
		return "active";
	}
}

/**
 * Input type for registerProvider API (from extensions).
 */
export interface ProviderConfigInput {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	requestTransform?: ModelRequestTransform;
	authHeader?: boolean;
	/** Streaming transport override — see {@link Model.transport}. */
	transport?: Model<Api>["transport"];
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey?(credentials: OAuthCredentials): string;
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinking?: ThinkingConfig;
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
		requestTransform?: ModelRequestTransform;
		wireModelId?: string;
		contextPromotionTarget?: string;
		premiumMultiplier?: number;
	}>;
}
