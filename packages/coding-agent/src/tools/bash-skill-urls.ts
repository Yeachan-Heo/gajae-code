import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getTrustedHomeDir, isEnoent } from "@gajae-code/utils";
import { findRepoRoot } from "../capability/fs";
import type { Rule } from "../capability/rule";
import type { Skill } from "../extensibility/skills";
import {
	initializeLocalRoot,
	type LocalProtocolOptions,
	resolveLocalRoot,
	resolveLocalUrlToPath,
} from "../internal-urls/local-protocol";
import { validateRelativePath } from "../internal-urls/skill-protocol";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import { normalizeLocalScheme } from "./path-utils";
import { ToolError } from "./tool-errors";

/** Regex to find skill:// tokens in command text. */
const SKILL_URL_PATTERN = /'skill:\/\/[^'\s")`\\]+'|"skill:\/\/[^"\s')`\\]+"|skill:\/\/[^\s'")`\\]+/g;

const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^\s'")`\\]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\]+/g;

const SUPPORTED_INTERNAL_SCHEMES = ["skill", "agent", "artifact", "plan", "memory", "rule", "local"] as const;

type SupportedInternalScheme = (typeof SUPPORTED_INTERNAL_SCHEMES)[number];

interface InternalUrlResolver {
	canHandle(input: string): boolean;
	resolve(input: string, context?: ResolveContext): Promise<InternalResource>;
}

export interface InternalUrlExpansionOptions {
	skills: readonly Skill[];
	noEscape?: boolean;
	internalRouter?: InternalUrlResolver;
	localOptions?: LocalProtocolOptions;
	ensureLocalParentDirs?: boolean;
	/** Project directory of the bash session. `rule://` must stay inside its boundary. */
	sessionCwd?: string;
	/** Agent directory for this session. User rules use it. */
	sessionAgentDir?: string;
	/**
	 * Rules loaded for this session. `rule://` resolves only against this list;
	 * an absent list resolves no rule rather than falling back to the
	 * process-global snapshot that another session owns.
	 */
	rules?: readonly Rule[];
	/**
	 * How the expanded text is read afterwards. `"shell"` (default) is command
	 * text the shell parses, so quoting, multi-line, and nested-expansion guards
	 * apply. `"data"` is a value the executor passes verbatim (an env value): no
	 * shell parses it, so those guards would refuse legitimate content without
	 * protecting anything. URL authorization and the shell-bearing path refusal
	 * still apply, and a data replacement is never shell-escaped.
	 */
	context?: "shell" | "data";
}

/**
 * Resolve a single skill:// URL to its absolute filesystem path.
 * Does NOT read file content or verify existence.
 */
export function resolveSkillUrl(url: string, skills: readonly Skill[]): { skill: Skill; lexicalPath: string } {
	const parsed = /^skill:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
	if (!parsed) {
		throw new ToolError(`Invalid skill:// URL: ${url}`);
	}

	let rawSkillSegment = parsed[1];
	if (!rawSkillSegment) {
		throw new ToolError(`skill:// URL requires a skill name: ${url}`);
	}
	// Decode percent-encoded colons (%3A) used for namespaced skill names
	try {
		rawSkillSegment = decodeURIComponent(rawSkillSegment);
	} catch {
		// Leave as-is if decoding fails
	}

	// Resolve skill name by longest-prefix match against registered skills.
	// This handles namespaced skills ("plugin:skill") where the URI may also
	// carry a colon-delimited suffix (e.g., ":1-5" line range).
	const { skill, suffix } = matchSkillName(rawSkillSegment, skills);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new ToolError(`Unknown skill: ${rawSkillSegment}. Available: ${availableStr}`);
	}

	// Combine any colon suffix (line range like ":1-5") with the path segment
	const rawPath = (parsed[2] ?? "") + (suffix ? `/${suffix}` : "");
	const hasRelativePath = rawPath !== "" && rawPath !== "/";

	if (!hasRelativePath) {
		return { skill, lexicalPath: path.resolve(skill.filePath) };
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPath.slice(1));
	} catch {
		throw new ToolError(`Invalid skill:// URL path encoding: ${url}`);
	}
	try {
		validateRelativePath(relativePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(message);
	}

	const targetPath = path.join(skill.baseDir, relativePath);
	const resolvedPath = path.resolve(targetPath);
	const resolvedBaseDir = path.resolve(skill.baseDir);
	if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
		throw new ToolError("Path traversal is not allowed in skill:// URLs");
	}

	return { skill, lexicalPath: resolvedPath };
}

export function resolveSkillUrlToPath(url: string, skills: readonly Skill[]): string {
	return resolveSkillUrl(url, skills).lexicalPath;
}

/**
 * Match a raw skill segment against registered skills using longest-prefix match.
 * Handles colons in both skill names (namespacing) and suffixes (line ranges).
 *
 * For "superpowers:brainstorming:1-5" with skill "superpowers:brainstorming":
 *   -> skill = superpowers:brainstorming, suffix = "1-5"
 * For "brainstorming" with skill "brainstorming":
 *   -> skill = brainstorming, suffix = undefined
 */
