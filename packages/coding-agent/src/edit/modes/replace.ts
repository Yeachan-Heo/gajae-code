/**
 * Fuzzy matching utilities for the edit tool.
 *
 * Provides both character-level and line-level fuzzy matching with progressive
 * fallback strategies for finding text in files.
 */
import type { AgentToolResult } from "@gajae-code/agent-core";
import * as z from "zod/v4";
import type { WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { invalidateFsScanAfterWrite } from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { generateDiffString, replaceText } from "../diff";
import {
	detectLineEnding,
	normalizeForFuzzy,
	normalizeToLF,
	normalizeUnicode,
	restoreLineEndings,
	stripBom,
} from "../normalize";

type NativeFuzzyMatch = {
	actualText: string;
	startIndex: number;
	startLine: number;
	confidence: number;
};

type NativeFindMatchResult = {
	matched?: NativeFuzzyMatch | null;
	closest?: NativeFuzzyMatch | null;
	occurrences?: number | null;
	occurrenceLines?: number[] | null;
	occurrencePreviews?: string[] | null;
	fuzzyMatches?: number | null;
	dominantFuzzy?: boolean | null;
};

type NativeSeekSequenceResult = {
	index?: number | null;
	confidence: number;
	matchCount?: number | null;
	matchIndices?: number[] | null;
	strategy?: string | null;
};

type NativeEditFuzzyBindings = {
	editFindMatch: (content: string, target: string, allowFuzzy: boolean, threshold?: number) => NativeFindMatchResult;
	editSeekSequence: (
		lines: string[],
		pattern: string[],
		start: number,
		eof: boolean,
		allowFuzzy: boolean,
	) => NativeSeekSequenceResult;
};

let nativeEditFuzzyBindingsPromise: Promise<NativeEditFuzzyBindings> | undefined;

function loadNativeEditFuzzyBindings(): Promise<NativeEditFuzzyBindings> {
	if (!nativeEditFuzzyBindingsPromise) {
		nativeEditFuzzyBindingsPromise = Promise.resolve().then(() => {
			const mod = require("@gajae-code/natives") as Partial<NativeEditFuzzyBindings>;
			if (typeof mod.editFindMatch !== "function" || typeof mod.editSeekSequence !== "function") {
				throw new Error("Native pi-edit matcher exports are missing from @gajae-code/natives");
			}
			return mod as NativeEditFuzzyBindings;
		});
	}
	return nativeEditFuzzyBindingsPromise;
}

import { withEditPathMutation } from "../path-mutation-lock";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { EditToolDetails, LspBatchRequest } from "../renderer";

export interface FuzzyMatch {
	actualText: string;
	startIndex: number;
	startLine: number;
	confidence: number;
}

export interface MatchOutcome {
	match?: FuzzyMatch;
	closest?: FuzzyMatch;
	occurrences?: number;
	occurrenceLines?: number[];
	occurrencePreviews?: string[];
	fuzzyMatches?: number;
	dominantFuzzy?: boolean;
}

export type SequenceMatchStrategy =
	| "exact"
	| "trim-trailing"
	| "trim"
	| "comment-prefix"
	| "unicode"
	| "prefix"
	| "substring"
	| "fuzzy"
	| "fuzzy-dominant"
	| "character";

export interface SequenceSearchResult {
	index: number | undefined;
	confidence: number;
	matchCount?: number;
	matchIndices?: number[];
	strategy?: SequenceMatchStrategy;
}

export type ContextMatchStrategy = "exact" | "trim" | "unicode" | "prefix" | "substring" | "fuzzy";

export interface ContextLineResult {
	index: number | undefined;
	confidence: number;
	matchCount?: number;
	matchIndices?: number[];
	strategy?: ContextMatchStrategy;
}

export class EditMatchError extends Error {
	constructor(
		readonly path: string,
		readonly searchText: string,
		readonly closest: FuzzyMatch | undefined,
		readonly options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
	) {
		super(EditMatchError.formatMessage(path, searchText, closest, options));
		this.name = "EditMatchError";
	}

	static formatMessage(
		path: string,
		searchText: string,
		closest: FuzzyMatch | undefined,
		options: { allowFuzzy: boolean; threshold: number; fuzzyMatches?: number },
	): string {
		if (!closest) {
			return options.allowFuzzy
				? `Could not find a close enough match in ${path}.`
				: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;
		}

		const similarity = Math.round(closest.confidence * 100);
		const searchLines = searchText.split("\n");
		const actualLines = closest.actualText.split("\n");
		const { oldLine, newLine } = findFirstDifferentLine(searchLines, actualLines);
		const thresholdPercent = Math.round(options.threshold * 100);

		const hint = options.allowFuzzy
			? options.fuzzyMatches && options.fuzzyMatches > 1
				? `Found ${options.fuzzyMatches} high-confidence matches. Provide more context to make it unique.`
				: `Closest match was below the ${thresholdPercent}% similarity threshold.`
			: "Fuzzy matching is disabled. Enable 'Edit fuzzy match' in settings to accept high-confidence matches.";

		return [
			options.allowFuzzy
				? `Could not find a close enough match in ${path}.`
				: `Could not find the exact text in ${path}.`,
			``,
			`Closest match (${similarity}% similar) at line ${closest.startLine}:`,
			`  - ${oldLine}`,
			`  + ${newLine}`,
			hint,
		].join("\n");
	}
}

function findFirstDifferentLine(oldLines: string[], newLines: string[]): { oldLine: string; newLine: string } {
	const max = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < max; i++) {
		const oldLine = oldLines[i] ?? "";
		const newLine = newLines[i] ?? "";
		if (oldLine !== newLine) {
			return { oldLine, newLine };
		}
	}
	return { oldLine: oldLines[0] ?? "", newLine: newLines[0] ?? "" };
}

