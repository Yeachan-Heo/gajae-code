import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $credentialEnv, $env, $pickCredentialEnv, extractHttpStatusFromError } from "@gajae-code/utils";
import { getCustomApi } from "./api-registry";
import type { Effort } from "./model-thinking";
import {
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	requireSupportedEffort,
} from "./model-thinking";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { CursorOptions } from "./providers/cursor";
import { isGitLabDuoModel, streamGitLabDuo } from "./providers/gitlab-duo";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import { isKimiModel, streamKimi } from "./providers/kimi";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import { streamPiNative } from "./providers/pi-native-client";
// Heavy provider stream functions are imported lazily via register-builtins,
// which wraps each provider module in a dynamic import. This keeps the
// AWS SDK, google-auth-library, @google/genai, @bufbuild/protobuf, and
// other provider SDKs out of the CLI startup parse graph. The
// gitlab-duo / kimi / synthetic providers stay eager because their modules
// export routing predicates (isGitLabDuoModel, isKimiModel, isSyntheticModel)
// that must be callable synchronously before streaming begins, and their
// modules are thin wrappers with no heavy SDK dependencies.
import {
	streamAnthropic,
	streamAzureOpenAIResponses,
	streamBedrock,
	streamCursor,
	streamGoogle,
	streamGoogleGeminiCli,
	streamGoogleVertex,
	streamOllama,
	streamOpenAICodexResponses,
	streamOpenAICompletions,
	streamOpenAIResponses,
} from "./providers/register-builtins";
import { isSyntheticModel, streamSynthetic } from "./providers/synthetic";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	OptionsForApi,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ToolChoice,
} from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { isFoundryEnabled } from "./utils/foundry";

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		const gacPath = $credentialEnv("GOOGLE_APPLICATION_CREDENTIALS");
		if (gacPath) {
			cachedVertexAdcCredentialsExists = fs.existsSync(gacPath);
		} else {
			cachedVertexAdcCredentialsExists = fs.existsSync(
				path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

type KeyResolver = string | (() => string | undefined);

const serviceProviderMap: Record<string, KeyResolver> = {
	"alibaba-coding-plan": "ALIBABA_CODING_PLAN_API_KEY",
	openai: () => $credentialEnv("OPENAI_API_KEY"),
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	firepass: "FIREPASS_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	kilo: "KILO_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-code": "MINIMAX_CODE_API_KEY",
	"minimax-code-cn": "MINIMAX_CODE_CN_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	"opencode-zen": "OPENCODE_API_KEY",
	cursor: "CURSOR_ACCESS_TOKEN",
	deepseek: "DEEPSEEK_API_KEY",
	"openai-codex": "OPENAI_CODEX_OAUTH_TOKEN",
	"azure-openai": "AZURE_OPENAI_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	exa: "EXA_API_KEY",
	jina: "JINA_API_KEY",
	brave: "BRAVE_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
	tavily: "TAVILY_API_KEY",
	parallel: "PARALLEL_API_KEY",
	kagi: "KAGI_API_KEY",
	// GitHub Copilot uses GitHub personal access token
	"github-copilot": () => $pickCredentialEnv("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"),
	// Foundry mode optionally switches Anthropic auth to enterprise gateway credentials.
	anthropic: () =>
		isFoundryEnabled()
			? $pickCredentialEnv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
			: $pickCredentialEnv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"),
	"gitlab-duo": "GITLAB_TOKEN",
	// Vertex AI supports either GOOGLE_CLOUD_API_KEY or Application Default Credentials.
	"google-vertex": () => {
		const googleCloudApiKey = $credentialEnv("GOOGLE_CLOUD_API_KEY");
		if (googleCloudApiKey) return googleCloudApiKey;

		const hasCredentials = hasVertexAdcCredentials();
		const hasProject = !!($env.GOOGLE_CLOUD_PROJECT || $env.GCLOUD_PROJECT);
		const hasLocation = !!$env.GOOGLE_CLOUD_LOCATION;
		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	},
	// Amazon Bedrock supports multiple credential sources:
	// 1. AWS_PROFILE - named profile from ~/.aws/credentials
	// 2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY - standard IAM keys
	// 3. AWS_BEARER_TOKEN_BEDROCK - Bedrock API keys (bearer token)
	// 4. AWS_CONTAINER_CREDENTIALS_* - ECS/Task IAM role credentials
	// 5. AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN - IRSA (EKS) web identity
	"amazon-bedrock": () => {
		const awsProfile = $credentialEnv("AWS_PROFILE");
		const awsAccessKeyId = $credentialEnv("AWS_ACCESS_KEY_ID");
		const awsSecretAccessKey = $credentialEnv("AWS_SECRET_ACCESS_KEY");
		const awsBearerToken = $credentialEnv("AWS_BEARER_TOKEN_BEDROCK");
		const hasEcsCredentials =
			!!$credentialEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
			!!$credentialEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI");
		const hasWebIdentity = !!$credentialEnv("AWS_WEB_IDENTITY_TOKEN_FILE") && !!$credentialEnv("AWS_ROLE_ARN");
		if (
			awsProfile ||
			(awsAccessKeyId && awsSecretAccessKey) ||
			awsBearerToken ||
			hasEcsCredentials ||
			hasWebIdentity
		) {
			return "<authenticated>";
		}
	},
	synthetic: "SYNTHETIC_API_KEY",
	"cloudflare-ai-gateway": "CLOUDFLARE_AI_GATEWAY_API_KEY",
	huggingface: () => $pickCredentialEnv("HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"),
	litellm: "LITELLM_API_KEY",
	moonshot: "MOONSHOT_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	nanogpt: "NANO_GPT_API_KEY",
	"lm-studio": "LM_STUDIO_API_KEY",
	ollama: "OLLAMA_API_KEY",
	"ollama-cloud": "OLLAMA_CLOUD_API_KEY",
	"llama.cpp": "LLAMA_CPP_API_KEY",
	qianfan: "QIANFAN_API_KEY",
	"qwen-portal": () => $pickCredentialEnv("QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"),
	together: "TOGETHER_API_KEY",
	zenmux: "ZENMUX_API_KEY",
	venice: "VENICE_API_KEY",
	vllm: "VLLM_API_KEY",
	xiaomi: "XIAOMI_API_KEY",
};

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Provider authentication intentionally excludes cwd/.env values. Project dotenv files are
 * loaded into $env for app/tool execution, but must not silently fund GJC model requests.
 */
export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	if (typeof resolver === "string") {
		return $credentialEnv(resolver);
	}
	return resolver?.();
}

/**
 * Enumerate every provider that has an env-var fallback for `getEnvApiKey`.
 * Used by `gjc auth-broker migrate --include-env` to discover env-sourced keys
 * that should be uploaded to the broker.
 */
export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}

