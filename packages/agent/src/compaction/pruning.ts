/**
 * Tool output pruning utilities for compaction.
 *
 * Candidate selection is staleness-aware: tool results that have been
 * superseded by a later result for the same target (same file read again,
 * same search re-run) or invalidated by a later successful edit/write to a
 * covered file are pruned in preference to merely-old results. Protect-window
 * and minimum-savings hysteresis semantics are unchanged.
 */

import type { ToolCall, ToolResultMessage } from "@gajae-code/ai";
import { createHash } from "node:crypto";
import { sanitizeText } from "@gajae-code/utils";
import type { AgentMessage } from "../types";
import { estimateEntryTokens, estimateTextTokensHeuristic } from "./compaction";
import type { SessionEntry, SessionMessageEntry } from "./entries";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool names that should never be pruned. */
	protectedTools: string[];
	/** Number of newest user turns whose tool outputs must remain intact. Defaults to 2. */
	protectRecentTurns?: number;
	/**
	 * Tools in `protectedTools` whose protection is waived once the result is
	 * superseded (a later result for the same target, or a later successful
	 * edit/write to the covered file). The most recent result per target is
	 * never considered superseded. Optional; defaults to none.
	 */
	staleOverridableTools?: string[];
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", "read"],
	protectRecentTurns: 2,
	staleOverridableTools: ["read"],
};

export interface ToolOutputPruneDigest {
	entryId: string;
	sha256: string;
	bytes: number;
}

export interface ToolOutputPruneReplacement {
	entryId: string;
	replacementText: string;
	/** Text-only results are the only entries safe to evict to an artifact. */
	complete: boolean;
	tokens: number;
}

export interface ToolOutputPrunePlan {
	prunedCount: number;
	tokensSaved: number;
	/** Digest-only identity records; no original output text is retained. */
	digests: readonly ToolOutputPruneDigest[];
	/** Immutable replacement proposals keyed by entry id. */
	replacements: readonly ToolOutputPruneReplacement[];
}

export interface ToolOutputPruneEvictionHandle {
	v: 1;
	artifactId: string;
	uri: string;
	encoding: "utf-8";
	bytes: number;
	sha256: string;
	complete: true;
}

export interface ToolOutputPruneCommitReplacement {
	replacementText?: string;
	eviction?: ToolOutputPruneEvictionHandle;
}

export interface ToolOutputPruneCommitOptions {
	replacements?: ReadonlyMap<string, ToolOutputPruneCommitReplacement>;
}

export type ToolOutputCommitOutcome =
	| { entryId: string; outcome: "committed" }
	| { entryId: string; outcome: "mismatch"; diagnostic: string }
	| { entryId: string; outcome: "unavailable"; diagnostic: string };

const ERROR_DIGEST_MAX_CHARS = 240;
const TAIL_DIGEST_MAX_CHARS = 160;
const PATH_DIGEST_MAX_CHARS = 120;
/**
 * Absolute budget for the assembled digest (~64 tokens). Fields are ordered
 * error-first, so truncating the assembled digest drops tail/counts before it
 * ever touches the error signal.
 */
const DIGEST_TOTAL_MAX_CHARS = 256;

function createGenericPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

export function extractToolOutputText(message: ToolResultMessage): { text: string; complete: boolean } {
	if (typeof message.content === "string") return { text: message.content, complete: true };
	const textBlocks: string[] = [];
	let complete = true;
	for (const block of message.content) {
		if (block.type === "text") textBlocks.push(block.text);
		else complete = false;
	}
	return { text: textBlocks.join("\n"), complete };
}

function firstTextContent(message: ToolResultMessage): string {
	return extractToolOutputText(message).text;
}

function firstErrorLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.find(line => /error|failed|exception|panic/i.test(line))
		?.trim();
}

function firstNonEmptyLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.find(line => line.trim().length > 0)
		?.trim();
}

function lastNonEmptyLine(text: string): string | undefined {
	return text.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
}

function truncateField(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return "…";
	return `${value.slice(0, maxLength - 1)}…`;
}

function resultPathHint(message: ToolResultMessage, call?: ToolCall): string | undefined {
	return (call && toolCallPath(call)) ?? readResolvedPath(message);
}

