import * as fs from "node:fs";
import * as path from "node:path";
import { projectSafeSpawnEnv } from "@gajae-code/utils/shell-config";
import {
	classifyStateArgv,
	STATE_ACTION_NAMES,
	type StateAction,
	type StateArgvClassification,
} from "../gjc-runtime/state-argv";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../skill-state/canonical-skills";

export interface BashAllowedPrefixesCheck {
	allowed: boolean;
	reason?: string;
}

export type BashRestrictionProfile = "workflow" | "read-only";

/** Session identities and workspace the restricted `gjc` command may name. */
export interface GjcSessionBinding {
	sessionId?: string | null;
	/** Owner identity already on the tool session. Role-agent ralplan writes use it. */
	credentialSessionId?: string | null;
	/** Session workspace. A `--worktree-root` must be this repo, not a foreign one. */
	worktreeRoot: string;
	/** Child cwd. Relative `--worktree-root` resolves against it, as ralplan does. */
	invocationCwd: string;
}

export interface BashRestrictionOptions {
	profile?: BashRestrictionProfile;
	gjcSessionBinding?: GjcSessionBinding;
}

const SHELL_CONTROL_CHARS = new Set([";", "|", "&", "<", ">", "(", ")"]);
// `~` is handled separately: bash performs tilde expansion only at positions where a
// tilde can open an expansion - the start of a word, and inside an assignment word
// directly after the first `=` or after a `:` in the assigned value. A tilde anywhere
// else (e.g. the git revision `HEAD~1`) is a literal character.
const UNSAFE_UNQUOTED_EXPANSION_CHARS = new Set(["$", "*", "?", "[", "]", "{", "}"]);
// A bash assignment word has a plain assignment name before its first unquoted `=`,
// in either the `name=value` or the compound `name+=value` form.
const ASSIGNMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\+?$/u;
const ALLOWED_STATE_ACTIONS = new Set(["read", "write", "contract"]);
const CANONICAL_STATE_TARGETS = new Set<string>(CANONICAL_GJC_WORKFLOW_SKILLS);
const READ_ONLY_COMMANDS = new Set(["grep", "rg", "tree", "ls", "pwd", "wc", "du", "file", "stat"]);

function parseShellWords(command: string): { words: string[]; reason?: string } {
	const words: string[] = [];
	let current = "";
	let quote: "single" | "double" | null = null;

	let wordStarted = false;
	// Per-token tilde-expansion state. `assignmentNameCandidate` stays true while the
	// characters before the first unquoted `=` could still form an assignment name (any
	// quoting in that region disqualifies the token), `sawAssignmentEquals` records that
	// the token is an assignment word, and `tildeExpandable` means an unquoted `~` at the
	// current index would actually be expanded by bash.
	let assignmentNameCandidate = true;
	let sawAssignmentEquals = false;
	let tildeExpandable = false;
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
			wordStarted = true;
			if (!sawAssignmentEquals) assignmentNameCandidate = false;
			tildeExpandable = false;
			continue;
		}
		if (char === '"') {
			quote = "double";
			wordStarted = true;
			if (!sawAssignmentEquals) assignmentNameCandidate = false;
			tildeExpandable = false;
			continue;
		}
		if (char === "`" || (char === "$" && next === "(")) {
			return { words, reason: "command substitution is not allowed in restricted bash commands" };
		}
		if (char === "\n" || char === "\r") {
			return { words, reason: "multiple shell commands are not allowed in restricted bash mode" };
		}
		if (SHELL_CONTROL_CHARS.has(char)) {
			return {
				words,
				reason: `shell control operator '${char}' is not allowed in restricted bash commands; send one simple command per bash call (no chaining, pipes, or redirects) and pass the directory as \`cwd\` instead of \`cd … &&\``,
			};
		}
		if (UNSAFE_UNQUOTED_EXPANSION_CHARS.has(char)) {
			return { words, reason: `shell expansion character '${char}' is not allowed in restricted bash commands` };
		}
		// Tilde expansion is positional: bash expands a tilde only where one can open an
		// expansion, i.e. at the start of a word or, inside an assignment word, directly
		// after the first `=` or after a `:` in the assigned value. A tilde anywhere else
		// is literal, which is what git revision syntax such as `HEAD~1` relies on.
		if (char === "~" && (!wordStarted || tildeExpandable)) {
			return { words, reason: "shell expansion character '~' is not allowed in restricted bash commands" };
		}
		if (/\s/u.test(char)) {
			if (wordStarted) {
				words.push(current);
				current = "";
				wordStarted = false;
			}
			assignmentNameCandidate = true;
			sawAssignmentEquals = false;
			tildeExpandable = false;
			continue;
		}
		if (char === "\\") {
			return { words, reason: "backslash escapes are not allowed in restricted bash commands" };
		}
		if (char === "=" && !sawAssignmentEquals) {
			// Only a plain assignment name before the first unquoted `=` makes this an
			// assignment word whose value bash scans for tilde expansions.
			if (assignmentNameCandidate && ASSIGNMENT_NAME_PATTERN.test(current)) {
				sawAssignmentEquals = true;
				tildeExpandable = true;
			} else {
				assignmentNameCandidate = false;
				tildeExpandable = false;
			}
		} else if (char === ":" && sawAssignmentEquals) {
			tildeExpandable = true;
		} else {
			tildeExpandable = false;
		}
		current += char;
		wordStarted = true;
	}

	if (quote !== null) {
		return { words, reason: "unterminated quote in restricted bash command" };
	}
	if (wordStarted) words.push(current);
	return { words };
}

