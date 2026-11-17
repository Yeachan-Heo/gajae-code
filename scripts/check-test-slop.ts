#!/usr/bin/env bun

/**
 * Guard: new and changed tests must not regrow the test-slop backlog (discussion #6286).
 *
 * Only test files (`*.test.ts` / `*.test.tsx`) that a pull request adds or changes
 * relative to the merge base are inspected, so the existing backlog never blocks
 * anyone. Rules:
 *
 * 1. FAIL an ADDED test file whose basename is issue-numbered (`issue-NNN`, `gh-NNN`)
 *    or a repro dump (`*-repro`). Fold the case into the behavior-named test file.
 *    Renaming or editing an existing file is not an addition.
 * 2. FAIL a test that reads a repository `src/**\/*.ts(x)` file as text
 *    (`readFileSync`, `readFile`, `Bun.file(...).text()`) and asserts on it. Assert
 *    behavior instead. In a changed file only reads on lines the diff adds count, so
 *    pre-existing debt in a touched file does not fail. Reviewed exceptions (real
 *    generated-source freshness checks) live in `check-test-slop-allowlist.json`.
 * 3. WARN (GitHub `::warning`, exit 0) on a new test file over 1,500 lines and on
 *    added wall-clock sleeps over 100 ms (`Bun.sleep(N)`, `sleep(N)`,
 *    `setTimeout(fn, N)`, `setTimeout(N)` from `node:timers/promises`).
 *
 * The base is resolved exactly like `ci-dev-affected.ts` (immutable PR base sha in
 * CI, `origin/dev` locally) and narrowed to its merge base with the head.
 */

import { $ } from "bun";
import * as path from "node:path";
import { resolveBaseRef } from "./ci-dev-affected";

export const MAX_NEW_TEST_LINES = 1500;
export const MAX_SLEEP_MS = 100;
const GIT_SHOW_CONCURRENCY = 16;
export const DEFAULT_ALLOWLIST_PATH = path.join(import.meta.dir, "check-test-slop-allowlist.json");

const TEST_FILE = /\.test\.tsx?$/;
const ISSUE_NUMBERED_STEM = /(?:^|[-_.])(?:issue|gh)[-_]?\d+(?:$|[-_.])/i;
const REPRO_STEM = /(?:^|[-_.])repro$/i;
const SOURCE_PATH = /(?:^|\/)src\/(?:[^/]+\/)*[^/]+\.[cm]?tsx?$/;
const ANCHOR_EXPRESSION = /import\.meta|__dirname|__filename|process\.cwd\(\)/;
const ANCHOR_IDENTIFIER = /root|repo|package|pkg|workspace/i;
const TEMPORARY = /tmp|temp(?!late)|fixture|scratch|sandbox/i;
const PATH_HELPERS = new Set(["path", "posix", "new", "URL", "fileURLToPath", "join", "resolve", "normalize", "await"]);
const REGEX_PREFIX_KEYWORDS = new Set([
	"return",
	"typeof",
	"case",
	"do",
	"else",
	"in",
	"of",
	"void",
	"yield",
	"await",
	"delete",
	"throw",
]);

export type ChangeKind = "added" | "changed";
export type Rule = "issue-numbered-name" | "source-text-assertion" | "large-new-file" | "long-sleep";

export interface TestFileChange {
	path: string;
	kind: ChangeKind;
	/** Head line numbers (1-based) the diff adds. Ignored for added files: every line counts. */
	addedLines: ReadonlySet<number>;
}

export interface Finding {
	severity: "error" | "warning";
	rule: Rule;
	file: string;
	line?: number;
	message: string;
}

export function isTestFile(file: string): boolean {
	return TEST_FILE.test(file);
}

/** `issue-123`, `gh-45`, or `*-repro` in a test file basename. */
export function isIssueNumberedTestName(file: string): boolean {
	const stem = path.posix.basename(file).replace(TEST_FILE, "");
	return ISSUE_NUMBERED_STEM.test(stem) || REPRO_STEM.test(stem);
}

interface Literal {
	start: number;
	end: number;
	value: string;
}

interface Lexed {
	/** Source with string, template, comment, and regex bodies blanked (newlines kept). */
	code: string;
	literals: Literal[];
	lineStarts: number[];
}

/**
 * Minimal TS lexer: separates code from string/template/comment/regex text so call
 * sites inside strings or comments are never mistaken for real calls.
 */
