/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */
import type { AgentMessage } from "@gajae-code/agent-core";
import {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	renderBranchSummaryContext,
	renderCompactionSummaryContext,
} from "@gajae-code/agent-core/compaction/messages";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	MessageAttribution,
	TextContent,
	ToolResultMessage,
} from "@gajae-code/ai/core";

export {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
} from "@gajae-code/agent-core/compaction/messages";

import type { LoadedSubskillActivation } from "../extensibility/gjc-plugins";
import type { OutputMeta } from "../tools/output-meta";
import { formatOutputNotice } from "../tools/output-meta";

/**
 * Encode untrusted values embedded in prompt markup. Control and bidi characters become visible
 * escape sequences so they cannot alter markup structure or display. Isolated UTF-16 surrogates
 * are also escaped; valid Unicode pairs remain intact.
 */
export function escapePromptMetadata(value: string, options: { preserveNewlines?: boolean } = {}): string {
	return value.replace(
		/[&<>"\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/g,
		(char, offset) => {
			const code = char.charCodeAt(0);
			if (
				(code >= 0xd800 &&
					code <= 0xdbff &&
					value.charCodeAt(offset + 1) >= 0xdc00 &&
					value.charCodeAt(offset + 1) <= 0xdfff) ||
				(code >= 0xdc00 &&
					code <= 0xdfff &&
					value.charCodeAt(offset - 1) >= 0xd800 &&
					value.charCodeAt(offset - 1) <= 0xdbff)
			) {
				return char;
			}
			if (options.preserveNewlines && (char === "\n" || char === "\t")) return char;
			switch (char) {
				case "&":
					return "&amp;";
				case "<":
					return "&lt;";
				case ">":
					return "&gt;";
				case '"':
					return "&quot;";
				default:
					return `\\u${code.toString(16).padStart(4, "0")}`;
			}
		},
	);
}
export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
	subskillActivation?: LoadedSubskillActivation;
	subskillActivationSet?: LoadedSubskillActivation[];
	/** Internal: tag used by AgentSession to remove the pending-display chip
	 *  from `#steeringMessages` / `#followUpMessages` when the agent consumes
	 *  this message. Not surfaced to renderers; the `__` prefix signals
	 *  "private". Optional — non-streaming skill prompts never set it. Stripped
	 *  from persisted `details` by `SessionManager.appendCustomMessageEntry`
	 *  via the `INTERNAL_DETAILS_FIELDS` allowlist below. */
	__pendingDisplayTag?: string;
}

/** Sentinel value for `AssistantMessage.errorMessage` indicating that the abort
 *  was an *expected internal transition* (plan-mode → execution compaction)
 *  and must NOT surface as a red "Operation aborted" line. Distinct from
 *  `undefined` (default) so user-cancel aborts with no errorMessage still
 *  render normally. Persists through SessionManager so history replay
 *  branches identically.
 *
 *  Consumers: `AgentSession.#handleAgentEvent` (stamper) writes this value;
 *  `EventController.#handleMessageEnd`, `AssistantMessageComponent`,
 *  `ui-helpers.addMessageToChat` (renderers), `SessionObserverOverlay
 *  #buildTranscriptLines`, `runPrintMode`, and `AcpAgent#replayAssistantMessage`
 *  (fallback error emission) read it via `isSilentAbort`. */
export const SILENT_ABORT_MARKER = "__gjc.silent_abort__";

/** Type-guard for `SILENT_ABORT_MARKER`. Renderers MUST branch on this rather
 *  than string-comparing inline so refactors to the marker constant (e.g.,
 *  namespacing changes) propagate through every consumer in lockstep. */
export function isSilentAbort(errorMessage: string | undefined): boolean {
	return errorMessage === SILENT_ABORT_MARKER;
}

/** Extract the optional `__pendingDisplayTag` field from a CustomMessage's
 *  `details` blob. Safe over `unknown`; returns undefined when the field is
 *  absent or non-string. */
export function readPendingDisplayTag(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { __pendingDisplayTag?: unknown }).__pendingDisplayTag;
	return typeof candidate === "string" ? candidate : undefined;
}

/** Explicit allowlist of `details` field names that are AgentSession-internal
 *  transient bookkeeping and MUST be removed before SessionManager persists
 *  the CustomMessageEntry to disk. Scoped intentionally narrow: only fields
 *  declared here are stripped. Adding a new entry is a deliberate, reviewed
 *  change — unrelated future payload fields are never silently dropped. */
export const INTERNAL_DETAILS_FIELDS = ["__pendingDisplayTag", "ownedCompletions"] as const;

/** Return a `details` copy with every key in `INTERNAL_DETAILS_FIELDS`
 *  removed. Returns the input unchanged when there is nothing to strip
 *  (null/non-object, or no listed fields present) so callers don't pay a
 *  clone cost on the common path. */
