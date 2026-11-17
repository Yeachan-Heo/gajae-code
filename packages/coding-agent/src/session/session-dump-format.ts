/**
 * Plain-text / markdown session formatting (same shape as /dump clipboard export).
 */
import type { AgentMessage, ThinkingLevel } from "@gajae-code/agent-core";
import { INTENT_FIELD } from "@gajae-code/agent-core";
import type { AssistantMessage, Model } from "@gajae-code/ai/core";
import {
	findPrivateKeySpans,
	isCredentialKey,
	isHeaderCollectionKey,
	PRIVATE_KEY_REDACTION_MARKER,
	type PrivateKeySpan,
	redactCrashSecrets,
	redactStructuredSecrets,
} from "@gajae-code/utils";
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

/** Redact the private-key blocks that a caller located in a wider source string. */
function redactPrivateKeyRanges(text: string, spans: readonly PrivateKeySpan[]): string {
	if (spans.length === 0) return text;
	const parts: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		parts.push(text.slice(cursor, span.start), PRIVATE_KEY_REDACTION_MARKER);
		cursor = span.end;
	}
	parts.push(text.slice(cursor));
	return parts.join("");
}

/**
 * Locate private-key blocks that span sibling argument values.
 * Leaves are joined in serialization order without a separator so a banner split
 * mid-token is still paired, and each block is mapped back to ranges of the
 * original leaves. Detection happens before any field-level credential masking
 * can remove one of the two banners.
 */
function crossFieldPrivateKeySpans(values: readonly string[]): PrivateKeySpan[][] {
	const spansByValue: PrivateKeySpan[][] = values.map(() => []);
	// Only the leaves between the first and the last banner can take part, so a lone banner
	// in one place cannot pull unrelated structure into a span.
	let first = -1;
	let last = -1;
	for (let index = 0; index < values.length; index++) {
		if (!values[index].includes(PEM_MARKER_HINT)) continue;
		if (first < 0) first = index;
		last = index;
	}
	if (first < 0 || last === first) return spansByValue;
	const offsets: number[] = [];
	let joined = "";
	for (let index = first; index <= last; index++) {
		offsets.push(joined.length);
		joined += values[index];
	}
	// Spans and leaves are both ordered, so the walk advances one leaf pointer instead of
	// visiting every leaf for every span.
	let leaf = 0;
	for (const span of findPrivateKeySpans(joined)) {
		while (leaf < offsets.length && offsets[leaf] + values[first + leaf].length <= span.start) leaf++;
		for (let index = leaf; index < offsets.length; index++) {
			const valueStart = offsets[index];
			if (valueStart >= span.end) break;
			const valueEnd = valueStart + values[first + index].length;
			const start = Math.max(span.start, valueStart) - valueStart;
			const end = Math.min(span.end, valueEnd) - valueStart;
			if (end > start) spansByValue[first + index].push({ start, end });
		}
	}
	return spansByValue;
}

/** Collect every string leaf of a value tree in serialization order. */
function collectStringLeaves(value: unknown, out: string[]): void {
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStringLeaves(item, out);
		return;
	}
	if (value === null || typeof value !== "object") return;
	// Field names take part too: a banner split between a value and a name is still a block.
	for (const [key, nested] of Object.entries(value)) {
		out.push(key);
		collectStringLeaves(nested, out);
	}
}

/** Part of both private-key banners; used to pick the leaves that can take part in a span. */
const PEM_MARKER_HINT = "PRIVATE KEY-----";

/** Apply the spans found for each leaf, in the order `collectStringLeaves` produced them. */
function applyPrivateKeySpans(value: unknown, spans: readonly PrivateKeySpan[][], cursor: { index: number }): unknown {
	if (typeof value === "string") return redactPrivateKeyRanges(value, spans[cursor.index++] ?? []);
	if (Array.isArray(value)) return value.map(item => applyPrivateKeySpans(item, spans, cursor));
	if (value === null || typeof value !== "object") return value;
	const redacted = Object.create(null) as Record<string, unknown>;
	for (const [key, nested] of Object.entries(value)) {
		// Names locate a block but are never rewritten by it: a scrubbed name would destroy the
		// argument identity the dump relies on, and a banner on its own is not secret material.
		cursor.index++;
		redacted[key] = applyPrivateKeySpans(nested, spans, cursor);
	}
	return redacted;
}

