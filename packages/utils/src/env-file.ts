/**
 * Environment-file parsing primitives.
 *
 * Kept in a leaf module so both `env.ts` and `dirs.ts` can use them. `env.ts`
 * imports `dirs.ts`, so anything `dirs.ts` needs from the env layer has to live
 * below both of them.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeEnvValue } from "./spawn-env";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

function stripInlineShellComment(value: string): string {
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if ((char === '"' || char === "'") && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			continue;
		}
		if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
			return value.slice(0, i).trimEnd();
		}
	}
	return value.trimEnd();
}

/**
 * Strips an unquoted trailing `# comment` the way Bun's dotenv loader does.
 * Outside quotes, `#` starts a comment even after a backslash (`a\#b` loads
 * as `a\`). A backslash before a quote does not open a quoted span
 * (`a\"b#c` loads as `a\"b`). Inside quotes, a backslash skips the next byte,
 * so `#` and the closer stay in the value. Shell files use
 * `stripInlineShellComment`, whose POSIX rule requires whitespace before `#`.
 */
function stripInlineDotenvComment(value: string): string {
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		const next = value[i + 1];
		if (!quote && char === "\\" && (next === '"' || next === "'")) {
			i++;
			continue;
		}
		if (quote && char === "\\") {
			i++;
			continue;
		}
		if ((char === '"' || char === "'") && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			continue;
		}
		if (char === "#" && !quote) return value.slice(0, i).trimEnd();
	}
	return value.trimEnd();
}

/**
 * Parses simple POSIX shell environment assignments from files such as
 * ~/.zshrc without executing user shell code. Supports `export KEY=value` and
 * `KEY=value`, including single/double quoted literal values. Dynamic shell
 * expressions are intentionally ignored because evaluating startup files would
 * run arbitrary code during CLI startup.
 */
export function parseShellEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
			if (!match) continue;

			const key = match[1];
			if (!isValidEnvName(key)) continue;

			let value = stripInlineShellComment(match[2] ?? "").trim();
			if (value.endsWith(";")) value = value.slice(0, -1).trimEnd();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!isSafeEnvValue(value)) continue;
			if (/[$`]/.test(value)) continue;

			result[key] = value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	return result;
}

/**
 * Parses a .env file synchronously and extracts key-value string pairs.
 * Ignores lines that are empty or start with '#'. Trims whitespace.
 * Allows values to be quoted with single or double quotes.
 * Returns an object of key-value pairs.
 *
 * The trust guards (`trustedAgentDirOverrideFor`, `trustedConfigDirName`,
 * `filterCredentialInheritedEnv`) decide provenance by comparing
 * `process.env` against this parse, so the accepted syntax must be a superset
 * of what Bun's own dotenv loader honors in `cwd/.env`: `export KEY=value`,
 * whitespace around `=` or `:`, and `#` comments after unquoted values, including
 * a backslash before `#` (quotes keep their `#`). Values that Bun would expand
 * (`$VAR`, `${VAR}`, backticks,
 * command substitution) are kept as their literal text: the trust rule only
 * needs the parser to see the key at all, and an operator environment value
 * cannot equal attacker-written expansion text, so a literal parse stays
 * conservative.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	try {
		return parseEnvFileContent(fs.readFileSync(filePath, "utf-8"));
	} catch {
		// File doesn't exist or can't be read - return empty result
		return {};
	}
}

/** Parse dotenv content that has already been read from a trusted file. */
export function parseEnvFileContent(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		// Skip comments and blank lines
		if (!trimmed || trimmed.startsWith("#")) continue;

		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)\s*(.*)$/.exec(trimmed);
		if (!match) continue;

		const key = match[1];
		if (!isValidEnvName(key)) continue;

		// Strip an unquoted trailing `# comment` the way Bun's dotenv loader
		// does (`KEY=v#note` loads as `v`); quoted `#` survives. A quoted value
		// then ends at the first unescaped closer; Bun drops the suffix.
		let value = stripInlineDotenvComment(match[2] ?? "").trim();
		value = dotenvQuotedLiteral(value);
		if (!isSafeEnvValue(value)) continue;

		result[key] = value;
	}

	return result;
}

/**
 * What the caller's checkout declares through its dotenv files.
 *
 * `values` is the merged declaration set, later layers winning. `dynamic` holds
 * the keys whose surviving declaration is one Bun expands at load time, or whose
 * raw text is quoted in a way this line parser does not decode. Provenance
 * refuses those keys instead of comparing a value Bun may have loaded differently.
 */
export interface ProjectEnvSnapshot {
	values: Record<string, string>;
	dynamic: Set<string>;
	/** True when at least one project dotenv layer could not be read safely. */
	incomplete?: boolean;
}

