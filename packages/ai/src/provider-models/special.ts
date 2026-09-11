import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@gajae-code/ai";
import { once, sanitizeText } from "@gajae-code/utils";

import type { ModelManagerOptions } from "../model-manager";
import { buildZCodeSourceHeaders, resolveGlmZcodeAnthropicBaseUrl } from "../providers/anthropic";
import { fetchKiroApiModels, isKiroApiKey, kiroApiStaticModels } from "../providers/kiro-api-key";
import { fetchOpenCodexModels, OPENCODEX_MODEL_CACHE_TTL_MS } from "../providers/openai-opencodex-responses";
import type { Model } from "../types";
import { fetchCodexModels } from "../utils/discovery/codex";
import { fetchOpenAICompatibleModels } from "../utils/discovery/openai-compatible";
import { createBundledReferenceMap } from "./bundled-references";
export function openCodexModelManagerOptions(): ModelManagerOptions<"openai-responses"> {
	return {
		providerId: "opencodex",
		cacheTtlMs: OPENCODEX_MODEL_CACHE_TTL_MS,
		fetchDynamicModels: fetchOpenCodexModels,
	};
}

// ---------------------------------------------------------------------------
// Devin CLI (ACP)
// ---------------------------------------------------------------------------

/**
 * Lazy handle to the ACP provider module. The ACP SDK must stay out of the
 * catalog/startup import graph, so it is only required when Devin model
 * discovery actually runs.
 */
interface DevinAcpDiscoveryModule {
	fetchDevinAcpModels: (config?: {
		cliPath?: string;
		cliArgs?: readonly string[];
		cwd?: string;
	}) => Promise<Model<"devin-acp">[] | null>;
}

const devinAcpDiscovery = once(() => require("../providers/devin-acp") as DevinAcpDiscoveryModule);

export interface DevinModelManagerConfig {
	cliPath?: string;
	cliArgs?: readonly string[];
	cwd?: string;
}

/**
 * Devin models come from the ACP session's own `model` config option: the
 * account and enterprise allowlists are authoritative there, and ACP is the
 * documented programmatic surface (`devin acp`). Discovery fails closed to "no
 * models" when the CLI is missing or unauthenticated.
 */
export function devinModelManagerOptions(config: DevinModelManagerConfig = {}): ModelManagerOptions<"devin-acp"> {
	return {
		providerId: "devin",
		fetchDynamicModels: () => devinAcpDiscovery().fetchDevinAcpModels(config),
	};
}

// ---------------------------------------------------------------------------
// OpenAI code provider
// ---------------------------------------------------------------------------

export interface OpenAICodexModelManagerConfig {
	accessToken?: string;
	accountId?: string;
	clientVersion?: string;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { accessToken, accountId, clientVersion } = config;
	return {
		providerId: "openai-codex",
		...(accessToken
			? {
					fetchDynamicModels: async () => {
						const result = await fetchCodexModels({ accessToken, accountId, clientVersion });
						return result?.models ?? null;
					},
				}
			: undefined),
	};
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	clientVersion?: string;
}

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey, baseUrl, clientVersion } = config;
	return {
		providerId: "cursor",
		...(apiKey
			? {
					fetchDynamicModels: async () => {
						const { fetchCursorUsableModels } = await cursorDiscovery();
						return fetchCursorUsableModels({ apiKey, baseUrl, clientVersion });
					},
				}
			: undefined),
	};
}

const cursorDiscovery = once(() => import("../utils/discovery/cursor"));

// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

export function zaiModelManagerOptions(_config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "zai" };
}

// ---------------------------------------------------------------------------
// GLM ZCode (unofficial Z.AI OAuth)
// ---------------------------------------------------------------------------

export interface GlmZcodeModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
}

export function glmZcodeModelManagerOptions(
	config: GlmZcodeModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages"> {
	const apiKey = config.apiKey;
	const baseUrl = resolveGlmZcodeAnthropicBaseUrl();
	const providerRefs = createBundledReferenceMap<"anthropic-messages">("glm-zcode");
	// Same-family GLM references: the thin `glm-zcode` slice bundles only the
	// newest model, while the `zai` slice carries the rest of the GLM family
	// with real capabilities (reasoning, thinking, limits). Resolving through
	// both keeps a newly selectable GLM model from degrading to generic
	// unknown metadata; the provider/base are rewritten below.
	const familyRefs = createBundledReferenceMap<"anthropic-messages">("zai");
	const resolveReference = (modelId: string) => providerRefs.get(modelId) ?? familyRefs.get(modelId);

	return {
		providerId: "glm-zcode",
		...(apiKey ? { cacheDynamicModelProvenance: `${Bun.hash(apiKey).toString(36)}\0${baseUrl}` } : undefined),
		...(apiKey
			? {
					fetchDynamicModels: () =>
						fetchOpenAICompatibleModels({
							api: "anthropic-messages",
							provider: "glm-zcode",
							baseUrl: baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`,
							apiKey,
							headers: {
								...buildZCodeSourceHeaders(),
								"anthropic-version": "2023-06-01",
								"anthropic-dangerous-direct-browser-access": "true",
							},
							mapModel: (entry, defaults) => {
								// The remote catalog is provider-controlled text that ends up
								// rendered in the TUI model selector; strip ANSI/OSC and other
								// control sequences at the discovery boundary.
								const remoteName =
									typeof entry.name === "string" && entry.name.length > 0
										? sanitizeText(entry.name).replace(/\s+/g, " ").trim().slice(0, 200)
										: "";
								const reference = resolveReference(defaults.id);
								if (!reference) {
									return { ...defaults, name: remoteName || defaults.id };
								}
								return {
									...reference,
									id: defaults.id,
									provider: "glm-zcode",
									name: remoteName || reference.name,
									baseUrl,
									contextWindow:
										defaults.contextWindow === UNK_CONTEXT_WINDOW
											? reference.contextWindow
											: defaults.contextWindow,
									maxTokens: defaults.maxTokens === UNK_MAX_TOKENS ? reference.maxTokens : defaults.maxTokens,
								};
							},
						}),
				}
			: undefined),
	};
}
// ---------------------------------------------------------------------------
// JetBrains Junie (JetBrains AI Service, Ingrazzio gateway)
// ---------------------------------------------------------------------------

export interface JetBrainsJunieModelManagerConfig {}

export function jetbrainsJunieModelManagerOptions(
	_config: JetBrainsJunieModelManagerConfig = {},
): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "jetbrains-junie" };
}

// ---------------------------------------------------------------------------
// Kiro (Amazon Q Developer / CodeWhisperer)
// ---------------------------------------------------------------------------

export interface KiroModelManagerConfig {
	apiKey?: string;
}

export function kiroModelManagerOptions(
	config: KiroModelManagerConfig = {},
): ModelManagerOptions<"kiro-codewhisperer-stream"> {
	const apiKey = config.apiKey;
	return {
		providerId: "kiro",
		...(isKiroApiKey(apiKey)
			? {
					staticModels: kiroApiStaticModels(),
					fetchDynamicModels: () => fetchKiroApiModels(apiKey),
				}
			: undefined),
	};
}
