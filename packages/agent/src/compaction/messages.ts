import type {
	AssistantMessage,
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
} from "@gajae-code/ai";
import { prompt } from "@gajae-code/utils";
import type { AgentMessage } from "../types";
import branchSummaryContextPrompt from "./prompts/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "./prompts/compaction-summary-context.md" with { type: "text" };

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Legacy hook message type (pre-extensions). Kept for session migration. */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	providerPayload?: ProviderPayload;
	timestamp: number;
}

export type CoreCompactionMessage = CustomMessage | HookMessage | BranchSummaryMessage | CompactionSummaryMessage;

declare module "../types" {
	interface CustomAgentMessages {
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

/**
 * Neutralize control characters, bidirectional text markers, and tag-breaking sequences
 * in a stored summary before placing it in the summary template.
 *
 * Strategy: Rather than using lossy HTML entity encoding that corrupts code (e.g., `<` → `&lt;`),
 * we only escape sequences that could actually break the wrapper or template tags.
 * Control/bidi characters are neutralized to prevent injection/confusion attacks.
 *
 * `prompt.render` does not escape, and the summary can contain tool output,
 * repository text, or fetched pages. Newlines and tabs stay so the summary remains readable.
 */
function escapeSummaryMarkup(value: string): string {
	// First, neutralize control characters and bidirectional markers.
	// These are replaced with a unicode escape to neutralize them without visual impact.
	const result = value.replace(
		/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/g,
		(char, offset) => {
			const code = char.charCodeAt(0);
			const next = value.charCodeAt(offset + 1);
			const prev = value.charCodeAt(offset - 1);
			// Preserve valid surrogate pairs
			if (
				(code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
				(code >= 0xdc00 && code <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff)
			) {
				return char;
			}
			// Preserve newlines and tabs for readability
			if (char === "\n" || char === "\t") return char;
			// Neutralize other control characters
			return `\\u${code.toString(16).padStart(4, "0")}`;
		},
	);

	// Break every opening or closing wrapper tag token, whatever its case, attributes or
	// whitespace, by inserting a zero-width space after `<`. Other markup stays verbatim.
	return result.replace(/<(\/?)(summary|untrusted-content)(?=[\s/>]|$)/gi, "<\u200b$1$2");
}

function renderFencedSummary(template: string, summary: string): string {
	const framed = `<untrusted-content>\n${escapeSummaryMarkup(summary)}\n</untrusted-content>`;
	return prompt.render(template, { summary: framed });
}

export function renderBranchSummaryContext(summary: string): string {
	return renderFencedSummary(BRANCH_SUMMARY_TEMPLATE, summary);
}

export function renderCompactionSummaryContext(summary: string): string {
	return renderFencedSummary(COMPACTION_SUMMARY_TEMPLATE, summary);
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	shortSummary?: string,
	providerPayload?: ProviderPayload,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		providerPayload,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

function isCoreCompactionMessage(message: AgentMessage): message is AgentMessage & CoreCompactionMessage {
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

/**
 * Default compaction-domain transformer.
 *
 * Embedders with their own app messages should pass a richer transformer through
 * `SummaryOptions.convertToLlm`; this default intentionally preserves only the
 * core LLM roles and the compaction messages owned by this package.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((message): Message | undefined => {
			if (isCoreCompactionMessage(message)) {
				switch (message.role) {
					case "custom":
					case "hookMessage": {
						const content =
							typeof message.content === "string"
								? [{ type: "text" as const, text: message.content }]
								: message.content;
						return {
							role: "user",
							content,
							attribution: message.attribution,
							timestamp: message.timestamp,
						};
					}
					case "branchSummary":
						return {
							role: "user",
							content: [
								{
									type: "text" as const,
									text: renderBranchSummaryContext(message.summary),
								},
							],
							attribution: "agent",
							timestamp: message.timestamp,
						};
					case "compactionSummary":
						return {
							role: "user",
							content: [
								{
									type: "text" as const,
									text: renderCompactionSummaryContext(message.summary),
								},
							],
							attribution: "agent",
							providerPayload: message.providerPayload,
							timestamp: message.timestamp,
						};
				}
			}

			switch (message.role) {
				case "user":
					return { ...message, attribution: message.attribution ?? "user" };
				case "developer":
					return { ...message, attribution: message.attribution ?? "agent" };
				case "assistant":
					return message as AssistantMessage;
				case "toolResult":
					return {
						...message,
						content: getPrunedToolResultContent(message as ToolResultMessage),
						attribution: message.attribution ?? "agent",
					};
				default:
					return undefined;
			}
		})
		.filter(message => message !== undefined);
}
export const convertToLlm = defaultConvertToLlm;
