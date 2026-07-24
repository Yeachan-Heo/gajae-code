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
const ANSI_C_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
};

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

type ShellQuote = "single" | "double" | "ansi-c" | "backtick";
type ShellScanQuote = Exclude<ShellQuote, "backtick">;

interface ShellScanFrame {
	kind: "word" | "substitution" | "backtick";
	quote?: ShellScanQuote;
	parenthesisDepth: number;
}

function findShellWordSpans(command: string): ShellWordSpan[] {
	const spans: ShellWordSpan[] = [];
	let index = 0;
	while (index < command.length) {
		while (index < command.length && /[\s;&|()<>]/.test(command[index] ?? "")) index += 1;
		if (index >= command.length) break;
		const start = index;
		const frames: ShellScanFrame[] = [{ kind: "word", parenthesisDepth: 0 }];
		while (index < command.length) {
			const frame = frames.at(-1)!;
			const character = command[index] ?? "";
			if (frame.quote === "single") {
				index += 1;
				if (character === "'") frame.quote = undefined;
				continue;
			}
			if (frame.quote === "ansi-c") {
				if (character === "\\") {
					index = Math.min(index + 2, command.length);
					continue;
				}
				index += 1;
				if (character === "'") frame.quote = undefined;
				continue;
			}
			if (frame.quote === "double") {
				if (character === "\\") {
					index = Math.min(index + 2, command.length);
					continue;
				}
				if (character === '"') {
					frame.quote = undefined;
					index += 1;
					continue;
				}
				if (character === "$" && command[index + 1] === "(") {
					frames.push({ kind: "substitution", parenthesisDepth: 1 });
					index += 2;
					continue;
				}
				if (character === "`") {
					frames.push({ kind: "backtick", parenthesisDepth: 0 });
					index += 1;
					continue;
				}
				index += 1;
				continue;
			}
			if (character === "\\") {
				index = Math.min(index + 2, command.length);
				continue;
			}
			if (character === '"') {
				frame.quote = "double";
				index += 1;
				continue;
			}
			if (character === "'") {
				frame.quote = index > start && command[index - 1] === "$" ? "ansi-c" : "single";
				index += 1;
				continue;
			}
			if (character === "$" && command[index + 1] === "(") {
				frames.push({ kind: "substitution", parenthesisDepth: 1 });
				index += 2;
				continue;
			}
			if (character === "`") {
				if (frame.kind === "backtick") frames.pop();
				else frames.push({ kind: "backtick", parenthesisDepth: 0 });
				index += 1;
				continue;
			}
			if (frame.kind === "substitution") {
				if (character === "(") frame.parenthesisDepth += 1;
				if (character === ")") {
					frame.parenthesisDepth -= 1;
					if (frame.parenthesisDepth === 0) frames.pop();
				}
				index += 1;
				continue;
			}
			if (frame.kind === "backtick") {
				index += 1;
				continue;
			}
			if (/[\s;&|()<>]/.test(character)) break;
			index += 1;
		}
		spans.push({ start, end: index, value: command.slice(start, index) });
	}
	return spans;
}

function readAnsiDigits(value: string, start: number, maxLength: number, pattern: RegExp): string {
	let end = start;
	while (end < value.length && end - start < maxLength && pattern.test(value[end] ?? "")) end += 1;
	return value.slice(start, end);
}

function ansiCodePoint(digits: string, radix: number, fallback: string): string {
	if (!digits) return fallback;
	const codePoint = Number.parseInt(digits, radix);
	return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : fallback;
}

function decodeAnsiCEscape(value: string, index: number): { decoded: string; nextIndex: number } {
	const escaped = value[index];
	if (escaped === undefined) return { decoded: "\\", nextIndex: index };
	const simple = ANSI_C_SIMPLE_ESCAPES[escaped];
	if (simple !== undefined) return { decoded: simple, nextIndex: index + 1 };
	if (escaped === "c") {
		const control = value[index + 1];
		if (control === undefined) return { decoded: "c", nextIndex: index + 1 };
		return {
			decoded: control === "?" ? "\x7f" : String.fromCharCode(control.toUpperCase().charCodeAt(0) & 0x1f),
			nextIndex: index + 2,
		};
	}
	if (escaped === "x") {
		const digits = readAnsiDigits(value, index + 1, 2, /[0-9a-f]/i);
		return { decoded: ansiCodePoint(digits, 16, "x"), nextIndex: index + 1 + digits.length };
	}
	if (escaped === "u" || escaped === "U") {
		const digits = readAnsiDigits(value, index + 1, escaped === "u" ? 4 : 8, /[0-9a-f]/i);
		return { decoded: ansiCodePoint(digits, 16, escaped), nextIndex: index + 1 + digits.length };
	}
	if (/[0-7]/.test(escaped)) {
		const maxLength = escaped === "0" ? 4 : 3;
		const digits = readAnsiDigits(value, index, maxLength, /[0-7]/);
		return { decoded: ansiCodePoint(digits, 8, escaped), nextIndex: index + digits.length };
	}
	return { decoded: escaped, nextIndex: index + 1 };
}

function cookShellWord(value: string): string {
	let output = "";
	let index = 0;
	let quote: ShellQuote | undefined;
	while (index < value.length) {
		const character = value[index] ?? "";
		if (quote === "single") {
			index += 1;
			if (character === "'") quote = undefined;
			else output += character;
			continue;
		}
		if (quote === "ansi-c") {
			if (character === "\\") {
				const decodedEscape = decodeAnsiCEscape(value, index + 1);
				output += decodedEscape.decoded;
				index = decodedEscape.nextIndex;
				continue;
			}
			index += 1;
			if (character === "'") quote = undefined;
			else output += character;
			continue;
		}
		if (quote === "double" || quote === "backtick") {
			if (character === "\\" && index + 1 < value.length) {
				output += value[index + 1] ?? "";
				index += 2;
				continue;
			}
			index += 1;
			if ((quote === "double" && character === '"') || (quote === "backtick" && character === "`")) {
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
		if (character === "`") {
			quote = "backtick";
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
	let quote: ShellQuote | undefined;
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
		if (quote === "backtick") {
			if (character === "\\") {
				index = Math.min(index + 2, value.length);
				continue;
			}
			index += 1;
			if (character === "`") quote = undefined;
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
		if (character === "`") {
			quote = "backtick";
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
		const classifiedName = logicalName.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
		if (rawEquals >= 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(classifiedName)) {
			const rawValue = span.value.slice(rawEquals + 1);
			const wrapper = splitShellWordWrapper(rawValue);
			const displayed = displayValue(wrapper.value, expanded, isSensitiveInvocationName(classifiedName));
			replacements.set(index, `${rawName}=${wrapper.prefix}${displayed}${wrapper.suffix}`);
			continue;
		}
		if (rawEquals < 0 && logicalEquals >= 0 && isSensitiveInvocationName(classifiedName)) {
			replacements.set(index, replaceShellWordValue(span.value, `${classifiedName}=${REDACTED_INVOCATION_VALUE}`));
			continue;
		}

		if (!isSensitiveFlagName(classifiedName)) continue;
		if (rawEquals >= 0) {
			const rawValue = span.value.slice(rawEquals + 1);
			replacements.set(index, `${rawName}=${replaceShellWordValue(rawValue, REDACTED_INVOCATION_VALUE)}`);
			continue;
		}
		if (logicalEquals >= 0) {
			replacements.set(index, replaceShellWordValue(span.value, `${classifiedName}=${REDACTED_INVOCATION_VALUE}`));
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