/**
 * Subscription-style providers whose "subscription" is delivered as an API key
 * (created at https://opencode.ai/auth), not a separate OAuth/session token.
 * Used to give OpenCode users an accurate headless auth diagnostic (#755).
 */
const OPENCODE_SUBSCRIPTION_PROVIDERS = new Set(["opencode-go", "opencode-zen"]);

/**
 * Provider-specific credential guidance appended to "no credential" errors.
 *
 * Headless GJC has no interactive `/login` TUI, so a bare "No API key" /
 * "No credentials" error left users — OpenCode Go subscribers especially
 * (#755) — unsure what signal GJC actually reads. OpenCode subscriptions are
 * themselves API keys, so this names the env var GJC reads for the provider,
 * warns that a project `.env` is intentionally ignored for provider
 * credentials, and points OpenCode users at one-time interactive CLI credential capture.
 *
 * Returns an empty string when the provider has no env-var key and no special
 * handling, so callers can append it unconditionally.
 */
export function formatProviderCredentialHint(provider: string): string {
	const resolver = serviceProviderMap[provider];
	const envVar = typeof resolver === "string" ? resolver : undefined;
	const isOpenCodeSubscription = OPENCODE_SUBSCRIPTION_PROVIDERS.has(provider);
	const parts: string[] = [];
	if (isOpenCodeSubscription) {
		parts.push(
			"OpenCode subscriptions authenticate with an API key (created at https://opencode.ai/auth), not a separate session/OAuth token.",
		);
	}
	if (envVar) {
		parts.push(
			`Headless GJC reads this provider's key from ${envVar} (exported in your shell or set in ~/.gjc/.env).`,
		);
		parts.push("A value set only in a project .env is intentionally ignored for provider credentials.");
	}
	if (isOpenCodeSubscription) {
		parts.push(
			`Or run \`gjc auth-broker login ${provider}\` once before headless/print mode to store the key interactively.`,
		);
	}
	return parts.join(" ");
}

