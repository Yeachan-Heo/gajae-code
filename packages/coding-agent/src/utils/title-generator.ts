/**
 * Generate session titles using a smol, fast model.
 */
import * as path from "node:path";

import { type Api, type AssistantMessage, completeSimple, type Model, type Tool } from "@gajae-code/ai";
import { logger, prompt } from "@gajae-code/utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };

const TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);

const DEFAULT_TERMINAL_TITLE = "GJC";
const TERMINAL_TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const MAX_INPUT_CHARS = 2000;
const TITLE_MAX_TOKENS = 30;
const REASONING_SAFE_MAX_TOKENS = 1024;
const SET_TITLE_TOOL_NAME = "set_title";

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

function getTitleModel(registry: ModelRegistry, settings: Settings, currentModel?: Model<Api>): Model<Api> | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;

	const titleModel = resolveRoleSelection(["default"], settings, availableModels, registry)?.model;
	if (titleModel) return titleModel;

	if (currentModel) return currentModel;

	return undefined;
}

/**
 * Generate a title for a session based on the first user message.
 *
 * @param firstMessage The first user message
 * @param registry Model registry
 * @param settings Settings used to resolve the smol role
 * @param sessionId Optional session id for sticky API key selection
 * @param currentModel Current model (used to derive title model)
 * @param metadataResolver Optional resolver evaluated after credential selection
 *   to produce request metadata (e.g. user_id for session attribution). Using a
 *   resolver instead of a pre-evaluated value ensures the metadata's account_uuid
 *   reflects the credential actually selected for this request.
 */
export async function generateSessionTitle(
	firstMessage: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	currentModel?: Model<Api>,
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined,
): Promise<string | null> {
	const model = getTitleModel(registry, settings, currentModel);
	if (!model) {
		logger.debug("title-generator: no title model found");
		return null;
	}

	// Truncate message if too long
	const truncatedMessage =
		firstMessage.length > MAX_INPUT_CHARS ? `${firstMessage.slice(0, MAX_INPUT_CHARS)}…` : firstMessage;
	const userMessage = `<user-message>
${truncatedMessage}
</user-message>`;

	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) {
		logger.debug("title-generator: no API key for smol model", {
			provider: model.provider,
			id: model.id,
		});
		return null;
	}
	// Resolve metadata after getApiKey so the session-sticky credential for this
	// request is already recorded; metadataResolver can then return the correct
	// account_uuid rather than the snapshot-at-call-site value.
	const metadata = metadataResolver?.(model.provider);

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
	logger.debug("title-generator: request", request);

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
				errorMessage: response.errorMessage,
			});
			return null;
		}

		const title = extractGeneratedTitle(response.content);

		logger.debug("title-generator: response", {
			model: request.model,
			title,
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
			error: err instanceof Error ? err.message : String(err),
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
	return textTitle.trim();
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
