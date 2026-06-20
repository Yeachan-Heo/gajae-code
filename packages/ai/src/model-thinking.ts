import { resolveOpenAICompat } from "./providers/openai-completions-compat";
import type { Api, Model as ApiModel, ThinkingConfig } from "./types";
import { isClaudeForcedToolChoiceIncapableModelId } from "./utils/tool-choice-capability";

/** User-facing thinking levels, ordered least to most intensive. */
export const enum Effort {
	Minimal = "minimal",
	Low = "low",
	Medium = "medium",
	High = "high",
	XHigh = "xhigh",
	Max = "max",
}

export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

const DEFAULT_REASONING_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const DEFAULT_REASONING_EFFORTS_WITH_XHIGH: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
];
const DEFAULT_REASONING_EFFORTS_WITH_MAX: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.Max,
];
const DEFAULT_REASONING_EFFORTS_WITH_XHIGH_AND_MAX: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];
const GEMINI_3_PRO_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High];
const GEMINI_3_FLASH_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const GPT_5_2_PLUS_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
const GPT_5_5_DEFAULT_EFFORT = Effort.XHigh;

const GPT_5_1_CODEX_MINI_EFFORTS: readonly Effort[] = [Effort.Medium, Effort.High];
const CLOUDFLARE_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic";

type SemVer = {
	major: number;
	minor: number;
	patch: number;
};

type GeminiKind = "pro" | "flash";
type AnthropicKind = "opus" | "sonnet";
type OpenAIVariant = "base" | "codex" | "codex-max" | "codex-mini" | "codex-spark" | "mini" | "max" | "nano";

const CODEX_GPT_5_4_PRIORITY_BY_VARIANT: Partial<Record<OpenAIVariant, number>> = {
	base: 0,
	mini: 1,
	nano: 2,
};

const COPILOT_GENERATED_LIMITS: Record<string, { contextWindow: number; maxTokens: number }> = {
	"claude-opus-4.6": { contextWindow: 168000, maxTokens: 32000 },
	"gpt-5.2": { contextWindow: 272000, maxTokens: 128000 },
	"gpt-5.4": { contextWindow: 272000, maxTokens: 128000 },
	"gpt-5.4-mini": { contextWindow: 272000, maxTokens: 128000 },
	"grok-code-fast-1": { contextWindow: 192000, maxTokens: 64000 },
};

interface GeminiModel {
	family: "gemini";
	kind: GeminiKind;
	version: SemVer;
}

interface AnthropicModel {
	family: "anthropic";
	kind: AnthropicKind;
	version: SemVer;
}

interface OpenAIModel {
	family: "openai";
	variant: OpenAIVariant;
	version: SemVer;
}

interface UnknownModel {
	family: "unknown";
	id: string;
}

type ParsedModel = GeminiModel | AnthropicModel | OpenAIModel | UnknownModel;

/**
 * Static fallback model injected when Cloudflare AI Gateway discovery
 * returns no results. Ensures the provider always has at least one usable
 * model entry in the catalog.
 */
export const CLOUDFLARE_FALLBACK_MODEL: ApiModel<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Anthropic Sonnet 4.5",
	api: "anthropic-messages",
	provider: "cloudflare-ai-gateway",
	baseUrl: CLOUDFLARE_AI_GATEWAY_BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	contextWindow: 200000,
	maxTokens: 64000,
};

const kEnrichedModel = Symbol("model-thinking.enrichedModel");
type ModelWithEnriched = ApiModel<Api> & { [kEnrichedModel]?: ApiModel<Api> };

/**
 * Returns a copy of the model with canonical thinking metadata attached.
 *
 * This helper belongs to catalog enrichment only. Runtime consumers should
 * trust `model.thinking` and avoid inferring capabilities on demand.
 */
export function enrichModelThinking<TApi extends Api>(model: ApiModel<TApi>): ApiModel<TApi> {
	const tagged = model as ModelWithEnriched;
	const cached = tagged[kEnrichedModel];
	if (cached !== undefined) {
		return cached as ApiModel<TApi>;
	}
	const normalizedThinking = normalizeThinkingConfig(model.thinking);
	let result: ApiModel<TApi>;
	if (!model.reasoning) {
		result =
			normalizedThinking === undefined && model.thinking === undefined ? model : { ...model, thinking: undefined };
	} else {
		const thinking = normalizedThinking ?? inferModelThinking(model);
		result = thinkingsEqual(normalizedThinking, thinking) ? model : { ...model, thinking };
	}
	// Stash the enriched copy on a non-enumerable slot so callers that hand us
	// the same reference twice skip the work. `enumerable: false` is critical:
	// many call sites build derived models via `{ ...model, ...overrides }`,
	// which would otherwise copy this cache slot and trick us into returning
	// the *original* enriched model — silently discarding the overrides.
	Object.defineProperty(tagged, kEnrichedModel, {
		value: result,
		enumerable: false,
		configurable: true,
		writable: true,
	});
	return result;
}

