/**
 * Generate a one-line session recap at turn end with the `default` model role.
 */
import { type Api, completeSimple, type Model } from "@gajae-code/ai/core";
import { logger, prompt, redactCrashSecrets, untilAborted } from "@gajae-code/utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import recapSystemPrompt from "../prompts/system/recap-system.md" with { type: "text" };
import { isValidSessionRecapText, SESSION_RECAP_MAX_BYTES, SESSION_RECAP_MAX_CODEPOINTS } from "../sdk/session-recap";
import { titleInputObfuscator } from "./title-generator";

const RECAP_SYSTEM_PROMPT = prompt.render(recapSystemPrompt);

/** Total UTF-8 bytes of the user payload, including the framing tags. */
export const RECAP_MAX_INPUT_BYTES = 8192;
/** The generator accepts exactly what the session store accepts, so a recap it returns can always be committed. */
export const RECAP_MAX_OUTPUT_CODEPOINTS = SESSION_RECAP_MAX_CODEPOINTS;
export const RECAP_MAX_OUTPUT_BYTES = SESSION_RECAP_MAX_BYTES;
export const RECAP_TIMEOUT_MS = 30_000;
const RECAP_MAX_TOKENS = 200;
const REASONING_SAFE_MAX_TOKENS = 1024;

const USER_OPEN = "<session-turn>\n<user-message>\n";
const USER_CLOSE = "\n</user-message>\n";
const ASSISTANT_OPEN = "<assistant-message>\n";
const ASSISTANT_CLOSE = "\n</assistant-message>\n</session-turn>";
const FRAME_BYTES = [USER_OPEN, USER_CLOSE, ASSISTANT_OPEN, ASSISTANT_CLOSE].reduce(
	(sum, part) => sum + Buffer.byteLength(part, "utf8"),
	0,
);

export interface SessionRecapGenerationInput {
	userText: string;
	assistantText: string;
	model: Model<Api>;
	registry: ModelRegistry;
	settings: Settings;
	sessionId: string;
	signal: AbortSignal;
	activeCwd: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
}

export interface SessionRecapGenerationResult {
	text: string;
	/** `provider/id` of the model that produced the recap. */
	model: string;
}

/** Select the recap model from the `default` role, falling back to the current model. */
export function selectRecapModel(
	registry: ModelRegistry,
	settings: Settings,
	currentModel?: Model<Api>,
	sessionId?: string,
): Model<Api> | undefined {
	const availableModels = registry.getAvailable(sessionId);
	if (availableModels.length === 0) return undefined;
	const selected = resolveRoleSelection(["default"], settings, availableModels, registry)?.model;
	return selected ?? currentModel;
}

/** Keep the longest codepoint-aligned prefix (or suffix) of `text` within `maxBytes` UTF-8 bytes. */
function fitBytes(text: string, maxBytes: number, keep: "head" | "tail"): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const chars = Array.from(text);
	if (keep === "tail") chars.reverse();
	const kept: string[] = [];
	let used = 0;
	for (const ch of chars) {
		const size = Buffer.byteLength(ch, "utf8");
		if (used + size > maxBytes) break;
		used += size;
		kept.push(ch);
	}
	if (keep === "tail") kept.reverse();
	return kept.join("");
}

/**
 * Sanitize both full texts first, then split the byte budget so each side keeps
 * content: a side shorter than half leaves its slack to the other side.
 * The user turn keeps its head (the request); the assistant keeps its tail (the outcome).
 */
export function prepareRecapOutboundText(
	userText: string,
	assistantText: string,
	obfuscateText?: (text: string) => string,
): string {
	const user = obfuscateText ? obfuscateText(userText) : userText;
	const assistant = obfuscateText ? obfuscateText(assistantText) : assistantText;
	const budget = RECAP_MAX_INPUT_BYTES - FRAME_BYTES;
	const userBytes = Buffer.byteLength(user, "utf8");
	const assistantBytes = Buffer.byteLength(assistant, "utf8");
	const half = Math.floor(budget / 2);
	let userBudget = Math.min(userBytes, half);
	let assistantBudget = Math.min(assistantBytes, half);
	const slack = budget - userBudget - assistantBudget;
	if (userBytes - userBudget > 0) userBudget += Math.min(slack, userBytes - userBudget);
	const remaining = budget - userBudget - assistantBudget;
	if (assistantBytes - assistantBudget > 0) assistantBudget += Math.min(remaining, assistantBytes - assistantBudget);
	return `${USER_OPEN}${fitBytes(user, userBudget, "head")}${USER_CLOSE}${ASSISTANT_OPEN}${fitBytes(assistant, assistantBudget, "tail")}${ASSISTANT_CLOSE}`;
}

/**
 * Outer whitespace is the only normalization. Everything else is the session store's own validator
 * (controls, line/paragraph separators, bidi and invisible format characters, surrogates, size),
 * so output the store would refuse is dropped here instead of being cut down to fit.
 */
function acceptRecap(raw: string): string | null {
	const text = raw.trim();
	return isValidSessionRecapText(text) ? text : null;
}

/**
 * Generate one recap with a single, tool-less, non-retried request. Any failure,
 * abort, timeout, or unacceptable output yields `null`; output is never truncated.
 */
export async function generateSessionRecap(
	input: SessionRecapGenerationInput,
): Promise<SessionRecapGenerationResult | null> {
	const { model, signal } = input;
	const modelName = `${model.provider}/${model.id}`;
	if (signal.aborted) return null;

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), RECAP_TIMEOUT_MS);
	try {
		const apiKey = await untilAborted(controller.signal, input.registry.getApiKey(model, input.sessionId));
		if (!apiKey) {
			logger.debug("recap-generator: no API key", { model: modelName });
			return null;
		}
		// Resolve metadata after credential selection so it reflects the chosen credential.
		const metadata = input.metadataResolver?.(model.provider);
		const obfuscate = await untilAborted(controller.signal, titleInputObfuscator(input.settings, input.activeCwd));
		const userMessage = prepareRecapOutboundText(input.userText, input.assistantText, obfuscate);
		const maxTokens = model.reasoning ? Math.max(RECAP_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS) : RECAP_MAX_TOKENS;

		const response = await untilAborted(
			controller.signal,
			completeSimple(
				model,
				{
					systemPrompt: [RECAP_SYSTEM_PROMPT],
					messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
					tools: [],
				},
				{
					apiKey,
					maxTokens,
					disableReasoning: true,
					toolChoice: "none",
					requestMaxRetries: 0,
					streamMaxRetries: 0,
					metadata,
					signal: controller.signal,
				},
			),
		);

		if (controller.signal.aborted || response.stopReason !== "stop") {
			logger.debug("recap-generator: rejected response", { model: modelName, stopReason: response.stopReason });
			return null;
		}
		if (`${response.provider}/${response.model}` !== modelName) {
			logger.debug("recap-generator: model mismatch", { model: modelName });
			return null;
		}
		let raw = "";
		for (const block of response.content) {
			if (block.type === "toolCall") return null;
			if (block.type === "text") raw += block.text;
		}
		const text = acceptRecap(obfuscate ? obfuscate(raw) : raw);
		return text ? { text, model: modelName } : null;
	} catch (err) {
		logger.debug("recap-generator: error", {
			model: modelName,
			error: redactCrashSecrets(err instanceof Error ? err.message : String(err)),
		});
		return null;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}
