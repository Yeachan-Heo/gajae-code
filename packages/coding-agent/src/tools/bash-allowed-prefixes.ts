export interface BashAllowedPrefixesCheck {
	allowed: boolean;
	reason?: string;
}

export type BashRestrictionProfile = "workflow" | "read-only";

export interface BashRestrictionOptions {
	profile?: BashRestrictionProfile;
}

const SHELL_CONTROL_CHARS = new Set([";", "|", "&", "<", ">", "(", ")"]);
const UNSAFE_UNQUOTED_EXPANSION_CHARS = new Set(["$", "*", "?", "[", "]", "{", "}", "~"]);
const STATE_FLAGS_WITH_VALUES = new Set(["--input", "--mode", "--session-id", "--thread-id", "--turn-id", "--to"]);
const STATE_ACTIONS = new Set(["read", "write", "clear", "contract", "handoff"]);
const ALLOWED_STATE_ACTIONS = new Set(["read", "write", "contract"]);
const READ_ONLY_COMMANDS = new Set(["grep", "rg", "tree", "ls", "pwd", "wc", "du", "file", "stat"]);

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

function optionWords(words: readonly string[]): string[] {
	const options: string[] = [];
	for (const word of words.slice(1)) {
		if (word === "--") break;
		options.push(word);
	}
	return options;
}

function isLongOption(word: string, option: string): boolean {
	return word === option || word.startsWith(`${option}=`);
}

function hasShortOption(word: string, option: string): boolean {
	return word.startsWith("-") && !word.startsWith("--") && word.slice(1).includes(option);
}
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolvedExternalCommand(command: string): string | undefined {
	return Bun.which(command) ?? undefined;
}

function validateReadOnlyCommand(words: readonly string[]): BashAllowedPrefixesCheck {
	const command = words[0];
	if (!command || !READ_ONLY_COMMANDS.has(command)) {
		return { allowed: false, reason: "read-only bash only allows approved inspection commands" };
	}

	const options = optionWords(words);
	if (command === "rg") {
		for (const option of options) {
			if (isLongOption(option, "--pre") || isLongOption(option, "--pre-glob")) {
				return { allowed: false, reason: "read-only bash does not allow ripgrep preprocessors" };
			}
			if (isLongOption(option, "--search-zip") || hasShortOption(option, "z")) {
				return { allowed: false, reason: "read-only bash does not allow ripgrep compressed-file subprocesses" };
			}
		}
	}

	if (command === "tree") {
		for (const option of options) {
			if (isLongOption(option, "--output") || hasShortOption(option, "o")) {
				return { allowed: false, reason: "read-only bash does not allow tree output-file writes" };
			}
		}
	}

	return { allowed: true };
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

function commandAllowedPrefixesReason(normalizedPrefixes: readonly string[], options: BashRestrictionOptions): string {
	const prefixList = normalizedPrefixes.join(", ");
	return options.profile === "read-only"
		? `read-only bash only allows commands starting with: ${prefixList}`
		: `restricted role-agent bash only allows commands starting with: ${prefixList}`;
}

export function normalizeReadOnlyBashCommand(command: string): string | undefined {
	const parsed = parseShellWords(command.trim());
	if (parsed.reason || parsed.words.length === 0) return undefined;
	const validation = validateReadOnlyCommand(parsed.words);
	if (!validation.allowed) return undefined;
	const [head, ...rest] = parsed.words;
	if (!head) return undefined;
	const resolvedHead = resolvedExternalCommand(head);
	if (!resolvedHead) return undefined;
	return [shellQuote(resolvedHead), ...rest.map(shellQuote)].join(" ");
}

export function checkBashAllowedPrefixes(
	command: string,
	allowedPrefixes: readonly string[] | undefined,
	options: BashRestrictionOptions = {},
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
			reason: commandAllowedPrefixesReason(normalizedPrefixes, options),
		};
	}

	if (options.profile === "read-only") {
		return validateReadOnlyCommand(parsed.words);
	}
	return validateMatchedGjcCommand(parsed.words);
}
