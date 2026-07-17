/**
 * Predict the user's likely next prompt after an agent turn using a smol,
 * fast model. Native GJC port of the ghost-text prompt-suggestion behavior
 * from Claude Code: the prediction renders as dim ghost text in the empty
 * composer and Tab accepts it.
 */
import type { AgentMessage } from "@gajae-code/agent-core";
import { type Api, type AssistantMessage, completeSimple, type Model } from "@gajae-code/ai";
import { logger, prompt } from "@gajae-code/utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import suggestionSystemPrompt from "../prompts/system/prompt-suggestion-system.md" with { type: "text" };

const SUGGESTION_SYSTEM_PROMPT = prompt.render(suggestionSystemPrompt);

export const PROMPT_SUGGESTION_MAX_WORDS = 12;
export const PROMPT_SUGGESTION_MAX_CHARS = 100;

const SUGGESTION_MAX_TOKENS = 64;
const REASONING_SAFE_MAX_TOKENS = 1024;
const MAX_CONTEXT_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1500;
const MAX_CONTEXT_CHARS = 8000;

/** Single words a user plausibly types on their own; anything else needs >= 2 words. */
const SINGLE_WORD_ALLOWLIST = new Set([
	"yes",
	"yeah",
	"yep",
	"yea",
	"yup",
	"sure",
	"ok",
	"okay",
	"push",
	"commit",
	"deploy",
	"stop",
	"continue",
	"check",
	"exit",
	"quit",
	"no",
]);

/** Model responses that are meta-statements about staying silent, not suggestions. */
const META_TEXT_PATTERN = /\bsilence is\b|\bstay(s|ing)? silent\b/;

/**
 * Strip wrapper tags and label prefixes a model sometimes adds despite being
 * told to reply with only the suggestion.
 */
export function sanitizePromptSuggestion(raw: string): string {
	return raw
		.trim()
		.replace(/^<(suggestion|response|output|answer|result)>([\s\S]*)<\/\1>$/i, (match, tag: string, inner: string) =>
			// Keep the original when the inner text itself contains the closing
			// tag (nested/ambiguous markup) instead of producing a mangled strip.
			inner.includes(`</${tag.toLowerCase()}>`) || inner.includes(`</${tag.toUpperCase()}>`) ? match : inner,
		)
		.replace(
			/^\s*(suggested\s+(response|reply|input|prompt)|suggestion|response|reply|answer|output|result)\s*:\s*/i,
			"",
		)
		.trim();
}

/**
 * Heuristic gate rejecting model output that would make a bad ghost-text
 * suggestion. Returns the rejection reason, or null when the text is usable.
 */
export function suppressPromptSuggestionReason(text: string): string | null {
	if (!text) return "empty";
	const lower = text.toLowerCase();
	const wordCount = text.trim().split(/\s+/).length;

	if (lower === "done") return "done";
	if (
		lower === "nothing found" ||
		lower === "nothing found." ||
		lower.startsWith("nothing to suggest") ||
		lower.startsWith("no suggestion") ||
		META_TEXT_PATTERN.test(lower) ||
		/^\W*silence\W*$/.test(lower)
	) {
		return "meta_text";
	}
	if (/^\(.*\)$|^\[.*\]$/.test(text)) return "meta_wrapped";
	if (
		lower.startsWith("api error:") ||
		lower.startsWith("prompt is too long") ||
		lower.startsWith("request timed out") ||
		lower.startsWith("invalid api key")
	) {
		return "error_message";
	}
	if (/^\w+:\s/.test(text)) return "prefixed_label";
	if (wordCount < 2 && !text.startsWith("/") && !SINGLE_WORD_ALLOWLIST.has(lower)) return "too_few_words";
	if (wordCount > PROMPT_SUGGESTION_MAX_WORDS) return "too_many_words";
	if (text.length >= PROMPT_SUGGESTION_MAX_CHARS) return "too_long";
	if (/[.!?]\s+[A-Z]/.test(text)) return "multiple_sentences";
	if (/[\n*]|\*\*/.test(text)) return "has_formatting";
	if (
		/thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(
			lower,
		)
	) {
		return "evaluative";
	}
	if (
		/^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(
			text,
		)
	) {
		return "claude_voice";
	}
	return null;
}