/**
 * Returns a copy of the model with thinking metadata recomputed from the
 * canonical rules, replacing any existing `thinking`.
 */
export function refreshModelThinking<TApi extends Api>(model: ApiModel<TApi>): ApiModel<TApi> {
	if (!model.reasoning) {
		const normalizedThinking = normalizeThinkingConfig(model.thinking);
		return normalizedThinking === undefined && model.thinking === undefined
			? model
			: { ...model, thinking: undefined };
	}
	return { ...model, thinking: inferModelThinking(model) };
}

/**
 * Apply upstream metadata corrections to a mutable array of models.
 *
 * Each model is first normalized through `refreshModelThinking()` so generated
 * catalogs keep canonical thinking metadata and policy fixes in one pass.
 */
export function applyGeneratedModelPolicies(models: ApiModel<Api>[]): void {
	for (let index = 0; index < models.length; index++) {
		const model = refreshModelThinking(models[index]!);
		applyGeneratedModelPolicy(model);
		models[index] = model;
	}
}

/**
 * Link OpenAI model variants to their context promotion targets.
 *
 * When a model's context is exhausted, the agent can promote to a sibling
 * model with a larger context window on the same provider:
 * - `OpenAI code backend-spark` variants promote to `gpt-5.5`.
 *
 * `gpt-5.5` itself is a 400K-context model and is not demoted to `gpt-5.4`
 * (which has a smaller window), so it has no promotion target.
 */
export function linkOpenAIPromotionTargets(models: ApiModel<Api>[]): void {
	for (const candidate of models) {
		const parsedCandidate = parseKnownModel(candidate.id);
		if (parsedCandidate.family !== "openai") continue;
		let targetId: string | undefined;
		if (parsedCandidate.variant === "codex-spark") {
			targetId = "gpt-5.5";
		} else {
			continue;
		}
		const fallback = models.find(
			model => model.provider === candidate.provider && model.api === candidate.api && model.id === targetId,
		);
		if (!fallback) continue;
		candidate.contextPromotionTarget = `${fallback.provider}/${fallback.id}`;
	}
}

/**
 * Returns the supported thinking efforts declared on the model metadata.
 *
 * Catalog enrichment is responsible for normalizing bundled model metadata up front.
 * Runtime callers must treat explicit `model.thinking` on custom models as authoritative
 * so proxy-specific overrides from `models.yml` survive request construction.
 *
 * @throws Error when a reasoning-capable model is missing thinking metadata
 */
export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (!model.reasoning) {
		return [];
	}
	if (!model.thinking) {
		throw new Error(`Model ${model.provider}/${model.id} is missing thinking metadata`);
	}
	return expandEffortRange(model.thinking);
}

/**
 * Clamps a requested thinking level against explicit model metadata.
 *
 * Non-reasoning models always resolve to `undefined`.
 */
export function clampThinkingLevelForModel<TApi extends Api>(
	model: ApiModel<TApi> | undefined,
	requested: Effort | undefined,
): Effort | undefined {
	if (!model) {
		return requested;
	}
	if (!model.reasoning || requested === undefined) {
		return undefined;
	}

	const levels = getSupportedEfforts(model);
	if (levels.includes(requested)) {
		return requested;
	}

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) {
		return undefined;
	}

	let clamped: Effort | undefined;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) {
			break;
		}
		clamped = effort;
	}

	return clamped ?? levels[0];
}

export function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort {
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	}
	const levels = getSupportedEfforts(model);
	if (!levels.includes(effort)) {
		throw new Error(
			`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}. Supported efforts: ${levels.join(", ")}`,
		);
	}
	return effort;
}

