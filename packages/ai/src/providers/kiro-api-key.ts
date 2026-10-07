/**
 * Kiro API-key (ksk_) transport.
 *
 * Headless Kiro Pro keys authenticate against the Kiro service root with
 * `tokentype: API_KEY` and `origin: AI_EDITOR`. This is distinct from the
 * AWS SSO OIDC / CodeWhisperer streaming path used by `gjc auth-broker login kiro`.
 */
import { $env } from "@gajae-code/utils";
import { assertAwsRegionLabel } from "../adapter-internals/aws-region";
import {
	getProviderSafetyStopModelIdentity,
	getProviderSafetyStopWireModelId,
	isProviderSafetyStopAdapterInvocation,
	mintProviderSafetyStop,
	PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
	registerProviderSafetyStopModel,
} from "../adapter-internals/provider-safety-stop";
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

/**
 * Trust assumption: globalThis.fetch is treated as a trusted source for authenticated
 * provider safety stops. The Kiro API-key transport does not support caller-provided
 * fetch overrides (test injection via options.fetch is not supported). Tests that need
 * to mock Kiro responses should use the provider test harness or mock at a higher level.
 *
 * This trust assumption is safe in runtime contexts where globalThis.fetch is the
 * system-provided implementation and cannot be replaced after module load.
 */

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