function lex(source: string): Lexed {
	const out = source.split("");
	const literals: Literal[] = [];
	const templates: { start: number; value: string; depth: number }[] = [];
	const n = source.length;
	let braceDepth = 0;
	let lastSignificant = "";
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
	};
	const scanTemplate = (from: number): number => {
		const template = templates[templates.length - 1];
		let j = from;
		while (j < n) {
			const c = source[j];
			if (c === "\\") {
				template.value += source.slice(j, j + 2);
				blank(j, j + 2);
				j += 2;
				continue;
			}
			if (c === "`") {
				templates.pop();
				literals.push({ start: template.start, end: j + 1, value: template.value });
				lastSignificant = '"';
				return j + 1;
			}
			if (c === "$" && source[j + 1] === "{") {
				template.depth = braceDepth;
				lastSignificant = "{";
				return j + 2;
			}
			template.value += c;
			blank(j, j + 1);
			j++;
		}
		templates.pop();
		return n;
	};

	let i = 0;
	while (i < n) {
		const ch = source[i];
		const next = source[i + 1];
		if (ch === "}" && templates.length > 0 && braceDepth === templates[templates.length - 1].depth) {
			i = scanTemplate(i + 1);
			continue;
		}
		if (ch === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			const stop = end < 0 ? n : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end < 0 ? n : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < n && source[j] !== ch && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
			literals.push({ start: i, end: j + 1, value: source.slice(i + 1, j) });
			blank(i + 1, j);
			lastSignificant = '"';
			i = j + 1;
			continue;
		}
		if (ch === "`") {
			templates.push({ start: i, value: "", depth: -1 });
			i = scanTemplate(i + 1);
			continue;
		}
		if (ch === "/" && (lastSignificant === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSignificant) || REGEX_PREFIX_KEYWORDS.has(lastSignificant))) {
			let j = i + 1;
			let inClass = false;
			while (j < n && source[j] !== "\n") {
				const c = source[j];
				if (c === "\\") {
					j += 2;
					continue;
				}
				if (c === "[") inClass = true;
				else if (c === "]") inClass = false;
				else if (c === "/" && !inClass) break;
				j++;
			}
			blank(i + 1, j);
			lastSignificant = '"';
			i = j + 1;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < n && /[\w$]/.test(source[j])) j++;
			lastSignificant = source.slice(i, j);
			i = j;
			continue;
		}
		if (ch === "{") braceDepth++;
		else if (ch === "}") braceDepth--;
		if (!/\s/.test(ch)) lastSignificant = ch;
		i++;
	}

	const lineStarts = [0];
	for (let k = 0; k < n; k++) if (source[k] === "\n") lineStarts.push(k + 1);
	return { code: out.join(""), literals, lineStarts };
}

/** The nearest non-whitespace code character before `index`, or "". */
function previousCodeChar(code: string, index: number): string {
	for (let k = index - 1; k >= 0; k--) if (!/\s/.test(code[k])) return code[k];
	return "";
}

/** The nearest non-whitespace code character at or after `index`, or "". */
function nextCodeChar(code: string, index: number): string {
	for (let k = index; k < code.length; k++) if (!/\s/.test(code[k])) return code[k];
	return "";
}

