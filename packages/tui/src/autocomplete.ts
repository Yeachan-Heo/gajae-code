import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fuzzyFind } from "@gajae-code/natives";
import { getProjectDir } from "@gajae-code/utils";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function buildAutocompleteFuzzyDiscoveryProfile(
	query: string,
	basePath: string,
): {
	query: string;
	path: string;
	maxResults: number;
	hidden: boolean;
	gitignore: boolean;
	cache: boolean;
} {
	return {
		query,
		path: basePath,
		maxResults: 100,
		hidden: true,
		gitignore: true,
		cache: true,
	};
}

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || path.includes(" ");
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = options.isDirectory ? "" : '"';
	return `${openQuote}${path}${closeQuote}`;
}

/**
 * Check if query is a subsequence of target (fuzzy match).
 * "wig" matches "skill:wig" because w-i-g appear in order.
 */
function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;

	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) qi++;
	}
	return qi === query.length;
}

/**
 * Score a fuzzy match. Higher = better match.
 * Prioritizes: exact match > starts-with > contains > subsequence
 */
function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;

	// Subsequence match - score by how "tight" the match is
	// (fewer gaps between matched characters = higher score)
	let qi = 0;
	let gaps = 0;
	let lastMatchIdx = -1;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) {
			if (lastMatchIdx >= 0 && ti - lastMatchIdx > 1) gaps++;
			lastMatchIdx = ti;
			qi++;
		}
	}
	if (qi !== query.length) return 0;

	// Base score 40 for subsequence, minus penalty for gaps
	return Math.max(1, 40 - gaps * 5);
}
export function getSlashCommandMatchRank(query: string, commandName: string): number {
	const normalizedQuery = normalizeSlashCommandText(query);
	if (normalizedQuery.length === 0) return 4;

	const normalizedName = normalizeSlashCommandText(commandName);
	if (commandName.toLowerCase().startsWith(query.toLowerCase()) || normalizedName.startsWith(normalizedQuery)) {
		return 0;
	}

	const queryTokens = normalizedQuery.split(" ").filter(Boolean);
	const nameTokens = normalizedName.split(" ").filter(Boolean);
	if (queryTokens.length === 1 && nameTokens.includes(queryTokens[0]!)) {
		return 1;
	}

	if (
		queryTokens.length > 1 &&
		queryTokens.every((token, index) => {
			const nameToken = nameTokens[index];
			return nameToken ? nameToken.startsWith(token) : false;
		})
	) {
		return 2;
	}

	if (
		queryTokens.length === 1 &&
		nameTokens.some(token => token.startsWith(queryTokens[0]!) || token.includes(queryTokens[0]!))
	) {
		return 3;
	}

	return 4;
}

function normalizeSlashCommandText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	/** Dim hint text shown inline after cursor when this item is selected */
	hint?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	/**
	 * Higher values surface first in autocomplete, ahead of fuzzy-score ordering.
	 * Use this to pin first-class commands (e.g. bundled GJC skills) to the top.
	 */
	priority?: number;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
	/** Return inline hint text for the current argument state (shown as dim ghost text after cursor) */
	getInlineHint?(argumentText: string): string | null;
}

export interface AutocompleteProvider {
	/** Get autocomplete suggestions for current text/cursor position */
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{
		items: AutocompleteItem[];
		prefix: string; // What we're matching against (e.g., "/" or "src/")
	} | null>;

	/** Apply the selected item and return new text + cursor position */
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	};

	/** Get inline hint text to show as dim ghost text after the cursor */
	getInlineHint?(lines: string[], cursorLine: number, cursorCol: number): string | null;
	/** Synchronously try to complete a slash command at the start of a line (no async I/O). */
	/** Returns matched items and the full prefix, or null if not applicable. */
	trySyncSlashCompletion?(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null;
	/**
	 * Synchronously try to expand text immediately before the cursor (no async I/O).
	 * Called after every single-character insert. Implementations MUST cheaply
	 * early-return when the trailing context cannot trigger them.
	 * Returns the number of characters to delete immediately before the cursor
	 * and the literal string to insert in their place, or null to leave the
	 * buffer untouched.
	 */
	trySyncInlineReplace?(textBeforeCursor: string): { replaceLen: number; insert: string } | null;
}

