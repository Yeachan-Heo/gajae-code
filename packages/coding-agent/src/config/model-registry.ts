import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type Api,
	type AssistantMessageEventStream,
	type AuthCredentialSelector,
	applyFinalCodexGpt56ContextCap,
	applyGeneratedModelPolicies,
	type CacheRetention,
	CODEX_GPT_5_6_CONTEXT_CAP,
	type Context,
	codexContextOverrideKey,
	createModelManager,
	Effort,
	enrichModelThinking,
	getBundledModels,
	getBundledProviders,
	getEnvApiKey,
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	isCodexGpt56Tier,
	isKnownProvider,
	type Model,
	type ModelManagerOptions,
	type ModelMaxTokensSource,
	type ModelRefreshStrategy,
	type ModelRequestTransform,
	modelSupportsReasoningControl,
	openaiCodexModelManagerOptions,
	PROVIDER_DESCRIPTORS,
	readModelCache,
	registerCustomApi,
	resolveOAuthStorageProvider,
	type SimpleStreamOptions,
	type ThinkingConfig,
	UNK_CONTEXT_WINDOW,
	UNK_MAX_TOKENS,
	unregisterCustomApis,
} from "@gajae-code/ai/core";
import { fetchModelsDevPayload } from "@gajae-code/ai/provider-models/openai-compat";
import {
	detectDiscoveredApiFamily,
	resolveLoopbackOpenAIBaseUrl,
} from "@gajae-code/ai/utils/discovery/openai-compatible";

// Sentinels for local-only OAuth tokens — declared inline to avoid loading provider
// modules at startup. Must match the provider OAuth modules.
const DEFAULT_LOCAL_TOKEN = "lm-studio-local";
const VLLM_DEFAULT_LOCAL_TOKEN = "vllm-local";

function isVllmNoAuthToken(provider: string, apiKey: string | undefined): boolean {
	return provider === "vllm" && apiKey === VLLM_DEFAULT_LOCAL_TOKEN;
}

function normalizeVllmApiKey(provider: string, apiKey: string | undefined): string | undefined {
	return isVllmNoAuthToken(provider, apiKey) ? getEnvApiKey(provider) : apiKey;
}

import { registerOAuthProvider, unregisterOAuthProviders } from "@gajae-code/ai/utils/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@gajae-code/ai/utils/oauth/types";
import { $pickCredentialEnv, $rotatingCredentialEnv, getAgentDir, isRecord, logger } from "@gajae-code/utils";
import { parseModelString, resolveProviderModelReference, splitSelectorThinkingSuffix } from "../config/model-resolver";
import { isValidThemeColor, type ThemeColor } from "../modes/theme/theme";
import {
	type ActiveProviderDescriptor,
	ActiveProviderResolutionError,
	projectActiveProviderDescriptors,
} from "../sdk/providers";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";
import type { ActiveSearchModelContext, WebSearchMode } from "../web/search/types";
import { type BillingPath, deriveBillingPath } from "./billing-path";
import { ConfigError, ConfigFile } from "./config-file";
import { isAuthenticated, kNoAuth } from "./model-auth";
import { type ConfiguredModelBindings, ModelBindingsApplier } from "./model-bindings-applier";
import { ModelDiscoveryManager, type ProviderDiscoveryState } from "./model-discovery-manager";
import {
	loadAcceptedModelPresetProfiles,
	type ModelPresetRegistryDependencies,
	refreshModelPresetRegistryInBackground,
} from "./model-preset-registry";

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
import { normalizeModelSelectorValue } from "./model-selector-value";
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
import {
	buildProviderSelectionCatalog,
	createProviderSelectionPolicy,
	type EffectiveProviderAuth,
	type ProviderSelectionPolicy,
	projectCatalogProviderOrder,
} from "./provider-selection-policy";
import { type Settings, settings } from "./settings";

export type { BillingPath, BillingPathKind } from "./billing-path";
export type { EffectiveProviderAuth, ProviderSelectionPolicy } from "./provider-selection-policy";
export type { CanonicalModelIndex, CanonicalModelRecord, CanonicalModelVariant, ModelEquivalenceConfig };

export { isAuthenticated, kNoAuth };

const MAX_SESSION_CANONICAL_VARIANTS = 64;
const GENERATED_AUTH_HEADER = Symbol("generated-auth-header");
function firstPositiveDiscoveryNumber(...values: readonly unknown[]): number | undefined {
	for (const value of values) {
		const number =
			typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
		if (Number.isSafeInteger(number) && number > 0) return number;
	}
	return undefined;
}
function redactDiscoveryUrl(value: string | URL): string {
	try {
		const url = typeof value === "string" ? new URL(value) : value;
		return `${url.origin}${url.pathname}`;
	} catch {
		return "(invalid URL)";
	}
}

/** Whether a structured transport code proves that no listener accepted the connection. */
function isConnectionRefusedDiscoveryCode(value: unknown): boolean {
	if (typeof value === "string") {
		const normalized = value.replace(/[^A-Za-z0-9]/gu, "").toUpperCase();
		return (
			normalized === "ECONNREFUSED" || normalized === "CONNECTIONREFUSED" || normalized === "ERRCONNECTIONREFUSED"
		);
	}
	if (typeof value !== "number" || !Number.isInteger(value)) return false;
	// ECONNREFUSED errno values used by the supported runtimes/OSes.
	return value === 61 || value === -61 || value === 111 || value === -111 || value === 10061 || value === -10061;
}

function isConnectionRefusedDiscoveryEvidence(error: unknown): boolean {
	const seen = new Set<unknown>();
	const queue: unknown[] = [error];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === null || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		for (const field of ["code", "errno", "errorCode", "transportCode"]) {
			let value: unknown;
			try {
				value = Reflect.get(current, field);
			} catch {
				value = undefined;
			}
			if (isConnectionRefusedDiscoveryCode(value)) return true;
		}
		for (const field of ["cause", "error", "transport"]) {
			let nested: unknown;
			try {
				nested = Reflect.get(current, field);
			} catch {
				nested = undefined;
			}
			if (nested !== undefined) queue.push(nested);
		}
	}
	return false;
}

/** Whether `hostname` (as `URL.hostname` reports it) names this machine's loopback. */
function isLoopbackDiscoveryHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
	return /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

/**
 * A loopback discovery endpoint that is proven to have no listener is the normal state of
 * a machine without a local model server. Structured transport evidence is required when
 * available; DNS, routing, proxy, TLS, and HTTP failures remain warnings.
 */
export function isQuietLocalDiscoveryFailure(baseUrl: string, _warning: string, evidence?: unknown): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		return false;
	}
	return isLoopbackDiscoveryHost(host) && evidence !== undefined && isConnectionRefusedDiscoveryEvidence(evidence);
}
function stripUrlQuery(value: string): string {
	const queryStart = value.indexOf("?");
	if (queryStart < 0) return value;
	const fragmentStart = value.indexOf("#", queryStart);
	return value.slice(0, queryStart) + (fragmentStart < 0 ? "" : value.slice(fragmentStart));
}

function envAvailabilityFingerprint(configuredNames?: ReadonlySet<string>): string {
	const names = new Set(
		Object.keys(process.env).filter(
			name =>
				/(?:_API_KEY|_OAUTH_TOKEN|_ACCESS_TOKEN)$/.test(name) ||
				/^(?:GH_TOKEN|GITHUB_TOKEN|HF_TOKEN|COPILOT_GITHUB_TOKEN)$/.test(name),
		),
	);
	for (const name of configuredNames ?? []) names.add(name);
	return [...names]
		.sort((left, right) => left.localeCompare(right))
		.map(name => `${name}=${process.env[name] ?? ""}`)
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
	image: { id: "image", tag: "IMAGE", name: "Image", color: "accent", settingsPath: "modelRoles" },
};

export function requiresExplicitThinkingChoice(model: Model, role: GjcModelAssignmentTargetId | null): boolean {
	if (!modelSupportsReasoningControl(model)) return false;
	if (
		model.provider === "openai" ||
		model.provider === "openai-codex" ||
		(model.provider === "xai" && (model.id === "grok-4.5" || model.id === "grok-4.6"))
	)
		return true;
	if (role === null) return false;
	if (role === "default") return true;
	return GJC_MODEL_ASSIGNMENT_TARGETS[role].settingsPath === "task.agentModelOverrides";
}

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

const OPENAI_FAMILY_APIS = new Set<Api>([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

/** Whether an api uses an OpenAI-shaped request/response transport. */
function isOpenAIFamilyApi(api: Api): boolean {
	return OPENAI_FAMILY_APIS.has(api);
}

/**
 * The most frequent OpenAI-family api among statically-configured models, used
 * as the default api for auto-enabled `/v1/models` discovery on a custom
 * provider that sets `api` only per model. Returns `undefined` when no
 * configured model uses an OpenAI-family api (e.g. an Anthropic-only base),
 * which suppresses auto-discovery for that provider.
 */
function dominantOpenAIFamilyModelApi(models: readonly { api?: string }[] | undefined): Api | undefined {
	if (!models || models.length === 0) return undefined;
	const counts = new Map<Api, number>();
	for (const model of models) {
		const api = model.api as Api | undefined;
		if (api === undefined || !isOpenAIFamilyApi(api)) continue;
		counts.set(api, (counts.get(api) ?? 0) + 1);
	}
	let best: Api | undefined;
	let bestCount = 0;
	for (const [api, count] of counts) {
		if (count > bestCount) {
			best = api;
			bestCount = count;
		}
	}
	return best;
}

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

function isCanonicalOpenAIAffinityBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const url = new URL(baseUrl);
		return (
			url.origin === "https://api.openai.com" &&
			url.username === "" &&
			url.password === "" &&
			(url.pathname === "/" || url.pathname === "/v1") &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

function assertResponsesSessionAffinitySupported(
	providerName: string,
	api: Api | undefined,
	baseUrl: string | undefined,
	source: string,
): void {
	if (isKnownProvider(providerName) && providerName !== "openai") {
		throw new Error(
			`Provider ${providerName}: ${source} is only supported for the openai provider or unknown user-defined provider IDs.`,
		);
	}
	if (api !== "openai-responses") {
		throw new Error(`Provider ${providerName}: ${source} is only supported with the openai-responses API.`);
	}
	if (!isKnownProvider(providerName) && (!baseUrl?.trim() || isCanonicalOpenAIAffinityBaseUrl(baseUrl))) {
		throw new Error(
			`Provider ${providerName}: ${source} requires a genuinely custom base URL for unknown provider IDs.`,
		);
	}
}

interface ProviderValidationModel {
	id: string;
	baseUrl?: string;
	api?: Api;
	contextWindow?: number;
	maxTokens?: number;
	compat?: Model<Api>["compat"];
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
					: `Provider ${providerName}: custom models need a credential source, but none is configured. ` +
							`"auth" only selects the scheme ("auth: apiKey" does not supply a key). ` +
							`Fix by adding "apiKeyEnv: <ENV_VAR>" (recommended) or "apiKey: <literal-key>", ` +
							`or set "auth: none" if the endpoint is genuinely unauthenticated.`,
			);
		}
	}

	if (mode === "models-config" && config.discovery && !config.api) {
		throw new Error(`Provider ${providerName}: "api" is required when discovery is enabled at provider level.`);
	}
	const configCompat = config.compat;
	if (
		configCompat &&
		"supportsResponsesSessionAffinity" in configCompat &&
		configCompat.supportsResponsesSessionAffinity !== undefined
	) {
		const source = '"compat.supportsResponsesSessionAffinity"';
		if (models.length > 0) {
			for (const model of models) {
				assertResponsesSessionAffinitySupported(
					providerName,
					model.api ?? config.api ?? getKnownProviderModelApi(providerName, model.id),
					model.baseUrl ?? config.baseUrl,
					source,
				);
			}
		} else if (config.api) {
			assertResponsesSessionAffinitySupported(providerName, config.api, config.baseUrl, source);
		} else {
			const knownApis = getKnownProviderApis(providerName);
			if (knownApis.size === 0) {
				assertResponsesSessionAffinitySupported(providerName, undefined, config.baseUrl, source);
			}
			for (const api of knownApis) {
				assertResponsesSessionAffinitySupported(providerName, api, config.baseUrl, source);
			}
		}
	}
	for (const [modelId, rawOverride] of Object.entries(config.modelOverrides ?? {})) {
		const override = rawOverride as ModelOverride;
		const effectiveApi =
			models.find(model => model.id === modelId)?.api ??
			config.api ??
			getKnownProviderModelApi(providerName, modelId);
		if (override.compat?.supportsResponsesSessionAffinity !== undefined) {
			assertResponsesSessionAffinitySupported(
				providerName,
				effectiveApi,
				config.baseUrl,
				`modelOverrides ${modelId} "compat.supportsResponsesSessionAffinity"`,
			);
		}
		if (!override.requestTransform) continue;
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
		const modelCompat = modelDef.compat;
		if (modelCompat && "supportsResponsesSessionAffinity" in modelCompat) {
			assertResponsesSessionAffinitySupported(
				providerName,
				effectiveApi,
				modelDef.baseUrl ?? config.baseUrl,
				`model ${modelDef.id} "compat.supportsResponsesSessionAffinity"`,
			);
		}
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
	api?: Api;
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	authHeader?: boolean;
	compat?: Model<Api>["compat"];
	transport?: Model<Api>["transport"];
	requestTransform?: ModelRequestTransform;
	cacheRetention?: CacheRetention;
	isOAuth?: boolean;
}

function hasMatchingRegistryTransport(left: Model<Api>, right: Model<Api> | ProviderOverride): boolean {
	return (
		left.baseUrl === right.baseUrl &&
		isDeepStrictEqual(left.headers, right.headers) &&
		left.transport === right.transport &&
		isDeepStrictEqual(left.requestTransform, right.requestTransform) &&
		left.cacheRetention === right.cacheRetention &&
		left.isOAuth === right.isOAuth
	);
}

function commonRegistryTransportCompat(models: readonly Model<Api>[]): Model<Api>["compat"] | undefined {
	if (models.length === 0) return undefined;
	const records = models.map(model => model.compat as Record<string, unknown> | undefined);
	const keys = new Set(records.flatMap(record => (record ? Object.keys(record) : [])));
	const common: Record<string, unknown> = {};
	for (const key of keys) {
		const value = records[0]?.[key];
		if (records.every(record => record !== undefined && isDeepStrictEqual(record[key], value))) common[key] = value;
	}
	return Object.keys(common).length > 0 ? (common as Model<Api>["compat"]) : undefined;
}

function registryModelMetadataWithoutApiSpecificFields(model: Model<Api>): Partial<Model<Api>> {
	const metadata: Partial<Model<Api>> = {
		name: model.name,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	if (model.longContextPricing !== undefined) metadata.longContextPricing = model.longContextPricing;
	if (model.premiumMultiplier !== undefined) metadata.premiumMultiplier = model.premiumMultiplier;
	if (model.priority !== undefined) metadata.priority = model.priority;
	if (model.contextPromotionTarget !== undefined) metadata.contextPromotionTarget = model.contextPromotionTarget;
	return metadata;
}

function registrySelectorResolvesToModel(selector: string, models: readonly Model<Api>[]): boolean {
	if (models.some(model => model.id === selector || `${model.provider}/${model.id}` === selector)) return true;
	const suffix = splitSelectorThinkingSuffix(selector);
	const baseSelector = suffix.thinkingLevel === undefined ? selector : suffix.selector;
	const parsed = parseModelString(baseSelector);
	if (parsed) return models.some(model => model.provider === parsed.provider && model.id === parsed.id);
	return models.some(model => model.id === baseSelector || model.id.endsWith(`/${baseSelector}`));
}

function filterMaterializedRegistryProfiles(
	profiles: ReadonlyMap<string, ModelProfileDefinition>,
	models: readonly Model<Api>[],
	dynamicProviders: ReadonlySet<string>,
): Map<string, ModelProfileDefinition> {
	const filtered = new Map<string, ModelProfileDefinition>();
	for (const [name, profile] of profiles) {
		if (
			profile.source === "registry" &&
			Object.values(profile.modelMapping).some(selectorValue => {
				const selectors = normalizeModelSelectorValue(selectorValue);
				return (
					selectors.length > 0 &&
					!selectors.some(selector => {
						if (registrySelectorResolvesToModel(selector, models)) return true;
						const suffix = splitSelectorThinkingSuffix(selector);
						const parsed = parseModelString(suffix.thinkingLevel ? suffix.selector : selector);
						return parsed !== undefined && dynamicProviders.has(parsed.provider);
					})
				);
			})
		) {
			continue;
		}
		filtered.set(name, profile);
	}
	return filtered;
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

/**
 * Provider base URL from the environment, trusted sources only.
 *
 * The result is baked into the provider override and reaches `model.baseUrl`,
 * which the provider resolvers use as the request endpoint that carries the
 * provider credential. `$env` (and therefore `$pickenv`) merges the caller's
 * `cwd/.env`, so reading it there would let repository content redirect
 * authenticated traffic for any provider — including re-admitting a redirect
 * that the provider-level resolvers already reject. Resolve it the same way
 * provider credentials are: launching shell plus GJC/user-owned `.env` files,
 * never the project `.env`.
 */
function resolveProviderBaseUrlFromEnv(provider: string): string | undefined {
	const baseUrl = $pickCredentialEnv(...getProviderBaseUrlEnvKeys(provider));
	return provider === "omlx" && baseUrl ? resolveLoopbackOpenAIBaseUrl(baseUrl, "http://127.0.0.1:8080/v1") : baseUrl;
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
			headers: mergeCaseInsensitiveHeaders(existing.headers, model.headers),
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
			headers: mergeCaseInsensitiveHeaders(model.headers, providerOverride.headers),
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

const REUSABLE_DISCOVERY_HEADER_NAMES = new Set([
	"accept",
	"content-type",
	"openai-organization",
	"openai-project",
	"x-organization-id",
	"x-project-id",
	"x-routing-id",
	"x-tenant-id",
	"x-workspace-id",
]);

function isSensitiveDiscoveryHeader(name: string): boolean {
	// Persist values only for a small, audited set of request-shaping headers.
	// Unknown headers fail closed because their semantics cannot be inferred from
	// their names (for example, CF-Access-Jwt-Assertion carries a credential).
	return !REUSABLE_DISCOVERY_HEADER_NAMES.has(name.toLowerCase());
}

/**
 * Credential-safe fingerprint of the effective configured-discovery request
 * identity: non-secret credential evidence, normalized endpoint, effective
 * request headers (config plus runtime overrides, lowercased and sorted), and
 * the semantic request-shape fields (discovery type, provider api, per-prefix
 * api routing, models.dev catalog key). A
 * published cache row is only trusted while this fingerprint is unchanged, so
 * a tenant/project header change (or any other request-shape change)
 * invalidates the authoritative catalog instead of silently serving the old
 * context's models. Configurations containing secret-bearing headers are not
 * fingerprinted or persisted at all because an unsalted digest would permit
 * offline guessing of low-entropy values.
 */
function fingerprintConfiguredDiscoveryRequestShape(
	providerConfig: DiscoveryProviderConfig,
	authEvidence: string,
	endpoint: string,
): string | undefined {
	const sortEntries = (record: Record<string, string> | undefined) =>
		Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	try {
		const parsed = new URL(providerConfig.baseUrl ?? "");
		if (parsed.username || parsed.password || parsed.search) return undefined;
	} catch {
		return undefined;
	}
	if (Object.keys(providerConfig.headers ?? {}).some(isSensitiveDiscoveryHeader)) return undefined;
	const context = JSON.stringify({
		authEvidence,
		endpoint,
		headers: sortEntries(providerConfig.headers).map(([name, value]) => [name.toLowerCase(), value]),
		discoveryType: providerConfig.discovery.type,
		api: providerConfig.api,
		apiByModelPrefix: sortEntries(providerConfig.discovery.apiByModelPrefix),
		modelsDevProvider: providerConfig.discovery.modelsDevProvider ?? "",
	});
	return crypto.createHash("sha256").update("gajae:model-discovery-provenance\0").update(context).digest("hex");
}

function fingerprintDescriptorDiscoveryProvenance(authEvidence: string, endpoint: string): string | undefined {
	try {
		const parsed = new URL(endpoint);
		if (parsed.username || parsed.password || parsed.search) return undefined;
	} catch {
		return undefined;
	}
	return crypto
		.createHash("sha256")
		.update("gajae:model-discovery-provenance\0")
		.update(JSON.stringify({ authEvidence, endpoint }))
		.digest("hex");
}

export interface CanonicalModelQueryOptions {
	availableOnly?: boolean;
	candidates?: readonly Model<Api>[];
	/** Stable session identity used to keep a canonical variant sticky within a session. */
	sessionId?: string;
	/** Credential-selection session used to classify effective provider auth. Defaults to sessionId. */
	credentialSessionId?: string;
}

/** One canonical record with its winning variant resolved, from a batch query. */
export interface CanonicalModelSelection {
	record: CanonicalModelRecord;
	model: Model<Api> | undefined;
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
	return $rotatingCredentialEnv(envKey);
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
	const providerEntry = authStorage.getAll()[resolveOAuthStorageProvider(provider)];
	if (!providerEntry) return [];
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

function resolveOAuthAccountIdForAccessToken(
	authStorage: AuthStorage,
	provider: string,
	accessToken: string,
	owner?: object,
): string | undefined {
	if (authStorage.getEffectiveCredentialType(provider, undefined, owner ? { owner } : undefined) !== "oauth") {
		return undefined;
	}
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

function mergeProviderCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: Model<Api>["compat"],
): Model<Api>["compat"] {
	const merged = mergeCompat(baseCompat, overrideCompat);
	// An explicit model-level opt-out must win over a provider-level opt-in.
	const baseAffinity =
		baseCompat && "supportsResponsesSessionAffinity" in baseCompat
			? baseCompat.supportsResponsesSessionAffinity
			: undefined;
	const overrideAffinity =
		overrideCompat && "supportsResponsesSessionAffinity" in overrideCompat
			? overrideCompat.supportsResponsesSessionAffinity
			: undefined;
	let protectedMerged = merged;
	if (baseAffinity === false && overrideAffinity !== undefined) {
		protectedMerged = { ...protectedMerged, supportsResponsesSessionAffinity: false };
	}
	const baseReasoningEffort =
		baseCompat && "supportsReasoningEffort" in baseCompat ? baseCompat.supportsReasoningEffort : undefined;
	const overrideReasoningEffort =
		overrideCompat && "supportsReasoningEffort" in overrideCompat
			? overrideCompat.supportsReasoningEffort
			: undefined;
	if (baseReasoningEffort === false && overrideReasoningEffort !== undefined) {
		protectedMerged = { ...protectedMerged, supportsReasoningEffort: false };
	}
	return protectedMerged;
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
	const contextWindowOverride = toPositiveNumberOrUndefined(override.contextWindow);
	if (contextWindowOverride !== undefined) {
		result.contextWindow = contextWindowOverride;
	} else if (override.contextWindow !== undefined && !isCodexGpt56Tier({ id: model.id })) {
		// Codex-tier invalid overrides are diagnosed in #collectCodexContextWindowOverrides;
		// every other provider is diagnosed here so an ignored override is never silent.
		logger.warn("model context-window override ignored: value must be a positive finite number", {
			model: model.id,
			provider: model.provider,
			override: override.contextWindow,
		});
	}
	if (override.maxTokens !== undefined && Number.isSafeInteger(override.maxTokens) && override.maxTokens > 0) {
		result.maxTokens = override.maxTokens;
		result.maxTokensSource = "configured";
	}
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
		const explicitAuthKey = Object.keys(override.headers).find(key => key.toLowerCase() === "authorization");
		if (explicitAuthKey !== undefined) {
			const explicitAuthValue = override.headers[explicitAuthKey];
			deleteHeaderCaseInsensitive(result.headers, "Authorization");
			result.headers[explicitAuthKey] = explicitAuthValue;
			delete (result.headers as Record<string, string> & { [GENERATED_AUTH_HEADER]?: boolean })[
				GENERATED_AUTH_HEADER
			];
		}
	}
	result.compat = mergeCompat(model.compat, override.compat);
	return enrichModelThinking(result);
}
/**
 * Normalizes `modelOverrides` keys to lowercase so override matching is
 * case-insensitive everywhere (the Codex cap exemption is keyed by
 * `codexContextOverrideKey`, which lowercases both sides). Without this,
 * a mixed-case config key is exempted from the cap without its value ever
 * being merged into the model.
 */
function normalizeModelOverrideKeys(
	modelOverrides: Map<string, Map<string, ModelOverride>>,
): Map<string, Map<string, ModelOverride>> {
	const normalized = new Map<string, Map<string, ModelOverride>>();
	for (const [provider, perModel] of modelOverrides) {
		const perProvider = new Map<string, ModelOverride>();
		for (const [modelId, override] of perModel) {
			perProvider.set(modelId.toLowerCase(), override);
		}
		normalized.set(provider.toLowerCase(), perProvider);
	}
	return normalized;
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
	maxTokensSource?: ModelMaxTokensSource;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
	contextPromotionTarget?: string;
	premiumMultiplier?: number;
	wireModelId?: string;
	requestTransform?: ModelRequestTransform;
	cacheRetention?: CacheRetention;
	transport?: Model<Api>["transport"];
	isOAuth?: boolean;
};

function mergeCustomModelHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	const merged = mergeCaseInsensitiveHeaders(providerHeaders, modelHeaders);
	return mergeAuthHeader(merged, authHeader, apiKeyConfig);
}

function mergeCaseInsensitiveHeaders(
	baseHeaders: Record<string, string> | undefined,
	overrideHeaders: Record<string, string> | undefined,
): (Record<string, string> & { [GENERATED_AUTH_HEADER]?: string }) | undefined {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseHeaders ?? {})) {
		if (key.toLowerCase() === "authorization") deleteHeaderCaseInsensitive(merged, "Authorization");
		merged[key] = value;
	}
	for (const [key, value] of Object.entries(overrideHeaders ?? {})) {
		if (key.toLowerCase() === "authorization") deleteHeaderCaseInsensitive(merged, "Authorization");
		merged[key] = value;
	}
	const baseGenerated = (baseHeaders as (Record<string, string> & { [GENERATED_AUTH_HEADER]?: string }) | undefined)?.[
		GENERATED_AUTH_HEADER
	];
	const overrideGenerated = (
		overrideHeaders as (Record<string, string> & { [GENERATED_AUTH_HEADER]?: string }) | undefined
	)?.[GENERATED_AUTH_HEADER];
	const survivingGenerated =
		headerValue(overrideHeaders, "Authorization") !== undefined ? overrideGenerated : baseGenerated;
	if (survivingGenerated !== undefined && headerValue(merged, "Authorization") === survivingGenerated) {
		(merged as Record<string, string> & { [GENERATED_AUTH_HEADER]?: string })[GENERATED_AUTH_HEADER] =
			survivingGenerated;
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeAuthHeader(
	headers: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	const nextHeaders = headers && Object.keys(headers).length > 0 ? { ...headers } : undefined;
	if (!authHeader || !apiKeyConfig || headerValue(nextHeaders, "Authorization") !== undefined) {
		return nextHeaders;
	}
	return apiKeyConfig
		? ({
				...nextHeaders,
				Authorization: `Bearer ${apiKeyConfig}`,
				[GENERATED_AUTH_HEADER]: `Bearer ${apiKeyConfig}`,
			} as Record<string, string>)
		: nextHeaders;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	const lowerName = name.toLowerCase();
	const key = Object.keys(headers ?? {}).find(candidate => candidate.toLowerCase() === lowerName);
	return key === undefined ? undefined : headers?.[key];
}

function deleteHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
	const lowerName = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lowerName) delete headers[key];
	}
}