function lineAt(lexed: Lexed, index: number): number {
	let low = 0;
	let high = lexed.lineStarts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (lexed.lineStarts[mid] <= index) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

interface Call {
	name: string;
	start: number;
	/** Index of the closing paren. */
	close: number;
	/** [start, end) ranges of each top-level argument. */
	args: [number, number][];
}

function findCalls(lexed: Lexed): Call[] {
	const calls: Call[] = [];
	const { code } = lexed;
	const pattern = /(Bun\s*\.\s*)?(?<![\w$])(readFileSync|readFile|file|sleep|setTimeout)\s*\(/g;
	for (const match of code.matchAll(pattern)) {
		const name = match[2];
		const start = match.index + (match[1]?.length ?? 0);
		const viaBun = match[1] !== undefined;
		const isMember = !viaBun && previousCodeChar(code, match.index) === ".";
		if (name === "file" && !viaBun) continue;
		if (name === "sleep" && isMember) continue;
		const open = match.index + match[0].length - 1;
		const args: [number, number][] = [];
		let depth = 0;
		let argStart = open + 1;
		let close = -1;
		for (let k = open + 1; k < code.length; k++) {
			const c = code[k];
			if (c === "(" || c === "[" || c === "{") depth++;
			else if (c === ")" || c === "]" || c === "}") {
				if (depth === 0) {
					close = k;
					break;
				}
				depth--;
			} else if (c === "," && depth === 0) {
				args.push([argStart, k]);
				argStart = k + 1;
			}
		}
		if (close < 0) continue;
		if (code.slice(argStart, close).trim() !== "") args.push([argStart, close]);
		calls.push({ name: viaBun ? `Bun.${name}` : name, start, close, args });
	}
	return calls;
}

interface ResolvedPath {
	joined: string;
	/** Rooted at the repository rather than at a directory the test created. */
	anchored: boolean;
	/** Mentions a temp/fixture/sandbox location anywhere in its derivation. */
	temporary: boolean;
}

const DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=(?!=)/g;
const MAX_PATH_INITIALIZER_CHARS = 400;
const TEXT_ACCESS = /\s*\.\s*text\s*\(/y;

/**
 * Resolves the path a read call's argument names, following `const|let|var`
 * initializers of the identifiers it uses. Declarations are indexed once and each
 * initializer is resolved at most once per file, so large test files stay linear.
 */
class PathResolver {
	#lexed: Lexed;
	#literals: Literal[];
	#declarations = new Map<string, number[]>();
	#resolved = new Map<number, ResolvedPath>();
	#inProgress = new Set<number>();

	constructor(lexed: Lexed) {
		this.#lexed = lexed;
		this.#literals = [...lexed.literals].sort((left, right) => left.start - right.start);
		for (const match of lexed.code.matchAll(DECLARATION)) {
			const positions = this.#declarations.get(match[1]) ?? [];
			positions.push(match.index + match[0].length);
			this.#declarations.set(match[1], positions);
		}
	}

	/**
	 * Join the path-like pieces of an expression in source order and decide whether
	 * it is anchored at the repository (import.meta / __dirname / a root-ish
	 * identifier / a leading literal) rather than at a temp directory the test made.
	 */
	resolve(start: number, end: number): ResolvedPath {
		const code = this.#lexed.code;
		const parts: { at: number; kind: "literal" | "identifier"; value: string; anchored: boolean }[] = [];
		for (let k = this.#firstLiteralAtOrAfter(start); k < this.#literals.length; k++) {
			const literal = this.#literals[k];
			if (literal.start >= end) break;
			if (literal.end <= end) parts.push({ at: literal.start, kind: "literal", value: literal.value, anchored: false });
		}
		const expression = code.slice(start, end);
		let anchored = ANCHOR_EXPRESSION.test(expression);
		let temporary = TEMPORARY.test(expression);
		for (const match of expression.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) {
			const name = match[0];
			const at = start + match.index;
			if (PATH_HELPERS.has(name) || previousCodeChar(code, at) === ".") continue;
			// Callee names (`initRepo()`, `findRepoRoot()`) say nothing reliable about the path.
			if (nextCodeChar(code, at + name.length) === "(") continue;
			const initializer = this.#declarationBefore(name, at);
			const resolved = initializer === undefined ? undefined : this.#resolveInitializer(initializer);
			if (resolved) {
				temporary ||= resolved.temporary;
				const named = ANCHOR_IDENTIFIER.test(name) && !resolved.temporary;
				parts.push({ at, kind: "identifier", value: resolved.joined, anchored: resolved.anchored || named });
			} else {
				temporary ||= TEMPORARY.test(name);
				parts.push({ at, kind: "identifier", value: "", anchored: ANCHOR_IDENTIFIER.test(name) });
			}
		}
		parts.sort((left, right) => left.at - right.at);
		if (parts[0]?.kind === "literal") anchored = true;
		if (parts.some(part => part.anchored)) anchored = true;
		const joined = parts
			.map(part => part.value)
			.filter(Boolean)
			.join("/")
			.replace(/\/{2,}/g, "/");
		return { joined, anchored: anchored && !temporary, temporary };
	}

	#firstLiteralAtOrAfter(index: number): number {
		let low = 0;
		let high = this.#literals.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (this.#literals[mid].start < index) low = mid + 1;
			else high = mid;
		}
		return low;
	}

	/** Initializer start of the closest declaration before `at` (else the first one). */
	#declarationBefore(name: string, at: number): number | undefined {
		const positions = this.#declarations.get(name);
		if (!positions) return undefined;
		let chosen = positions[0];
		for (const position of positions) if (position < at) chosen = position;
		return chosen;
	}

	#resolveInitializer(start: number): ResolvedPath | undefined {
		const cached = this.#resolved.get(start);
		if (cached) return cached;
		if (this.#inProgress.has(start)) return undefined;
		const end = this.#initializerEnd(start);
		// A path expression is short; a long initializer (object, function body) is not one.
		if (end - start > MAX_PATH_INITIALIZER_CHARS) return undefined;
		this.#inProgress.add(start);
		const result = this.resolve(start, end);
		this.#inProgress.delete(start);
		this.#resolved.set(start, result);
		return result;
	}

	#initializerEnd(start: number): number {
		const code = this.#lexed.code;
		let depth = 0;
		let sawCode = false;
		for (let k = start; k < code.length; k++) {
			const c = code[k];
			if (c === "(" || c === "[" || c === "{") depth++;
			else if (c === ")" || c === "]" || c === "}") {
				if (depth === 0) return k;
				depth--;
			} else if (depth === 0 && (c === ";" || c === "," || (c === "\n" && sawCode))) {
				return k;
			}
			if (!/\s/.test(c)) sawCode = true;
		}
		return code.length;
	}
}