/** Decode `\u` escapes in every string leaf, so banner detection sees the text a reader sees. */
function decodeValueStrings(value: unknown): unknown {
	if (typeof value === "string") return decodeUnicodeEscapeText(value);
	if (Array.isArray(value)) return value.map(decodeValueStrings);
	if (value === null || typeof value !== "object") return value;
	const decoded = Object.create(null) as Record<string, unknown>;
	for (const [key, nested] of Object.entries(value)) {
		decoded[key] = decodeValueStrings(nested);
	}
	return decoded;
}

/** Redact private-key blocks that span sibling argument values, at any nesting depth. */
function redactCrossFieldPrivateKeys(values: readonly unknown[]): unknown[] {
	const decoded = values.map(decodeValueStrings);
	const leaves: string[] = [];
	for (const value of decoded) collectStringLeaves(value, leaves);
	const spansByLeaf = crossFieldPrivateKeySpans(leaves);
	const cursor = { index: 0 };
	return decoded.map(value => applyPrivateKeySpans(value, spansByLeaf, cursor));
}

function serializeParameterValue(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value, null, "\t") ?? "null");
}

/** Text of one tool-argument value: scrubbed, decoded, then escaped for XML. */
function formatArgumentText(value: unknown, key: string): string {
	const structured = redactStructuredSecrets(value, key, { headerPairs: isHeaderCollectionKey });
	return escapeXmlText(redactCrashSecrets(decodeUnicodeEscapeText(serializeParameterValue(structured))));
}

/** Keywords whose value is one concrete literal, so a credential-named property's own data can be masked. */
const SCHEMA_VALUE_KEYWORDS = new Set(["default", "example", "examples", "const"]);

/**
 * Scrub a data value inside a schema (a `default`, `example`, or `const`).
 * The value is data, not schema structure, so it is decoded first and then scrubbed with
 * the same rules as tool arguments: credential-named fields are masked, text is scrubbed,
 * and a known header collection keeps its value redaction.
 */
function scrubSchemaData(value: unknown, propertyName?: string): unknown {
	return redactStructuredSecrets(decodeValueStrings(value), propertyName, { headerPairs: isHeaderCollectionKey });
}

/**
 * Pair a private-key block that spans the data of sibling property definitions.
 * Only data keywords take part, so a neighbour's type and description stay intact
 * while an opener in one definition's `default` and a footer in another's are paired.
 */

/** Replace every leaf of a data value with the marker, preserving its shape. */
function maskSchemaData(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(maskSchemaData);
	if (value === null || typeof value !== "object") return "«redacted»";
	const masked = Object.create(null) as Record<string, unknown>;
	for (const [key, nested] of Object.entries(value)) {
		masked[redactCrashSecrets(key)] = maskSchemaData(nested);
	}
	return masked;
}

/**
 * Scrubbed form of a schema key, kept distinct when two keys scrub to the same marker
 * so one property definition cannot silently replace another.
 */
function uniqueScrubbedKey(target: Record<string, unknown>, key: string, nextSuffix: Map<string, number>): string {
	const scrubbed = redactCrashSecrets(key);
	if (!Object.hasOwn(target, scrubbed)) return scrubbed;
	let suffix = nextSuffix.get(scrubbed) ?? 2;
	while (Object.hasOwn(target, `${scrubbed}#${suffix}`)) suffix += 1;
	nextSuffix.set(scrubbed, suffix + 1);
	return `${scrubbed}#${suffix}`;
}

/**
 * Scrub a tool schema without destroying its definitions.
 * Property names are schema structure, not credential assignments, so they stay
 * readable; only string leaves and data-carrying keywords are redacted. The whole
 * schema is sanitized at once so a property map nested under `properties` keeps its
 * property names as context.
 */