function resultDigest(message: ToolResultMessage, call?: ToolCall): string | undefined {
	const toolName = message.toolName.toLowerCase();
	const text = sanitizeText(firstTextContent(message));
	const error = firstErrorLine(text);
	const path = resultPathHint(message, call);
	const pathPart = path ? `path=${truncateField(path, PATH_DIGEST_MAX_CHARS)}` : undefined;
	if (toolName === "bash") {
		const details = message as { details?: { exitCode?: unknown } };
		const exitCode =
			typeof details.details?.exitCode === "number" ? details.details.exitCode : message.isError ? 1 : 0;
		const tail = text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
		return [
			`exit=${exitCode}`,
			error ? `error=${truncateField(error, ERROR_DIGEST_MAX_CHARS)}` : undefined,
			pathPart,
			tail ? `tail=${truncateField(tail, TAIL_DIGEST_MAX_CHARS)}` : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join("; ");
	}
	if (toolName === "search" || toolName === "grep") {
		const match = text.match(/(\d+)\s+matches?/i) ?? text.match(/totalMatches["']?:\s*(\d+)/i);
		const files = text.match(/(\d+)\s+files?/i) ?? text.match(/filesWithMatches["']?:\s*(\d+)/i);
		return (
			[
				error ? `error=${truncateField(error, ERROR_DIGEST_MAX_CHARS)}` : undefined,
				pathPart,
				match ? `matches=${match[1]}` : undefined,
				files ? `files=${files[1]}` : undefined,
			]
				.filter((part): part is string => part !== undefined)
				.join("; ") || "search digest unavailable"
		);
	}
	if (message.isError !== true) return undefined;
	if (text.trim().length === 0) return "error=tool result failed without text";
	if (error) return [`error=${truncateField(error, ERROR_DIGEST_MAX_CHARS)}`, pathPart].filter(Boolean).join("; ");
	const summary = firstNonEmptyLine(text) ?? lastNonEmptyLine(text);
	return summary ? `summary=${truncateField(summary, ERROR_DIGEST_MAX_CHARS)}` : undefined;
}

export function createPrunedNotice(tokens: number, message?: ToolResultMessage, call?: ToolCall, artifact?: string): string {
	const generic = createGenericPrunedNotice(tokens);
	const digest =
		truncateField(message ? (resultDigest(message, call) ?? "") : "", DIGEST_TOTAL_MAX_CHARS) || undefined;
	if (!digest && !artifact) return generic;
	if (artifact) {
		return `[Output truncated - ${tokens} tokens; full output: ${artifact}]${digest ? ` ${digest}` : ""}`;
	}
	return `[Output truncated - ${tokens} tokens; ${digest}]`;
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number, notice: string): number {
	return tokens - estimateTextTokensHeuristic(notice);
}

export interface AssistantArgumentPruneResult {
	argumentPrunedCount: number;
	argumentTokensSaved: number;
	/**
	 * The mutated assistant message entries. Callers whose entry source returns
	 * materialized copies must write these back into their canonical store by id.
	 */
	prunedEntries: SessionMessageEntry[];
}

interface PrunedToolArgumentsSentinel {
	pruned: true;
	reason: "stale_tool_arguments";
	pathHints: string[];
	originalChars: number;
	prunedAt: number;
}

const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch", "ast_edit"]);

/** Extract the file-path argument from a tool call, when the tool has one. */
function toolCallPath(call: ToolCall): string | undefined {
	const args = call.arguments;
	const path = args.path ?? args.file_path ?? args.filePath;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * `*** Add|Update|Delete File: <path>` headers open a hunk; `*** Move to:
 * <path>` attaches a rename destination to the current hunk. Move
 * destinations count as touched paths: a rename onto a file invalidates
 * earlier reads of that destination.
 */
const APPLY_PATCH_HEADER = /^\*\*\* (?:((?:Add|Update|Delete) File)|(Move to)): (.+)$/gm;

/**
 * Paths touched by an edit-class tool call, grouped per hunk so a failed
 * hunk can be excluded wholesale (its rename destination included). Most
 * edit tools carry a single path argument; apply_patch envelopes carry an
 * `input` string with per-file headers instead. The envelope shape can
 * arrive under the custom `apply_patch` tool OR the regular `edit` tool
 * (providers without custom-tool support fall back to the JSON function), so
 * any edit-class call with a string `input` is parsed for headers.
 */
function editToolPathGroups(call: ToolCall): string[][] {
	const path = toolCallPath(call);
	if (path !== undefined) return [[path]];
	const input = call.arguments.input;
	if (typeof input !== "string") return [];
	const groups: string[][] = [];
	for (const match of input.matchAll(APPLY_PATCH_HEADER)) {
		const headerPath = match[3]?.trim();
		if (!headerPath) continue;
		const isMoveTo = match[2] !== undefined;
		if (isMoveTo && groups.length > 0) {
			groups[groups.length - 1].push(headerPath);
		} else {
			groups.push([headerPath]);
		}
	}
	return groups;
}
function pathGroupKey(group: string[]): string {
	return JSON.stringify([...group].sort());
}

function pathHintsForGroups(groups: string[][]): string[] {
	return [...new Set(groups.flat())].sort();
}

function isPrunedToolArgumentsSentinel(value: unknown): value is PrunedToolArgumentsSentinel {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { pruned?: unknown; reason?: unknown }).pruned === true &&
		(value as { pruned?: unknown; reason?: unknown }).reason === "stale_tool_arguments"
	);
}

function isEditToolCall(call: ToolCall): boolean {
	return EDIT_TOOL_NAMES.has(call.name) || call.customWireName === "apply_patch";
}

interface AssistantArgumentStalenessIndex {
	latestSuccessfulMutationByPathGroup: Map<string, { index: number; callId: string }>;
	failedCallIds: Set<string>;
}

function buildAssistantArgumentStalenessIndex(entries: SessionEntry[]): AssistantArgumentStalenessIndex {
	const callsById = new Map<string, ToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage;
		if (message.role !== "assistant") continue;
		for (const content of message.content) {
			if (content.type === "toolCall") callsById.set(content.id, content);
		}
	}

	const latestSuccessfulMutationByPathGroup = new Map<string, { index: number; callId: string }>();
	const failedCallIds = new Set<string>();
	for (let i = 0; i < entries.length; i++) {
		const message = getToolResultMessage(entries[i]);
		if (!message) continue;
		const call = callsById.get(message.toolCallId);
		if (!call || !isEditToolCall(call)) continue;
		const detailFiles = call.name === "ast_edit" ? resultDetailFiles(message) : [];
		const groups = detailFiles.length > 0 ? detailFiles.map(file => [file]) : editToolPathGroups(call);
		if (groups.length === 0) continue;
		if (message.isError) {
			failedCallIds.add(call.id);
			continue;
		}
		const successfulPaths = successfulEditPaths(message);
		let mutated = false;
		for (const group of groups) {
			if (successfulPaths !== undefined && !group.some(groupPath => successfulPaths.has(groupPath))) continue;
			latestSuccessfulMutationByPathGroup.set(pathGroupKey(group), { index: i, callId: call.id });
			mutated = true;
		}
		if (!mutated) failedCallIds.add(call.id);
	}
	return { latestSuccessfulMutationByPathGroup, failedCallIds };
}

/** Exact read selector grammar mirrored from the read tool without importing its package layer. */
const READ_SELECTOR_RE = /^(?:L?\d+(?:[-+]L?\d+|-)?(?:,L?\d+(?:[-+]L?\d+|-)?)*|raw|conflicts)$/i;
const READ_RANGE_SELECTOR_RE = /^L?\d+(?:[-+]L?\d+|-)?(?:,L?\d+(?:[-+]L?\d+|-)?)*$/i;
const READ_RAW_SELECTOR_RE = /^raw$/i;

type ReadTarget = { basePath: string; selector?: string };

function splitReadTarget(path: string): ReadTarget {
	const outerColon = path.lastIndexOf(":");
	if (outerColon <= 0) return { basePath: path };
	const outer = path.slice(outerColon + 1);
	if (!READ_SELECTOR_RE.test(outer)) return { basePath: path };

	let basePath = path.slice(0, outerColon);
	let selector = outer;
	const innerColon = basePath.lastIndexOf(":");
	if (innerColon > 0) {
		const inner = basePath.slice(innerColon + 1);
		const compoundRawRange =
			(READ_RAW_SELECTOR_RE.test(inner) && READ_RANGE_SELECTOR_RE.test(outer)) ||
			(READ_RANGE_SELECTOR_RE.test(inner) && READ_RAW_SELECTOR_RE.test(outer));
		if (compoundRawRange) {
			selector = `${inner}:${outer}`;
			basePath = basePath.slice(0, innerColon);
		}
	}
	return { basePath, selector };
}

/** Base file path of a read target with its one valid selector stripped. */
function readBasePath(path: string): string {
	return splitReadTarget(path).basePath;
}

type ReadLineRange = { start: number; end: number };

/** Parse only one explicit, provably bounded trailing read range. */
function readLineRanges(path: string): ReadLineRange[] {
	const selector = splitReadTarget(path).selector;
	if (!selector || /(?:^|:)raw(?:$|:)/i.test(selector) || /^conflicts$/i.test(selector)) return [];
	return selector.split(",").flatMap(part => {
		const range = part.match(/^L?(\d+)([-+])L?(\d+)$/i);
		if (!range) return [];
		const start = Number(range[1]);
		const end = range[2] === "+" ? start + Number(range[3]) - 1 : Number(range[3]);
		return start > 0 && end >= start ? [{ start, end }] : [];
	});
}

function strictlyContainsReadRange(container: ReadLineRange, contained: ReadLineRange): boolean {
	return (
		container.start <= contained.start &&
		container.end >= contained.end &&
		(container.start < contained.start || container.end > contained.end)
	);
}

function readSupersedesRead(
	later: ToolCall,
	earlier: ToolCall,
	lineRangesByCall: ReadonlyMap<ToolCall, ReadLineRange[]>,
): boolean {
	const laterRanges = lineRangesByCall.get(later);
	const earlierRanges = lineRangesByCall.get(earlier);
	return (
		laterRanges?.length === 1 &&
		earlierRanges?.length === 1 &&
		strictlyContainsReadRange(laterRanges[0], earlierRanges[0])
	);
}

/**
 * Stable identity for "the same logical lookup": same tool re-targeting the
 * same subject. A later result with the same key supersedes earlier ones.
 * Keys are canonical JSON tuples so user-controlled text (patterns, paths)
 * can never collide via delimiter ambiguity. Search keys include pagination
 * (`skip`) and result-shaping flags (`i`, `gitignore`): a later page or a
 * differently-shaped search complements earlier output, it does not replace it.
 */
const IDEMPOTENT_BASH_COMMAND =
	/^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|build)\b|git\s+status\b|cargo\s+build\b|(?:make|just)\s+build\b)/;

function normalizedIdempotentBashCommand(call: ToolCall): string | undefined {
	if (call.name !== "bash") return undefined;
	const command = call.arguments.command;
	if (typeof command !== "string") return undefined;
	const normalized = command.trim().replace(/\s+/g, " ");
	if (/[;&|]/.test(normalized) || !IDEMPOTENT_BASH_COMMAND.test(normalized)) return undefined;
	return JSON.stringify([normalized, typeof call.arguments.cwd === "string" ? call.arguments.cwd : undefined]);
}

function toolTargetKey(call: ToolCall): string | undefined {
	const path = toolCallPath(call);
	if (path !== undefined) return JSON.stringify([call.name, "path", path]);
	const command = normalizedIdempotentBashCommand(call);
	if (command !== undefined) return JSON.stringify([call.name, "command", command]);
	const pattern = call.arguments.pattern;
	if (typeof pattern === "string" && pattern.length > 0) {
		const paths = call.arguments.paths;
		const pathList = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
		const skip = typeof call.arguments.skip === "number" ? call.arguments.skip : 0;
		const caseInsensitive = call.arguments.i === true;
		const gitignore = call.arguments.gitignore !== false;
		return JSON.stringify([call.name, "pattern", pattern, pathList, skip, caseInsensitive, gitignore]);
	}
	return undefined;
}

/**
 * Files actually mutated according to a tool result's details. Used for
 * AST-edit-shaped results (`ast_edit` direct-apply and the hidden `resolve`
 * apply step), which report `{ applied: true, files: [...] }` — the resolve
 * tool nests that payload under `details.sourceResultDetails`. Conservative:
 * returns nothing unless the details explicitly mark the change as applied.
 * Checked even on `isError` results: a stale-preview apply reports an error
 * while still having mutated the listed files.
 */
function resultDetailFiles(message: ToolResultMessage): string[] {
	const raw = message.details as { applied?: unknown; files?: unknown; sourceResultDetails?: unknown } | undefined;
	const candidates = [raw, raw?.sourceResultDetails as { applied?: unknown; files?: unknown } | undefined];
	for (const details of candidates) {
		if (details?.applied === true && Array.isArray(details.files)) {
			return details.files.filter((file): file is string => typeof file === "string" && file.length > 0);
		}
	}
	return [];
}

/**
 * Paths that a per-file edit result proves were mutated. Multi-file
 * `apply_patch` can return a non-error envelope while individual files fail, so
 * only explicit success (`isError === false`) or the normal successful result
 * shape (a string `diff` with no error flag) counts. Ambiguous/malformed rows
 * fail closed. If no per-file result array exists, return undefined so ordinary
 * single-file successful tool results retain their established behavior.
 */
function successfulEditPaths(message: ToolResultMessage): Set<string> | undefined {
	const details = message.details as { perFileResults?: unknown } | undefined;
	const perFile = details?.perFileResults;
	if (!Array.isArray(perFile)) return undefined;
	const succeeded = new Set<string>();
	for (const item of perFile) {
		const entry = item as { path?: unknown; isError?: unknown; diff?: unknown };
		if (typeof entry?.path !== "string") continue;
		if (entry.isError === false || (entry.isError === undefined && typeof entry.diff === "string")) {
			succeeded.add(entry.path);
		}
	}
	return succeeded;
}

/**
 * Concrete file path a `read` result actually came from, when the tool
 * reported one (`details.resolvedPath`). Suffix resolution can map a bare
 * filename argument onto a different concrete path.
 */
function readResolvedPath(message: ToolResultMessage): string | undefined {
	const details = message.details as { resolvedPath?: unknown } | undefined;
	const resolved = details?.resolvedPath;
	return typeof resolved === "string" && resolved.length > 0 ? resolved : undefined;
}

interface StalenessIndex {
	/** Entry indices of toolResults superseded by a later same-target result or a later edit. */
	staleResultIndices: Set<number>;
}

/**
 * Build a staleness index over session entries (oldest -> newest):
 * - a toolResult is stale when a later non-error toolResult shares its target key;
 * - a `read` result is stale when a later non-error edit/write touches its file.
 * The most recent result per target is never stale.
 */
function buildStalenessIndex(entries: SessionEntry[]): StalenessIndex {
	const callsById = new Map<string, ToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as AgentMessage;
		if (message.role !== "assistant") continue;
		for (const content of message.content) {
			if (content.type === "toolCall") callsById.set(content.id, content);
		}
	}

	type ResultMeta = { key?: string; call: ToolCall; message: ToolResultMessage };
	const lastResultIndexByKey = new Map<string, number>();
	const resultMeta = new Map<number, ResultMeta>();
	const lastEditIndexByPath = new Map<string, number>();

	for (let i = 0; i < entries.length; i++) {
		const message = getToolResultMessage(entries[i]);
		if (!message) continue;
		const call = callsById.get(message.toolCallId);
		if (!call) continue;

		// AST edits mutate files when previews are applied via the hidden
		// `resolve` tool; the call args carry globs, not concrete paths. Both
		// tools report actually-touched files in result details. Collected
		// BEFORE the error gate: a stale-preview apply reports an error while
		// still having mutated the listed files.
		if (call.name === "resolve" || call.name === "ast_edit") {
			for (const editPath of resultDetailFiles(message)) {
				lastEditIndexByPath.set(editPath, i);
			}
		}
		if (message.isError) continue;

		const key = toolTargetKey(call);
		resultMeta.set(i, { key, call, message });
		if (key !== undefined) lastResultIndexByKey.set(key, i);
		if (EDIT_TOOL_NAMES.has(call.name)) {
			// Per-file edit results prove which path groups actually mutated. A
			// malformed or ambiguous row cannot invalidate earlier read evidence.
			const successfulPaths = successfulEditPaths(message);
			for (const group of editToolPathGroups(call)) {
				if (successfulPaths !== undefined && !group.some(groupPath => successfulPaths.has(groupPath))) continue;
				for (const editPath of group) {
					lastEditIndexByPath.set(editPath, i);
				}
			}
		}
	}

	const staleResultIndices = new Set<number>();
	for (const [index, meta] of resultMeta) {
		if (meta.key !== undefined) {
			const lastIndex = lastResultIndexByKey.get(meta.key);
			if (lastIndex !== undefined && lastIndex > index) {
				staleResultIndices.add(index);
				continue;
			}
		}
		if (meta.call.name === "read") {
			// Check both the call argument (selectors stripped) and the resolved
			// path from result details: suffix resolution can map a bare filename
			// onto a different concrete path, and edits may use either form.
			const lookupPaths = new Set<string>();
			const argPath = toolCallPath(meta.call);
			if (argPath !== undefined) lookupPaths.add(readBasePath(argPath));
			const resolved = readResolvedPath(meta.message);
			if (resolved !== undefined) lookupPaths.add(resolved);
			for (const lookupPath of lookupPaths) {
				const editIndex = lastEditIndexByPath.get(lookupPath);
				if (editIndex !== undefined && editIndex > index) {
					staleResultIndices.add(index);
					break;
				}
			}
		}
	}

	const readsByBasePath = new Map<string, Array<[number, ResultMeta]>>();
	const lineRangesByCall = new Map<ToolCall, ReadLineRange[]>();
	for (const [index, meta] of resultMeta) {
		if (meta.call.name !== "read") continue;
		const path = toolCallPath(meta.call);
		if (!path) continue;
		lineRangesByCall.set(meta.call, readLineRanges(path));
		const basePath = readBasePath(path);
		const group = readsByBasePath.get(basePath);
		if (group) group.push([index, meta]);
		else readsByBasePath.set(basePath, [[index, meta]]);
	}
	for (const reads of readsByBasePath.values()) {
		if (reads.length < 2) continue;
		for (let earlier = 0; earlier < reads.length - 1; earlier++) {
			const [index, meta] = reads[earlier];
			for (let later = earlier + 1; later < reads.length; later++) {
				if (readSupersedesRead(reads[later][1].call, meta.call, lineRangesByCall)) {
					staleResultIndices.add(index);
					break;
				}
			}
		}
	}

	return { staleResultIndices };
}
export function pruneAssistantToolArguments(
	entries: SessionEntry[],
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): AssistantArgumentPruneResult {
	let accumulatedTokens = 0;
	const { latestSuccessfulMutationByPathGroup, failedCallIds } = buildAssistantArgumentStalenessIndex(entries);
	const argumentFenceStart = recentTurnFenceStart(entries, config.protectRecentTurns ?? 2);
	const candidates: Array<{
		entry: SessionMessageEntry;
		call: ToolCall;
		pathHints: string[];
		originalChars: number;
	}> = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		// Same newest-turn fence as tool-output pruning: edit/apply_patch
		// arguments in the active (or otherwise protected) turn are live
		// context, even when a later call in that turn superseded their path.
		if (argumentFenceStart !== undefined && i >= argumentFenceStart) continue;
		const message = entry.message as AgentMessage;
		if (message.role !== "assistant") continue;
		const entryTokens = estimateEntryTokens(entry);
		const insideProtectWindow = accumulatedTokens < config.protectTokens;
		accumulatedTokens += entryTokens;
		for (const content of message.content) {
			if (content.type !== "toolCall" || !isEditToolCall(content)) continue;
			const argumentJson = JSON.stringify(content.arguments);
			if (argumentJson === undefined) continue;
			const originalChars = argumentJson.length;
			if (isPrunedToolArgumentsSentinel(content.arguments)) continue;
			if (insideProtectWindow || failedCallIds.has(content.id)) continue;
			const groups = editToolPathGroups(content);
			if (groups.length === 0) continue;
			// Arguments are pruned as one indivisible payload, so require EVERY
			// concrete path group to be stale from a later successful mutation.
			// A group with no later success (failed/unknown/ambiguous) protects the
			// whole call rather than dropping non-stale multi-file patch evidence.
			const isStale = groups.every(group => {
				const latest = latestSuccessfulMutationByPathGroup.get(pathGroupKey(group));
				return latest !== undefined && latest.index > i && latest.callId !== content.id;
			});
			if (!isStale) continue;
			candidates.push({
				entry: entry as SessionMessageEntry,
				call: content,
				pathHints: pathHintsForGroups(groups),
				originalChars,
			});
		}
	}

	if (candidates.length === 0) {
		return { argumentPrunedCount: 0, argumentTokensSaved: 0, prunedEntries: [] };
	}

	const prunedAt = Date.now();
	const candidatesByEntry = new Map<SessionMessageEntry, typeof candidates>();
	for (const candidate of candidates) {
		const group = candidatesByEntry.get(candidate.entry);
		if (group) group.push(candidate);
		else candidatesByEntry.set(candidate.entry, [candidate]);
	}

	let argumentTokensSaved = 0;
	const admittedGroups: Array<{ entry: SessionMessageEntry; candidates: typeof candidates }> = [];
	for (const [entry, entryCandidates] of candidatesByEntry) {
		const candidateByCallId = new Map(entryCandidates.map(candidate => [candidate.call.id, candidate]));
		const message = entry.message as AgentMessage;
		if (message.role !== "assistant") continue;
		const stagedEntry = {
			...entry,
			message: {
				...message,
				content: message.content.map(content => {
					if (content.type !== "toolCall") return content;
					const candidate = candidateByCallId.get(content.id);
					if (!candidate) return content;
					return {
						...content,
						arguments: {
							pruned: true,
							reason: "stale_tool_arguments",
							pathHints: candidate.pathHints,
							originalChars: candidate.originalChars,
							prunedAt,
						} satisfies PrunedToolArgumentsSentinel,
					};
				}),
			},
		} as SessionMessageEntry;
		const savings = Math.max(0, estimateEntryTokens(entry) - estimateEntryTokens(stagedEntry));
		if (savings === 0) continue;
		argumentTokensSaved += savings;
		admittedGroups.push({ entry, candidates: entryCandidates });
	}

	if (argumentTokensSaved < config.minimumSavings || admittedGroups.length === 0) {
		return { argumentPrunedCount: 0, argumentTokensSaved: 0, prunedEntries: [] };
	}

	let argumentPrunedCount = 0;
	const prunedEntries: SessionMessageEntry[] = [];
	for (const group of admittedGroups) {
		for (const candidate of group.candidates) {
			candidate.call.arguments = {
				pruned: true,
				reason: "stale_tool_arguments",
				pathHints: candidate.pathHints,
				originalChars: candidate.originalChars,
				prunedAt,
			};
			argumentPrunedCount++;
		}
		prunedEntries.push(group.entry);
	}
	return { argumentPrunedCount, argumentTokensSaved, prunedEntries };
}