function extractTranscriptEntry(message: AgentMessage): { role: "User" | "Assistant"; text: string } | null {
	if (message.role === "user") {
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
		const trimmed = text.trim();
		return trimmed ? { role: "User", text: trimmed } : null;
	}
	if (message.role === "assistant") {
		const text = (message as AssistantMessage).content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.trim();
		return text ? { role: "Assistant", text } : null;
	}
	return null;
}

/**
 * Build a compact recent-conversation transcript for the prediction request.
 * Returns null when there is no user message to predict from.
 */
export function buildPromptSuggestionContext(messages: AgentMessage[]): string | null {
	const entries: { role: "User" | "Assistant"; text: string }[] = [];
	let totalChars = 0;
	for (let index = messages.length - 1; index >= 0 && entries.length < MAX_CONTEXT_MESSAGES; index--) {
		const message = messages[index];
		if (!message) continue;
		const entry = extractTranscriptEntry(message);
		if (!entry) continue;
		const text = entry.text.length > MAX_MESSAGE_CHARS ? `${entry.text.slice(0, MAX_MESSAGE_CHARS)}…` : entry.text;
		if (totalChars + text.length > MAX_CONTEXT_CHARS && entries.length > 0) break;
		entries.push({ role: entry.role, text });
		totalChars += text.length;
	}
	if (!entries.some(entry => entry.role === "User")) return null;
	entries.reverse();
	const transcript = entries.map(entry => `${entry.role}: ${entry.text}`).join("\n\n");
	return `<conversation>\n${transcript}\n</conversation>\n\nPredict the user's next message.`;
}

function getSuggestionModel(
	registry: ModelRegistry,
	settings: Settings,
	currentModel?: Model<Api>,
): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;
	const model = resolveRoleSelection(["default"], settings, availableModels, registry)?.model;
	if (model) return model;
	return currentModel;
}

function extractSuggestionText(contentBlocks: AssistantMessage["content"]): string {
	let text = "";
	for (const content of contentBlocks) {
		if (content.type === "text") {
			text += content.text;
		}
	}
	return text;
}

/**
 * Generate a predicted next user prompt from the recent conversation.
 * Returns null when no usable suggestion is produced (silence is the
 * expected steady state).
 */
export async function generatePromptSuggestion(
	messages: AgentMessage[],
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
): Promise<string | null> {
	const context = buildPromptSuggestionContext(messages);
	if (!context) return null;

	const model = getSuggestionModel(registry, settings, currentModel);
	if (!model) {
		logger.debug("prompt-suggestion: no model available");
		return null;
	}

	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) {
		logger.debug("prompt-suggestion: no API key", { provider: model.provider, id: model.id });
		return null;
	}
	// Resolve metadata after getApiKey so the session-sticky credential for
	// this request is already recorded (same contract as title-generator).
	const metadata = metadataResolver?.(model.provider);

	// A suggestion is a 2-12 word task, but some reasoning backends ignore
	// disableReasoning; reserve output room for the answer after any
	// unavoidable thinking tokens.
	const maxTokens = model.reasoning
		? Math.max(SUGGESTION_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS)
		: SUGGESTION_MAX_TOKENS;

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: [SUGGESTION_SYSTEM_PROMPT],
				messages: [{ role: "user", content: context, timestamp: Date.now() }],
			},
			{
				apiKey,
				maxTokens,
				disableReasoning: true,
				metadata,
			},
		);

		if (response.stopReason === "error") {
			logger.debug("prompt-suggestion: response error", {
				model: `${model.provider}/${model.id}`,
				errorMessage: response.errorMessage,
			});
			return null;
		}

		const suggestion = sanitizePromptSuggestion(extractSuggestionText(response.content));
		const suppressReason = suppressPromptSuggestionReason(suggestion);
		if (suppressReason) {
			logger.debug("prompt-suggestion: suppressed", { reason: suppressReason });
			return null;
		}
		return suggestion;
	} catch (err) {
		logger.debug("prompt-suggestion: error", {
			model: `${model.provider}/${model.id}`,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