/** Maps a normalized thinking effort to Google's `thinkingLevel` enum values. */
export function mapEffortToGoogleThinkingLevel<TApi extends Api>(
	model: ApiModel<TApi>,
	effort: Effort,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	switch (requireSupportedEffort(model, effort)) {
		case Effort.Minimal:
			return "MINIMAL";
		case Effort.Low:
			return "LOW";
		case Effort.Medium:
			return "MEDIUM";
		case Effort.High:
		case Effort.XHigh:
		case Effort.Max:
			return "HIGH";
	}
}

/** Maps a normalized thinking effort to Anthropic adaptive effort values. */
export function mapEffortToAnthropicAdaptiveEffort<TApi extends Api>(
	model: ApiModel<TApi>,
	effort: Effort,
): "low" | "medium" | "high" | "xhigh" | "max" {
	switch (requireSupportedEffort(model, effort)) {
		case Effort.Minimal:
		case Effort.Low:
			return "low";
		case Effort.Medium:
			return "medium";
		case Effort.High:
			return "high";
		case Effort.XHigh:
		case Effort.Max:
			return effort === Effort.XHigh ? "xhigh" : "max";
	}
}

/**
 * Returns true for Anthropic models with Opus 4.7 API restrictions:
 * - Sampling parameters (temperature/top_p/top_k) return 400 error
 * - Thinking content is omitted by default (needs display: "summarized")
 */
export function hasOpus47ApiRestrictions(modelId: string): boolean {
	const parsed = parseAnthropicModel(getCanonicalModelId(modelId));
	if (!parsed) return false;
	return semverGte(parsed.version, "4.7") && parsed.kind === "opus";
}

function anthropicModelHasRealXHighEffort<TApi extends Api>(model: ApiModel<TApi>): boolean {
	if (model.api !== "anthropic-messages") return false;
	const parsedModel = parseKnownModel(model.id);
	if (parsedModel.family !== "anthropic" || parsedModel.kind !== "opus") return false;
	return semverGte(parsedModel.version, "4.7");
}

function applyGeneratedModelPolicy(model: ApiModel<Api>): void {
	const copilotLimits = model.provider === "github-copilot" ? COPILOT_GENERATED_LIMITS[model.id] : undefined;
	if (copilotLimits) {
		model.contextWindow = copilotLimits.contextWindow;
		model.maxTokens = copilotLimits.maxTokens;
	}

	if (
		model.api === "openai-completions" &&
		(model.provider === "minimax-code" || model.provider === "minimax-code-cn")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		};
		delete model.compat.thinkingFormat;
	}
	model.name = scrubGeneratedModelName(model.name);
	if (
		model.api === "openai-completions" &&
		model.provider === "opencode-go" &&
		(model.id === "deepseek-v4-flash" || model.id === "deepseek-v4-pro")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsToolChoice: false,
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
		};
	}
	const parsedModel = parseKnownModel(model.id);
	const applyPatchToolType = inferGeneratedApplyPatchToolType(model, parsedModel);
	if (applyPatchToolType) {
		model.applyPatchToolType = applyPatchToolType;
	} else {
		delete model.applyPatchToolType;
	}
	if (
		(model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
		isClaudeForcedToolChoiceIncapableModelId(model.id)
	) {
		// Claude Mythos accepts tools but rejects forced tool use (Anthropic
		// 400: "tool_choice forces tool use is not compatible with this model").
		model.compat = { ...(model.compat ?? {}), toolChoiceSupport: "auto" } as typeof model.compat;
	}
	if (parsedModel.family === "anthropic") {
		applyAnthropicCatalogPolicy(model, parsedModel);
	}
	if (parsedModel.family === "openai") {
		applyOpenAICatalogPolicy(model, parsedModel);
	}
	// GLM-5.2 (Zhipu/ZAI): ships a 1M lossless context window, but the bundled
	// catalog copied GLM-5.1's 200K and that stale value survives generate-models
	// (provider-scoped models bypass the models.dev refresh in applyGlobalModelsDevFallback).
	// Pin to the true 1M so context-cap / auto-compaction thresholds aren't tripped ~5x early.
	if (model.provider === "zai" && model.id === "glm-5.2") {
		model.contextWindow = 1_000_000;
	}
	// MiniMax-M3: official MiniMax docs (platform.minimax.io/docs/guides/models-intro)
	// document a 1M context window, but models.dev and the bundled catalog both report
	// 512K. The stale 512K survives generate-models (provider-scoped models bypass the
	// models.dev refresh in applyGlobalModelsDevFallback), tripping auto-compaction /
	// context-cap thresholds 2x early on MiniMax sessions. Pin to the true 1M.
	if (model.provider !== "opencode-go" && model.id === "minimax-m3") {
		model.contextWindow = 1_000_000;
	}
}