function redactSchemaValue(value: unknown, propertyName?: string): unknown {
	if (typeof value === "string") return redactCrashSecrets(decodeUnicodeEscapeText(value));
	if (Array.isArray(value)) return value.map(item => redactSchemaValue(item, propertyName));
	if (value === null || typeof value !== "object") return value;

	const source = value as Record<string, unknown>;
	const redacted = Object.create(null) as Record<string, unknown>;
	const scrubbedKeys = new Map<string, number>();
	// A schema renders as one section, so a banner split between any two of its values —
	// including a description and a nested definition — is paired across the whole object
	// before credential-named fields are masked.
	const pairedSource = redactCrossFieldPrivateKeys([source])[0] as Record<string, unknown>;
	const dataFields = Object.keys(source).filter(field => SCHEMA_VALUE_KEYWORDS.has(field));
	for (const [field, nested] of Object.entries(pairedSource)) {
		const dataIndex = dataFields.indexOf(field);
		if (field === "properties" && nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
			const properties = Object.create(null) as Record<string, unknown>;
			const propertyKeys = new Map<string, number>();
			for (const [name, schema] of Object.entries(nested as Record<string, unknown>)) {
				properties[uniqueScrubbedKey(properties, name, propertyKeys)] = redactSchemaValue(schema, name);
			}
			redacted[uniqueScrubbedKey(redacted, field, scrubbedKeys)] = properties;
			continue;
		}
		if (dataIndex >= 0) {
			const paired = nested;
			redacted[uniqueScrubbedKey(redacted, field, scrubbedKeys)] =
				propertyName !== undefined && isCredentialKey(propertyName)
					? maskSchemaData(paired)
					: scrubSchemaData(paired, propertyName);
			continue;
		}
		redacted[uniqueScrubbedKey(redacted, field, scrubbedKeys)] = redactSchemaValue(nested, propertyName);
	}
	return redacted;
}

/** Text of one already-sanitized schema value: escaped for XML. */
function formatSchemaText(value: unknown): string {
	return escapeXmlText(serializeParameterValue(value));
}

/**
 * Serialize an object as XML parameter elements, one per key.
 * The generated `<parameter>` markup is never passed through the text scrubber:
 * a value ending in `KEY=<placeholder>` must not consume the closing tag, and a
 * private-key block spanning two values is redacted inside those values so each
 * parameter keeps its own identity.
 */
function formatArgsAsXml(
	args: Record<string, unknown>,
	mode: "arguments" | "schema" = "arguments",
	indent = "\t",
): string {
	const schema = mode === "schema" ? (redactSchemaValue(args) as Record<string, unknown>) : undefined;
	// A scrubbed schema key no longer matches the original argument name, so the schema's own
	// entries are used once it exists; the scrubbed title is already part of them.
	// Arguments are paired over the whole object — names included — and a scrubbed schema name
	// no longer matches the original argument name, so each mode walks its own entries.
	const paired = mode === "arguments" ? (redactCrossFieldPrivateKeys([args])[0] as Record<string, unknown>) : schema;
	const entries = Object.entries(paired ?? args).filter(([key]) => key !== INTENT_FIELD);
	const parts: string[] = [];
	for (const [key, value] of entries) {
		const escapedKey = escapeXmlAttribute(redactCrashSecrets(key));
		const text = schema === undefined ? formatArgumentText(value, key) : formatSchemaText(value);
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
	return parts.join("\n");
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
			lines.push(`\nParameters:\n${formatArgsAsXml(parametersClean as Record<string, unknown>, "schema")}`);
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
						lines.push(formatArgsAsXml(c.arguments as Record<string, unknown>, "arguments"));
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
				// The renderer emits the sections in reading order, so scrubbing its output pairs a
				// private-key block across command, output and notice without ordering assumptions.
				lines.push(redactCrashSecrets(bashExecutionToText(bashMsg)));
				lines.push("\n");
			}
		} else if (msg.role === "pythonExecution") {
			const pythonMsg = msg as PythonExecutionMessage;
			if (!pythonMsg.excludeFromContext) {
				lines.push("## Python Execution\n");
				lines.push(redactCrashSecrets(pythonExecutionToText(pythonMsg)));
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