export function sanitizeKiroError(value: unknown, secret?: string): string {
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
		modelId: "claude-opus-5.5",
		modelName: "Claude Opus 5.5",
		maxInputTokens: 1_000_000,
		maxOutputTokens: 128_000,
		image: false,
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
		// Register as trusted identity if baseUrl is an official region-derived endpoint
		if (isRegionDerivedKiroApiBaseUrl(baseUrl)) {
			registerProviderSafetyStopModel(model);
		}
		models.push(model);
		const dashed = toGjcModelId(item.modelId);
		if (dashed !== item.modelId) {
			const dashedModel = { ...model, id: dashed };
			if (isRegionDerivedKiroApiBaseUrl(baseUrl)) {
				registerProviderSafetyStopModel(dashedModel);
			}
			models.push(dashedModel);
		}
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
	const response = await globalThis.fetch(baseUrl, {
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
		// Register as trusted identity if baseUrl is an official region-derived endpoint
		if (isRegionDerivedKiroApiBaseUrl(baseUrl)) {
			registerProviderSafetyStopModel(model);
		}
		const dashed = toGjcModelId(item.modelId);
		if (dashed !== item.modelId) {
			const dashedModel = { ...model, id: dashed };
			if (isRegionDerivedKiroApiBaseUrl(baseUrl)) {
				registerProviderSafetyStopModel(dashedModel);
			}
			models.push(dashedModel);
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
	| {
			type: "refusal";
			data: { stopReason?: string; stopDetails?: { refusal?: { category?: string; explanation?: string } } };
	  }
	| { type: "error"; data: { error: string; message?: string } };

// Removed EVENT_PATTERNS: now scans for any '{' and parses complete JSON objects,
// independent of property order (fixes #6150 where refusal was missed when
// stopReason/stopDetails was not the first property)

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
	// Bounded retention: if we find stray/invalid JSON, rescan up to this distance ahead
	// looking for a valid JSON object. If we don't find one, return what we have.
	const MAX_RESCAN_DISTANCE = 64 * 1024; // 64KB

	while (pos < buffer.length) {
		// Find next '{' character (property-order independent scan)
		const start = buffer.indexOf("{", pos);
		if (start < 0) break;

		const end = findJsonEnd(buffer, start);
		if (end < 0) {
			// Unclosed brace at 'start'. Could be incomplete JSON waiting for more data, or junk/corruption.
			// Resync by looking for valid JSON objects within MAX_RESCAN_DISTANCE that parse successfully.
			const strayBraceEnd = Math.min(start + MAX_RESCAN_DISTANCE, buffer.length);
			let resyncPos = start + 1;
			let found = false;
			while (resyncPos < strayBraceEnd) {
				const nextStart = buffer.indexOf("{", resyncPos);
				if (nextStart < 0) break;

				// Try to find the end of this candidate
				const nextEnd = findJsonEnd(buffer, nextStart);
				if (nextEnd >= 0) {
					// Found a candidate that closes. Try to parse it as valid JSON.
					try {
						const candidate = buffer.slice(nextStart, nextEnd + 1);
						JSON.parse(candidate);
						// Valid JSON found. Resync to this position and continue processing.
						pos = nextStart;
						found = true;
						break;
					} catch {
						// Not valid JSON, keep looking
					}
				}
				resyncPos = nextStart + 1;
			}
			if (!found) {
				// No valid JSON found within MAX_RESCAN_DISTANCE. Retain the stray brace and data up to the cap
				// for the next parse call. Enforce the MAX_RESCAN_DISTANCE cap to prevent unbounded buffering.
				return { events, remaining: buffer.slice(start, start + MAX_RESCAN_DISTANCE) };
			}
			// Loop will continue with the resynced pos
			continue;
		}

		let parsed: Record<string, unknown> | undefined;
		try {
			parsed = JSON.parse(buffer.slice(start, end + 1)) as Record<string, unknown>;

			// Classify event based on fields present (order-independent)
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
			}

			// Check for usage first (before refusal) to ensure it gets processed even if refusal terminates the stream
			if (parsed.usage && typeof parsed.usage === "object") {
				const u = parsed.usage as { inputTokens?: number; outputTokens?: number };
				events.push({ type: "usage", data: u });
			}

			// Check for refusal after usage so that usage is processed first and recorded before refusal terminates
			// This check is now order-independent: stopDetails can appear at any position in the JSON object
			if (
				typeof parsed.stopDetails === "object" &&
				parsed.stopDetails !== null &&
				(parsed.stopDetails as Record<string, unknown>).refusal
			) {
				// Emit refusal event if stopDetails contains actual refusal data
				events.push({
					type: "refusal",
					data: {
						stopReason: parsed.stopReason as string | undefined,
						stopDetails: parsed.stopDetails as { refusal?: { category?: string; explanation?: string } },
					},
				});
				// Normal terminal metadata (stopReason: "COMPLETED", etc.) without refusal data is ignored
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
			// JSON parsing failed for a balanced frame: could be a junk wrapper like '{junk{...}}'
			// Rescan for valid JSON objects inside the failed frame
			const strayBraceEnd = Math.min(start + MAX_RESCAN_DISTANCE, buffer.length);
			let resyncPos = start + 1;
			let found = false;
			while (resyncPos < strayBraceEnd) {
				const nextStart = buffer.indexOf("{", resyncPos);
				if (nextStart < 0 || nextStart > end) break; // Don't go past the found end

				// Try to find the end of this candidate
				const nextEnd = findJsonEnd(buffer, nextStart);
				if (nextEnd >= 0) {
					// Found a candidate that closes. Try to parse it as valid JSON.
					try {
						const candidate = buffer.slice(nextStart, nextEnd + 1);
						JSON.parse(candidate);
						// Valid JSON found. Resync to this position and continue processing.
						pos = nextStart;
						found = true;
						break;
					} catch {
						// Not valid JSON, keep looking
					}
				}
				resyncPos = nextStart + 1;
			}
			if (found) {
				// Found valid JSON inside the junk wrapper, continue processing from there
				continue;
			}
			// No valid JSON found; just skip this malformed frame
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
		const startTime = Date.now();
		let firstTokenEmitted = false;
		let firstTokenTime: number | undefined;

		// Initialize output with default values; will be updated inside try block with snapshotted model identity
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "kiro-codewhisperer-stream" as Api,
			provider: "",
			model: "",
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

		// Variables for streaming tool calls (initialized before try block so they're accessible in catch)
		let currentTool: { id: string; name: string; input: string } | undefined;
		let toolComplete = false; // Track whether the current tool has been completed (has stop flag)
		let toolcallIndex: number | undefined;
		const pendingToolCalls: Array<{ input: string; toolCall: ToolCall; index: number }> = [];

		try {
			// Use validated identity snapshot from trust check if available (no second read of getters),
			// otherwise snapshot model properties now to prevent TOCTOU attacks.
			let modelSnapshot = getProviderSafetyStopModelIdentity(options);
			let wireModelIdFromSnapshot = getProviderSafetyStopWireModelId(options);
			if (!modelSnapshot) {
				// Trust check didn't provide snapshot; snapshot properties now
				modelSnapshot = Object.freeze({
					provider: model.provider,
					id: model.id,
					baseUrl: model.baseUrl,
					api: "kiro-codewhisperer-stream" as Api,
				});
				wireModelIdFromSnapshot = model.wireModelId;
			}

			// Update output with snapshotted model identity
			output.api = (modelSnapshot.api as Api) || ("kiro-codewhisperer-stream" as Api);
			output.provider = modelSnapshot.provider || "";
			output.model = modelSnapshot.id || "";

			if (!isKiroApiKey(apiKey)) {
				throw new Error(
					"Kiro API key missing. Set KIRO_API_KEY to a ksk_ key from https://app.kiro.dev/settings/api-keys.",
				);
			}

			const configuredBaseUrl = modelSnapshot.baseUrl || "";
			const usesExplicitBaseUrl = Boolean(configuredBaseUrl) && !isRegionDerivedKiroApiBaseUrl(configuredBaseUrl);
			const endpoint = configuredBaseUrl || kiroApiBaseUrl(kiroApiRegion(options));
			// Create a snapshotted model view for downstream functions to use
			const snapshotModel: Model<"kiro-codewhisperer-stream"> = {
				...model,
				provider: (modelSnapshot.provider || model.provider) as string,
				id: (modelSnapshot.id || model.id) as string,
				baseUrl: (modelSnapshot.baseUrl ?? model.baseUrl) as string,
				wireModelId: wireModelIdFromSnapshot ?? model.wireModelId,
			};
			let request = buildApiKeyRequest(snapshotModel, context, options);
			const replacementPayload = await options?.onPayload?.(
				request,
				snapshotModel,
				options?.attemptScope,
				options?.signal,
			);
			if (replacementPayload !== undefined) {
				request = replacementPayload;
			}

			const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
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
			let thinkingIndex: number | undefined;
			let textIndex: number | undefined;

			// Add tool to blocks without emitting events (deferred until stream end)
			const addToolToBlocks = () => {
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
				if (toolcallIndex === undefined) {
					toolcallIndex = index;
				}
				const toolArgs =
					typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
						? (parsed as Record<string, unknown>)
						: {};
				const normalizedArgs = JSON.stringify(toolArgs);
				pendingToolCalls.push({ input: normalizedArgs, toolCall, index });
				currentTool = undefined;
			};

			// Emit accumulated tool call events (only called at stream end if no refusal)
			const emitPendingToolCalls = () => {
				for (const { input, toolCall, index } of pendingToolCalls) {
					stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
					stream.push({
						type: "toolcall_delta",
						contentIndex: index,
						delta: input,
						partial: output,
					});
					stream.push({
						type: "toolcall_end",
						contentIndex: index,
						toolCall,
						partial: output,
					});
				}
				pendingToolCalls.length = 0;
			};

			// Clear pending tool calls without emitting events (on refusal)
			const clearPendingToolCalls = () => {
				pendingToolCalls.length = 0;
				currentTool = undefined;
				toolComplete = false; // Reset tool completion flag
			};

			let textStartDeferred = false; // Track if text_start has been deferred pending thinking

			const appendText = (delta: string) => {
				// Set firstTokenTime on first real (non-thinking) text delta
				if (!firstTokenEmitted) {
					firstTokenEmitted = true;
					firstTokenTime = Date.now();
				}
				if (thinkingIndex !== undefined) {
					thinkingIndex = undefined;
				}
				if (textIndex === undefined) {
					textIndex = blocks.length;
					blocks.push({ type: "text", text: "", index: textIndex });
					// Defer text_start emission if thinking might come before text.
					// thinkingAccumulated is non-empty means we've seen thinking in this or prior content events.
					// We don't know yet if more thinking will come, so defer text_start until stream end.
					if (thinkingAccumulated.length === 0) {
						// No thinking yet; safe to emit text_start now
						stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
					} else {
						// Thinking exists; defer text_start until we know thinking position
						textStartDeferred = true;
					}
				}
				const block = blocks[textIndex] as TextContent;
				block.text += delta;
				// Only emit text_delta if text_start was already emitted
				if (!textStartDeferred) {
					stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
				}
			};

			// Emit deferred text events if text_start was not yet sent
			const emitDeferredTextEvents = () => {
				if (textStartDeferred && textIndex !== undefined && textIndex < blocks.length) {
					const block = blocks[textIndex];
					if (block && block.type === "text") {
						stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
						if (block.text.length > 0) {
							stream.push({
								type: "text_delta",
								contentIndex: textIndex,
								delta: block.text,
								partial: output,
							});
						}
						textStartDeferred = false;
					}
				}
			};

			// Emit text_end if text block was opened
			const closeTextBlock = () => {
				if (textIndex !== undefined) {
					const block = blocks[textIndex] as TextContent;
					stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
					textIndex = undefined;
				}
			};

			let inThink = false;
			let thinkBuf = "";
			let thinkingAccumulated = ""; // Buffer thinking until end or refusal

			const consumeContent = (raw: string) => {
				thinkBuf += raw;
				while (true) {
					if (!inThink) {
						const start = thinkBuf.indexOf("<thinking>");
						if (start < 0) {
							if (thinkBuf) {
								appendText(thinkBuf);
								thinkBuf = "";
							}
							return;
						}
						if (start > 0) appendText(thinkBuf.slice(0, start));
						thinkBuf = thinkBuf.slice(start + "<thinking>".length);
						inThink = true;
					} else {
						const end = thinkBuf.indexOf("</thinking>");
						if (end < 0) {
							if (thinkBuf) {
								thinkingAccumulated += thinkBuf;
								thinkBuf = "";
							}
							return;
						}
						if (end > 0) thinkingAccumulated += thinkBuf.slice(0, end);
						thinkBuf = thinkBuf.slice(end + "</thinking>".length);
						inThink = false;
					}
				}
			};

			// Emit accumulated thinking (from buffer)
			const emitThinking = () => {
				if (!thinkingAccumulated) return;
				if (thinkingIndex === undefined) {
					if (textIndex !== undefined && !textStartDeferred) {
						// Text_start has already been emitted (not deferred) with contentIndex.
						// Do NOT insert thinking before text (would change text's index).
						// Append thinking after all emitted blocks.
						thinkingIndex = blocks.length;
						blocks.push({
							type: "thinking",
							thinking: thinkingAccumulated,
							index: thinkingIndex,
						} as ThinkingContent & { index: number });
					} else {
						// Text has not started streaming yet, or text_start was deferred.
						// Thinking can take index 0 to preserve provider order.
						thinkingIndex = 0;
						blocks.unshift({
							type: "thinking",
							thinking: thinkingAccumulated,
							index: 0,
						} as ThinkingContent & { index: number });
						// Update indices of blocks that were shifted
						for (let i = 1; i < blocks.length; i++) {
							(blocks[i] as Block).index = i;
						}
						// Update state tracking variables for shifted blocks
						if (textIndex !== undefined) textIndex += 1;
						if (toolcallIndex !== undefined) toolcallIndex += 1;
						// Update indices in pending tool calls since all blocks shifted by 1
						for (const pending of pendingToolCalls) {
							pending.index += 1;
						}
					}
					stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingIndex,
						delta: thinkingAccumulated,
						partial: output,
					});
					stream.push({
						type: "thinking_end",
						contentIndex: thinkingIndex,
						content: thinkingAccumulated,
						partial: output,
					});
				}
			};

			// Process events incrementally as they arrive (streaming, no full-response buffering)
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const { events, remaining } = parseKiroApiEvents(buffer);
				buffer = remaining;

				// Check if any refusal events are present in this batch.
				// Refusals suppress all content/tool events, but ordinary errors allow prior events to stream.
				const hasTerminalEvent = events.some(e => e.type === "refusal");

				for (const event of events) {
					if (event.type === "content") {
						if (!hasTerminalEvent) {
							if (event.data === lastContent) continue;
							lastContent = event.data;
							consumeContent(event.data);
						}
					} else if (event.type === "toolUse") {
						if (!hasTerminalEvent) {
							if (!firstTokenEmitted) {
								firstTokenEmitted = true;
								firstTokenTime = Date.now();
							}
							if (currentTool && currentTool.id !== event.data.toolUseId) {
						// Only emit previous tool if it was completed
						if (toolComplete) addToolToBlocks();
						currentTool = undefined; // Clear the incomplete tool
						toolComplete = false; // Reset for new tool
					}
							if (!currentTool) {
								currentTool = { id: event.data.toolUseId, name: event.data.name, input: event.data.input };
								toolComplete = false; // New tool starts as incomplete
							} else {
								currentTool.input += event.data.input;
							}
							if (event.data.stop) {
								toolComplete = true; // Mark tool as complete when stop flag is set
								addToolToBlocks();
							}
						}
					} else if (event.type === "toolUseInput" && currentTool && !hasTerminalEvent) {
						if (!firstTokenEmitted) {
							firstTokenEmitted = true;
							firstTokenTime = Date.now();
						}
						currentTool.input += event.data.input;
					} else if (event.type === "toolUseStop" && event.data.stop) {
						toolComplete = true; // Mark tool as complete when toolUseStop is received
						addToolToBlocks();
					} else if (event.type === "usage") {
						if (event.data.inputTokens !== undefined) output.usage.input = event.data.inputTokens;
						if (event.data.outputTokens !== undefined) output.usage.output = event.data.outputTokens;
						output.usage.totalTokens = output.usage.input + output.usage.output;
					} else if (event.type === "refusal") {
						const refusalData = event.data as {
							stopReason?: string;
							stopDetails?: { refusal?: { category?: string; explanation?: string } };
						};
						if (refusalData.stopDetails?.refusal) {
							// Handle refusal: clear blocks and emit error (don't emit any text/tool that came before)
							consumeContent(""); // Flush any pending thinking
							clearPendingToolCalls(); // DROP any pending tool call without emitting events

							const refusal = refusalData.stopDetails.refusal;
							const category = refusal.category;
							const explanation = refusal.explanation?.trim();
							const label = category ? `Kiro refused the request (${category})` : "Kiro refused the request";

							output.stopReason = "error";
							output.errorMessage = sanitizeKiroError(explanation ? `${label}: ${explanation}` : label, apiKey);
							output.content = [];

							// Mint provider safety stop
							// Do not pass options.fetch as callerTransport: the refusal came from the
							// provider's response, not from a caller-controlled fabrication.
							const adapterInvocation = isProviderSafetyStopAdapterInvocation(options);

							const authenticated = mintProviderSafetyStop(
								output,
								"refusal",
								PROVIDER_SAFETY_STOP_ADAPTER_CAPABILITY,
								undefined,
								adapterInvocation,
							);

							if (!authenticated) {
								output.transportFailure = {
									kind: "transport",
									status: 500,
									providerCode: "untrusted_safety_stop",
								};
							}

							output.duration = Date.now() - startTime;
							if (firstTokenTime) output.ttft = firstTokenTime - startTime;
							stream.push({ type: "error", reason: "error", error: output });
							stream.end();
							return;
						}
					} else if (event.type === "error") {
						// On ordinary errors, flush pending COMPLETED tool events before the error terminal
						// (refusals drop them, incomplete tools must not be emitted)
						// Only emit the tool if it was explicitly completed (has stop flag)
						if (toolComplete) addToolToBlocks();
						emitPendingToolCalls();

						// Preserve any already-accumulated text in the error context
						const accumulatedText = blocks
							.filter((b): b is TextContent => b.type === "text")
							.map(b => b.text)
							.join("");
						const errorMsg = sanitizeKiroError(`${event.data.error}: ${event.data.message ?? ""}`, apiKey);
						const fullErrorMsg = accumulatedText ? `${errorMsg}\n\nPartial output: ${accumulatedText}` : errorMsg;
						throw new Error(fullErrorMsg);
					}
				}
			}

			// Stream is done - add any pending tool, emit accumulated thinking, then deferred text, then close text block
			// Emit tool if explicitly completed or if stream end (implicit completion)
			if (currentTool) addToolToBlocks();
			emitThinking();
			emitDeferredTextEvents();
			// Now emit all tool call events in order (safe since no refusal occurred)
			emitPendingToolCalls();
			closeTextBlock();
			const hasText = blocks.some(b => b.type === "text" && b.text.length > 0);
			const hasTools = blocks.some(b => b.type === "toolCall");
			if (!hasText && !hasTools) {
				output.stopReason = "error";
				output.errorMessage = "Kiro API key stream returned no tokens";
				output.duration = Date.now() - startTime;
				if (firstTokenTime) output.ttft = firstTokenTime - startTime;
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
			// Rebuild output.content with blocks (thinking first if inserted at index 0, otherwise append order)
			output.content = blocks.filter(
				(b): b is TextContent | ThinkingContent | ToolCall =>
					b.type === "text" || b.type === "thinking" || b.type === "toolCall",
			);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			// On ordinary errors (including reader.read() throws), emit only COMPLETED tool events
			// before the error terminal (same semantics as the ordinary-error flush in the event loop).
			// Incomplete currentTool is NOT finalized/emitted (only completed tools in pendingToolCalls flush).
			// Refusals drop them via clearPendingToolCalls, but ordinary errors preserve content consistency.

			// Emit all pending tool call events (inline of emitPendingToolCalls logic)
			for (const { input, toolCall, index } of pendingToolCalls) {
				stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: index,
					delta: input,
					partial: output,
				});
				stream.push({
					type: "toolcall_end",
					contentIndex: index,
					toolCall,
					partial: output,
				});
			}
			pendingToolCalls.length = 0;

			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = sanitizeKiroError(error, apiKey);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
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