function scrubGeneratedModelName(name: string): string {
	return name
		.replaceAll("Claude", "Anthropic")
		.replaceAll("claude", "anthropic")
		.replaceAll("Codex", "OpenAI code")
		.replaceAll("codex", "openai-code");
}

function applyAnthropicCatalogPolicy(model: ApiModel<Api>, parsedModel: AnthropicModel): void {
	// Anthropic model Opus 4.5: models.dev reports 3x the correct cache pricing.
	if (model.provider === "anthropic" && parsedModel.kind === "opus" && semverEqual(parsedModel.version, "4.5")) {
		model.cost.cacheRead = 0.5;
		model.cost.cacheWrite = 6.25;
	}

	// Bedrock Opus 4.6: upstream metadata is stale for cache pricing and context.
	if (model.provider === "amazon-bedrock" && parsedModel.kind === "opus" && semverEqual(parsedModel.version, "4.6")) {
		model.cost.cacheRead = 0.5;
		model.cost.cacheWrite = 6.25;
		model.contextWindow = 1000000;
		model.maxTokens = 128000;
	}
}

function inferGeneratedApplyPatchToolType(
	model: ApiModel<Api>,
	parsedModel: ParsedModel,
): ApiModel<Api>["applyPatchToolType"] {
	if (parsedModel.family !== "openai" || parsedModel.version.major !== 5) {
		return undefined;
	}
	if (model.provider === "openai" && model.api === "openai-responses") {
		return "freeform";
	}
	if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
		return "freeform";
	}
	return undefined;
}

function applyGpt55ContextWindow(model: ApiModel<Api>, parsedModel: OpenAIModel): boolean {
	// gpt-5.5 is a 400K-context model. OpenAI code backend discovery can omit the
	// context window, falling back to the 272K default, which incorrectly trips
	// context-cap / auto-promote thresholds (a ~272K session would look over-cap
	// and demote to gpt-5.4). Pin gpt-5.5 to its true 400K window.
	if (parsedModel.variant === "base" && semverEqual(parsedModel.version, "5.5")) {
		model.contextWindow = 400000;
		return true;
	}
	return false;
}

function applyOpenAICatalogPolicy(model: ApiModel<Api>, parsedModel: OpenAIModel): void {
	if (applyGpt55ContextWindow(model, parsedModel)) {
		return;
	}
	// OpenAI code backend models: 400K figure includes output budget; input window is 272K.
	if (parsedModel.variant.startsWith("codex") && parsedModel.variant !== "codex-spark") {
		model.contextWindow = 272000;
		return;
	}
	// GPT-5.4 mini/nano use plain OpenAI IDs on the OpenAI code backend transport, but OpenAI code backend still
	// enforces the lower prompt budget for these variants. OpenAI code backend discovery can also
	// report inconsistent priorities for the GPT-5.4 family, so normalize by parsed
	// variant instead of special-casing raw model ids.
	if (model.api === "openai-codex-responses" && semverEqual(parsedModel.version, "5.4")) {
		const normalizedPriority = CODEX_GPT_5_4_PRIORITY_BY_VARIANT[parsedModel.variant];
		if (normalizedPriority !== undefined) {
			model.priority = normalizedPriority;
		}
		if (parsedModel.variant === "mini" || parsedModel.variant === "nano") {
			model.contextWindow = 272000;
		}
	}
}

function inferDefaultEffort<TApi extends Api>(model: ApiModel<TApi>, parsedModel: ParsedModel): Effort | undefined {
	if (
		parsedModel.family === "openai" &&
		model.provider === "openai-codex" &&
		semverEqual(parsedModel.version, "5.5")
	) {
		return GPT_5_5_DEFAULT_EFFORT;
	}
	return undefined;
}

