import type { Model, OpenAICompat } from "../types";

type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ResolvedToolStrictMode = NonNullable<OpenAICompat["toolStrictMode"]> | "mixed";

export type ResolvedOpenAICompat = Required<
	Omit<
		OpenAICompat,
		"openRouterRouting" | "vercelGatewayRouting" | "extraBody" | "toolStrictMode" | "toolChoiceSupport"
	>
> & {
	openRouterRouting?: OpenAICompat["openRouterRouting"];
	vercelGatewayRouting?: OpenAICompat["vercelGatewayRouting"];
	extraBody?: OpenAICompat["extraBody"];
	toolStrictMode: ResolvedToolStrictMode;
	/** Optional explicit capability override; resolved via deriveToolChoiceSupport. */
	toolChoiceSupport?: OpenAICompat["toolChoiceSupport"];
};

function detectStrictModeSupport(provider: string, baseUrl: string): boolean {
	if (
		provider === "openai" ||
		provider === "openrouter" ||
		provider === "cerebras" ||
		provider === "together" ||
		provider === "github-copilot" ||
		provider === "zenmux"
	) {
		return true;
	}

	const normalizedBaseUrl = baseUrl.toLowerCase();
	return (
		normalizedBaseUrl.includes("api.openai.com") ||
		normalizedBaseUrl.includes(".openai.azure.com") ||
		normalizedBaseUrl.includes("models.inference.ai.azure.com") ||
		normalizedBaseUrl.includes("api.cerebras.ai") ||
		normalizedBaseUrl.includes("api.together.xyz") ||
		normalizedBaseUrl.includes("openrouter.ai") ||
		normalizedBaseUrl.includes("api.deepseek.com") ||
		normalizedBaseUrl.includes("deepseek.com")
	);
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 * @param model - The model configuration
 * @param resolvedBaseUrl - Optional resolved base URL (e.g., after GitHub Copilot proxy-ep resolution).
 *                           If provided, this takes precedence over model.baseUrl for URL-based checks.
 */
export function detectOpenAICompat(model: Model<"openai-completions">, resolvedBaseUrl?: string): ResolvedOpenAICompat {
	const provider = model.provider;
	// Use resolvedBaseUrl if provided (e.g., after GitHub Copilot proxy-ep resolution)
	const baseUrl = resolvedBaseUrl ?? model.baseUrl;

	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
	const isKilo = provider === "kilo" || baseUrl.includes("api.kilo.ai");
	const isKimiModel = model.id.includes("moonshotai/kimi") || /(^|\/)kimi[-.]/i.test(model.id);
	const isMoonshotKimi =
		isKimiModel &&
		(provider === "moonshot" ||
			provider === "kimi-code" ||
			baseUrl.includes("api.moonshot.ai") ||
			baseUrl.includes("api.kimi.com"));
	const isAnthropicModel =
		provider === "anthropic" ||
		baseUrl.includes("api.anthropic.com") ||
		/(^|\/)claude[-.]/i.test(model.id) ||
		/(^|\/)anthropic\//i.test(model.id);
	const isAlibaba = provider === "alibaba-coding-plan" || baseUrl.includes("dashscope");
	const isQwen = model.id.toLowerCase().includes("qwen");
	// DeepSeek V4 (and other reasoning-capable DeepSeek models) reject follow-up requests in
	// thinking mode unless prior assistant tool-call turns include `reasoning_content`. The
	// upstream model is reachable through many OpenAI-compat hosts (api.deepseek.com, Deepinfra,
	// Kilo, NVIDIA NIM, Zenmux, OpenRouter, …), so we match by model id/name as well as by
	// provider/baseUrl. The flag is gated by `model.reasoning` because the invariant only
	// applies when thinking mode is actually engaged.
	const lowerId = model.id.toLowerCase();
	const lowerName = (model.name ?? "").toLowerCase();
	const isDeepseekFamily =
		provider === "deepseek" ||
		baseUrl.includes("deepseek.com") ||
		lowerId.includes("deepseek") ||
		lowerName.includes("deepseek");
	const isDirectDeepseekApi = provider === "deepseek" || baseUrl.includes("api.deepseek.com");
	const isDirectDeepseekReasoning = isDirectDeepseekApi && isDeepseekFamily && Boolean(model.reasoning);
	const isNonStandard =
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		provider === "mistral" ||
		baseUrl.includes("mistral.ai") ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("deepseek.com") ||
		baseUrl.includes("fireworks.ai") ||
		isAlibaba ||
		isZai ||
		isKilo ||
		isQwen ||
		provider === "opencode-zen" ||
		provider === "opencode-go" ||
		baseUrl.includes("opencode.ai");
	const isOpenCodeProvider = provider === "opencode-go" || provider === "opencode-zen";
	const isOpenCodeGoReasoning = provider === "opencode-go" && Boolean(model.reasoning);
	const isOpenCodeGoKimiReasoning = provider === "opencode-go" && isKimiModel && Boolean(model.reasoning);
	const isOpenCodeGoKimi25Reasoning = isOpenCodeGoKimiReasoning && model.id === "kimi-k2.5";
	const isOpenCodeGoKimi27CodeReasoning = isOpenCodeGoKimiReasoning && model.id === "kimi-k2.7-code";
	const needsOpenCodeGoKimiEffortMap = isOpenCodeGoKimi25Reasoning || isOpenCodeGoKimi27CodeReasoning;

	const useMaxTokens =
		provider === "mistral" ||
		baseUrl.includes("mistral.ai") ||
		baseUrl.includes("chutes.ai") ||
		baseUrl.includes("fireworks.ai") ||
		isDirectDeepseekApi;
	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isMistral = provider === "mistral" || baseUrl.includes("mistral.ai");

	// Hosts whose chat-completions endpoints are known to accept multiple
	// leading `system`/`developer` messages (preferred for KV-cache reuse).
	// Anything outside this allowlist defaults to coalescing because
	// strict chat templates (Qwen 3.5+ via vLLM, MiniMax, etc.) reject
	// follow-up system messages with a 400.
	const isOpenAIHost = provider === "openai" || baseUrl.includes("api.openai.com");
	const isAzureHost =
		provider === "azure" ||
		baseUrl.includes(".openai.azure.com") ||
		baseUrl.includes("models.inference.ai.azure.com") ||
		baseUrl.includes("azure.com/openai");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isTogether = provider === "together" || baseUrl.includes("api.together.xyz");
	const isFireworks = baseUrl.includes("fireworks.ai");
	const isGroqHost = provider === "groq" || baseUrl.includes("api.groq.com");
	const isCopilotHost = provider === "github-copilot";
	const isZenmuxHost = provider === "zenmux";
	// Endpoints that MUST receive a single system block. MiniMax's OpenAI
	// endpoint returns error 2013 on multiple system messages; Alibaba's
	// Dashscope and Qwen Portal serve Qwen models whose chat template
	// raises "System message must be at the beginning" if any system
	// message appears past index 0.
	const isMiniMaxHost =
		provider === "minimax-code" ||
		provider === "minimax-code-cn" ||
		baseUrl.includes("api.minimax.io") ||
		baseUrl.includes("api.minimaxi.com");
	const isQwenPortal = provider === "qwen-portal" || baseUrl.includes("portal.qwen.ai");
	const supportsMultipleSystemMessagesDefault =
		!isMiniMaxHost &&
		!isAlibaba &&
		!isQwenPortal &&
		(isOpenAIHost ||
			isAzureHost ||
			isOpenRouter ||
			isCerebras ||
			isTogether ||
			isFireworks ||
			isGroqHost ||
			isDeepseekFamily ||
			isMistral ||
			isGrok ||
			isZai ||
			isCopilotHost ||
			isZenmuxHost);

	const reasoningEffortMap: NonNullable<OpenAICompat["reasoningEffortMap"]> =
		provider === "groq" && model.id === "qwen/qwen3-32b"
			? ({
					minimal: "default",
					low: "default",
					medium: "default",
					high: "default",
					xhigh: "default",
					max: "default",
				} satisfies Partial<Record<OpenAIReasoningEffort, string>>)
			: needsOpenCodeGoKimiEffortMap
				? ({
						// Live Go probes (2026-07-06) showed model-specific effort gaps:
						// kimi-k2.5 rejects "minimal", while kimi-k2.7-code rejects
						// OpenAI-style "xhigh" and "max"; all other Kimi efforts tested
						// successfully and should pass through unchanged.
						...(isOpenCodeGoKimi25Reasoning ? { minimal: "low" } : {}),
						...(isOpenCodeGoKimi27CodeReasoning ? { xhigh: "high", max: "high" } : {}),
					} satisfies Partial<Record<OpenAIReasoningEffort, string>>)
				: isDeepseekFamily && model.reasoning
					? ({
							minimal: "high",
							low: "high",
							medium: "high",
							high: "high",
							xhigh: "max",
							max: "max",
						} satisfies Partial<Record<OpenAIReasoningEffort, string>>)
					: isFireworks
						? ({
								// Fireworks' OpenAI-compatible endpoint rejects OpenAI's
								// `minimal` literal but accepts `none` for the lowest setting.
								minimal: "none",
							} satisfies Partial<Record<OpenAIReasoningEffort, string>>)
						: {};

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: !isNonStandard,
		sendSessionHeaders: false,
		supportsMultipleSystemMessages: supportsMultipleSystemMessagesDefault,
		supportsReasoningEffort: !isGrok && !isZai,
		reasoningEffortMap,
		supportsUsageInStreaming: !isCerebras,
		disableReasoningOnForcedToolChoice: isKimiModel || isAnthropicModel || isOpenCodeGoReasoning,
		disableReasoningOnToolChoice: isDeepseekFamily && Boolean(model.reasoning) && !isOpenRouter,
		supportsToolChoice: !isDirectDeepseekReasoning,
		supportsForcedToolChoice: !isOpenCodeGoKimiReasoning,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: isMistral,
		requiresMistralToolIds: isMistral,
		thinkingFormat:
			isZai || isMoonshotKimi
				? "zai"
				: provider === "openrouter" || baseUrl.includes("openrouter.ai")
					? "openrouter"
					: isAlibaba || isQwen
						? "qwen"
						: "openai",
		reasoningContentField: "reasoning_content",
		// Backends that 400 follow-up requests when prior assistant tool-call turns lack `reasoning_content`:
		//   - Kimi: documented invariant on its native API.
		//   - Any reasoning-capable model reached through OpenRouter: DeepSeek V4 Pro and similar enforce
		//     this server-side whenever the request is in thinking mode. We can't translate Anthropic's
		//     redacted/encrypted reasoning into DeepSeek's plaintext form, so cross-provider continuations
		//     rely on a placeholder — see `convertMessages` for the placeholder injection.
		//   - OpenCode-Go and OpenCode-Zen handle reasoning content internally and reject
		//     `reasoning_content` in client-sent messages — exclude them even for Kimi models.
		requiresReasoningContentForToolCalls:
			(isKimiModel && !isOpenCodeProvider) ||
			(isDeepseekFamily && Boolean(model.reasoning)) ||
			((provider === "openrouter" || baseUrl.includes("openrouter.ai")) && Boolean(model.reasoning)),
		// DeepSeek V4 rejects synthetic reasoning_content placeholders (".") on tool-call turns.
		// Kimi and OpenRouter accept them when actual reasoning is unavailable.
		allowsSyntheticReasoningContentForToolCalls: !isDeepseekFamily || !model.reasoning,
		requiresAssistantContentForToolCalls: isKimiModel || isDirectDeepseekReasoning,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		supportsStrictMode: detectStrictModeSupport(provider, baseUrl) && !(isDeepseekFamily && isOpenRouter),
		extraBody: isDirectDeepseekReasoning ? { thinking: { type: "enabled" } } : undefined,
		toolStrictMode: isCerebras ? "all_strict" : "mixed",
	};
}