// Combined provider that handles both slash commands and file paths.
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	#commands: (SlashCommand | AutocompleteItem)[];
	#basePath: string;
	// Intentionally separate from pi-natives cache: this cache is a local,
	// per-directory readdir fast-path for prefix completions. Global fuzzy
	// discovery continues to use native fuzzyFind + shared scan cache.
	#dirCache: Map<string, { entries: fs.Dirent[]; timestamp: number }> = new Map();
	readonly #DIR_CACHE_TTL = 2000; // 2 seconds

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string = getProjectDir()) {
		this.#commands = commands;
		this.#basePath = basePath;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Check for @ file reference (fuzzy search) - must be after a delimiter or at start
		const atPrefix = this.#extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			const suggestions =
				rawPrefix.length > 0
					? await this.#getFuzzyFileSuggestions(rawPrefix, { isQuotedPrefix })
					: await this.#getFileSuggestions("@");
			if (suggestions.length === 0 && rawPrefix.length > 0) {
				const fallback = await this.#getFileSuggestions(atPrefix);
				if (fallback.length === 0) return null;
				return { items: fallback, prefix: atPrefix };
			}
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		// Check for slash commands
		if (textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				// No space yet - complete command names
				const prefix = textBeforeCursor.slice(1); // Remove the "/"
				const lowerPrefix = prefix.toLowerCase();

				// Filter commands using fuzzy matching (subsequence match)
				const matches = this.#commands
					.filter(cmd => {
						const name = "name" in cmd ? cmd.name : cmd.value;
						if (!name) return false;
						// Match name, normalized slash-name aliases, or description.
						if (fuzzyMatch(lowerPrefix, name.toLowerCase())) return true;
						if (getSlashCommandMatchRank(lowerPrefix, name.toLowerCase()) < 4) return true;
						const desc = cmd.description?.toLowerCase();
						return desc ? fuzzyMatch(lowerPrefix, desc) : false;
					})
					.map((cmd, index) => {
						const name = "name" in cmd ? cmd.name : cmd.value;
						const lowerName = name?.toLowerCase() ?? "";
						const lowerDesc = cmd.description?.toLowerCase() ?? "";
						// Score name matches higher than description matches
						const nameScore = fuzzyMatch(lowerPrefix, lowerName) ? fuzzyScore(lowerPrefix, lowerName) : 0;
						const descScore = fuzzyMatch(lowerPrefix, lowerDesc) ? fuzzyScore(lowerPrefix, lowerDesc) * 0.5 : 0;
						const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
						const desc = cmd.description ?? "";
						const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
						const priority = "priority" in cmd && typeof cmd.priority === "number" ? cmd.priority : 0;
						return {
							value: name,
							label: "name" in cmd ? cmd.name : cmd.label,
							score: Math.max(nameScore, descScore),
							priority,
							matchRank: getSlashCommandMatchRank(lowerPrefix, lowerName),
							index,
							...(fullDesc && { description: fullDesc }),
						};
					})
					.sort(
						(a, b) =>
							a.matchRank - b.matchRank || b.priority - a.priority || b.score - a.score || a.index - b.index,
					)
					.map(({ score: _score, priority: _priority, matchRank: _matchRank, index: _index, ...rest }) => rest);

				if (matches.length === 0) return null;

				return {
					items: matches,
					prefix: textBeforeCursor,
				};
			} else {
				// Space found - complete command arguments
				const commandName = textBeforeCursor.slice(1, spaceIndex); // Command without "/"
				const argumentText = textBeforeCursor.slice(spaceIndex + 1); // Text after space

				const command = this.#commands.find(cmd => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					return name === commandName;
				});
				if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
					return null; // No argument completion for this command
				}

				const argumentSuggestions = await command.getArgumentCompletions(argumentText);
				if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
					return null;
				}

				return {
					items: argumentSuggestions,
					prefix: argumentText,
				};
			}
		}

		// Check for file paths - triggered by Tab or if we detect a path pattern
		const pathMatch = this.#extractPathPrefix(textBeforeCursor, false);

		if (pathMatch !== null) {
			const suggestions = await this.#getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			// Check if we have an exact match that is a directory
			// In that case, we might want to return suggestions for the directory content instead
			// But only if the prefix ends with /
			if (suggestions.length === 1 && suggestions[0]?.value === pathMatch && !pathMatch.endsWith("/")) {
				// Exact match found (e.g. user typed "src" and "src/" is the only match)
				// We still return it so user can select it and add /
				return {
					items: suggestions,
					prefix: pathMatch,
				};
			}

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);

		// Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
		// Slash commands are at the start of the line and don't contain path separators after the first /
		const isSlashCommand = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		if (isSlashCommand) {
			// This is a command name completion
			const newLine = `${beforePrefix}/${item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}

		// Check if we're completing a file attachment (prefix starts with "@")
		if (prefix.startsWith("@")) {
			// This is a file attachment completion
			const newLine = `${beforePrefix + item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1, // +1 for space
			};
		}

		// Check if we're in a slash command context (beforePrefix contains "/command ")
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// This is likely a command argument completion
			const newLine = beforePrefix + item.value + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
			};
		}

		// For file paths, complete the path
		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}

	// Extract @ prefix for fuzzy file suggestions
	#extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;

		if (text[tokenStart] === "@") {
			return text.slice(tokenStart);
		}

		return null;
	}

	// Extract a path-like prefix from the text before cursor
	#extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// Return empty string only after a space (not for completely empty text)
		// Empty text should not trigger file suggestions - that's for forced Tab completion
		if (pathPrefix === "" && text.endsWith(" ")) {
			return pathPrefix;
		}

		return null;
	}

	// Expand home directory (~/) to actual home path
	#expandHomePath(filePath: string): string {
		if (filePath.startsWith("~/")) {
			const expandedPath = path.join(os.homedir(), filePath.slice(2));
			// Preserve trailing slash if original path had one
			return filePath.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (filePath === "~") {
			return os.homedir();
		}
		return filePath;
	}

	async #resolveScopedFuzzyQuery(
		rawQuery: string,
	): Promise<{ baseDir: string; query: string; displayBase: string } | null> {
		const slashIndex = rawQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = rawQuery.slice(0, slashIndex + 1);
		const query = rawQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.#expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = path.join(this.#basePath, displayBase);
		}

		try {
			if (!(await fs.promises.stat(baseDir)).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	#scopedPathForDisplay(displayBase: string, relativePath: string): string {
		if (displayBase === "/") {
			return `/${relativePath}`;
		}
		return `${displayBase}${relativePath}`;
	}

	async #getCachedDirEntries(searchDir: string): Promise<fs.Dirent[]> {
		const now = Date.now();
		const cached = this.#dirCache.get(searchDir);

		if (cached && now - cached.timestamp < this.#DIR_CACHE_TTL) {
			return cached.entries;
		}

		const entries = await fs.promises.readdir(searchDir, { withFileTypes: true });
		this.#dirCache.set(searchDir, { entries, timestamp: now });

		if (this.#dirCache.size > 100) {
			const sortedKeys = [...this.#dirCache.entries()]
				.sort((a, b) => a[1].timestamp - b[1].timestamp)
				.slice(0, 50)
				.map(([key]) => key);
			for (const key of sortedKeys) {
				this.#dirCache.delete(key);
			}
		}

		return entries;
	}

	invalidateDirCache(dir?: string): void {
		if (dir) {
			this.#dirCache.delete(dir);
		} else {
			this.#dirCache.clear();
		}
	}

	// Get file/directory suggestions for a given path prefix
	async #getFileSuggestions(prefix: string): Promise<AutocompleteItem[]> {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			// Handle home directory expansion
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.#expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				rawPrefix === "" ||
				rawPrefix === "./" ||
				rawPrefix === "../" ||
				rawPrefix === "~" ||
				rawPrefix === "~/" ||
				rawPrefix === "/" ||
				(isAtPrefix && rawPrefix === "");

			if (isRootPrefix) {
				// Complete from specified position
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = path.join(this.#basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (rawPrefix.endsWith("/")) {
				// If prefix ends with /, show contents of that directory
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = path.join(this.#basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// Split into directory and file prefix
				const dir = path.dirname(expandedPrefix);
				const file = path.basename(expandedPrefix);
				if (rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = dir;
				} else {
					searchDir = path.join(this.#basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = await this.#getCachedDirEntries(searchDir);
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}
				// Skip .git directory
				if (entry.name === ".git") {
					continue;
				}

				// Check if entry is a directory (or a symlink pointing to a directory)
				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = path.join(searchDir, entry.name);
						isDirectory = (await fs.promises.stat(fullPath)).isDirectory();
					} catch {
						// Broken symlink, file deleted between readdir and stat, or permission error
						continue;
					}
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix;

				if (displayPrefix.endsWith("/")) {
					// If prefix ends with /, append entry to the prefix
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/")) {
					// Preserve ~/ format for home directory paths
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
						const dir = path.dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : path.join(dir, name)}`;
					} else if (displayPrefix.startsWith("/")) {
						// Absolute path - construct properly
						const dir = path.dirname(displayPrefix);
						if (dir === "/") {
							relativePath = `/${name}`;
						} else {
							relativePath = `${dir}/${name}`;
						}
					} else {
						relativePath = path.join(path.dirname(displayPrefix), name);
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					// For standalone entries, preserve ~/ if original prefix was ~/
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix,
					isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			// Sort directories first, then alphabetically
			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch {
			// Directory doesn't exist or not accessible
			return [];
		}
	}

	async #getFuzzyFileSuggestions(query: string, options: { isQuotedPrefix: boolean }): Promise<AutocompleteItem[]> {
		try {
			const scopedQuery = await this.#resolveScopedFuzzyQuery(query);
			const searchPath = scopedQuery?.baseDir ?? this.#basePath;
			const fuzzyQuery = scopedQuery?.query ?? query;
			const result = await fuzzyFind(buildAutocompleteFuzzyDiscoveryProfile(fuzzyQuery, searchPath));
			const lowerQuery = fuzzyQuery.toLowerCase();
			const filteredMatches = result.matches.filter(entry => {
				const p = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
				const normalized = p.replaceAll("\\", "/");
				if (/(^|\/)\.git(\/|$)/.test(normalized)) {
					return false;
				}
				return lowerQuery.length === 0 || fuzzyMatch(lowerQuery, normalized.toLowerCase());
			});
			const topEntries = filteredMatches.slice(0, 20);
			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.#scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = path.basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});
				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}
			return suggestions;
		} catch {
			return [];
		}
	}

	// Force file completion (called on Tab key) - always returns suggestions
	async getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return null;
		}

		// Force extract path prefix - this will always return something
		const pathMatch = this.#extractPathPrefix(textBeforeCursor, true);
		if (pathMatch !== null) {
			const suggestions = await this.#getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}

	/** Get inline hint text for slash commands with subcommand hints */
	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		if (!textBeforeCursor.startsWith("/")) return null;

		const spaceIndex = textBeforeCursor.indexOf(" ");
		if (spaceIndex === -1) return null;

		const commandName = textBeforeCursor.slice(1, spaceIndex);
		const argumentText = textBeforeCursor.slice(spaceIndex + 1);

		const command = this.#commands.find(cmd => {
			const name = "name" in cmd ? cmd.name : cmd.value;
			return name === commandName;
		});

		if (!command || !("getInlineHint" in command) || !command.getInlineHint) {
			return null;
		}

		return command.getInlineHint(argumentText);
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		if (!textBeforeCursor.startsWith("/")) return null;
		if (textBeforeCursor.length <= 1) return null; // Bare "/" alone, don't auto-complete
		if (textBeforeCursor.includes(" ")) return null; // Only complete command name, not args

		const prefix = textBeforeCursor.slice(1);
		const lowerPrefix = prefix.toLowerCase();

		const matches = this.#commands
			.filter(cmd => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				if (!name) return false;
				if (fuzzyMatch(lowerPrefix, name.toLowerCase())) return true;
				if (getSlashCommandMatchRank(lowerPrefix, name.toLowerCase()) < 4) return true;
				const desc = cmd.description?.toLowerCase();
				return desc ? fuzzyMatch(lowerPrefix, desc) : false;
			})
			.map((cmd, index) => {
				const name = "name" in cmd ? cmd.name : cmd.value;
				const lowerName = name?.toLowerCase() ?? "";
				const lowerDesc = cmd.description?.toLowerCase() ?? "";
				const nameScore = fuzzyMatch(lowerPrefix, lowerName) ? fuzzyScore(lowerPrefix, lowerName) : 0;
				const descScore = fuzzyMatch(lowerPrefix, lowerDesc) ? fuzzyScore(lowerPrefix, lowerDesc) * 0.5 : 0;
				const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
				const desc = cmd.description ?? "";
				const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc;
				const priority = "priority" in cmd && typeof cmd.priority === "number" ? cmd.priority : 0;
				return {
					value: name,
					label: "name" in cmd ? cmd.name : cmd.label,
					score: Math.max(nameScore, descScore),
					priority,
					matchRank: getSlashCommandMatchRank(lowerPrefix, lowerName),
					index,
					...(fullDesc && { description: fullDesc }),
				} as AutocompleteItem & { score: number; priority: number; matchRank: number; index: number };
			})
			.sort((a, b) => a.matchRank - b.matchRank || b.priority - a.priority || b.score - a.score || a.index - b.index)
			.map(({ score: _score, priority: _priority, matchRank: _matchRank, index: _index, ...rest }) => rest);

		if (matches.length === 0) return null;
		return { items: matches, prefix: textBeforeCursor };
	}
}