function inferModelThinking<TApi extends Api>(model: ApiModel<TApi>): ThinkingConfig {
	const parsedModel = parseKnownModel(model.id);
	const efforts = inferSupportedEfforts(parsedModel, model);
	const minLevel = efforts[0];
	const maxLevel = efforts.at(-1);
	if (!minLevel || !maxLevel) {
		throw new Error(`Model ${model.provider}/${model.id} resolved to an empty thinking range`);
	}
	const config: ThinkingConfig = {
		mode: inferThinkingControlMode(model, parsedModel),
		minLevel,
		maxLevel,
	};
	const defaultLevel = inferDefaultEffort(model, parsedModel);
	if (defaultLevel && efforts.includes(defaultLevel)) {
		config.defaultLevel = defaultLevel;
	}
	// Encode explicit levels only when the inferred set has gaps the min..max range cannot represent.
	const minIndex = THINKING_EFFORTS.indexOf(minLevel);
	const maxIndex = THINKING_EFFORTS.indexOf(maxLevel);
	const expandedRange = THINKING_EFFORTS.slice(minIndex, maxIndex + 1);
	if (expandedRange.length !== efforts.length) {
		config.levels = efforts;
	}
	return config;
}

function normalizeThinkingConfig(thinking: ThinkingConfig | undefined): ThinkingConfig | undefined {
	if (!thinking || expandEffortRange(thinking).length === 0) {
		return undefined;
	}
	return thinking;
}

function thinkingsEqual(left: ThinkingConfig | undefined, right: ThinkingConfig | undefined): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	if (
		left.mode !== right.mode ||
		left.minLevel !== right.minLevel ||
		left.maxLevel !== right.maxLevel ||
		left.defaultLevel !== right.defaultLevel
	)
		return false;
	const leftLevels = left.levels;
	const rightLevels = right.levels;
	if (leftLevels === rightLevels) return true;
	if (!leftLevels || !rightLevels) return false;
	if (leftLevels.length !== rightLevels.length) return false;
	return leftLevels.every((level, index) => level === rightLevels[index]);
}

function expandEffortRange(thinking: ThinkingConfig): readonly Effort[] {
	if (thinking.levels && thinking.levels.length > 0) {
		return thinking.levels;
	}
	const minIndex = THINKING_EFFORTS.indexOf(thinking.minLevel);
	const maxIndex = THINKING_EFFORTS.indexOf(thinking.maxLevel);
	if (minIndex === -1 || maxIndex === -1 || minIndex > maxIndex) {
		return [];
	}
	return THINKING_EFFORTS.slice(minIndex, maxIndex + 1);
}

function inferSupportedEfforts<TApi extends Api>(parsedModel: ParsedModel, model: ApiModel<TApi>): readonly Effort[] {
	switch (parsedModel.family) {
		case "openai":
			return inferOpenAISupportedEfforts(parsedModel);
		case "gemini":
			return inferGeminiSupportedEfforts(parsedModel);
		case "anthropic":
			return inferAnthropicSupportedEfforts(parsedModel, model);
		case "unknown":
			return inferFallbackEfforts(model);
	}
}

function inferOpenAISupportedEfforts(model: OpenAIModel): readonly Effort[] {
	if (model.variant === "codex-mini" && semverEqual(model.version, "5.1")) {
		return GPT_5_1_CODEX_MINI_EFFORTS;
	}
	if (semverGte(model.version, "5.2")) {
		return GPT_5_2_PLUS_EFFORTS;
	}
	return DEFAULT_REASONING_EFFORTS;
}

function inferGeminiSupportedEfforts(model: GeminiModel): readonly Effort[] {
	if (!semverGte(model.version, "3.0")) {
		return DEFAULT_REASONING_EFFORTS;
	}
	return model.kind === "pro" ? GEMINI_3_PRO_EFFORTS : GEMINI_3_FLASH_EFFORTS;
}