interface ToolOutputPruneCandidate {
	entry: SessionMessageEntry;
	call?: ToolCall;
	tokens: number;
	originalText: string;
	complete: boolean;
	notice: string;
	savings: number;
}

function recentTurnFenceStart(entries: SessionEntry[], protectRecentTurns: number): number | undefined {
	if (protectRecentTurns <= 0) return undefined;
	const starts: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const role = entry.message.role as string;
		if (role === "user" || role === "bashExecution") starts.push(i);
	}
	return starts.length === 0 ? undefined : starts[Math.max(0, starts.length - protectRecentTurns)];
}

/**
 * Read-only candidate collection shared by the digest-only plan and the
 * non-mutating {@link estimateToolOutputPruneSavings} gate.
 */
function collectToolOutputPruneCandidates(
	entries: SessionEntry[],
	config: PruneConfig,
): { candidates: ToolOutputPruneCandidate[]; tokensSaved: number } {
	let accumulatedTokens = 0;

	const { staleResultIndices } = buildStalenessIndex(entries);
	const callsById = new Map<string, ToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const content of entry.message.content) {
			if (content.type === "toolCall") callsById.set(content.id, content);
		}
	}
	const fenceStart = recentTurnFenceStart(entries, config.protectRecentTurns ?? 2);
	const staleOverridable = new Set(config.staleOverridableTools ?? []);
	const candidates: ToolOutputPruneCandidate[] = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateEntryTokens(entry);
		const isStale = staleResultIndices.has(i);
		// Staleness waives protected-tool immunity for overridable tools
		// (e.g. a superseded `read`); the most recent result per target is
		// never stale, so the latest read of each file stays protected.
		const isProtected =
			config.protectedTools.includes(message.toolName) && !(isStale && staleOverridable.has(message.toolName));

		if (message.prunedAt !== undefined || (fenceStart !== undefined && i >= fenceStart)) {
			accumulatedTokens += tokens;
			continue;
		}

		// Stale results are prunable even inside the recency protect window —
		// they are superseded, so recency no longer implies relevance. They
		// still count toward window accounting so non-stale protection is
		// unchanged.
		const insideProtectWindow = accumulatedTokens < config.protectTokens;
		if ((insideProtectWindow && !isStale) || isProtected) {
			accumulatedTokens += tokens;
			continue;
		}

		const call = callsById.get(message.toolCallId);
		const captured = extractToolOutputText(message);
		const notice = createPrunedNotice(tokens, message, call);
		const savings = estimatePrunedSavings(tokens, notice);
		const errorNoticeGrows = message.isError === true && notice.length > captured.text.length;
		if (savings <= 0 || errorNoticeGrows) {
			accumulatedTokens += tokens;
			continue;
		}
		candidates.push({
			entry: entry as SessionMessageEntry,
			call,
			tokens,
			originalText: captured.text,
			complete: captured.complete,
			notice,
			savings,
		});

		accumulatedTokens += tokens;
	}

	let tokensSaved = 0;
	for (const candidate of candidates) {
		tokensSaved += candidate.savings;
	}
	return { candidates, tokensSaved };
}