function ownsOnlyGeneratedAuthorization(headers: Record<string, string>, generated: string | undefined): boolean {
	if (generated === undefined) return false;
	const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === "authorization");
	return entries.length === 1 && entries[0]![1] === generated;
}

function deleteAuthorizationValue(headers: Record<string, string>, value: string): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === "authorization" && headers[key] === value) delete headers[key];
	}
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
	providerTransport: Model<Api>["transport"] | undefined,
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
		maxTokensSource:
			modelDef.maxTokens !== undefined && Number.isSafeInteger(modelDef.maxTokens) && modelDef.maxTokens > 0
				? "configured"
				: undefined,
		headers: mergeCustomModelHeaders(providerHeaders, modelDef.headers, authHeader, providerApiKey),
		compat: mergeCompat(providerCompat, modelDef.compat),
		requestTransform: mergeRequestTransform(providerRequestTransform, modelDef.requestTransform),
		wireModelId: modelDef.wireModelId,
		contextPromotionTarget: modelDef.contextPromotionTarget,
		premiumMultiplier: modelDef.premiumMultiplier,
		cacheRetention: modelDef.cacheRetention ?? providerCacheRetention,
		transport: providerTransport,
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
	const trimmedId = modelId.trim();
	const minimaxM = /^minimax-m(\d+(?:\.\d+)*)$/i.exec(trimmedId);
	const queue = minimaxM ? [`MiniMax-M${minimaxM[1]}`, trimmedId] : [trimmedId];
	if (minimaxM) {
		// First-class MiniMax catalogs expose canonical `MiniMax-M*` ids only,
		// but custom providers may still use lowercase wire ids. Normalize to
		// the canonical display casing so metadata inheritance keeps working.
	}
	// Namespaced wire IDs (e.g. `cline-pass/deepseek-v4-flash`) keep the full id for
	// the API request, but should still try the leaf segment against bundled
	// references so capability metadata is not silently replaced by 128K/16K defaults.
	// Only an exact leaf match in the reference map inherits; unknown leaves stay defaulted.
	const slashIndex = trimmedId.lastIndexOf("/");
	if (slashIndex >= 0 && slashIndex < trimmedId.length - 1) {
		const leafId = trimmedId.slice(slashIndex + 1).trim();
		if (leafId && leafId !== trimmedId) {
			queue.push(leafId);
		}
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
		maxTokensSource:
			resolvedModel.maxTokensSource ?? (reference?.maxTokensSource === "configured" ? "configured" : undefined),
		headers: resolvedModel.headers,
		compat: mergeCompat(reference?.compat, resolvedModel.compat),
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		wireModelId: resolvedModel.wireModelId,
		requestTransform: resolvedModel.requestTransform,
		cacheRetention: resolvedModel.cacheRetention ?? reference?.cacheRetention,
		transport: resolvedModel.transport,
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

function getDisabledProviderIdsFromSettings(settingsReader: Pick<Settings, "get"> = settings): Set<string> {
	try {
		return new Set(settingsReader.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

function getConfiguredProviderOrderFromSettings(settingsReader: Pick<Settings, "getGlobal"> = settings): string[] {
	try {
		const configured = settingsReader.getGlobal("modelProviderOrder");
		return Array.isArray(configured) ? configured.filter((value): value is string => typeof value === "string") : [];
	} catch {
		return [];
	}
}
interface ProviderActivityEvidence {
	staticModelIds: ReadonlySet<string>;
	staticConfigured: boolean;
	discoveryConfigured: boolean;
	implicitDiscovery: boolean;
	descriptorBacked: boolean;
	descriptorFresh: boolean;
	descriptorModelIds: ReadonlySet<string>;
	authGeneration: string;
	endpoint: string;
}

interface ModelManagerDiscoveryOptions {
	options: ModelManagerOptions<Api>;
	authGeneration: string;
	apiKey: string | undefined;
	endpoint: string;
	endpointContainsUserinfo: boolean;
}

interface ConfiguredDiscoveryResult {
	provider: string;
	current: boolean;
	models: Model<Api>[];
	authGeneration: string;
	configurationGeneration: number;
	endpoint: string;
	fetched: boolean;
	clearPublishedModelIds?: readonly string[];
}

type ProviderRefreshFence = { providerId: string; generation: number } | { generations: ReadonlyMap<string, number> };

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	#models: Model<Api>[] = [];
	#catalogChangeListeners: Set<() => void> = new Set();
	#canonicalIndex: CanonicalModelIndex = {
		records: [],
		byId: new Map(),
		bySelector: new Map(),
		aliases: new Map(),
	};
	#availableModelsCache: Model<Api>[] | undefined;
	#availableModelsDisabledProviders: string | undefined;
	#availableModelsEnvFingerprint: string | undefined;
	#sessionCanonicalVariants = new Map<string, string>();
	#customProviderApiKeys: Map<string, string> = new Map();
	#customProviderApiKeyEnvNames: Map<string, string> = new Map();
	#customProviderAuthHeaders: Map<string, boolean> = new Map();
	#providerWebSearchModes: Map<string, WebSearchMode> = new Map();
	#keylessProviders: Set<string> = new Set();
	#optionalAuthProviders: Set<string> = new Set();
	#credentiallessAuthFallbackProviders: Map<string, string> = new Map();
	#providerEvidenceApiKeys: Map<string, string | undefined> = new Map();
	#providerActivity: ReadonlyMap<string, ProviderActivityEvidence> = new Map();
	#configuredProviderIds: ReadonlySet<string> = new Set();
	#configuredDiscoveryProviderIds: ReadonlySet<string> = new Set();
	#descriptorDiscoveryEvidence = new Map<
		string,
		{
			fresh: boolean;
			modelIds: ReadonlySet<string>;
			profileModelIds?: ReadonlySet<string>;
			profileFresh?: boolean;
			profileEndpoint?: string;
			authGeneration: string;
			endpoint: string;
		}
	>();
	#descriptorDiscoveryGenerations = new Map<string, number>();
	#configuredDiscoveryEvidence = new Map<
		string,
		{ authGeneration: string; endpoint: string; modelIds: ReadonlySet<string> }
	>();
	#discoveryManager = new ModelDiscoveryManager<DiscoveryProviderConfig>();
	#customModelOverlays: CustomModelOverlay[] = [];
	#providerOverrides: Map<string, ProviderOverride> = new Map();
	#modelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	#codexContextWindowOverrides: Map<string, number> = new Map();
	#equivalenceConfig: ModelEquivalenceConfig | undefined;
	#modelBindingsApplier = new ModelBindingsApplier();
	#modelProfiles: Map<string, ModelProfileDefinition> = mergeModelProfiles();
	#configError: ConfigError | undefined = undefined;
	#modelsConfigFile: ConfigFile<ModelsConfig>;
	#settings: Pick<Settings, "get" | "getGlobal">;
	readonly #authStorageConfigOwner: object = {};
	#disposeAuthStorageFallbackResolver: (() => void) | undefined;
	#lastStaticLoadMtime: number | null = null;
	#lastStaticLoadEnvironmentFingerprint: string | undefined;
	#lastModelPresetRegistryFingerprint: string | undefined;
	#loadedModelPresetRegistryManifestSha256: string | undefined;
	#modelPresetRegistryAgentDir: string;
	#modelPresetRegistryDependencies: Omit<ModelPresetRegistryDependencies, "agentDir">;
	#cancelModelPresetRegistryRefresh: (() => Promise<void>) | undefined;
	#disposePromise: Promise<void> | undefined;
	#unsubscribeAuthGeneration: (() => void) | undefined;
	#staticModelsLoaded = false;
	#lastDisabledProviderKey: string | undefined;
	#registeredProviderSources: Set<string> = new Set();
	#cacheDbPath?: string;
	#suppressedSelectors: Map<string, number> = new Map();
	#backgroundRefresh?: Promise<void>;
	#catalogMutationTail: Promise<void> = Promise.resolve();
	#pendingCatalogMutations = 0;
	#catalogRefreshGeneration = 0;
	#providerRefreshGenerations = new Map<string, number>();
	#disposed = false;
	// Runtime extension model overlays — persist across refresh() cycles so that
	// models registered by extensions survive the model selector's offline reload.
	#runtimeModelOverlays: CustomModelOverlay[] = [];
	#runtimeProviderApiKeys: Map<string, string> = new Map();
	#runtimeProviderResolvedApiKeys: Map<string, string> = new Map();
	#runtimeProviderCredentialInstalled: Set<string> = new Set();
	#runtimeProviderApiKeyEnvNames: Map<string, string> = new Map();
	#runtimeProviderOverrides: Map<string, ProviderOverride> = new Map();
	#runtimeProviderAuthHeaders: Map<string, boolean> = new Map();
	#generatedAuthHeaderProviders: Set<string> = new Set();
	#generatedAuthHeaders: WeakMap<Model<Api>, { authorization?: string; apiKey?: string }> = new WeakMap();
	#runtimeProvidersBySource: Map<string, Set<string>> = new Map();
	#runtimeProviderSourceByName: Map<string, string> = new Map();
	#registryModelKeys: Set<string> = new Set();
	#rebuildPending: boolean = false;
	#rebuildSuspended: number = 0;
	#configuredApiKeyEnvNames: Set<string> = new Set();
	#optionalAuthPreflightGenerations = new Map<string, number>();
	#optionalAuthPreflightEpoch = 0;

	/**
	 * @param authStorage - Auth storage for API key resolution
	 */
	constructor(
		readonly authStorage: AuthStorage,
		modelsPath?: string,
		registrySettings?: Pick<Settings, "get" | "getGlobal">,
		modelPresetRegistryDependencies: ModelPresetRegistryDependencies = {},
	) {
		this.#settings = registrySettings ?? settings;
		const configuredAgentDir = path.resolve(modelPresetRegistryDependencies.agentDir ?? getAgentDir());
		this.#modelsConfigFile = ModelsConfigFile.relocate(modelsPath);
		this.#modelPresetRegistryAgentDir = modelPresetRegistryDependencies.agentDir
			? configuredAgentDir
			: modelsPath && path.isAbsolute(modelsPath)
				? path.dirname(modelsPath)
				: configuredAgentDir;
		const { agentDir: _agentDir, ...registryDependencies } = modelPresetRegistryDependencies;
		this.#modelPresetRegistryDependencies = registryDependencies;
		this.#cacheDbPath = modelsPath ? path.join(path.dirname(modelsPath), "models.db") : undefined;
		// Set up fallback resolver for custom provider API keys
		this.#disposeAuthStorageFallbackResolver = this.authStorage.setFallbackResolver(provider => {
			const keyConfig = this.#customProviderApiKeys.get(provider);
			return keyConfig;
		}, this.#authStorageConfigOwner);
		this.#unsubscribeAuthGeneration = this.authStorage.onGenerationChanged(() => this.#invalidateAvailableModels());
		// Load models synchronously in constructor
		this.#loadModels();
		this.#cancelModelPresetRegistryRefresh = refreshModelPresetRegistryInBackground(
			{
				...this.#modelPresetRegistryDependencies,
				agentDir: this.#modelPresetRegistryAgentDir,
				knownManifestSha256: this.#loadedModelPresetRegistryManifestSha256,
			},
			() => {
				void this.#enqueueCatalogMutation(() => {
					if (this.#disposed) return;
					this.#reloadStaticModels();
					this.#modelBindingsApplier.apply();
					this.#notifyCatalogChanged();
				}).catch(() => undefined);
			},
		);
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#catalogRefreshGeneration++;
		const awaitRefreshDisposal = this.#cancelModelPresetRegistryRefresh?.() ?? Promise.resolve();
		this.#cancelModelPresetRegistryRefresh = undefined;
		this.#unsubscribeAuthGeneration?.();
		this.#unsubscribeAuthGeneration = undefined;
		this.authStorage.clearConfigApiKeys(this.#authStorageConfigOwner);
		this.#disposeAuthStorageFallbackResolver?.();
		this.#disposeAuthStorageFallbackResolver = undefined;
		this.#catalogChangeListeners.clear();
		this.#disposePromise = awaitRefreshDisposal;
		return this.#disposePromise;
	}

	#enqueueCatalogMutation(operation: () => void | Promise<void>): Promise<void> {
		this.#pendingCatalogMutations++;
		let run: Promise<void>;
		if (this.#pendingCatalogMutations === 1) {
			try {
				run = Promise.resolve(operation());
			} catch (error) {
				run = Promise.reject(error);
			}
		} else {
			run = this.#catalogMutationTail.then(operation);
		}
		const completion = run.finally(() => {
			this.#pendingCatalogMutations--;
		});
		this.#catalogMutationTail = completion.catch(() => undefined);
		return completion;
	}

	onCatalogChanged(listener: () => void): () => void {
		this.#catalogChangeListeners.add(listener);
		return () => {
			this.#catalogChangeListeners.delete(listener);
		};
	}

	/** Replace the read-only settings snapshot used by profile-scoped resolution. */
	setScopedSettings(settingsReader: Pick<Settings, "get" | "getGlobal">): void {
		this.#catalogRefreshGeneration++;
		this.#settings = settingsReader;
		this.#staticModelsLoaded = false;
		this.#reloadStaticModels();
		this.#rebuildCanonicalIndex();
	}

	/**
	 * Reload models from disk (embedded + accepted registry + custom from models.yml).
	 */
	async refreshStatic(): Promise<void> {
		if (this.#disposed) return;
		await this.#enqueueCatalogMutation(async () => {
			if (this.#disposed) return;
			this.#catalogRefreshGeneration++;
			this.#suspendRebuild();
			try {
				this.#reloadStaticModels();
				this.#suppressedSelectors.clear();
				this.#modelBindingsApplier.apply();
			} finally {
				this.#resumeRebuild();
			}
		});
	}

	/**
	 * Reload models from disk and refresh runtime provider discovery state.
	 */
	async refresh(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		if (this.#disposed) return;
		await this.#enqueueCatalogMutation(async () => {
			if (this.#disposed) return;
			const refreshGeneration = ++this.#catalogRefreshGeneration;
			const providerRefreshFence: ProviderRefreshFence = {
				generations: new Map(this.#providerRefreshGenerations),
			};
			this.#suspendRebuild();
			try {
				this.#reloadStaticModels();
				this.#suppressedSelectors.clear();
				await this.#refreshRuntimeDiscoveries(strategy, undefined, refreshGeneration, providerRefreshFence);
				if (refreshGeneration === this.#catalogRefreshGeneration) this.#modelBindingsApplier.apply();
			} finally {
				this.#resumeRebuild();
			}
		});
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
		if (this.#disposed) return;
		const providerRefreshGeneration = (this.#providerRefreshGenerations.get(providerId) ?? 0) + 1;
		this.#providerRefreshGenerations.set(providerId, providerRefreshGeneration);
		await this.#enqueueCatalogMutation(async () => {
			if (this.#disposed) return;
			const refreshGeneration = this.#catalogRefreshGeneration;
			this.#suspendRebuild();
			try {
				// A provider refresh only updates discovery for this provider.
				// Static catalog changes are serialized through refresh().
				for (const selector of this.#suppressedSelectors.keys()) {
					if (selector.startsWith(`${providerId}/`)) {
						this.#suppressedSelectors.delete(selector);
					}
				}
				await this.#refreshRuntimeDiscoveries(strategy, new Set([providerId]), refreshGeneration, {
					providerId,
					generation: providerRefreshGeneration,
				});
				if (
					refreshGeneration === this.#catalogRefreshGeneration &&
					this.#providerRefreshGenerations.get(providerId) === providerRefreshGeneration
				) {
					this.#modelBindingsApplier.apply();
				}
			} finally {
				this.#resumeRebuild();
			}
		});
	}

	admitCachedProviderForStoredLiteralCredential(providerId: string, selector: AuthCredentialSelector): boolean {
		const cachedModels = this.#loadCachedProviderModelsForStoredLiteralCredential(providerId, selector);
		if (!cachedModels || cachedModels.length === 0) return false;

		this.#suspendRebuild();
		try {
			this.#mergeDiscoveredModels(cachedModels);
			this.#rebuildProviderActivity();
			this.#modelBindingsApplier.apply();
			return true;
		} finally {
			this.#resumeRebuild();
		}
	}

	/** @internal Validate an existing startup model without mutating a caller-supplied registry. */
	validateModelForStoredLiteralCredential(
		providerId: string,
		modelId: string,
		selector: AuthCredentialSelector,
	): boolean {
		if (!this.find(providerId, modelId)) return false;
		if (this.#resolveStaticModelReference(providerId, modelId)) return true;
		const cachedModels = this.#loadCachedProviderModelsForStoredLiteralCredential(providerId, selector, false);
		return cachedModels ? resolveProviderModelReference(providerId, modelId, cachedModels) !== undefined : false;
	}

	/** @internal Whether startup must establish credential-scoped cache provenance for this exact target. */
	requiresStoredLiteralCredentialCacheAdmission(providerId: string, modelId: string): boolean {
		return !this.find(providerId, modelId) || !this.#resolveStaticModelReference(providerId, modelId);
	}

	#loadCachedProviderModelsForStoredLiteralCredential(
		providerId: string,
		selector: AuthCredentialSelector,
		publishDiscoveryState = true,
	): Model<Api>[] | undefined {
		const supportsDiscovery =
			this.#discoveryManager.providerIds().has(providerId) ||
			PROVIDER_DESCRIPTORS.some(descriptor => descriptor.providerId === providerId);
		if (!supportsDiscovery) return undefined;
		const authEvidence = this.authStorage.getStoredLiteralApiKeyEvidenceGeneration(
			providerId,
			selector,
			this.#authStorageConfigOwner,
		);
		if (!authEvidence) return undefined;
		return [
			...this.#loadCachedStandardProviderModels(providerId, authEvidence),
			...this.#loadCachedDiscoverableModels(providerId, authEvidence, publishDiscoveryState),
		];
	}

	#resolveStaticModelReference(providerId: string, modelId: string): Model<Api> | undefined {
		const normalizedProvider = providerId.toLowerCase();
		const matchingActivity = [...this.#providerActivity.entries()].filter(
			([candidateProvider]) => candidateProvider.toLowerCase() === normalizedProvider,
		);
		if (matchingActivity.length !== 1) return undefined;
		const [canonicalProvider, activity] = matchingActivity[0];
		const staticModels = this.#models.filter(
			model => model.provider === canonicalProvider && activity.staticModelIds.has(model.id),
		);
		return resolveProviderModelReference(providerId, modelId, staticModels);
	}

	#getStaticLoadEnvironmentFingerprint(): string {
		const providerBaseUrlEnvKeys = new Set(
			[
				...getBundledProviders(),
				...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
				...this.#configuredProviderIds,
			].flatMap(getProviderBaseUrlEnvKeys),
		);
		return JSON.stringify({
			apiKeyEnv: [...this.#configuredApiKeyEnvNames].sort().map(name => [name, Bun.env[name] ?? ""]),
			implicitEndpoints: [
				["OLLAMA_BASE_URL", Bun.env.OLLAMA_BASE_URL || ""],
				["LLAMA_CPP_BASE_URL", Bun.env.LLAMA_CPP_BASE_URL || ""],
				["LM_STUDIO_BASE_URL", Bun.env.LM_STUDIO_BASE_URL || ""],
			],
			providerBaseUrls: [...providerBaseUrlEnvKeys].sort().map(name => [name, Bun.env[name] ?? ""]),
		});
	}

	#reloadStaticModels(): void {
		const currentMtime = this.#modelsConfigFile.getMtimeMs();
		const disabledProviderKey = [...getDisabledProviderIdsFromSettings(this.#settings)].sort().join("\u0000");
		const environmentFingerprint = this.#getStaticLoadEnvironmentFingerprint();
		const acceptedPresets = loadAcceptedModelPresetProfiles(
			this.#modelPresetRegistryAgentDir,
			this.#modelPresetRegistryDependencies,
		);
		const modelPresetRegistryFingerprint = JSON.stringify({
			revision: acceptedPresets.revision,
			manifestSha256: acceptedPresets.manifestSha256,
			disabled: acceptedPresets.disabled,
			error: acceptedPresets.error,
		});
		if (
			this.#staticModelsLoaded &&
			currentMtime === this.#lastStaticLoadMtime &&
			disabledProviderKey === this.#lastDisabledProviderKey &&
			environmentFingerprint === this.#lastStaticLoadEnvironmentFingerprint &&
			modelPresetRegistryFingerprint === this.#lastModelPresetRegistryFingerprint
		) {
			// models.json and settings-derived implicit provider state are unchanged.
			return;
		}
		this.#modelsConfigFile.invalidate();
		this.#customProviderApiKeys.clear();
		this.#customProviderApiKeyEnvNames.clear();
		this.#customProviderAuthHeaders.clear();
		this.#providerWebSearchModes.clear();
		this.#keylessProviders.clear();
		this.#optionalAuthProviders.clear();
		this.#credentiallessAuthFallbackProviders.clear();
		this.#optionalAuthPreflightEpoch += 1;
		this.#discoveryManager.reset();
		for (const descriptor of PROVIDER_DESCRIPTORS) this.#clearDescriptorDiscoveryEvidence(descriptor.providerId);
		this.#configuredDiscoveryEvidence.clear();
		// Drop config-sourced apiKeys from AuthStorage before reload; entries
		// removed from models.yml must actually disappear from the resolver, not
		// linger from the previous parse. The post-load setters below repopulate.
		this.authStorage.clearConfigApiKeys(this.#authStorageConfigOwner);
		// Runtime provider keys are reapplied after #loadModels so they retain
		// registration-time precedence over colliding static provider keys.
		this.#providerOverrides.clear();
		this.#modelOverrides.clear();
		this.#equivalenceConfig = undefined;
		this.#modelBindingsApplier.setBindings(undefined);
		this.#configError = undefined;
		this.#loadModels();
		for (const [provider, apiKeyConfig] of this.#runtimeProviderApiKeys) {
			const resolved = this.#runtimeProviderApiKeyEnvNames.has(provider)
				? $rotatingCredentialEnv(this.#runtimeProviderApiKeyEnvNames.get(provider)!)
				: resolveApiKeyConfig(apiKeyConfig);
			if (!resolved) {
				this.#runtimeProviderCredentialInstalled.delete(provider);
				const authHeader = this.#runtimeProviderAuthHeaders.get(provider);
				if (authHeader === true) {
					this.#runtimeModelOverlays = this.#runtimeModelOverlays.map(overlay => {
						if (overlay.provider !== provider) return overlay;
						const headers = { ...(overlay.headers ?? {}) } as Record<string, string> & {
							[GENERATED_AUTH_HEADER]?: string;
						};
						const generated = headers[GENERATED_AUTH_HEADER];
						if (typeof generated === "string" && headers.Authorization === generated)
							delete headers.Authorization;
						delete headers[GENERATED_AUTH_HEADER];
						return { ...overlay, headers };
					});
				}
				const override = this.#runtimeProviderOverrides.get(provider);
				if (override) this.#runtimeProviderOverrides.set(provider, { ...override, apiKey: "" });
				continue;
			}
			this.#customProviderApiKeys.set(provider, resolved);
			this.#runtimeProviderResolvedApiKeys.set(provider, resolved);
			this.#runtimeProviderCredentialInstalled.add(provider);
			this.authStorage.setConfigApiKey(provider, resolved, { owner: this.#authStorageConfigOwner });
			const override = this.#runtimeProviderOverrides.get(provider);
			if (override) this.#runtimeProviderOverrides.set(provider, { ...override, apiKey: resolved });
			const authHeader = this.#runtimeProviderAuthHeaders.get(provider);
			if (authHeader === true) {
				this.#runtimeModelOverlays = this.#runtimeModelOverlays.map(overlay => {
					if (overlay.provider !== provider) return overlay;
					const headers = { ...(overlay.headers ?? {}) } as Record<string, string> & {
						[GENERATED_AUTH_HEADER]?: string;
					};
					const generated = headers[GENERATED_AUTH_HEADER];
					const hadAuthorization = headerValue(headers, "Authorization") !== undefined;
					const ownsAuthorization = ownsOnlyGeneratedAuthorization(headers, generated);
					if (ownsAuthorization) deleteHeaderCaseInsensitive(headers, "Authorization");
					if (resolved && (ownsAuthorization || !hadAuthorization))
						return {
							...overlay,
							headers: {
								...headers,
								Authorization: `Bearer ${resolved}`,
								[GENERATED_AUTH_HEADER]: `Bearer ${resolved}`,
							},
						};
					delete headers[GENERATED_AUTH_HEADER];
					return { ...overlay, headers };
				});
			}
		}
		this.#loadModels();
		for (const [provider, apiKeyConfig] of this.#runtimeProviderApiKeys) {
			const resolved = this.#runtimeProviderApiKeyEnvNames.has(provider)
				? $rotatingCredentialEnv(this.#runtimeProviderApiKeyEnvNames.get(provider)!)
				: resolveApiKeyConfig(apiKeyConfig);
			if (!resolved) continue;
			this.#customProviderApiKeys.set(provider, resolved);
			this.#runtimeProviderResolvedApiKeys.set(provider, resolved);
			this.#runtimeProviderCredentialInstalled.add(provider);
			this.authStorage.setConfigApiKey(provider, resolved, { owner: this.#authStorageConfigOwner });
		}
		this.#lastDisabledProviderKey = disabledProviderKey;
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
		this.#keylessProviders = keylessProviders;
		this.#discoveryManager.setProviders(discoverableProviders);
		this.#configuredProviderIds = new Set(configuredProviders);
		this.#configuredDiscoveryProviderIds = new Set(discoverableProviders.map(provider => provider.provider));
		this.#customModelOverlays = customModels;
		this.#providerOverrides = overrides;
		this.#modelOverrides = normalizeModelOverrideKeys(modelOverrides);
		this.#codexContextWindowOverrides = this.#collectCodexContextWindowOverrides();
		this.#equivalenceConfig = equivalence;
		this.#modelBindingsApplier.setBindings(modelBindings);
		const acceptedPresets = loadAcceptedModelPresetProfiles(
			this.#modelPresetRegistryAgentDir,
			this.#modelPresetRegistryDependencies,
		);
		const acceptedRegistryError = acceptedPresets.error
			? new ConfigError("model-preset-registry", undefined, {
					err: new Error(acceptedPresets.error),
					stage: "Registry",
				})
			: undefined;
		this.#configError = configError ?? acceptedRegistryError;

		this.#addImplicitDiscoverableProviders(configuredProviders);
		const builtInModels = this.#applyHardcodedModelPolicies(this.#loadBuiltInModels(overrides));
		const registryModels = this.#applyHardcodedModelPolicies(acceptedPresets.presets);
		const acceptedRegistryModelKeys = new Set(registryModels.map(model => `${model.provider}\u0000${model.id}`));
		const cachedStandardModels = this.#applyHardcodedModelPolicies(this.#loadCachedStandardProviderModels());
		const cachedDiscoveries = this.#applyHardcodedModelPolicies(this.#loadCachedDiscoverableModels());
		const resolvedProviderCatalog = this.#mergeResolvedModels(
			this.#mergeResolvedModels(builtInModels, cachedStandardModels),
			cachedDiscoveries,
		);
		const resolvedDefaults = this.#mergeRegistryModelMetadata(resolvedProviderCatalog, registryModels, overrides);
		const materializedRegistryModelKeys = new Set(
			resolvedDefaults
				.map(model => `${model.provider}\u0000${model.id}`)
				.filter(key => acceptedRegistryModelKeys.has(key)),
		);
		this.#registryModelKeys = materializedRegistryModelKeys;
		const withConfigModels = this.#mergeCustomModels(resolvedDefaults, this.#customModelOverlays);
		// Merge runtime extension models so they survive refresh() cycles
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(combined, this.#modelOverrides);
		this.#models = this.#finalizeModels(this.#applyRuntimeProviderOverrides(withModelOverrides));
		this.#modelProfiles = mergeModelProfiles(
			profiles,
			filterMaterializedRegistryProfiles(
				acceptedPresets.profiles,
				this.#models,
				new Set(acceptedPresets.dynamicProviders),
			),
		);
		this.#rebuildProviderActivity();
		this.#rebuildCanonicalIndex();
		this.#lastStaticLoadMtime = this.#modelsConfigFile.getMtimeMs();
		this.#lastStaticLoadEnvironmentFingerprint = this.#getStaticLoadEnvironmentFingerprint();
		this.#lastModelPresetRegistryFingerprint = JSON.stringify({
			revision: acceptedPresets.revision,
			manifestSha256: acceptedPresets.manifestSha256,
			disabled: acceptedPresets.disabled,
			error: acceptedPresets.error,
		});
		this.#loadedModelPresetRegistryManifestSha256 = acceptedPresets.manifestSha256;
		this.#staticModelsLoaded = true;
	}

	#rebuildProviderActivity(): void {
		const staticModelIds = new Map<string, Set<string>>();
		const addStaticModel = (provider: string, id: string) => {
			const modelIds = staticModelIds.get(provider) ?? new Set<string>();
			modelIds.add(id);
			staticModelIds.set(provider, modelIds);
		};
		for (const provider of getBundledProviders()) {
			for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[])
				addStaticModel(provider, model.id);
		}
		for (const overlay of [...this.#customModelOverlays, ...this.#runtimeModelOverlays])
			addStaticModel(overlay.provider, overlay.id);
		for (const model of this.#models) {
			if (this.#registryModelKeys.has(`${model.provider}\u0000${model.id}`))
				addStaticModel(model.provider, model.id);
		}

		const runtimeProviderIds = new Set(this.#runtimeProviderSourceByName.keys());
		const providerIds = new Set<string>([
			...this.#configuredProviderIds,
			...this.#keylessProviders,
			...this.#discoveryManager.providerIds(),
			...this.#descriptorDiscoveryEvidence.keys(),
			...runtimeProviderIds,
			...staticModelIds.keys(),
		]);
		const activity = new Map<string, ProviderActivityEvidence>();
		for (const provider of providerIds) {
			const discoveryConfigured = this.#configuredDiscoveryProviderIds.has(provider);
			const isDiscoveryProvider = this.#discoveryManager.providerIds().has(provider);
			const descriptorEvidence = this.#descriptorDiscoveryEvidence.get(provider);
			activity.set(provider, {
				staticModelIds: new Set(staticModelIds.get(provider) ?? []),
				staticConfigured: staticModelIds.has(provider),
				discoveryConfigured,
				implicitDiscovery: isDiscoveryProvider && !discoveryConfigured,
				descriptorBacked:
					descriptorEvidence !== undefined ||
					(!discoveryConfigured && PROVIDER_DESCRIPTORS.some(descriptor => descriptor.providerId === provider)),
				descriptorFresh: descriptorEvidence?.fresh ?? false,
				descriptorModelIds: new Set(descriptorEvidence?.modelIds ?? []),
				authGeneration: descriptorEvidence?.authGeneration ?? "",
				endpoint: descriptorEvidence?.endpoint ?? "",
			});
		}
		this.#providerActivity = activity;
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

	#mergeRegistryModelMetadata(
		baseModels: Model<Api>[],
		registryModels: Model<Api>[],
		providerOverrides: ReadonlyMap<string, ProviderOverride>,
	): Model<Api>[] {
		const merged = [...baseModels];
		const indexByKey = new Map(merged.map((model, index) => [`${model.provider}\u0000${model.id}`, index]));
		for (const registryModel of registryModels) {
			const key = `${registryModel.provider}\u0000${registryModel.id}`;
			const existingIndex = indexByKey.get(key);
			const explicitTransport = this.#resolveProviderOverride(registryModel.provider, providerOverrides);
			if (existingIndex === undefined) {
				const transportTemplates = merged.filter(
					model => model.provider === registryModel.provider && model.api === registryModel.api,
				);
				const transportTemplate = transportTemplates[0];
				const explicitTransportMatches =
					explicitTransport?.api === registryModel.api && explicitTransport.baseUrl !== undefined;
				const templatesAgree =
					transportTemplate !== undefined &&
					transportTemplates.every(template => hasMatchingRegistryTransport(transportTemplate, template));
				if (!explicitTransportMatches && transportTemplates.length > 0 && !templatesAgree) continue;
				if (!transportTemplate && !explicitTransportMatches) continue;
				const transportSource = explicitTransportMatches ? explicitTransport : transportTemplate!;
				const inheritedCompat = explicitTransportMatches
					? explicitTransport?.compat
					: commonRegistryTransportCompat(transportTemplates);
				const hydratedRegistryModel = {
					...registryModel,
					baseUrl: transportSource.baseUrl!,
					headers: transportSource.headers,
					transport: transportSource.transport,
					requestTransform: transportSource.requestTransform,
					cacheRetention: transportSource.cacheRetention,
					isOAuth: transportSource.isOAuth,
					compat:
						inheritedCompat || registryModel.compat || explicitTransport?.compat
							? { ...inheritedCompat, ...registryModel.compat, ...explicitTransport?.compat }
							: undefined,
				};
				merged.push(
					explicitTransportMatches
						? this.#applyProviderTransportOverride(hydratedRegistryModel, explicitTransport!)
						: hydratedRegistryModel,
				);
				indexByKey.set(key, merged.length - 1);
				continue;
			}
			const existing = merged[existingIndex]!;
			const effectiveApi = explicitTransport?.api ?? existing.api;
			const registryApiMatchesEffectiveTransport = registryModel.api === effectiveApi;
			const registryMetadata = registryApiMatchesEffectiveTransport
				? registryModel
				: registryModelMetadataWithoutApiSpecificFields(registryModel);
			merged[existingIndex] = {
				...existing,
				...registryMetadata,
				api: explicitTransport?.api ?? existing.api,
				baseUrl: existing.baseUrl,
				headers: existing.headers,
				transport: existing.transport,
				requestTransform: existing.requestTransform,
				cacheRetention: existing.cacheRetention,
				isOAuth: explicitTransport?.isOAuth ?? existing.isOAuth,
				wireModelId: existing.wireModelId,
				compat:
					existing.compat ||
					(registryApiMatchesEffectiveTransport ? registryModel.compat : undefined) ||
					explicitTransport?.compat
						? {
								...existing.compat,
								...(registryApiMatchesEffectiveTransport ? registryModel.compat : undefined),
								...explicitTransport?.compat,
							}
						: undefined,
			};
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
					maxTokensSource: customModel.maxTokensSource ?? existingModel.maxTokensSource,
					// Same-id custom definitions replace bundled transport behavior. Provider-level
					// headers/compat were already folded into customModel during parsing; do not
					// re-merge bundled transport metadata here.
					headers: customModel.headers,
					compat: customModel.compat,
					transport: customModel.transport,
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

	#loadCachedStandardProviderModels(providerId?: string, authEvidence?: string): Model<Api>[] {
		const configuredDiscoveryProviders = new Set(this.#discoveryManager.providers.map(provider => provider.provider));
		const cachedModels: Model<Api>[] = [];
		for (const descriptor of PROVIDER_DESCRIPTORS) {
			if (providerId && descriptor.providerId !== providerId) continue;
			if (configuredDiscoveryProviders.has(descriptor.providerId)) {
				continue;
			}
			const cache = readModelCache<Api>(descriptor.providerId, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
			const expectedProvenance = fingerprintDescriptorDiscoveryProvenance(
				authEvidence ?? this.#getProviderEvidenceGeneration(descriptor.providerId),
				this.#normalizeDiscoveryEvidenceEndpoint(this.#getProviderBaseUrlForDiscovery(descriptor.providerId) ?? ""),
			);
			if (
				expectedProvenance === undefined ||
				!cache ||
				cache.dynamicModelIds === undefined ||
				cache.dynamicModelProvenance !== expectedProvenance
			) {
				continue;
			}
			const models = cache.models.map(model =>
				model.provider === descriptor.providerId ? model : { ...model, provider: descriptor.providerId },
			);
			const providerOverride = this.#resolveProviderOverride(descriptor.providerId);
			const withTransport = providerOverride
				? models.map(model => this.#applyProviderTransportOverride(model, providerOverride))
				: models;
			const normalized = this.#applyProviderModelOverrides(descriptor.providerId, withTransport);
			applyGeneratedModelPolicies(normalized);
			cachedModels.push(...normalized);
		}
		return cachedModels;
	}

	#loadCachedDiscoverableModels(
		providerId?: string,
		authEvidence?: string,
		publishDiscoveryState = true,
	): Model<Api>[] {
		const cachedModels: Model<Api>[] = [];
		for (const providerConfig of this.#discoveryManager.providers) {
			if (providerId && providerConfig.provider !== providerId) continue;
			let expectedProvenance: string | undefined;
			try {
				const effectiveConfig = this.#effectiveDiscoveryProviderConfig(providerConfig);
				expectedProvenance = fingerprintConfiguredDiscoveryRequestShape(
					effectiveConfig,
					authEvidence ?? this.#getProviderEvidenceGeneration(effectiveConfig.provider),
					this.#normalizeDiscoveryEvidenceEndpoint(effectiveConfig.baseUrl ?? ""),
				);
			} catch {
				// A context that cannot be fully derived cannot vouch for a cache row.
				expectedProvenance = undefined;
			}
			const models = publishDiscoveryState
				? this.#discoveryManager.loadCached(providerConfig, this.#cacheDbPath, expectedProvenance)
				: this.#readCachedDiscoverableModels(providerConfig, expectedProvenance);
			// Cache rows persist sanitized transport metadata (no headers), so a
			// rebooted registry re-derives the provider transport override from the
			// same source the live publish path uses — mirroring the cached
			// descriptor path — instead of serving header-less models until the
			// next successful online discovery.
			const providerOverride = this.#resolveProviderOverride(providerConfig.provider);
			const withTransport = providerOverride
				? models.map(model => this.#applyProviderTransportOverride(model, providerOverride))
				: models;
			const normalized = this.#applyProviderModelOverrides(
				providerConfig.provider,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(providerConfig.compat, [...withTransport]),
				),
			);
			applyGeneratedModelPolicies(normalized);
			cachedModels.push(...normalized);
		}
		return cachedModels;
	}

	#readCachedDiscoverableModels(
		providerConfig: DiscoveryProviderConfig,
		expectedProvenance: string | undefined,
	): Model<Api>[] {
		const cache = readModelCache<Api>(providerConfig.provider, 24 * 60 * 60 * 1000, Date.now, this.#cacheDbPath);
		if (
			cache === null ||
			cache.dynamicModelIds === undefined ||
			expectedProvenance === undefined ||
			cache.dynamicModelProvenance !== expectedProvenance
		) {
			return [];
		}
		return applyFinalCodexGpt56ContextCap(cache.models);
	}

	#applyProviderCompat(compat: Model<Api>["compat"] | undefined, models: Model<Api>[]): Model<Api>[] {
		if (!compat) return models;
		return models.map(model => ({ ...model, compat: mergeCompat(model.compat, compat) }));
	}

	#normalizeDiscoverableModels(providerConfig: DiscoveryProviderConfig, models: Model<Api>[]): Model<Api>[] {
		const liveBaseUrl =
			providerConfig.discovery.type === "openai-models-list" ||
			providerConfig.discovery.type === "lm-studio" ||
			providerConfig.discovery.type === "omlx" ||
			providerConfig.discovery.type === "vllm" ||
			providerConfig.discovery.type === "sglang"
				? this.#normalizeOpenAIModelsListBaseUrl(
						this.#getProviderBaseUrlForDiscovery(providerConfig.provider) ?? providerConfig.baseUrl,
					)
				: undefined;
		return models.map(model => {
			const normalized =
				providerConfig.provider === "ollama" &&
				providerConfig.api === "openai-responses" &&
				model.api === "openai-completions"
					? ({ ...model, api: "openai-responses" } as Model<Api>)
					: model;
			const baseUrl = this.#restoreLiveDiscoveryBaseUrl(normalized.baseUrl, liveBaseUrl);
			return {
				...normalized,
				...(baseUrl !== normalized.baseUrl ? { baseUrl } : {}),
				requestTransform: providerConfig.requestTransform
					? mergeRequestTransform(undefined, providerConfig.requestTransform)
					: undefined,
				cacheRetention: normalized.cacheRetention ?? providerConfig.cacheRetention,
			};
		});
	}
	#sanitizeDiscoverableModelsForCache(_providerConfig: DiscoveryProviderConfig, models: Model<Api>[]): Model<Api>[] {
		return this.#stripModelBaseUrlQueries(models).map(model => ({
			...model,
			headers: undefined,
		}));
	}
	#stripModelBaseUrlQueries(models: readonly Model<Api>[]): Model<Api>[] {
		return models.map(model => {
			if (!model.baseUrl) return model;
			try {
				const parsed = new URL(model.baseUrl);
				parsed.username = "";
				parsed.password = "";
				parsed.search = "";
				parsed.hash = "";
				return { ...model, baseUrl: parsed.toString().replace(/\/$/, "") };
			} catch {
				const { baseUrl: _baseUrl, ...withoutBaseUrl } = model;
				return withoutBaseUrl as Model<Api>;
			}
		});
	}
	#stripUrlUserinfo(url: string | undefined): string | undefined {
		if (!url) return url;
		try {
			const parsed = new URL(url);
			if (!parsed.username && !parsed.password) return url;
			parsed.username = "";
			parsed.password = "";
			return parsed.toString();
		} catch {
			return undefined;
		}
	}
	#restoreLiveDiscoveryBaseUrl(modelBaseUrl: string | undefined, liveBaseUrl: string | undefined): string | undefined {
		if (!modelBaseUrl || !liveBaseUrl) return this.#stripUrlUserinfo(modelBaseUrl);
		const restored =
			this.#normalizeDiscoveryEvidenceEndpoint(stripUrlQuery(modelBaseUrl)) !==
			this.#normalizeDiscoveryEvidenceEndpoint(stripUrlQuery(liveBaseUrl))
				? modelBaseUrl
				: liveBaseUrl;
		return this.#stripUrlUserinfo(restored);
	}

	#addImplicitDiscoverableProviders(configuredProviders: Set<string>): void {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		if (!configuredProviders.has("ollama") && !disabledProviders.has("ollama")) {
			this.#discoveryManager.addProvider({
				provider: "ollama",
				api: "openai-responses",
				baseUrl: Bun.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
				discovery: { type: "ollama" },
				optional: true,
			});
			// Implicit Ollama auth is optional and may be added after startup.
			this.#optionalAuthProviders.add("ollama");
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
			// Implicit llama.cpp auth is optional and may be added after startup.
			this.#optionalAuthProviders.add("llama.cpp");
			this.#keylessProviders.add("llama.cpp");
		}
		if (!configuredProviders.has("lm-studio") && !disabledProviders.has("lm-studio")) {
			this.#discoveryManager.addProvider({
				provider: "lm-studio",
				api: "openai-completions",
				baseUrl: Bun.env.LM_STUDIO_BASE_URL || "http://127.0.0.1:1234/v1",
				discovery: { type: "lm-studio" },
				optional: true,
			});
			// Implicit LM Studio auth is optional and may be added after startup.
			this.#optionalAuthProviders.add("lm-studio");
			this.#keylessProviders.add("lm-studio");
		}
		if (!configuredProviders.has("omlx") && !disabledProviders.has("omlx")) {
			this.#discoveryManager.addProvider({
				provider: "omlx",
				api: "openai-completions",
				baseUrl: resolveLoopbackOpenAIBaseUrl(Bun.env.OMLX_BASE_URL, "http://127.0.0.1:8080/v1"),
				discovery: { type: "omlx" },
				optional: true,
			});
			// Implicit oMLX auth is optional and may be added after startup.
			this.#optionalAuthProviders.add("omlx");
			this.#keylessProviders.add("omlx");
		}
	}

	#loadCustomModels(): CustomModelsResult {
		this.#configuredApiKeyEnvNames.clear();
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
			const authMode = (providerConfig.auth ?? "apiKey") as ProviderAuthMode;
			const isOAuth = resolveCustomModelIsOAuth(
				(providerConfig.api as Api | undefined) ?? "openai-completions",
				providerConfig.auth as ProviderAuthMode | undefined,
			);
			if (providerConfig.apiKeyEnv) {
				this.#configuredApiKeyEnvNames.add(providerConfig.apiKeyEnv);
			}
			if (providerConfig.apiKey) this.#configuredApiKeyEnvNames.add(providerConfig.apiKey);
			if (providerConfig.openaiCompat?.apiKeyEnv)
				this.#configuredApiKeyEnvNames.add(providerConfig.openaiCompat.apiKeyEnv);
			if (providerConfig.openaiCompat?.apiKey)
				this.#configuredApiKeyEnvNames.add(providerConfig.openaiCompat.apiKey);
			if (providerConfig.webSearch) this.#providerWebSearchModes.set(providerName, providerConfig.webSearch);
			const providerApiKeyConfig = providerConfig.apiKey
				? resolveApiKeyConfig(providerConfig.apiKey)
				: resolveApiKeyEnvConfig(providerConfig.apiKeyEnv);
			const localOpenAICompat = providerConfig.openaiCompat;
			const rotatingApiKeyEnv = providerConfig.apiKey
				? undefined
				: (providerConfig.apiKeyEnv ?? (localOpenAICompat?.apiKey ? undefined : localOpenAICompat?.apiKeyEnv));
			if (rotatingApiKeyEnv) this.#customProviderApiKeyEnvNames.set(providerName, rotatingApiKeyEnv);
			if (providerConfig.authHeader !== undefined)
				this.#customProviderAuthHeaders.set(providerName, providerConfig.authHeader);
			const localOpenAICompatApiKeyConfig = localOpenAICompat
				? localOpenAICompat.apiKey
					? resolveApiKeyConfig(localOpenAICompat.apiKey)
					: resolveApiKeyEnvConfig(localOpenAICompat.apiKeyEnv)
				: undefined;
			if (localOpenAICompat) {
				const localOpenAICompatBaseUrl = normalizeLocalOpenAICompatBaseUrl(localOpenAICompat.baseUrl);
				const localCompatResolvedKey = localOpenAICompat.apiKey
					? resolveApiKeyConfig(localOpenAICompat.apiKey)
					: localOpenAICompat.apiKeyEnv
						? resolveApiKeyEnvConfig(localOpenAICompat.apiKeyEnv)
						: undefined;
				overrides.set(providerName, {
					api: "openai-completions",
					baseUrl: localOpenAICompatBaseUrl,
					apiKey: localOpenAICompatApiKeyConfig,
					isOAuth,
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
					this.authStorage.setConfigApiKey(providerName, localCompatResolvedKey, {
						envSourced: !localOpenAICompat.apiKey,
						owner: this.#authStorageConfigOwner,
					});
				} else {
					keylessProviders.add(providerName);
					this.#optionalAuthProviders.add(providerName);
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
					api: providerConfig.api as Api | undefined,
					baseUrl: providerConfig.baseUrl,
					headers: providerConfig.headers,
					apiKey: providerApiKeyConfig,
					authHeader: providerConfig.authHeader,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					transport: providerConfig.transport,
					requestTransform: providerConfig.requestTransform,
					cacheRetention: providerConfig.cacheRetention,
					isOAuth,
				});
			}

			if (authMode === "none") {
				keylessProviders.add(providerName);
			}

			// Explicit discovery config is authoritative. Otherwise auto-enable
			// OpenAI-compatible `/v1/models` discovery for any custom provider that
			// declares an OpenAI-family `api` and a `baseUrl`: a subscription-style
			// gateway (e.g. CLIProxyAPI) then auto-populates `/model` with its live
			// catalog and auto-routes each model's wire family, with no manual
			// `discovery:` block. It stays optional so an endpoint without
			// `/v1/models` degrades to the configured static models instead of
			// failing. Providers that route through the local `openaiCompat` proxy
			// already register their own discovery above, so skip them here.
			const effectiveDiscoveryBaseUrl = providerConfig.baseUrl ?? resolveProviderBaseUrlFromEnv(providerName);
			// The default api for discovered models: the provider-level `api` when
			// set, otherwise the most common OpenAI-family `api` among the
			// statically-configured models. For withfox-style configs that only set
			// `api` per model (`openai-responses` for gpt, `anthropic-messages` for
			// claude), this preserves the intended OpenAI transport for discovered
			// OpenAI models while `detectDiscoveredApiFamily` still flips claude ids
			// to Anthropic.
			const providerApi =
				(providerConfig.api as Api | undefined) ??
				dominantOpenAIFamilyModelApi(providerConfig.models as { api?: string }[] | undefined);
			const autoDiscovery: ProviderDiscovery | undefined =
				!providerConfig.discovery &&
				!localOpenAICompat &&
				providerName !== "vllm" &&
				providerName !== "sglang" &&
				providerApi !== undefined &&
				isOpenAIFamilyApi(providerApi) &&
				effectiveDiscoveryBaseUrl !== undefined
					? { type: "openai-models-list" }
					: undefined;
			const effectiveDiscovery = providerConfig.discovery ?? autoDiscovery;
			if (effectiveDiscovery && providerApi) {
				discoverableProviders.push({
					provider: providerName,
					api: providerApi,
					baseUrl: effectiveDiscoveryBaseUrl,
					headers: providerConfig.headers,
					compat: providerConfig.compat,
					requestTransform: providerConfig.requestTransform,
					cacheRetention: providerConfig.cacheRetention,
					discovery: effectiveDiscovery,
					optional: !providerConfig.discovery,
				});
			}

			// Store API key for fallback resolver AND register as config override
			// so it wins over OAuth tokens from the broker — when the user pins a
			// bearer in models.yml (e.g. for an auth-gateway baseUrl), that bearer
			// must authenticate the outbound request.
			if (providerConfig.apiKey || providerConfig.apiKeyEnv) {
				const resolved = providerConfig.apiKey
					? resolveApiKeyConfig(providerConfig.apiKey)
					: providerConfig.apiKeyEnv
						? resolveApiKeyEnvConfig(providerConfig.apiKeyEnv)
						: undefined;
				if (resolved) this.#customProviderApiKeys.set(providerName, resolved);
				if (resolved) {
					this.authStorage.setConfigApiKey(providerName, resolved, {
						envSourced: !providerConfig.apiKey,
						owner: this.#authStorageConfigOwner,
					});
				}
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
		if (current.profiles?.[normalizedName] !== undefined) {
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

	/**
	 * Re-assert configured modelBindings into the target override slots after a
	 * session-scoped profile reset removed profile-installed keys. Bypasses the
	 * user-edit heuristic so the startup role/agent routing is restored.
	 */
	reapplyConfiguredModelBindings(targetSettings: Settings): void {
		this.#modelBindingsApplier.forceApplyTo(targetSettings);
	}

	/** The currently configured modelBindings, for pre-profile baseline lookup. */
	getConfiguredModelBindings(): ConfiguredModelBindings | undefined {
		return this.#modelBindingsApplier.getBindings();
	}

	async #refreshRuntimeDiscoveries(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
		refreshGeneration = this.#catalogRefreshGeneration,
		providerRefresh?: ProviderRefreshFence,
	): Promise<void> {
		const profileAvailabilityEvidenceBefore = this.#profileAvailabilityEvidenceFingerprint();
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const selectedDiscoverableProviders = (
			providerFilter
				? this.#discoveryManager.providers.filter(provider => providerFilter.has(provider.provider))
				: this.#discoveryManager.providers
		).filter(provider => !disabledProviders.has(provider.provider));
		const configuredDiscoveriesPromise =
			selectedDiscoverableProviders.length === 0
				? Promise.resolve([] as ConfiguredDiscoveryResult[])
				: Promise.all(
						selectedDiscoverableProviders.map(provider =>
							this.#discoverProviderModels(provider, strategy, providerRefresh),
						),
					);
		const [configuredDiscoveryResults, builtInDiscovered] = await Promise.all([
			configuredDiscoveriesPromise,
			this.#discoverBuiltInProviderModels(strategy, providerFilter, providerRefresh),
		]);
		if (
			refreshGeneration !== this.#catalogRefreshGeneration ||
			(providerRefresh !== undefined &&
				"providerId" in providerRefresh &&
				this.#providerRefreshGenerations.get(providerRefresh.providerId) !== providerRefresh.generation)
		) {
			return;
		}
		const currentConfiguredDiscoveryResults = configuredDiscoveryResults.map(result => {
			const providerConfig = selectedDiscoverableProviders.find(provider => provider.provider === result.provider);
			const current =
				result.current &&
				providerConfig !== undefined &&
				(() => {
					try {
						return (
							result.authGeneration ===
								this.#getProviderEvidenceGeneration(
									result.provider,
									this.#providerEvidenceApiKeys.get(result.provider),
								) &&
							result.endpoint ===
								this.#normalizeDiscoveryEvidenceEndpoint(
									this.#effectiveDiscoveryProviderConfig(providerConfig).baseUrl ?? "",
								)
						);
					} catch {
						return false;
					}
				})();
			const invalidatesPublishedState =
				result.current &&
				providerConfig !== undefined &&
				(() => {
					try {
						return (
							result.authGeneration !==
								this.#getProviderEvidenceGeneration(
									result.provider,
									this.#providerEvidenceApiKeys.get(result.provider),
								) ||
							result.configurationGeneration !==
								this.authStorage.getProviderConfigurationGeneration(result.provider) ||
							result.endpoint !==
								this.#normalizeDiscoveryEvidenceEndpoint(
									this.#effectiveDiscoveryProviderConfig(providerConfig).baseUrl ?? "",
								)
						);
					} catch {
						return true;
					}
				})();
			return current
				? { ...result, invalidatesPublishedState }
				: { ...result, current: false, models: [], fetched: false, invalidatesPublishedState };
		});
		// Every field below except `model.baseUrl` and `model.id` depends only on
		// `model.provider`. The built-in catalog carries thousands of models across
		// only a few dozen providers, and `#getProviderEvidenceGeneration` reaches
		// into AuthStorage while `#getProviderBaseUrlForDiscovery` parses URLs, so
		// recomputing per model turned this filter into a per-refresh UI-thread
		// stall. Memoize the provider-keyed work once per provider.
		interface BuiltInProviderEvidenceState {
			evidence:
				| {
						fresh: boolean;
						modelIds: ReadonlySet<string>;
						profileModelIds?: ReadonlySet<string>;
						profileFresh?: boolean;
						profileEndpoint?: string;
						authGeneration: string;
						endpoint: string;
				  }
				| undefined;
			expectedAuthGeneration: string | undefined;
			authGenerationThrew: boolean;
			providerBaseEndpoint: string | undefined;
			canUseCredentialDerivedXiaomiEndpoint: boolean;
		}
		const builtInProviderStates = new Map<string, BuiltInProviderEvidenceState>();
		const builtInProviderStateFor = (provider: string): BuiltInProviderEvidenceState => {
			const cached = builtInProviderStates.get(provider);
			if (cached) return cached;
			let expectedAuthGeneration: string | undefined;
			let authGenerationThrew = false;
			try {
				expectedAuthGeneration = this.#getProviderEvidenceGeneration(
					provider,
					this.#providerEvidenceApiKeys.get(provider),
				);
			} catch {
				authGenerationThrew = true;
			}
			const providerBaseUrl = this.#getProviderBaseUrlForDiscovery(provider);
			const state: BuiltInProviderEvidenceState = {
				evidence: this.#descriptorDiscoveryEvidence.get(provider),
				expectedAuthGeneration,
				authGenerationThrew,
				providerBaseEndpoint:
					providerBaseUrl !== undefined ? this.#normalizeDiscoveryEvidenceEndpoint(providerBaseUrl) : undefined,
				canUseCredentialDerivedXiaomiEndpoint:
					provider === "xiaomi" &&
					this.#providerEvidenceApiKeys.get("xiaomi")?.startsWith("tp-") === true &&
					this.#runtimeProviderOverrides.get("xiaomi")?.baseUrl === undefined &&
					this.#providerOverrides.get("xiaomi")?.baseUrl === undefined &&
					resolveProviderBaseUrlFromEnv("xiaomi") === undefined,
			};
			builtInProviderStates.set(provider, state);
			return state;
		};
		const currentBuiltInDiscovered = builtInDiscovered.filter(model => {
			const state = builtInProviderStateFor(model.provider);
			const { evidence } = state;
			if (evidence === undefined || state.authGenerationThrew) return false;
			if (evidence.authGeneration !== state.expectedAuthGeneration) return false;
			try {
				const currentEndpoint =
					state.providerBaseEndpoint ?? this.#normalizeDiscoveryEvidenceEndpoint(model.baseUrl ?? "");
				return (
					(evidence.endpoint === currentEndpoint ||
						(state.canUseCredentialDerivedXiaomiEndpoint &&
							evidence.endpoint === this.#normalizeDiscoveryEvidenceEndpoint(model.baseUrl ?? ""))) &&
					evidence.modelIds.has(model.id)
				);
			} catch {
				return false;
			}
		});
		const configuredDiscoveryEvidence = new Map(
			currentConfiguredDiscoveryResults
				.filter(result => result.current)
				.map(result => [
					result.provider,
					{
						authGeneration: result.authGeneration,
						endpoint: result.endpoint,
						modelIds: new Set(result.models.map(model => model.id)),
					},
				]),
		);
		const configuredDiscoveries = new Map(currentConfiguredDiscoveryResults.map(result => [result.provider, result]));
		const configuredDiscovered = currentConfiguredDiscoveryResults.flatMap(result => result.models);
		const discovered = [...configuredDiscovered, ...currentBuiltInDiscovered];
		const clearPublishedModelIds = new Map(
			currentConfiguredDiscoveryResults
				.filter(result => result.current && result.clearPublishedModelIds !== undefined)
				.map(result => [result.provider, new Set(result.clearPublishedModelIds ?? [])]),
		);
		for (const provider of selectedDiscoverableProviders) {
			const evidence = configuredDiscoveryEvidence.get(provider.provider);
			const discovery = configuredDiscoveries.get(provider.provider);
			const state = this.#discoveryManager.getState(provider.provider);
			if (!discovery?.current) {
				if (discovery?.invalidatesPublishedState) this.#discoveryManager.invalidate(provider.provider);
				continue;
			}
			const currentAuthGeneration = discovery.authGeneration;
			const currentEndpoint = this.#normalizeDiscoveryEvidenceEndpoint(
				this.#effectiveDiscoveryProviderConfig(provider).baseUrl ?? "",
			);
			if (
				evidence !== undefined &&
				state?.status === "ok" &&
				discovery.fetched &&
				currentAuthGeneration === evidence.authGeneration &&
				currentEndpoint === evidence.endpoint
			) {
				this.#configuredDiscoveryEvidence.set(provider.provider, evidence);
			} else if (
				(state?.status !== "cached" && !(state?.status === "ok" && !discovery.fetched)) ||
				state.error !== undefined ||
				this.#configuredDiscoveryEvidence.get(provider.provider)?.authGeneration !== currentAuthGeneration ||
				this.#configuredDiscoveryEvidence.get(provider.provider)?.endpoint !== currentEndpoint
			) {
				this.#configuredDiscoveryEvidence.delete(provider.provider);
			}
		}
		this.#rebuildProviderActivity();
		if (clearPublishedModelIds.size > 0) {
			this.#models = this.#models.filter(model => {
				const ids = clearPublishedModelIds.get(model.provider);
				return (
					!ids?.has(model.id) ||
					(this.#providerActivity.get(model.provider)?.staticModelIds.has(model.id) ?? false)
				);
			});
		}
		if (discovered.length === 0) {
			if (
				clearPublishedModelIds.size > 0 ||
				profileAvailabilityEvidenceBefore !== this.#profileAvailabilityEvidenceFingerprint()
			) {
				this.#rebuildCanonicalIndex();
			}
			return;
		}
		this.#mergeDiscoveredModels(discovered);
	}

	#profileAvailabilityEvidenceFingerprint(): string {
		return JSON.stringify(
			[...this.#descriptorDiscoveryEvidence.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([provider, evidence]) => [
					provider,
					evidence.fresh,
					evidence.profileFresh,
					evidence.authGeneration,
					evidence.endpoint,
					evidence.profileEndpoint,
					[...evidence.modelIds].sort(),
					evidence.profileModelIds === undefined ? undefined : [...evidence.profileModelIds].sort(),
				]),
		);
	}

	#mergeDiscoveredModels(discovered: readonly Model<Api>[]): void {
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
		this.#models = this.#finalizeModels(this.#applyRuntimeProviderOverrides(withModelOverrides));
		this.#rebuildCanonicalIndex();
	}

	async #discoverProviderModels(
		providerConfig: DiscoveryProviderConfig,
		strategy: ModelRefreshStrategy,
		providerRefresh?: ProviderRefreshFence,
	): Promise<ConfiguredDiscoveryResult> {
		const provider = providerConfig.provider;
		const preflightEpoch = this.#optionalAuthPreflightEpoch;
		const preflightGeneration = (this.#optionalAuthPreflightGenerations.get(provider) ?? 0) + 1;
		this.#optionalAuthPreflightGenerations.set(provider, preflightGeneration);
		const isCurrentPreflight = () =>
			this.#optionalAuthPreflightEpoch === preflightEpoch &&
			this.#optionalAuthPreflightGenerations.get(provider) === preflightGeneration;
		let preflightApiKey: string | undefined;
		let preflightFailed = false;
		let preflightStale = false;
		let preflightCompleted = false;
		const optionalAuth = this.#optionalAuthProviders.has(provider);
		const shouldPreflightAuth = optionalAuth
			? this.authStorage.has(provider) ||
				this.authStorage.hasAuth(provider, undefined, { owner: this.#authStorageConfigOwner })
			: !this.#isCredentiallessProvider(provider);
		let preflightAuthConfigurationGeneration = this.authStorage.getProviderConfigurationGeneration(provider);
		let preflightOAuthRefreshGeneration = this.authStorage.getProviderOAuthRefreshGeneration(provider);
		if (shouldPreflightAuth) {
			if (optionalAuth && isCurrentPreflight()) this.#credentiallessAuthFallbackProviders.delete(provider);
			let apiKey: string | undefined;
			try {
				apiKey = normalizeVllmApiKey(
					provider,
					await this.#peekApiKeyForProvider(provider, {
						ignoreCredentiallessFallback: optionalAuth,
						refreshOAuth: true,
						baseUrl: providerConfig.baseUrl,
					}),
				);
				const currentAuthConfigurationGeneration = this.authStorage.getProviderConfigurationGeneration(provider);
				if (preflightAuthConfigurationGeneration !== currentAuthConfigurationGeneration) {
					const currentOAuthRefreshGeneration = this.authStorage.getProviderOAuthRefreshGeneration(provider);
					if (
						currentOAuthRefreshGeneration === preflightOAuthRefreshGeneration ||
						currentAuthConfigurationGeneration - preflightAuthConfigurationGeneration !==
							currentOAuthRefreshGeneration - preflightOAuthRefreshGeneration
					) {
						preflightStale = true;
					} else {
						preflightAuthConfigurationGeneration = currentAuthConfigurationGeneration;
						preflightOAuthRefreshGeneration = currentOAuthRefreshGeneration;
					}
				}
			} catch (error) {
				preflightFailed = true;
				logger.warn("model discovery credential preflight failed", {
					provider,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			preflightApiKey = apiKey;
			preflightCompleted = true;
			if (!preflightFailed && optionalAuth && isCurrentPreflight()) {
				this.#providerEvidenceApiKeys.set(provider, apiKey);
				const authGeneration = this.authStorage.getProviderEvidenceGeneration(
					provider,
					apiKey,
					this.#authStorageConfigOwner,
				);
				if (apiKey === undefined) this.#credentiallessAuthFallbackProviders.set(provider, authGeneration);
				else this.#credentiallessAuthFallbackProviders.delete(provider);
			}
		}
		const effectiveProviderConfig = this.#effectiveDiscoveryProviderConfig(providerConfig);
		const endpoint = this.#normalizeDiscoveryEvidenceEndpoint(effectiveProviderConfig.baseUrl ?? "");
		const allowsKeylessLocalDiscovery =
			(provider !== "vllm" && provider !== "sglang") ||
			(isAuthenticated(preflightApiKey) && !isVllmNoAuthToken(provider, preflightApiKey)) ||
			effectiveProviderConfig.baseUrl === undefined ||
			resolveLoopbackOpenAIBaseUrl(effectiveProviderConfig.baseUrl, "") === effectiveProviderConfig.baseUrl;
		if (!isCurrentPreflight() || preflightStale) {
			return {
				provider: effectiveProviderConfig.provider,
				current: false,
				models: [],
				authGeneration: this.#getProviderEvidenceGeneration(provider, preflightApiKey),
				configurationGeneration: preflightAuthConfigurationGeneration,
				endpoint,
				fetched: false,
			};
		}
		if (optionalAuth && preflightFailed) {
			return {
				provider: effectiveProviderConfig.provider,
				current: false,
				models: [],
				authGeneration: this.#getProviderEvidenceGeneration(provider, preflightApiKey),
				configurationGeneration: preflightAuthConfigurationGeneration,
				endpoint,
				fetched: false,
			};
		}
		if (!allowsKeylessLocalDiscovery) {
			return {
				provider: effectiveProviderConfig.provider,
				current: true,
				models: [],
				authGeneration: this.#getProviderEvidenceGeneration(provider, preflightApiKey),
				configurationGeneration: preflightAuthConfigurationGeneration,
				endpoint,
				fetched: false,
			};
		}
		const authGenerationBeforeDiscovery = this.#getProviderEvidenceGeneration(provider, preflightApiKey);
		const isCurrentEndpoint = () =>
			endpoint ===
			this.#normalizeDiscoveryEvidenceEndpoint(this.#effectiveDiscoveryProviderConfig(providerConfig).baseUrl ?? "");
		const isCurrentProviderRefresh = () =>
			providerRefresh === undefined ||
			("providerId" in providerRefresh
				? strategy !== "online-if-uncached" ||
					(providerRefresh.providerId === provider &&
						this.#providerRefreshGenerations.get(provider) === providerRefresh.generation)
				: (this.#providerRefreshGenerations.get(provider) ?? 0) ===
					(providerRefresh.generations.get(provider) ?? 0));
		const evidence = this.#configuredDiscoveryEvidence.get(provider);
		const cacheDynamicModelProvenance = fingerprintConfiguredDiscoveryRequestShape(
			effectiveProviderConfig,
			authGenerationBeforeDiscovery,
			endpoint,
		);
		if (cacheDynamicModelProvenance === undefined && strategy === "offline") {
			const previouslyPublishedModelIds = [...(evidence?.modelIds ?? [])];
			this.#configuredDiscoveryEvidence.delete(provider);
			return {
				provider: effectiveProviderConfig.provider,
				current: true,
				models: [],
				authGeneration: authGenerationBeforeDiscovery,
				configurationGeneration: preflightAuthConfigurationGeneration,
				endpoint,
				fetched: false,
				clearPublishedModelIds: previouslyPublishedModelIds,
			};
		}
		const cacheLookupProvenance =
			cacheDynamicModelProvenance ?? `gajae:non-cacheable-configured:${crypto.randomUUID()}`;
		const refreshStrategy =
			strategy === "online-if-uncached" &&
			(cacheDynamicModelProvenance === undefined ||
				(evidence !== undefined &&
					(evidence.authGeneration !== authGenerationBeforeDiscovery || evidence.endpoint !== endpoint)))
				? "online"
				: strategy;
		let discoveryFailureEvidence: unknown;

		const mergeInput = await this.#discoveryManager.discover(effectiveProviderConfig, refreshStrategy, {
			cacheDbPath: this.#cacheDbPath,
			requiresAuth: provider =>
				provider.discovery.type !== "models-dev" && !this.#isCredentiallessProvider(provider.provider),
			peekApiKey: async provider =>
				preflightCompleted
					? preflightApiKey
					: this.#peekApiKeyForProvider(provider.provider, {
							refreshOAuth: true,
							baseUrl: provider.baseUrl,
						}),
			isAuthenticated,
			fetchModels: async (provider, apiKey) => {
				try {
					return this.#sanitizeDiscoverableModelsForCache(
						provider,
						await this.#discoverModelsByProviderType(provider, apiKey),
					);
				} catch (error) {
					discoveryFailureEvidence = error;
					throw error;
				}
			},
			getEvidenceGeneration: provider => this.#getProviderEvidenceGeneration(provider.provider, preflightApiKey),
			cacheDynamicModelProvenance: cacheLookupProvenance,
			canPublishCache: () => isCurrentEndpoint() && isCurrentProviderRefresh(),
		});
		const authGeneration =
			mergeInput.authGeneration ??
			this.#getProviderEvidenceGeneration(effectiveProviderConfig.provider, preflightApiKey);
		const current =
			mergeInput.current &&
			authGeneration === this.#getProviderEvidenceGeneration(effectiveProviderConfig.provider, preflightApiKey) &&
			isCurrentEndpoint();
		if (!current) {
			return {
				provider: effectiveProviderConfig.provider,
				current: false,
				models: [],
				authGeneration,
				configurationGeneration: preflightAuthConfigurationGeneration,
				endpoint,
				fetched: false,
			};
		}
		if (mergeInput.warning) {
			const baseUrl = effectiveProviderConfig.baseUrl ?? "";
			const fields = {
				provider: effectiveProviderConfig.provider,
				url: redactDiscoveryUrl(baseUrl),
				error: mergeInput.warning,
			};
			if (isQuietLocalDiscoveryFailure(baseUrl, mergeInput.warning, discoveryFailureEvidence))
				logger.debug("model discovery failed for provider", fields);
			else logger.warn("model discovery failed for provider", fields);
		}
		this.#providerEvidenceApiKeys.set(effectiveProviderConfig.provider, preflightApiKey);
		return {
			provider: effectiveProviderConfig.provider,
			current: true,
			authGeneration,
			configurationGeneration: preflightAuthConfigurationGeneration,
			endpoint,
			fetched: mergeInput.fetched ?? false,
			models: this.#applyProviderModelOverrides(
				effectiveProviderConfig.provider,
				this.#normalizeDiscoverableModels(
					effectiveProviderConfig,
					this.#applyProviderCompat(effectiveProviderConfig.compat, [...mergeInput.models]),
				),
			),
		};
	}
	#effectiveDiscoveryProviderConfig(providerConfig: DiscoveryProviderConfig): DiscoveryProviderConfig {
		const override = this.#runtimeProviderOverrides.get(providerConfig.provider);
		const baseUrl = this.#getProviderBaseUrlForDiscovery(providerConfig.provider) ?? providerConfig.baseUrl;
		const effectiveBaseUrl =
			providerConfig.discovery.type === "ollama"
				? this.#normalizeOllamaBaseUrl(baseUrl)
				: providerConfig.discovery.type === "llama.cpp"
					? this.#normalizeLlamaCppBaseUrl(baseUrl)
					: this.#normalizeOpenAIModelsListBaseUrl(baseUrl);
		return {
			...providerConfig,
			baseUrl: effectiveBaseUrl,
			headers: mergeCaseInsensitiveHeaders(providerConfig.headers, override?.headers),
			compat: override?.compat ? mergeCompat(providerConfig.compat, override.compat) : providerConfig.compat,
			requestTransform: mergeRequestTransform(providerConfig.requestTransform, override?.requestTransform),
			cacheRetention: override?.cacheRetention ?? providerConfig.cacheRetention,
		};
	}

	#discoverModelsByProviderType(
		providerConfig: DiscoveryProviderConfig,
		apiKey: string | undefined,
	): Promise<Model<Api>[]> {
		switch (providerConfig.discovery.type) {
			case "ollama":
				return this.#discoverOllamaModels(providerConfig, apiKey);
			case "llama.cpp":
				return this.#discoverLlamaCppModels(providerConfig, apiKey);
			case "lm-studio":
			case "omlx":
			case "vllm":
			case "sglang":
			case "openai-models-list":
				return this.#discoverOpenAIModelsList(providerConfig, apiKey);
			case "models-dev":
				return this.#discoverModelsDevProvider(providerConfig);
		}
	}

	async #discoverBuiltInProviderModels(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
		providerRefresh?: ProviderRefreshFence,
	): Promise<Model<Api>[]> {
		// Skip providers already handled by configured discovery (e.g. user-configured ollama with discovery.type)
		const configuredDiscoveryProviders = new Set(this.#discoveryManager.providers.map(p => p.provider));
		// An explicit static vLLM/SGLang provider owns its catalog. Unlike other
		// standard descriptors, vLLM and SGLang also support credentialless
		// implicit discovery, so leaving them eligible here would probe and merge
		// models the user did not request. Explicit discovery remains available
		// through discovery.type.
		if (this.#configuredProviderIds.has("vllm")) configuredDiscoveryProviders.add("vllm");
		if (this.#configuredProviderIds.has("sglang")) configuredDiscoveryProviders.add("sglang");
		const managerOptions = (await this.#collectBuiltInModelManagerOptions(configuredDiscoveryProviders)).filter(
			entry => (providerFilter ? providerFilter.has(entry.options.providerId) : true),
		);
		if (managerOptions.length === 0) {
			return [];
		}
		const discoveries = await Promise.all(
			managerOptions.map(entry => this.#discoverWithModelManager(entry, strategy, providerRefresh)),
		);
		return discoveries.flat();
	}

	async #collectBuiltInModelManagerOptions(
		excludedProviderIds: ReadonlySet<string> = new Set(),
	): Promise<ModelManagerDiscoveryOptions[]> {
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
					const accountId = resolveOAuthAccountIdForAccessToken(
						this.authStorage,
						"openai-codex",
						accessToken,
						this.#authStorageConfigOwner,
					);
					return openaiCodexModelManagerOptions({
						accessToken,
						accountId,
					});
				},
			},
		];
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const standardProviderDescriptors = PROVIDER_DESCRIPTORS.filter(
			descriptor => !disabledProviders.has(descriptor.providerId) && !excludedProviderIds.has(descriptor.providerId),
		);
		const enabledSpecialProviderDescriptors = specialProviderDescriptors.filter(
			descriptor => !disabledProviders.has(descriptor.providerId) && !excludedProviderIds.has(descriptor.providerId),
		);
		for (const descriptor of standardProviderDescriptors) {
			if (!descriptor.allowUnauthenticated) continue;
			this.#keylessProviders.add(descriptor.providerId);
			this.#optionalAuthProviders.add(descriptor.providerId);
		}
		// Use peekApiKey to avoid OAuth token refresh during discovery.
		// The token is only needed if the dynamic fetch fires (cache miss),
		// and failures there are handled gracefully.
		const peekKey = async (descriptor: { providerId: string }) => {
			const configurationGeneration = this.authStorage.getProviderConfigurationGeneration(descriptor.providerId);
			const apiKey = await this.#peekApiKeyForProvider(descriptor.providerId);
			if (configurationGeneration !== this.authStorage.getProviderConfigurationGeneration(descriptor.providerId)) {
				return { apiKey: undefined, authGeneration: undefined };
			}
			return {
				apiKey,
				authGeneration: this.#getProviderEvidenceGeneration(descriptor.providerId, apiKey),
			};
		};
		const [standardProviderCredentials, specialProviderCredentials] = await Promise.all([
			Promise.all(standardProviderDescriptors.map(peekKey)),
			Promise.all(enabledSpecialProviderDescriptors.map(peekKey)),
		]);
		const options: ModelManagerDiscoveryOptions[] = [];
		for (let i = 0; i < standardProviderDescriptors.length; i++) {
			const descriptor = standardProviderDescriptors[i];
			const { apiKey, authGeneration } = standardProviderCredentials[i];
			const requestApiKey = isVllmNoAuthToken(descriptor.providerId, apiKey) ? undefined : apiKey;
			const baseUrl = this.#getProviderBaseUrlForDiscovery(descriptor.providerId);
			const allowsKeylessDiscovery =
				descriptor.allowUnauthenticated &&
				((descriptor.providerId !== "vllm" && descriptor.providerId !== "sglang") ||
					baseUrl === undefined ||
					resolveLoopbackOpenAIBaseUrl(baseUrl, "") === baseUrl);
			if (
				authGeneration !== undefined &&
				authGeneration === this.#getProviderEvidenceGeneration(descriptor.providerId, apiKey) &&
				(isAuthenticated(requestApiKey) || allowsKeylessDiscovery)
			) {
				options.push({
					options: descriptor.createModelManagerOptions({
						apiKey: isAuthenticated(requestApiKey) ? requestApiKey : undefined,
						baseUrl,
					}),
					authGeneration,
					apiKey,
					endpoint: this.#normalizeDiscoveryEvidenceEndpoint(baseUrl ?? ""),
					endpointContainsUserinfo: this.#urlContainsUserinfo(baseUrl ?? ""),
				});
			}
		}

		for (let i = 0; i < enabledSpecialProviderDescriptors.length; i++) {
			const descriptor = enabledSpecialProviderDescriptors[i];
			const { apiKey: apiKeyValue, authGeneration } = specialProviderCredentials[i];
			const key = descriptor.resolveKey(apiKeyValue);
			if (
				authGeneration !== undefined &&
				authGeneration === this.#getProviderEvidenceGeneration(descriptor.providerId, apiKeyValue) &&
				isAuthenticated(key)
			) {
				const managerOptions = descriptor.createOptions(key);
				const baseUrl = this.#getProviderBaseUrlForDiscovery(descriptor.providerId) ?? "";
				options.push({
					options: managerOptions,
					authGeneration,
					apiKey: apiKeyValue,
					endpoint: this.#normalizeDiscoveryEvidenceEndpoint(baseUrl),
					endpointContainsUserinfo: this.#urlContainsUserinfo(baseUrl),
				});
			}
		}
		return options;
	}

	async #discoverWithModelManager(
		{ options, authGeneration, apiKey, endpoint, endpointContainsUserinfo }: ModelManagerDiscoveryOptions,
		strategy: ModelRefreshStrategy,
		providerRefresh?: ProviderRefreshFence,
	): Promise<Model<Api>[]> {
		const generation = (this.#descriptorDiscoveryGenerations.get(options.providerId) ?? 0) + 1;
		this.#descriptorDiscoveryGenerations.set(options.providerId, generation);
		const canUseCredentialDerivedXiaomiEndpoint =
			options.providerId === "xiaomi" &&
			apiKey?.startsWith("tp-") === true &&
			this.#runtimeProviderOverrides.get("xiaomi")?.baseUrl === undefined &&
			this.#providerOverrides.get("xiaomi")?.baseUrl === undefined &&
			resolveProviderBaseUrlFromEnv("xiaomi") === undefined;
		let credentialDerivedEndpoint: string | undefined;
		const reusableCacheProvenance = endpointContainsUserinfo
			? undefined
			: fingerprintDescriptorDiscoveryProvenance(authGeneration, endpoint);
		if (reusableCacheProvenance === undefined && strategy === "offline") return [];
		// Signed/userinfo endpoints may still publish a sanitized best-effort row,
		// but each refresh gets a new opaque nonce. The nonce contains no endpoint
		// secret and can never match a previous invocation, so constructor loads,
		// stale fallback, and online-if-uncached reuse all fail closed.
		const cacheDynamicModelProvenance =
			reusableCacheProvenance ?? `gajae:non-cacheable-endpoint:${crypto.randomUUID()}`;
		const isCurrentDiscoveryContext = () =>
			(this.#descriptorDiscoveryGenerations.get(options.providerId) ?? 0) === generation &&
			this.#getProviderEvidenceGeneration(options.providerId, apiKey) === authGeneration &&
			(endpoint ===
				this.#normalizeDiscoveryEvidenceEndpoint(this.#getProviderBaseUrlForDiscovery(options.providerId) ?? "") ||
				(canUseCredentialDerivedXiaomiEndpoint && credentialDerivedEndpoint !== undefined));
		const isCurrentProviderRefresh = () =>
			providerRefresh === undefined ||
			("providerId" in providerRefresh
				? providerRefresh.providerId === options.providerId &&
					this.#providerRefreshGenerations.get(options.providerId) === providerRefresh.generation
				: (this.#providerRefreshGenerations.get(options.providerId) ?? 0) ===
					(providerRefresh.generations.get(options.providerId) ?? 0));
		const isCurrentDiscovery = () =>
			isCurrentDiscoveryContext() &&
			(providerRefresh === undefined || "generations" in providerRefresh || isCurrentProviderRefresh());
		const canPublishCache = () =>
			isCurrentDiscoveryContext() &&
			(providerRefresh === undefined ||
				("providerId" in providerRefresh
					? strategy !== "online-if-uncached" || isCurrentDiscovery()
					: isCurrentProviderRefresh()));
		try {
			const manager = createModelManager({
				...options,
				cacheDbPath: this.#cacheDbPath,
				cacheDynamicModelProvenance,
				canPublishCache,
				...(options.fetchDynamicModels
					? {
							fetchDynamicModels: async () => {
								const models = await options.fetchDynamicModels?.();
								if (models === null || models === undefined) return null;
								const sanitizedModels = this.#stripModelBaseUrlQueries(models ?? []);
								if (canUseCredentialDerivedXiaomiEndpoint) {
									credentialDerivedEndpoint = sanitizedModels[0]?.baseUrl;
								}
								return sanitizedModels;
							},
						}
					: {}),
				...(options.modelsDev
					? {
							modelsDev: {
								...options.modelsDev,
								map: (payload, providerId) =>
									this.#stripModelBaseUrlQueries(options.modelsDev?.map(payload, providerId) ?? []),
							},
						}
					: {}),
			});
			const evidence = this.#descriptorDiscoveryEvidence.get(options.providerId);
			const refreshStrategy =
				strategy === "online-if-uncached" &&
				(evidence?.authGeneration !== authGeneration || evidence.endpoint !== endpoint)
					? "online"
					: strategy;
			const result = await manager.refresh(refreshStrategy);
			const liveBaseUrl = this.#getProviderBaseUrlForDiscovery(options.providerId);
			const models = result.models.map(model => {
				const baseUrl = this.#restoreLiveDiscoveryBaseUrl(model.baseUrl, liveBaseUrl);
				return {
					...(model.provider === options.providerId ? model : { ...model, provider: options.providerId }),
					...(baseUrl !== model.baseUrl ? { baseUrl } : {}),
				};
			});
			const preservesExistingDescriptorEvidence =
				(result.dynamicModelIds === undefined && !result.fetched && !result.stale) ||
				(result.stale && result.cacheFresh && result.cacheAuthoritative && evidence?.fresh === true) ||
				(strategy === "offline" && result.dynamicModelIds === undefined);
			if (
				isCurrentDiscovery() &&
				!preservesExistingDescriptorEvidence &&
				(result.fetched ||
					result.dynamicModelIds !== undefined ||
					result.stale ||
					this.#descriptorDiscoveryEvidence.get(options.providerId)?.authGeneration !== authGeneration ||
					this.#descriptorDiscoveryEvidence.get(options.providerId)?.endpoint !== endpoint)
			) {
				this.#descriptorDiscoveryEvidence.set(options.providerId, {
					fresh: result.fetched,
					modelIds: new Set(models.map(model => model.id)),
					...(result.dynamicModelIds === undefined
						? {}
						: {
								profileModelIds: new Set(result.dynamicModelIds),
								profileFresh: !result.stale,
								profileEndpoint: endpoint,
							}),
					authGeneration,
					endpoint: this.#normalizeDiscoveryEvidenceEndpoint(models[0]?.baseUrl ?? endpoint),
				});
			}
			if (!isCurrentDiscovery()) {
				return [];
			}
			this.#providerEvidenceApiKeys.set(options.providerId, apiKey);
			if (options.providerId === "opencodex" && !isAuthenticated(apiKey)) {
				this.#credentiallessAuthFallbackProviders.set(options.providerId, authGeneration);
				const evidence = this.#descriptorDiscoveryEvidence.get(options.providerId);
				if (evidence?.authGeneration === authGeneration) {
					this.#descriptorDiscoveryEvidence.set(options.providerId, {
						...evidence,
						authGeneration: this.#getProviderEvidenceGeneration(options.providerId),
					});
				}
			}
			return models;
		} catch (error) {
			if (isCurrentDiscovery()) {
				this.#providerEvidenceApiKeys.set(options.providerId, apiKey);
				this.#descriptorDiscoveryEvidence.set(options.providerId, {
					fresh: false,
					modelIds: new Set(),
					authGeneration,
					endpoint,
				});
			}
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

	async #discoverOllamaModels(
		providerConfig: DiscoveryProviderConfig,
		discoveryApiKey?: string,
	): Promise<Model<Api>[]> {
		const endpoint = this.#normalizeOllamaBaseUrl(providerConfig.baseUrl);
		const tagsUrl = `${endpoint}/api/tags`;
		const headers: Record<string, string> = { ...(providerConfig.headers ?? {}) };
		const apiKey =
			discoveryApiKey ??
			(this.#isCredentiallessProvider(providerConfig.provider)
				? kNoAuth
				: await this.authStorage.getApiKey(providerConfig.provider, undefined, {
						owner: this.#authStorageConfigOwner,
					}));
		if (
			apiKey &&
			apiKey !== DEFAULT_LOCAL_TOKEN &&
			apiKey !== kNoAuth &&
			headerValue(headers, "Authorization") === undefined
		) {
			headers.Authorization = `Bearer ${apiKey}`;
		}
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

	async #discoverLlamaCppModels(
		providerConfig: DiscoveryProviderConfig,
		discoveryApiKey?: string,
	): Promise<Model<Api>[]> {
		const baseUrl = this.#normalizeLlamaCppBaseUrl(providerConfig.baseUrl);
		const modelsUrl = `${baseUrl}/models`;

		const requestHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
		const apiKey =
			discoveryApiKey ??
			(this.#isCredentiallessProvider(providerConfig.provider)
				? kNoAuth
				: await this.authStorage.getApiKey(providerConfig.provider, undefined, {
						owner: this.#authStorageConfigOwner,
					}));
		if (
			apiKey &&
			apiKey !== DEFAULT_LOCAL_TOKEN &&
			apiKey !== kNoAuth &&
			headerValue(requestHeaders, "Authorization") === undefined
		) {
			requestHeaders.Authorization = `Bearer ${apiKey}`;
		}

		const [response, serverMetadata] = await Promise.all([
			fetch(modelsUrl, {
				headers: requestHeaders,
				signal: AbortSignal.timeout(250),
			}),
			this.#discoverLlamaCppServerMetadata(baseUrl, requestHeaders),
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
					headers: providerConfig.headers,
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

	#resolveDiscoveredModelApi(
		providerConfig: DiscoveryProviderConfig,
		modelId: string,
		entry?: { id?: unknown; owned_by?: unknown },
	): Api {
		// 1. Explicit per-prefix routing from models.yml always wins — the user
		//    stated the transport for these ids, so never second-guess it.
		let matchedPrefixLength = -1;
		let prefixApi: Api | undefined;
		for (const [prefix, routedApi] of Object.entries(providerConfig.discovery.apiByModelPrefix ?? {})) {
			if (modelId.startsWith(prefix) && prefix.length > matchedPrefixLength) {
				prefixApi = routedApi;
				matchedPrefixLength = prefix.length;
			}
		}
		if (prefixApi !== undefined) return prefixApi;
		// 2. For OpenAI-compatible gateways that can front both OpenAI and
		//    Anthropic upstreams (e.g. CLIProxyAPI), auto-detect the wire family
		//    per model from the `/v1/models` `owned_by` owner and the model id.
		//    A mixed gateway then routes `claude-*` through Anthropic Messages
		//    with zero manual config. OpenAI-family models keep the provider's
		//    configured OpenAI transport (e.g. `openai-responses` vs
		//    `openai-completions`) rather than being forced to chat-completions,
		//    because a `/v1/models` list cannot reveal which OpenAI API the
		//    gateway expects. Only override to `openai-completions` when the
		//    provider default is not itself an OpenAI-family api.
		if (providerConfig.discovery.type === "openai-models-list") {
			const detected = detectDiscoveredApiFamily(entry ?? { id: modelId });
			if (detected === "anthropic-messages") return "anthropic-messages";
			if (detected === "openai-completions") {
				return isOpenAIFamilyApi(providerConfig.api) ? providerConfig.api : "openai-completions";
			}
		}
		// 3. Fall back to the provider-level default api.
		return providerConfig.api;
	}

	async #discoverModelsDevProvider(providerConfig: DiscoveryProviderConfig): Promise<Model<Api>[]> {
		const baseUrl = providerConfig.baseUrl;
		if (!baseUrl) throw new Error(`Provider "${providerConfig.provider}" requires baseUrl for models.dev discovery.`);
		const payload: unknown = await fetchModelsDevPayload();
		if (!isRecord(payload)) return [];
		const catalogProvider = payload[providerConfig.discovery.modelsDevProvider ?? providerConfig.provider];
		if (!isRecord(catalogProvider) || !isRecord(catalogProvider.models)) return [];

		const discovered: Model<Api>[] = [];
		for (const [catalogId, value] of Object.entries(catalogProvider.models)) {
			if (!isRecord(value) || value.tool_call !== true || value.status === "deprecated") continue;
			const id = typeof value.id === "string" && value.id.trim() ? value.id : catalogId;
			const limit = isRecord(value.limit) ? value.limit : {};
			const cost = isRecord(value.cost) ? value.cost : {};
			const modalities = isRecord(value.modalities) ? value.modalities : {};
			const inputModalities = Array.isArray(modalities.input) ? modalities.input : [];
			const outputModalities = Array.isArray(modalities.output) ? modalities.output : [];
			discovered.push(
				enrichModelThinking({
					id,
					name: typeof value.name === "string" && value.name.trim() ? value.name : id,
					api: this.#resolveDiscoveredModelApi(providerConfig, id),
					provider: providerConfig.provider,
					baseUrl,
					reasoning: value.reasoning === true,
					input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
					output: outputModalities.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: toPositiveNumberOrUndefined(cost.input) ?? 0,
						output: toPositiveNumberOrUndefined(cost.output) ?? 0,
						cacheRead: toPositiveNumberOrUndefined(cost.cache_read) ?? 0,
						cacheWrite: toPositiveNumberOrUndefined(cost.cache_write) ?? 0,
					},
					contextWindow: toPositiveNumberOrUndefined(limit.context) ?? UNK_CONTEXT_WINDOW,
					maxTokens: toPositiveNumberOrUndefined(limit.output) ?? UNK_MAX_TOKENS,
					headers: providerConfig.headers,
					compat: providerConfig.compat,
				}),
			);
		}
		return this.#applyProviderModelOverrides(providerConfig.provider, discovered);
	}

	async #discoverOpenAIModelsList(
		providerConfig: DiscoveryProviderConfig,
		discoveryApiKey?: string,
	): Promise<Model<Api>[]> {
		const baseUrl = this.#normalizeOpenAIModelsListBaseUrl(providerConfig.baseUrl);
		const modelsUrl = new URL(baseUrl);
		const requestBaseUrl = baseUrl;
		modelsUrl.pathname = `${modelsUrl.pathname.replace(/\/+$/g, "")}/models`;

		const requestHeaders: Record<string, string> = { ...(providerConfig.headers ?? {}) };
		// Resolve with the same baseUrl context completion requests use so an
		// endpoint-scoped (or config-pinned) credential wins here exactly as it
		// does for chat completions.
		const apiKey =
			discoveryApiKey ??
			(this.#isCredentiallessProvider(providerConfig.provider)
				? kNoAuth
				: await this.authStorage.getApiKey(providerConfig.provider, undefined, {
						baseUrl,
						owner: this.#authStorageConfigOwner,
					}));
		if (
			apiKey &&
			apiKey !== DEFAULT_LOCAL_TOKEN &&
			!isVllmNoAuthToken(providerConfig.provider, apiKey) &&
			apiKey !== kNoAuth &&
			headerValue(requestHeaders, "Authorization") === undefined
		) {
			requestHeaders.Authorization = `Bearer ${apiKey}`;
		}

		const hardenedLocalDiscovery =
			(providerConfig.discovery.type === "vllm" || providerConfig.discovery.type === "sglang") &&
			resolveLoopbackOpenAIBaseUrl(baseUrl, "") === baseUrl;
		const response = await fetch(modelsUrl, {
			headers: requestHeaders,
			...(providerConfig.discovery.type === "vllm" || providerConfig.discovery.type === "sglang"
				? { redirect: "error" as const }
				: {}),
			signal: AbortSignal.timeout(hardenedLocalDiscovery ? 500 : 5_000),
		});
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				// Redacted by construction: name the provider, endpoint, and the
				// config surface to fix — never the resolved key.
				throw new Error(
					`HTTP ${response.status} from ${redactDiscoveryUrl(modelsUrl)}: provider "${providerConfig.provider}" credential was rejected for OpenAI models-list discovery; check providers.${providerConfig.provider}.apiKey/apiKeyEnv.`,
				);
			}
			throw new Error(`HTTP ${response.status} from ${redactDiscoveryUrl(modelsUrl)}`);
		}
		const payload: unknown = await response.json();
		if (!isRecord(payload) || !Array.isArray(payload.data)) {
			throw new Error(`Malformed OpenAI models-list response from ${redactDiscoveryUrl(modelsUrl)}`);
		}
		const models = payload.data;
		const discovered: Model<Api>[] = [];
		for (const item of models) {
			if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
			const id = item.id;
			const referenceModel = resolveCustomModelReference(id);
			const discoveredMaxTokens = firstPositiveDiscoveryNumber(
				item.max_completion_tokens,
				item.max_tokens,
				item.max_output_tokens,
			);
			const api = this.#resolveDiscoveredModelApi(providerConfig, id, item);
			discovered.push(
				enrichModelThinking({
					id,
					name: typeof item.name === "string" ? item.name : (referenceModel?.name ?? id),
					api,
					provider: providerConfig.provider,
					baseUrl: requestBaseUrl,
					reasoning: providerConfig.provider === "omlx" ? true : (referenceModel?.reasoning ?? false),
					thinking: referenceModel?.thinking,
					input: referenceModel?.input ?? ["text"],
					output: referenceModel?.output,
					cost: referenceModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow:
						firstPositiveDiscoveryNumber(
							item.max_model_len,
							item.context_length,
							item.context_window,
							item.max_context_length,
							referenceModel?.contextWindow,
							UNK_CONTEXT_WINDOW,
						) ?? UNK_CONTEXT_WINDOW,
					maxTokens: discoveredMaxTokens ?? referenceModel?.maxTokens ?? UNK_MAX_TOKENS,
					maxTokensSource: discoveredMaxTokens === undefined ? referenceModel?.maxTokensSource : "discovered",
					headers: providerConfig.headers,
					compat: mergeCompat(
						{
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: providerConfig.provider === "omlx",
							...(providerConfig.provider === "omlx"
								? {
										thinkingFormat: "qwen-chat-template" as const,
										reasoningContentField: "reasoning_content" as const,
									}
								: {}),
						},
						mergeProviderCompat(providerConfig.compat, referenceModel?.compat),
					),
					...(providerConfig.provider === "omlx"
						? {
								reasoning: true,
								thinking: {
									mode: "effort" as const,
									minLevel: Effort.Low,
									maxLevel: Effort.High,
									defaultLevel: Effort.Medium,
								},
							}
						: {}),
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
	#normalizeDiscoveryEvidenceEndpoint(endpoint: string): string {
		try {
			const parsed = new URL(endpoint);
			const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
			return `${parsed.protocol}//${parsed.host}${trimmedPath}${parsed.search}`;
		} catch {
			return endpoint.replace(/\/+$/g, "");
		}
	}
	#urlContainsUserinfo(endpoint: string): boolean {
		try {
			const parsed = new URL(endpoint);
			return Boolean(parsed.username || parsed.password);
		} catch {
			return false;
		}
	}
	#isCredentiallessProvider(provider: string): boolean {
		let fallbackMatchesCurrentEvidence = false;
		const fallbackEvidenceGeneration = this.#credentiallessAuthFallbackProviders.get(provider);
		if (fallbackEvidenceGeneration !== undefined) {
			try {
				fallbackMatchesCurrentEvidence =
					fallbackEvidenceGeneration ===
					this.authStorage.getProviderEvidenceGeneration(
						provider,
						this.#providerEvidenceApiKeys.get(provider),
						this.#authStorageConfigOwner,
					);
			} catch {
				// AuthStorage may be unavailable while a registry is being torn down.
			}
		}
		return (
			this.#keylessProviders.has(provider) &&
			(!this.#optionalAuthProviders.has(provider) ||
				(!this.authStorage.hasAuth(provider, undefined, { owner: this.#authStorageConfigOwner }) &&
					!this.authStorage.has(provider)) ||
				fallbackMatchesCurrentEvidence)
		);
	}
	#getProviderEvidenceGeneration(provider: string, resolvedApiKey?: string): string {
		if (this.#isCredentiallessProvider(provider)) {
			return `credentialless:${provider}`;
		}
		return this.authStorage.getProviderEvidenceGeneration(
			provider,
			resolvedApiKey ?? this.#providerEvidenceApiKeys.get(provider),
			this.#authStorageConfigOwner,
		);
	}
	#normalizeOpenAIModelsListBaseUrl(baseUrl?: string): string {
		const defaultBaseUrl = "http://127.0.0.1:1234/v1";
		const raw = baseUrl || defaultBaseUrl;
		try {
			const parsed = new URL(raw);
			const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
			parsed.pathname = trimmedPath.endsWith("/v1") ? trimmedPath || "/v1" : `${trimmedPath}/v1`;
			parsed.hash = "";
			return parsed.toString().replace(/\/$/, "");
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
		const overrides = this.#modelOverrides.get(provider.toLowerCase());
		if (!overrides || overrides.size === 0) return models;
		return models.map(model => {
			const override = overrides.get(model.id.toLowerCase());
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}

	#resolveProviderOverride(
		provider: string,
		overrides: ReadonlyMap<string, ProviderOverride> = this.#providerOverrides,
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
			this.#runtimeProviderOverrides.get(provider)?.baseUrl ??
			this.#providerOverrides.get(provider)?.baseUrl ??
			resolveProviderBaseUrlFromEnv(provider) ??
			this.getProviderBaseUrl(provider)
		);
	}

	#mergeProviderOverride(baseOverride: ProviderOverride | undefined, override: ProviderOverride): ProviderOverride {
		return {
			api: override.api ?? baseOverride?.api,
			baseUrl: override.baseUrl ?? baseOverride?.baseUrl,
			apiKey: override.apiKey ?? baseOverride?.apiKey,
			authHeader: override.authHeader ?? baseOverride?.authHeader,
			headers: mergeCaseInsensitiveHeaders(baseOverride?.headers, override.headers),
			compat: override.compat ? mergeCompat(baseOverride?.compat, override.compat) : baseOverride?.compat,
			transport: override.transport ?? baseOverride?.transport,
			requestTransform: mergeRequestTransform(baseOverride?.requestTransform, override.requestTransform),
			cacheRetention: override.cacheRetention ?? baseOverride?.cacheRetention,
			isOAuth: override.isOAuth ?? baseOverride?.isOAuth,
		};
	}
	#applyProviderTransportOverride<T extends Model<Api>>(
		entry: T,
		override: Pick<
			ProviderOverride,
			| "baseUrl"
			| "headers"
			| "authHeader"
			| "apiKey"
			| "compat"
			| "transport"
			| "requestTransform"
			| "cacheRetention"
		>,
	): T {
		const overrideHeaders = (
			override.headers ? { ...entry.headers, ...override.headers } : { ...entry.headers }
		) as Record<string, string> & { [GENERATED_AUTH_HEADER]?: string };
		const explicitAuthKey = override.headers
			? Object.keys(override.headers).find(key => key.toLowerCase() === "authorization")
			: undefined;
		if (explicitAuthKey !== undefined) {
			const explicitAuthValue = override.headers![explicitAuthKey]!;
			deleteHeaderCaseInsensitive(overrideHeaders, "Authorization");
			overrideHeaders[explicitAuthKey] = explicitAuthValue;
			delete (overrideHeaders as Record<string, string> & { [GENERATED_AUTH_HEADER]?: string })[
				GENERATED_AUTH_HEADER
			];
		}
		const existingMarker = (overrideHeaders as Record<string, string> & { [GENERATED_AUTH_HEADER]?: string })[
			GENERATED_AUTH_HEADER
		];
		const managesAuth = override.authHeader !== undefined || override.apiKey !== undefined;
		const canInject =
			managesAuth &&
			override.authHeader === true &&
			Boolean(override.apiKey) &&
			(headerValue(overrideHeaders, "Authorization") === undefined ||
				ownsOnlyGeneratedAuthorization(overrideHeaders, existingMarker));
		if (canInject) {
			deleteHeaderCaseInsensitive(overrideHeaders, "Authorization");
			delete overrideHeaders[GENERATED_AUTH_HEADER];
		} else if (managesAuth && existingMarker !== undefined) {
			deleteAuthorizationValue(overrideHeaders, existingMarker);
			delete overrideHeaders[GENERATED_AUTH_HEADER];
		}
		const headers = mergeAuthHeader(overrideHeaders, canInject, canInject ? override.apiKey : undefined);
		const result = {
			...entry,
			compat: mergeProviderCompat(entry.compat, override.compat),
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
		if (!canInject && explicitAuthKey !== undefined) {
			delete (result.headers as Record<string, string> & { [GENERATED_AUTH_HEADER]?: string })[
				GENERATED_AUTH_HEADER
			];
		}
		const generatedHeader = (
			result.headers as (Record<string, string> & { [GENERATED_AUTH_HEADER]?: string }) | undefined
		)?.[GENERATED_AUTH_HEADER];
		if (generatedHeader !== undefined && result.headers?.Authorization === generatedHeader) {
			this.#generatedAuthHeaders.set(result, { authorization: result.headers.Authorization });
		} else if (explicitAuthKey === undefined) {
			const generated = this.#generatedAuthHeaders.get(entry);
			if (generated) this.#generatedAuthHeaders.set(result, generated);
		}
		return result;
	}
	#applyRuntimeProviderOverride(model: Model<Api>, override: ProviderOverride): Model<Api> {
		const withTransportOverride = this.#applyProviderTransportOverride(
			this.#restoreDeclaredThinking(model),
			override,
		);
		const sanitizedBaseUrl = this.#stripUrlUserinfo(withTransportOverride.baseUrl);
		const sanitizedTransport: Model<Api> =
			sanitizedBaseUrl === withTransportOverride.baseUrl
				? withTransportOverride
				: { ...withTransportOverride, ...(sanitizedBaseUrl === undefined ? {} : { baseUrl: sanitizedBaseUrl }) };
		const modelCompat = this.#modelOverrides.get(model.provider.toLowerCase())?.get(model.id.toLowerCase())?.compat;
		const result = enrichModelThinking(
			modelCompat
				? { ...sanitizedTransport, compat: mergeCompat(sanitizedTransport.compat, modelCompat) }
				: sanitizedTransport,
		);
		const generated = this.#generatedAuthHeaders.get(sanitizedTransport);
		if (generated) this.#generatedAuthHeaders.set(result, generated);
		return result;
	}
	#applyRuntimeProviderOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeProviderOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#runtimeProviderOverrides.get(model.provider);
			if (!override) return model;
			const runtimeCredentialRevoked =
				this.#runtimeProviderApiKeys.has(model.provider) &&
				!this.#runtimeProviderCredentialInstalled.has(model.provider);
			return this.#applyRuntimeProviderOverride(
				model,
				runtimeCredentialRevoked ? { ...override, apiKey: undefined, authHeader: undefined } : override,
			);
		});
	}
	#finalizeModels(models: Model<Api>[]): Model<Api>[] {
		const finalized = models.map(model => enrichModelThinking({ ...this.#restoreDeclaredThinking(model) }));
		const result = applyFinalCodexGpt56ContextCap(finalized, undefined, this.#codexContextWindowOverrides);
		for (let index = 0; index < result.length; index++) {
			if (
				(result[index]?.headers as (Record<string, string> & { [GENERATED_AUTH_HEADER]?: string }) | undefined)?.[
					GENERATED_AUTH_HEADER
				]
			) {
				const authorization = result[index]?.headers?.Authorization;
				const marker = (result[index]?.headers as Record<string, string> & { [GENERATED_AUTH_HEADER]?: string })[
					GENERATED_AUTH_HEADER
				];
				if (authorization && marker === authorization)
					this.#generatedAuthHeaders.set(result[index]!, { authorization });
				else
					delete (result[index]?.headers as Record<string, string> & { [GENERATED_AUTH_HEADER]?: string })[
						GENERATED_AUTH_HEADER
					];
			}
			const generated = this.#generatedAuthHeaders.get(models[index]!);
			if (generated) this.#generatedAuthHeaders.set(result[index]!, generated);
		}
		return result;
	}
	#restoreDeclaredThinking(model: Model<Api>): Model<Api> {
		const overrideThinking = this.#modelOverrides
			.get(model.provider.toLowerCase())
			?.get(model.id.toLowerCase())?.thinking;
		if (overrideThinking !== undefined) return { ...model, thinking: overrideThinking as ThinkingConfig };
		const overlay = [...this.#runtimeModelOverlays, ...this.#customModelOverlays].find(
			candidate =>
				candidate.provider === model.provider && candidate.id === model.id && candidate.thinking !== undefined,
		);
		return overlay?.thinking === undefined ? model : { ...model, thinking: overlay.thinking };
	}
	/**
	 * Collects explicit user `contextWindow` overrides keyed by provider + model
	 * id (`codexContextOverrideKey`), and surfaces diagnostics when one applies
	 * to a Codex GPT-5.6 tier
	 * model. The map is computed once per config load and feeds the final
	 * context cap so an explicit override is never silently re-clamped.
	 */
	#collectCodexContextWindowOverrides(): Map<string, number> {
		const result = new Map<string, number>();
		for (const [provider, providerOverrides] of this.#modelOverrides) {
			for (const [modelId, override] of providerOverrides) {
				if (override.contextWindow === undefined) {
					continue;
				}
				const normalizedId = modelId.toLowerCase();
				const value = toPositiveNumberOrUndefined(override.contextWindow);
				if (value === undefined) {
					if (isCodexGpt56Tier({ id: normalizedId })) {
						logger.warn("codex gpt-5.6 context-window override ignored: value must be a positive finite number", {
							model: modelId,
							provider,
							override: override.contextWindow,
						});
					}
					continue;
				}
				result.set(codexContextOverrideKey(provider, modelId), value);
				if (!isCodexGpt56Tier({ id: normalizedId })) {
					continue;
				}
				logger.warn("codex gpt-5.6 context-window override active; verify it against the live product limit", {
					model: modelId,
					provider,
					override: override.contextWindow,
					enforced: CODEX_GPT_5_6_CONTEXT_CAP.enforced,
				});
			}
		}
		return result;
	}
	#applyModelOverrides(models: Model<Api>[], overrides: Map<string, Map<string, ModelOverride>>): Model<Api>[] {
		if (overrides.size === 0) return models;
		return models.map(model => {
			const providerOverrides = overrides.get(model.provider.toLowerCase());
			if (!providerOverrides) return model;
			const override = providerOverrides.get(model.id.toLowerCase());
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}
	#applyHardcodedModelPolicies(models: Model<Api>[]): Model<Api>[] {
		return models.map(model => {
			// `github-copilot` and `jetbrains-junie` both serve GPT-5.4 through their own
			// gateway, which enforces a smaller prompt budget than the first-party 1M
			// figure (Junie's is a probed 922K). Their bundled values are measured.
			if (model.id !== "gpt-5.4" || model.provider === "github-copilot" || model.provider === "jetbrains-junie") {
				return model;
			}
			const overrides = this.#modelOverrides.get(model.provider.toLowerCase())?.get(model.id.toLowerCase());
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
		this.#notifyCatalogChanged();
		this.#rebuildPending = false;
	}

	#invalidateAvailableModels(): void {
		this.#availableModelsCache = undefined;
		this.#availableModelsDisabledProviders = undefined;
		this.#availableModelsEnvFingerprint = undefined;
	}

	#notifyCatalogChanged(): void {
		for (const listener of [...this.#catalogChangeListeners]) {
			try {
				listener();
			} catch (error) {
				logger.debug("ModelRegistry catalog listener failed", { error: String(error) });
			}
		}
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
			this.#notifyCatalogChanged();
		}
	}

	#parseModels(config: ModelsConfig): CustomModelOverlay[] {
		const models: CustomModelOverlay[] = [];

		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models
			if (providerConfig.apiKey || providerConfig.apiKeyEnv) {
				const resolved = providerConfig.apiKey
					? resolveApiKeyConfig(providerConfig.apiKey)
					: providerConfig.apiKeyEnv
						? resolveApiKeyEnvConfig(providerConfig.apiKeyEnv)
						: undefined;
				if (resolved) this.#customProviderApiKeys.set(providerName, resolved);
				if (resolved) {
					this.authStorage.setConfigApiKey(providerName, resolved, {
						envSourced: !providerConfig.apiKey,
						owner: this.#authStorageConfigOwner,
					});
				}
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
					providerConfig.apiKey
						? resolveApiKeyConfig(providerConfig.apiKey)
						: providerConfig.apiKeyEnv
							? resolveApiKeyEnvConfig(providerConfig.apiKeyEnv)
							: undefined,
					providerConfig.authHeader,
					providerCompat,
					providerConfig.requestTransform,
					(providerConfig.auth as ProviderAuthMode | undefined) ?? undefined,
					providerConfig.cacheRetention,
					providerConfig.transport,
					modelDef as CustomModelDefinitionLike,
				);
				if (!model) continue;
				models.push(model);
			}
		}
		return models;
	}

	/**
	 * Get all models (embedded + accepted registry + custom).
	 * If models.yml had errors, returns embedded plus accepted registry models.
	 */
	getAll(): Model<Api>[] {
		return this.#models;
	}

	/** Provider ids declared in models.yml, including override-only providers. */
	getConfiguredProviderIds(): readonly string[] {
		return [...this.#configuredProviderIds];
	}

	#isModelAvailable(model: Model<Api>, disabledProviders?: ReadonlySet<string>): boolean {
		const disabled = disabledProviders ?? getDisabledProviderIdsFromSettings(this.#settings);
		return (
			!disabled.has(model.provider) &&
			(this.#keylessProviders.has(model.provider) ||
				this.authStorage.hasAuth(model.provider, undefined, { owner: this.#authStorageConfigOwner }))
		);
	}
	/** Per-query precomputed variant filter inputs; plan fields are authoritative when provided. */
	#buildCanonicalVariantFilterPlan(options: CanonicalModelQueryOptions | undefined): {
		candidateKeys: Set<string> | undefined;
		disabledProviders: ReadonlySet<string> | undefined;
	} {
		return {
			candidateKeys: options?.candidates
				? new Set(options.candidates.map(candidate => formatCanonicalVariantSelector(candidate)))
				: undefined,
			disabledProviders: options?.availableOnly ? getDisabledProviderIdsFromSettings(this.#settings) : undefined,
		};
	}

	#filterCanonicalVariants(
		record: CanonicalModelRecord,
		options: CanonicalModelQueryOptions | undefined,
		plan?: { candidateKeys: Set<string> | undefined; disabledProviders: ReadonlySet<string> | undefined },
	): CanonicalModelVariant[] {
		const candidateKeys =
			plan !== undefined
				? plan.candidateKeys
				: options?.candidates
					? new Set(options.candidates.map(candidate => formatCanonicalVariantSelector(candidate)))
					: undefined;
		const disabledProviders =
			plan !== undefined
				? plan.disabledProviders
				: options?.availableOnly
					? getDisabledProviderIdsFromSettings(this.#settings)
					: undefined;
		return record.variants.filter(variant => {
			if (candidateKeys && !candidateKeys.has(variant.selector)) return false;
			if (options?.availableOnly && !this.#isModelAvailable(variant.model, disabledProviders)) return false;
			return true;
		});
	}

	/**
	 * Effective credential provenance for a provider, derived from existing
	 * AuthStorage/session credential surfaces — never from token shape.
	 *
	 * Precedence mirrors actual credential selection (`getApiKey`):
	 * 1. Runtime/config API-key overrides (the actual credential resolver's
	 *    highest-priority surfaces)
	 * 2. Session-recorded stored credential type
	 * 3. Stored/custom API-key surfaces
	 * 4. OAuth, only when it is the effective remaining stored credential
	 * 5. Keyless providers
	 * 6. Unknown (no credential surface)
	 */
	#effectiveProviderAuth(provider: string, sessionId?: string): EffectiveProviderAuth {
		const credentialType = this.authStorage.getEffectiveCredentialType(provider, sessionId, {
			owner: this.#authStorageConfigOwner,
		});
		if (credentialType === "api_key") return "key";
		if (credentialType === "oauth") return "oauth";
		if (this.#keylessProviders.has(provider)) return "keyless";
		return "unknown";
	}

	/**
	 * Build the pure provider selection policy from the registry catalog order,
	 * configured `modelProviderOrder`, and effective credential provenance for
	 * the given session. Caller candidate order never influences the resulting
	 * ranks or tie data; session provenance can (a session that authenticated
	 * with an API key moves a mixed-credential provider out of the OAuth band).
	 */
	#buildProviderSelectionPolicy(sessionId?: string): ProviderSelectionPolicy {
		const { catalogProviders, catalogModels } = buildProviderSelectionCatalog(this.#models);
		const effectiveAuth = new Map<string, EffectiveProviderAuth>();
		for (const model of this.#models) {
			const providerKey = model.provider.trim().toLowerCase();
			if (!providerKey || effectiveAuth.has(providerKey)) {
				continue;
			}
			effectiveAuth.set(providerKey, this.#effectiveProviderAuth(model.provider, sessionId));
		}
		return createProviderSelectionPolicy({
			explicitProviderOrder: getConfiguredProviderOrderFromSettings(this.#settings),
			effectiveAuth,
			catalogProviders,
			catalogModels,
		});
	}

	/**
	 * Deterministic provider priority for autorouting tier generation: configured
	 * `modelProviderOrder` first, then first-wins catalog order.
	 *
	 * Deliberately takes no session and never touches `authStorage`. It bypasses
	 * `#buildProviderSelectionPolicy` entirely so no `effectiveAuth` map is even
	 * assembled — auth-independence is structural here, not a convention. Ranking
	 * that *is* auth-aware stays private to the policy.
	 *
	 * Providers absent from the catalog are dropped so a dead declaration cannot
	 * pollute the generated setup's `declarationFingerprint`. Returned ids use the
	 * catalog's original spelling because the generator matches provider prefixes
	 * with case-sensitive exact strings.
	 */
	autoroutingProviderOrder(): readonly string[] {
		return projectCatalogProviderOrder(getConfiguredProviderOrderFromSettings(), this.#models);
	}

	/**
	 * Provider priority for automatic model selection. Explicit provider order
	 * wins first, followed by omitted OAuth providers, then other providers;
	 * catalog order breaks ties within each policy band.
	 */
	automaticProviderOrder(sessionId?: string): readonly string[] {
		const policy = this.#buildProviderSelectionPolicy(sessionId);
		return [...policy.orderedProviders()].sort((left, right) => {
			const rankDifference = policy.rank(left) - policy.rank(right);
			return rankDifference !== 0
				? rankDifference
				: policy.providerCatalogIndex(left) - policy.providerCatalogIndex(right);
		});
	}

	#providerRankMap(policy: ProviderSelectionPolicy): Map<string, number> {
		const providerRank = new Map<string, number>();
		for (const provider of policy.orderedProviders()) {
			if (!providerRank.has(provider)) {
				providerRank.set(provider, policy.rank(provider));
			}
		}
		return providerRank;
	}

	/** Stable model order from the registry catalog (never caller candidate order). */
	#catalogModelOrder(): Map<string, number> {
		const modelOrder = new Map<string, number>();
		for (let index = 0; index < this.#models.length; index += 1) {
			const selector = formatCanonicalVariantSelector(this.#models[index]!);
			if (!modelOrder.has(selector)) {
				modelOrder.set(selector, index);
			}
		}
		return modelOrder;
	}

	#rememberCanonicalVariant(sessionId: string, selector: string): void {
		const normalizedSessionId = sessionId.trim();
		if (!normalizedSessionId) return;
		this.#sessionCanonicalVariants.delete(normalizedSessionId);
		this.#sessionCanonicalVariants.set(normalizedSessionId, selector);
		if (this.#sessionCanonicalVariants.size > MAX_SESSION_CANONICAL_VARIANTS) {
			this.#sessionCanonicalVariants.delete(this.#sessionCanonicalVariants.keys().next().value!);
		}
	}

	/**
	 * Resolve the winning variant among equivalent candidates. Session stickiness
	 * wins when the remembered selector is still eligible; otherwise the variant
	 * is ranked with provider-rank-first axis order when `providerRankFirst` is
	 * set (alias resolution), or the legacy vision-first order by default
	 * (canonical resolution). `exactnessKey` (the alias lookup key) replaces the
	 * canonical-id exactness axis so `model.id === alias` beats slash-prefixed
	 * ids before source/cost/catalog ties. Provider/model tie data always comes
	 * from the registry catalog.
	 */
	#resolveCanonicalVariant(
		variants: readonly CanonicalModelVariant[],
		sessionId?: string,
		options: {
			providerRankFirst?: boolean;
			exactnessKey?: string;
			credentialSessionId?: string;
			providerRank?: Map<string, number>;
			modelOrder?: Map<string, number>;
		} = {},
	): CanonicalModelVariant | undefined {
		if (variants.length === 0) return undefined;
		const normalizedSessionId = sessionId?.trim();
		const stickySelector = normalizedSessionId ? this.#sessionCanonicalVariants.get(normalizedSessionId) : undefined;
		const stickyVariant = stickySelector
			? variants.find(variant => variant.selector.toLowerCase() === stickySelector.toLowerCase())
			: undefined;
		if (stickyVariant) {
			this.#rememberCanonicalVariant(normalizedSessionId!, stickyVariant.selector);
			return stickyVariant;
		}
		if (normalizedSessionId && stickySelector) this.#sessionCanonicalVariants.delete(normalizedSessionId);
		const providerRank =
			options.providerRank ??
			this.#providerRankMap(this.#buildProviderSelectionPolicy(options.credentialSessionId ?? normalizedSessionId));
		const modelOrder = options.modelOrder ?? this.#catalogModelOrder();
		const sourceRank: Record<CanonicalModelVariant["source"], number> = {
			override: 1,
			bundled: 1,
			heuristic: 2,
			fallback: 3,
		};
		return [...variants].sort((left, right) =>
			compareEquivalentModelVariants(left.model, right.model, {
				providerRankFirst: options.providerRankFirst,
				providerRank,
				canonicalId:
					options.exactnessKey ?? (left.canonicalId === right.canonicalId ? left.canonicalId : undefined),
				leftSourceRank: sourceRank[left.source],
				rightSourceRank: sourceRank[right.source],
				includeCost: true,
				modelOrder,
			}),
		)[0];
	}

	getCanonicalModels(options?: CanonicalModelQueryOptions): CanonicalModelRecord[] {
		const filterPlan = this.#buildCanonicalVariantFilterPlan(options);
		const records: CanonicalModelRecord[] = [];
		for (const record of this.#canonicalIndex.records) {
			const variants = this.#filterCanonicalVariants(record, options, filterPlan);
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

	/**
	 * Batch form of {@link resolveCanonicalModel} over every canonical record:
	 * one candidate-key set, one provider policy, and one catalog order for the
	 * whole query instead of per record. `model` is `undefined` only when a
	 * record has surviving variants but none can win resolution.
	 */
	getCanonicalModelSelections(options?: CanonicalModelQueryOptions): CanonicalModelSelection[] {
		const filterPlan = this.#buildCanonicalVariantFilterPlan(options);
		const providerRank = this.#providerRankMap(
			this.#buildProviderSelectionPolicy(options?.credentialSessionId ?? options?.sessionId?.trim()),
		);
		const modelOrder = this.#catalogModelOrder();
		const selections: CanonicalModelSelection[] = [];
		for (const record of this.#canonicalIndex.records) {
			const variants = this.#filterCanonicalVariants(record, options, filterPlan);
			if (variants.length === 0) {
				continue;
			}
			const resolved = this.#resolveCanonicalVariant(variants, options?.sessionId, {
				providerRankFirst: true,
				credentialSessionId: options?.credentialSessionId,
				providerRank,
				modelOrder,
			});
			if (resolved && options?.sessionId) this.#rememberCanonicalVariant(options.sessionId, resolved.selector);
			selections.push({ record: { id: record.id, name: record.name, variants }, model: resolved?.model });
		}
		return selections;
	}

	getCanonicalVariants(canonicalId: string, options?: CanonicalModelQueryOptions): CanonicalModelVariant[] {
		const record = this.#canonicalIndex.byId.get(canonicalId.trim().toLowerCase());
		if (!record) {
			return [];
		}
		return this.#filterCanonicalVariants(record, options);
	}

	/**
	 * Resolve an exact canonical id to a concrete model.
	 *
	 * Canonical ids remain exact lookup keys, but their provider variant uses the
	 * same provider-rank-first policy as preset aliases. Availability filtering
	 * remains opt-in through `availableOnly`; final-segment aliases never fall
	 * back implicitly — use {@link resolveModelByLookupAlias} for alias intent.
	 */
	resolveCanonicalModel(canonicalId: string, options?: CanonicalModelQueryOptions): Model<Api> | undefined {
		const variants = this.getCanonicalVariants(canonicalId, options);
		if (variants.length === 0) return undefined;
		const resolved = this.#resolveCanonicalVariant(variants, options?.sessionId, {
			providerRankFirst: true,
			credentialSessionId: options?.credentialSessionId,
		});
		if (resolved && options?.sessionId) this.#rememberCanonicalVariant(options.sessionId, resolved.selector);
		return resolved?.model;
	}

	/**
	 * Resolve a final-slash-segment alias to a concrete model, explicitly.
	 *
	 * The alias gathers every matching variant selector from the variant-level
	 * alias index — never sibling variants in the same canonical record that end
	 * in a different segment — then ranks all eligible variants together by the
	 * centralized provider policy (provider-rank-first axis order), with the
	 * canonical/exactness axis preserved relative to the alias lookup key
	 * (`model.id === alias` beats slash-prefixed ids before source/cost/catalog
	 * ties). Fails closed: availability/disabled filtering applies even to
	 * supplied candidate arrays, alias variants are intersected with the
	 * filtered candidate selectors before ranking, and zero eligible candidates
	 * returns an authoritative `undefined` without rewriting the variant's
	 * model/wire ids. Winners stay sticky per session.
	 */
	resolveModelByLookupAlias(alias: string, options?: CanonicalModelQueryOptions): Model<Api> | undefined {
		const normalizedAlias = alias.trim().toLowerCase();
		const aliasSelectors = this.#canonicalIndex.aliases.get(normalizedAlias);
		if (!aliasSelectors || aliasSelectors.length === 0) return undefined;

		const candidateKeys = options?.candidates
			? new Set(
					options.candidates
						.filter(candidate => this.#isModelAvailable(candidate))
						.map(candidate => formatCanonicalVariantSelector(candidate)),
				)
			: undefined;
		const eligible: CanonicalModelVariant[] = [];
		for (const aliasSelector of aliasSelectors) {
			const canonicalId = this.#canonicalIndex.bySelector.get(aliasSelector);
			if (canonicalId === undefined) continue;
			const record = this.#canonicalIndex.byId.get(canonicalId.trim().toLowerCase());
			if (!record) continue;
			const variant = record.variants.find(entry => entry.selector.toLowerCase() === aliasSelector);
			if (!variant) continue;
			if (candidateKeys && !candidateKeys.has(variant.selector)) continue;
			if (!this.#isModelAvailable(variant.model)) continue;
			eligible.push(variant);
		}
		if (eligible.length === 0) return undefined;

		const resolved = this.#resolveCanonicalVariant(eligible, options?.sessionId, {
			providerRankFirst: true,
			exactnessKey: normalizedAlias,
			credentialSessionId: options?.credentialSessionId,
		});
		if (resolved && options?.sessionId) this.#rememberCanonicalVariant(options.sessionId, resolved.selector);
		return resolved?.model;
	}

	/**
	 * Whether a final-slash-segment alias is known in the current canonical
	 * index. Knownness is decided from the full multi-target alias index and is
	 * independent of availability: a known-but-unavailable alias still reports
	 * `true` while {@link resolveModelByLookupAlias} returns an authoritative
	 * `undefined`.
	 */
	lookupAliasExists(alias: string): boolean {
		const normalized = alias.trim().toLowerCase();
		return this.#canonicalIndex.aliases.has(normalized);
	}

	/**
	 * Effective credential provenance for a provider, derived from existing
	 * AuthStorage/session credential surfaces (never from token shape).
	 * Session-specific provenance wins; API-key surfaces (runtime, config,
	 * custom/manual, stored api_key) beat OAuth presence; OAuth remains the
	 * provenance when it is the effective remaining stored credential;
	 * unknown/keyless providers fall back to non-OAuth.
	 */
	getEffectiveProviderAuth(provider: string, sessionId?: string): EffectiveProviderAuth {
		return this.#effectiveProviderAuth(provider, sessionId);
	}

	/**
	 * Billing path for a resolved binding — derived at the point the binding
	 * resolves credentials (model.api + credential provenance). Not a
	 * provider-name allowlist: a custom OpenAI-compatible provider bound
	 * to a metered gateway is "metered-api" exactly like a first-party
	 * key. Only the billing category is ever disclosed.
	 */
	getBillingPath(model: Model<Api>, sessionId?: string): BillingPath | undefined {
		const effectiveAuth = this.#effectiveProviderAuth(model.provider, sessionId);
		return deriveBillingPath(model.provider, model.api as Api, effectiveAuth);
	}

	/**
	 * Forget a session's remembered canonical variant so the next resolution
	 * for that session re-ranks from scratch (explicit reselection
	 * integration). Returns whether an entry was actually removed.
	 */
	clearCanonicalVariant(sessionId: string): boolean {
		const scope = sessionId.trim();
		if (!scope) return false;
		return this.#sessionCanonicalVariants.delete(scope);
	}
	/**
	 * Snapshot a session's remembered sticky canonical variant selector — the exact
	 * concrete "provider/id" selector, captured verbatim rather than re-derived
	 * from any live model. Returns undefined when the session has no remembered
	 * variant. The caller owns restoring it later via
	 * {@link restoreSessionCanonicalVariant}.
	 */
	getSessionCanonicalVariant(sessionId: string): string | undefined {
		const scope = sessionId.trim();
		if (!scope) return undefined;
		return this.#sessionCanonicalVariants.get(scope);
	}

	/**
	 * Restore a session's sticky canonical variant selector exactly, preserving the
	 * concrete provider/model previously remembered (never re-derived from a live
	 * model). The selector must still be present in the canonical index, otherwise
	 * the stale variant is left untouched and `false` is returned.
	 */
	restoreSessionCanonicalVariant(sessionId: string, selector: string): boolean {
		const scope = sessionId.trim();
		if (!scope) return false;
		const normalized = selector.trim();
		if (!normalized) return false;
		const canonicalId = this.#canonicalIndex.bySelector.get(normalized.toLowerCase());
		if (!canonicalId) return false;
		const record = this.#canonicalIndex.byId.get(canonicalId.trim().toLowerCase());
		const variant = record?.variants.find(candidate => candidate.selector.toLowerCase() === normalized.toLowerCase());
		if (!variant) return false;
		this.#rememberCanonicalVariant(scope, variant.selector);
		return true;
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
		this.#synchronizeEnvironmentCredentials();
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
		const disabledProviderKey = [...disabledProviders].sort().join("\u0000");
		const envFingerprint = envAvailabilityFingerprint(this.#configuredApiKeyEnvNames);
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

	#synchronizeEnvironmentCredentials(): void {
		// Runtime registrations own a provider while their credential is present.
		// Refresh them first so a missing runtime env key can hand ownership back to
		// the static config before the static apiKeyEnv pass runs.
		for (const provider of this.#runtimeProviderApiKeyEnvNames.keys()) {
			this.#refreshRotatingConfigApiKey(provider);
		}
		for (const provider of this.#customProviderApiKeyEnvNames.keys()) {
			if (this.#runtimeProviderCredentialInstalled.has(provider)) continue;
			this.#refreshRotatingConfigApiKey(provider, true);
		}
	}

	/**
	 * Get authenticated models, excluding bundled entries that a fresh provider
	 * catalog has positively shown to be unavailable. Bundled entries remain
	 * usable until live catalog evidence exists so offline startup is unchanged.
	 */
	getAvailableForProfileActivation(): Model<Api>[] {
		return this.getAvailable().filter(model => {
			const evidence = this.#descriptorDiscoveryEvidence.get(model.provider);
			if (!evidence?.profileFresh || evidence.profileModelIds === undefined) return true;
			if (this.#hasCustomModelOverlay(model.provider, model.id)) return true;
			const bundledModelIds = new Set(
				(getBundledModels(model.provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[]).map(
					candidate => candidate.id,
				),
			);
			if (!bundledModelIds.has(model.id)) return true;
			if (
				evidence.authGeneration !== this.#getProviderEvidenceGeneration(model.provider) ||
				evidence.profileEndpoint !==
					this.#normalizeDiscoveryEvidenceEndpoint(this.#getProviderBaseUrlForDiscovery(model.provider) ?? "")
			)
				return true;
			return evidence.profileModelIds.has(model.id);
		});
	}

	#hasCustomModelOverlay(provider: string, id: string): boolean {
		return [...this.#customModelOverlays, ...this.#runtimeModelOverlays].some(
			overlay => overlay.provider === provider && overlay.id === id,
		);
	}

	#hasFreshOrStaticModelEvidence(model: Model<Api>): boolean {
		const evidence = this.#providerActivity.get(model.provider);
		if (
			!evidence ||
			(!evidence.staticConfigured &&
				!evidence.discoveryConfigured &&
				!evidence.implicitDiscovery &&
				!evidence.descriptorBacked)
		) {
			return false;
		}
		if (evidence.staticConfigured && (!evidence.discoveryConfigured || evidence.staticModelIds.has(model.id))) {
			return true;
		}
		if (
			evidence.descriptorFresh &&
			evidence.authGeneration === this.#getProviderEvidenceGeneration(model.provider) &&
			evidence.endpoint ===
				this.#normalizeDiscoveryEvidenceEndpoint(
					this.#getProviderBaseUrlForDiscovery(model.provider) ?? model.baseUrl ?? "",
				) &&
			evidence.descriptorModelIds.has(model.id)
		)
			return true;
		const discoveryState = this.#discoveryManager.getState(model.provider);
		const configuredEvidence = this.#configuredDiscoveryEvidence.get(model.provider);
		return (
			(discoveryState?.status === "ok" || discoveryState?.status === "cached") &&
			configuredEvidence?.authGeneration === this.#getProviderEvidenceGeneration(model.provider) &&
			configuredEvidence.endpoint ===
				this.#normalizeDiscoveryEvidenceEndpoint(this.#getProviderBaseUrlForDiscovery(model.provider) ?? "") &&
			configuredEvidence.modelIds.has(model.id)
		);
	}

	#activeConnectionKind(model: Model<Api>): ActiveProviderDescriptor["connectionKind"] | undefined {
		const evidence = this.#providerActivity.get(model.provider);
		if (
			!this.#isCredentiallessProvider(model.provider) &&
			this.authStorage.hasUsableAuth(model.provider, { owner: this.#authStorageConfigOwner })
		) {
			if (!evidence) return undefined;
			const discoveryOnly =
				!evidence.staticConfigured &&
				(evidence.discoveryConfigured || evidence.implicitDiscovery || evidence.descriptorBacked);
			return !discoveryOnly || this.#hasFreshOrStaticModelEvidence(model) ? "credential" : undefined;
		}
		if (this.#isCredentiallessProvider(model.provider)) {
			const discoveryOnly =
				evidence !== undefined &&
				!evidence.staticConfigured &&
				(evidence.discoveryConfigured || evidence.implicitDiscovery || evidence.descriptorBacked);
			if (discoveryOnly) {
				if (evidence.descriptorBacked)
					return this.#hasFreshOrStaticModelEvidence(model) ? "credentialless" : undefined;
				const configuredBaseUrl = this.#getProviderBaseUrlForDiscovery(model.provider);
				const discoveryType = this.#discoveryManager.providers.find(
					provider => provider.provider === model.provider,
				)?.discovery.type;
				const endpointFor = (baseUrl: string | undefined): string =>
					this.#normalizeDiscoveryEvidenceEndpoint(
						discoveryType === "ollama"
							? `${this.#normalizeOllamaBaseUrl(baseUrl)}/v1`
							: discoveryType === "openai-models-list" ||
									discoveryType === "lm-studio" ||
									discoveryType === "omlx" ||
									discoveryType === "vllm" ||
									discoveryType === "sglang"
								? this.#normalizeOpenAIModelsListBaseUrl(baseUrl)
								: (baseUrl ?? ""),
					);
				if (
					endpointFor(model.baseUrl) !== endpointFor(configuredBaseUrl) ||
					this.#discoveryManager.getState(model.provider)?.status === "empty"
				)
					return undefined;
				const configuredEvidence = this.#configuredDiscoveryEvidence.get(model.provider);
				if (
					this.#discoveryManager.getState(model.provider)?.error !== undefined ||
					(this.#optionalAuthProviders.has(model.provider) &&
						(configuredEvidence === undefined ||
							configuredEvidence.authGeneration !== this.#getProviderEvidenceGeneration(model.provider)))
				)
					return undefined;
			}
			return "credentialless";
		}
		return undefined;
	}

	getActiveProviders(): ActiveProviderDescriptor[] {
		try {
			const descriptors: ActiveProviderDescriptor[] = [];
			const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
			const available = this.#models.filter(model => this.#isModelAvailable(model, disabledProviders));
			for (const model of available) {
				const connectionKind = this.#activeConnectionKind(model);
				if (connectionKind) descriptors.push({ provider: model.provider, connectionKind });
			}
			return projectActiveProviderDescriptors(descriptors);
		} catch {
			throw new ActiveProviderResolutionError();
		}
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
		return (
			this.#keylessProviders.has(model.provider) ||
			this.authStorage.hasAuth(model.provider, undefined, { owner: this.#authStorageConfigOwner })
		);
	}

	/**
	 * Check whether auth is configured for a provider.
	 */
	hasConfiguredProviderAuth(provider: string): boolean {
		return (
			this.#keylessProviders.has(provider) ||
			this.authStorage.hasAuth(provider, undefined, { owner: this.#authStorageConfigOwner })
		);
	}

	isCredentiallessProvider(provider: string): boolean {
		return this.#isCredentiallessProvider(provider);
	}

	getDiscoverableProviders(): string[] {
		const disabledProviders = getDisabledProviderIdsFromSettings(this.#settings);
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

	/** Opaque owner token for registry-scoped AuthStorage reads. */
	getAuthStorageOwner(): object {
		return this.#authStorageConfigOwner;
	}

	getProviderWebSearchMode(provider: string): WebSearchMode | undefined {
		return this.#providerWebSearchModes.get(provider);
	}

	getActiveSearchModelContext(model: Model<Api>): ActiveSearchModelContext {
		const provider = model.provider.toLowerCase();
		const ownerAuthOverride =
			this.authStorage.hasConfigApiKey(model.provider, this.#authStorageConfigOwner) ||
			this.#providerOverrides.has(provider) ||
			this.#runtimeProviderOverrides.has(provider) ||
			this.#modelOverrides.get(provider)?.has(model.id.toLowerCase()) === true ||
			this.#customProviderAuthHeaders.has(provider) ||
			this.#runtimeProviderAuthHeaders.has(provider);
		return {
			provider: model.provider,
			modelId: model.id,
			wireModelId: model.wireModelId,
			api: model.api,
			baseUrl: model.baseUrl,
			headers: model.headers,
			ownerAuthOverride,
			resolveCredentials: async ({ sessionId, signal }) => {
				// Resolve against the current registry model so rotating apiKeyEnv
				// credentials and generated Authorization headers are synchronized
				// immediately before native search sends its request.
				const currentModel = this.find(model.provider, model.id) ?? model;
				const apiKey = await this.getApiKey(currentModel, sessionId, { signal });
				return { apiKey, headers: currentModel.headers };
			},
			webSearch: this.getProviderWebSearchMode(model.provider),
		};
	}

	async #getApiKeyOrNoAuth(provider: string, lookup: () => Promise<string | undefined>): Promise<string | undefined> {
		const credentialless = this.#isCredentiallessProvider(provider);
		if (credentialless && !this.#optionalAuthProviders.has(provider)) return kNoAuth;
		const apiKey = await lookup();
		if (isVllmNoAuthToken(provider, apiKey)) return normalizeVllmApiKey(provider, apiKey) ?? kNoAuth;
		if (!credentialless) return apiKey;
		if (apiKey !== undefined) {
			this.#credentiallessAuthFallbackProviders.delete(provider);
			return apiKey;
		}
		return kNoAuth;
	}

	/**
	 * Get API key for a model.
	 */
	async getApiKey(
		model: Model<Api>,
		sessionId?: string,
		options: {
			credentialSelector?: AuthCredentialSelector;
			preferredCredentialSelector?: AuthCredentialSelector;
			signal?: AbortSignal;
		} = {},
	): Promise<string | undefined> {
		this.#refreshRotatingConfigApiKey(model.provider);
		const apiKey = await this.#getApiKeyOrNoAuth(model.provider, () =>
			this.authStorage.getApiKey(model.provider, sessionId, {
				baseUrl: model.baseUrl,
				modelId: model.id,
				credentialSelector: options.credentialSelector,
				preferredCredentialSelector: options.preferredCredentialSelector,
				owner: this.#authStorageConfigOwner,
				signal: options.signal,
			}),
		);
		this.#applyEffectiveAuthHeader(model, apiKey);
		return apiKey;
	}

	/**
	 * Get API key for a provider (e.g., "openai").
	 */
	async getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		baseUrl?: string,
		options: {
			credentialSelector?: AuthCredentialSelector;
			preferredCredentialSelector?: AuthCredentialSelector;
			signal?: AbortSignal;
		} = {},
	): Promise<string | undefined> {
		this.#refreshRotatingConfigApiKey(provider);
		const apiKey = await this.#getApiKeyOrNoAuth(provider, () =>
			this.authStorage.getApiKey(provider, sessionId, {
				baseUrl,
				credentialSelector: options.credentialSelector,
				preferredCredentialSelector: options.preferredCredentialSelector,
				owner: this.#authStorageConfigOwner,
				signal: options.signal,
			}),
		);
		if (
			this.#runtimeProviderAuthHeaders.get(provider) === true ||
			this.#customProviderAuthHeaders.get(provider) === true
		) {
			for (const model of this.#models) {
				if (model.provider === provider) this.#applyEffectiveAuthHeader(model, apiKey);
			}
		}
		return apiKey;
	}

	#refreshRotatingConfigApiKey(provider: string, forceStatic = false): void {
		const runtimeOwned = !forceStatic && this.#runtimeProviderApiKeys.has(provider);
		const envName = runtimeOwned
			? this.#runtimeProviderApiKeyEnvNames.get(provider)
			: this.#customProviderApiKeyEnvNames.get(provider);
		if (!envName) return;
		const resolved = $rotatingCredentialEnv(envName);
		const previous = runtimeOwned
			? this.#runtimeProviderResolvedApiKeys.get(provider)
			: this.#customProviderApiKeys.get(provider);
		if (resolved === previous && (!runtimeOwned || this.#runtimeProviderCredentialInstalled.has(provider))) return;
		if (resolved === undefined) {
			if (runtimeOwned) {
				if (!this.#runtimeProviderCredentialInstalled.has(provider)) return;
				this.#runtimeProviderCredentialInstalled.delete(provider);
				this.#staticModelsLoaded = false;
				this.#reloadStaticModels();
				return;
			}
			this.#customProviderApiKeys.delete(provider);
			this.authStorage.removeConfigApiKey(provider, this.#authStorageConfigOwner);
		} else {
			this.#customProviderApiKeys.set(provider, resolved);
			if (runtimeOwned) {
				this.#runtimeProviderResolvedApiKeys.set(provider, resolved);
				this.#runtimeProviderCredentialInstalled.add(provider);
			}
			if (runtimeOwned) {
				this.authStorage.setConfigApiKey(provider, resolved, { owner: this.#authStorageConfigOwner });
			} else {
				this.authStorage.setConfigApiKey(provider, resolved, {
					envSourced: true,
					owner: this.#authStorageConfigOwner,
				});
			}
		}
		const authHeader =
			this.#runtimeProviderAuthHeaders.get(provider) ?? this.#customProviderAuthHeaders.get(provider);
		const runtimeOverride = this.#runtimeProviderOverrides.get(provider);
		if (runtimeOverride) this.#runtimeProviderOverrides.set(provider, { ...runtimeOverride, apiKey: resolved ?? "" });
		this.#runtimeModelOverlays = this.#runtimeModelOverlays.map(overlay => {
			if (overlay.provider !== provider) return overlay;
			const headers = { ...(overlay.headers ?? {}) } as Record<string, string> & {
				[GENERATED_AUTH_HEADER]?: string;
			};
			const generated = headers[GENERATED_AUTH_HEADER];
			const hadAuthorization = headerValue(headers, "Authorization") !== undefined;
			const ownsAuthorization = ownsOnlyGeneratedAuthorization(headers, generated);
			if (ownsAuthorization) deleteHeaderCaseInsensitive(headers, "Authorization");
			else if (typeof generated === "string") deleteAuthorizationValue(headers, generated);
			delete headers[GENERATED_AUTH_HEADER];
			if (authHeader === true && resolved && (ownsAuthorization || !hadAuthorization)) {
				headers.Authorization = `Bearer ${resolved}`;
				headers[GENERATED_AUTH_HEADER] = `Bearer ${resolved}`;
			}
			return { ...overlay, headers };
		});
		if (authHeader === true) this.#generatedAuthHeaderProviders.add(provider);
		if (authHeader !== true && !this.#generatedAuthHeaderProviders.has(provider)) return;
		for (const model of this.#models) {
			if (model.provider !== provider) continue;
			const headers = { ...(model.headers ?? {}) } as Record<string, string> & {
				[GENERATED_AUTH_HEADER]?: string;
			};
			const generated =
				this.#generatedAuthHeaders.get(model) ??
				(typeof headers[GENERATED_AUTH_HEADER] === "string"
					? { authorization: headers[GENERATED_AUTH_HEADER] }
					: undefined);
			const hadAuthorization = headerValue(headers, "Authorization") !== undefined;
			const ownsAuthorization = ownsOnlyGeneratedAuthorization(headers, generated?.authorization);
			if (ownsAuthorization) deleteHeaderCaseInsensitive(headers, "Authorization");
			else if (generated?.authorization) deleteAuthorizationValue(headers, generated.authorization);
			if (generated?.apiKey === headers["X-Api-Key"]) delete headers["X-Api-Key"];
			delete headers[GENERATED_AUTH_HEADER];
			model.headers =
				authHeader === true && resolved && (ownsAuthorization || !hadAuthorization)
					? { ...headers, Authorization: `Bearer ${resolved}`, [GENERATED_AUTH_HEADER]: `Bearer ${resolved}` }
					: headers;
			if (authHeader === true && resolved && (ownsAuthorization || !hadAuthorization))
				this.#generatedAuthHeaders.set(model, { authorization: model.headers.Authorization });
		}
		this.#rebuildCanonicalIndex();
	}

	#applyEffectiveAuthHeader(model: Model<Api>, apiKey: string | undefined): void {
		const runtimeCredentialRevoked =
			this.#runtimeProviderApiKeys.has(model.provider) &&
			!this.#runtimeProviderCredentialInstalled.has(model.provider);
		const authHeader = runtimeCredentialRevoked
			? this.#customProviderAuthHeaders.get(model.provider)
			: (this.#runtimeProviderAuthHeaders.get(model.provider) ??
				this.#customProviderAuthHeaders.get(model.provider));
		if (authHeader === true) this.#generatedAuthHeaderProviders.add(model.provider);
		const headers = { ...(model.headers ?? {}) } as Record<string, string> & {
			[GENERATED_AUTH_HEADER]?: string;
		};
		const generated =
			this.#generatedAuthHeaders.get(model) ??
			(typeof headers[GENERATED_AUTH_HEADER] === "string"
				? { authorization: headers[GENERATED_AUTH_HEADER] }
				: undefined);
		const hadAuthorization = headerValue(headers, "Authorization") !== undefined;
		const ownsAuthorization = ownsOnlyGeneratedAuthorization(headers, generated?.authorization);
		if (authHeader !== true && generated === undefined && !this.#generatedAuthHeaderProviders.has(model.provider))
			return;
		if (ownsAuthorization) deleteHeaderCaseInsensitive(headers, "Authorization");
		else if (generated?.authorization) deleteAuthorizationValue(headers, generated.authorization);
		if (generated?.apiKey === headers["X-Api-Key"]) delete headers["X-Api-Key"];
		delete headers[GENERATED_AUTH_HEADER];
		model.headers =
			authHeader === true && apiKey && apiKey !== kNoAuth && (ownsAuthorization || !hadAuthorization)
				? { ...headers, Authorization: `Bearer ${apiKey}`, [GENERATED_AUTH_HEADER]: `Bearer ${apiKey}` }
				: headers;
		if (authHeader === true && apiKey && apiKey !== kNoAuth && (ownsAuthorization || !hadAuthorization)) {
			this.#generatedAuthHeaders.set(model, { authorization: model.headers.Authorization });
		}
	}

	async #peekApiKeyForProvider(
		provider: string,
		options: {
			ignoreCredentiallessFallback?: boolean;
			refreshOAuth?: boolean;
			baseUrl?: string;
		} = {},
	): Promise<string | undefined> {
		this.#refreshRotatingConfigApiKey(provider);
		if (!options.ignoreCredentiallessFallback && this.#isCredentiallessProvider(provider)) {
			return kNoAuth;
		}
		try {
			this.authStorage.getProviderEvidenceGeneration(provider, undefined, this.#authStorageConfigOwner);
		} catch {
			return undefined;
		}
		if (options.refreshOAuth && this.authStorage.hasOAuth(provider)) {
			return this.authStorage.getApiKey(provider, undefined, {
				baseUrl: options.baseUrl,
				owner: this.#authStorageConfigOwner,
			});
		}
		return options.ignoreCredentiallessFallback
			? this.authStorage.peekApiKey(provider, { owner: this.#authStorageConfigOwner })
			: this.#getApiKeyOrNoAuth(provider, () =>
					this.authStorage.peekApiKey(provider, { owner: this.#authStorageConfigOwner }),
				);
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

	#clearDescriptorDiscoveryEvidence(providerName: string): void {
		this.#descriptorDiscoveryGenerations.set(
			providerName,
			(this.#descriptorDiscoveryGenerations.get(providerName) ?? 0) + 1,
		);
		this.#descriptorDiscoveryEvidence.delete(providerName);
		this.#configuredDiscoveryEvidence.delete(providerName);
		this.#discoveryManager.invalidate(providerName);
	}

	#clearRuntimeProviderState(providerName: string): void {
		this.#runtimeProviderApiKeys.delete(providerName);
		this.#runtimeProviderResolvedApiKeys.delete(providerName);
		this.#runtimeProviderCredentialInstalled.delete(providerName);
		this.#runtimeProviderApiKeyEnvNames.delete(providerName);
		this.#runtimeProviderOverrides.delete(providerName);
		this.#runtimeProviderAuthHeaders.delete(providerName);
		this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(overlay => overlay.provider !== providerName);
		this.authStorage.removeConfigApiKey(providerName, this.#authStorageConfigOwner);
		this.#clearDescriptorDiscoveryEvidence(providerName);
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
		this.#staticModelsLoaded = false;
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
				compat: config.compat,
				requestTransform: config.requestTransform,
				models: (config.models ?? []) as ProviderValidationModel[],
			},
			"runtime-register",
		);
		this.#clearDescriptorDiscoveryEvidence(providerName);
		this.#rebuildProviderActivity();

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
			this.#staticModelsLoaded = false;
			this.#reloadStaticModels();
			if (config.authHeader !== undefined) this.#runtimeProviderAuthHeaders.set(providerName, config.authHeader);
		}
		if (config.authHeader !== undefined) {
			if (config.authHeader === false) {
				this.#runtimeModelOverlays = this.#runtimeModelOverlays.map(overlay => {
					if (overlay.provider !== providerName) return overlay;
					const headers = { ...(overlay.headers ?? {}) } as Record<string, string> & {
						[GENERATED_AUTH_HEADER]?: string;
					};
					const generated = headers[GENERATED_AUTH_HEADER];
					if (typeof generated === "string" && headers.Authorization === generated) delete headers.Authorization;
					delete headers[GENERATED_AUTH_HEADER];
					return { ...overlay, headers };
				});
			}
			this.#runtimeProviderAuthHeaders.set(providerName, config.authHeader);
			if (config.authHeader === true) this.#generatedAuthHeaderProviders.add(providerName);
		}

		if (config.apiKey) {
			const resolved = resolveApiKeyConfig(config.apiKey);
			if (!resolved) return;
			if (Bun.env[config.apiKey] !== undefined) this.#runtimeProviderApiKeyEnvNames.set(providerName, config.apiKey);
			else this.#runtimeProviderApiKeyEnvNames.delete(providerName);
			this.#customProviderApiKeys.set(providerName, resolved);
			// Persist runtime API keys so they survive #reloadStaticModels() cycles
			this.#runtimeProviderApiKeys.set(providerName, config.apiKey);
			this.#runtimeProviderResolvedApiKeys.set(providerName, resolved);
			this.#runtimeProviderCredentialInstalled.add(providerName);
			if (config.authHeader !== undefined) this.#runtimeProviderAuthHeaders.set(providerName, config.authHeader);
			this.authStorage.setConfigApiKey(providerName, resolved, { owner: this.#authStorageConfigOwner });
		}
		if (config.oauth && !config.apiKey && this.#runtimeProviderApiKeys.has(providerName)) {
			const previousApiKey = this.#runtimeProviderResolvedApiKeys.get(providerName);
			this.#runtimeProviderApiKeys.delete(providerName);
			this.#runtimeProviderResolvedApiKeys.delete(providerName);
			this.#runtimeProviderCredentialInstalled.delete(providerName);
			this.#runtimeProviderApiKeyEnvNames.delete(providerName);
			this.#runtimeProviderAuthHeaders.delete(providerName);
			this.#customProviderApiKeys.delete(providerName);
			this.authStorage.removeConfigApiKey(providerName, this.#authStorageConfigOwner);
			this.#runtimeModelOverlays = this.#runtimeModelOverlays.map(overlay => {
				if (overlay.provider !== providerName) return overlay;
				const headers = { ...(overlay.headers ?? {}) } as Record<string, string> & {
					[GENERATED_AUTH_HEADER]?: string;
				};
				const generated = headers[GENERATED_AUTH_HEADER];
				for (const key of Object.keys(headers)) {
					if (key.toLowerCase() !== "authorization") continue;
					const value = headers[key];
					if (
						(typeof generated === "string" && value === generated) ||
						(previousApiKey !== undefined && value === `Bearer ${previousApiKey}`) ||
						(previousApiKey === undefined && value.startsWith("Bearer "))
					)
						delete headers[key];
				}
				delete headers[GENERATED_AUTH_HEADER];
				return { ...overlay, headers };
			});
			const previousOverride = this.#runtimeProviderOverrides.get(providerName);
			if (previousOverride) {
				const headers = { ...(previousOverride.headers ?? {}) };
				for (const key of Object.keys(headers)) {
					if (key.toLowerCase() !== "authorization") continue;
					const value = headers[key];
					if (
						(previousApiKey !== undefined && value === `Bearer ${previousApiKey}`) ||
						(previousApiKey === undefined && value.startsWith("Bearer "))
					)
						delete headers[key];
				}
				this.#runtimeProviderOverrides.set(providerName, {
					...previousOverride,
					apiKey: "",
					authHeader: undefined,
					isOAuth: true,
					headers,
				});
			}
			this.#staticModelsLoaded = false;
			this.#reloadStaticModels();
			if (config.authHeader !== undefined) this.#runtimeProviderAuthHeaders.set(providerName, config.authHeader);
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
					config.apiKey ? resolveApiKeyConfig(config.apiKey) : undefined,
					config.authHeader,
					config.compat,
					config.requestTransform,
					undefined,
					undefined,
					config.transport,
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
			if (
				config.baseUrl ||
				config.headers ||
				config.apiKey ||
				config.authHeader !== undefined ||
				config.compat !== undefined ||
				config.requestTransform !== undefined ||
				config.transport !== undefined
			) {
				this.#runtimeProviderOverrides.set(
					providerName,
					this.#mergeProviderOverride(this.#runtimeProviderOverrides.get(providerName), {
						api: config.api,
						baseUrl: this.#runtimeProviderOverrides.get(providerName)?.baseUrl ?? config.baseUrl,
						headers: config.headers,
						apiKey: config.apiKey ? resolveApiKeyConfig(config.apiKey) : undefined,
						authHeader: config.authHeader,
						compat: config.compat,
						requestTransform: config.requestTransform,
						transport: config.transport,
					}),
				);
			}
			const runtimeTransportOverride = this.#runtimeProviderOverrides.get(providerName);
			const withRuntimeTransportOverride = runtimeTransportOverride
				? nextModels.map(model => {
						if (model.provider !== providerName) return model;
						return this.#applyRuntimeProviderOverride(model, runtimeTransportOverride);
					})
				: nextModels;
			const withModelOverrides = this.#applyProviderModelOverrides(providerName, withRuntimeTransportOverride);

			if (config.oauth?.modifyModels) {
				const credential = this.authStorage.getOAuthCredential(providerName, undefined, {
					owner: this.#authStorageConfigOwner,
				});
				if (credential) {
					this.#models = this.#finalizeModels(config.oauth.modifyModels(withModelOverrides, credential));
					this.#rebuildCanonicalIndex();
					this.#rebuildProviderActivity();
					return;
				}
			}

			this.#models = this.#finalizeModels(withModelOverrides);
			this.#rebuildCanonicalIndex();
			this.#rebuildProviderActivity();
			return;
		}

		if (
			config.baseUrl ||
			config.headers ||
			config.apiKey ||
			config.authHeader !== undefined ||
			config.compat !== undefined ||
			config.requestTransform !== undefined ||
			config.transport !== undefined
		) {
			const transportOverride = {
				api: config.api,
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey ? resolveApiKeyConfig(config.apiKey) : undefined,
				authHeader: config.authHeader,
				compat: config.compat,
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
				return this.#applyRuntimeProviderOverride(m, transportOverride);
			});
			if (config.authHeader === false) {
				for (const model of this.#models) {
					if (model.provider === providerName) this.#applyEffectiveAuthHeader(model, undefined);
				}
			}
			this.#rebuildCanonicalIndex();
			this.#rebuildProviderActivity();
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