export interface ProjectEnvSnapshotOptions {
	/** Maximum bytes read from each dotenv layer; unsafe files mark the snapshot incomplete. */
	maxFileBytes?: number;
}

/**
 * Windows environment variable names are case-insensitive, so a project dotenv
 * line `userprofile=...` is what `process.env.USERPROFILE` resolves to. Every
 * provenance lookup is spelled in upper case, so the snapshot must be keyed the
 * same way or the declaration is invisible to the guard while still being live
 * in the process. POSIX names are case-sensitive and must not fold.
 */
export function canonicalEnvKey(name: string): string {
	return process.platform === "win32" ? name.toUpperCase() : name;
}

/**
 * Keys whose last declaration is not safe to value-compare.
 *
 * The line parser drops the suffix after the first unescaped closing quote,
 * matching Bun, and strips an unquoted `#` comment even when a backslash
 * precedes the hash. Classification refuses a value that parser would not
 * store the way Bun loaded it. Other backslashes stay in the compared text.
 * The bytes inside the quotes are not decoded.
 */
/**
 * Keys Bun's dotenv loader accepts that are not shell identifiers. Bun loads
 * names containing `-` or `.` (e.g. `npm_config_node-options`, which npm reads as
 * `node-options`), but the line parser keeps only identifiers, so provenance
 * would never see them. They are refused as dynamic, like a dropped quoted key.
 */
function nonIdentifierDeclarationKeys(content: string): Set<string> {
	const keys = new Set<string>();
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const key = /^(?:export\s+)?([A-Za-z0-9_.-]+)\s*(?:=|:)/.exec(trimmed)?.[1];
		if (key && !isValidEnvName(key)) keys.add(canonicalEnvKey(key));
	}
	return keys;
}

function quotedDeclarationKeys(content: string): Set<string> {
	const quoted = new Set<string>();
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		// `.` stops at a carriage return, which is why the line parser drops the key.
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)\s*([\s\S]*)$/.exec(trimmed);
		const key = match?.[1];
		if (!key || !isValidEnvName(key)) continue;
		const canonical = canonicalEnvKey(key);
		const comparable = stripInlineDotenvComment(match[2] ?? "");
		if (rawValueDisagreesWithLineParser(comparable)) quoted.add(canonical);
		else quoted.delete(canonical);
	}
	return quoted;
}

/** Index of the first unescaped closer, or -1. A backslash skips the next character. */
function indexOfUnescapedCloser(value: string, opener: '"' | "'"): number {
	for (let i = 1; i < value.length; i++) {
		if (value[i] === "\\") {
			i++;
			continue;
		}
		if (value[i] === opener) return i;
	}
	return -1;
}

/**
 * Bun ends a quoted dotenv value at the first unescaped closer and drops the
 * suffix (`KEY="v" ignored` loads as `v`). Bytes inside the quotes are not decoded.
 * An unclosed value keeps the previous surrounding-pair cut.
 */
function dotenvQuotedLiteral(value: string): string {
	const opener = value[0];
	if (opener !== '"' && opener !== "'") return value;
	const closed = indexOfUnescapedCloser(value, opener);
	if (closed !== -1) return value.slice(1, closed);
	if (value.endsWith(opener)) return value.slice(1, -1);
	return value;
}

