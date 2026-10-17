import { logger } from "@gajae-code/utils";
import * as z from "zod/v4";
import { isRetiredModelKey } from "../../model-retirements";
import { getAntigravityUserAgent, getGeminiCliUserAgent } from "../../providers/google-gemini-headers";
import type { Model } from "../../types";

/**
 * Returns the default Antigravity discovery User-Agent.
 * Can be overridden via PI_AI_ANTIGRAVITY_USER_AGENT environment variable.
 */
export function getDefaultAntigravityUserAgent(): string {
	return getAntigravityUserAgent();
}

const DEFAULT_ANTIGRAVITY_DISCOVERY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const;
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const ANTIGRAVITY_DISCOVERY_DENYLIST = new Set([
	"chat_20706",
	"chat_23310",
	"gemini-2.5-flash-thinking",
	"gemini-3-pro-low",
	"gemini-2.5-pro",
]);

/**
 * Raw model metadata returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiModel {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	thinkingBudget?: number;
	recommended?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	model?: string;
	apiProvider?: string;
	modelProvider?: string;
	isInternal?: boolean;
	supportsVideo?: boolean;
	/** Account-specific entitlement status */
	entitlement?: string;
	/** Whether the model is disabled for this account */
	disabled?: boolean;
	/** Per-account quota/tier information */
	quota?: string;
}

/**
 * Grouping metadata used by Antigravity to surface recommended model ids.
 */
export interface AntigravityDiscoveryAgentModelGroup {
	modelIds?: string[];
}

/**
 * Sort/group metadata used by Antigravity to surface recommended model ids.
 */
export interface AntigravityDiscoveryAgentModelSort {
	groups?: AntigravityDiscoveryAgentModelGroup[];
}

/**
 * Response payload returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiResponse {
	models?: Record<string, AntigravityDiscoveryApiModel>;
	agentModelSorts?: AntigravityDiscoveryAgentModelSort[];
}
const AntigravityDiscoveryApiModelSchema: z.ZodType<AntigravityDiscoveryApiModel> = z
	.object({
		displayName: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		supportsImages: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		supportsThinking: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		thinkingBudget: z.preprocess(
			value => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
			z.number().optional(),
		),
		recommended: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		maxTokens: z.preprocess(
			value => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
			z.number().optional(),
		),
		maxOutputTokens: z.preprocess(
			value => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
			z.number().optional(),
		),
		model: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		apiProvider: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		modelProvider: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		isInternal: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		supportsVideo: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		entitlement: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
		disabled: z.preprocess(value => (typeof value === "boolean" ? value : undefined), z.boolean().optional()),
		quota: z.preprocess(value => (typeof value === "string" ? value : undefined), z.string().optional()),
	})
	.loose();
const AntigravityDiscoveryAgentModelGroupSchema: z.ZodType<AntigravityDiscoveryAgentModelGroup> = z
	.object({
		modelIds: z.preprocess(
			value =>
				Array.isArray(value)
					? value.filter((modelId): modelId is string => typeof modelId === "string")
					: undefined,
			z.array(z.string()).optional(),
		),
	})
	.loose();
const AntigravityDiscoveryAgentModelSortSchema: z.ZodType<AntigravityDiscoveryAgentModelSort> = z
	.object({
		groups: z.preprocess(
			value => (Array.isArray(value) ? value : undefined),
			z
				.array(z.unknown())
				.transform(groups =>
					groups.flatMap(group => {
						const parsedGroup = AntigravityDiscoveryAgentModelGroupSchema.safeParse(group);
						return parsedGroup.success ? [parsedGroup.data] : [];
					}),
				)
				.optional(),
		),
	})
	.loose();
const AntigravityDiscoveryApiResponseSchema: z.ZodType<AntigravityDiscoveryApiResponse> = z
	.object({
		models: z.preprocess(
			value => (typeof value === "object" && value !== null ? value : undefined),
			z
				.record(z.string(), z.unknown())
				.transform(models => {
					const normalized: Record<string, AntigravityDiscoveryApiModel> = {};
					for (const [modelId, modelValue] of Object.entries(models)) {
						if (typeof modelValue !== "object" || modelValue === null) {
							continue;
						}
						const parsedModel = AntigravityDiscoveryApiModelSchema.safeParse(modelValue);
						if (parsedModel.success) {
							normalized[modelId] = parsedModel.data;
						}
					}
					return normalized;
				})
				.optional(),
		),
		agentModelSorts: z.preprocess(
			value => (Array.isArray(value) ? value : undefined),
			z
				.array(z.unknown())
				.transform(sorts =>
					sorts.flatMap(sort => {
						const parsedSort = AntigravityDiscoveryAgentModelSortSchema.safeParse(sort);
						return parsedSort.success ? [parsedSort.data] : [];
					}),
				)
				.optional(),
		),
	})
	.loose();

/**
 * Options for fetching Antigravity discovery models.
 */
