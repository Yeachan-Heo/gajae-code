import { extractHttpStatusFromError, fetchWithRetry } from "@gajae-code/utils";
import { getEnvApiKey } from "../stream";
import type {
	Api,
	AssistantMessage,
	Context,
	DeveloperMessage,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
	ToolResultMessage,
	UserMessage,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { finalizeErrorMessage, type RawHttpRequestDump } from "../utils/http-inspector";
import { parseStreamingJson } from "../utils/json-parse";
import { resolveRetryBudget } from "../utils/retry-budget";
import { flattenToolRootCombinators, toolWireSchema } from "../utils/schema";
import {
	isForcedToolChoiceUnsupportedError,
	markToolChoiceIncapability,
	resolveToolChoice,
} from "../utils/tool-choice-capability";
import { transformMessages } from "./transform-messages";

export interface OllamaChatOptions extends StreamOptions {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	toolChoice?: ToolChoice;
}

type OllamaFunctionTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
};

type OllamaMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	images?: string[];
	thinking?: string;
	tool_calls?: Array<{
		type: "function";
		function: {
			index?: number;
			name: string;
			arguments: Record<string, unknown>;
		};
	}>;
	tool_name?: string;
};

type OllamaChatChunk = {
	message?: {
		role?: string;
		content?: string;
		thinking?: string;
		tool_calls?: Array<{
			type?: string;
			function?: {
				index?: number;
				name?: string;
				arguments?: Record<string, unknown> | string;
			};
		}>;
	};
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
};

type InternalToolCallBlock = AssistantMessage["content"][number] & {
	type: "toolCall";
	partialJson?: string;
};

function normalizeBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "https://ollama.com";
	}
	const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
	return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function mapReasoning(reasoning: OllamaChatOptions["reasoning"]): boolean | "low" | "medium" | "high" | undefined {
	switch (reasoning) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "xhigh":
		case "max":
			return "high";
		default:
			return undefined;
	}
}

function mapToolChoice(toolChoice: ToolChoice | undefined): "auto" | "none" | "required" | undefined {
	if (!toolChoice || toolChoice === "auto") {
		return undefined;
	}
	if (toolChoice === "none") {
		return "none";
	}
	if (toolChoice === "required" || toolChoice === "any") {
		return "required";
	}
	if (typeof toolChoice === "object") {
		return "required";
	}
	return undefined;
}

function getNamedToolChoiceName(toolChoice: ToolChoice | undefined): string | undefined {
	if (!toolChoice || typeof toolChoice === "string") {
		return undefined;
	}
	if ("function" in toolChoice) {
		return toolChoice.function.name;
	}
	return toolChoice.name;
}

function selectToolsForToolChoice(tools: Tool[] | undefined, toolChoice: ToolChoice | undefined): Tool[] | undefined {
	const toolName = getNamedToolChoiceName(toolChoice);
	if (!toolName || !tools) {
		return tools;
	}
	for (const tool of tools) {
		if (tool.name === toolName) {
			return [tool];
		}
	}
	return [];
}

function toPlainContent(content: string | Array<{ type: "text" | "image"; text?: string; data?: string }>): {
	content: string;
	images?: string[];
} {
	if (typeof content === "string") {
		return { content };
	}
	const textParts: string[] = [];
	const images: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
		if (block.type === "image" && typeof block.data === "string") {
			images.push(block.data);
		}
	}
	return {
		content: textParts.join("\n"),
		...(images.length > 0 ? { images } : {}),
	};
}

function convertMessage(message: Message): OllamaMessage {
	if (message.role === "user") {
		const converted = toPlainContent(message.content as UserMessage["content"]);
		return { role: "user", ...converted };
	}
	if (message.role === "developer") {
		const converted = toPlainContent(message.content as DeveloperMessage["content"]);
		return { role: "system", ...converted };
	}
	if (message.role === "toolResult") {
		const converted = toPlainContent(message.content as ToolResultMessage["content"]);
		return {
			role: "tool",
			tool_name: message.toolName,
			...converted,
		};
	}
	const text: string[] = [];
	const thinking: string[] = [];
	const toolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
	for (const block of message.content) {
		if (block.type === "text") {
			text.push(block.text);
			continue;
		}
		if (block.type === "thinking") {
			thinking.push(block.thinking);
			continue;
		}
		if (block.type === "toolCall") {
			toolCalls.push({
				type: "function",
				function: {
					name: block.name,
					arguments: block.arguments,
				},
			});
		}
	}
	return {
		role: "assistant",
		content: text.join("\n"),
		...(thinking.length > 0 ? { thinking: thinking.join("\n") } : {}),
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
	};
}