/**
 * Build an actionable "missing API key" error for a provider, used by the
 * low-level `stream`/`complete` entry points (#755).
 */
export function formatMissingApiKeyError(provider: string): string {
	const base = `No API key for provider: ${provider}.`;
	const hint = formatProviderCredentialHint(provider);
	return hint ? `${base} ${hint}` : base;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	// Check custom API registry first (extension-provided APIs like "vertex-Anthropic model-api")
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.stream(model, context, options as StreamOptions);
	}

	if (isGitLabDuoModel(model)) {
		const apiKey = (options as StreamOptions | undefined)?.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new Error(formatMissingApiKeyError(model.provider));
		}
		return streamGitLabDuo(model, context, {
			...(options as SimpleStreamOptions | undefined),
			apiKey,
		});
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		return streamGoogleVertex(model as Model<"google-vertex">, context, options as GoogleVertexOptions);
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		return streamBedrock(model as Model<"bedrock-converse-stream">, context, (options || {}) as BedrockOptions);
	}

	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(formatMissingApiKeyError(model.provider));
	}
	const providerOptions = { ...options, apiKey };

	const api: Api = model.api;
	switch (api) {
		case "anthropic-messages": {
			const anthropicOptions = providerOptions as AnthropicOptions;
			return streamAnthropic(model as Model<"anthropic-messages">, context, {
				...anthropicOptions,
				isOAuth: anthropicOptions.isOAuth ?? model.isOAuth,
			});
		}

		case "openai-completions":
			return streamOpenAICompletions(model as Model<"openai-completions">, context, providerOptions as any);

		case "openai-responses":
			return streamOpenAIResponses(model as Model<"openai-responses">, context, providerOptions as any);

		case "azure-openai-responses":
			return streamAzureOpenAIResponses(model as Model<"azure-openai-responses">, context, providerOptions as any);

		case "openai-codex-responses":
			return streamOpenAICodexResponses(model as Model<"openai-codex-responses">, context, providerOptions as any);

		case "google-generative-ai":
			return streamGoogle(model as Model<"google-generative-ai">, context, providerOptions);

		case "google-gemini-cli":
			return streamGoogleGeminiCli(
				model as Model<"google-gemini-cli">,
				context,
				providerOptions as GoogleGeminiCliOptions,
			);

		case "ollama-chat":
			return streamOllama(model as Model<"ollama-chat">, context, providerOptions as OllamaChatOptions);

		case "cursor-agent":
			return streamCursor(model as Model<"cursor-agent">, context, providerOptions as CursorOptions);

		default:
			throw new Error(`Unhandled API: ${api}`);
	}
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

type AuthRetryFailure = {
	error: unknown;
	bufferedEvents: AssistantMessageEvent[];
	terminalEvent?: Extract<AssistantMessageEvent, { type: "error" }>;
};

function extractStatusFromAssistantError(message: AssistantMessage): number | undefined {
	if (message.errorStatus !== undefined) return message.errorStatus;
	if (!message.errorMessage) return undefined;
	return extractHttpStatusFromError({ message: message.errorMessage });
}

function createAssistantAuthError(message: AssistantMessage): Error & { status?: number } {
	const error: Error & { status?: number } = new Error(message.errorMessage ?? "Provider authentication failed");
	const status = extractStatusFromAssistantError(message);
	if (status !== undefined) error.status = status;
	return error;
}