function matchSkillName(
	rawSegment: string,
	skills: readonly Skill[],
): { skill: Skill | undefined; suffix: string | undefined } {
	// Exact match first (most common case)
	const exact = skills.find(s => s.name === rawSegment);
	if (exact) return { skill: exact, suffix: undefined };

	// Try stripping colon-delimited suffixes from the right
	let candidate = rawSegment;
	while (true) {
		const lastColon = candidate.lastIndexOf(":");
		if (lastColon <= 0) break;
		candidate = candidate.slice(0, lastColon);
		const match = skills.find(s => s.name === candidate);
		if (match) {
			const suffix = rawSegment.slice(lastColon + 1);
			return { skill: match, suffix };
		}
	}

	return { skill: undefined, suffix: undefined };
}

function localPathEscapes(realRoot: string, candidate: string): boolean {
	return candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`);
}

async function canonicalLocalPath(localRoot: string, lexicalPath: string): Promise<string> {
	const realRoot = await fs.realpath(localRoot);
	try {
		const realTarget = await fs.realpath(lexicalPath);
		if (localPathEscapes(realRoot, realTarget)) {
			throw new ToolError("local:// path escapes the session local root");
		}
		return realTarget;
	} catch (error) {
		if (error instanceof ToolError || !isEnoent(error)) throw error;
	}

	const missing: string[] = [];
	let cursor = lexicalPath;
	for (;;) {
		let stat: fsTypes.Stats | undefined;
		try {
			stat = await fs.lstat(cursor);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (stat) {
			let realAncestor: string;
			try {
				realAncestor = await fs.realpath(cursor);
			} catch (error) {
				if (isEnoent(error)) throw new ToolError("local:// path escapes the session local root");
				throw error;
			}
			const canonical = path.join(realAncestor, ...missing);
			if (localPathEscapes(realRoot, canonical)) {
				throw new ToolError("local:// path escapes the session local root");
			}
			return canonical;
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new ToolError("local:// path escapes the session local root");
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

const SKILL_ESCAPE = "Path traversal is not allowed in skill:// URLs";

/**
 * Real path of `target`, or the real ancestor plus the missing suffix.
 * Any filesystem failure is reported as `escapeMessage` so a foreign pathname
 * never reaches the caller through an operating-system error.
 */
async function canonicalPathOrAncestor(target: string, escapeMessage: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch (error) {
		if (!isEnoent(error)) throw new ToolError(escapeMessage);
	}

	const missing: string[] = [];
	let cursor = target;
	for (;;) {
		let stat: fsTypes.Stats | undefined;
		try {
			stat = await fs.lstat(cursor);
		} catch (error) {
			if (!isEnoent(error)) throw new ToolError(escapeMessage);
		}
		if (stat) {
			try {
				return path.join(await fs.realpath(cursor), ...missing);
			} catch {
				throw new ToolError(escapeMessage);
			}
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new ToolError(escapeMessage);
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

/**
 * Keep the lexical skill path, then bind the shell to the real path inside the skill directory.
 * A missing file under a real in-skill ancestor still expands.
 */
async function canonicalSkillExpansionPath(baseDir: string, lexicalPath: string): Promise<string> {
	const realBase = await canonicalPathOrAncestor(baseDir, SKILL_ESCAPE);
	const realTarget = await canonicalPathOrAncestor(lexicalPath, SKILL_ESCAPE);
	if (localPathEscapes(realBase, realTarget)) {
		throw new ToolError(SKILL_ESCAPE);
	}
	return realTarget;
}

function extractScheme(url: string): SupportedInternalScheme | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (!match) return undefined;
	const scheme = match[1].toLowerCase();
	if (!SUPPORTED_INTERNAL_SCHEMES.includes(scheme as SupportedInternalScheme)) return undefined;
	return scheme as SupportedInternalScheme;
}

/**
 * Shell quote state at `index`: the quote syntax still open, or undefined.
 * A URL matched inside an open quote is spliced into an argument the caller
 * already quoted, so replacing it with a separately quoted path would end that
 * quote early and expose any shell syntax in the replacement path.
 * `$'...'` is tracked separately because there a backslash escapes `'`.
 */
function enclosingQuote(command: string, index: number): "'" | '"' | "ansi-c" | undefined {
	let quote: "'" | '"' | "ansi-c" | undefined;
	for (let i = 0; i < index; i++) {
		const character = command[i];
		if (quote === "ansi-c") {
			if (character === "\\") i++;
			else if (character === "'") quote = undefined;
			continue;
		}
		if (quote === "'") {
			if (character === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (character === "\\") i++;
			else if (character === '"') quote = undefined;
			continue;
		}
		if (character === "\\") i++;
		else if (character === "$" && command[i + 1] === "'") {
			quote = "ansi-c";
			i++;
		} else if (character === "'" || character === '"') quote = character;
	}
	return quote;
}

/**
 * True when the character immediately before a URL token changes how the
 * replacement's leading quote is read: an adjacent `$` turns it into ANSI-C or
 * locale quoting, and an odd backslash run escapes it. Both would run the
 * replacement path outside the single-quoted segment added by shellEscape.
 */
function unsafeExpansionPrefix(command: string, index: number): boolean {
	if (index === 0) return false;
	const preceding = command[index - 1];
	if (preceding === "$") {
		let escapedBy = 0;
		for (let i = index - 2; i >= 0 && command[i] === "\\"; i--) escapedBy++;
		if (escapedBy % 2 === 0) return true;
	}
	let backslashes = 0;
	for (let i = index - 1; i >= 0 && command[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 1;
}

/**
 * Shell contexts that expand text again after this substitution: command
 * substitution, backticks, heredoc bodies, parameter/arithmetic expansion,
 * arithmetic commands, and bracket subscripts. In those contexts the single
 * quotes added by `shellEscape` are not quoting, so a canonical path carrying
 * shell syntax could run. Multi-line commands are refused for the same reason:
 * comment and heredoc membership starts at line structure a flat scan cannot
 * model.
 */
function hasNestedExpansionContext(command: string): boolean {
	return (
		command.includes("\n") ||
		command.includes("\r") ||
		command.includes("`") ||
		command.includes("((") ||
		command.includes("[") ||
		command.includes("]") ||
		/(?:^|[\s;&|])let(?:\s|$)/.test(command) ||
		/\$[([{]|\$['"]/.test(command) ||
		/(?:^|[^<])<<(?![<])/.test(command)
	);
}

/**
 * Shell builtins that read the substituted text again: `eval` re-parses its
 * argument list as command text, so the single quotes this module adds survive
 * the command's first parse but not that second one. `source`/`.` take an
 * already-parsed filename operand -- the shell resolves it once and the builtin
 * parses the file's *contents*, not the operand -- so refusing them here is a
 * conservative policy margin, not a claim that the operand is re-parsed.
 * Quote and escape characters are removed before matching so `e'val'` reads as
 * the builtin it becomes. A match anywhere is deliberate: `command eval`,
 * `builtin eval`, a later pipeline segment, and `xargs eval` all reach the same
 * builtin, and refusing a command that merely mentions the word is the
 * fail-closed direction. A literal assignment such as `x=eval` is included:
 * `$x` reaches the builtin, and refusing the spelling is cheaper than proving
 * the indirection safe.
 * The trailing boundary includes the redirection operators: bash also ends a
 * command word at `<`/`>`, so `eval>out cat path` still passes `path` to
 * `eval`, which re-parses it.
 */
const REPARSING_SHELL_BUILTIN = /(?:^|[\s;&|()`=])(?:eval|source|\.)(?=[\s;&|()<>]|$)/;

/**
 * Shell words whose `-c` argument is parsed as a script by a child shell. A
 * substitution inside that word is unquoted by the outer shell and re-read by
 * the child, so the single quotes this module adds do not protect it.
 */
const SCRIPT_SHELL_NAMES = new Set(["sh", "bash", "dash", "ksh", "zsh", "ash", "mksh", "pdksh"]);

interface ShellWordSpan {
	start: number;
	end: number;
	value: string;
}

/**
 * Split command text into shell words with their source spans. Quotes and
 * escapes are resolved into `value`; operators and whitespace end a word.
 * This is a locator, not a shell parser: it only has to find which source word
 * holds a substitution, so ambiguous syntax falls back to the wider span.
 */
function shellWordSpans(command: string): ShellWordSpan[] {
	const words: ShellWordSpan[] = [];
	let value = "";
	let start = -1;
	let i = 0;
	const flush = (end: number) => {
		if (start >= 0) words.push({ start, end, value });
		start = -1;
		value = "";
	};
	while (i < command.length) {
		const character = command[i];
		if (character === "'") {
			if (start < 0) start = i;
			let j = i + 1;
			while (j < command.length && command[j] !== "'") j++;
			value += command.slice(i + 1, j);
			i = Math.min(j + 1, command.length);
			continue;
		}
		if (character === '"') {
			if (start < 0) start = i;
			let j = i + 1;
			while (j < command.length && command[j] !== '"') {
				if (command[j] === "\\") j++;
				j++;
			}
			value += command.slice(i + 1, Math.min(j, command.length));
			i = Math.min(j + 1, command.length);
			continue;
		}
		if (character === "\\") {
			if (start < 0) start = i;
			value += command[i + 1] ?? "";
			i += 2;
			continue;
		}
		if (/\s/.test(character) || ";&|()<>".includes(character)) {
			flush(i);
			i++;
			continue;
		}
		if (start < 0) start = i;
		value += character;
		i++;
	}
	flush(command.length);
	return words;
}

/**
 * Source span of every command word a child shell will parse as its `-c`
 * script, e.g. `sh -ec '...'`, `/bin/bash --norc -c ...`, `busybox sh -c ...`.
 * The script is the first operand after the flag cluster that contains `c`;
 * `-o NAME` consumes its operand before that scan continues.
 */
function shellScriptWordSpans(command: string): Array<[number, number]> {
	const words = shellWordSpans(command);
	const spans: Array<[number, number]> = [];
	for (let i = 0; i < words.length; i++) {
		const name = words[i].value.split(/[\\/]/).pop() ?? "";
		if (!SCRIPT_SHELL_NAMES.has(name)) continue;
		let scripted = false;
		let j = i + 1;
		while (j < words.length) {
			const word = words[j].value;
			if (word.startsWith("--")) {
				j++;
				continue;
			}
			if (!word.startsWith("-") || word === "-") break;
			const flags = word.slice(1);
			const scriptFlag = flags.indexOf("c");
			if (scriptFlag >= 0) {
				if (scriptFlag < flags.length - 1) {
					// `-c'cat 'path`: the script is attached to the same argument,
					// so its span starts after the `c` and ends with the word.
					spans.push([words[j].start + 1 + scriptFlag + 1, words[j].end]);
				} else {
					scripted = true;
					j++;
				}
				break;
			}
			j += flags.endsWith("o") ? 2 : 1;
		}
		if (scripted && j < words.length) spans.push([words[j].start, words[j].end]);
	}
	return spans;
}

function hasReparsingShellCommand(command: string): boolean {
	return REPARSING_SHELL_BUILTIN.test(command.replace(/['"\\]/g, ""));
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

const SESSION_URL_ESCAPE = "URL is outside this session and cannot be expanded in a bash command";

/**
 * Named in every rule-URL refusal so a model retries with the reader instead of
 * guessing more shell spellings.
 */
const RULE_READ_ALTERNATIVE = "Read the rule directly instead: read <rule-url>.";

/**
 * Case-exact prefix rule for Windows spellings. `path.relative` answers `""` for a
 * case-variant spelling of the root as well, so the comparison is made on the
 * resolved spellings directly. Both arguments must be absolute and resolved.
 * Exported because a POSIX host cannot exercise the platform branch of
 * {@link pathStaysInside} that depends on it.
 */
export function windowsPathIsInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith("\\") ? root : `${root}\\`);
}

/**
 * True when `candidate` is `root` or below it. Windows resolves `path.relative`
 * without regard to case, so a case-variant sibling directory such as
 * `C:\work\proj` counts as inside `C:\work\Proj` — and answers `""` for a
 * case-variant spelling of the root itself — even on a volume or directory that
 * is case-sensitive. Every caller here compares two canonical paths or two paths
 * derived from one spelling, so on Windows the shared prefix has to match
 * exactly as well: a case-insensitive volume canonicalizes both sides to one
 * spelling, and a case-sensitive one keeps their real spellings apart.
 */
function pathStaysInside(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	const relative = path.relative(resolvedRoot, resolvedCandidate);
	if (relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
		return false;
	}
	return process.platform !== "win32" || windowsPathIsInside(resolvedRoot, resolvedCandidate);
}

/**
 * True when `candidate` is spelled inside `root`, folding case. This answers
 * provenance — was the request written under the configured directory — and
 * never identity: discovery stores the configured prefix, the same directory's
 * real path can carry other casing, and a case-insensitive volume resolves the
 * two spellings to one directory. Containment decisions use
 * {@link pathStaysInside} on the verified on-disk root instead, which is exact
 * wherever the path namespace is exact.
 */
function pathSpelledInside(root: string, candidate: string): boolean {
	const foldedRoot = path.resolve(root).toLowerCase();
	const foldedCandidate = path.resolve(candidate).toLowerCase();
	const relative = path.relative(foldedRoot, foldedCandidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isStrictlyInside(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	return pathStaysInside(resolvedRoot, resolvedCandidate) && resolvedCandidate !== resolvedRoot;
}

const PROJECT_RULE_DIR_NAMES = [".agent", ".agents"] as const;

/**
 * On-disk spelling of `target` when every component below `base` is a real
 * directory, or `undefined` when one is missing or is a link (junction).
 *
 * `base` must already be the canonical directory the caller authorized: it is
 * not resolved again, so the walk cannot start from a different root than the
 * one the caller checked. A caller whose base may be a link (the trusted home
 * often is) resolves it once before calling.
 *
 * The configured spelling decides which directory is meant. On a
 * case-insensitive volume `lstat` resolves `.agent` to the `.AGENT` entry the
 * user created and `realpath` then reports that on-disk case, so a real
 * directory is still matched; on a case-sensitive volume an absent `.agent`
 * stays absent instead of being promoted from a case-variant sibling that
 * discovery would never treat as the configured rules directory. `realpath` is
 * only taken after `lstat` proved the component is not a link, because a linked
 * rule directory must not become the trust root.
 */
async function unlinkedDirectorySpelling(base: string, target: string): Promise<string | undefined> {
	const resolvedBase = path.resolve(base);
	const relative = path.relative(resolvedBase, path.resolve(target));
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return undefined;
	}
	let current = resolvedBase;
	for (const part of relative.split(path.sep)) {
		const requested = path.join(current, part);
		let entry: fsTypes.Stats;
		try {
			entry = await fs.lstat(requested);
		} catch {
			return undefined;
		}
		if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
		let resolved: string;
		let settled: fsTypes.Stats;
		try {
			resolved = await fs.realpath(requested);
			settled = await fs.stat(resolved);
		} catch {
			return undefined;
		}
		// The recovered name has to be a direct child of the directory already
		// verified for it and may differ from the requested name only by case, so a
		// link swapped in between the calls cannot move the boundary elsewhere.
		if (path.dirname(resolved) !== current) return undefined;
		const name = path.basename(resolved);
		if (name.toLowerCase() !== part.toLowerCase()) return undefined;
		// Identity supplements the location check: a rename keeps the inode but not
		// the parent, and a replacement keeps neither.
		if (!settled.isDirectory() || settled.dev !== entry.dev || settled.ino !== entry.ino) return undefined;
		current = path.join(current, name);
	}
	return current;
}

/**
 * Real path of a rule file in an ancestor `.agent/rules` or `.agents/rules` directory
 * under the trusted home. Non-Git discovery loads those directories and skips home.
 * Ancestors are matched by physical identity so a trusted home reached through a
 * symlink still matches the project tree spelled with either path.
 */
async function discoveredAncestorRulePath(sessionCwd: string, sourcePath: string): Promise<string | undefined> {
	const lexicalCwd = path.resolve(sessionCwd);
	const lexicalHome = path.resolve(getTrustedHomeDir());
	const canonicalHome = await canonicalPathOrAncestor(lexicalHome, SESSION_URL_ESCAPE);
	const canonicalCwd = await canonicalPathOrAncestor(lexicalCwd, SESSION_URL_ESCAPE);
	if (!isStrictlyInside(canonicalHome, canonicalCwd)) return undefined;

	const lexical = path.resolve(sourcePath);
	const realTarget = await canonicalPathOrAncestor(lexical, SESSION_URL_ESCAPE);

	// Walk the session's lexical ancestors, keeping the lexical spelling used by
	// discovery alongside the physical identity used for containment.
	const ancestors: { lexical: string; canonical: string }[] = [];
	let lexicalAncestor = path.dirname(lexicalCwd);
	for (;;) {
		const canonicalAncestor = await canonicalPathOrAncestor(lexicalAncestor, SESSION_URL_ESCAPE);
		if (!isStrictlyInside(canonicalHome, canonicalAncestor)) break;
		ancestors.push({ lexical: lexicalAncestor, canonical: canonicalAncestor });
		const parent = path.dirname(lexicalAncestor);
		if (parent === lexicalAncestor) break;
		lexicalAncestor = parent;
	}

	for (const ancestor of ancestors) {
		for (const dirName of PROJECT_RULE_DIR_NAMES) {
			const lexicalRuleDir = path.join(ancestor.lexical, dirName, "rules");
			const canonicalRuleDir = path.join(ancestor.canonical, dirName, "rules");
			// The names above are synthesized, and a linked rules directory must not
			// widen the boundary to its target, so the boundary is the on-disk
			// spelling of a directory reached without following a link.
			const ruleDir = await unlinkedDirectorySpelling(ancestor.canonical, canonicalRuleDir);
			if (ruleDir === undefined) continue;
			if (!pathSpelledInside(lexicalRuleDir, lexical) && !pathSpelledInside(ruleDir, lexical)) continue;
			if (pathStaysInside(ruleDir, realTarget)) return realTarget;
		}
	}
	return undefined;
}

/**
 * Real path of a user rule among the requesting session's rules that stays
 * inside the trusted home `.agent/rules` or `.agents/rules` directory. Other
 * user-rule roots stay out.
 */
async function discoveredUserRulePath(rules: readonly Rule[], sourcePath: string): Promise<string | undefined> {
	const home = path.resolve(getTrustedHomeDir());
	let canonicalHome = home;
	try {
		canonicalHome = await fs.realpath(home);
	} catch {
		// The configured spelling stands when the home cannot be resolved.
	}
	const lexical = path.resolve(sourcePath);
	const realTarget = await canonicalPathOrAncestor(lexical, SESSION_URL_ESCAPE);
	for (const rule of rules) {
		if (rule._source.level !== "user") continue;
		const ruleLexical = path.resolve(rule.path);
		let realRule: string;
		try {
			realRule = await fs.realpath(ruleLexical);
		} catch {
			// A stale or inaccessible unrelated rule must not block a healthy one.
			continue;
		}
		if (realRule !== realTarget) continue;
		for (const dirName of PROJECT_RULE_DIR_NAMES) {
			const ruleRoot = path.join(home, dirName, "rules");
			// An unlinked rules directory is its own on-disk spelling, so a real
			// directory the user created with other casing still matches without
			// promoting a case-variant sibling that discovery never loaded.
			const unlinkedRoot = await unlinkedDirectorySpelling(
				canonicalHome,
				path.join(canonicalHome, dirName, "rules"),
			);
			if (unlinkedRoot !== undefined) {
				// Provenance accepts either spelling discovery may have stored: the
				// configured home, or the canonical home a caller supplied. The
				// directory's on-disk spelling may also differ in case, or the trusted
				// home may be reached through a link, so these gates fold case.
				const underConfigured = (candidate: string) =>
					pathSpelledInside(ruleRoot, candidate) || pathSpelledInside(unlinkedRoot, candidate);
				if (!underConfigured(lexical) || !underConfigured(ruleLexical)) continue;
				if (pathStaysInside(unlinkedRoot, realTarget)) return realTarget;
				continue;
			}
			// A linked rules directory keeps the documented behavior: the link is the
			// trust anchor for the request's spelling, its target for containment.
			// The anchor keeps the synthesized `.agent`/`rules` names under either home
			// spelling discovery may have stored; the link target is never provenance,
			// so a request spelled at a case-variant target does not count as the link.
			const anchorSuffix = `${path.sep}${dirName}${path.sep}rules`;
			const spelledUnderLink = (candidate: string) => {
				const resolved = path.resolve(candidate);
				for (const homeSpelling of [home, canonicalHome]) {
					if (resolved.length <= homeSpelling.length) continue;
					if (resolved.slice(0, homeSpelling.length).toLowerCase() !== homeSpelling.toLowerCase()) continue;
					const remainder = resolved.slice(homeSpelling.length);
					if (remainder === anchorSuffix || remainder.startsWith(`${anchorSuffix}${path.sep}`)) return true;
				}
				return false;
			};
			if (!spelledUnderLink(lexical) || !spelledUnderLink(ruleLexical)) continue;
			let linkedRoot: string;
			try {
				linkedRoot = await fs.realpath(ruleRoot);
			} catch {
				continue;
			}
			if (pathStaysInside(linkedRoot, realTarget)) return realTarget;
		}
	}
	return undefined;
}

/**
 * Drop the whole `Available:` tail, not just its first line: rule names derive
 * from filenames, and a name containing a newline would otherwise leave its
 * remaining fragments in the diagnostic.
 */
function withoutForeignRuleNames(message: string): string {
	const lines = message.split(/\r?\n/);
	const availableIndex = lines.findIndex(line => line.startsWith("Available:"));
	const kept = availableIndex === -1 ? lines : lines.slice(0, availableIndex);
	return kept.join("\n").trim();
}

/** Real path of `lexicalPath` when it stays inside `root`; otherwise undefined. */
async function containedExpansionPath(root: string, lexicalPath: string): Promise<string | undefined> {
	const resolvedRoot = path.resolve(root);
	const resolvedLexical = path.resolve(lexicalPath);
	let realRoot = resolvedRoot;
	try {
		realRoot = await fs.realpath(resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw new ToolError(SESSION_URL_ESCAPE);
	}
	const realTarget = await canonicalPathOrAncestor(resolvedLexical, SESSION_URL_ESCAPE);
	if (!pathStaysInside(realRoot, realTarget)) return undefined;
	return realTarget;
}

async function sessionScopedRulePath(
	sourcePath: string,
	sessionCwd: string,
	sessionAgentDir: string | undefined,
	sessionRules: readonly Rule[],
	reparsedByShell: boolean,
): Promise<string> {
	const agentDir = sessionAgentDir?.trim() ? sessionAgentDir : getAgentDir();
	const repoRoot = await findRepoRoot(sessionCwd);
	for (const root of [repoRoot ?? path.resolve(sessionCwd), path.resolve(agentDir)]) {
		const contained = await containedExpansionPath(root, sourcePath);
		if (contained) return refuseShellBearingRulePath(contained, reparsedByShell);
	}
	const userRule = await discoveredUserRulePath(sessionRules, sourcePath);
	if (userRule) return refuseShellBearingRulePath(userRule, reparsedByShell);
	if (!repoRoot) {
		const ancestorRule = await discoveredAncestorRulePath(sessionCwd, sourcePath);
		if (ancestorRule) return refuseShellBearingRulePath(ancestorRule, reparsedByShell);
	}
	throw new ToolError(`rule:// ${SESSION_URL_ESCAPE}.`);
}

/**
 * A canonical path carrying shell syntax can change the command that re-reads
 * the substituted text (arithmetic, heredocs, `eval`, `source`). Refuse it
 * fail-closed instead of trying to enumerate every such context.
 * A backslash is the shell's escape character, so it stays in this set: it is
 * only accepted after the separator normalization below has removed it.
 */
const RULE_PATH_SHELL_SYNTAX = /[$`;&|<>()'"\\\n\r]/;

/**
 * Characters a second shell parse expands or splits instead of reading
 * literally: pathname-glob metacharacters, tilde, and whitespace. The
 * substitution is single-quoted, so a command parsed once keeps them literal;
 * only a command that re-parses the text can turn one into a selection outside
 * the authorized root or split the path into different words. POSIX filenames
 * may legitimately contain `*`, `?`, `[`, `]`, `{`, and `}` (and this module
 * must not disable such a project), so they are refused only in that
 * second-parse context. Rule paths here are canonical and therefore absolute,
 * which leaves `~` no legitimate role in one.
 */
const RULE_PATH_REPARSED_SYNTAX = /[*?[\]{}~\s]/;

/**
 * A drive-qualified Windows path. NTFS forbids `\` inside a name, so in such a
 * path every backslash is a separator and the forward-slash spelling names the
 * same file. The bash-compatible shell the bash tool runs on Windows reads `\`
 * as an escape, so the forward-slash spelling is the only one that is both the
 * intended file and free of shell syntax.
 * UNC paths (`\\server\share\...`) are deliberately not rewritten: their
 * `//server/share` spelling is not reliably accepted by every Windows shell, so
 * they stay refused instead of guessed at.
 */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Spelling of a Windows path for a data value: `/` names the same file and needs
 * no escaping inside a quoted value, unlike the `\` the shell spelling uses.
 * Exported because a POSIX host cannot produce a drive-qualified path.
 */
export function windowsDataValueSpelling(resolvedPath: string): string {
	return WINDOWS_DRIVE_PATH.test(resolvedPath) ? resolvedPath.replaceAll("\\", "/") : resolvedPath;
}

/**
 * Return `resolvedPath` in the form the bash tool's shell reads as that same
 * file, or refuse it when shell syntax survives that form.
 * `reparsedByShell` marks a command whose builtin reads the substituted text
 * again (`eval`, `source`, `.`). A path that is safe in one parse is not
 * necessarily safe in two, so the glob/tilde/whitespace refusal applies only
 * then; see {@link RULE_PATH_REPARSED_SYNTAX}.
 */
export function refuseShellBearingRulePath(resolvedPath: string, reparsedByShell = false): string {
	const shellPath = WINDOWS_DRIVE_PATH.test(resolvedPath) ? resolvedPath.replaceAll("\\", "/") : resolvedPath;
	if (RULE_PATH_SHELL_SYNTAX.test(shellPath)) {
		throw new ToolError(
			`rule:// URL resolved to a path containing shell syntax and cannot be expanded in a bash command. ${RULE_READ_ALTERNATIVE}`,
		);
	}
	if (reparsedByShell && RULE_PATH_REPARSED_SYNTAX.test(shellPath)) {
		throw new ToolError(
			`rule:// URL resolved to a path containing a glob, tilde, or whitespace metacharacter and cannot be expanded in a command that may re-read the substituted text (eval, source, or .). ${RULE_READ_ALTERNATIVE}`,
		);
	}
	return shellPath;
}

async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[],
	internalRouter?: InternalUrlResolver,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
	sessionCwd?: string,
	sessionAgentDir?: string,
	enclosedInQuote = false,
	sessionRules?: readonly Rule[],
	reparsedByShell = false,
): Promise<string> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = extractScheme(url);
	if (!scheme) {
		throw new ToolError(`Unsupported internal URL in bash command: ${url}`);
	}

	if (scheme === "skill") {
		const { skill, lexicalPath } = resolveSkillUrl(url, skills);
		return canonicalSkillExpansionPath(skill.baseDir, lexicalPath);
	}

	// Managed artifact and agent resources carry session authority. Expanding
	// either into a subprocess command would let that subprocess reopen, replace,
	// or unlink the managed object by pathname. Keep those resources behind the
	// internal reader boundary.
	if (scheme === "artifact" || scheme === "agent") {
		throw new ToolError(
			`${scheme}:// URLs cannot be expanded in bash commands; read them through the internal reader instead.`,
		);
	}

	// The memory store folds `/`, `\`, and `:` in the project path to `-`, so
	// distinct projects (`/work/acme-api/server`, `/work/acme/api-server`) share
	// one memory root. No path check can tell which project owns a file there.
	// `memory://` is a legacy reader-only URI (docs/memory.md), so fail closed.
	if (scheme === "memory") {
		throw new ToolError(
			"memory:// URLs cannot be expanded in bash commands because the memory root is not unique per project; read them through the internal reader instead.",
		);
	}

	if (scheme === "local") {
		if (!localOptions) {
			throw new ToolError(
				"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
			);
		}
		await initializeLocalRoot(localOptions);
		const resolvedLocalPath = resolveLocalUrlToPath(url, localOptions);
		const realTarget = await canonicalLocalPath(resolveLocalRoot(localOptions), resolvedLocalPath);
		if (ensureLocalParentDirs) {
			await fs.mkdir(path.dirname(realTarget), { recursive: true });
		}
		return realTarget;
	}

	const sessionDirectoryMissing = sessionCwd === undefined || sessionCwd.trim() === "";
	if (scheme === "rule" && sessionDirectoryMissing) {
		throw new ToolError(
			`rule:// URLs cannot be expanded in bash commands without a session directory. ${RULE_READ_ALTERNATIVE}`,
		);
	}

	if (!internalRouter?.canHandle(url)) {
		throw new ToolError(
			`Cannot resolve ${scheme}:// URL in bash command: ${url}\n` +
				"Internal URL router is unavailable for this protocol in the current session.",
		);
	}

	let resource: InternalResource;
	try {
		// `rule://` resolves against the requesting session's rules. An absent list
		// becomes an empty scope, so the lookup reports the rule unknown instead of
		// reading the process-global snapshot another session installed.
		resource = await internalRouter.resolve(url, scheme === "rule" ? { rules: sessionRules ?? [] } : undefined);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(
			`Failed to resolve ${scheme}:// URL in bash command: ${url}\n${withoutForeignRuleNames(message)}`,
		);
	}

	if (!resource.sourcePath) {
		throw new ToolError(`${scheme}:// URL resolved without a filesystem path and cannot be used in bash: ${url}`);
	}

	if (scheme === "rule" && sessionCwd !== undefined) {
		if (enclosedInQuote) {
			throw new ToolError(
				`rule:// URLs must be a standalone shell argument in bash commands; a rule:// URL inside a quoted argument cannot be expanded safely. ${RULE_READ_ALTERNATIVE}`,
			);
		}
		return sessionScopedRulePath(
			resource.sourcePath,
			sessionCwd,
			sessionAgentDir,
			sessionRules ?? [],
			reparsedByShell,
		);
	}

	return path.resolve(resource.sourcePath);
}

/**
 * Expand all skill:// URIs in a bash command string.
 * Returns the command with URIs replaced by shell-escaped absolute paths.
 * Throws ToolError if any URI cannot be resolved.
 */
export function expandSkillUrls(command: string, skills: readonly Skill[]): string {
	if (skills.length === 0 || !command.includes("skill://")) {
		return command;
	}

	return command.replace(SKILL_URL_PATTERN, token => {
		const url = unquoteToken(token);
		const resolvedPath = resolveSkillUrlToPath(url, skills);
		return shellEscape(resolvedPath);
	});
}

/**
 * Characters that end a quoted value or are escape-processed inside one. A
 * resolved path carrying one of them cannot be spliced into a value the caller
 * quoted without changing the value's shape (a JSON string, for example)
 * instead of only its path. Rule paths already refuse shell syntax;
 * `skill://`, `local://`, and `plan://` paths are not guarded that way, so this
 * check is the only backstop for them.
 */
const QUOTED_VALUE_UNSAFE = /['"\\\u0000-\u001f]/;

/**
 * True when a backslash immediately before `index` escapes it (odd run). The
 * consumer reads that escape, so the text after it is not a URL there.
 */
function escapedAt(value: string, index: number): boolean {
	let count = 0;
	for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) count++;
	return count % 2 === 1;
}

/**
 * A data value's format is the caller's, not this tool's: JSON, YAML, shell
 * fragments, and prose all arrive as one opaque string, so the surrounding text
 * cannot say how a path would have to be escaped. The rule is therefore the same
 * for every insertion: a path carrying a quote, a backslash, or a control
 * character is refused instead of spliced, because only the caller knows how its
 * format would spell it.
 */
function assertPathFitsDataValue(resolvedPath: string): void {
	if (!QUOTED_VALUE_UNSAFE.test(resolvedPath)) return;
	throw new ToolError(
		"Cannot expand this URL in an env value: the resolved path contains a quote, a backslash, or a control character that the value cannot carry.",
	);
}

/**
 * Expand filesystem-safe internal URLs in `command`. `agent://`,
 * `artifact://`, and `memory://` remain internal-reader-only and are rejected
 * before resolution.
 * `rule://` expands to a session, repository, or agent-directory path, a non-Git
 * ancestor rule under the trusted home, or a discovered user rule under
 * `.agent/rules`, `.agents/rules`, or the agent directory. Lookup uses
 * `options.rules` only; a missing list is an empty scope, never the
 * process-global snapshot. A resolved rule path carrying a glob, tilde, or
 * whitespace character is refused in a command whose `eval` re-parses the
 * substituted text; `source`/`.` are refused the same way as a conservative
 * margin. A rule URL inside a shell's `-c` script word is always refused.
 * Passing `context: "data"` expands a value the shell never parses (an env
 * value) instead of command text: the same authorization applies, but the
 * quoting and nested-expansion guards, which only describe shell reading, do
 * not.
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes("://") && !command.includes("local:/")) return command;

	const matches = Array.from(command.matchAll(INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL));
	if (matches.length === 0) return command;

	const shellContext = options.context !== "data";
	let expanded = command;
	const hasRuleUrl = matches.some(match => extractScheme(normalizeLocalScheme(unquoteToken(match[0]))) === "rule");
	const nestedRuleContext = shellContext && hasRuleUrl && hasNestedExpansionContext(command);
	// `eval` re-parses the substituted text; `source`/`.` are refused the same
	// way as a conservative margin. A glob, tilde, or whitespace-bearing rule
	// path is refused only in that context.
	const reparsedRuleContext = shellContext && hasRuleUrl && hasReparsingShellCommand(command);
	// A shell's `-c` argument is a word the child parses again. The outer shell
	// joins adjacent quoted segments and strips the substitution's quotes, so a
	// rule URL anywhere inside that word must be refused outright, whatever the
	// canonical path contains.
	const shellScriptSpans = shellContext && hasRuleUrl ? shellScriptWordSpans(command) : [];
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		const rawUrl = unquoteToken(token);
		const url = normalizeLocalScheme(rawUrl);
		const quotedToken = token !== rawUrl;
		const urlStart = index + (quotedToken ? 1 : 0);
		const urlEnd = urlStart + rawUrl.length;
		// The same bytes mean different things in JSON (an escape) and in a YAML
		// literal block (data), and an env value does not say which it is, so an
		// escaped scheme is reported instead of guessed at or silently left
		// unresolved. An escaped quote is only data around the URL, not a delimiter.
		if (!shellContext && escapedAt(command, urlStart)) {
			throw new ToolError(
				"Refusing to expand this URL in an env value: it follows a backslash, which the value's format may read as an escape. Remove the backslash or make the URL the whole value.",
			);
		}
		const delimiter = quotedToken && !escapedAt(command, index) ? token[0] : undefined;
		if (extractScheme(url) === "rule" && shellScriptSpans.some(([start, end]) => index >= start && index < end)) {
			throw new ToolError(
				`rule:// URLs cannot be expanded inside a shell's -c script word, because that child shell parses the substituted text again. ${RULE_READ_ALTERNATIVE}`,
			);
		}
		if (nestedRuleContext && extractScheme(url) === "rule") {
			throw new ToolError(
				`rule:// URLs must be a standalone shell argument in bash commands; they cannot be expanded in a multi-line command or one that uses command substitution, backticks, heredocs, parameter or arithmetic expansion, or brackets. ${RULE_READ_ALTERNATIVE}`,
			);
		}
		const resolvedPath = await resolveInternalUrlToPath(
			url,
			options.skills,
			options.internalRouter,
			options.localOptions,
			options.ensureLocalParentDirs,
			options.sessionCwd,
			options.sessionAgentDir,
			shellContext && (enclosingQuote(command, index) !== undefined || unsafeExpansionPrefix(command, index)),
			options.rules,
			reparsedRuleContext,
		);
		let replacement: string;
		if (shellContext) {
			replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		} else {
			// A data value carries no shell spelling, so a Windows path uses `/`,
			// which names the same file and needs no escaping inside quotes.
			replacement = windowsDataValueSpelling(resolvedPath);
			// A value that is only a bare URL carries whatever the path holds; a value
			// that wraps the URL in its own quotes is structured text, and once the URL
			// sits inside text the caller wrote, only a path that needs no escaping by
			// any format is safe to splice.
			if (delimiter !== undefined || index !== 0 || token.length !== command.length) {
				assertPathFitsDataValue(replacement);
			}
		}
		// Command text replaces the whole token because the replacement brings its own
		// quoting. A data value keeps the delimiters the token was written with: they
		// are part of the value (`{"rule":"rule://x"}` is JSON, not shell text), and
		// the delimiter check above refused a path that could close them.
		const start = shellContext ? index : urlStart;
		const end = shellContext ? index + token.length : urlEnd;
		expanded = `${expanded.slice(0, start)}${replacement}${expanded.slice(end)}`;
	}

	return expanded;
}