function prefixWords(prefix: string): string[] {
	return prefix.trim().split(/\s+/u).filter(Boolean);
}

function wordsStartWith(words: readonly string[], prefix: readonly string[]): boolean {
	if (prefix.length === 0 || words.length < prefix.length) return false;
	return prefix.every((word, index) => words[index] === word);
}

function malformedStateShape(): StateActionClassification {
	return { reason: "restricted role-agent bash only allows documented `gjc state` action shapes" };
}

interface ParsedStateAction {
	action: string;
	target: string;
}

interface StateActionClassification {
	parsed?: ParsedStateAction;
	reason?: string;
}

function hasDocumentedStatePositionals(classification: StateArgvClassification): boolean {
	const [first, second, third] = classification.positionals;
	if (third) return false;
	if (!second) return true;
	return STATE_ACTION_NAMES.has(first as StateAction) || STATE_ACTION_NAMES.has(second as StateAction);
}

function classifyStateAction(words: readonly string[]): StateActionClassification {
	const classification = classifyStateArgv(words.slice(2));
	if (
		classification.unknownFlags.length > 0 ||
		classification.flags.some(flag => flag.malformed) ||
		!hasDocumentedStatePositionals(classification)
	) {
		return malformedStateShape();
	}

	const modeFlags = classification.flags.filter(flag => flag.name === "--mode");
	const inputFlags = classification.flags.filter(flag => flag.name === "--input");
	if (modeFlags.length > 1 || inputFlags.length > 1) {
		return { reason: "restricted role-agent bash rejects repeated or conflicting `gjc state` target selectors" };
	}
	if (classification.inputs.some(input => input.kind === "file")) {
		return { reason: "restricted role-agent bash does not allow file-backed `gjc state --input` values" };
	}
	if (classification.inputs.some(input => input.kind === "invalid")) return malformedStateShape();

	const runtimeTarget = classification.runtimeSelectorCandidates.find(candidate => candidate.value)?.value;
	const suppliedTargets = classification.selectorCandidates
		.map(candidate => candidate.value)
		.filter((target): target is string => target !== undefined);
	const distinctTargets = new Set(suppliedTargets);
	if (distinctTargets.size > 1 || (runtimeTarget && suppliedTargets.some(target => target !== runtimeTarget))) {
		return {
			reason:
				"restricted role-agent bash rejects conflicting `gjc state` selectors that disagree with runtime precedence",
		};
	}
	if (!runtimeTarget || !CANONICAL_STATE_TARGETS.has(runtimeTarget)) {
		return { reason: "restricted role-agent bash requires a canonical workflow skill for `gjc state` commands" };
	}
	return { parsed: { action: classification.effectiveAction, target: runtimeTarget } };
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

function fileCompilesMagic(words: readonly string[]): boolean {
	const valueOptions = ["--exclude", "--exclude-quiet", "--files-from", "--separator", "--magic-file", "--parameter"];
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index]!;
		if (word === "--") break;
		if (word.startsWith("--")) {
			const equalsAt = word.indexOf("=");
			const name = equalsAt === -1 ? word : word.slice(0, equalsAt);
			if (name.length > 2 && "--compile".startsWith(name)) return true;
			if (equalsAt === -1 && valueOptions.some(option => name.length > 2 && option.startsWith(name))) {
				index += 1;
			}
		} else if (word.startsWith("-")) {
			for (let offset = 1; offset < word.length; offset += 1) {
				const flag = word[offset]!;
				if (flag === "C") return true;
				// Required arguments consume the rest of the cluster, or the next word (even `--`).
				if ("eFfmMP".includes(flag)) {
					if (offset === word.length - 1) index += 1;
					break;
				}
			}
		}
	}
	return false;
}

