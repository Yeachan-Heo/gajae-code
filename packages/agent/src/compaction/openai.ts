/**
 * Remote compaction utilities.
 *
 * Provider-side conversation summarization endpoints. Two flavors:
 *
 * - **OpenAI remote compaction** (`/responses/compact`): preserves encrypted
 *   reasoning across compactions by submitting the full responses-API native
 *   history and storing the returned `compaction` / `compaction_summary`
 *   item in `preserveData` so future turns can replay the encrypted state.
 * - **Generic remote compaction**: a thin POST helper for self-hosted
 *   summarization endpoints that accept `{ systemPrompt, prompt }` and reply
 *   with `{ summary, shortSummary? }`.
 */

import {
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@gajae-code/ai/providers/openai-codex/constants";
import { parseTextSignature } from "@gajae-code/ai/providers/openai-responses-shared";
import { transformMessages } from "@gajae-code/ai/providers/transform-messages";
import type { AssistantMessage, Message, Model } from "@gajae-code/ai/types";
import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	neutralizeReservedControlTokens,
	neutralizeResponsesInputControlTokens,
	normalizeResponsesToolCallId,
} from "@gajae-code/ai/utils";
import { $env, logger } from "@gajae-code/utils";

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

// ============================================================================
// Public types
// ============================================================================

export const OPENAI_REMOTE_COMPACTION_PRESERVE_KEY = "openaiRemoteCompaction";

export type OpenAiRemoteCompactionItem = {
	type: "compaction" | "compaction_summary";
	encrypted_content?: string;
	summary?: string;
};

export interface OpenAiRemoteCompactionPreserveData {
	provider?: string;
	replacementHistory: Array<Record<string, unknown>>;
	compactionItem: OpenAiRemoteCompactionItem;
}

export interface OpenAiRemoteCompactionRequest {
	model: string;
	input: Array<Record<string, unknown>>;
	instructions: string;
}

export interface OpenAiRemoteCompactionResponse extends OpenAiRemoteCompactionPreserveData {}

export interface RemoteCompactionRequest {
	systemPrompt: string;
	prompt: string;
}

export interface RemoteCompactionResponse {
	summary: string;
	shortSummary?: string;
}

// ============================================================================
// OpenAI provider gating + endpoint resolution
// ============================================================================

export function shouldUseOpenAiRemoteCompaction(model: Model): boolean {
	return model.provider === "openai" || model.provider === "openai-codex";
}

function resolveOpenAiCompactEndpoint(model: Model, authCredentialType?: "api_key" | "oauth"): string {
	if (model.provider === "openai-codex") {
		return resolveOpenAiCodexCompactEndpoint(model.baseUrl);
	}

	const envBaseUrl = $env.OPENAI_BASE_URL?.trim();
	const configuredBaseUrl = model.baseUrl?.trim();
	const rawBase =
		authCredentialType === "oauth"
			? OPENAI_DEFAULT_BASE_URL
			: envBaseUrl && (!configuredBaseUrl || configuredBaseUrl.toLowerCase().includes("api.openai.com"))
				? envBaseUrl
				: configuredBaseUrl || envBaseUrl || OPENAI_DEFAULT_BASE_URL;
	const normalizedBase = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
	if (normalizedBase.endsWith("/v1")) return `${normalizedBase}/responses/compact`;
	return `${normalizedBase}/v1/responses/compact`;
}

function resolveOpenAiCodexCompactEndpoint(baseUrl: string | undefined): string {
	const rawBase = baseUrl && baseUrl.length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalizedBase = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase;
	if (/\/codex(?:\/v\d+)?$/.test(normalizedBase)) return `${normalizedBase}/responses/compact`;
	return `${normalizedBase}/codex/responses/compact`;
}