function inferAnthropicSupportedEfforts<TApi extends Api>(
	parsedModel: AnthropicModel,
	model: ApiModel<TApi>,
): readonly Effort[] {
	if (
		(model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") &&
		semverGte(parsedModel.version, "4.6")
	) {
		if (parsedModel.kind !== "opus") return DEFAULT_REASONING_EFFORTS;
		return anthropicModelHasRealXHighEffort(model)
			? DEFAULT_REASONING_EFFORTS_WITH_XHIGH_AND_MAX
			: DEFAULT_REASONING_EFFORTS_WITH_MAX;
	}
	return inferFallbackEfforts(model);
}

function inferFallbackEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (model.api === "anthropic-messages") {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	if (model.name.includes("deepseek-v4")) {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	if (model.api === "bedrock-converse-stream") {
		return DEFAULT_REASONING_EFFORTS;
	}
	if (model.api === "openai-completions") {
		const compat = resolveOpenAICompat(model as ApiModel<"openai-completions">);
		if (compat.thinkingFormat === "openai" && compat.supportsReasoningEffort) {
			return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
		}
		return DEFAULT_REASONING_EFFORTS;
	}
	// OpenAI Responses APIs encode discrete effort levels, including xhigh.
	if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	return DEFAULT_REASONING_EFFORTS;
}

function inferThinkingControlMode<TApi extends Api>(
	model: ApiModel<TApi>,
	parsedModel: ParsedModel,
): ThinkingConfig["mode"] {
	switch (model.api) {
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return parsedModel.family === "gemini" &&
				semverGte(parsedModel.version, "3.0") &&
				parsedModel.version.major === 3
				? "google-level"
				: "budget";

		case "anthropic-messages":
			if (parsedModel.family === "anthropic") {
				if (semverGte(parsedModel.version, "4.6")) {
					return "anthropic-adaptive";
				}
				if (semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			return "budget";

		case "bedrock-converse-stream":
			if (parsedModel.family === "anthropic") {
				if (semverGte(parsedModel.version, "4.6") && parsedModel.kind === "opus") {
					return "anthropic-adaptive";
				}
				if (semverGte(parsedModel.version, "4.5")) {
					return "anthropic-budget-effort";
				}
			}
			return "budget";

		default:
			return "effort";
	}
}

function parseKnownModel(modelId: string): ParsedModel {
	const canonicalId = getCanonicalModelId(modelId);
	return (
		parseGeminiModel(canonicalId) ??
		parseAnthropicModel(canonicalId) ??
		parseOpenAIModel(canonicalId) ?? { family: "unknown", id: canonicalId }
	);
}

const GEMINI_SUFFIX = "-preview";
function parseGeminiModel(modelId: string): GeminiModel | null {
	if (modelId.endsWith(GEMINI_SUFFIX)) {
		modelId = modelId.slice(0, -GEMINI_SUFFIX.length);
	}
	const match = /gemini-(\d+(?:\.\d+){0,2})-(pro|flash)\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "gemini", kind: match[2] as GeminiKind, version };
}

function parseAnthropicModel(modelId: string): AnthropicModel | null {
	const match = /claude-(opus|sonnet)-(\d{1,2}(?:[.-]\d{1,2}){0,2})\b/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[2]);
	if (!version) {
		return null;
	}
	return { family: "anthropic", kind: match[1] as AnthropicKind, version };
}

function parseOpenAIModel(modelId: string): OpenAIModel | null {
	const match = /gpt-(\d+(?:\.\d+){0,2})(?:-(codex-spark|codex-mini|codex-max|codex|mini|max|nano))?$/.exec(modelId);
	if (!match) {
		return null;
	}
	const version = parseSemVer(match[1]);
	if (!version) {
		return null;
	}
	return { family: "openai", variant: (match[2] as OpenAIVariant | undefined) ?? "base", version };
}

function createSemVer(major: number, minor: number, patch = 0): SemVer {
	return { major, minor, patch };
}

// extend this table if we need anything more than 9.10
const precomputeTable: Record<string, SemVer> = {};
for (let major = 0; major <= 9; major++) {
	for (let minor = 0; minor <= 10; minor++) {
		const version = createSemVer(major, minor, 0);
		precomputeTable[`${major}.${minor}`] = version;
		precomputeTable[`${major}-${minor}`] = version;
	}
	precomputeTable[`${major}`] = createSemVer(major, 0, 0);
}

function parseSemVer(version: string): SemVer | null {
	return precomputeTable[version] ?? null;
}

function semverGte(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) >= 0;
}

function semverEqual(left: SemVer | string, right: SemVer | string): boolean {
	return compareSemVer(left, right) === 0;
}

function compareSemVer(left: SemVer | string | null, right: SemVer | string | null): number {
	left = typeof left === "string" ? parseSemVer(left) : left;
	right = typeof right === "string" ? parseSemVer(right) : right;
	if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);

	if (left.major !== right.major) {
		return left.major - right.major;
	}
	if (left.minor !== right.minor) {
		return left.minor - right.minor;
	}
	return left.patch - right.patch;
}

function getCanonicalModelId(modelId: string): string {
	const p = modelId.lastIndexOf("/");
	return p !== -1 ? modelId.slice(p + 1) : modelId;
}
