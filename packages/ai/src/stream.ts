import * as fs from "node:fs";
import * as path from "node:path";
import {
	$credentialEnv,
	$env,
	$pickCredentialEnv,
	extractHttpStatusFromError,
	getTrustedHomeDir,
} from "@gajae-code/utils";
import {
	copyProviderSafetyStopAdapterInvocation,
	isProviderSafetyStopModelTrusted,
	withProviderSafetyStopAdapterInvocation,
} from "./adapter-internals/provider-safety-stop";
import { assertManagedAttempt, classifyFallbackTrigger, type TransportFailureFacts } from "./utils/fallback-transport";

const managedAttemptValidated = Symbol("managedAttemptValidated");

function hasValidatedManagedAttempt(options: object | undefined): boolean {
	return (options as Record<symbol, unknown> | undefined)?.[managedAttemptValidated] === true;
}

function markManagedAttemptValidated<T extends object>(options: T): T {
	return Object.assign(options, { [managedAttemptValidated]: true });
}

import { getCustomApi } from "./api-registry";
import type { Effort } from "./model-thinking";
import {
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	requireSupportedEffort,
} from "./model-thinking";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import {
	hasResolvableAwsProfileSource,
	isValidBedrockBearerToken,
	readAwsStaticEnvironmentCredentials,
} from "./providers/aws-credential-config";
import type { CursorOptions } from "./providers/cursor";
import type { GoogleOptions } from "./providers/google";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import type { KiroCodeWhispererOptions } from "./providers/kiro-codewhisperer";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
// Heavy provider stream functions are imported lazily via register-builtins,
// which wraps each provider module in a dynamic import. Thin provider routing
// modules are also loaded lazily below by returning an outer stream and piping
// the dynamically imported inner stream into it.
import {
	streamAnthropic,
	streamAzureOpenAIResponses,
	streamBedrock,
	streamCursor,
	streamGoogle,
	streamGoogleGeminiCli,
	streamGoogleVertex,
	streamKiroCodeWhisperer,
	streamOllama,
	streamOpenAICodexResponses,
	streamOpenAICompletions,
	streamOpenAIResponses,
} from "./providers/register-builtins";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AuthRetryCredential,
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
				path.join(getTrustedHomeDir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

type KeyResolver = string | (() => string | undefined);

const serviceProviderMap: Record<string, KeyResolver> = {
	"alibaba-token-plan": "ALIBABA_TOKEN_PLAN_API_KEY",
	openai: () => $credentialEnv("OPENAI_API_KEY"),
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	firepass: "FIREPASS_API_KEY",
	fugu: "FUGU_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	kilo: "KILO_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	"glm-zcode": "GLM_ZCODE_API_KEY",
	"jetbrains-junie": "JUNIE_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-code": "MINIMAX_CODE_API_KEY",
	"minimax-code-cn": "MINIMAX_CODE_CN_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	"opencode-zen": "OPENCODE_API_KEY",
	cursor: "CURSOR_ACCESS_TOKEN",
	deepseek: "DEEPSEEK_API_KEY",
	deepinfra: "DEEPINFRA_API_KEY",
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
	// Kiro API keys use the ksk_ prefix; preserve the AWS bearer fallback for OAuth.
	kiro: () => {
		const apiKey = $credentialEnv("KIRO_API_KEY");
		return apiKey?.trim().startsWith("ksk_") && !/[\x00-\x1f\x7f]/.test(apiKey)
			? apiKey
			: $credentialEnv("AWS_BEARER_TOKEN_KIRO");
	},
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
	// Advertise only credential sources implemented by the Bedrock request path.
	// ECS and IRSA remain unavailable until matching resolvers are implemented.
	"amazon-bedrock": () => {
		const bearerToken = $credentialEnv("AWS_BEARER_TOKEN_BEDROCK");
		if (bearerToken) return isValidBedrockBearerToken(bearerToken) ? "<authenticated>" : undefined;
		if (readAwsStaticEnvironmentCredentials() || hasResolvableAwsProfileSource()) {
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
	omlx: "OMLX_API_KEY",
	ollama: "OLLAMA_API_KEY",
	"ollama-cloud": "OLLAMA_CLOUD_API_KEY",
	"llama.cpp": "LLAMA_CPP_API_KEY",
	qianfan: "QIANFAN_API_KEY",
	"qwen-portal": () => $pickCredentialEnv("QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"),
	together: "TOGETHER_API_KEY",
	zenmux: "ZENMUX_API_KEY",
	opengateway: "OPENGATEWAY_API_KEY",
	bizrouter: "BIZROUTER_API_KEY",
	mara: "MARA_API_KEY",
	venice: "VENICE_API_KEY",
	vllm: "VLLM_API_KEY",
	sglang: "SGLANG_API_KEY",
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
	if (provider === "jetbrains-junie") {
		parts.push(
			"JetBrains AI (Junie) authenticates with an access token generated at https://junie.jetbrains.com/cli; there is no OAuth login for this provider.",
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
function pipeAssistantStream(
	outer: AssistantMessageEventStream,
	inner: AssistantMessageEventStream,
	signal?: AbortSignal,
	onStreamCreated?: () => void,
): void {
	void (async () => {
		try {
			let admitted = false;
			const markAdmission = (): void => {
				if (admitted) return;
				admitted = true;
				onStreamCreated?.();
			};
			for await (const event of inner) {
				if (event.type !== "start") markAdmission();
				outer.push(event);
				// The inner provider stream owns abort semantics (it receives the
				// same signal), but stop forwarding as soon as the consumer
				// aborted so a misbehaving inner stream cannot keep the pipe
				// buffering events indefinitely.
				if (signal?.aborted && !outer.done) {
					outer.end(await inner.result());
					return;
				}
			}
			if (!outer.done) outer.end(await inner.result());
		} catch (error) {
			outer.fail(error);
		}
	})();
}

export function streamFromLazyImport(
	createInner: () => Promise<AssistantMessageEventStream>,
	signal?: AbortSignal,
	onStreamCreated?: () => void,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	void (async () => {
		try {
			const inner = await createInner();
			pipeAssistantStream(outer, inner, signal, onStreamCreated);
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
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
	onStreamCreated?: () => void,
): AssistantMessageEventStream {
	if (!hasValidatedManagedAttempt(options)) assertManagedAttempt(options);
	if (options?.fallbackManaged) {
		options = { ...options, requestMaxRetries: 0, streamMaxRetries: 0 } as OptionsForApi<TApi>;
	}
	// Canonical low-level boundary: the request budget must be a positive safe
	// integer. Provider options arrive here unvalidated (unlike `streamSimple`,
	// whose resolver already normalizes), so an unsafe value is dropped to
	// unspecified here once for every dispatch below — integer-only provider
	// fields can never receive a fractional or MAX_SAFE_INTEGER+1 budget.
	if (options?.maxTokens !== undefined && !(Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0)) {
		options = { ...options, maxTokens: undefined } as OptionsForApi<TApi>;
	}
	// Check custom API registry first (extension-provided APIs like "vertex-Anthropic model-api")
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.stream(model, context, options as StreamOptions);
	}

	if (model.provider === "gitlab-duo") {
		const apiKey = (options as StreamOptions | undefined)?.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new Error(formatMissingApiKeyError(model.provider));
		}
		const adapterOptions = isProviderSafetyStopModelTrusted(model)
			? withProviderSafetyStopAdapterInvocation({ ...(options as SimpleStreamOptions | undefined), apiKey })
			: { ...(options as SimpleStreamOptions | undefined), apiKey };
		return streamFromLazyImport(
			async () => {
				const { streamGitLabDuo } = await import("./providers/gitlab-duo");
				return streamGitLabDuo(model, context, adapterOptions);
			},
			(options as StreamOptions | undefined)?.signal,
			onStreamCreated,
		);
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		const vertexOptions = (options || {}) as GoogleVertexOptions;
		return streamGoogleVertex(
			model as Model<"google-vertex">,
			context,
			isProviderSafetyStopModelTrusted(model)
				? withProviderSafetyStopAdapterInvocation(vertexOptions)
				: vertexOptions,
			onStreamCreated,
		);
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		return streamBedrock(
			model as Model<"bedrock-converse-stream">,
			context,
			(options || {}) as BedrockOptions,
			onStreamCreated,
		);
	} else if (model.api === "kiro-codewhisperer-stream") {
		return streamKiroCodeWhisperer(
			model as Model<"kiro-codewhisperer-stream">,
			context,
			(options || {}) as KiroCodeWhispererOptions,
			onStreamCreated,
		);
	}

	const apiKey = options?.apiKey || (model.provider === "opencodex" ? "local" : getEnvApiKey(model.provider));
	if (!apiKey) {
		throw new Error(formatMissingApiKeyError(model.provider));
	}
	const providerOptions = { ...options, apiKey };
	const adapterProviderOptions = isProviderSafetyStopModelTrusted(model)
		? withProviderSafetyStopAdapterInvocation(providerOptions)
		: providerOptions;

	const api: Api = model.api;
	switch (api) {
		case "anthropic-messages": {
			const anthropicOptions = adapterProviderOptions as AnthropicOptions;
			return streamAnthropic(
				model as Model<"anthropic-messages">,
				context,
				{
					...anthropicOptions,
					isOAuth: anthropicOptions.isOAuth ?? model.isOAuth,
				},
				onStreamCreated,
			);
		}

		case "openai-completions":
			return streamOpenAICompletions(
				model as Model<"openai-completions">,
				context,
				adapterProviderOptions as any,
				onStreamCreated,
			);

		case "openai-responses":
			return streamOpenAIResponses(
				model as Model<"openai-responses">,
				context,
				adapterProviderOptions as any,
				onStreamCreated,
			);

		case "azure-openai-responses":
			return streamAzureOpenAIResponses(
				model as Model<"azure-openai-responses">,
				context,
				adapterProviderOptions as any,
				onStreamCreated,
			);

		case "openai-codex-responses":
			return streamOpenAICodexResponses(
				model as Model<"openai-codex-responses">,
				context,
				adapterProviderOptions as any,
				onStreamCreated,
			);

		case "google-generative-ai":
			return streamGoogle(model as Model<"google-generative-ai">, context, adapterProviderOptions, onStreamCreated);

		case "google-gemini-cli":
			return streamGoogleGeminiCli(
				model as Model<"google-gemini-cli">,
				context,
				adapterProviderOptions as GoogleGeminiCliOptions,
				onStreamCreated,
			);

		case "ollama-chat":
			return streamOllama(
				model as Model<"ollama-chat">,
				context,
				adapterProviderOptions as OllamaChatOptions,
				onStreamCreated,
			);

		case "cursor-agent":
			return streamCursor(
				model as Model<"cursor-agent">,
				context,
				adapterProviderOptions as CursorOptions,
				onStreamCreated,
			);

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

function createAssistantAuthError(
	message: AssistantMessage,
): Error & { status?: number; transportFailure?: TransportFailureFacts } {
	const error: Error & { status?: number; transportFailure?: TransportFailureFacts } = new Error(
		message.errorMessage ?? "Provider authentication failed",
	);
	const status = extractStatusFromAssistantError(message);
	if (status !== undefined) error.status = status;
	// Preserve the structured facts. Without this the callback receives a
	// status-only error and every downstream `auth` consumer loses the provider
	// code it needs to tell a credential problem from a plain `forbidden`.
	if (message.transportFailure) error.transportFailure = message.transportFailure;
	return error;
}

/**
 * Unwraps a nested `error.transportFailure` carrier.
 *
 * `transportFailureFacts` dereferences `value`, `value.response`, `value.error`
 * and the captured response, but NOT `value.transportFailure` — and that is the
 * shape this repository actually throws for transport errors. Reading the
 * carrier here keeps the shared extractor untouched (its ten production call
 * sites and its idempotence invariant stay as they are) while still letting the
 * auth veto below see the provider code.
 */
function carriedTransportFailure(candidate: unknown): unknown {
	if (!candidate || typeof candidate !== "object") return undefined;
	const carried = (candidate as { transportFailure?: unknown }).transportFailure;
	return carried && typeof carried === "object" ? carried : undefined;
}

/** Auth-relevant facts for a thrown error or an assistant error, carrier first. */
function authFailureFacts(candidate: unknown): unknown {
	return carriedTransportFailure(candidate) ?? candidate;
}

/**
 * Whether this failure is a credential problem worth retrying with a different
 * credential.
 *
 * Consulted by BOTH capture exits below, and it is the ONLY auth predicate they
 * use. Gating on HTTP 401 alone would contradict the classifier: a typed
 * provider code is supposed to win over the status, so `403 + invalid_api_key`
 * must be captured and `401 + forbidden` must not. A `forbidden` failure is an
 * authorization or configuration defect — handing it to `onAuthError` lets the
 * gateway and SDK consumers invalidate a perfectly healthy credential.
 */
function shouldCaptureAuthFailure(candidate: unknown, statusHint: number | undefined): boolean {
	const trigger = classifyFallbackTrigger(authFailureFacts(candidate));
	// Typed auth facts are authoritative and already encode code-over-status.
	if (trigger.class === "auth") return trigger.authDisposition !== "forbidden";
	// Nothing classifiable: keep the historical bare-401 admission.
	return statusHint === 401;
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
	assertManagedAttempt(options);
	if (options?.fallbackManaged) {
		options = {
			...options,
			requestMaxRetries: 0,
			streamMaxRetries: 0,
			onAuthError: undefined,
		};
		options = markManagedAttemptValidated(options);
	}
	const retryApiKey = options?.onAuthError ? (options.apiKey ?? getEnvApiKey(model.provider)) : undefined;
	if (retryApiKey) {
		const consumerAbortController = new AbortController();
		const outer = new AssistantMessageEventStream(() => consumerAbortController.abort());
		const requestSignal = options?.signal
			? AbortSignal.any([options.signal, consumerAbortController.signal])
			: consumerAbortController.signal;
		const onAuthError = options!.onAuthError!;
		const runAttempt = async (
			apiKey: string,
			captureAuthFailure: boolean,
			onStreamCreated?: () => void,
		): Promise<AuthRetryFailure | undefined> => {
			const bufferedEvents: AssistantMessageEvent[] = [];
			let emittedReplayUnsafeEvent = false;
			let admitted = false;
			const markAdmission = (): void => {
				if (admitted) return;
				admitted = true;
				onStreamCreated?.();
			};
			const flushBuffered = (): void => {
				emitBufferedEvents(outer, bufferedEvents);
				bufferedEvents.length = 0;
			};

			try {
				const inner = streamSimple(model, context, {
					...options,
					apiKey,
					onAuthError: undefined,
					onStreamCreated: markAdmission,
					signal: requestSignal,
				});
				for await (const event of inner) {
					if (!emittedReplayUnsafeEvent && event.type === "start") {
						bufferedEvents.push(event);
						continue;
					}
					if (
						!emittedReplayUnsafeEvent &&
						captureAuthFailure &&
						event.type === "error" &&
						// L0 gate, event exit. Classification decides; a typed
						// `forbidden` never becomes an auth retry.
						shouldCaptureAuthFailure(event.error, extractStatusFromAssistantError(event.error))
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
				if (
					!emittedReplayUnsafeEvent &&
					captureAuthFailure &&
					// L0 gate, throw exit: same rule, carrier-aware.
					shouldCaptureAuthFailure(error, extractHttpStatusFromError(error))
				) {
					return { error, bufferedEvents };
				}
				flushBuffered();
				outer.fail(error);
			} finally {
				// A lazy import or a synchronous provider failure can happen before
				// the admission hook is reached. Release that attempt's lease in
				// the failure path without extending a successful request's lease
				// through the response lifetime.
				if (!admitted) markAdmission();
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
			const failure = await runAttempt(retryApiKey, true, options?.onStreamCreated);
			if (!failure) return;
			let nextCredential: string | AuthRetryCredential | undefined;
			try {
				nextCredential = await onAuthError(model.provider, retryApiKey, failure.error);
			} catch {
				nextCredential = undefined;
			}
			const retryCredential: AuthRetryCredential | undefined =
				typeof nextCredential === "string" ? { apiKey: nextCredential } : nextCredential;
			if (!retryCredential?.apiKey || retryCredential.apiKey === retryApiKey) {
				if (retryCredential) retryCredential.onStreamCreated?.();
				emitFailure(failure);
				return;
			}
			await runAttempt(retryCredential.apiKey, false, retryCredential.onStreamCreated);
		})();
		return outer;
	}

	// Pi-native transport short-circuits the per-provider dispatch entirely:
	// the gateway resolves provider + credential server-side, so we don't
	// need an `apiKey` from `getEnvApiKey` here — `options.apiKey` carries
	// the gateway bearer instead. Comes BEFORE the custom-API check so
	// extension-registered APIs can't accidentally override a configured
	// pi-native transport.
	const resolvedRequestMaxTokens = resolveDefaultRequestMaxTokens(model, options?.maxTokens);
	if (model.transport === "pi-native") {
		return streamFromLazyImport(
			async () => {
				const { streamPiNative } = await import("./providers/pi-native-client");
				return streamPiNative(model, context, { ...options, maxTokens: resolvedRequestMaxTokens });
			},
			options?.signal,
			options?.onStreamCreated,
		);
	}

	// Check custom API registry (extension-provided APIs)
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		const events = customApiProvider.streamSimple(model, context, { ...options, maxTokens: resolvedRequestMaxTokens });
		if (!options?.onStreamCreated) return events;
		const forwarded = new AssistantMessageEventStream();
		pipeAssistantStream(forwarded, events, options.signal, options.onStreamCreated);
		return forwarded;
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		const providerOptions = mapOptionsForApi(model, options, undefined);
		const events = stream(model, context, providerOptions, options?.onStreamCreated);
		return events;
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		const providerOptions = mapOptionsForApi(model, options, undefined);
		const events = stream(model, context, providerOptions, options?.onStreamCreated);
		return events;
	}

	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(formatMissingApiKeyError(model.provider));
	}
	const adapterOptions = isProviderSafetyStopModelTrusted(model)
		? withProviderSafetyStopAdapterInvocation(options ?? {})
		: options;
	const resolvedSpecialProviderMaxTokens = resolvedRequestMaxTokens;

	// GitLab Duo - wraps Anthropic/OpenAI behind GitLab AI Gateway direct access tokens
	if (model.provider === "gitlab-duo") {
		return streamFromLazyImport(
			async () => {
				const { streamGitLabDuo } = await import("./providers/gitlab-duo");
				return streamGitLabDuo(
					model,
					context,
					copyProviderSafetyStopAdapterInvocation(adapterOptions, {
						...adapterOptions,
						apiKey,
						maxTokens: resolvedSpecialProviderMaxTokens,
					}),
				);
			},
			options?.signal,
			options?.onStreamCreated,
		);
	}

	// Kimi Code - route to dedicated handler that wraps OpenAI or Anthropic API
	if (model.provider === "kimi-code") {
		return streamFromLazyImport(
			async () => {
				const { streamKimi } = await import("./providers/kimi");
				// Pass raw SimpleStreamOptions - streamKimi handles mapping internally
				return streamKimi(
					model as Model<"openai-completions">,
					context,
					copyProviderSafetyStopAdapterInvocation(adapterOptions, {
						...adapterOptions,
						apiKey,
						maxTokens: resolvedSpecialProviderMaxTokens,
						format: options?.kimiApiFormat ?? "anthropic",
					}),
				);
			},
			options?.signal,
			options?.onStreamCreated,
		);
	}

	// Synthetic - route to dedicated handler that wraps OpenAI or Anthropic API
	if (model.provider === "synthetic") {
		return streamFromLazyImport(
			async () => {
				const { streamSynthetic } = await import("./providers/synthetic");
				// Pass raw SimpleStreamOptions - streamSynthetic handles mapping internally
				return streamSynthetic(
					model as Model<"openai-completions">,
					context,
					copyProviderSafetyStopAdapterInvocation(adapterOptions, {
						...adapterOptions,
						apiKey,
						maxTokens: resolvedSpecialProviderMaxTokens,
						format: options?.syntheticApiFormat ?? "openai", // Default to OpenAI format
					}),
				);
			},
			options?.signal,
			options?.onStreamCreated,
		);
	}

	const providerOptions = mapOptionsForApi(model, options, apiKey);
	const events = stream(model, context, providerOptions, options?.onStreamCreated);
	return events;
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
const DEFAULT_REQUEST_MAX_TOKENS = 32000;
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

export function resolveDefaultRequestMaxTokens<TApi extends Api>(model: Model<TApi>, requested?: number): number {
	if (requested !== undefined && Number.isSafeInteger(requested) && requested > 0) return requested;
	if (model.maxTokensSource === "configured" && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0) {
		return model.maxTokens;
	}
	return Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0
		? Math.min(model.maxTokens, DEFAULT_REQUEST_MAX_TOKENS)
		: DEFAULT_REQUEST_MAX_TOKENS;
}

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const base = copyProviderSafetyStopAdapterInvocation(options, {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: resolveDefaultRequestMaxTokens(model, options?.maxTokens),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		fallbackManaged: options?.fallbackManaged,
		fallbackAttempt: options?.fallbackAttempt,
		cacheRetention: options?.cacheRetention ?? model.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		requestMaxRetries: options?.fallbackManaged ? 0 : options?.requestMaxRetries,
		streamMaxRetries: options?.fallbackManaged ? 0 : options?.streamMaxRetries,
		metadata: options?.metadata,
		sessionId: options?.sessionId,
		providerSessionState: options?.providerSessionState,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onStreamCreated: options?.onStreamCreated,
		disableProviderRetries: options?.disableProviderRetries,
		onSseEvent: options?.onSseEvent,
		attemptScope: options?.attemptScope,
		execHandlers: options?.execHandlers,
		[managedAttemptValidated]: hasValidatedManagedAttempt(options),
	});

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

			// Caller's maxTokens is the desired output; add thinking budget on top,
			// capped at the model limit. `base.maxTokens` is already resolver-sanitized,
			// so only a finite positive model cap participates (malformed metadata
			// cannot reintroduce NaN into the wire budget).
			const modelCap =
				Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : base.maxTokens;
			const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, modelCap);

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

			// Caller's maxTokens is the desired output; add thinking budget on top,
			// capped at the model limit. `base.maxTokens` is already resolver-sanitized,
			// so only a finite positive model cap participates (malformed metadata
			// cannot reintroduce NaN into the wire budget).
			const modelCap =
				Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : base.maxTokens;
			const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, modelCap);

			// If not enough room for thinking + output, reduce thinking budget
			if (maxTokens <= thinkingBudget) {
				thinkingBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
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