function minimumSavings(config: PruneConfig, options: PruneToolOutputsOptions = {}): number {
	const relaxedMinimum = options.relaxedMinimum;
	return typeof relaxedMinimum === "number" && Number.isFinite(relaxedMinimum)
		? Math.min(config.minimumSavings, Math.max(0, relaxedMinimum))
		: config.minimumSavings;
}

/**
 * Estimate conservative savings for a digest-only prune plan without mutating
 * entries or invoking artifact publication.
 */
export function estimateToolOutputPruneSavings(
	entries: SessionEntry[],
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
	options: PruneToolOutputsOptions = {},
): { prunableCount: number; tokensSaved: number } {
	const { candidates, tokensSaved: baseTokensSaved } = collectToolOutputPruneCandidates(entries, config);
	const minimum = minimumSavings(config, options);
	if (baseTokensSaved < minimum || candidates.length === 0) return { prunableCount: 0, tokensSaved: 0 };
	const planned = planToolOutputPruneCandidates(candidates, options);
	const tokensSaved = planned.reduce((total, candidate) => total + candidate.savings, 0);
	if (tokensSaved < minimum || planned.length === 0) return { prunableCount: 0, tokensSaved: 0 };
	return { prunableCount: planned.length, tokensSaved };
}

/**
 * Evidence gate for below-threshold maintenance pruning (Finding 13). Pruning
 * forces a prompt-cache-epoch reset, so it only runs when opted in AND the
 * estimated stale savings clear a high minimum AND exceed the one-time reset
 * cost (so the reclaim pays the reset back). Default-off/blocked until live
 * evidence justifies enabling.
 */
