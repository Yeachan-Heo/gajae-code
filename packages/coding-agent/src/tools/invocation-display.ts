import { Ellipsis, truncateToWidth, visibleWidth } from "@gajae-code/tui";
import { PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "./render-utils";

export const REDACTED_INVOCATION_VALUE = "<redacted>";

const SENSITIVE_NAME_PATTERN =
	/(?:^|_)(?:api_?key|access_?key|token|secret|password|passwd|pwd|credential|authorization|auth|bearer|cookie|session|client_?secret|private_?key)(?:$|_)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const TOKEN_VALUE_PATTERN =
	/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const URL_CREDENTIAL_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#@]+)(@)/g;
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
		.replace(URL_CREDENTIAL_PATTERN, (_match, scheme: string, userinfo: string, at: string) => {
			const colon = userinfo.indexOf(":");
			if (colon < 0) return `${scheme}${REDACTED_INVOCATION_VALUE}${at}`;
			return `${scheme}${userinfo.slice(0, colon)}:${REDACTED_INVOCATION_VALUE}${at}`;
		});
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

interface ShellWordSpan {
	start: number;
	end: number;
	value: string;
}

interface ShellWordWrapper {
	prefix: string;
	value: string;
	suffix: string;
}

function findShellWordSpans(command: string): ShellWordSpan[] {
	const spans: ShellWordSpan[] = [];
	let index = 0;
	while (index < command.length) {
		while (index < command.length && /[\s;&|()<>]/.test(command[index] ?? "")) index += 1;
		if (index >= command.length) break;
		const start = index;
		let quote: "single" | "double" | "ansi-c" | undefined;
		let substitutionDepth = 0;
		while (index < command.length) {
			const character = command[index] ?? "";
			if (quote === "single") {
				index += 1;
				if (character === "'") quote = undefined;
				continue;
			}
			if (quote === "double" || quote === "ansi-c") {
				if (character === "\\") {
					index = Math.min(index + 2, command.length);
					continue;
				}
				index += 1;
				if ((quote === "double" && character === '"') || (quote === "ansi-c" && character === "'")) {
					quote = undefined;
				}
				continue;
			}
			if (character === "\\") {
				index = Math.min(index + 2, command.length);
				continue;
			}
			if (character === '"') {
				quote = "double";
				index += 1;
				continue;
			}
			if (character === "'") {
				quote = index > start && command[index - 1] === "$" ? "ansi-c" : "single";
				index += 1;
				continue;
			}
			if (substitutionDepth > 0) {
				if (character === "(") substitutionDepth += 1;
				if (character === ")") substitutionDepth -= 1;
				index += 1;
				continue;
			}
			if (character === "$" && command[index + 1] === "(") {
				substitutionDepth = 1;
				index += 2;
				continue;
			}
			if (/[\s;&|()<>]/.test(character)) break;
			index += 1;
		}
		spans.push({ start, end: index, value: command.slice(start, index) });
	}
	return spans;
}

function cookShellWord(value: string): string {
	let output = "";
	let index = 0;
	let quote: "single" | "double" | "ansi-c" | undefined;
	while (index < value.length) {
		const character = value[index] ?? "";
		if (quote === "single") {
			index += 1;
			if (character === "'") quote = undefined;
			else output += character;
			continue;
		}
		if (quote === "double" || quote === "ansi-c") {
			if (character === "\\" && index + 1 < value.length) {
				output += value[index + 1] ?? "";
				index += 2;
				continue;
			}
			index += 1;
			if ((quote === "double" && character === '"') || (quote === "ansi-c" && character === "'")) {
				quote = undefined;
			} else {
				output += character;
			}
			continue;
		}
		if (character === "\\" && index + 1 < value.length) {
			output += value[index + 1] ?? "";
			index += 2;
			continue;
		}
		if (character === "$" && value[index + 1] === "'") {
			quote = "ansi-c";
			index += 2;
			continue;
		}
		if (character === '"') {
			quote = "double";
			index += 1;
			continue;
		}
		if (character === "'") {
			quote = "single";
			index += 1;
			continue;
		}
		output += character;
		index += 1;
	}
	return output;
}

function findShellWordEquals(value: string): number {
	let index = 0;
	let quote: "single" | "double" | "ansi-c" | undefined;
	let substitutionDepth = 0;
	while (index < value.length) {
		const character = value[index] ?? "";
		if (quote === "single") {
			index += 1;
			if (character === "'") quote = undefined;
			continue;
		}
		if (quote === "double" || quote === "ansi-c") {
			if (character === "\\") {
				index = Math.min(index + 2, value.length);
				continue;
			}
			index += 1;
			if ((quote === "double" && character === '"') || (quote === "ansi-c" && character === "'")) {
				quote = undefined;
			}
			continue;
		}
		if (character === "\\") {
			index = Math.min(index + 2, value.length);
			continue;
		}
		if (character === '"') {
			quote = "double";
			index += 1;
			continue;
		}
		if (character === "'") {
			quote = index > 0 && value[index - 1] === "$" ? "ansi-c" : "single";
			index += 1;
			continue;
		}
		if (substitutionDepth > 0) {
			if (character === "(") substitutionDepth += 1;
			if (character === ")") substitutionDepth -= 1;
			index += 1;
			continue;
		}
		if (character === "$" && value[index + 1] === "(") {
			substitutionDepth = 1;
			index += 2;
			continue;
		}
		if (character === "=") return index;
		index += 1;
	}
	return -1;
}

function splitShellWordWrapper(value: string): ShellWordWrapper {
	if (value.startsWith("$'") && value.endsWith("'")) {
		return { prefix: "$'", value: value.slice(2, -1), suffix: "'" };
	}
	const quote = value[0];
	if ((quote === "'" || quote === '"') && value.endsWith(quote)) {
		return { prefix: quote, value: value.slice(1, -1), suffix: quote };
	}
	return { prefix: "", value, suffix: "" };
}

function replaceShellWordValue(value: string, displayed: string): string {
	const wrapper = splitShellWordWrapper(value);
	return `${wrapper.prefix}${displayed}${wrapper.suffix}`;
}

function isSensitiveFlagName(name: string): boolean {
	return /^--?/.test(name) && isSensitiveInvocationName(name.replace(/^--?/, "").replaceAll("-", "_"));
}

function redactShellWords(command: string, expanded: boolean): string {
	const spans = findShellWordSpans(command);
	const replacements = new Map<number, string>();
	for (const [index, span] of spans.entries()) {
		if (replacements.has(index)) continue;
		const rawEquals = findShellWordEquals(span.value);
		const cookedWord = cookShellWord(span.value);
		const logicalEquals = cookedWord.indexOf("=");
		const rawName = rawEquals < 0 ? span.value : span.value.slice(0, rawEquals);
		const logicalName = logicalEquals < 0 ? cookedWord : cookedWord.slice(0, logicalEquals);
		if (rawEquals >= 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(logicalName)) {
			const rawValue = span.value.slice(rawEquals + 1);
			const wrapper = splitShellWordWrapper(rawValue);
			const displayed = displayValue(wrapper.value, expanded, isSensitiveInvocationName(logicalName));
			replacements.set(index, `${rawName}=${wrapper.prefix}${displayed}${wrapper.suffix}`);
			continue;
		}
		if (rawEquals < 0 && logicalEquals >= 0 && isSensitiveInvocationName(logicalName)) {
			replacements.set(index, replaceShellWordValue(span.value, `${logicalName}=${REDACTED_INVOCATION_VALUE}`));
			continue;
		}

		if (!isSensitiveFlagName(logicalName)) continue;
		if (rawEquals >= 0) {
			const rawValue = span.value.slice(rawEquals + 1);
			replacements.set(index, `${rawName}=${replaceShellWordValue(rawValue, REDACTED_INVOCATION_VALUE)}`);
			continue;
		}
		if (logicalEquals >= 0) {
			replacements.set(index, replaceShellWordValue(span.value, `${logicalName}=${REDACTED_INVOCATION_VALUE}`));
			continue;
		}

		const next = spans[index + 1];
		if (next && /^\s+$/.test(command.slice(span.end, next.start))) {
			replacements.set(index + 1, replaceShellWordValue(next.value, REDACTED_INVOCATION_VALUE));
		}
	}

	let output = "";
	let cursor = 0;
	for (const [index, span] of spans.entries()) {
		output += command.slice(cursor, span.start);
		output += replacements.get(index) ?? span.value;
		cursor = span.end;
	}
	return output + command.slice(cursor);
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

function boundCollapsedLines(command: string): string {
	return command
		.split("\n")
		.map(line =>
			visibleWidth(line) > LONG_VALUE_CHARS ? truncateToWidth(line, LONG_VALUE_CHARS, Ellipsis.Unicode) : line,
		)
		.join("\n");
}

export function formatInvocationCommand(command: string, expanded: boolean): string {
	let displayed = redactShellWords(command, expanded);
	displayed = redactInvocationValuePatterns(displayed);
	if (expanded) return displayed;
	displayed = collapseLongQuotedArguments(displayed);
	displayed = collapseLongUnquotedArguments(displayed);
	return boundCollapsedLines(collapseMultilineCommand(displayed));
}
