/**
 * Zod schemas for the OpenAI chat-completions request shape we accept on the
 * gateway. Mirrors https://platform.openai.com/docs/api-reference/chat — only
 * the shapes the gateway translation layer understands. Unknown fields on
 * permissive objects are accepted-and-stripped (via `z.unknown()` passthroughs
 * or `.loose()`) so the official OpenAI SDK — which sends a growing pile of
 * non-strict defaults (e.g. `stream_options.include_obfuscation`) — does not
 * trip 400s on shapes we simply ignore.
 */
import type {
	ChatCompletionContentPart,
	ChatCompletionCreateParams,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import * as z from "zod/v4";

// ─── User-message content parts ─────────────────────────────────────────────

export const textPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

/**
 * OpenAI documents `image_url` as either `{ url: string, detail?: ... }` or —
 * older clients — a bare string. Accept both shapes; downstream we extract a
 * URL. `detail` is accepted for forward-compat but currently dropped (pi-ai's
 * `ImageContent` has no detail field — TODO: plumb through if/when added).
 */
export const imagePartSchema = z.object({
	type: z.literal("image_url"),
	image_url: z.union([
		z.string(),
		z.object({
			url: z.string(),
			detail: z.enum(["auto", "low", "high"]).optional(),
		}),
	]),
});

/** OpenAI audio input block (gpt-4o-audio). Accepted; currently dropped downstream. */
export const inputAudioPartSchema = z.object({
	type: z.literal("input_audio"),
	input_audio: z.object({
		data: z.string(),
		format: z.enum(["wav", "mp3"]),
	}),
});

/** OpenAI file input block (file_search / vision-document). Accepted; currently dropped downstream. */
export const filePartSchema = z.object({
	type: z.literal("file"),
	file: z.object({
		file_id: z.string().optional(),
		filename: z.string().optional(),
		file_data: z.string().optional(),
	}),
});

/** Replayed assistant refusal block. Accepted; currently dropped downstream. */
export const refusalPartSchema = z.object({
	type: z.literal("refusal"),
	refusal: z.string(),
});

/**
 * Forward-compat catch-all for unknown content-part types. Matches every other
 * `{ type: string, ... }` object so a new OpenAI block kind does not 400 the
 * whole request; the walker ignores parts whose `type` it does not know.
 */
export const unknownPartSchema = z.object({ type: z.string() }).loose();

export const userContentPartSchema = z.union([
	textPartSchema,
	imagePartSchema,
	inputAudioPartSchema,
	filePartSchema,
	refusalPartSchema,
	unknownPartSchema,
]);

// ─── Tool calls / tools ─────────────────────────────────────────────────────

export const toolCallSchema = z.object({
	id: z.string(),
	type: z.literal("function").optional(),
	function: z.object({
		name: z.string(),
		arguments: z.string(),
	}),
});

export const toolSchema = z.object({
	type: z.literal("function"),
	function: z.object({
		name: z.string().min(1),
		description: z.string().optional(),
		parameters: z.record(z.string(), z.unknown()).optional(),
		/** OpenAI structured-output strict mode. Accepted, not enforced upstream. */
		strict: z.boolean().optional(),
	}),
});

// ─── Tool choice ────────────────────────────────────────────────────────────

export const toolChoiceSchema = z.union([
	z.literal("auto"),
	z.literal("none"),
	z.literal("required"),
	z.object({
		type: z.literal("function"),
		function: z.object({ name: z.string().min(1) }),
	}),
	// Anthropic-style `{ type: 'tool', name }` — translated to the OpenAI
	// function shape in the walker.
	z.object({
		type: z.literal("tool"),
		name: z.string().min(1),
	}),
]);

// ─── Messages ───────────────────────────────────────────────────────────────

const baseContent = z.union([z.string(), z.array(userContentPartSchema)]);

export const systemMessageSchema = z.object({
	role: z.literal("system"),
	content: baseContent,
});

export const developerMessageSchema = z.object({
	role: z.literal("developer"),
	content: baseContent,
});

export const userMessageSchema = z.object({
	role: z.literal("user"),
	content: baseContent,
});

export const assistantMessageSchema = z.object({
	role: z.literal("assistant"),
	content: baseContent.optional(),
	tool_calls: z.array(toolCallSchema).optional(),
});

export const toolMessageSchema = z.object({
	role: z.literal("tool"),
	content: baseContent.optional(),
	tool_call_id: z.string().optional(),
});

/**
 * Legacy `function` role (pre-tools API). Translated to a `tool` role
 * canonical message in the walker so downstream providers see one shape.
 */
export const functionMessageSchema = z.object({
	role: z.literal("function"),
	name: z.string(),
	content: z.string().nullable(),
});

export const messageSchema = z.discriminatedUnion("role", [
	systemMessageSchema,
	developerMessageSchema,
	userMessageSchema,
	assistantMessageSchema,
	toolMessageSchema,
	functionMessageSchema,
]);

// ─── Stream options ─────────────────────────────────────────────────────────

/**
 * Permissive: the official OpenAI SDK sets `include_obfuscation: false` by
 * default. We only consume `include_usage`, so unknown keys are silently
 * stripped rather than 400'd.
 */
export const streamOptionsSchema = z.object({
	include_usage: z.boolean().optional(),
});

// ─── Stop sequences ─────────────────────────────────────────────────────────

// OpenAI rejects > 4 stop strings; mirror that at the gateway.
export const stopSchema = z.union([z.string(), z.array(z.string()).max(4)]);

// ─── Top-level request ──────────────────────────────────────────────────────

export const openaiChatRequestSchema = z.object({
	model: z.string().min(1),
	messages: z.array(messageSchema),
	tools: z.array(toolSchema).optional(),
	tool_choice: toolChoiceSchema.optional(),
	max_tokens: z.number().optional(),
	max_completion_tokens: z.number().optional(),
	temperature: z.number().optional(),
	top_p: z.number().optional(),
	stop: stopSchema.optional(),
	stream: z.boolean().optional(),
	stream_options: streamOptionsSchema.optional(),

	// ── Typed first-class passthroughs (now consumed by the walker) ────────
	response_format: z.unknown().optional(),
	seed: z.number().optional(),
	presence_penalty: z.number().optional(),
	frequency_penalty: z.number().optional(),
	logit_bias: z.record(z.string(), z.number()).optional(),
	user: z.string().optional(),
	reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
	parallel_tool_calls: z.boolean().optional(),
	service_tier: z.enum(["auto", "default", "flex", "scale", "priority"]).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),

	// ── Accept-and-ignore passthroughs ─────────────────────────────────────
	// Forward acceptance only: validating these would 400 on shapes the
	// gateway has no opinion on. The downstream provider does the real check.
	logprobs: z.unknown().optional(),
	top_logprobs: z.unknown().optional(),
	prediction: z.unknown().optional(),
	modalities: z.unknown().optional(),
	audio: z.unknown().optional(),
	store: z.unknown().optional(),
	prompt_cache_key: z.unknown().optional(),
	safety_identifier: z.unknown().optional(),
	n: z.unknown().optional(),
	web_search_options: z.unknown().optional(),
});

/**
 * Public types are sourced from the OpenAI SDK so the gateway stays in
 * lock-step with the canonical API surface; the schemas above are runtime
 * validators for the subset we actually accept.
 */
export type OpenAIChatRequest = ChatCompletionCreateParams;
export type OpenAIChatMessage = ChatCompletionMessageParam;
export type OpenAIChatToolCall = ChatCompletionMessageToolCall;
export type OpenAIChatTool = ChatCompletionTool;
export type OpenAIChatToolChoice = ChatCompletionToolChoiceOption;
export type OpenAIChatContentPart = ChatCompletionContentPart;
