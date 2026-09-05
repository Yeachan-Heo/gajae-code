/**
 * Kiro API-key (ksk_) transport.
 *
 * Headless Kiro Pro keys authenticate against the Kiro service root with
 * `tokentype: API_KEY` and `origin: AI_EDITOR`. This is distinct from the
 * AWS SSO OIDC / CodeWhisperer streaming path used by `gjc auth-broker login kiro`.
 */
import { $env } from "@gajae-code/utils";
import { assertAwsRegionLabel } from "../adapter-internals/aws-region";
import { Effort } from "../model-thinking";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { withHttpStatus } from "../utils/http-inspector";
import type { KiroCodeWhispererOptions } from "./kiro-codewhisperer";

const DEFAULT_REGION = "us-east-1";
const KIRO_ORIGIN = "AI_EDITOR";
const LIST_TARGET = "AmazonCodeWhispererService.ListAvailableModels";
const CHAT_TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const KIRO_THINKING = {
	mode: "effort" as const,
	minLevel: Effort.Low,
	maxLevel: Effort.XHigh,
	defaultLevel: Effort.Medium,
	levels: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
};

const EFFORT_BUDGET: Record<string, number> = {
	minimal: 10_000,
	low: 10_000,
	medium: 20_000,
	high: 30_000,
	xhigh: 50_000,
	max: 50_000,
};

export function isKiroApiKey(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().startsWith("ksk_") && !/[\x00-\x1f\x7f]/.test(value);
}

export function kiroApiRegion(options?: { region?: string }): string {
	return (
		options?.region ??
		$env.KIRO_API_REGION ??
		$env.KIRO_REGION ??
		$env.AWS_REGION ??
		$env.AWS_DEFAULT_REGION ??
		DEFAULT_REGION
	);
}

export function kiroApiBaseUrl(region: string): string {
	assertAwsRegionLabel(region);
	return `https://q.${region}.amazonaws.com/`;
}

function isRegionDerivedKiroApiBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		const match = /^q\.([a-z0-9-]+)\.amazonaws\.com$/.exec(url.hostname);
		if (!match) return false;
		assertAwsRegionLabel(match[1]);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.port === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

export function toKiroModelId(modelId: string): string {
	return modelId.replace(/(\d)-(\d)/g, "$1.$2");
}

function toGjcModelId(kiroId: string): string {
	return kiroId.replace(/(\d)\.(\d)/g, "$1-$2");
}

