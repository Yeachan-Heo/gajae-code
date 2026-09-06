/**
 * Kiro / Amazon Q Developer / CodeWhisperer streaming transport.
 *
 * Talks directly to the CodeWhisperer streaming service over HTTPS using
 * a bearer token from AWS SSO OIDC. The response is an
 * `application/vnd.amazon.eventstream`, decoded by the shared
 * `decodeEventStream` primitive from `aws-eventstream.ts`.
 *
 * Clean-room: derived from published Amazon service model shapes
 * (aws-toolkit-vscode CodeWhisperer streaming + codewhispererruntime-2022-11-11),
 * not from any AGPL reference implementation.
 */
import { $credentialEnv, $env, extractHttpStatusFromError } from "@gajae-code/utils";
import { assertAwsRegionLabel } from "../adapter-internals/aws-region";
import type { Effort } from "../model-thinking";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { transportFailureFacts } from "../utils/fallback-transport";
import { withHttpStatus } from "../utils/http-inspector";
import { captureUnicodeEscapeEvidence } from "../utils/json-parse";
import { decodeEventStream } from "./aws-eventstream";
import { isKiroApiKey, streamKiroApiKey, toKiroModelId } from "./kiro-api-key";

// ─────────────────────────────────────────────────────────────────────────────
// Provider options
// ─────────────────────────────────────────────────────────────────────────────

