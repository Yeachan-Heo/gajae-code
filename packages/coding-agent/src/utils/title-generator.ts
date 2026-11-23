/**
 * Generate session titles with the `default` model role.
 */
import * as path from "node:path";

import type { AgentMessage } from "@gajae-code/agent-core";
import { type Api, type AssistantMessage, completeSimple, type Model, type Tool } from "@gajae-code/ai/core";
import { logger, prompt, redactCrashSecrets } from "@gajae-code/utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import { collectEnvSecrets, createSecretObfuscator, loadSecrets } from "../secrets";
import type { SessionManager, SessionMessageEntry } from "../session/session-manager";
import { syncCmuxWorkspaceTitle } from "./cmux-workspace";
import { syncHerdrPaneTitle } from "./herdr-pane";

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);

const DEFAULT_TERMINAL_TITLE = "GJC";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const MAX_TITLE_CONVERSATION_MESSAGES = 6;
const MAX_TITLE_MESSAGE_CHARS = 400;

const MAX_INPUT_CHARS = 2000;
const TITLE_MAX_TOKENS = 30;
const REASONING_SAFE_MAX_TOKENS = 1024;
const SET_TITLE_TOOL_NAME = "set_title";

// Some models (notably cursor/composer-*) ignore the forced set_title tool call
// and instead emit a long free-text narrative. Without the tool call we fall back
// to the plain text, so cap its length: a real 3-6 word title never exceeds these.
// Beyond the cap we treat the response as a non-title hallucination and reject it.
const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 12;

/**
 * Extract user message text from an array of live session messages.
 * Returns the raw user message strings (not yet formatted).
 */
function extractUserMessageTexts(messages: readonly AgentMessage[]): string[] {
	const userMessages: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
		const trimmed = text.trim();
		if (!trimmed) continue;
		userMessages.push(text);
	}
	return userMessages;
}

/**
 * Extract user message text from persisted sessionManager entries.
 * Returns the raw user message strings (not yet formatted).
 */
function extractUserMessagesFromSessionEntries(entries: readonly object[]): string[] {
	const userMessages: string[] = [];
	for (const entry of entries) {
		const messageEntry = entry as Partial<SessionMessageEntry>;
		if (messageEntry.type !== "message" || !messageEntry.message) continue;
		const message = messageEntry.message as AgentMessage;
		if (message.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block: any) => block.type === "text")
						.map((block: any) => block.text)
						.join("\n");
		const trimmed = text.trim();
		if (!trimmed) continue;
		userMessages.push(text);
	}
	return userMessages;
}

/**
 * Extract summary text from compaction or branch summary messages.
 * Returns the summary text if found, otherwise undefined.
 */
function extractSummaryFromMessages(messages: readonly AgentMessage[]): string | undefined {
	for (const message of messages) {
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			const summaryMsg = message as any;
			if (typeof summaryMsg.summary === "string" && summaryMsg.summary.trim()) {
				return summaryMsg.summary;
			}
		}
	}
	return undefined;
}

/**
 * Format user message texts into a bounded conversation digest.
 * This is the core formatting logic used by both the live-message and fallback paths.
 */
function formatUserMessagesForTitle(
	userMessages: string[],
	obfuscateText?: (text: string) => string,
): string | undefined {
	if (userMessages.length === 0) return undefined;

	// First apply obfuscation to raw messages (before trimming)
	const obfuscatedMessages = obfuscateText ? userMessages.map(msg => obfuscateText(msg)) : userMessages;

	// Then trim
	const trimmedMessages = obfuscatedMessages
		.map(msg => (typeof msg === "string" ? msg.trim() : msg))
		.filter(msg => msg.length > 0);

	if (trimmedMessages.length === 0) return undefined;

	// Keep first and last 5 messages
	const keptMessages =
		trimmedMessages.length > MAX_TITLE_CONVERSATION_MESSAGES
			? [trimmedMessages[0]!, ...trimmedMessages.slice(-(MAX_TITLE_CONVERSATION_MESSAGES - 1))]
			: trimmedMessages;

	// Reserve separator and ellipsis room so the digest is already within the
	// generator's MAX_INPUT_CHARS bound; its existing truncation is a no-op here.
	const maxMessageChars = Math.min(
		MAX_TITLE_MESSAGE_CHARS,
		Math.floor((MAX_INPUT_CHARS - (keptMessages.length - 1) - keptMessages.length) / keptMessages.length),
	);
	return keptMessages
		.map(message => (message.length > maxMessageChars ? `${message.slice(0, maxMessageChars)}…` : message))
		.join("\n");
}

/**
 * Build a bounded conversation digest for title regeneration. Regeneration
 * reads several messages so a throwaway first prompt can be corrected, while
 * the automatic first-message path intentionally uses only its initial input.
 * `obfuscateText`, when set, runs on each kept message's full text before the
 * per-message character cut so a secret cannot be split by that cut.
 */
