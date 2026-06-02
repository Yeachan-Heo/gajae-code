export interface BashAllowedPrefixesCheck {
	allowed: boolean;
	reason?: string;
}

const SHELL_CONTROL_CHARS = new Set([";", "|", "&", "<", ">", "(", ")"]);
const UNSAFE_UNQUOTED_EXPANSION_CHARS = new Set(["$", "*", "?", "[", "]", "{", "}", "~"]);
const STATE_FLAGS_WITH_VALUES = new Set(["--input", "--mode", "--session-id", "--thread-id", "--turn-id", "--to"]);
const STATE_ACTIONS = new Set(["read", "write", "clear", "contract", "handoff"]);
const ALLOWED_STATE_ACTIONS = new Set(["read", "write", "contract"]);

function parseShellWords(command: string): { words: string[]; reason?: string } {
	const words: string[] = [];
	let current = "";
	let quote: "single" | "double" | null = null;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;
		const next = command[index + 1];

		if (quote === "single") {
			if (char === "'") {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (quote === "double") {
			if (char === '"') {
				quote = null;
				continue;
			}
			if (char === "`" || (char === "$" && next === "(")) {
				return { words, reason: "command substitution is not allowed in restricted bash commands" };
			}
			if (char === "$") {
				return { words, reason: "shell expansion character '$' is not allowed in restricted bash commands" };
			}
			if (char === "\\") {
				return { words, reason: "backslash escapes are not allowed in restricted bash commands" };
			}
			current += char;
			continue;
		}

		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === '"') {
			quote = "double";
			continue;
		}
		if (char === "`" || (char === "$" && next === "(")) {
			return { words, reason: "command substitution is not allowed in restricted bash commands" };
		}
		if (char === "\n" || char === "\r") {
			return { words, reason: "multiple shell commands are not allowed in restricted bash mode" };
		}
		if (SHELL_CONTROL_CHARS.has(char)) {
			return { words, reason: `shell control operator '${char}' is not allowed in restricted bash commands` };
		}
		if (UNSAFE_UNQUOTED_EXPANSION_CHARS.has(char)) {
			return { words, reason: `shell expansion character '${char}' is not allowed in restricted bash commands` };
		}
		if (/\s/u.test(char)) {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
			continue;
		}
		if (char === "\\") {
			return { words, reason: "backslash escapes are not allowed in restricted bash commands" };
		}
		current += char;
	}

	if (quote !== null) {
		return { words, reason: "unterminated quote in restricted bash command" };
	}
	if (current.length > 0) words.push(current);
	return { words };
}

function prefixWords(prefix: string): string[] {
	return prefix.trim().split(/\s+/u).filter(Boolean);
}

function wordsStartWith(words: readonly string[], prefix: readonly string[]): boolean {
	if (prefix.length === 0 || words.length < prefix.length) return false;
	return prefix.every((word, index) => words[index] === word);
}

function parseStateAction(words: readonly string[]): string | undefined {
	const args = words.slice(2);
	const positional: string[] = [];
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (STATE_FLAGS_WITH_VALUES.has(arg)) {
			skipNext = true;
			continue;
		}
		if (!arg.startsWith("-")) positional.push(arg);
	}

	const [first, second, third] = positional;
	if (!first) return "read";
	if (STATE_ACTIONS.has(first)) return second ? undefined : first;
	if (!second) return "read";
	if (!STATE_ACTIONS.has(second)) return undefined;
	return third ? undefined : second;
}

function validateMatchedGjcCommand(words: readonly string[]): BashAllowedPrefixesCheck {
	if (words[0] !== "gjc") return { allowed: true };

	if (words[1] === "ralplan") {
		if (!words.includes("--write")) {
			return { allowed: false, reason: "restricted role-agent bash only allows `gjc ralplan --write ...`" };
		}
		return { allowed: true };
	}

	if (words[1] === "state") {
		const action = parseStateAction(words);
		if (!action) {
			return {
				allowed: false,
				reason: "restricted role-agent bash only allows documented `gjc state` action shapes",
			};
		}
		if (!ALLOWED_STATE_ACTIONS.has(action)) {
			return { allowed: false, reason: `restricted role-agent bash does not allow \`gjc state ${action}\`` };
		}
		return { allowed: true };
	}

	return { allowed: true };
}

export function checkBashAllowedPrefixes(
	command: string,
	allowedPrefixes: readonly string[] | undefined,
): BashAllowedPrefixesCheck {
	const normalizedPrefixes = allowedPrefixes?.map(prefix => prefix.trim()).filter(Boolean) ?? [];
	if (normalizedPrefixes.length === 0) return { allowed: true };

	const parsed = parseShellWords(command.trim());
	if (parsed.reason) return { allowed: false, reason: parsed.reason };
	if (parsed.words.length === 0)
		return { allowed: false, reason: "empty command is not allowed in restricted bash mode" };

	const matched = normalizedPrefixes.some(prefix => wordsStartWith(parsed.words, prefixWords(prefix)));
	if (!matched) {
		return {
			allowed: false,
			reason: `restricted role-agent bash only allows commands starting with: ${normalizedPrefixes.join(", ")}`,
		};
	}

	return validateMatchedGjcCommand(parsed.words);
}