export function stripInternalDetailsFields<T>(details: T | undefined): T | undefined {
	if (details == null || typeof details !== "object") return details;
	const obj = details as Record<string, unknown>;
	let hit = false;
	for (const key of INTERNAL_DETAILS_FIELDS) {
		if (key in obj) {
			hit = true;
			break;
		}
	}
	if (!hit) return details;
	const cleaned: Record<string, unknown> = { ...obj };
	for (const key of INTERNAL_DETAILS_FIELDS) {
		delete cleaned[key];
	}
	return cleaned as T;
}

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

export const PRE_ADMISSION_ARTIFACT_SPILL_HEAD_BYTES = 4096;
export const PRE_ADMISSION_ARTIFACT_SPILL_TAIL_BYTES = 4096;

/**
 * Keep an authenticated `#GJC1_` placeholder whole when the byte cut lands
 * inside it. Short inputs whose head and tail already overlap stay on the
 * original byte limits.
 */
function retainStraddlingPlaceholders(text: string, head: string, tail: string): { head: string; tail: string } {
	const headEnd = head.length;
	const tailStart = text.length - tail.length;
	if (headEnd > tailStart) return { head, tail };

	let nextHeadEnd = headEnd;
	let nextTailStart = tailStart;
	const placeholder = /#GJC1_[A-Za-z0-9_-]{22}#/g;
	for (;;) {
		const match = placeholder.exec(text);
		if (match === null) break;
		const start = match.index;
		const stop = start + match[0].length;
		if (start < headEnd && stop > headEnd) nextHeadEnd = Math.max(nextHeadEnd, stop);
		if (start < tailStart && stop > tailStart) nextTailStart = Math.min(nextTailStart, start);
	}
	if (nextHeadEnd > nextTailStart) return { head, tail };
	return {
		head: nextHeadEnd === headEnd ? head : text.slice(0, nextHeadEnd),
		tail: nextTailStart === tailStart ? tail : text.slice(nextTailStart),
	};
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
	let bytes = 0;
	let end = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character, "utf-8");
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		end += character.length;
	}
	return text.slice(0, end);
}

function utf8Suffix(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
	let bytes = 0;
	let retainedStart = text.length;
	for (let index = text.length; index > 0; ) {
		let characterStart = --index;
		const codeUnit = text.charCodeAt(characterStart);
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && characterStart > 0) characterStart--;
		const character = text.slice(characterStart, index + 1);
		const characterBytes = Buffer.byteLength(character, "utf-8");
		if (bytes + characterBytes > maxBytes) break;
		bytes += characterBytes;
		retainedStart = characterStart;
		index = characterStart;
	}
	return text.slice(retainedStart);
}

/**
 * Build the deterministic inline receipt for a tool result saved before the
 * next provider context is constructed. Byte boundaries never split UTF-8
 * code points, so head/tail recovery remains readable for emoji and CJK text.
 *
 * `redact` runs on the complete text before the cut. The digest stays the
 * caller's hash of the stored artifact; the omitted count is the redacted
 * preview's omitted bytes.
 */