export function shouldRunMaintenancePrune(args: {
	enabled: boolean;
	estimatedSavings: number;
	minSavings: number;
	cacheEpochResetCost: number;
}): boolean {
	if (!args.enabled) return false;
	if (args.estimatedSavings < args.minSavings) return false;
	return args.estimatedSavings > args.cacheEpochResetCost;
}

const MAX_ARTIFACT_REF_CHARS = 16_384;

export interface PruneToolOutputsOptions {
	/** Lower the usual minimum only when the caller is already over its compaction threshold. */
	relaxedMinimum?: number;
	/** Conservative maximum ASCII length of every planned artifact reference. */
	artifactRefMaxChars?: number;
}

interface PlannedToolOutputPruneCandidate extends ToolOutputPruneCandidate {}

function artifactRefMaxChars(options: PruneToolOutputsOptions): number {
	const maxChars = options.artifactRefMaxChars;
	if (maxChars === undefined) return 0;
	if (!Number.isSafeInteger(maxChars) || maxChars <= 0 || maxChars > MAX_ARTIFACT_REF_CHARS) {
		throw new RangeError(`artifactRefMaxChars must be an integer between 1 and ${MAX_ARTIFACT_REF_CHARS}`);
	}
	return maxChars;
}

function planToolOutputPruneCandidates(
	candidates: ToolOutputPruneCandidate[],
	options: PruneToolOutputsOptions,
): PlannedToolOutputPruneCandidate[] {
	const maxArtifactChars = artifactRefMaxChars(options);
	const artifactBudget = maxArtifactChars > 0 ? "x".repeat(maxArtifactChars) : undefined;
	return candidates.flatMap(candidate => {
		const notice = createPrunedNotice(
			candidate.tokens,
			candidate.entry.message as ToolResultMessage,
			candidate.call,
			candidate.complete ? artifactBudget : undefined,
		);
		const savings = estimatePrunedSavings(candidate.tokens, notice);
		const errorNoticeGrows =
			(candidate.entry.message as ToolResultMessage).isError === true &&
			notice.length > candidate.originalText.length;
		return savings > 0 && !errorNoticeGrows ? [{ ...candidate, notice, savings }] : [];
	});
}

