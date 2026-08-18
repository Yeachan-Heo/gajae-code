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

/**
 * Clients (Aside, LangChain, LiteLLM, the Vercel AI SDK, …) routinely
 * serialize an unset optional field as explicit `null` instead of omitting
 * it, and OpenAI itself accepts that. Collapse `null` back to `undefined` so
 * every downstream consumer keeps working against the `T | undefined` shape.
 */
const nullableOptional = <T extends z.ZodType>(schema: T) => schema.nullish().transform(value => value ?? undefined);

/** Present-but-`null` content is empty text, not a 400. */
const requiredContent = baseContent.nullable().transform(value => value ?? "");

export const systemMessageSchema = z.object({
	role: z.literal("system"),
	content: requiredContent,
});

export const developerMessageSchema = z.object({
	role: z.literal("developer"),
	content: requiredContent,
});

export const userMessageSchema = z.object({
	role: z.literal("user"),
	content: requiredContent,
});

export const assistantMessageSchema = z.object({
	role: z.literal("assistant"),
	content: nullableOptional(baseContent),
	tool_calls: nullableOptional(z.array(toolCallSchema)),
});

export const toolMessageSchema = z.object({
	role: z.literal("tool"),
	content: nullableOptional(baseContent),
	tool_call_id: nullableOptional(z.string()),
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
	tools: nullableOptional(z.array(toolSchema)),
	tool_choice: nullableOptional(toolChoiceSchema),
	max_tokens: nullableOptional(z.number()),
	max_completion_tokens: nullableOptional(z.number()),
	temperature: nullableOptional(z.number()),
	top_p: nullableOptional(z.number()),
	stop: nullableOptional(stopSchema),
	stream: nullableOptional(z.boolean()),
	stream_options: nullableOptional(streamOptionsSchema),

	// ── Typed first-class passthroughs (now consumed by the walker) ────────
	response_format: z.unknown().optional(),
	seed: nullableOptional(z.number()),
	presence_penalty: nullableOptional(z.number()),
	frequency_penalty: nullableOptional(z.number()),
	logit_bias: nullableOptional(z.record(z.string(), z.number())),
	user: nullableOptional(z.string()),
	reasoning_effort: nullableOptional(z.enum(["minimal", "low", "medium", "high", "xhigh", "max"])),
	parallel_tool_calls: nullableOptional(z.boolean()),
	service_tier: nullableOptional(z.enum(["auto", "default", "flex", "scale", "priority"])),
	metadata: nullableOptional(z.record(z.string(), z.unknown())),

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