export interface KiroCodeWhispererOptions extends StreamOptions {
	/** Effort level for Kiro API-key reasoning. */
	reasoning?: Effort | boolean;
	/** AWS region for the CodeWhisperer streaming endpoint. */
	region?: string;
	/** Profile ARN for enterprise IAM Identity Center accounts. */
	profileArn?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CodeWhisperer streaming wire types
// ─────────────────────────────────────────────────────────────────────────────

interface WireToolSpec {
	toolSpecification: {
		name: string;
		description?: string;
		inputSchema: { json: unknown };
	};
}

interface WireToolResult {
	toolResultMessage: {
		content: string;
		toolUseId: string;
		status?: "success" | "error";
	};
}

interface WireUserMessage {
	userInputMessage: {
		content: string;
		modelId?: string;
		userInputMessageContext?: {
			tools?: { tools: WireToolSpec[] };
			toolResults?: { toolResults: WireToolResult[][] };
			editorStateContext?: Record<string, unknown>;
		};
		origin?: string;
	};
}

interface WireAssistantMessage {
	assistantResponseMessage: {
		content: string;
	};
}

type WireHistoryMessage = WireUserMessage | WireAssistantMessage;

interface ConversationState {
	chatTriggerType: "MANUAL";
	currentMessage: WireUserMessage;
	history?: WireHistoryMessage[];
	profileArn?: string;
	customizationArn?: string;
}

interface GenerateAssistantResponseRequest {
	conversationState: ConversationState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response eventstream types (ChatResponseStream union members)
// ─────────────────────────────────────────────────────────────────────────────

interface AssistantResponseEvent {
	assistantResponseEvent?: {
		content?: string;
	};
}

interface ToolUseEventPayload {
	toolUseEvent?: {
		toolUseId?: string;
		name?: string;
		input?: unknown;
		stop?: { stopReason?: string };
	};
}

interface MessageMetadataEvent {
	messageMetadataEvent?: {
		conversationId?: string;
		utteranceId?: string;
	};
}

interface ErrorPayload {
	error?: {
		message?: string;
		code?: string;
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_REGION = "us-east-1";
const STREAMING_SERVICE_NAME = "amazoncodewhispererstreamingservice";

type Block = (TextContent | ToolCall) & { index?: number; partialJson?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Stream function
// ─────────────────────────────────────────────────────────────────────────────

export const streamKiroCodeWhisperer: StreamFunction<"kiro-codewhisperer-stream"> = (
	model: Model<"kiro-codewhisperer-stream">,
	context: Context,
	options: KiroCodeWhispererOptions,
): AssistantMessageEventStream => {
	const token = resolveBearerToken(options.apiKey);
	if (isKiroApiKey(token)) {
		return streamKiroApiKey(model, context, { ...options, apiKey: token });
	}

	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

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
		const region = options.region ?? $env.KIRO_REGION ?? $env.AWS_REGION ?? $env.AWS_DEFAULT_REGION ?? DEFAULT_REGION;

		try {
			assertAwsRegionLabel(region);
			// Resolve bearer token
			const bearerToken = resolveBearerToken(options.apiKey);
			if (!bearerToken) {
				throw new Error(
					"No Kiro credentials found. Set KIRO_API_KEY (ksk_ from https://app.kiro.dev/settings/api-keys) or run 'gjc auth-broker login kiro'.",
				);
			}

			// Build request
			const conversationState = buildConversationState(context, model, options);
			let requestBody: GenerateAssistantResponseRequest = {
				conversationState,
			};

			const replacementPayload = await options?.onPayload?.(
				requestBody,
				model,
				options?.attemptScope,
				options?.signal,
			);
			if (replacementPayload !== undefined) {
				requestBody = replacementPayload as typeof requestBody;
			}

			const host = `${STREAMING_SERVICE_NAME}.${region}.amazonaws.com`;
			const url = `https://${host}/`;

			const bodyText = JSON.stringify(requestBody);
			const body = new TextEncoder().encode(bodyText);
			const requestHeaders: Record<string, string> = {
				"content-type": "application/json",
				accept: "application/vnd.amazon.eventstream",
				authorization: `Bearer ${bearerToken}`,
				"amzn-X-amz-target": "AmazonCodeWhispererService.GenerateAssistantResponse",
			};

			if (options.profileArn) {
				requestHeaders["x-amzn-codewhisperer-proflearn"] = options.profileArn;
			}

			// Merge user-provided headers
			if (options.headers) {
				Object.assign(requestHeaders, options.headers);
			}

			const response = await fetch(url, {
				method: "POST",
				headers: requestHeaders,
				body,
				redirect: "error",
				signal: options.signal,
			});

			if (!response.ok) {
				const errBody = await response.text().catch(() => "");
				throw withHttpStatus(
					new Error(`Kiro CodeWhisperer HTTP ${response.status}: ${errBody.slice(0, 1000)}`),
					response.status,
				);
			}

			if (!response.body) throw new Error("Kiro CodeWhisperer response has no body");

			// Decode eventstream
			for await (const message of decodeEventStream(response.body)) {
				if (options.signal?.aborted) break;

				const messageType = message.headers[":message-type"];
				const eventType = message.headers[":event-type"];

				if (messageType === "exception") {
					const exceptionType = message.headers[":exception-type"] || "Exception";
					const payload = safeParsePayload(message.payload) as { message?: string } | undefined;
					const errorMessage = payload?.message || new TextDecoder().decode(message.payload);
					const status = exceptionType === "ValidationException" ? 400 : 0;
					const err = new Error(`${exceptionType}: ${errorMessage}`);
					throw status ? withHttpStatus(err, status) : err;
				}

				if (messageType === "error") {
					const code = message.headers[":error-code"] || "UnknownError";
					const errorMessage = message.headers[":error-message"] || new TextDecoder().decode(message.payload);
					throw new Error(`${code}: ${errorMessage}`);
				}

				if (messageType !== "event") continue;

				const payload = safeParsePayload(message.payload);
				if (!payload) continue;

				switch (eventType) {
					case "assistantResponseEvent": {
						const ev = payload as AssistantResponseEvent;
						const content = ev.assistantResponseEvent?.content;
						if (content) {
							if (!firstTokenTime) firstTokenTime = Date.now();
							if (blocks.length === 0) {
								stream.push({ type: "start", partial: output });
							}
							handleTextDelta(content, blocks, output, stream);
						}
						break;
					}
					case "toolUseEvent": {
						const ev = payload as ToolUseEventPayload;
						if (!firstTokenTime) firstTokenTime = Date.now();
						if (blocks.length === 0) {
							stream.push({ type: "start", partial: output });
						}
						handleToolUseEvent(ev, blocks, output, stream);
						break;
					}
					case "messageMetadataEvent": {
						const ev = payload as MessageMetadataEvent;
						if (ev.messageMetadataEvent?.conversationId) {
							output.responseId = ev.messageMetadataEvent.conversationId;
						}
						break;
					}
					case "codeReferenceEvent":
					case "supplementaryWebLinksEvent":
					case "followupPromptEvent":
					case "dryRunSucceedEvent":
					case "citationEvent":
					case "intentsEvent":
					case "interactionComponentsEvent":
					case "invalidStateEvent":
						// Known but unhandled events — ignore gracefully
						break;
					default:
						// Unknown event types — ignore (forward compatibility)
						break;
				}

				const errorPayload = payload as ErrorPayload;
				if (errorPayload.error?.message) {
					throw new Error(`Kiro CodeWhisperer stream error: ${errorPayload.error.message}`);
				}
			}

			if (options.signal?.aborted) throw new Error("Request was aborted");

			// Finalize blocks
			for (const block of blocks) {
				delete block.index;
				delete block.partialJson;
			}

			// Determine stop reason
			const hasToolCall = blocks.some(b => b.type === "toolCall");
			output.stopReason = hasToolCall ? "toolUse" : "stop";

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as Block).index;
				delete (block as Block).partialJson;
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorStatus = extractHttpStatusFromError(error);
			output.transportFailure = transportFailureFacts(error);
			const baseMessage = error instanceof Error ? error.message : JSON.stringify(error);
			output.errorMessage = baseMessage;
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

// ─────────────────────────────────────────────────────────────────────────────
// Request building
// ─────────────────────────────────────────────────────────────────────────────

function buildConversationState(
	context: Context,
	model: Model<"kiro-codewhisperer-stream">,
	options: KiroCodeWhispererOptions,
): ConversationState {
	const messages = context.messages;
	if (messages.length === 0) {
		throw new Error("Kiro CodeWhisperer requires at least one message");
	}

	// Normalize the local dashed selector/wire id (e.g. "claude-haiku-4-5") to
	// the canonical dotted upstream Kiro model id (e.g. "claude-haiku-4.5"),
	// matching the sibling ksk_ API-key transport (kiro-api-key.ts) so both
	// auth methods send the same wire form for the same catalog entry.
	const modelId = toKiroModelId(model.wireModelId || model.id);

	// Build history from all messages except the last
	const history: WireHistoryMessage[] = [];
	const systemPrompt = context.systemPrompt?.join("\n") ?? "";

	for (let i = 0; i < messages.length - 1; i++) {
		const msg = messages[i];
		history.push(convertToWireMessage(msg, modelId, i === 0 ? systemPrompt : undefined));
	}

	// Convert the last message as currentMessage
	const lastMsg = messages[messages.length - 1];
	const currentMessage = convertToWireUserMessage(lastMsg, modelId, systemPrompt);

	// Add tools to the current message context
	if (context.tools && context.tools.length > 0) {
		if (!currentMessage.userInputMessage.userInputMessageContext) {
			currentMessage.userInputMessage.userInputMessageContext = {};
		}
		currentMessage.userInputMessage.userInputMessageContext.tools = {
			tools: convertTools(context.tools),
		};
	}

	return {
		chatTriggerType: "MANUAL",
		currentMessage,
		history: history.length > 0 ? history : undefined,
		profileArn: options.profileArn,
	};
}

function convertToWireMessage(
	msg: Context["messages"][number],
	modelId: string,
	systemPrompt?: string,
): WireHistoryMessage {
	if (msg.role === "user") {
		return convertToWireUserMessage(msg, modelId, systemPrompt);
	}
	if (msg.role === "toolResult") {
		return convertToWireUserMessage(msg, modelId, systemPrompt);
	}
	// assistant → assistant response
	const textParts: string[] = [];
	for (const block of msg.content) {
		if (typeof block === "string") {
			textParts.push(block);
		} else if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "toolCall") {
			textParts.push(JSON.stringify({ toolUseId: block.id, name: block.name, input: block.arguments }));
		}
	}
	return {
		assistantResponseMessage: {
			content: textParts.join("\n") || "",
		},
	};
}

function convertToWireUserMessage(
	msg: Context["messages"][number],
	modelId: string,
	systemPrompt?: string,
): WireUserMessage {
	let content = extractTextContent(msg);
	if (systemPrompt) {
		content = `${systemPrompt}\n\n${content}`;
	}

	const userMsg: WireUserMessage = {
		userInputMessage: {
			content,
			modelId,
		},
	};

	// Handle tool results
	if (msg.role === "toolResult") {
		const toolResultMsg = msg as ToolResultMessage;
		const toolResults = (toolResultMsg.content ?? []).map(detail => ({
			toolResultMessage: {
				content: detail.type === "text" ? detail.text : "",
				toolUseId: toolResultMsg.toolCallId,
				status: toolResultMsg.isError ? ("error" as const) : ("success" as const),
			},
		}));
		if (toolResults.length > 0) {
			if (!userMsg.userInputMessage.userInputMessageContext) {
				userMsg.userInputMessage.userInputMessageContext = {};
			}
			userMsg.userInputMessage.userInputMessageContext.toolResults = { toolResults: [toolResults] };
		}
	}

	return userMsg;
}

function extractTextContent(msg: Context["messages"][number]): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.map(block => {
				if (typeof block === "string") return block;
				if (block.type === "text") return block.text;
				if (block.type === "image") return ""; // Images not supported in text field
				return "";
			})
			.join("");
	}
	return "";
}

function convertTools(tools: Tool[]): WireToolSpec[] {
	return tools.map(tool => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: {
				json: tool.parameters ?? {},
			},
		},
	}));
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handling
// ─────────────────────────────────────────────────────────────────────────────

function handleTextDelta(
	delta: string,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	// Find or create the last text block
	let lastBlock = blocks[blocks.length - 1];
	if (lastBlock?.type !== "text") {
		const newBlock: Block = { type: "text", text: "", index: blocks.length };
		blocks.push(newBlock);
		lastBlock = newBlock;
		stream.push({ type: "text_start", contentIndex: newBlock.index!, partial: output });
	}
	lastBlock.text += delta;
	stream.push({ type: "text_delta", contentIndex: lastBlock.index!, delta, partial: output });
}

function handleToolUseEvent(
	ev: ToolUseEventPayload,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const toolEvent = ev.toolUseEvent;
	if (!toolEvent) return;

	const toolUseId = toolEvent.toolUseId ?? "";
	const name = toolEvent.name ?? "";

	// If input is provided as a complete object, emit toolcall_end
	if (toolEvent.input !== undefined && toolEvent.input !== null) {
		const inputStr = typeof toolEvent.input === "string" ? toolEvent.input : JSON.stringify(toolEvent.input);
		const toolCall: ToolCall = {
			type: "toolCall",
			id: toolUseId,
			name,
			arguments: safeParseJson(inputStr) as Record<string, any>,
		};
		if (typeof toolEvent.input === "string") captureUnicodeEscapeEvidence(toolCall, inputStr);

		const newBlock: Block = { ...toolCall, index: blocks.length };
		if (typeof toolEvent.input === "string") captureUnicodeEscapeEvidence(newBlock, inputStr);
		blocks.push(newBlock);
		stream.push({ type: "toolcall_end", contentIndex: newBlock.index!, toolCall, partial: output });
		return;
	}

	// Otherwise, accumulate partial input (if the service streams it in chunks)
	// The published model does not document chunked tool input for CodeWhisperer,
	// so this path handles the case defensively but expects complete input per event.
	const toolCall: ToolCall = {
		type: "toolCall",
		id: toolUseId,
		name,
		arguments: {},
	};

	const newBlock: Block = { ...toolCall, index: blocks.length };
	blocks.push(newBlock);
	stream.push({ type: "toolcall_end", contentIndex: newBlock.index!, toolCall, partial: output });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveBearerToken(apiKey: string | undefined): string | undefined {
	if (!apiKey) {
		return $credentialEnv("KIRO_API_KEY") ?? $credentialEnv("AWS_BEARER_TOKEN_KIRO") ?? undefined;
	}

	// Structured API key (from getOAuthApiKey) contains the access token as JSON
	try {
		const parsed = JSON.parse(apiKey) as { token?: string };
		if (parsed.token) return parsed.token;
	} catch {
		// Plain bearer token
	}

	return apiKey;
}

function safeParsePayload(payload: Uint8Array): unknown {
	if (payload.length === 0) return {};
	try {
		const text = new TextDecoder().decode(payload);
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function safeParseJson(str: string): unknown {
	if (!str) return {};
	try {
		return JSON.parse(str);
	} catch {
		return str;
	}
}