export function buildConversationTitleInput(
	messages: readonly AgentMessage[],
	obfuscateText?: (text: string) => string,
): string | undefined {
	const userMessages = extractUserMessageTexts(messages);
	return formatUserMessagesForTitle(userMessages, obfuscateText);
}

/**
 * Build a bounded conversation digest with fallback to sessionManager entries and summaries.
 * After compaction, live session messages may only contain compactionSummary placeholders,
 * while the persisted sessionManager entries still have the original user messages.
 * This function tries multiple sources:
 * 1. User messages from live context (if not compacted away)
 * 2. User messages from persisted sessionManager entries
 * 3. Summary text from compaction/branch summary messages
 */
export function buildConversationTitleInputWithFallback(
	messages: readonly AgentMessage[],
	sessionManager: SessionManager | undefined,
	obfuscateText?: (text: string) => string,
): string | undefined {
	// Try live messages first
	const liveUserMessages = extractUserMessageTexts(messages);
	let result = formatUserMessagesForTitle(liveUserMessages, obfuscateText);
	if (result) return result;

	// If live messages are empty (after compaction), try sessionManager entries
	if (sessionManager) {
		const entries = sessionManager.getBranch();
		const persistedUserMessages = extractUserMessagesFromSessionEntries(entries);
		result = formatUserMessagesForTitle(persistedUserMessages, obfuscateText);
		if (result) return result;
	}

	// If still empty, try to extract summary text from compaction/branch summaries
	const summaryText = extractSummaryFromMessages(messages);
	if (summaryText) {
		const summaryLines = obfuscateText ? obfuscateText(summaryText).trim() : summaryText.trim();
		if (summaryLines.length > 0) {
			const maxChars = MAX_INPUT_CHARS;
			return summaryLines.length > maxChars ? `${summaryLines.slice(0, maxChars)}…` : summaryLines;
		}
	}

	return undefined;
}

const setTitleTool: Tool = {
	name: SET_TITLE_TOOL_NAME,
	description: "Set the generated session title.",
	parameters: {
		type: "object",
		properties: {
			title: {
				type: "string",
				description: "A concise 3-6 word title for the session.",
			},
		},
		required: ["title"],
		additionalProperties: false,
	},
};

function getTitleModel(
	registry: ModelRegistry,
	settings: Settings,
	currentModel?: Model<Api>,
	credentialSessionId?: string,
): Model<Api> | undefined {
	const availableModels = registry.getAvailable(credentialSessionId);
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["default"], settings, availableModels, registry)?.model;
	if (titleModel) return titleModel;

	if (currentModel) return currentModel;

	return undefined;
}

/**
 * Obfuscate the full title input, then truncate, then wrap.
 * A secret that crosses the character cap is replaced before the cut, and the
 * `<user-message>` fence stays outside the truncated body.
 */
export function prepareTitleOutboundText(firstMessage: string, obfuscateText?: (text: string) => string): string {
	const source = obfuscateText ? obfuscateText(firstMessage) : firstMessage;
	const truncated = source.length > MAX_INPUT_CHARS ? `${source.slice(0, MAX_INPUT_CHARS)}…` : source;
	return `<user-message>\n${truncated}\n</user-message>`;
}

export async function titleInputObfuscator(
	settings: Settings,
	activeCwd?: string,
): Promise<((text: string) => string) | undefined> {
	const reader = settings as Partial<Pick<Settings, "get" | "getCwd" | "getAgentDir">>;
	if (typeof reader.get !== "function" || reader.get("secrets.enabled") !== true) return undefined;
	const cwd = activeCwd ?? (typeof reader.getCwd === "function" ? reader.getCwd() : process.cwd());
	const agentDir = typeof reader.getAgentDir === "function" ? reader.getAgentDir() : cwd;
	const entries = [...collectEnvSecrets(), ...(await loadSecrets(cwd, agentDir))];
	if (entries.length === 0) return undefined;
	const obfuscator = createSecretObfuscator(entries);
	if (!obfuscator.hasSecrets()) return undefined;
	return text => obfuscator.obfuscate(text);
}