function emptyToolOutputPrunePlan(): ToolOutputPrunePlan {
	return { prunedCount: 0, tokensSaved: 0, digests: [], replacements: [] };
}

/**
 * Build a digest-only pruning plan. This function is deliberately read-only:
 * candidates are inspected in private locals and the returned plan never keeps
 * references to the source entries or their original output text.
 */
export function planToolOutputPrune(
	entries: SessionEntry[],
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
	options: PruneToolOutputsOptions = {},
): ToolOutputPrunePlan {
	const { candidates, tokensSaved: baseTokensSaved } = collectToolOutputPruneCandidates(entries, config);
	const minimum = minimumSavings(config, options);
	if (baseTokensSaved < minimum || candidates.length === 0) return emptyToolOutputPrunePlan();

	const planned = planToolOutputPruneCandidates(candidates, options);
	const tokensSaved = planned.reduce((total, candidate) => total + candidate.savings, 0);
	if (tokensSaved < minimum || planned.length === 0) return emptyToolOutputPrunePlan();

	const digests = planned.map(candidate => ({
		entryId: candidate.entry.id,
		bytes: Buffer.byteLength(candidate.originalText, "utf8"),
		sha256: createHash("sha256").update(candidate.originalText, "utf8").digest("hex"),
	}));
	const replacements = planned.map(candidate => ({
		entryId: candidate.entry.id,
		replacementText: candidate.notice,
		complete: candidate.complete,
		tokens: candidate.tokens,
	}));
	return Object.freeze({
		prunedCount: planned.length,
		tokensSaved,
		digests: Object.freeze(digests),
		replacements: Object.freeze(replacements),
	});
}