function formatOccurrenceError(path: string, matchOutcome: MatchOutcome): string {
	const previews = matchOutcome.occurrencePreviews?.join("\n\n") ?? "";
	const moreMsg =
		matchOutcome.occurrences && matchOutcome.occurrences > MAX_RECORDED_MATCHES
			? ` (showing first ${MAX_RECORDED_MATCHES} of ${matchOutcome.occurrences})`
			: "";
	return `Found ${matchOutcome.occurrences} occurrences in ${path}${moreMsg}:\n\n${previews}\n\nAdd more context lines to disambiguate.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Default similarity threshold for fuzzy matching */
export const DEFAULT_FUZZY_THRESHOLD = 0.95;

/** Threshold for context line matching */
const CONTEXT_FUZZY_THRESHOLD = 0.8;

/** Minimum length for partial/substring matching */
const PARTIAL_MATCH_MIN_LENGTH = 6;

/** Minimum ratio of pattern to line length for substring match */
const PARTIAL_MATCH_MIN_RATIO = 0.3;

/** Maximum number of match indices or previews to retain for diagnostics */
const MAX_RECORDED_MATCHES = 5;

interface IndexedMatches {
	firstMatch: number | undefined;
	matchCount: number;
	matchIndices: number[];
}

function collectIndexedMatches(
	start: number,
	endInclusive: number,
	predicate: (index: number) => boolean,
): IndexedMatches {
	let firstMatch: number | undefined;
	let matchCount = 0;
	const matchIndices: number[] = [];

	for (let index = start; index <= endInclusive; index++) {
		if (!predicate(index)) continue;
		if (firstMatch === undefined) {
			firstMatch = index;
		}
		matchCount++;
		if (matchIndices.length < MAX_RECORDED_MATCHES) {
			matchIndices.push(index);
		}
	}

	return { firstMatch, matchCount, matchIndices };
}

function toAmbiguousMatchResult<TStrategy extends SequenceMatchStrategy | ContextMatchStrategy>(
	matches: IndexedMatches,
	confidence: number,
	strategy: TStrategy,
): { index: number; confidence: number; matchCount: number; matchIndices: number[]; strategy: TStrategy } | undefined {
	if (matches.firstMatch === undefined) {
		return undefined;
	}
	return {
		index: matches.firstMatch,
		confidence,
		matchCount: matches.matchCount,
		matchIndices: matches.matchIndices,
		strategy,
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Algorithms
// ═══════════════════════════════════════════════════════════════════════════

/** Compute Levenshtein distance between two strings */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1;
			const insertion = curr[j - 1] + 1;
			const substitution = prev[j - 1] + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

/** Compute similarity score between two strings (0 to 1) */
export function similarity(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLen;
}

// ═══════════════════════════════════════════════════════════════════════════
// Character-Level Fuzzy Match (for replace mode)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find a match for target text within content.
 * Used primarily for replace-mode edits.
 */
function toFuzzyMatch(match: NativeFuzzyMatch | null | undefined): FuzzyMatch | undefined {
	if (!match) return undefined;
	return {
		actualText: match.actualText,
		startIndex: match.startIndex,
		startLine: match.startLine,
		confidence: match.confidence,
	};
}

/** Find an exact or fuzzy match through the native pi-edit matcher. */
export async function findMatch(
	content: string,
	target: string,
	options: { allowFuzzy: boolean; threshold?: number },
): Promise<MatchOutcome> {
	const native = await loadNativeEditFuzzyBindings();
	const result = native.editFindMatch(content, target, options.allowFuzzy, options.threshold);
	const match = toFuzzyMatch(result.matched);
	const closest = toFuzzyMatch(result.closest);
	return {
		...(match ? { match } : {}),
		...(closest ? { closest } : {}),
		...(result.occurrences != null ? { occurrences: result.occurrences } : {}),
		...(result.occurrenceLines != null ? { occurrenceLines: result.occurrenceLines } : {}),
		...(result.occurrencePreviews != null ? { occurrencePreviews: result.occurrencePreviews } : {}),
		...(result.fuzzyMatches != null ? { fuzzyMatches: result.fuzzyMatches } : {}),
		...(result.dominantFuzzy != null ? { dominantFuzzy: result.dominantFuzzy } : {}),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Line-Based Sequence Match (for patch mode)
// ═══════════════════════════════════════════════════════════════════════════

/** Compute average similarity score for pattern at position */
function fuzzyScoreAt(lines: string[], pattern: string[], i: number): number {
	let totalScore = 0;
	for (let j = 0; j < pattern.length; j++) {
		const lineNorm = normalizeForFuzzy(lines[i + j]);
		const patternNorm = normalizeForFuzzy(pattern[j]);
		totalScore += similarity(lineNorm, patternNorm);
	}
	return totalScore / pattern.length;
}

/** Search line sequences with the native pi-edit matcher. */
export async function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
	options?: { allowFuzzy?: boolean },
): Promise<SequenceSearchResult> {
	const native = await loadNativeEditFuzzyBindings();
	const result = native.editSeekSequence(lines, pattern, start, eof, options?.allowFuzzy ?? true);
	return {
		index: result.index ?? undefined,
		confidence: result.confidence,
		...(result.matchCount != null ? { matchCount: result.matchCount } : {}),
		...(result.matchIndices != null ? { matchIndices: result.matchIndices } : {}),
		...(result.strategy != null ? { strategy: result.strategy as SequenceMatchStrategy } : {}),
	};
}
export function findClosestSequenceMatch(
	lines: string[],
	pattern: string[],
	options?: { start?: number; eof?: boolean },
): { index: number | undefined; confidence: number; strategy: SequenceMatchStrategy } {
	if (pattern.length === 0) {
		return { index: options?.start ?? 0, confidence: 1, strategy: "exact" };
	}
	if (pattern.length > lines.length) {
		return { index: undefined, confidence: 0, strategy: "fuzzy" };
	}

	const start = options?.start ?? 0;
	const eof = options?.eof ?? false;
	const maxStart = lines.length - pattern.length;
	const searchStart = eof && lines.length >= pattern.length ? maxStart : start;

	let bestIndex: number | undefined;
	let bestScore = 0;

	for (let i = searchStart; i <= maxStart; i++) {
		const score = fuzzyScoreAt(lines, pattern, i);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (eof && searchStart > start) {
		for (let i = start; i < searchStart; i++) {
			const score = fuzzyScoreAt(lines, pattern, i);
			if (score > bestScore) {
				bestScore = score;
				bestIndex = i;
			}
		}
	}

	return { index: bestIndex, confidence: bestScore, strategy: "fuzzy" };
}

/**
 * Find a context line in the file using progressive matching strategies.
 *
 * @param lines - The lines of the file content
 * @param context - The context line to search for
 * @param startFrom - Starting index for the search
 */
export function findContextLine(
	lines: string[],
	context: string,
	startFrom: number,
	options?: { allowFuzzy?: boolean; skipFunctionFallback?: boolean },
): ContextLineResult {
	const allowFuzzy = options?.allowFuzzy ?? true;
	const trimmedContext = context.trim();

	const endIndex = lines.length - 1;
	const exactPasses: Array<{
		confidence: number;
		strategy: ContextMatchStrategy;
		predicate: (index: number) => boolean;
	}> = [
		{ confidence: 1.0, strategy: "exact", predicate: i => lines[i] === context },
		{ confidence: 0.99, strategy: "trim", predicate: i => lines[i].trim() === trimmedContext },
	];

	for (const pass of exactPasses) {
		const matches = collectIndexedMatches(startFrom, endIndex, pass.predicate);
		const result = toAmbiguousMatchResult(matches, pass.confidence, pass.strategy);
		if (result) {
			return result;
		}
	}

	// Pass 3: Unicode normalization match
	const normalizedContext = normalizeUnicode(context);
	const unicodeMatches = collectIndexedMatches(
		startFrom,
		endIndex,
		i => normalizeUnicode(lines[i]) === normalizedContext,
	);
	const unicodeResult = toAmbiguousMatchResult(unicodeMatches, 0.98, "unicode");
	if (unicodeResult) {
		return unicodeResult;
	}

	if (!allowFuzzy) {
		return { index: undefined, confidence: 0 };
	}

	// Pass 4: Prefix match (file line starts with context)
	const contextNorm = normalizeForFuzzy(context);
	if (contextNorm.length > 0) {
		const prefixMatches = collectIndexedMatches(startFrom, endIndex, i =>
			normalizeForFuzzy(lines[i]).startsWith(contextNorm),
		);
		const prefixResult = toAmbiguousMatchResult(prefixMatches, 0.96, "prefix");
		if (prefixResult) {
			return prefixResult;
		}
	}

	// Pass 5: Substring match (file line contains context)
	// First pass: find all substring matches (ignoring ratio)
	// If exactly one match exists, accept it (uniqueness is sufficient)
	// If multiple matches, apply ratio filter to disambiguate
	if (contextNorm.length >= PARTIAL_MATCH_MIN_LENGTH) {
		const allSubstringMatches: Array<{ index: number; ratio: number }> = [];
		for (let i = startFrom; i < lines.length; i++) {
			const lineNorm = normalizeForFuzzy(lines[i]);
			if (lineNorm.includes(contextNorm)) {
				const ratio = contextNorm.length / Math.max(1, lineNorm.length);
				allSubstringMatches.push({ index: i, ratio });
			}
		}
		const matchIndices = allSubstringMatches.slice(0, 5).map(match => match.index);

		// If exactly one substring match, accept it regardless of ratio
		if (allSubstringMatches.length === 1) {
			return {
				index: allSubstringMatches[0].index,
				confidence: 0.94,
				matchCount: 1,
				matchIndices,
				strategy: "substring",
			};
		}

		// Multiple matches: filter by ratio to disambiguate
		let firstMatch: number | undefined;
		let matchCount = 0;
		for (const match of allSubstringMatches) {
			if (match.ratio >= PARTIAL_MATCH_MIN_RATIO) {
				if (firstMatch === undefined) firstMatch = match.index;
				matchCount++;
			}
		}
		if (matchCount > 0) {
			return { index: firstMatch, confidence: 0.94, matchCount, matchIndices, strategy: "substring" };
		}

		// If we had substring matches but none passed ratio filter,
		// return ambiguous result so caller knows matches exist
		if (allSubstringMatches.length > 1) {
			return {
				index: allSubstringMatches[0].index,
				confidence: 0.94,
				matchCount: allSubstringMatches.length,
				matchIndices,
				strategy: "substring",
			};
		}
	}

	// Pass 6: Fuzzy match using similarity
	let bestIndex: number | undefined;
	let bestScore = 0;
	const fuzzyMatches: IndexedMatches = {
		firstMatch: undefined,
		matchCount: 0,
		matchIndices: [],
	};

	for (let i = startFrom; i < lines.length; i++) {
		const lineNorm = normalizeForFuzzy(lines[i]);
		const score = similarity(lineNorm, contextNorm);
		if (score >= CONTEXT_FUZZY_THRESHOLD) {
			if (fuzzyMatches.firstMatch === undefined) {
				fuzzyMatches.firstMatch = i;
			}
			fuzzyMatches.matchCount++;
			if (fuzzyMatches.matchIndices.length < MAX_RECORDED_MATCHES) {
				fuzzyMatches.matchIndices.push(i);
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (bestIndex !== undefined && bestScore >= CONTEXT_FUZZY_THRESHOLD) {
		return {
			index: bestIndex,
			confidence: bestScore,
			matchCount: fuzzyMatches.matchCount,
			matchIndices: fuzzyMatches.matchIndices,
			strategy: "fuzzy",
		};
	}

	if (!options?.skipFunctionFallback && trimmedContext.endsWith("()")) {
		const withParen = trimmedContext.replace(/\(\)\s*$/u, "(");
		const withoutParen = trimmedContext.replace(/\(\)\s*$/u, "");
		const parenResult = findContextLine(lines, withParen, startFrom, { allowFuzzy, skipFunctionFallback: true });
		if (parenResult.index !== undefined || (parenResult.matchCount ?? 0) > 0) {
			return parenResult;
		}
		return findContextLine(lines, withoutParen, startFrom, { allowFuzzy, skipFunctionFallback: true });
	}

	return { index: undefined, confidence: bestScore };
}

export const replaceEditEntrySchema = z
	.object({
		old_text: z.string().describe("text to find"),
		new_text: z.string().describe("replacement text"),
		all: z.boolean().describe("replace all occurrences").optional(),
	})
	.strict();

export const replaceEditSchema = z
	.object({
		path: z.string().describe("file path"),
		edits: z.array(replaceEditEntrySchema).min(1).describe("replacements"),
	})
	.strict();

export type ReplaceEditEntry = z.infer<typeof replaceEditEntrySchema>;
export type ReplaceParams = z.infer<typeof replaceEditSchema>;

export interface ExecuteReplaceSingleOptions {
	session: ToolSession;
	path: string;
	params: ReplaceEditEntry;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

export async function executeReplaceSingle(
	options: ExecuteReplaceSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof replaceEditEntrySchema>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;
	const { old_text, new_text, all } = params;

	enforcePlanModeWrite(session, path);

	if (old_text.length === 0) {
		throw new Error("old_text must not be empty.");
	}

	const absolutePath = resolvePlanPath(session, path);
	return withEditPathMutation([absolutePath], () =>
		executeReplaceSingleUnderLock({
			session,
			path,
			params,
			signal,
			batchRequest,
			allowFuzzy,
			fuzzyThreshold,
			writethrough,
			beginDeferredDiagnosticsForPath,
			absolutePath,
			old_text,
			new_text,
			all,
		}),
	);
}

async function executeReplaceSingleUnderLock(
	options: ExecuteReplaceSingleOptions & {
		absolutePath: string;
		old_text: string;
		new_text: string;
		all: boolean | undefined;
	},
): Promise<AgentToolResult<EditToolDetails, typeof replaceEditEntrySchema>> {
	const {
		path,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		writethrough,
		beginDeferredDiagnosticsForPath,
		absolutePath,
		old_text,
		new_text,
		all,
	} = options;

	const rawContent = await readEditFileText(absolutePath, path);
	const { bom, text: content } = stripBom(rawContent);
	const originalEnding = detectLineEnding(content);
	const normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(old_text);
	const normalizedNewText = normalizeToLF(new_text);

	const result = await replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
		fuzzy: allowFuzzy,
		all: all ?? false,
		threshold: fuzzyThreshold,
	});

	if (result.count === 0) {
		const matchOutcome = await findMatch(normalizedContent, normalizedOldText, {
			allowFuzzy,
			threshold: fuzzyThreshold,
		});

		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			throw new Error(formatOccurrenceError(path, matchOutcome));
		}

		throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
			allowFuzzy,
			threshold: fuzzyThreshold,
			fuzzyMatches: matchOutcome.fuzzyMatches,
		});
	}

	if (normalizedContent === result.content) {
		throw new Error(`Edits to ${path} resulted in no changes being made.`);
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		path,
		bom + restoreLineEndings(result.content, originalEnding),
	);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);

	const diffResult = generateDiffString(normalizedContent, result.content);
	const resultText =
		result.count > 1
			? `Successfully replaced ${result.count} occurrences in ${path}.`
			: `Successfully replaced text in ${path}.`;

	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	return {
		content: [{ type: "text", text: resultText }],
		details: {
			diff: diffResult.diff,
			path: absolutePath,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics,
			meta,
			oldText: rawContent,
			newText: finalContent,
		},
	};
}
