/**
 * Plain-text / markdown session formatting (same shape as /dump clipboard export).
 */
import type { AgentMessage, ThinkingLevel } from "@gajae-code/agent-core";
import { INTENT_FIELD } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import { redactCrashSecrets, redactStructuredSecrets } from "@gajae-code/utils";
import { buildCacheEconomicsWarning, type CacheWarningBuildState } from "./cache-economics";
import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	bashExecutionToText,
	type CompactionSummaryMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
	pythonExecutionToText,
} from "./messages";

/** Minimal tool shape for dump output (matches AgentTool fields used by formatSessionDumpText). */
export interface SessionDumpToolInfo {
	name: string;
	description: string;
	parameters: unknown;
}

export interface FormatSessionDumpTextOptions {
	messages: readonly AgentMessage[];
	systemPrompt?: readonly string[] | null;
	model?: Model | null;
	thinkingLevel?: ThinkingLevel | string | null;
	tools?: readonly SessionDumpToolInfo[];
}

function stripTypeBoxFields(obj: unknown): unknown {
	if (Array.isArray(obj)) {
		return obj.map(stripTypeBoxFields);
	}
	if (obj && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			if (!k.startsWith("TypeBox.")) {
				result[k] = stripTypeBoxFields(v);
			}
		}
		return result;
	}
	return obj;
}

function redactStringValues(value: unknown): unknown {
	if (typeof value === "string") return redactCrashSecrets(value);
	if (Array.isArray(value)) return value.map(redactStringValues);
	if (value === null || typeof value !== "object") return value;
	const redacted = Object.create(null) as Record<string, unknown>;
	for (const [key, nested] of Object.entries(value)) {
		redacted[key] = redactStringValues(nested);
	}
	return redacted;
}

function takeRedactedTextRun(parts: string[]): string | undefined {
	if (parts.length === 0) return undefined;
	const redacted = redactCrashSecrets(parts.join("\n"));
	parts.length = 0;
	return redacted;
}

function escapeXmlAttribute(input: string): string {
	return input.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlText(input: string): string {
	return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeCodePoint(hex: string): string {
	const codePoint = Number.parseInt(hex, 16);
	if (
		!Number.isFinite(codePoint) ||
		codePoint < 0x20 ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		(codePoint >= 0xd800 && codePoint <= 0xdfff)
	) {
		return `\\u${hex}`;
	}
	return String.fromCharCode(codePoint);
}

function decodeUnicodeEscapeText(input: string): string {
	return input
		.replace(/\\\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => decodeCodePoint(hex))
		.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => decodeCodePoint(hex));
}

function formatParameterValue(value: unknown): string {
	const raw = typeof value === "string" ? value : (JSON.stringify(value, null, "\t") ?? "null");
	return escapeXmlText(decodeUnicodeEscapeText(raw));
}

/** Serialize an object as XML parameter elements, one per key. */
function formatArgsAsXml(args: Record<string, unknown>, indent = "\t", redactCredentialKeys = true): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key === INTENT_FIELD) continue;
		const escapedKey = escapeXmlAttribute(redactCrashSecrets(key));
		const safeValue = redactCredentialKeys ? redactStructuredSecrets(value, key) : redactStringValues(value);
		const text = redactCrashSecrets(formatParameterValue(safeValue));
		if (text.includes("\n")) {
			const indentedText = text
				.split("\n")
				.map(line => `${indent}\t${line}`)
				.join("\n");
			parts.push(`${indent}<parameter name="${escapedKey}">\n${indentedText}\n${indent}</parameter>`);
		} else {
			parts.push(`${indent}<parameter name="${escapedKey}">${text}</parameter>`);
		}
	}
	return redactCrashSecrets(parts.join("\n"));
}

/**
 * Format messages and session metadata as markdown/plain text (same shape as /dump clipboard export).
 * Text runs, tool-argument sections, and each rendered Bash or Python execution
 * section are scrubbed inside that section so a private-key banner cannot pair
 * across unrelated messages.
 */