function kiroUserAgent(): string {
	const mid = crypto.randomUUID().replace(/-/g, "");
	return `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
}

function kiroApiHeaders(apiKey: string, target: string): Record<string, string> {
	const ua = kiroUserAgent();
	return {
		"Content-Type": "application/x-amz-json-1.0",
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
		tokentype: "API_KEY",
		"X-Amz-Target": target,
		"x-amzn-codewhisperer-optout": "true",
		"amz-sdk-invocation-id": crypto.randomUUID(),
		"amz-sdk-request": "attempt=1; max=1",
		"x-amz-user-agent": ua,
		"user-agent": ua,
		"x-amzn-kiro-agent-mode": "vibe",
	};
}

function sanitizeKiroError(value: unknown, secret?: string): string {
	let message = value instanceof Error ? value.message : String(value);
	if (secret) message = message.split(secret).join("[redacted]");
	message = message.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
	message = message.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
	message = message.replace(/[\r\n\t ]+/g, " ").trim();
	return message.length > 1000 ? `${message.slice(0, 997)}...` : message || "Kiro request failed";
}

interface ApiModel {
	modelId: string;
	modelName?: string;
	supportedInputTypes?: string[];
	tokenLimits?: { maxInputTokens?: number; maxOutputTokens?: number };
}

function toModel(api: ApiModel, baseUrl: string): Model<"kiro-codewhisperer-stream"> {
	const types = api.supportedInputTypes ?? ["TEXT"];
	const input = types.some(t => t.toUpperCase() === "IMAGE") ? (["text", "image"] as const) : (["text"] as const);
	return {
		id: api.modelId,
		name: api.modelName ?? api.modelId,
		api: "kiro-codewhisperer-stream",
		provider: "kiro",
		baseUrl,
		reasoning: true,
		thinking: KIRO_THINKING,
		input: [...input],
		cost: ZERO_COST,
		contextWindow: api.tokenLimits?.maxInputTokens ?? 200_000,
		maxTokens: api.tokenLimits?.maxOutputTokens ?? 8_192,
	};
}

const STATIC_KIRO_API_CATALOG: Array<{
	modelId: string;
	modelName: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	image: boolean;
}> = [
	{ modelId: "auto", modelName: "Auto", maxInputTokens: 1_000_000, maxOutputTokens: 64_000, image: true },
	{
		modelId: "claude-haiku-4.5",
		modelName: "Claude Haiku 4.5",
		maxInputTokens: 200_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "claude-sonnet-4",
		modelName: "Claude Sonnet 4",
		maxInputTokens: 200_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "claude-sonnet-4.5",
		modelName: "Claude Sonnet 4.5",
		maxInputTokens: 200_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "claude-sonnet-4.6",
		modelName: "Claude Sonnet 4.6",
		maxInputTokens: 1_000_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "claude-sonnet-5",
		modelName: "Claude Sonnet 5",
		maxInputTokens: 1_000_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "claude-opus-4.5",
		modelName: "Claude Opus 4.5",
		maxInputTokens: 200_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "claude-opus-4.6",
		modelName: "Claude Opus 4.6",
		maxInputTokens: 1_000_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "claude-opus-4.7",
		modelName: "Claude Opus 4.7",
		maxInputTokens: 1_000_000,
		maxOutputTokens: 128_000,
		image: true,
	},
	{
		modelId: "claude-opus-4.8",
		modelName: "Claude Opus 4.8",
		maxInputTokens: 1_000_000,
		maxOutputTokens: 128_000,
		image: true,
	},
	{
		modelId: "claude-opus-5",
		modelName: "Claude Opus 5",
		maxInputTokens: 1_000_000,
		maxOutputTokens: 128_000,
		image: true,
	},
	{
		modelId: "gpt-5.6-luna",
		modelName: "GPT 5.6 Luna",
		maxInputTokens: 272_000,
		maxOutputTokens: 128_000,
		image: true,
	},
	{
		modelId: "gpt-5.6-terra",
		modelName: "GPT 5.6 Terra",
		maxInputTokens: 272_000,
		maxOutputTokens: 128_000,
		image: true,
	},
	{ modelId: "gpt-5.6-sol", modelName: "GPT 5.6 Sol", maxInputTokens: 272_000, maxOutputTokens: 128_000, image: true },
	{
		modelId: "deepseek-3.2",
		modelName: "DeepSeek 3.2",
		maxInputTokens: 164_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "minimax-m2.1",
		modelName: "MiniMax M2.1",
		maxInputTokens: 196_000,
		maxOutputTokens: 64_000,
		image: true,
	},
	{
		modelId: "minimax-m2.5",
		modelName: "MiniMax M2.5",
		maxInputTokens: 196_000,
		maxOutputTokens: 64_000,
		image: false,
	},
	{ modelId: "glm-5", modelName: "GLM 5", maxInputTokens: 200_000, maxOutputTokens: 64_000, image: false },
	{
		modelId: "qwen3-coder-next",
		modelName: "Qwen3 Coder Next",
		maxInputTokens: 256_000,
		maxOutputTokens: 64_000,
		image: true,
	},
];

export function kiroApiStaticModels(): Model<"kiro-codewhisperer-stream">[] {
	const baseUrl = kiroApiBaseUrl(kiroApiRegion());
	const models: Model<"kiro-codewhisperer-stream">[] = [];
	for (const item of STATIC_KIRO_API_CATALOG) {
		const model = toModel(
			{
				modelId: item.modelId,
				modelName: item.modelName,
				supportedInputTypes: item.image ? ["TEXT", "IMAGE"] : ["TEXT"],
				tokenLimits: { maxInputTokens: item.maxInputTokens, maxOutputTokens: item.maxOutputTokens },
			},
			baseUrl,
		);
		models.push(model);
		const dashed = toGjcModelId(item.modelId);
		if (dashed !== item.modelId) models.push({ ...model, id: dashed });
	}
	return models;
}

/** Discover models this API key can use. Returns null when the key is missing. */
export async function fetchKiroApiModels(
	apiKey: string,
	region?: string,
): Promise<Model<"kiro-codewhisperer-stream">[]> {
	const resolvedRegion = region ?? kiroApiRegion();
	const baseUrl = kiroApiBaseUrl(resolvedRegion);
	const response = await fetch(baseUrl, {
		method: "POST",
		headers: kiroApiHeaders(apiKey, LIST_TARGET),
		body: JSON.stringify({ origin: KIRO_ORIGIN }),
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			sanitizeKiroError(`Kiro ListAvailableModels HTTP ${response.status}: ${body.slice(0, 500)}`, apiKey),
		);
	}
	const payload = (await response.json()) as { models?: ApiModel[] };
	const models: Model<"kiro-codewhisperer-stream">[] = [];
	for (const item of payload.models ?? []) {
		if (!item.modelId) continue;
		const model = toModel(item, baseUrl);
		models.push(model);
		const dashed = toGjcModelId(item.modelId);
		if (dashed !== item.modelId) {
			models.push({ ...model, id: dashed });
		}
	}
	return models;
}

// ---- JSON event parser (Kiro API-key streams interleave JSON in the body) ----

type KiroStreamEvent =
	| { type: "content"; data: string }
	| { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
	| { type: "toolUseInput"; data: { input: string } }
	| { type: "toolUseStop"; data: { stop: boolean } }
	| { type: "usage"; data: { inputTokens?: number; outputTokens?: number } }
	| { type: "error"; data: { error: string; message?: string } };

const EVENT_PATTERNS = [
	'{"content":',
	'{"name":',
	'{"input":',
	'{"stop":',
	'{"contextUsagePercentage":',
	'{"usage":',
	'{"toolUseId":',
	'{"error":',
	'{"Error":',
];

function findJsonEnd(text: string, start: number): number {
	let brace = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") brace++;
		else if (ch === "}") {
			brace--;
			if (brace === 0) return i;
		}
	}
	return -1;
}

export function parseKiroApiEvents(buffer: string): { events: KiroStreamEvent[]; remaining: string } {
	const events: KiroStreamEvent[] = [];
	let pos = 0;
	while (pos < buffer.length) {
		let start = -1;
		for (const pattern of EVENT_PATTERNS) {
			const idx = buffer.indexOf(pattern, pos);
			if (idx >= 0 && (start < 0 || idx < start)) start = idx;
		}
		if (start < 0) break;
		const end = findJsonEnd(buffer, start);
		if (end < 0) return { events, remaining: buffer.slice(start) };
		try {
			const parsed = JSON.parse(buffer.slice(start, end + 1)) as Record<string, unknown>;
			if (typeof parsed.content === "string") {
				events.push({ type: "content", data: parsed.content });
			} else if (parsed.name && parsed.toolUseId) {
				const raw = parsed.input;
				const input = typeof raw === "string" ? raw : raw && typeof raw === "object" ? JSON.stringify(raw) : "";
				events.push({
					type: "toolUse",
					data: {
						name: String(parsed.name),
						toolUseId: String(parsed.toolUseId),
						input,
						stop: parsed.stop as boolean | undefined,
					},
				});
			} else if ("input" in parsed && !parsed.name) {
				events.push({
					type: "toolUseInput",
					data: { input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input) },
				});
			} else if ("stop" in parsed && parsed.contextUsagePercentage === undefined) {
				events.push({ type: "toolUseStop", data: { stop: Boolean(parsed.stop) } });
			} else if (parsed.usage && typeof parsed.usage === "object") {
				const u = parsed.usage as { inputTokens?: number; outputTokens?: number };
				events.push({ type: "usage", data: u });
			} else if (parsed.error || parsed.Error) {
				events.push({
					type: "error",
					data: {
						error: String(parsed.error || parsed.Error),
						message: (parsed.message || parsed.Message) as string | undefined,
					},
				});
			}
		} catch {
			// skip malformed frame
		}
		pos = end + 1;
	}
	return { events, remaining: "" };
}

function extractText(msg: Context["messages"][number]): string {
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.map(block => {
			if (typeof block === "string") return block;
			if (block.type === "text") return block.text;
			return "";
		})
		.join("");
}

function convertTools(tools: Tool[]) {
	return tools.map(tool => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: { json: tool.parameters ?? {} },
		},
	}));
}

function thinkingPrefix(reasoning: string | boolean | undefined): string {
	if (!reasoning || reasoning === true) return "";
	const budget = EFFORT_BUDGET[String(reasoning)] ?? 20_000;
	return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
}

function buildApiKeyRequest(
	model: Model<"kiro-codewhisperer-stream">,
	context: Context,
	options: KiroCodeWhispererOptions,
): unknown {
	const modelId = toKiroModelId(model.wireModelId || model.id);
	const prefix = thinkingPrefix(options.reasoning);
	let systemPrompt = context.systemPrompt?.join("\n") ?? "";
	if (prefix) systemPrompt = systemPrompt ? `${prefix}\n${systemPrompt}` : prefix;

	const messages = context.messages;
	const history: unknown[] = [];
	for (let i = 0; i < messages.length - 1; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			let content = "";
			const toolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
			for (const block of msg.content) {
				if (typeof block === "string") content += block;
				else if (block.type === "text") content += block.text;
				else if (block.type === "thinking") content = `<thinking>${block.thinking}</thinking>\n\n${content}`;
				else if (block.type === "toolCall") {
					toolUses.push({
						name: block.name,
						toolUseId: block.id,
						input: (block.arguments ?? {}) as Record<string, unknown>,
					});
				}
			}
			history.push({
				assistantResponseMessage: {
					content,
					...(toolUses.length > 0 ? { toolUses } : {}),
				},
			});
		} else if (msg.role === "user") {
			let content = extractText(msg);
			if (systemPrompt && history.length === 0) {
				content = `${systemPrompt}\n\n${content}`;
				systemPrompt = "";
			}
			history.push({
				userInputMessage: { content, modelId, origin: KIRO_ORIGIN },
			});
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const result = {
				content: [{ text: extractText(msg) }],
				status: tr.isError ? "error" : "success",
				toolUseId: tr.toolCallId,
			};
			const last = history[history.length - 1] as {
				userInputMessage?: { userInputMessageContext?: { toolResults?: unknown[] } };
			};
			if (last?.userInputMessage) {
				last.userInputMessage.userInputMessageContext ??= {};
				last.userInputMessage.userInputMessageContext.toolResults ??= [];
				last.userInputMessage.userInputMessageContext.toolResults.push(result);
			} else {
				history.push({
					userInputMessage: {
						content: "Tool results provided.",
						modelId,
						origin: KIRO_ORIGIN,
						userInputMessageContext: { toolResults: [result] },
					},
				});
			}
		}
	}

	const last = messages[messages.length - 1];
	let currentContent = last ? extractText(last) : "Please proceed with the task.";
	if (last?.role === "user" && systemPrompt) {
		currentContent = `${systemPrompt}\n\n${currentContent}`;
		systemPrompt = "";
	}
	if (last?.role === "toolResult") currentContent = "Tool results provided.";

	const toolResults: unknown[] = [];
	if (last?.role === "toolResult") {
		const tr = last as ToolResultMessage;
		toolResults.push({
			content: [{ text: extractText(last) }],
			status: tr.isError ? "error" : "success",
			toolUseId: tr.toolCallId,
		});
	}
	const uimc: Record<string, unknown> = {};
	if (toolResults.length > 0) uimc.toolResults = toolResults;
	if (context.tools?.length) uimc.tools = convertTools(context.tools);

	return {
		conversationState: {
			chatTriggerType: "MANUAL",
			agentTaskType: "vibe",
			conversationId: crypto.randomUUID(),
			currentMessage: {
				userInputMessage: {
					content: currentContent,
					modelId,
					origin: KIRO_ORIGIN,
					...(Object.keys(uimc).length > 0 ? { userInputMessageContext: uimc } : {}),
				},
			},
			...(history.length > 0 ? { history } : {}),
		},
		agentMode: "vibe",
	};
}

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number };

export const streamKiroApiKey: StreamFunction<"kiro-codewhisperer-stream"> = (
	model: Model<"kiro-codewhisperer-stream">,
	context: Context,
	options: KiroCodeWhispererOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	(async () => {
		const apiKey = options.apiKey?.trim() ?? "";
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "kiro-codewhisperer-stream" as Api,
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
		const blocks = output.content as Block[];
		try {
			if (!isKiroApiKey(apiKey)) {
				throw new Error(
					"Kiro API key missing. Set KIRO_API_KEY to a ksk_ key from https://app.kiro.dev/settings/api-keys.",
				);
			}
			const configuredBaseUrl = model.baseUrl;
			const usesExplicitBaseUrl = Boolean(configuredBaseUrl) && !isRegionDerivedKiroApiBaseUrl(configuredBaseUrl);
			const endpoint = configuredBaseUrl || kiroApiBaseUrl(kiroApiRegion(options));
			let request = buildApiKeyRequest(model, context, options);
			const replacementPayload = await options?.onPayload?.(request, model, options?.attemptScope, options?.signal);
			if (replacementPayload !== undefined) {
				request = replacementPayload;
			}

			const response = await fetch(endpoint, {
				method: "POST",
				headers: { ...kiroApiHeaders(apiKey, CHAT_TARGET), ...(options.headers ?? {}) },
				body: JSON.stringify(request),
				...(usesExplicitBaseUrl ? {} : { redirect: "error" as const }),
				signal: options.signal,
			});
			if (!response.ok) {
				const errBody = await response.text().catch(() => "");
				throw withHttpStatus(
					new Error(sanitizeKiroError(`Kiro API key HTTP ${response.status}: ${errBody.slice(0, 1000)}`, apiKey)),
					response.status,
				);
			}
			if (!response.body) throw new Error("Kiro API key response has no body");

			stream.push({ type: "start", partial: output });
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let lastContent = "";
			let currentTool: { id: string; name: string; input: string } | undefined;
			let thinkingIndex: number | undefined;
			let textIndex: number | undefined;

			const flushTool = () => {
				if (!currentTool) return;
				const args = currentTool.input.trim() ? currentTool.input : "{}";
				let parsed: unknown = {};
				try {
					parsed = JSON.parse(args);
				} catch {
					parsed = {};
				}
				const toolCall: ToolCall = {
					type: "toolCall",
					id: currentTool.id,
					name: currentTool.name,
					arguments: parsed as Record<string, unknown>,
				};
				const index = blocks.length;
				blocks.push({ ...toolCall, index });
				stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				stream.push({ type: "toolcall_delta", contentIndex: index, delta: args, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
				currentTool = undefined;
			};

			const emitText = (delta: string) => {
				if (thinkingIndex !== undefined) {
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: "",
						partial: output,
					});
					thinkingIndex = undefined;
				}
				if (textIndex === undefined) {
					textIndex = blocks.length;
					blocks.push({ type: "text", text: "", index: textIndex });
					stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
				}
				const block = blocks[textIndex] as TextContent;
				block.text += delta;
				stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
			};

			const emitThinking = (delta: string) => {
				if (thinkingIndex === undefined) {
					thinkingIndex = blocks.length;
					blocks.push({ type: "thinking", thinking: "", index: thinkingIndex } as ThinkingContent & {
						index: number;
					});
					stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
				}
				const block = blocks[thinkingIndex] as ThinkingContent;
				block.thinking += delta;
				stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
			};

			let inThink = false;
			let thinkBuf = "";
			const consumeContent = (raw: string) => {
				thinkBuf += raw;
				while (true) {
					if (!inThink) {
						const start = thinkBuf.indexOf("<thinking>");
						if (start < 0) {
							if (thinkBuf) {
								emitText(thinkBuf);
								thinkBuf = "";
							}
							return;
						}
						if (start > 0) emitText(thinkBuf.slice(0, start));
						thinkBuf = thinkBuf.slice(start + "<thinking>".length);
						inThink = true;
					} else {
						const end = thinkBuf.indexOf("</thinking>");
						if (end < 0) {
							if (thinkBuf) {
								emitThinking(thinkBuf);
								thinkBuf = "";
							}
							return;
						}
						if (end > 0) emitThinking(thinkBuf.slice(0, end));
						thinkBuf = thinkBuf.slice(end + "</thinking>".length);
						inThink = false;
						if (thinkingIndex !== undefined) {
							stream.push({
								type: "thinking_end",
								contentIndex: thinkingIndex,
								content: "",
								partial: output,
							});
							thinkingIndex = undefined;
						}
					}
				}
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const { events, remaining } = parseKiroApiEvents(buffer);
				buffer = remaining;
				for (const event of events) {
					if (event.type === "content") {
						if (event.data === lastContent) continue;
						lastContent = event.data;
						consumeContent(event.data);
					} else if (event.type === "toolUse") {
						if (currentTool && currentTool.id !== event.data.toolUseId) flushTool();
						if (!currentTool) {
							currentTool = { id: event.data.toolUseId, name: event.data.name, input: event.data.input };
						} else {
							currentTool.input += event.data.input;
						}
						if (event.data.stop) flushTool();
					} else if (event.type === "toolUseInput" && currentTool) {
						currentTool.input += event.data.input;
					} else if (event.type === "toolUseStop" && event.data.stop) {
						flushTool();
					} else if (event.type === "usage") {
						if (event.data.inputTokens !== undefined) output.usage.input = event.data.inputTokens;
						if (event.data.outputTokens !== undefined) output.usage.output = event.data.outputTokens;
						output.usage.totalTokens = output.usage.input + output.usage.output;
					} else if (event.type === "error") {
						throw new Error(sanitizeKiroError(`${event.data.error}: ${event.data.message ?? ""}`, apiKey));
					}
				}
			}
			flushTool();
			if (textIndex !== undefined) {
				const block = blocks[textIndex] as TextContent;
				stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
			}
			const hasText = blocks.some(b => b.type === "text" && b.text.length > 0);
			const hasTools = blocks.some(b => b.type === "toolCall");
			if (!hasText && !hasTools) {
				output.stopReason = "error";
				output.errorMessage = "Kiro API key stream returned no tokens";
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
				return;
			}
			output.stopReason = hasTools ? "toolUse" : "stop";
			if (!output.usage.output && hasText) {
				const text = blocks
					.filter((b): b is TextContent => b.type === "text")
					.map(b => b.text)
					.join("");
				output.usage.output = Math.max(1, Math.floor(text.length / 4));
				output.usage.totalTokens = output.usage.input + output.usage.output;
			}
			stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = sanitizeKiroError(error, apiKey);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch(() => {
		try {
			stream.end();
		} catch {
			// ignore
		}
	});
	return stream;
};
