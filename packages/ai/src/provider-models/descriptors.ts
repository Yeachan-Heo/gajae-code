/**
 * Unified provider descriptors — single source of truth for provider metadata
 * used by both runtime model discovery (model-registry.ts) and catalog
 * generation (generate-models.ts).
 */
import type { ModelManagerOptions } from "../model-manager";
import type { Api, KnownProvider } from "../types";
import type { OAuthProvider } from "../utils/oauth/types";
import { googleModelManagerOptions } from "./google";
import { ollamaCloudModelManagerOptions } from "./ollama";
import {
	alibabaTokenPlanModelManagerOptions,
	anthropicModelManagerOptions,
	cerebrasModelManagerOptions,
	cloudflareAiGatewayModelManagerOptions,
	deepinfraModelManagerOptions,
	deepseekModelManagerOptions,
	firepassModelManagerOptions,
	fireworksModelManagerOptions,
	fuguModelManagerOptions,
	githubCopilotModelManagerOptions,
	groqModelManagerOptions,
	huggingfaceModelManagerOptions,
	kiloModelManagerOptions,
	kimiCodeModelManagerOptions,
	litellmModelManagerOptions,
	lmStudioModelManagerOptions,
	mistralModelManagerOptions,
	moonshotModelManagerOptions,
	nanoGptModelManagerOptions,
	nvidiaModelManagerOptions,
	ollamaModelManagerOptions,
	openaiModelManagerOptions,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
	openrouterModelManagerOptions,
	qianfanModelManagerOptions,
	qwenPortalModelManagerOptions,
	syntheticModelManagerOptions,
	togetherModelManagerOptions,
	veniceModelManagerOptions,
	vercelAiGatewayModelManagerOptions,
	vllmModelManagerOptions,
	xaiModelManagerOptions,
	xiaomiModelManagerOptions,
	zenmuxModelManagerOptions,
} from "./openai-compat";
import { cursorModelManagerOptions, glmZcodeModelManagerOptions, zaiModelManagerOptions } from "./special";

/** Catalog discovery configuration for providers that support endpoint-based model listing. */
export interface CatalogDiscoveryConfig {
	/** Human-readable name for log messages. */
	label: string;
	/** Environment variables to check for API keys during catalog generation. */
	envVars: string[];
	/** OAuth provider for credential refresh during catalog generation. */
	oauthProvider?: OAuthProvider;
	/** When true, catalog discovery proceeds even without credentials. */
	allowUnauthenticated?: boolean;
}

/** Unified provider descriptor used by both runtime discovery and catalog generation. */
export interface ProviderDescriptor {
	providerId: KnownProvider;
	createModelManagerOptions(config: { apiKey?: string; baseUrl?: string }): ModelManagerOptions<Api>;
	/** Preferred model ID when no explicit selection is made. */
	defaultModel: string;
	/** When true, the runtime creates a model manager even without a valid API key (e.g. ollama). */
	allowUnauthenticated?: boolean;
	/** Catalog discovery configuration. Only providers with this field participate in generate-models.ts. */
	catalogDiscovery?: CatalogDiscoveryConfig;
}

/** A provider descriptor that has catalog discovery configured. */
export type CatalogProviderDescriptor = ProviderDescriptor & { catalogDiscovery: CatalogDiscoveryConfig };

/** Type guard for descriptors with catalog discovery. */
export function isCatalogDescriptor(d: ProviderDescriptor): d is CatalogProviderDescriptor {
	return d.catalogDiscovery != null;
}

/** Whether catalog discovery may run without provider credentials. */
export function allowsUnauthenticatedCatalogDiscovery(descriptor: CatalogProviderDescriptor): boolean {
	return descriptor.catalogDiscovery.allowUnauthenticated ?? descriptor.allowUnauthenticated ?? false;
}

function descriptor(
	providerId: KnownProvider,
	defaultModel: string,
	createModelManagerOptions: ProviderDescriptor["createModelManagerOptions"],
	options: Pick<ProviderDescriptor, "allowUnauthenticated"> = {},
): ProviderDescriptor {
	return {
		providerId,
		defaultModel,
		createModelManagerOptions,
		...options,
	};
}

function catalog(
	label: string,
	envVars: string[],
	options: Pick<CatalogDiscoveryConfig, "oauthProvider" | "allowUnauthenticated"> = {},
): CatalogDiscoveryConfig {
	return {
		label,
		envVars,
		...options,
	};
}

function catalogDescriptor(
	providerId: KnownProvider,
	defaultModel: string,
	createModelManagerOptions: ProviderDescriptor["createModelManagerOptions"],
	catalogDiscovery: CatalogDiscoveryConfig,
	options: Pick<ProviderDescriptor, "allowUnauthenticated"> = {},
): ProviderDescriptor {
	return {
		...descriptor(providerId, defaultModel, createModelManagerOptions, options),
		catalogDiscovery,
	};
}