export interface FetchAntigravityDiscoveryModelsOptions {
	/** OAuth access token used as `Authorization: Bearer <token>`. */
	token: string;
	/** Optional endpoint override. Defaults to Antigravity fallback endpoints. */
	endpoint?: string;
	/** Optional Google Cloud project ID for tier-gated model discovery. */
	project?: string;
	/** Optional user agent override. */
	userAgent?: string;
	/** Optional abort signal for request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetcher?: typeof fetch;
	/**
	 * Provider id the caller assigns to returned models. Scopes retired-selector
	 * filtering (e.g. `google-gemini-cli` reuses this helper and remaps rows).
	 * Default: `google-antigravity`.
	 */
	targetProvider?: "google-antigravity" | "google-gemini-cli";
	/** Optional logger for debug diagnostics. */
	logger?: Pick<typeof logger, "debug">;
}

/**
 * Fetches discoverable Antigravity models and normalizes them into canonical model entries.
 *
 * Returns `null` on network/payload/auth failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchAntigravityDiscoveryModels(
	options: FetchAntigravityDiscoveryModelsOptions,
): Promise<Model<"google-gemini-cli">[] | null> {
	const fetcher = options.fetcher ?? fetch;
	const signal = options.signal ?? AbortSignal.timeout(5_000);
	const targetProvider = options.targetProvider ?? "google-antigravity";
	const userAgent = options.userAgent ?? getAntigravityDiscoveryUserAgent();
	const endpoints = options.endpoint
		? [trimTrailingSlashes(options.endpoint)]
		: DEFAULT_ANTIGRAVITY_DISCOVERY_ENDPOINTS.map(trimTrailingSlashes);
	const debugLogger = options.logger ?? logger;

	for (const endpoint of endpoints) {
		const redactedEndpoint = redactAntigravityEndpoint(endpoint);
		let response: Response;
		try {
			const requestBody: Record<string, unknown> = {};
			if (options.project) {
				requestBody.project = options.project;
			}
			response = await fetcher(`${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.token}`,
					"Content-Type": "application/json",
					"User-Agent": userAgent,
				},
				body: JSON.stringify(requestBody),
				signal,
			});
		} catch {
			continue;
		}

		debugLogger.debug("Antigravity discovery endpoint response", {
			endpoint: redactedEndpoint,
			status: response.status,
			statusText: response.statusText,
		});

		if (!response.ok) {
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			continue;
		}

		const parsed = parseAntigravityDiscoveryResponse(payload);
		if (!parsed) {
			continue;
		}

		const surfacedModelIds = new Set<string>();
		for (const sort of parsed.agentModelSorts ?? []) {
			for (const group of sort.groups ?? []) {
				for (const modelId of group.modelIds ?? []) {
					surfacedModelIds.add(modelId);
				}
			}
		}

		const debugEnabled = process.env.GJC_DEBUG_ANTIGRAVITY_DISCOVERY === "1";
		const keptModelIds: string[] = [];
		const filteredByDenylist: string[] = [];
		const filteredByRetirement: string[] = [];
		const filteredByInternal: string[] = [];
		const filteredByDisabled: string[] = [];
		const keptModelDetails: Record<string, Partial<AntigravityDiscoveryApiModel>> = {};
		const filteredModelDetails: Record<string, Partial<AntigravityDiscoveryApiModel> & { reason: string }> = {};

		const models: Model<"google-gemini-cli">[] = [];
		const modelDropReasons: Record<string, string> = {};

		for (const [modelId, model] of Object.entries(parsed.models ?? {})) {
			let dropReason: string | undefined;

			if (ANTIGRAVITY_DISCOVERY_DENYLIST.has(modelId)) {
				dropReason = "denylist";
			} else if (isRetiredModelKey(targetProvider, modelId)) {
				dropReason = "retired";
			} else if (model.disabled === true) {
				dropReason = "disabled";
			} else if (model.isInternal === true && !surfacedModelIds.has(modelId)) {
				dropReason = "isInternal-not-surfaced";
			}

			if (dropReason) {
				modelDropReasons[modelId] = dropReason;
				if (debugEnabled) {
					if (dropReason === "denylist") filteredByDenylist.push(modelId);
					else if (dropReason === "retired") filteredByRetirement.push(modelId);
					else if (dropReason === "disabled") filteredByDisabled.push(modelId);
					else filteredByInternal.push(modelId);
					filteredModelDetails[modelId] = {
						...model,
						reason:
							dropReason === "retired"
								? `retired-${targetProvider}`
								: dropReason === "isInternal-not-surfaced"
									? "internal-not-surfaced"
									: dropReason,
					};
				}
				continue;
			}
			if (debugEnabled) {
				keptModelIds.push(modelId);
				keptModelDetails[modelId] = {
					displayName: model.displayName,
					isInternal: model.isInternal,
					entitlement: model.entitlement,
					disabled: model.disabled,
					quota: model.quota,
				};
			}

			const supportsImages = model.supportsImages === true;
			models.push({
				id: modelId,
				name: model.displayName ? `${model.displayName} (Antigravity)` : modelId,
				api: "google-gemini-cli",
				provider: "google-antigravity",
				baseUrl: endpoint,
				reasoning: model.supportsThinking === true,
				input: supportsImages ? ["text", "image"] : ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: toPositiveNumber(model.maxTokens, DEFAULT_CONTEXT_WINDOW),
				maxTokens: toPositiveNumber(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
			});
		}

		if (Object.keys(modelDropReasons).length > 0) {
			debugLogger.debug("Antigravity discovery dropped models", {
				endpoint: redactedEndpoint,
				dropReasons: modelDropReasons,
			});
		}

		debugLogger.debug("Antigravity discovery kept models", {
			endpoint: redactedEndpoint,
			keptModelIds: models.map(m => m.id),
		});

		models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

		if (debugEnabled) {
			const allRawModelIds = Object.keys(parsed.models ?? {}).sort();
			console.error("[GJC_DEBUG_ANTIGRAVITY_DISCOVERY]");
			console.error(`  HTTP Status: ${response.status}`);
			console.error(`  User-Agent: ${userAgent}`);
			console.error(`  Endpoint: ${endpoint}`);
			console.error(`  Total raw models from response: ${allRawModelIds.length}`);
			console.error("\n  === KEPT MODELS ===");
			console.error(`  Count: ${keptModelIds.length}`);
			for (const modelId of keptModelIds) {
				const details = keptModelDetails[modelId];
				const attrs = [];
				if (details?.entitlement) attrs.push(`entitlement=${details.entitlement}`);
				if (details?.disabled === true) attrs.push("disabled=true");
				if (details?.quota) attrs.push(`quota=${details.quota}`);
				if (details?.isInternal === true) attrs.push("isInternal=true");
				const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
				console.error(`    ${modelId}${attrStr}`);
			}
			if (filteredByDenylist.length > 0) {
				console.error(`\n  === FILTERED BY DENYLIST ===`);
				console.error(`  Count: ${filteredByDenylist.length}`);
				for (const modelId of filteredByDenylist) {
					const details = filteredModelDetails[modelId];
					const attrs = [];
					if (details?.entitlement) attrs.push(`entitlement=${details.entitlement}`);
					if (details?.disabled === true) attrs.push("disabled=true");
					if (details?.quota) attrs.push(`quota=${details.quota}`);
					if (details?.isInternal === true) attrs.push("isInternal=true");
					const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
					console.error(`    ${modelId}${attrStr}`);
				}
			}
			if (filteredByRetirement.length > 0) {
				console.error(`\n  === FILTERED BY RETIREMENT (${targetProvider}) ===`);
				console.error(`  Count: ${filteredByRetirement.length}`);
				for (const modelId of filteredByRetirement) {
					const details = filteredModelDetails[modelId];
					const attrs = [];
					if (details?.entitlement) attrs.push(`entitlement=${details.entitlement}`);
					if (details?.disabled === true) attrs.push("disabled=true");
					if (details?.quota) attrs.push(`quota=${details.quota}`);
					if (details?.isInternal === true) attrs.push("isInternal=true");
					const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
					console.error(`    ${modelId}${attrStr}`);
				}
			}
			if (filteredByDisabled.length > 0) {
				console.error(`\n  === FILTERED (disabled) ===`);
				console.error(`  Count: ${filteredByDisabled.length}`);
				for (const modelId of filteredByDisabled) {
					const details = filteredModelDetails[modelId];
					const attrs = [];
					if (details?.entitlement) attrs.push(`entitlement=${details.entitlement}`);
					if (details?.disabled === true) attrs.push("disabled=true");
					if (details?.quota) attrs.push(`quota=${details.quota}`);
					if (details?.isInternal === true) attrs.push("isInternal=true");
					const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
					console.error(`    ${modelId}${attrStr}`);
				}
			}
			if (filteredByInternal.length > 0) {
				console.error(`\n  === FILTERED (internal, not surfaced) ===`);
				console.error(`  Count: ${filteredByInternal.length}`);
				for (const modelId of filteredByInternal) {
					const details = filteredModelDetails[modelId];
					const attrs = [];
					if (details?.entitlement) attrs.push(`entitlement=${details.entitlement}`);
					if (details?.disabled === true) attrs.push("disabled=true");
					if (details?.quota) attrs.push(`quota=${details.quota}`);
					if (details?.isInternal === true) attrs.push("isInternal=true");
					const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
					console.error(`    ${modelId}${attrStr}`);
				}
			}
			console.error(`\n  === SURFACE INFO ===`);
			console.error(`  agentModelSorts surfaced: ${surfacedModelIds.size}`);
			if (surfacedModelIds.size > 0) {
				console.error(`    ${Array.from(surfacedModelIds).sort().join(", ")}`);
			}
		}

		return models;
	}

	return null;
}

function parseAntigravityDiscoveryResponse(value: unknown): AntigravityDiscoveryApiResponse | null {
	const parsed = AntigravityDiscoveryApiResponseSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}

function toPositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return value;
}

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

export function getAntigravityDiscoveryUserAgent(): string {
	return process.env.PI_AI_ANTIGRAVITY_USER_AGENT ? getAntigravityUserAgent() : getGeminiCliUserAgent();
}

function redactAntigravityEndpoint(value: string): string {
	try {
		return new URL(value).origin;
	} catch {
		return "invalid endpoint";
	}
}