/**
 * Resolve compatibility settings by layering explicit model.compat overrides onto
 * the detected defaults. This is the canonical compat view for both metadata and transport.
 * @param model - The model configuration
 * @param resolvedBaseUrl - Optional resolved base URL (e.g., after GitHub Copilot proxy-ep resolution).
 *                           If provided, this takes precedence over model.baseUrl for URL-based checks.
 */
export function resolveOpenAICompat(
	model: Model<"openai-completions">,
	resolvedBaseUrl?: string,
): ResolvedOpenAICompat {
	const detected = detectOpenAICompat(model, resolvedBaseUrl);
	if (!model.compat) {
		return detected;
	}

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		sendSessionHeaders: model.compat.sendSessionHeaders ?? detected.sendSessionHeaders,
		supportsMultipleSystemMessages:
			model.compat.supportsMultipleSystemMessages ?? detected.supportsMultipleSystemMessages,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		reasoningEffortMap: { ...detected.reasoningEffortMap, ...(model.compat.reasoningEffortMap ?? {}) },
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsToolChoice: model.compat.supportsToolChoice ?? detected.supportsToolChoice,
		supportsForcedToolChoice: model.compat.supportsForcedToolChoice ?? detected.supportsForcedToolChoice,
		toolChoiceSupport: model.compat.toolChoiceSupport ?? detected.toolChoiceSupport,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresMistralToolIds: model.compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		reasoningContentField: model.compat.reasoningContentField ?? detected.reasoningContentField,
		requiresReasoningContentForToolCalls:
			model.compat.requiresReasoningContentForToolCalls ?? detected.requiresReasoningContentForToolCalls,
		allowsSyntheticReasoningContentForToolCalls:
			model.compat.allowsSyntheticReasoningContentForToolCalls ??
			detected.allowsSyntheticReasoningContentForToolCalls,
		requiresAssistantContentForToolCalls:
			model.compat.requiresAssistantContentForToolCalls ?? detected.requiresAssistantContentForToolCalls,
		disableReasoningOnForcedToolChoice:
			model.compat.disableReasoningOnForcedToolChoice ?? detected.disableReasoningOnForcedToolChoice,
		disableReasoningOnToolChoice: model.compat.disableReasoningOnToolChoice ?? detected.disableReasoningOnToolChoice,
		openRouterRouting: model.compat.openRouterRouting ?? detected.openRouterRouting,
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		extraBody: model.compat.extraBody ?? detected.extraBody,
		toolStrictMode: model.compat.toolStrictMode ?? detected.toolStrictMode,
	};
}