function hasShortOption(word: string, option: string): boolean {
	return word.startsWith("-") && !word.startsWith("--") && word.slice(1).includes(option);
}
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolvedExternalCommand(command: string): string | undefined {
	// Bun.which caches a command name until PATH is passed explicitly, so a test
	// or a later session that changes PATH must be visible here.
	return Bun.which(command, { PATH: process.env.PATH ?? "" }) ?? undefined;
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
			if (isLongOption(option, "--hostname-bin")) {
				return { allowed: false, reason: "read-only bash does not allow ripgrep hostname commands" };
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

	if (command === "file" && fileCompilesMagic(words)) {
		return { allowed: false, reason: "read-only bash does not allow file magic compilation" };
	}

	const gitWrite = rejectGitHostAccess(words);
	if (gitWrite) return gitWrite;

	return { allowed: true };
}

const GIT_DIFF_FAMILY_SUBCOMMANDS = new Set(["blame", "diff", "log", "show"]);

function gitOptionName(word: string): string {
	const equalsAt = word.indexOf("=");
	return equalsAt === -1 ? word : word.slice(0, equalsAt);
}

/** Enabling forms only. `--no-ext-diff` and `--no-textconv` stay allowed. */
function gitEnablesExternalHelper(word: string): boolean {
	if (!word.startsWith("--")) return false;
	const name = gitOptionName(word);
	return name === "--ext-diff" || name === "--textconv";
}

function rejectGitHostAccess(words: readonly string[]): BashAllowedPrefixesCheck | undefined {
	if (words[0] !== "git") return undefined;
	for (const option of optionWords(words)) {
		if (isLongOption(option, "--output") || isLongOption(option, "--no-index")) {
			return { allowed: false, reason: "restricted bash does not allow git --output or --no-index" };
		}
		if (gitEnablesExternalHelper(option)) {
			return {
				allowed: false,
				reason: "restricted bash does not allow git external diff or textconv helpers",
			};
		}
	}
	return undefined;
}

/**
 * Diff-family git commands run `diff.external`, `GIT_EXTERNAL_DIFF`, and textconv
 * filters unless these flags are present. Place them immediately after the
 * subcommand so a later value-taking option cannot consume them and they stay
 * before a `--` pathspec. The gate rejects a later `--ext-diff` or `--textconv`,
 * which would otherwise win.
 */
function disableGitExternalHelpers(commandName: string, argv: readonly string[]): string[] {
	if (commandName !== "git" || !GIT_DIFF_FAMILY_SUBCOMMANDS.has(argv[1] ?? "")) return [...argv];
	const next = [...argv];
	next.splice(2, 0, "--no-ext-diff", "--no-textconv");
	return next;
}

const GJC_SESSION_BIND_REASON = "restricted role-agent bash binds gjc to the current session";
const GJC_WORKTREE_BIND_REASON = "restricted role-agent bash binds gjc --worktree-root to the current repository";

function separateFlagValues(words: readonly string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < words.length; index += 1) {
		if (words[index] !== flag) continue;
		values.push(words[index + 1] ?? "");
		index += 1;
	}
	return values;
}

function boundSessionIds(binding: GjcSessionBinding): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const value of [binding.sessionId, binding.credentialSessionId]) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) ids.add(trimmed);
	}
	return ids;
}