function convertMessages(model: Model<"ollama-chat">, context: Context): OllamaMessage[] {
	const messages: Message[] = [];
	// Emit one developer message per ordered system prompt. The wire role is mapped to "system"
	// by `convertMessage`, but keeping the prompts separate preserves prefix-cache stability:
	// if only the trailing prompt changes between calls, the leading system messages keep
	// their identical token prefix so KV-cache reuse covers them.
	for (const systemPrompt of normalizeSystemPrompts(context.systemPrompt)) {
		messages.push({
			role: "developer",
			content: systemPrompt,
			timestamp: Date.now(),
		});
	}
	messages.push(...context.messages);
	const isCloud = model.provider === "ollama-cloud";
	return transformMessages(messages, model).map(msg => {
		const converted = convertMessage(msg);
		// Ollama cloud rejects requests when assistant history messages contain the `thinking`
		// field — it's valid in model responses but not accepted as a history input. Strip it
		// to prevent HTTP 400 errors. Local Ollama instances are unaffected.
		if (isCloud && converted.role === "assistant" && converted.thinking) {
			const { thinking: _t, ...rest } = converted;
			return rest;
		}
		return converted;
	});
}

function convertTools(tools: Tool[] | undefined): OllamaFunctionTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map(tool => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: flattenToolRootCombinators(toolWireSchema(tool)),
		},
	}));
}

export function createChatBody(model: Model<"ollama-chat">, context: Context, options: OllamaChatOptions | undefined) {
	const think = mapReasoning(options?.reasoning);
	const resolved = resolveToolChoice(model, options?.toolChoice);
	const toolChoice = mapToolChoice(resolved.resolvedChoice);

	// Ollama's wire protocol has no named forcing — a named request rides
	// `tool_choice: "required"` with the tool list narrowed to the target
	// (issue #1236). Narrow whenever the resolved choice still forces a tool.
	const shouldNarrowToNamedTool =
		resolved.requestedLevel === "named" &&
		(resolved.resolvedLevel === "named" || resolved.resolvedLevel === "required") &&
		resolved.targetToolName !== undefined;
	const selectedTools =
		shouldNarrowToNamedTool && resolved.targetToolName
			? selectToolsForToolChoice(context.tools, { type: "tool", name: resolved.targetToolName })
			: context.tools;
	const tools = convertTools(selectedTools);
	return {
		model: model.id,
		messages: convertMessages(model, context),
		...(tools ? { tools } : {}),
		...(think !== undefined ? { think } : {}),
		...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
		...(options?.maxTokens !== undefined ? { options: { num_predict: options.maxTokens } } : {}),
		stream: true,
	};
}

async function* iterateNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<OllamaChatChunk> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex < 0) {
				break;
			}
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			yield JSON.parse(line) as OllamaChatChunk;
		}
	}
	buffer += decoder.decode();
	const tail = buffer.trim();
	if (tail) {
		yield JSON.parse(tail) as OllamaChatChunk;
	}
}

function createEmptyOutput(model: Model<"ollama-chat">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "ollama-chat" as Api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function endThinkingBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "thinking") {
		stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
	}
}

function endTextBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "text") {
		stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
	}
}

function endToolCallBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type !== "toolCall") {
		return;
	}
	const toolCall = block as InternalToolCallBlock;
	if (toolCall.partialJson) {
		toolCall.arguments = parseStreamingJson<Record<string, unknown>>(toolCall.partialJson);
		delete toolCall.partialJson;
	}
	stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
}

function mapDoneReason(doneReason: string | undefined, output: AssistantMessage): AssistantMessage["stopReason"] {
	if (doneReason === "length") {
		return "length";
	}
	if (doneReason === "tool_calls") {
		return "toolUse";
	}
	if (doneReason === undefined && output.content.some(block => block.type === "toolCall")) {
		return "toolUse";
	}
	return "stop";
}