function emitBufferedEvents(stream: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
	for (const event of events) {
		stream.push(event);
	}
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const retryApiKey = options?.onAuthError ? (options.apiKey ?? getEnvApiKey(model.provider)) : undefined;
	if (retryApiKey) {
		const outer = new AssistantMessageEventStream();
		const onAuthError = options!.onAuthError!;
		const runAttempt = async (apiKey: string, captureAuthFailure: boolean): Promise<AuthRetryFailure | undefined> => {
			const bufferedEvents: AssistantMessageEvent[] = [];
			let emittedReplayUnsafeEvent = false;
			const flushBuffered = (): void => {
				emitBufferedEvents(outer, bufferedEvents);
				bufferedEvents.length = 0;
			};

			try {
				const inner = streamSimple(model, context, { ...options, apiKey, onAuthError: undefined });
				for await (const event of inner) {
					if (!emittedReplayUnsafeEvent && event.type === "start") {
						bufferedEvents.push(event);
						continue;
					}
					if (
						!emittedReplayUnsafeEvent &&
						captureAuthFailure &&
						event.type === "error" &&
						extractStatusFromAssistantError(event.error) === 401
					) {
						return { error: createAssistantAuthError(event.error), bufferedEvents, terminalEvent: event };
					}
					flushBuffered();
					emittedReplayUnsafeEvent = true;
					outer.push(event);
					if (outer.done) return undefined;
				}
				flushBuffered();
				if (!outer.done) outer.end(await inner.result());
			} catch (error) {
				if (!emittedReplayUnsafeEvent && captureAuthFailure && extractHttpStatusFromError(error) === 401) {
					return { error, bufferedEvents };
				}
				flushBuffered();
				outer.fail(error);
			}
			return undefined;
		};
		const emitFailure = (failure: AuthRetryFailure): void => {
			emitBufferedEvents(outer, failure.bufferedEvents);
			if (failure.terminalEvent) {
				outer.push(failure.terminalEvent);
			} else {
				outer.fail(failure.error);
			}
		};

		void (async () => {
			const failure = await runAttempt(retryApiKey, true);
			if (!failure) return;
			let nextKey: string | undefined;
			try {
				nextKey = await onAuthError(model.provider, retryApiKey, failure.error);
			} catch {
				nextKey = undefined;
			}
			if (!nextKey || nextKey === retryApiKey) {
				emitFailure(failure);
				return;
			}
			await runAttempt(nextKey, false);
		})();
		return outer;
	}

	// Pi-native transport short-circuits the per-provider dispatch entirely:
	// the gateway resolves provider + credential server-side, so we don't
	// need an `apiKey` from `getEnvApiKey` here — `options.apiKey` carries
	// the gateway bearer instead. Comes BEFORE the custom-API check so
	// extension-registered APIs can't accidentally override a configured
	// pi-native transport.
	if (model.transport === "pi-native") {
		return streamPiNative(model, context, options);
	}

	// Check custom API registry (extension-provided APIs)
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.streamSimple(model, context, options);
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		const providerOptions = mapOptionsForApi(model, options, undefined);
		return stream(model, context, providerOptions);
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		const providerOptions = mapOptionsForApi(model, options, undefined);
		return stream(model, context, providerOptions);
	}

	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(formatMissingApiKeyError(model.provider));
	}

	// GitLab Duo - wraps Anthropic/OpenAI behind GitLab AI Gateway direct access tokens
	if (isGitLabDuoModel(model)) {
		return streamGitLabDuo(model, context, {
			...options,
			apiKey,
		});
	}

	// Kimi Code - route to dedicated handler that wraps OpenAI or Anthropic API
	if (isKimiModel(model)) {
		// Pass raw SimpleStreamOptions - streamKimi handles mapping internally
		return streamKimi(model as Model<"openai-completions">, context, {
			...options,
			apiKey,
			format: options?.kimiApiFormat ?? "anthropic",
		});
	}

	// Synthetic - route to dedicated handler that wraps OpenAI or Anthropic API
	if (isSyntheticModel(model)) {
		// Pass raw SimpleStreamOptions - streamSynthetic handles mapping internally
		return streamSynthetic(model as Model<"openai-completions">, context, {
			...options,
			apiKey,
			format: options?.syntheticApiFormat ?? "openai", // Default to OpenAI format
		});
	}

	const providerOptions = mapOptionsForApi(model, options, apiKey);
	return stream(model, context, providerOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}

const MIN_OUTPUT_TOKENS = 1024;
export const OUTPUT_FALLBACK_BUFFER = 4000;
const ANTHROPIC_USE_INTERLEAVED_THINKING = Bun.env.PI_NO_INTERLEAVED_THINKING !== "1";