function inlineStateSessionIds(words: readonly string[]): string[] {
	if (words[1] !== "state") return [];
	const ids: string[] = [];
	for (const input of classifyStateArgv(words.slice(2)).inputs) {
		if (input.kind !== "inline") continue;
		let payload: unknown;
		try {
			payload = JSON.parse(input.raw);
		} catch {
			continue;
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
		const sessionId = (payload as Record<string, unknown>).session_id;
		if (typeof sessionId === "string") ids.push(sessionId);
	}
	return ids;
}

function gitCommonDir(directory: string): string | undefined {
	const result = Bun.spawnSync(["git", "-C", directory, "rev-parse", "--git-common-dir"], {
		env: projectSafeSpawnEnv(),
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return undefined;
	const text = result.stdout.toString().trim();
	if (!text) return undefined;
	const absolute = path.isAbsolute(text) ? text : path.resolve(directory, text);
	try {
		return fs.realpathSync(absolute);
	} catch {
		return undefined;
	}
}

/** Same directory, or another worktree of the same git common dir (isolated tasks). */
function sameRepository(workspace: string, target: string): boolean {
	let workspaceReal: string;
	let targetReal: string;
	try {
		workspaceReal = fs.realpathSync(workspace);
		targetReal = fs.realpathSync(target);
	} catch {
		return false;
	}
	if (workspaceReal === targetReal) return true;
	const workspaceCommon = gitCommonDir(workspaceReal);
	const targetCommon = gitCommonDir(targetReal);
	return workspaceCommon !== undefined && workspaceCommon === targetCommon;
}

function worktreeSelectorAllowed(binding: GjcSessionBinding, rawTarget: string): boolean {
	const trimmed = rawTarget.trim();
	if (!trimmed) return false;
	const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(binding.invocationCwd, trimmed);
	return sameRepository(binding.worktreeRoot, resolved);
}

function rejectUnboundGjcCommand(
	words: readonly string[],
	options: BashRestrictionOptions,
): BashAllowedPrefixesCheck | undefined {
	const binding = options.gjcSessionBinding;
	if (!binding) return undefined;
	const allowed = boundSessionIds(binding);
	const sessionSelectors = [...separateFlagValues(words, "--session-id"), ...inlineStateSessionIds(words)];
	if (sessionSelectors.some(value => !allowed.has(value.trim()))) {
		return { allowed: false, reason: GJC_SESSION_BIND_REASON };
	}
	if (separateFlagValues(words, "--worktree-root").some(value => !worktreeSelectorAllowed(binding, value))) {
		return { allowed: false, reason: GJC_WORKTREE_BIND_REASON };
	}
	return undefined;
}

function validateMatchedGjcCommand(
	words: readonly string[],
	options: BashRestrictionOptions,
): BashAllowedPrefixesCheck {
	const gitWrite = rejectGitHostAccess(words);
	if (gitWrite) return gitWrite;
	if (words[0] !== "gjc") return { allowed: true };

	if (words[1] === "ralplan") {
		if (!words.includes("--write")) {
			return { allowed: false, reason: "restricted role-agent bash only allows `gjc ralplan --write ...`" };
		}
		return rejectUnboundGjcCommand(words, options) ?? { allowed: true };
	}

	if (words[1] === "state") {
		const classification = classifyStateAction(words);
		if (!classification.parsed) {
			return {
				allowed: false,
				reason:
					classification.reason ?? "restricted role-agent bash only allows documented `gjc state` action shapes",
			};
		}
		if (!ALLOWED_STATE_ACTIONS.has(classification.parsed.action)) {
			return {
				allowed: false,
				reason: `restricted role-agent bash does not allow \`gjc state ${classification.parsed.action}\``,
			};
		}
		return rejectUnboundGjcCommand(words, options) ?? { allowed: true };
	}

	return rejectUnboundGjcCommand(words, options) ?? { allowed: true };
}

function commandAllowedPrefixesReason(normalizedPrefixes: readonly string[], options: BashRestrictionOptions): string {
	const prefixList = normalizedPrefixes.join(", ");
	return options.profile === "read-only"
		? `read-only bash only allows commands starting with: ${prefixList}`
		: `restricted role-agent bash only allows commands starting with: ${prefixList}`;
}

/**
 * Workflow restricted bash keeps the lexical prefix check, then runs the resolved
 * executable. Callers also skip the shell snapshot and shell prefix, because a
 * snapshot function can be named for that absolute path.
 */
export function normalizeWorkflowBashCommand(
	command: string,
	allowedPrefixes: readonly string[] | undefined,
	options: BashRestrictionOptions = {},
): string | undefined {
	if (options.profile === "read-only") return undefined;
	const gate = checkBashAllowedPrefixes(command, allowedPrefixes, { ...options, profile: "workflow" });
	if (!gate.allowed) return undefined;
	const parsed = parseShellWords(command.trim());
	if (parsed.reason || parsed.words.length === 0) return undefined;
	const [head, ...rest] = parsed.words;
	if (!head) return undefined;
	const resolvedHead = resolvedExternalCommand(head);
	if (!resolvedHead) return undefined;
	return disableGitExternalHelpers(head, [resolvedHead, ...rest])
		.map(shellQuote)
		.join(" ");
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
	return validateMatchedGjcCommand(parsed.words, options);
}