function rawValueDisagreesWithLineParser(raw: string): boolean {
	const trimmed = raw.trim();
	const opener = trimmed[0];
	if (opener === '"' || opener === "'") {
		const closed = indexOfUnescapedCloser(trimmed, opener);
		if (closed !== -1) {
			const inner = trimmed.slice(1, closed);
			if (inner.includes(opener) || inner.includes("`") || inner.includes("\r") || inner.includes("\n")) return true;
			// Bun turns only `\n` and `\r` into controls inside double quotes.
			if (opener === '"' && /\\[nr]/.test(inner)) return true;
			// Provenance trims the snapshot and compares it with Bun's untrimmed runtime value.
			if (inner !== inner.trim()) return true;
			return false;
		}
	}
	return /["'`\r]/.test(trimmed);
}

/**
 * The layered dotenv declarations Bun overlays into `process.env` for a cwd.
 *
 * Lives in this leaf module so every consumer shares ONE notion of provenance.
 * `dirs.ts` resolves the config, agent and log directories from it, and
 * `scripts/test-preload.ts` decides test isolation from it — a second, narrower
 * reader (only `cwd/.env`, its own regex, its own dynamic test) is how a
 * `GJC_LOG_DIR` declared in `.env.local` / `.env.$NODE_ENV` came to be honored
 * by the preload and then rejected in production, silently routing test log
 * records to the operator's canonical sink. This module imports only `node:fs`,
 * `node:path` and the import-free `./spawn-env`, so importing it has no side
 * effects and cannot freeze resolver state the way importing `dirs.ts` would.
 *
 * `.env.local` is deliberately skipped when `NODE_ENV === "test"`, matching the
 * convention that a local override file is not part of a test run.
 */
/** Files Bun overlays for a cwd. Unset NODE_ENV selects the development layer. */
export function projectEnvLayerFiles(nodeEnv: string | undefined): string[] {
	const validNodeEnv = nodeEnv && /^[A-Za-z0-9_-]+$/.test(nodeEnv) ? nodeEnv : undefined;
	const layer = validNodeEnv ?? (nodeEnv ? undefined : "development");
	return [
		".env",
		...(layer ? [`.env.${layer}`] : []),
		...(layer !== "test" ? [".env.local"] : []),
		...(layer ? [`.env.${layer}.local`] : []),
	];
}

function readBoundedEnvFile(filePath: string, maxFileBytes: number): { content?: string; incomplete: boolean } {
	let fileDescriptor: number | undefined;
	try {
		// Non-blocking open lets fstat reject FIFOs and device files before any read.
		fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
		const initialStat = fs.fstatSync(fileDescriptor);
		if (!initialStat.isFile() || initialStat.size > maxFileBytes) return { incomplete: true };

		const buffer = Buffer.allocUnsafe(maxFileBytes + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.byteLength) {
			const count = fs.readSync(fileDescriptor, buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
			if (count === 0) break;
			bytesRead += count;
		}
		if (bytesRead > maxFileBytes || fs.fstatSync(fileDescriptor).size > maxFileBytes) {
			return { incomplete: true };
		}
		return { content: buffer.subarray(0, bytesRead).toString("utf-8"), incomplete: false };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { incomplete: false };
		}
		return { incomplete: true };
	} finally {
		if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
	}
}

/**
 * True when Bun expands the declaration at load time.
 * A backslash before `$` is a literal dollar, the same rule as project-value
 * expansion. Any other `$`, and any backtick, is still an expansion.
 */
export function projectDeclarationIsDynamic(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === "\\" && value[index + 1] === "$") {
			index++;
			continue;
		}
		if (char === "$" || char === "`") return true;
	}
	return false;
}

/** Bun drops a backslash before `$`. Equality uses that decoded literal. */
export function decodeEscapedProjectLiteral(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		if (value[index] === "\\" && value[index + 1] === "$") {
			result += "$";
			index++;
			continue;
		}
		result += value[index] ?? "";
	}
	return result;
}

export function projectEnvSnapshot(cwd = process.cwd(), options: ProjectEnvSnapshotOptions = {}): ProjectEnvSnapshot {
	if (
		options.maxFileBytes !== undefined &&
		(!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 0)
	) {
		throw new RangeError("maxFileBytes must be a non-negative safe integer");
	}
	const files = projectEnvLayerFiles(process.env.NODE_ENV);
	const values: Record<string, string> = {};
	const dynamic = new Set<string>();
	let incomplete = false;
	for (const file of files) {
		const filePath = path.join(cwd, file);
		let content: string;
		if (options.maxFileBytes === undefined) {
			try {
				content = fs.readFileSync(filePath, "utf-8");
			} catch {
				continue;
			}
		} else {
			const boundedRead = readBoundedEnvFile(filePath, options.maxFileBytes);
			if (boundedRead.incomplete) {
				incomplete = true;
				continue;
			}
			if (boundedRead.content === undefined) continue;
			content = boundedRead.content;
		}
		const quoted = quotedDeclarationKeys(content);
		const seen = new Set<string>();
		for (const [rawKey, value] of Object.entries(parseEnvFileContent(content))) {
			const key = canonicalEnvKey(rawKey);
			seen.add(key);
			// A quoted declaration Bun may decode differently is refused, same as `$`.
			// Unquoted values, and one plain pair of quotes, still compare by text.
			// An escaped dollar is a literal. Store Bun's decoded text so equality
			// still sees the project value. A real `$` or backtick stays dynamic.
			const expands = projectDeclarationIsDynamic(value);
			values[key] = expands || quoted.has(key) ? value : decodeEscapedProjectLiteral(value);
			if (quoted.has(key) || expands) dynamic.add(key);
			else dynamic.delete(key);
		}
		// The line parser drops a key when `.` cannot cross a carriage return, or
		// when Bun accepts a non-identifier name. Keep that key in the snapshot so
		// the value Bun loaded is not an override.
		for (const key of [...quoted, ...nonIdentifierDeclarationKeys(content)]) {
			if (seen.has(key)) continue;
			values[key] = "";
			dynamic.add(key);
		}
	}
	return incomplete ? { values, dynamic, incomplete: true } : { values, dynamic };
}