export function formatSessionDumpText(options: FormatSessionDumpTextOptions): string {
	const lines: string[] = [];

	const systemPrompt = options.systemPrompt?.filter(prompt => prompt.length > 0) ?? [];
	if (systemPrompt.length > 0) {
		lines.push("## System Prompt\n");
		for (let index = 0; index < systemPrompt.length; index++) {
			if (systemPrompt.length > 1) {
				lines.push(`### System Prompt ${index + 1}\n`);
			}
			lines.push(redactCrashSecrets(systemPrompt[index]));
			lines.push("\n");
		}
	}

	const model = options.model;
	const thinkingLevel = options.thinkingLevel;
	lines.push("## Configuration\n");
	lines.push(
		`Model: ${model ? `${redactCrashSecrets(model.provider)}/${redactCrashSecrets(model.id)}` : "(not selected)"}`,
	);
	lines.push(`Thinking Level: ${redactCrashSecrets(String(thinkingLevel ?? ""))}`);
	lines.push("\n");

	const tools = options.tools ?? [];
	if (tools.length > 0) {
		lines.push("## Available Tools\n");
		for (const tool of tools) {
			lines.push(`<tool name="${redactCrashSecrets(tool.name)}">`);
			lines.push(redactCrashSecrets(tool.description));
			const parametersClean = stripTypeBoxFields(tool.parameters);
			lines.push(`\nParameters:\n${formatArgsAsXml(parametersClean as Record<string, unknown>, "\t", false)}`);
			lines.push("<" + "/tool>\n");
		}
		lines.push("\n");
	}

	const cacheWarningState: CacheWarningBuildState = { warningsEmitted: 0 };
	for (const msg of options.messages) {
		if (msg.role === "user" || msg.role === "developer") {
			lines.push(msg.role === "developer" ? "## Developer\n" : "## User\n");
			if (typeof msg.content === "string") {
				lines.push(redactCrashSecrets(msg.content));
			} else {
				const textRun: string[] = [];
				for (const c of msg.content) {
					if (c.type === "text") {
						textRun.push(c.text);
					} else if (c.type === "image") {
						const redactedText = takeRedactedTextRun(textRun);
						if (redactedText !== undefined) lines.push(redactedText);
						lines.push("[Image]");
					}
				}
				const redactedText = takeRedactedTextRun(textRun);
				if (redactedText !== undefined) lines.push(redactedText);
			}
			lines.push("\n");
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			lines.push("## Assistant\n");

			const textRun: string[] = [];
			for (const c of assistantMsg.content) {
				if (c.type === "text") {
					textRun.push(c.text);
				} else if (c.type === "thinking") {
					if (c.thinking.trim().length === 0) continue;
					const redactedText = takeRedactedTextRun(textRun);
					if (redactedText !== undefined) lines.push(redactedText);
					lines.push("<thinking>");
					lines.push(redactCrashSecrets(c.thinking));
					lines.push("</thinking>\n");
				} else if (c.type === "toolCall") {
					const redactedText = takeRedactedTextRun(textRun);
					if (redactedText !== undefined) lines.push(redactedText);
					lines.push(`<invoke name="${redactCrashSecrets(c.name)}">`);
					if (c.arguments && typeof c.arguments === "object") {
						lines.push(formatArgsAsXml(c.arguments as Record<string, unknown>));
					}
					lines.push("<" + "/invoke>\n");
				}
			}
			const redactedText = takeRedactedTextRun(textRun);
			if (redactedText !== undefined) lines.push(redactedText);
			const cacheWarning = buildCacheEconomicsWarning(assistantMsg.usage, model, cacheWarningState);
			if (cacheWarning) {
				lines.push(redactCrashSecrets(cacheWarning));
			}
			lines.push("");
		} else if (msg.role === "toolResult") {
			lines.push(`### Tool Result: ${redactCrashSecrets(msg.toolName)}`);
			if (msg.isError) {
				lines.push("(error)");
			}
			const textRun: string[] = [];
			for (const c of msg.content) {
				if (c.type === "text") {
					textRun.push(c.text);
				} else if (c.type === "image") {
					const redactedText = takeRedactedTextRun(textRun);
					if (redactedText !== undefined) lines.push("```", redactedText, "```");
					lines.push("[Image output]");
				}
			}
			const redactedText = takeRedactedTextRun(textRun);
			if (redactedText !== undefined) lines.push("```", redactedText, "```");
			lines.push("");
		} else if (msg.role === "bashExecution") {
			const bashMsg = msg as BashExecutionMessage;
			if (!bashMsg.excludeFromContext) {
				lines.push("## Bash Execution\n");
				const rendered = bashExecutionToText(redactStructuredSecrets(bashMsg) as BashExecutionMessage);
				lines.push(redactCrashSecrets(rendered));
				lines.push("\n");
			}
		} else if (msg.role === "pythonExecution") {
			const pythonMsg = msg as PythonExecutionMessage;
			if (!pythonMsg.excludeFromContext) {
				lines.push("## Python Execution\n");
				const rendered = pythonExecutionToText(redactStructuredSecrets(pythonMsg) as PythonExecutionMessage);
				lines.push(redactCrashSecrets(rendered));
				lines.push("\n");
			}
		} else if (msg.role === "custom" || msg.role === "hookMessage") {
			const customMsg = msg as CustomMessage | HookMessage;
			lines.push(`## ${redactCrashSecrets(customMsg.customType)}\n`);
			if (typeof customMsg.content === "string") {
				lines.push(redactCrashSecrets(customMsg.content));
			} else {
				const textRun: string[] = [];
				for (const c of customMsg.content) {
					if (c.type === "text") {
						textRun.push(c.text);
					} else if (c.type === "image") {
						const redactedText = takeRedactedTextRun(textRun);
						if (redactedText !== undefined) lines.push(redactedText);
						lines.push("[Image]");
					}
				}
				const redactedText = takeRedactedTextRun(textRun);
				if (redactedText !== undefined) lines.push(redactedText);
			}
			lines.push("\n");
		} else if (msg.role === "branchSummary") {
			const branchMsg = msg as BranchSummaryMessage;
			lines.push("## Branch Summary\n");
			lines.push(`(from branch: ${redactCrashSecrets(branchMsg.fromId)})\n`);
			lines.push(redactCrashSecrets(branchMsg.summary));
			lines.push("\n");
		} else if (msg.role === "compactionSummary") {
			const compactMsg = msg as CompactionSummaryMessage;
			lines.push("## Compaction Summary\n");
			lines.push(`(${compactMsg.tokensBefore} tokens before compaction)\n`);
			lines.push(redactCrashSecrets(compactMsg.summary));
			lines.push("\n");
		} else if (msg.role === "fileMention") {
			const fileMsg = msg as FileMentionMessage;
			lines.push("## File Mention\n");
			for (const file of fileMsg.files) {
				lines.push(`<file path="${redactCrashSecrets(file.path)}">`);
				if (file.content) {
					lines.push(redactCrashSecrets(file.content));
				}
				if (file.image) {
					lines.push("[Image attached]");
				}
				lines.push("</file>\n");
			}
			lines.push("\n");
		}
	}

	return lines.join("\n").trim();
}