/**
 * Generate a title for a session based on the provided user-message input.
 * Automatic titles pass the first user message; regeneration passes a bounded
 * conversation digest.
 *
 * @param firstMessage The first user message or bounded conversation digest
 * @param registry Model registry
 * @param settings Settings used to resolve the `default` model role
 * @param sessionId Optional session id for sticky API key selection
 * @param currentModel Current model (used to derive title model)
 * @param metadataResolver Optional resolver evaluated after credential selection
 *   to produce request metadata (e.g. user_id for session attribution). Using a
 *   resolver instead of a pre-evaluated value ensures the metadata's account_uuid
 *   reflects the credential actually selected for this request.
 * @param activeCwd Active session cwd for project-scoped secret lookup.
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
	activeCwd?: string,
): Promise<string | null> {
	const model = getTitleModel(registry, settings, currentModel, sessionId);
	if (!model) {
		logger.debug("title-generator: no title model found");
		return null;
	}

	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) {
		logger.debug("title-generator: no API key for title model", {
			provider: model.provider,
			id: model.id,
		});
		return null;
	}
	// Resolve metadata after getApiKey so the session-sticky credential for this
	// request is already recorded; metadataResolver can then return the correct
	// account_uuid rather than the snapshot-at-call-site value.
	const metadata = metadataResolver?.(model.provider);
	const userMessage = prepareTitleOutboundText(firstMessage, await titleInputObfuscator(settings, activeCwd));

	// Title generation is a 3-6 word task, but some reasoning backends ignore
	// disableReasoning. Keep the normal cheap budget for non-reasoning models
	// while reserving enough output room for reasoning models to still emit
	// the forced tool call after any unavoidable thinking tokens.
	const maxTokens = model.reasoning ? Math.max(TITLE_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS) : TITLE_MAX_TOKENS;
	const request = {
		model: `${model.provider}/${model.id}`,
		systemPrompt: TITLE_SYSTEM_PROMPT,
		userMessage,
		maxTokens,
	};
	logger.debug("title-generator: request", {
		model: request.model,
		systemPrompt: request.systemPrompt,
		userMessage: redactCrashSecrets(request.userMessage),
		maxTokens: request.maxTokens,
	});

	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: [request.systemPrompt],
				messages: [{ role: "user", content: request.userMessage, timestamp: Date.now() }],
				tools: [setTitleTool],
			},
			{
				apiKey,
				maxTokens: request.maxTokens,
				disableReasoning: true,
				toolChoice: { type: "tool", name: SET_TITLE_TOOL_NAME },
				metadata,
			},
		);

		if (response.stopReason === "error") {
			logger.debug("title-generator: response error", {
				model: request.model,
				stopReason: response.stopReason,
				errorMessage:
					typeof response.errorMessage === "string"
						? redactCrashSecrets(response.errorMessage)
						: response.errorMessage,
			});
			return null;
		}

		const title = extractGeneratedTitle(response.content);

		logger.debug("title-generator: response", {
			model: request.model,
			title: redactCrashSecrets(title),
			usage: response.usage,
			stopReason: response.stopReason,
		});

		if (!title) {
			return null;
		}

		return title.replace(/^["']|["']$/g, "").replace(/[.!?]$/, "");
	} catch (err) {
		logger.debug("title-generator: error", {
			model: request.model,
			error: redactCrashSecrets(err instanceof Error ? err.message : String(err)),
		});
		return null;
	}
}

function extractGeneratedTitle(contentBlocks: AssistantMessage["content"]): string {
	let textTitle = "";
	for (const content of contentBlocks) {
		if (content.type === "toolCall" && content.name === SET_TITLE_TOOL_NAME) {
			const args = content.arguments as Record<string, unknown>;
			const title = args.title;
			return typeof title === "string" ? title.trim() : "";
		}
		if (content.type === "text") {
			textTitle += content.text;
		}
	}
	// Plain-text fallback (no set_title tool call): only accept it if it actually
	// looks like a title. A model that ignored the tool and rambled produces a long
	// blob — reject it so the caller falls back rather than persisting the narrative.
	const trimmed = textTitle.trim();
	if (trimmed.length > MAX_TITLE_CHARS || trimmed.split(/\s+/).length > MAX_TITLE_WORDS) {
		return "";
	}
	return trimmed;
}

/**
 * Remove control characters so model-generated titles cannot inject terminal escapes.
 */
function sanitizeTerminalTitlePart(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const sanitized = value.replace(TERMINAL_TITLE_CONTROL_CHARS, "").trim();
	return sanitized || undefined;
}

function getFallbackTerminalTitle(cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	const resolvedCwd = path.resolve(cwd);
	const baseName = path.basename(resolvedCwd);
	if (!baseName || baseName === path.parse(resolvedCwd).root) return undefined;
	return sanitizeTerminalTitlePart(baseName);
}

export function formatSessionTerminalTitle(sessionName: string | undefined, cwd?: string): string {
	const label = sanitizeTerminalTitlePart(sessionName) ?? getFallbackTerminalTitle(cwd);
	return label ? `${DEFAULT_TERMINAL_TITLE}: ${label}` : DEFAULT_TERMINAL_TITLE;
}

/**
 * Set the terminal title using OSC 0 (sets both tab and window title). Unsupported terminals ignore it.
 */
export function setTerminalTitle(title: string): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(`\x1b]0;${sanitizeTerminalTitlePart(title) ?? DEFAULT_TERMINAL_TITLE}\x07`);
}

export function setSessionTerminalTitle(sessionName: string | undefined, cwd?: string): void {
	setTerminalTitle(formatSessionTerminalTitle(sessionName, cwd));
	void syncCmuxWorkspaceTitle(sessionName);
	syncHerdrPaneTitle(sessionName);
}

/**
 * Save the current terminal title on terminals that support xterm window ops.
 */
export function pushTerminalTitle(): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write("\x1b[22;2t");
}

/**
 * Restore the previously saved terminal title on terminals that support xterm window ops.
 */
export function popTerminalTitle(): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write("\x1b[23;2t");
}
