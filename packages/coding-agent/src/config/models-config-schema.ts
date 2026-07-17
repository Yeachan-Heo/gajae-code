import * as z from "zod/v4";
import { stringOrNonEmptyArray } from "./model-selector-value";

const OpenRouterRoutingSchema = z.object({
	only: z.array(z.string()).optional(),
	order: z.array(z.string()).optional(),
});

const VercelGatewayRoutingSchema = z.object({
	only: z.array(z.string()).optional(),
	order: z.array(z.string()).optional(),
});

const ReasoningEffortMapSchema = z.object({
	minimal: z.string().optional(),
	low: z.string().optional(),
	medium: z.string().optional(),
	high: z.string().optional(),
	xhigh: z.string().optional(),
	max: z.string().optional(),
});

export const OpenAICompatSchema = z.object({
	supportsStore: z.boolean().optional(),
	supportsDeveloperRole: z.boolean().optional(),
	sendSessionHeaders: z.boolean().optional(),
	supportsMultipleSystemMessages: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
	reasoningEffortMap: ReasoningEffortMapSchema.optional(),
	maxTokensField: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
	supportsUsageInStreaming: z.boolean().optional(),
	requiresToolResultName: z.boolean().optional(),
	requiresMistralToolIds: z.boolean().optional(),
	requiresAssistantAfterToolResult: z.boolean().optional(),
	requiresThinkingAsText: z.boolean().optional(),
	reasoningContentField: z.enum(["reasoning_content", "reasoning", "reasoning_text"]).optional(),
	requiresReasoningContentForToolCalls: z.boolean().optional(),
	allowsSyntheticReasoningContentForToolCalls: z.boolean().optional(),
	requiresAssistantContentForToolCalls: z.boolean().optional(),
	supportsToolChoice: z.boolean().optional(),
	supportsForcedToolChoice: z.boolean().optional(),
	toolChoiceSupport: z.enum(["none", "auto", "required", "named"]).optional(),
	disableReasoningOnForcedToolChoice: z.boolean().optional(),
	disableReasoningOnToolChoice: z.boolean().optional(),
	thinkingFormat: z.enum(["openai", "openrouter", "zai", "qwen", "qwen-chat-template"]).optional(),
	openRouterRouting: OpenRouterRoutingSchema.optional(),
	vercelGatewayRouting: VercelGatewayRoutingSchema.optional(),
	extraBody: z.record(z.string(), z.unknown()).optional(),
	supportsStrictMode: z.boolean().optional(),
	toolStrictMode: z.enum(["all_strict", "none"]).optional(),
});

export const GJC_MODEL_EFFORT_IDS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const GJC_MODEL_ASSIGNMENT_TARGET_IDS = ["default", "executor", "architect", "planner", "critic"] as const;
export const EffortSchema = z.enum(GJC_MODEL_EFFORT_IDS);
const CacheRetentionSchema = z.enum(["none", "short", "long"]);

const ThinkingControlModeSchema = z.enum([
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
]);

const ModelThinkingSchema = z.object({
	minLevel: EffortSchema,
	maxLevel: EffortSchema,
	mode: ThinkingControlModeSchema,
	defaultLevel: EffortSchema.optional(),
	levels: z.array(EffortSchema).optional(),
});

const RequestTransformSchema = z
	.object({
		profile: z.enum(["openai-proxy"]).optional(),
		stripHeaders: z.array(z.string().min(1)).optional(),
		setHeaders: z.record(z.string(), z.string().nullable()).optional(),
		extraBody: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

const PermissiveModelSelectorSchema = z.string().trim().min(1);

export const ModelBindingsSchema = z.object({
	modelRoles: z.record(z.string(), stringOrNonEmptyArray(PermissiveModelSelectorSchema)).optional(),
	agentModelOverrides: z.record(z.string(), stringOrNonEmptyArray(PermissiveModelSelectorSchema)).optional(),
});

export const ProfileRoleSchema = z.enum(GJC_MODEL_ASSIGNMENT_TARGET_IDS);
export const ProfileModelSelectorPattern = `^[^,/]+/[^,:]+(?::(?:${EffortSchema.options.join("|")}))?$`;

export const ProfileModelSelectorSchema = z
	.string()
	.trim()
	.min(1)
	.regex(new RegExp(ProfileModelSelectorPattern), "Expected provider/modelId with optional :effort suffix");
export const ProfileModelMappingSchema = z.partialRecord(
	ProfileRoleSchema,
	stringOrNonEmptyArray(ProfileModelSelectorSchema),
);

export const ProfileDefinitionSchema = z
	.object({
		required_providers: z.array(z.string().min(1)).min(1),
		display_name: z.string().min(1).optional(),
		model_mapping: ProfileModelMappingSchema,
	})
	.strict();

export const ProfilesSchema = z.record(z.string().min(1), ProfileDefinitionSchema);

const ModelDefinitionSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).optional(),
		api: z
			.enum([
				"openai-completions",
				"openai-responses",
				"openai-codex-responses",
				"azure-openai-responses",
				"anthropic-messages",
				"bedrock-converse-stream",
				"google-generative-ai",
				"google-vertex",
				"google-gemini-cli",
				"ollama-chat",
				"cursor-agent",
			])
			.optional(),
		baseUrl: z.string().min(1).optional(),
		reasoning: z.boolean().optional(),
		thinking: ModelThinkingSchema.optional(),
		input: z.array(z.enum(["text", "image"])).optional(),
		output: z.array(z.enum(["text", "image"])).optional(),
		cost: z
			.object({
				input: z.number(),
				output: z.number(),
				cacheRead: z.number(),
				cacheWrite: z.number(),
			})
			.optional(),
		premiumMultiplier: z.number().optional(),
		contextWindow: z.number().optional(),
		maxTokens: z.number().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		compat: OpenAICompatSchema.optional(),
		contextPromotionTarget: z.string().min(1).optional(),
		wireModelId: z.string().min(1).optional(),
		requestTransform: RequestTransformSchema.optional(),
		cacheRetention: CacheRetentionSchema.optional(),
	})
	.strict();

