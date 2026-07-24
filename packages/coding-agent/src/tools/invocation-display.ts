import { PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "./render-utils";

export const REDACTED_INVOCATION_VALUE = "<redacted>";

const SENSITIVE_NAME_PATTERN =
	/(?:^|_)(?:api_?key|access_?key|token|secret|password|passwd|pwd|credential|authorization|auth|bearer|cookie|session|client_?secret|private_?key)(?:$|_)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_VALUE_PATTERN =
	/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const URL_CREDENTIAL_PATTERN = /(https?:\/\/[^\s:/@]+:)([^\s@]+)(@)/gi;
const LONG_VALUE_CHARS = TRUNCATE_LENGTHS.LINE;

function formatByteSize(value: string): string {
	const bytes = new TextEncoder().encode(value).byteLength;
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

function summarizeValue(value: string, type: "argument" | "multiline"): string {
	if (type === "multiline") {
		return `<multiline, ${value.split(/\r?\n/).length} lines, ${formatByteSize(value)}>`;
	}
	return `<argument, ${formatByteSize(value)}>`;
}

export function isSensitiveInvocationName(name: string): boolean {
	return SENSITIVE_NAME_PATTERN.test(name);
}

export function redactInvocationValuePatterns(value: string): string {
	return value
		.replace(BEARER_PATTERN, "Bearer <redacted>")
		.replace(TOKEN_VALUE_PATTERN, REDACTED_INVOCATION_VALUE)
		.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED_INVOCATION_VALUE}$3`);
}

function displayValue(value: string, expanded: boolean, sensitive: boolean): string {
	if (sensitive) return REDACTED_INVOCATION_VALUE;
	const redacted = redactInvocationValuePatterns(value);
	if (expanded) return redacted;
	if (/\r?\n/.test(value)) return summarizeValue(value, "multiline");
	if (value.length > LONG_VALUE_CHARS) return summarizeValue(value, "argument");
	return redacted;
}

function escapeBashDisplayValue(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

export function formatInvocationEnvironment(env: Record<string, string> | undefined, expanded: boolean): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => {
			const displayed = displayValue(value, expanded, isSensitiveInvocationName(key));
			return `${key}="${escapeBashDisplayValue(displayed)}"`;
		})
		.join(" ");
}

function findClosingQuote(value: string, start: number, quote: string): number {
	for (let index = start; index < value.length; index += 1) {
		if (value[index] === "\\") {
			index += 1;
			continue;
		}
		if (value[index] === quote) return index;
	}
	return -1;
}

function redactEmbeddedAssignments(command: string, expanded: boolean): string {
	const assignmentPattern = /(^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=(['"])/gm;
	let cursor = 0;
	let output = "";
	for (let match = assignmentPattern.exec(command); match; match = assignmentPattern.exec(command)) {
		const [token, prefix, key, quote] = match;
		const valueStart = match.index + token.length;
		const valueEnd = findClosingQuote(command, valueStart, quote);
		if (valueEnd < 0) continue;
		output += command.slice(cursor, match.index);
		const value = command.slice(valueStart, valueEnd);
		const displayed = displayValue(value, expanded, isSensitiveInvocationName(key));
		output += `${prefix}${key}=${quote}${displayed}${quote}`;
		cursor = valueEnd + 1;
		assignmentPattern.lastIndex = cursor;
	}
	output += command.slice(cursor);
	return output.replace(
		/(^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=([^\s;'"]+)/gm,
		(_match, prefix: string, key: string, value: string) =>
			`${prefix}${key}=${displayValue(value, expanded, isSensitiveInvocationName(key))}`,
	);
}

function redactSensitiveFlags(command: string): string {
	const flagName =
		"(--?[A-Za-z0-9_-]*(?:token|secret|password|passwd|pwd|credential|authorization|api[-_]?key)[A-Za-z0-9_-]*)";
	let redacted = command.replace(
		new RegExp(`${flagName}=(['"])([\\s\\S]*?)\\2`, "gi"),
		(_match, flag: string, quote: string) => `${flag}=${quote}${REDACTED_INVOCATION_VALUE}${quote}`,
	);
	redacted = redacted.replace(
		new RegExp(`${flagName}(\\s+)(['"])([\\s\\S]*?)\\3`, "gi"),
		(_match, flag: string, spacing: string, quote: string) =>
			`${flag}${spacing}${quote}${REDACTED_INVOCATION_VALUE}${quote}`,
	);
	redacted = redacted.replace(
		new RegExp(`${flagName}=([^\\s'"]+)`, "gi"),
		(_match, flag: string) => `${flag}=${REDACTED_INVOCATION_VALUE}`,
	);
	return redacted.replace(
		new RegExp(`${flagName}(\\s+)([^\\s'"]+)`, "gi"),
		(_match, flag: string, spacing: string) => `${flag}${spacing}${REDACTED_INVOCATION_VALUE}`,
	);
}

function collapseMultilineCommand(command: string): string {
	const lines = command.split(/\r?\n/);
	if (lines.length <= PREVIEW_LIMITS.COLLAPSED_LINES) return command;
	const prefix = lines.slice(0, PREVIEW_LIMITS.COLLAPSED_LINES).join("\n");
	return `${prefix}\n<multiline command, ${lines.length} lines, ${formatByteSize(command)}>`;
}

function collapseLongQuotedArguments(command: string): string {
	return command.replace(/(['"])([^'"\n]{111,})\1/g, (_match, quote: string, value: string) => {
		return `${quote}${summarizeValue(value, "argument")}${quote}`;
	});
}

function collapseLongUnquotedArguments(command: string): string {
	return command.replace(
		/(^|\s)([^\s'"]{111,})(?=\s|$)/g,
		(_match, prefix: string, value: string) => `${prefix}${summarizeValue(value, "argument")}`,
	);
}

export function formatInvocationCommand(command: string, expanded: boolean): string {
	let displayed = redactEmbeddedAssignments(command, expanded);
	displayed = redactSensitiveFlags(displayed);
	displayed = redactInvocationValuePatterns(displayed);
	if (expanded) return displayed;
	displayed = collapseLongQuotedArguments(displayed);
	displayed = collapseLongUnquotedArguments(displayed);
	return collapseMultilineCommand(displayed);
}
