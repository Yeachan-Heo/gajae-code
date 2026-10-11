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
 * Strips an unquoted trailing `# comment` from a dotenv value the way Bun's
 * dotenv loader does: an unescaped `#` starts a comment regardless of the
 * preceding character (`a#b` loads as `a`), while `#` inside quotes or after a
 * backslash escape survives. Used only by `parseEnvFile`; shell files use
 * `stripInlineShellComment`, whose POSIX rule requires whitespace before `#`.
 */
function stripInlineDotenvComment(value: string): string {
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
 * whitespace around `=` or `:`, and `#` comments after unquoted values (quotes keep
 * their `#`). Values that Bun would expand (`$VAR`, `${VAR}`, backticks,
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
		// does (`KEY=v#note` loads as `v`); quoted `#` survives.
		let value = stripInlineDotenvComment(match[2] ?? "").trim();

		// Remove surrounding quotes (" or ')
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
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
 * The line parser above strips one plain pair of quotes and an unquoted `#`
 * comment. Classification uses that same comment cut, then refuses a value
 * the line parser would not store the way Bun loaded it. Other backslashes
 * stay in the compared text. The bytes inside the quotes are not decoded.
 */
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

function rawValueDisagreesWithLineParser(raw: string): boolean {
	const trimmed = raw.trim();
	const opener = trimmed[0];
	if ((opener === '"' || opener === "'") && trimmed.length >= 2 && trimmed.endsWith(opener)) {
		const inner = trimmed.slice(1, -1);
		if (inner.includes(opener) || inner.includes("`") || inner.includes("\r") || inner.includes("\n")) return true;
		// Bun turns only `\n` and `\r` into controls inside double quotes.
		if (opener === '"' && /\\[nr]/.test(inner)) return true;
		return false;
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
export function projectEnvSnapshot(cwd = process.cwd()): ProjectEnvSnapshot {
	const nodeEnv = process.env.NODE_ENV;
	const validNodeEnv = nodeEnv && /^[A-Za-z0-9_-]+$/.test(nodeEnv) ? nodeEnv : undefined;
	const files = [
		".env",
		...(validNodeEnv ? [`.env.${validNodeEnv}`] : []),
		...(validNodeEnv !== "test" ? [".env.local"] : []),
		...(validNodeEnv ? [`.env.${validNodeEnv}.local`] : []),
	];
	const values: Record<string, string> = {};
	const dynamic = new Set<string>();
	for (const file of files) {
		const filePath = path.join(cwd, file);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const quoted = quotedDeclarationKeys(content);
		const seen = new Set<string>();
		for (const [rawKey, value] of Object.entries(parseEnvFileContent(content))) {
			const key = canonicalEnvKey(rawKey);
			seen.add(key);
			values[key] = value;
			// A quoted declaration Bun may decode differently is refused, same as `$`.
			// Unquoted values, and one plain pair of quotes, still compare by text.
			if (quoted.has(key) || /[$`]/.test(value)) dynamic.add(key);
			else dynamic.delete(key);
		}
		// The line parser drops a key when `.` cannot cross a carriage return.
		// Keep that key in the snapshot so the value Bun loaded is not an override.
		for (const key of quoted) {
			if (seen.has(key)) continue;
			values[key] = "";
			dynamic.add(key);
		}
	}
	return { values, dynamic };
}