export function createPreAdmissionArtifactSpillPreview(
	fullText: string,
	artifactId: string,
	digest: string,
	redact?: (text: string) => string,
): string {
	const source = redact ? redact(fullText) : fullText;
	const totalBytes = Buffer.byteLength(source, "utf-8");
	const head = utf8Prefix(source, PRE_ADMISSION_ARTIFACT_SPILL_HEAD_BYTES);
	const tail = utf8Suffix(source, PRE_ADMISSION_ARTIFACT_SPILL_TAIL_BYTES);
	// Without redaction the cut stays on the historical byte limits, including
	// when the tool text itself contains a placeholder-shaped string.
	const retained = redact ? retainStraddlingPlaceholders(source, head, tail) : { head, tail };
	const retainedBytes = Buffer.byteLength(retained.head, "utf-8") + Buffer.byteLength(retained.tail, "utf-8");
	const omittedBytes = Math.max(0, totalBytes - retainedBytes);
	const receipt = `[${omittedBytes} bytes omitted; sha256:${digest}; full output: artifact://${artifactId}]`;
	return `${retained.head}\n\n${receipt}\n\n${retained.tail}`;
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	signal?: string;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for user-initiated Python executions via the $ command.
 * Shares the same kernel session as eval's Python backend.
 */
export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context ($$ prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 */
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

/**
 * Legacy hook message type (pre-extensions). Kept for session migration.
 */
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

/**
 * Message type for auto-read file mentions via @filepath syntax.
 */
export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		lineCount?: number;
		/** File size in bytes, if known. */
		byteSize?: number;
		/** Why the file contents were omitted from auto-read. */
		skippedReason?: "tooLarge";
		image?: ImageContent;
		/** Set when this mention duplicated a recently shown path (compact note, no full body). */
		duplicate?: boolean;
		/** Set when a stale entry was pruned to a digest notice (never silently deleted). */
		pruned?: boolean;
	}>;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
// Legacy hookMessage is kept for migration; new code should use custom.
declare module "@gajae-code/agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		pythonExecution: PythonExecutionMessage;
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		fileMention: FileMentionMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.signal) {
		text += `\n\nCommand terminated by ${msg.signal}${
			msg.exitCode !== null && msg.exitCode !== undefined ? ` (exit code ${msg.exitCode})` : ""
		}`;
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

/**
 * Convert a PythonExecutionMessage to user message text for LLM context.
 */
export function pythonExecutionToText(msg: PythonExecutionMessage): string {
	let text = `Ran Python:\n\`\`\`python\n${msg.code}\n\`\`\`\n`;
	if (msg.output) {
		text += `Output:\n\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(execution cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nExecution failed with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function sanitizeRehydratedOpenAIResponsesAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.providerPayload?.type !== "openaiResponsesHistory") {
		return message;
	}

	let didSanitizeContent = false;
	const sanitizedContent = message.content.map(block => {
		if (block.type !== "thinking" || block.thinkingSignature === undefined) {
			return block;
		}

		didSanitizeContent = true;
		return { ...block, thinkingSignature: undefined };
	});

	// Strip the assistant-side native replay payload entirely.
	// After rehydration it belongs to a previous live provider connection and
	// replaying it on a warmed session causes 401 rejections from GitHub Copilot.
	// User/developer payloads are preserved separately by the caller.
	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
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

/**
 * Same closer escape as URL and tool framing: whitespace between the tag name
 * and ">" still closes the element, so those spellings are neutralized too.
 */
export function escapeUntrustedContent(content: string): string {
	return content
		.replace(/<\/untrusted-content>/gi, "&lt;/untrusted-content>")
		.replace(/<\/untrusted-content[ \t\n\r\f]+>/gi, "&lt;/untrusted-content>");
}

export function wrapUntrustedContent(content: string): string {
	return `<untrusted-content>\n${escapeUntrustedContent(content)}\n</untrusted-content>`;
}

/**
 * Break reserved prompt tags in workspace rule text so a rule file cannot close
 * `<system-interrupt>` or `<system-reminder>`. Ordinary markup such as `<Button>`
 * stays intact.
 */
export function neutralizeReservedPromptTag(value: string): string {
	return value.replace(
		/<\/?\s*(?:system-interrupt|system-reminder|untrusted-content|rules)(?=[\s>/]|$)/gi,
		tag => `&lt;${tag.slice(1)}`,
	);
}

/** Attribute-encode a TTSR name or path, and neutralize reserved tags in the body. */
export function ttsrPromptFields(rule: { name: string; path: string; content: string }): {
	name: string;
	path: string;
	content: string;
} {
	return {
		name: escapePromptMetadata(rule.name),
		path: escapePromptMetadata(rule.path),
		content: neutralizeReservedPromptTag(rule.content),
	};
}

/**
 * Frame stored `!` / `$` text at the model boundary. The command runner already
 * cut the excerpt that was recorded; do not slice this string again.
 */
function frameStoredLocalExecution(text: string): string {
	return wrapUntrustedContent(text);
}

/**
 * Frame debug tool text at the model boundary. Output capture and pre-admission
 * spill already cut the excerpt; do not slice this string again.
 */
function frameDebugToolResult(message: ToolResultMessage): (TextContent | ImageContent)[] {
	const content = getPrunedToolResultContent(message);
	if (message.toolName !== "debug") return content;
	return content.map(block => (block.type === "text" ? { ...block, text: wrapUntrustedContent(block.text) } : block));
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: frameStoredLocalExecution(bashExecutionToText(m)) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "pythonExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: frameStoredLocalExecution(pythonExecutionToText(m)) }],
						attribution: "user",
						timestamp: m.timestamp,
					};
				case "custom":
				case "hookMessage": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					const role = "user";
					const attribution = m.attribution;
					return {
						role,
						content,
						attribution,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [
							{
								type: "text" as const,
								text: renderBranchSummaryContext(m.summary),
							},
						],
						attribution: "agent",
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{
								type: "text" as const,
								text: renderCompactionSummaryContext(m.summary),
							},
						],
						attribution: "agent",
						providerPayload: m.providerPayload,
						timestamp: m.timestamp,
					};
				case "fileMention": {
					const fileContents = m.files
						.map(file => {
							const inner = file.content
								? `\n${escapePromptMetadata(file.content, { preserveNewlines: true })}\n`
								: "\n";
							return `<file path="${escapePromptMetadata(file.path)}">${inner}</file>`;
						})
						.join("\n\n");
					const content: (TextContent | ImageContent)[] = [
						{ type: "text" as const, text: `<system-reminder>\n${fileContents}\n</system-reminder>` },
					];
					for (const file of m.files) {
						if (file.image) {
							content.push(file.image);
						}
					}
					return {
						role: "user",
						content,
						attribution: "user",
						timestamp: m.timestamp,
					};
				}
				case "user":
					return { ...m, attribution: m.attribution ?? "user" };
				case "developer":
					return { ...m, attribution: m.attribution ?? "agent" };
				case "assistant":
					return m;
				case "toolResult":
					return {
						...m,
						content: frameDebugToolResult(m as ToolResultMessage),
						attribution: m.attribution ?? "agent",
					};
				default:
					m satisfies never;
					return undefined;
			}
		})
		.filter(m => m !== undefined);
}