function readsSourceText(lexed: Lexed, resolver: PathResolver, call: Call): string | undefined {
	if (call.name !== "readFileSync" && call.name !== "readFile" && call.name !== "Bun.file") return undefined;
	if (call.name === "Bun.file") {
		TEXT_ACCESS.lastIndex = call.close + 1;
		if (!TEXT_ACCESS.test(lexed.code)) return undefined;
	}
	const first = call.args[0];
	if (!first) return undefined;
	const resolved = resolver.resolve(first[0], first[1]);
	if (!resolved.anchored || !SOURCE_PATH.test(resolved.joined)) return undefined;
	return resolved.joined;
}

function sleepDelay(source: string, call: Call): number | undefined {
	let arg: [number, number] | undefined;
	if (call.name === "setTimeout") arg = call.args.length >= 2 ? call.args[1] : call.args[0];
	else if (call.name === "sleep" || call.name === "Bun.sleep") arg = call.args[0];
	if (!arg) return undefined;
	const text = source.slice(arg[0], arg[1]).trim();
	if (!/^\d[\d_]*(?:\.\d+)?(?:e\d+)?$/i.test(text)) return undefined;
	return Number(text.replace(/_/g, ""));
}

/** Apply every rule to one added or changed test file. */
export function analyzeTestFile(change: TestFileChange, source: string, allowlist: ReadonlySet<string>): Finding[] {
	const findings: Finding[] = [];
	const touches = (from: number, to: number) => {
		if (change.kind === "added") return true;
		for (let line = from; line <= to; line++) if (change.addedLines.has(line)) return true;
		return false;
	};

	if (change.kind === "added" && isIssueNumberedTestName(change.path)) {
		findings.push({
			severity: "error",
			rule: "issue-numbered-name",
			file: change.path,
			message:
				"New test file is named after an issue or repro (issue-NNN / gh-NNN / *-repro). Fold the case into the behavior-named test file for the module it covers.",
		});
	}

	if (change.kind === "added") {
		const lines = source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
		if (lines > MAX_NEW_TEST_LINES) {
			findings.push({
				severity: "warning",
				rule: "large-new-file",
				file: change.path,
				message: `New test file has ${lines} lines (over ${MAX_NEW_TEST_LINES}). Consider splitting it by behavior or extending an existing file.`,
			});
		}
	}

	const lexed = lex(source);
	const resolver = new PathResolver(lexed);
	const asserts = /\bexpect\s*\(/.test(lexed.code);
	for (const call of findCalls(lexed)) {
		const from = lineAt(lexed, call.start);
		const to = lineAt(lexed, call.close);
		if (!touches(from, to)) continue;
		const sourcePath = asserts && !allowlist.has(change.path) ? readsSourceText(lexed, resolver, call) : undefined;
		if (sourcePath !== undefined) {
			findings.push({
				severity: "error",
				rule: "source-text-assertion",
				file: change.path,
				line: from,
				message: `Test reads source file '${sourcePath}' as text to assert on it. Assert observable behavior instead; a real generated-source freshness check needs a reviewed entry in scripts/check-test-slop-allowlist.json.`,
			});
		}
		const delay = sleepDelay(source, call);
		if (delay !== undefined && delay > MAX_SLEEP_MS) {
			findings.push({
				severity: "warning",
				rule: "long-sleep",
				file: change.path,
				line: from,
				message: `Wall-clock wait of ${delay} ms (over ${MAX_SLEEP_MS} ms) in ${call.name}(). Wait on the condition or event instead of sleeping.`,
			});
		}
	}
	return findings;
}

/** Parse `git diff --name-status -z -M` output into added/changed test files. */
function parseNameStatus(output: string): { path: string; kind: ChangeKind; previousPath?: string }[] {
	const fields = output.split("\0");
	const entries: { path: string; kind: ChangeKind; previousPath?: string }[] = [];
	for (let k = 0; k < fields.length; ) {
		const status = fields[k++];
		if (!status) continue;
		const letter = status[0];
		if (letter === "R") {
			const previousPath = fields[k++];
			const file = fields[k++];
			// A rename keeps the old file's history: it is a change, never an addition.
			if (isTestFile(file)) entries.push({ path: file, kind: "changed", previousPath });
			continue;
		}
		const file = fields[k++];
		if (!isTestFile(file)) continue;
		if (letter === "A") entries.push({ path: file, kind: "added" });
		else if (letter === "M" || letter === "T") entries.push({ path: file, kind: "changed" });
	}
	return entries;
}

/** Parse `git diff -U0` output into the head line numbers each file adds. */
function parseAddedLines(diff: string): Map<string, Set<number>> {
	const added = new Map<string, Set<number>>();
	let current: Set<number> | undefined;
	let inHeader = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHeader = true;
			current = undefined;
			continue;
		}
		if (inHeader && line.startsWith("+++ ")) {
			const target = line.slice(4);
			current = undefined;
			if (target.startsWith("b/")) {
				current = new Set();
				added.set(target.slice(2), current);
			}
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk) inHeader = false;
		if (hunk && current) {
			const first = Number(hunk[1]);
			const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			for (let n = first; n < first + count; n++) current.add(n);
		}
	}
	return added;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await $`git -c core.quotePath=false ${args}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString();
}

async function collectChanges(cwd: string, base: string, head: string): Promise<TestFileChange[]> {
	const entries = parseNameStatus(await git(cwd, ["diff", "--name-status", "-z", "-M", "--diff-filter=AMRT", base, head]));
	const changed = entries.filter(entry => entry.kind === "changed");
	let addedLines = new Map<string, Set<number>>();
	if (changed.length > 0) {
		const pathspecs = changed.flatMap(entry => (entry.previousPath ? [entry.previousPath, entry.path] : [entry.path]));
		addedLines = parseAddedLines(
			await git(cwd, ["diff", "-U0", "-M", "--no-color", "--no-ext-diff", base, head, "--", ...pathspecs]),
		);
	}
	return entries.map(entry => ({ path: entry.path, kind: entry.kind, addedLines: addedLines.get(entry.path) ?? new Set() }));
}

export async function loadAllowlist(file: string): Promise<Set<string>> {
	const parsed: unknown = await Bun.file(file).json();
	const entries = (parsed as { sourceTextReads?: unknown }).sourceTextReads;
	if (!Array.isArray(entries)) throw new Error(`${file}: expected { "sourceTextReads": [...] }`);
	const paths = new Set<string>();
	for (const entry of entries) {
		const record = entry as { path?: unknown; reason?: unknown };
		if (typeof record.path !== "string" || typeof record.reason !== "string" || record.reason.trim() === "") {
			throw new Error(`${file}: every entry needs a string "path" and a non-empty "reason"`);
		}
		paths.add(record.path);
	}
	return paths;
}

function readFlag(argv: string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	const inline = argv.find(arg => arg.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : undefined;
}

function annotation(finding: Finding): string {
	const location = finding.line === undefined ? `file=${finding.file}` : `file=${finding.file},line=${finding.line}`;
	return `::${finding.severity} ${location}::[test-slop/${finding.rule}] ${finding.message}`;
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
	const head = readFlag(argv, "head") ?? "HEAD";
	const base = readFlag(argv, "base") ?? (await resolveBaseRef());
	const mergeBase = (await git(cwd, ["merge-base", base, head])).trim();
	const allowlist = await loadAllowlist(readFlag(argv, "allowlist") ?? DEFAULT_ALLOWLIST_PATH);
	const changes = await collectChanges(cwd, mergeBase, head);
	const perFile: Finding[][] = new Array(changes.length);
	let nextIndex = 0;
	const worker = async () => {
		for (let index = nextIndex++; index < changes.length; index = nextIndex++) {
			const change = changes[index];
			perFile[index] = analyzeTestFile(change, await git(cwd, ["show", `${head}:${change.path}`]), allowlist);
		}
	};
	await Promise.all(Array.from({ length: Math.min(GIT_SHOW_CONCURRENCY, changes.length) }, worker));
	const findings = perFile.flat();
	const errors = findings.filter(finding => finding.severity === "error");
	for (const finding of findings) {
		const line = annotation(finding);
		if (finding.severity === "error") console.error(line);
		else console.log(line);
	}
	const added = changes.filter(change => change.kind === "added").length;
	console.log(
		`check-test-slop: ${changes.length} test file(s) inspected (${added} added, ${changes.length - added} changed) ` +
			`against ${mergeBase.slice(0, 12)}..${head}: ${errors.length} error(s), ${findings.length - errors.length} warning(s)`,
	);
	return errors.length > 0 ? 1 : 0;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