function normalizeOpenAiCompactionToolCallId(id: string): string {
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId ?? normalized.callId}`;
}

// ============================================================================
// Preserve-data helpers
// ============================================================================

export function getPreservedOpenAiRemoteCompactionData(
	preserveData: Record<string, unknown> | undefined,
): OpenAiRemoteCompactionPreserveData | undefined {
	const candidate = preserveData?.[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const maybeData = candidate as { provider?: unknown; replacementHistory?: unknown; compactionItem?: unknown };
	if (!Array.isArray(maybeData.replacementHistory)) return undefined;
	const maybeItem = maybeData.compactionItem;
	if (!maybeItem || typeof maybeItem !== "object") return undefined;
	const compactionItem = maybeItem as { type?: unknown; encrypted_content?: unknown; summary?: unknown };
	const isClassicCompaction =
		compactionItem.type === "compaction" && typeof compactionItem.encrypted_content === "string";
	const isSummaryCompaction = compactionItem.type === "compaction_summary";
	if (!isClassicCompaction && !isSummaryCompaction) {
		return undefined;
	}
	return {
		provider: typeof maybeData.provider === "string" ? maybeData.provider : undefined,
		replacementHistory: maybeData.replacementHistory as Array<Record<string, unknown>>,
		compactionItem: compactionItem as unknown as OpenAiRemoteCompactionItem,
	};
}

export function withOpenAiRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
	remoteCompaction: OpenAiRemoteCompactionPreserveData | undefined,
): Record<string, unknown> | undefined {
	if (remoteCompaction) {
		return {
			...(preserveData ?? {}),
			[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: remoteCompaction,
		};
	}

	if (!preserveData || !(OPENAI_REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) {
		return preserveData;
	}

	const { [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

// ============================================================================
// Input/output filtering for OpenAI compact endpoint
// ============================================================================

export function estimateOpenAiCompactInputTokens(input: Array<Record<string, unknown>>, instructions: string): number {
	let chars = instructions.length;
	for (const item of input) {
		chars += JSON.stringify(item).length;
	}
	return Math.ceil(chars / 4);
}

function shouldTrimOpenAiCompactInputItem(item: Record<string, unknown>): boolean {
	return item.type === "function_call_output" || (item.type === "message" && item.role === "developer");
}

function shouldKeepOpenAiCompactOutputUserMessage(item: Record<string, unknown>): boolean {
	if (item.role !== "user") return false;
	const content = item.content;
	if (!Array.isArray(content) || content.length === 0) return false;
	const contextualFragmentPatterns = [
		[/^<system-reminder>[\s\S]*<\/system-reminder>$/i, /<system-reminder>/i],
		[/^#\s*AGENTS\.md instructions for\b[\s\S]*<\/INSTRUCTIONS>$/i, /# AGENTS.md instructions/],
		[/^<environment-context>[\s\S]*<\/environment-context>$/i, /<environment-context>/i],
		[/^<skill>[\s\S]*<\/skill>$/i, /<skill>/i],
		[/^<user-shell-command>[\s\S]*<\/user-shell-command>$/i, /<user-shell-command>/i],
		[/^<turn-aborted>[\s\S]*<\/turn-aborted>$/i, /<turn-aborted>/i],
		[/^<subagent-notification>[\s\S]*<\/subagent-notification>$/i, /<subagent-notification>/i],
	] as const;
	return content.every(part => {
		if (!part || typeof part !== "object") return false;
		const candidate = part as { type?: unknown; text?: unknown };
		if (candidate.type === "input_image") return true;
		if (candidate.type !== "input_text" || typeof candidate.text !== "string") return false;
		const trimmed = candidate.text.trim();
		if (trimmed.length === 0) return false;
		return !contextualFragmentPatterns.some(([strictPattern, markerPattern]) => {
			return strictPattern.test(trimmed) || markerPattern.test(trimmed);
		});
	});
}

function shouldKeepOpenAiCompactOutputItem(item: Record<string, unknown>): boolean {
	if (item.type === "compaction" || item.type === "compaction_summary") return true;
	if (item.type !== "message") return false;
	if (item.role === "developer") return false;
	if (item.role === "assistant") return true;
	return shouldKeepOpenAiCompactOutputUserMessage(item);
}

export function trimOpenAiCompactInput(
	input: Array<Record<string, unknown>>,
	contextWindow: number,
	instructions: string,
): Array<Record<string, unknown>> {
	const itemLengths = input.map(item => JSON.stringify(item).length);
	let chars = instructions.length;
	for (const length of itemLengths) chars += length;

	function removeAt(index: number): void {
		chars -= itemLengths[index] ?? 0;
		trimmed.splice(index, 1);
		itemLengths.splice(index, 1);
	}
	const trimmed = [...input];
	while (trimmed.length > 0 && Math.ceil(chars / 4) > contextWindow) {
		const last = trimmed[trimmed.length - 1];
		if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") {
			const callId = typeof last.call_id === "string" ? last.call_id : undefined;
			const callType = last.type === "custom_tool_call_output" ? "custom_tool_call" : "function_call";
			removeAt(trimmed.length - 1);
			if (callId) {
				const matchingCallIndex = trimmed.findLastIndex(item => item.type === callType && item.call_id === callId);
				if (matchingCallIndex >= 0) {
					removeAt(matchingCallIndex);
				}
			}
			continue;
		}
		if (!last || !shouldTrimOpenAiCompactInputItem(last)) {
			break;
		}
		removeAt(trimmed.length - 1);
	}
	return trimmed;
}

export function resolveOpenAiCompactInputBudget(contextWindow: number, maxOutputTokens = 0): number {
	if (contextWindow <= 0) return 0;
	const reservedTokens = Math.max(Math.floor(contextWindow * 0.15), maxOutputTokens, 1);
	return Math.max(1, contextWindow - reservedTokens);
}

function collectKnownOpenAiCallIds(items: Array<Record<string, unknown>>): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of items) {
		if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string") {
			knownCallIds.add(item.call_id);
		}
	}
	return knownCallIds;
}

function collectCustomOpenAiCallIds(items: Array<Record<string, unknown>>): Set<string> {
	const customCallIds = new Set<string>();
	for (const item of items) {
		if (item.type === "custom_tool_call" && typeof item.call_id === "string") {
			customCallIds.add(item.call_id);
		}
	}
	return customCallIds;
}

// ============================================================================
// Native history construction (responses-API shape)
// ============================================================================

/**
 * Build the OpenAI Responses-API native history array from LLM messages.
 *
 * Caller is responsible for converting any custom message types to
 * `Message[]` first (e.g. via the agent's `convertToLlm`); this function
 * operates purely on the LLM-domain shape.
 *
 * @param messages - LLM messages to encode.
 * @param model - Target model (used for provider gating + tool-call id rules).
 * @param previousReplacementHistory - History from a prior compaction whose
 *   encrypted reasoning we want to preserve.
 */
export function buildOpenAiNativeHistory(
	messages: Message[],
	model: Model,
	previousReplacementHistory?: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	const input: Array<Record<string, unknown>> = previousReplacementHistory ? [...previousReplacementHistory] : [];
	const transformedMessages = transformMessages(messages, model, id => normalizeOpenAiCompactionToolCallId(id));

	let msgIndex = 0;
	let knownCallIds = collectKnownOpenAiCallIds(input);
	let customCallIds = collectCustomOpenAiCallIds(input);
	for (const message of transformedMessages) {
		if (message.role === "user" || message.role === "developer") {
			const providerPayload = (message as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider);
			if (historyItems) {
				input.push(...historyItems);
				knownCallIds = collectKnownOpenAiCallIds(input);
				customCallIds = collectCustomOpenAiCallIds(input);
				msgIndex++;
				continue;
			}

			const contentBlocks: Array<Record<string, unknown>> = [];
			if (typeof message.content === "string") {
				if (message.content.trim().length > 0) {
					contentBlocks.push({ type: "input_text", text: message.content.toWellFormed() });
				}
			} else {
				for (const block of message.content) {
					if (block.type === "text") {
						if (!block.text || block.text.trim().length === 0) continue;
						contentBlocks.push({ type: "input_text", text: block.text.toWellFormed() });
						continue;
					}
					if (block.type === "image") {
						contentBlocks.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}
			}
			if (contentBlocks.length > 0) {
				input.push({ type: "message", role: message.role, content: contentBlocks });
			}
			msgIndex++;
			continue;
		}

		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			const providerPayload = getOpenAIResponsesHistoryPayload(
				assistant.providerPayload,
				model.provider,
				assistant.provider,
			);
			if (providerPayload) {
				if (providerPayload.dt) {
					input.push(...providerPayload.items);
				} else {
					input.splice(0, input.length, ...providerPayload.items);
				}
				knownCallIds = collectKnownOpenAiCallIds(input);
				customCallIds = collectCustomOpenAiCallIds(input);
				msgIndex++;
				continue;
			}
			const isDifferentModel =
				assistant.model !== model.id && assistant.provider === model.provider && assistant.api === model.api;

			for (const block of assistant.content) {
				if (block.type === "thinking" && assistant.stopReason !== "error" && block.thinkingSignature) {
					try {
						const reasoningItem = JSON.parse(block.thinkingSignature) as Record<string, unknown>;
						if (reasoningItem && typeof reasoningItem === "object") {
							input.push(reasoningItem);
						}
					} catch {
						logger.warn("Failed to parse assistant reasoning for remote compaction", {
							model: assistant.model,
							provider: assistant.provider,
						});
					}
					continue;
				}

				if (block.type === "text") {
					if (!block.text || block.text.trim().length === 0) continue;
					const parsedSignature = parseTextSignature(block.textSignature);
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${Bun.hash(msgId).toString(36)}`;
					}
					input.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					});
					continue;
				}

				if (block.type === "toolCall") {
					const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
					let itemId: string | undefined = normalized.itemId;
					if (
						isDifferentModel &&
						(itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))
					) {
						itemId = undefined;
					}
					knownCallIds.add(normalized.callId);
					if (block.customWireName) {
						const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
						customCallIds.add(normalized.callId);
						input.push({
							type: "custom_tool_call",
							id: itemId,
							call_id: normalized.callId,
							name: block.customWireName,
							input: rawInput,
						});
						continue;
					}
					input.push({
						type: "function_call",
						id: itemId,
						call_id: normalized.callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}

			msgIndex++;
			continue;
		}

		if (message.role === "toolResult") {
			const normalized = normalizeResponsesToolCallId(message.toolCallId);
			if (!knownCallIds.has(normalized.callId)) {
				msgIndex++;
				continue;
			}

			const textOutput = message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const hasImages = message.content.some(block => block.type === "image");
			const outputText = textOutput.length > 0 ? textOutput : hasImages ? "(see attached image)" : "";
			input.push({
				type: customCallIds.has(normalized.callId) ? "custom_tool_call_output" : "function_call_output",
				call_id: normalized.callId,
				output: outputText.toWellFormed(),
			});

			if (hasImages && model.input.includes("image")) {
				const contentBlocks: Array<Record<string, unknown>> = [
					{ type: "input_text", text: "Attached image(s) from tool result:" },
				];
				for (const block of message.content) {
					if (block.type !== "image") continue;
					contentBlocks.push({
						type: "input_image",
						detail: "auto",
						image_url: `data:${block.mimeType};base64,${block.data}`,
					});
				}
				input.push({ type: "message", role: "user", content: contentBlocks });
			}
		}

		msgIndex++;
	}

	return input;
}