/**
 * Re-check and commit a digest-only plan against the supplied live entries.
 * Each entry is mutated only after its canonical full-text digest matches.
 */
export function commitToolOutputPrune(
	entries: SessionEntry[],
	plan: ToolOutputPrunePlan,
	options: ToolOutputPruneCommitOptions = {},
): ToolOutputCommitOutcome[] {
	const byId = new Map(entries.filter((e): e is SessionMessageEntry => e.type === "message").map(e => [e.id, e]));
	const proposals = new Map(plan.replacements.map(replacement => [replacement.entryId, replacement]));
	return plan.digests.map(digest => {
		const entry = byId.get(digest.entryId);
		if (!entry) return { entryId: digest.entryId, outcome: "unavailable", diagnostic: "entry not found" };
		const message = entry.message as ToolResultMessage;
		const captured = extractToolOutputText(message);
		const bytes = Buffer.byteLength(captured.text, "utf8");
		const sha = createHash("sha256").update(captured.text, "utf8").digest("hex");
		if (bytes !== digest.bytes || sha !== digest.sha256) {
			return { entryId: digest.entryId, outcome: "mismatch", diagnostic: "tool output changed before commit" };
		}
		const proposal = proposals.get(digest.entryId);
		if (!proposal) return { entryId: digest.entryId, outcome: "unavailable", diagnostic: "replacement proposal missing" };
		const override = options.replacements?.get(digest.entryId);
		const replacementText = override?.replacementText ?? proposal.replacementText;
		message.content = [{ type: "text", text: replacementText }];
		message.prunedAt = Date.now();
		if (override?.eviction) {
			const details =
				message.details && typeof message.details === "object" && !Array.isArray(message.details)
					? (message.details as Record<string, unknown>)
					: {};
			const meta = details.meta && typeof details.meta === "object" && !Array.isArray(details.meta)
					? (details.meta as Record<string, unknown>)
					: {};
			message.details = { ...details, meta: { ...meta, eviction: override.eviction } };
		}
		return { entryId: digest.entryId, outcome: "committed" };
	});
}