const OLLAMA_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export const streamOllama: StreamFunction<"ollama-chat"> = (
	model: Model<"ollama-chat">,
	context: Context,
	options: OllamaChatOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;
		const output = createEmptyOutput(model);
		let rawRequestDump: RawHttpRequestDump | undefined;
		let activeThinkingIndex: number | undefined;
		let activeTextIndex: number | undefined;
		const activeToolIndices = new Set<number>();
		try {
			const apiKey = options.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const baseUrl = normalizeBaseUrl(model.baseUrl);
			let body = createChatBody(model, context, options);
			const sentForcedToolChoice = body.tool_choice === "required";
			const replacementPayload = await options.onPayload?.(body, model);
			if (replacementPayload !== undefined) {
				body = replacementPayload as typeof body;
			}
			rawRequestDump = {
				provider: model.provider,
				api: model.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl}/api/chat`,
				body,
			};
			let response = await fetchWithRetry(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: {
					...model.headers,
					...options.headers,
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: options.signal,
				maxAttempts: resolveRetryBudget(options.requestMaxRetries, 4) + 1,
				defaultDelayMs: OLLAMA_RETRY_DELAYS_MS,
				fetch: options.fetch,
			});
			if (!response.ok && sentForcedToolChoice) {
				const error = new Error(
					`HTTP ${response.status} from ${baseUrl}/api/chat: ${await response.text().catch(() => "")}`,
				);
				(error as Error & { status?: number }).status = response.status;
				if (firstTokenTime === undefined && isForcedToolChoiceUnsupportedError(error, true)) {
					markToolChoiceIncapability(model, "auto", error.message);
					stream.push({
						type: "toolChoiceIncapability",
						api: model.api,
						provider: model.provider,
						model: model.id,
						requestedLevel: "required",
						resolvedLevel: "auto",
						reason: error.message,
						registryKey: resolveToolChoice(model, options?.toolChoice).registryKey,
					});
					body = { ...body };
					delete (body as { tool_choice?: unknown }).tool_choice;
					rawRequestDump = { ...rawRequestDump, body };
					response = await fetchWithRetry(`${baseUrl}/api/chat`, {
						method: "POST",
						headers: {
							...model.headers,
							...options.headers,
							Authorization: `Bearer ${apiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
						signal: options.signal,
						maxAttempts: 1,
						defaultDelayMs: OLLAMA_RETRY_DELAYS_MS,
						fetch: options.fetch,
					});
				} else {
					throw error;
				}
			}
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} from ${baseUrl}/api/chat`);
			}
			if (!response.body) {
				throw new Error("Ollama returned an empty response body");
			}
			stream.push({ type: "start", partial: output });
			for await (const chunk of iterateNdjson(response.body)) {
				if (chunk.message?.thinking) {
					if (activeTextIndex !== undefined) {
						endTextBlock(stream, output, activeTextIndex);
						activeTextIndex = undefined;
					}
					if (activeThinkingIndex === undefined) {
						output.content.push({ type: "thinking", thinking: "" });
						activeThinkingIndex = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
					}
					const block = output.content[activeThinkingIndex];
					if (block?.type === "thinking") {
						block.thinking += chunk.message.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: activeThinkingIndex,
							delta: chunk.message.thinking,
							partial: output,
						});
					}
					if (!firstTokenTime) {
						firstTokenTime = Date.now();
					}
				}
				if (chunk.message?.content) {
					if (activeThinkingIndex !== undefined) {
						endThinkingBlock(stream, output, activeThinkingIndex);
						activeThinkingIndex = undefined;
					}
					if (activeTextIndex === undefined) {
						output.content.push({ type: "text", text: "" });
						activeTextIndex = output.content.length - 1;
						stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: output });
					}
					const block = output.content[activeTextIndex];
					if (block?.type === "text") {
						block.text += chunk.message.content;
						stream.push({
							type: "text_delta",
							contentIndex: activeTextIndex,
							delta: chunk.message.content,
							partial: output,
						});
					}
					if (!firstTokenTime) {
						firstTokenTime = Date.now();
					}
				}
				if (chunk.message?.tool_calls?.length) {
					if (activeThinkingIndex !== undefined) {
						endThinkingBlock(stream, output, activeThinkingIndex);
						activeThinkingIndex = undefined;
					}
					if (activeTextIndex !== undefined) {
						endTextBlock(stream, output, activeTextIndex);
						activeTextIndex = undefined;
					}
					for (const call of chunk.message.tool_calls) {
						const name = call.function?.name ?? "unknown_tool";
						const rawArgs = call.function?.arguments;
						const partialJson = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
						const toolCall: InternalToolCallBlock = {
							type: "toolCall",
							id: `ollama:${output.content.length}:${name}`,
							name,
							arguments: parseStreamingJson<Record<string, unknown>>(partialJson),
							partialJson,
						};
						output.content.push(toolCall);
						const index = output.content.length - 1;
						activeToolIndices.add(index);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: partialJson,
							partial: output,
						});
						if (!firstTokenTime) {
							firstTokenTime = Date.now();
						}
					}
				}
				if (chunk.done) {
					if (activeThinkingIndex !== undefined) {
						endThinkingBlock(stream, output, activeThinkingIndex);
						activeThinkingIndex = undefined;
					}
					if (activeTextIndex !== undefined) {
						endTextBlock(stream, output, activeTextIndex);
						activeTextIndex = undefined;
					}
					for (const index of activeToolIndices) {
						endToolCallBlock(stream, output, index);
					}
					activeToolIndices.clear();
					output.stopReason = mapDoneReason(chunk.done_reason, output);
					output.usage.input = chunk.prompt_eval_count ?? 0;
					output.usage.output = chunk.eval_count ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output;
				}
			}
			output.duration = Date.now() - startTime;
			if (firstTokenTime) {
				output.ttft = firstTokenTime - startTime;
			}
			const doneReason =
				output.stopReason === "length" ? "length" : output.stopReason === "toolUse" ? "toolUse" : "stop";
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") {
					delete (block as InternalToolCallBlock).partialJson;
				}
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			output.errorMessage = await finalizeErrorMessage(error, rawRequestDump);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) {
				output.ttft = firstTokenTime - startTime;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};