// ============================================================================
// Endpoint requests
// ============================================================================

export async function requestOpenAiRemoteCompaction(
	model: Model,
	apiKey: string,
	compactInput: Array<Record<string, unknown>>,
	instructions: string,
	signal?: AbortSignal,
	options?: { authCredentialType?: "api_key" | "oauth" },
): Promise<OpenAiRemoteCompactionResponse> {
	const endpoint = resolveOpenAiCompactEndpoint(model, options?.authCredentialType);
	const request: OpenAiRemoteCompactionRequest = {
		model: model.id,
		input: neutralizeResponsesInputControlTokens(
			trimOpenAiCompactInput(
				compactInput,
				resolveOpenAiCompactInputBudget(model.contextWindow, model.maxTokens),
				instructions,
			),
		),
		instructions,
	};
	const headers: Record<string, string> = {
		"content-type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		...(model.headers ?? {}),
	};

	// OpenAI code backend endpoints require additional auth headers
	if (model.provider === "openai-codex") {
		const accountId = getCodexAccountId(apiKey);
		if (accountId) {
			headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
		}
		headers[OPENAI_HEADERS.BETA] = OPENAI_HEADER_VALUES.BETA_RESPONSES;
		headers[OPENAI_HEADERS.ORIGINATOR] = OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	}

	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(request),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		logger.warn("OpenAI remote compaction failed", {
			endpoint,
			status: response.status,
			statusText: response.statusText,
			errorText,
		});
		throw new Error(`Remote compaction failed (${response.status} ${response.statusText})`);
	}

	const data = (await response.json()) as { output?: unknown[] } | undefined;
	const rawOutput = data?.output ?? [];
	const replacementHistory = rawOutput.filter(
		(item): item is Record<string, unknown> =>
			!!item && typeof item === "object" && shouldKeepOpenAiCompactOutputItem(item as Record<string, unknown>),
	);
	const compactionItem = replacementHistory.findLast((item): item is OpenAiRemoteCompactionItem => {
		if (item.type === "compaction" && typeof item.encrypted_content === "string") return true;
		if (item.type === "compaction_summary") return true;
		return false;
	});
	if (!compactionItem) {
		const outputTypes = rawOutput.map(item =>
			typeof item === "object" && item !== null ? (item as Record<string, unknown>).type : typeof item,
		);
		logger.warn("Remote compaction response missing compaction item", {
			endpoint,
			model: model.id,
			provider: model.provider,
			rawOutputLength: rawOutput.length,
			outputTypes,
			replacementHistoryLength: replacementHistory.length,
		});
		throw new Error("Remote compaction response missing compaction item");
	}
	return { provider: model.provider, replacementHistory, compactionItem };
}

export async function requestRemoteCompaction(
	endpoint: string,
	request: RemoteCompactionRequest,
	signal?: AbortSignal,
): Promise<RemoteCompactionResponse> {
	// The prompt embeds the serialized transcript, which can carry leaked Harmony
	// control-token markers (e.g. `<|channel|>analysis`) from model output; a
	// gpt-5.6-backed summarization endpoint rejects those with `Request blocked`.
	const sanitizedRequest: RemoteCompactionRequest = {
		systemPrompt: neutralizeReservedControlTokens(request.systemPrompt),
		prompt: neutralizeReservedControlTokens(request.prompt),
	};
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(sanitizedRequest),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		logger.warn("Remote compaction failed", {
			endpoint,
			status: response.status,
			statusText: response.statusText,
			errorText,
		});
		throw new Error(`Remote compaction failed (${response.status} ${response.statusText})`);
	}

	const data = (await response.json()) as RemoteCompactionResponse | undefined;
	if (!data || typeof data.summary !== "string") {
		throw new Error("Remote compaction response missing summary");
	}

	return data;
}