export const ANTHROPIC_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 65536,
};

const GOOGLE_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 24575,
	max: 24575,
};

const BEDROCK_CLAUDE_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 32768,
};

function resolveBedrockThinkingBudget(
	model: Model<"bedrock-converse-stream">,
	options?: SimpleStreamOptions,
): { budget: number; level: Effort } | null {
	if (!options?.reasoning || !model.reasoning) return null;
	const level = requireSupportedEffort(model, options.reasoning);
	const budget = options.thinkingBudgets?.[level] ?? BEDROCK_CLAUDE_THINKING[level];
	return { budget, level };
}

export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "tool", name: choice.name } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}

function mapGoogleToolChoice(
	choice?: ToolChoice,
): GoogleOptions["toolChoice"] | GoogleGeminiCliOptions["toolChoice"] | GoogleVertexOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	return "any";
}

function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

function resolveOpenAiReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): Effort | undefined {
	const reasoning = options?.reasoning;
	if (!reasoning || !model.reasoning) return undefined;
	return requireSupportedEffort(model, reasoning);
}

const castApi = <TApi extends Api>(api: OptionsForApi<TApi>): OptionsForApi<Api> => api as OptionsForApi<Api>;

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const base = {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		cacheRetention: options?.cacheRetention ?? model.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		requestMaxRetries: options?.requestMaxRetries,
		streamMaxRetries: options?.streamMaxRetries,
		metadata: options?.metadata,
		sessionId: options?.sessionId,
		providerSessionState: options?.providerSessionState,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onSseEvent: options?.onSseEvent,
		execHandlers: options?.execHandlers,
	};

	switch (model.api) {
		case "anthropic-messages": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning) {
				return castApi<"anthropic-messages">({
					...base,
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			let thinkingBudget = options.thinkingBudgets?.[reasoning] ?? ANTHROPIC_THINKING[reasoning];
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			// For Opus 4.6+ and Sonnet 4.6+: use adaptive thinking with effort level
			// For older models: use budget-based thinking
			if (model.thinking?.mode === "anthropic-adaptive") {
				const effort = mapEffortToAnthropicAdaptiveEffort(model, reasoning);
				return castApi<"anthropic-messages">({
					...base,
					thinkingEnabled: true,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			if (ANTHROPIC_USE_INTERLEAVED_THINKING) {
				return castApi<"anthropic-messages">({
					...base,
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			// Caller's maxTokens is the desired output; add thinking budget on top, capped at model limit
			const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, model.maxTokens);

			// If not enough room for thinking + output, reduce thinking budget
			if (maxTokens <= thinkingBudget) {
				thinkingBudget = maxTokens - MIN_OUTPUT_TOKENS;
			}

			// If thinking budget is too low, disable thinking
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			} else {
				return castApi<"anthropic-messages">({
					...base,
					maxTokens,
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}
		}

		case "bedrock-converse-stream": {
			const bedrockBase: BedrockOptions = {
				...base,
				reasoning: options?.reasoning,
				thinkingBudgets: options?.thinkingBudgets,
				toolChoice: mapAnthropicToolChoice(options?.toolChoice),
				thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
			};
			// Adaptive mode sends effort directly, no budget_tokens — skip budget inflation.
			if (model.thinking?.mode === "anthropic-adaptive") {
				return castApi<"bedrock-converse-stream">(bedrockBase);
			}
			const budgetInfo = resolveBedrockThinkingBudget(model as Model<"bedrock-converse-stream">, options);
			if (!budgetInfo) return bedrockBase as OptionsForApi<TApi>;
			let maxTokens = bedrockBase.maxTokens ?? model.maxTokens;
			let thinkingBudgets = bedrockBase.thinkingBudgets;
			if (maxTokens <= budgetInfo.budget) {
				const desiredMaxTokens = Math.min(model.maxTokens, budgetInfo.budget + MIN_OUTPUT_TOKENS);
				if (desiredMaxTokens > maxTokens) {
					maxTokens = desiredMaxTokens;
				}
			}
			if (maxTokens <= budgetInfo.budget) {
				const adjustedBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				thinkingBudgets = { ...(thinkingBudgets ?? {}), [budgetInfo.level]: adjustedBudget };
			}
			return castApi<"bedrock-converse-stream">({ ...bedrockBase, maxTokens, thinkingBudgets });
		}

		case "openai-completions":
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
			});

		case "openai-responses":
			return castApi<"openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
			});

		case "azure-openai-responses":
			return castApi<"azure-openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
			});

		case "openai-codex-responses":
			return castApi<"openai-codex-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				preferWebsockets: options?.preferWebsockets,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
			});

		case "google-generative-ai": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			// This is needed because Gemini has "dynamic thinking" enabled by default
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning) {
				return castApi<"google-generative-ai">({
					...base,
					thinking: { enabled: false },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			const googleModel = model as Model<"google-generative-ai">;
			const effort = requireSupportedEffort(googleModel, reasoning);

			// Gemini 3+ models use thinkingLevel exclusively instead of thinkingBudget.
			// https://ai.google.dev/gemini-api/docs/thinking#set-budget
			if (googleModel.thinking?.mode === "google-level") {
				return castApi<"google-generative-ai">({
					...base,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(googleModel, effort),
					},
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			return castApi<"google-gemini-cli">({
				...base,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(googleModel, effort, options?.thinkingBudgets),
				},
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
			});
		}

		case "google-gemini-cli": {
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning) {
				return castApi<"google-gemini-cli">({
					...base,
					thinking: { enabled: false },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			const effort = requireSupportedEffort(model, reasoning);

			// Gemini 3+ models use thinkingLevel instead of thinkingBudget
			if (model.thinking?.mode === "google-level") {
				return castApi<"google-gemini-cli">({
					...base,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(model, effort),
					},
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			let thinkingBudget = options.thinkingBudgets?.[effort] ?? GOOGLE_THINKING[effort];

			// Caller's maxTokens is the desired output; add thinking budget on top, capped at model limit
			const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, model.maxTokens);

			// If not enough room for thinking + output, reduce thinking budget
			if (maxTokens <= thinkingBudget) {
				thinkingBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS) ?? 0;
			}

			// If thinking budget is too low, disable thinking
			if (thinkingBudget <= 0) {
				return castApi<"google-gemini-cli">({
					...base,
					thinking: { enabled: false },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			} else {
				return castApi<"google-gemini-cli">({
					...base,
					maxTokens,
					thinking: { enabled: true, budgetTokens: thinkingBudget },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}
		}

		case "google-vertex": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning) {
				return castApi<"google-vertex">({
					...base,
					thinking: { enabled: false },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			const vertexModel = model as Model<"google-vertex">;
			const effort = requireSupportedEffort(vertexModel, reasoning);
			const geminiModel = vertexModel as unknown as Model<"google-generative-ai">;

			if (geminiModel.thinking?.mode === "google-level") {
				return castApi<"google-vertex">({
					...base,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(geminiModel, effort),
					},
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			return castApi<"google-vertex">({
				...base,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(geminiModel, effort, options?.thinkingBudgets),
				},
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
			});
		}

		case "ollama-chat":
			return castApi<"ollama-chat">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: options?.toolChoice,
			});

		case "cursor-agent": {
			const execHandlers = options?.cursorExecHandlers ?? options?.execHandlers;
			const onToolResult = options?.cursorOnToolResult ?? execHandlers?.onToolResult;
			return castApi<"cursor-agent">({
				...base,
				execHandlers,
				onToolResult,
			});
		}

		default:
			throw new Error(`Unhandled API in mapOptionsForApi: ${model.api}`);
	}
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: Effort,
	customBudgets?: ThinkingBudgets,
): number {
	requireSupportedEffort(model, effort);

	// Custom budgets take precedence if provided for this level
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	// See https://ai.google.dev/gemini-api/docs/thinking#set-budget
	if (model.id.includes("2.5-")) {
		switch (effort) {
			case "minimal":
				return 128;
			case "low":
				return 2048;
			case "medium":
				return 8192;
			default:
				return model.id.includes("2.5-flash") ? 24576 : 32768;
		}
	}

	// Unknown model - use dynamic
	return -1;
}