/**
 * All standard providers. Special providers (google-antigravity, google-gemini-cli,
 * OpenAI code provider) are handled separately because they require different config shapes.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
	descriptor("anthropic", "claude-sonnet-5", config => anthropicModelManagerOptions(config)),
	catalogDescriptor(
		"alibaba-token-plan",
		"deepseek-v4-pro",
		config => alibabaTokenPlanModelManagerOptions(config),
		catalog("Alibaba Token Plan", ["ALIBABA_TOKEN_PLAN_API_KEY"], { oauthProvider: "alibaba-token-plan" }),
	),
	descriptor("openai", "gpt-5.4", config => openaiModelManagerOptions(config)),
	descriptor("groq", "openai/gpt-oss-120b", config => groqModelManagerOptions(config)),
	catalogDescriptor(
		"huggingface",
		"deepseek-ai/DeepSeek-R1",
		config => huggingfaceModelManagerOptions(config),
		catalog("Hugging Face", ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"]),
	),
	catalogDescriptor(
		"cerebras",
		"zai-glm-4.6",
		config => cerebrasModelManagerOptions(config),
		catalog("Cerebras", ["CEREBRAS_API_KEY"]),
	),
	catalogDescriptor(
		"fireworks",
		"kimi-k2.6",
		config => fireworksModelManagerOptions(config),
		catalog("Fireworks", ["FIREWORKS_API_KEY"]),
	),
	descriptor("firepass", "kimi-k2.6-turbo", config => firepassModelManagerOptions(config)),
	catalogDescriptor(
		"fugu",
		"fugu",
		config => fuguModelManagerOptions(config),
		catalog("Sakana Fugu", ["FUGU_API_KEY"]),
	),
	descriptor("xai", "grok-4-fast-non-reasoning", config => xaiModelManagerOptions(config)),
	catalogDescriptor(
		"deepseek",
		"deepseek-v4-pro",
		config => deepseekModelManagerOptions(config),
		catalog("DeepSeek", ["DEEPSEEK_API_KEY"]),
	),
	catalogDescriptor(
		"deepinfra",
		"deepseek-ai/DeepSeek-V3.2",
		config => deepinfraModelManagerOptions(config),
		catalog("DeepInfra", ["DEEPINFRA_API_KEY"]),
	),
	descriptor("mistral", "devstral-medium-latest", config => mistralModelManagerOptions(config)),
	catalogDescriptor(
		"nvidia",
		"nvidia/llama-3.1-nemotron-70b-instruct",
		config => nvidiaModelManagerOptions(config),
		catalog("NVIDIA", ["NVIDIA_API_KEY"]),
	),
	catalogDescriptor(
		"nanogpt",
		"openai/gpt-5.4",
		config => nanoGptModelManagerOptions(config),
		catalog("NanoGPT", ["NANO_GPT_API_KEY"]),
	),
	descriptor("opencode-zen", "claude-sonnet-4-6", config => opencodeZenModelManagerOptions(config)),
	descriptor("opencode-go", "kimi-k2.5", config => opencodeGoModelManagerOptions(config)),
	catalogDescriptor(
		"openrouter",
		"openai/gpt-5.4",
		config => openrouterModelManagerOptions(config),
		catalog("OpenRouter", ["OPENROUTER_API_KEY"], { allowUnauthenticated: true }),
	),
	catalogDescriptor(
		"kilo",
		"anthropic/claude-sonnet-4.5",
		config => kiloModelManagerOptions(config),
		catalog("Kilo Gateway", ["KILO_API_KEY"], { allowUnauthenticated: true }),
	),
	catalogDescriptor(
		"vercel-ai-gateway",
		"anthropic/claude-sonnet-4-6",
		config => vercelAiGatewayModelManagerOptions(config),
		catalog("Vercel AI Gateway", ["VERCEL_AI_GATEWAY_API_KEY"], { allowUnauthenticated: true }),
	),
	catalogDescriptor(
		"ollama",
		"gpt-oss:20b",
		config => ollamaModelManagerOptions(config),
		catalog("Ollama", ["OLLAMA_API_KEY"]),
		{ allowUnauthenticated: true },
	),
	catalogDescriptor(
		"ollama-cloud",
		"gpt-oss:120b",
		config => ollamaCloudModelManagerOptions(config),
		catalog("Ollama Cloud", ["OLLAMA_CLOUD_API_KEY"], { oauthProvider: "ollama-cloud" }),
	),
	catalogDescriptor(
		"cloudflare-ai-gateway",
		"claude-sonnet-4-5",
		config => cloudflareAiGatewayModelManagerOptions(config),
		catalog("Cloudflare AI Gateway", ["CLOUDFLARE_AI_GATEWAY_API_KEY"]),
	),
	catalogDescriptor(
		"kimi-code",
		"kimi-k2.5",
		config => kimiCodeModelManagerOptions(config),
		catalog("Kimi Code", ["KIMI_API_KEY"]),
	),
	catalogDescriptor(
		"qwen-portal",
		"coder-model",
		config => qwenPortalModelManagerOptions(config),
		catalog("Qwen Portal", ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"], { oauthProvider: "qwen-portal" }),
	),
	catalogDescriptor(
		"synthetic",
		"hf:moonshotai/Kimi-K2.5",
		config => syntheticModelManagerOptions(config),
		catalog("Synthetic", ["SYNTHETIC_API_KEY"]),
	),
	catalogDescriptor(
		"venice",
		"llama-3.3-70b",
		config => veniceModelManagerOptions(config),
		catalog("Venice", ["VENICE_API_KEY"], { allowUnauthenticated: true }),
	),
	catalogDescriptor(
		"litellm",
		"claude-opus-4-6",
		config => litellmModelManagerOptions(config),
		catalog("LiteLLM", ["LITELLM_API_KEY"], { allowUnauthenticated: true }),
	),
	descriptor("lm-studio", "llama-3-8b", config => lmStudioModelManagerOptions(config), { allowUnauthenticated: true }),
	catalogDescriptor(
		"vllm",
		"gpt-oss-20b",
		config => vllmModelManagerOptions(config),
		catalog("vLLM", ["VLLM_API_KEY"], { allowUnauthenticated: true }),
	),
	catalogDescriptor(
		"moonshot",
		"kimi-k2.5",
		config => moonshotModelManagerOptions(config),
		catalog("Moonshot", ["MOONSHOT_API_KEY"]),
	),
	catalogDescriptor(
		"qianfan",
		"deepseek-v3.2",
		config => qianfanModelManagerOptions(config),
		catalog("Qianfan", ["QIANFAN_API_KEY"]),
	),
	catalogDescriptor(
		"together",
		"moonshotai/Kimi-K2.5",
		config => togetherModelManagerOptions(config),
		catalog("Together", ["TOGETHER_API_KEY"]),
	),
	catalogDescriptor(
		"xiaomi",
		"mimo-v2-flash",
		config => xiaomiModelManagerOptions(config),
		catalog("Xiaomi", ["XIAOMI_API_KEY"]),
	),
	catalogDescriptor(
		"xiaomi-token-plan-ams",
		"mimo-v2.5",
		config => xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" }),
		catalog("Xiaomi Token Plan (Europe)", ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"]),
	),
	catalogDescriptor(
		"xiaomi-token-plan-cn",
		"mimo-v2.5",
		config => xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-cn", tokenPlanRegion: "cn" }),
		catalog("Xiaomi Token Plan (China)", ["XIAOMI_TOKEN_PLAN_CN_API_KEY"]),
	),
	catalogDescriptor(
		"xiaomi-token-plan-sgp",
		"mimo-v2.5",
		config => xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-sgp", tokenPlanRegion: "sgp" }),
		catalog("Xiaomi Token Plan (Singapore)", ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"]),
	),
	catalogDescriptor(
		"zenmux",
		"anthropic/claude-opus-4.6",
		config => zenmuxModelManagerOptions(config),
		catalog("ZenMux", ["ZENMUX_API_KEY"]),
	),
	catalogDescriptor("zai", "glm-5.2", config => zaiModelManagerOptions(config), catalog("zAI", ["ZAI_API_KEY"])),
	catalogDescriptor(
		"glm-zcode",
		"glm-5.2",
		config => glmZcodeModelManagerOptions(config),
		catalog("GLM ZCode (unofficial)", ["GLM_ZCODE_API_KEY"], { oauthProvider: "glm-zcode" }),
	),
	descriptor("github-copilot", "gpt-4o", config => githubCopilotModelManagerOptions(config)),
	descriptor("google", "gemini-2.5-pro", config => googleModelManagerOptions(config)),
	catalogDescriptor(
		"cursor",
		"claude-sonnet-4-6",
		config => cursorModelManagerOptions(config),
		catalog("Cursor", ["CURSOR_API_KEY"], { oauthProvider: "cursor" }),
	),
] as const;

/** Default model IDs for all known providers, built from descriptors + special providers. */
export const DEFAULT_MODEL_PER_PROVIDER: Record<KnownProvider, string> = {
	...Object.fromEntries(PROVIDER_DESCRIPTORS.map(d => [d.providerId, d.defaultModel])),
	// Providers not in PROVIDER_DESCRIPTORS (special auth or no standard discovery)
	"azure-openai": "gpt-4.1",
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"google-antigravity": "gemini-3-pro-high",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-vertex": "gemini-3-pro-preview",
	minimax: "minimax-m3",
	"minimax-code": "minimax-m3",
	"minimax-code-cn": "minimax-m3",
	"openai-codex": "gpt-5.5",
	"gitlab-duo": "duo-chat-sonnet-4-5",
} as Record<KnownProvider, string>;