export const ModelOverrideSchema = z
	.object({
		name: z.string().min(1).optional(),
		reasoning: z.boolean().optional(),
		thinking: ModelThinkingSchema.optional(),
		input: z.array(z.enum(["text", "image"])).optional(),
		output: z.array(z.enum(["text", "image"])).optional(),
		cost: z
			.object({
				input: z.number().optional(),
				output: z.number().optional(),
				cacheRead: z.number().optional(),
				cacheWrite: z.number().optional(),
			})
			.optional(),
		premiumMultiplier: z.number().optional(),
		contextWindow: z.number().optional(),
		maxTokens: z.number().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		compat: OpenAICompatSchema.optional(),
		contextPromotionTarget: z.string().min(1).optional(),
		wireModelId: z.string().min(1).optional(),
		requestTransform: RequestTransformSchema.optional(),
		cacheRetention: CacheRetentionSchema.optional(),
	})
	.strict();

export type ModelOverride = z.infer<typeof ModelOverrideSchema>;

export const ProviderDiscoverySchema = z.object({
	type: z.enum(["ollama", "llama.cpp", "lm-studio", "openai-models-list"]),
});

const LocalOpenAICompatSchema = z
	.object({
		baseUrl: z.string().min(1),
		apiKey: z.string().min(1).optional(),
		apiKeyEnv: z.string().min(1).optional(),
	})
	.strict();

export const ProviderAuthSchema = z.enum(["apiKey", "none", "oauth"]);

export type ProviderAuthMode = z.infer<typeof ProviderAuthSchema>;
export type ProviderDiscovery = z.infer<typeof ProviderDiscoverySchema>;

const ProviderConfigSchema = z
	.object({
		baseUrl: z.string().min(1).optional(),
		apiKey: z.string().min(1).optional(),
		apiKeyEnv: z.string().min(1).optional(),
		api: z
			.enum([
				"openai-completions",
				"openai-responses",
				"openai-codex-responses",
				"azure-openai-responses",
				"anthropic-messages",
				"bedrock-converse-stream",
				"google-generative-ai",
				"google-vertex",
				"google-gemini-cli",
				"ollama-chat",
				"cursor-agent",
			])
			.optional(),
		headers: z.record(z.string(), z.string()).optional(),
		compat: OpenAICompatSchema.optional(),
		webSearch: z.enum(["on", "off", "auto"]).optional(),
		authHeader: z.boolean().optional(),
		auth: ProviderAuthSchema.optional(),
		discovery: ProviderDiscoverySchema.optional(),
		requestTransform: RequestTransformSchema.optional(),
		models: z.array(ModelDefinitionSchema).optional(),
		modelOverrides: z.record(z.string(), ModelOverrideSchema).optional(),
		disableStrictTools: z.boolean().optional(),
		/**
		 * Streaming transport override. When set to `"pi-native"`, gjc dispatches
		 * every model under this provider via the auth-gateway's
		 * `POST /v1/pi/stream` endpoint instead of the per-provider SDK. The
		 * provider's `baseUrl` must point at a compatible `gjc auth-gateway`
		 * and `apiKey` must carry the gateway bearer.
		 */
		transport: z.literal("pi-native").optional(),
		cacheRetention: CacheRetentionSchema.optional(),
		openaiCompat: LocalOpenAICompatSchema.optional(),
	})
	.strict();

const EquivalenceConfigSchema = z.object({
	overrides: z.record(z.string(), z.string().min(1)).optional(),
	exclude: z.array(z.string().min(1)).optional(),
});

export const ModelsConfigSchema = z
	.object({
		providers: z.record(z.string(), ProviderConfigSchema).optional(),
		modelBindings: ModelBindingsSchema.optional(),
		equivalence: EquivalenceConfigSchema.optional(),
		profiles: ProfilesSchema.optional(),
	})
	.strict();

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type ModelProfileConfig = z.infer<typeof ProfileDefinitionSchema>;
export type ModelProfilesConfig = z.infer<typeof ProfilesSchema>;
