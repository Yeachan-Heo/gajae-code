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
import type { AgentMessage } from "../types";
import { estimateEntryTokens } from "./compaction";
import type { SessionEntry, SessionMessageEntry } from "./entries";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool names that should never be pruned. */
	protectedTools: string[];
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
	staleOverridableTools: ["read"],
};

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
	/**
	 * The mutated message entries. Callers whose entry source returns
	 * materialized copies (not live references) must write these back into
	 * their canonical store by id.
	 */
	prunedEntries: SessionMessageEntry[];
}

const DIGEST_NOTICE_TOKEN_CAP_MULTIPLIER = 1.25;

function createGenericPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

function firstTextContent(message: ToolResultMessage): string {
	if (typeof message.content === "string") return message.content;
	const block = message.content.find(part => part.type === "text");
	return block?.type === "text" ? block.text : "";
}

function firstErrorLine(text: string): string | undefined {
	return text
		.split(/\r?\n/)
		.find(line => /error|failed|exception|panic/i.test(line))
		?.trim();
}

function truncateField(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	if (maxLength <= 1) return "…";
	return `${value.slice(0, maxLength - 1)}…`;
}

function resultDigest(message: ToolResultMessage): string | undefined {
	const toolName = message.toolName.toLowerCase();
	const text = firstTextContent(message);
	if (toolName === "bash") {
		const details = message as { details?: { exitCode?: unknown } };
		const exitCode =
			typeof details.details?.exitCode === "number" ? details.details.exitCode : message.isError ? 1 : 0;
		const tail = text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
		const error = firstErrorLine(text);
		return [`exit=${exitCode}`, tail ? `tail=${tail}` : undefined, error ? `error=${error}` : undefined]
			.filter((part): part is string => part !== undefined)
			.join("; ");
	}
	if (toolName === "search" || toolName === "grep") {
		const match = text.match(/(\d+)\s+matches?/i) ?? text.match(/totalMatches["']?:\s*(\d+)/i);
		const files = text.match(/(\d+)\s+files?/i) ?? text.match(/filesWithMatches["']?:\s*(\d+)/i);
		const error = firstErrorLine(text);
		return (
			[
				match ? `matches=${match[1]}` : undefined,
				files ? `files=${files[1]}` : undefined,
				error ? `error=${error}` : undefined,
			]
				.filter((part): part is string => part !== undefined)
				.join("; ") || "search digest unavailable"
		);
	}
	return undefined;
}

function createPrunedNotice(tokens: number, message?: ToolResultMessage): string {
	const generic = createGenericPrunedNotice(tokens);
	const digest = message ? resultDigest(message) : undefined;
	if (!digest) return generic;
	const genericTokens = Math.ceil(generic.length / 4);
	const maxTokens = Math.max(genericTokens, Math.floor(genericTokens * DIGEST_NOTICE_TOKEN_CAP_MULTIPLIER));
	const prefix = `[Output truncated - ${tokens} tokens; `;
	const suffix = "]";
	const maxChars = Math.max(0, maxTokens * 4 - prefix.length - suffix.length);
	return `${prefix}${truncateField(digest, maxChars)}${suffix}`;
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
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
		const failed = failedEditPaths(message);
		let mutated = false;
		for (const group of groups) {
			if (group.some(groupPath => failed.has(groupPath))) continue;
			latestSuccessfulMutationByPathGroup.set(pathGroupKey(group), { index: i, callId: call.id });
			mutated = true;
		}
		if (!mutated) failedCallIds.add(call.id);
	}
	return { latestSuccessfulMutationByPathGroup, failedCallIds };
}

/**
 * Trailing read selectors (`:50`, `:50-200`, `:50+150`, `:5-16,960-973`,
 * `:raw`, `:conflicts`), possibly stacked (`:2-4:raw`). Stripped to resolve
 * the underlying file for edit invalidation.
 */
const READ_SELECTOR_SUFFIX = /:(?:raw|conflicts|\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*)$/;

/** Base file path of a read target with any line/mode selectors stripped. */
function readBasePath(path: string): string {
	let base = path;
	while (READ_SELECTOR_SUFFIX.test(base)) {
		base = base.replace(READ_SELECTOR_SUFFIX, "");
	}
	return base;
}

type ReadLineRange = { start: number; end: number };

const DEFAULT_READ_LINE_LIMIT = 500;

/** Parse trailing read selectors using the read tool's actual bounded default. */
function readLineRanges(path: string): ReadLineRange[] {
	let target = path;
	let raw = false;
	while (/:(?:raw|conflicts)$/.test(target)) {
		raw ||= target.endsWith(":raw");
		target = target.replace(/:(?:raw|conflicts)$/, "");
	}
	const match = target.match(/:(\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*)$/);
	if (!match) return raw ? [{ start: 1, end: Number.POSITIVE_INFINITY }] : [];
	return match[1].split(",").flatMap(part => {
		const range = part.match(/^(\d+)(?:([-+])(\d+))?$/);
		if (!range) return [];
		const start = Number(range[1]);
		const end =
			range[2] === "+"
				? start + Number(range[3]) - 1
				: range[2] === "-"
					? Number(range[3])
					: start + DEFAULT_READ_LINE_LIMIT - 1;
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
 * Paths that FAILED in a per-file edit result (`details.perFileResults`) and
 * were NOT mutated by any same-path entry. Multi-file apply_patch catches
 * per-file failures and still returns a non-error result; a purely-failed
 * path was not mutated and must not stale reads. But apply_patch can emit
 * multiple entries for the same path (e.g. several hunks): if any same-path
 * entry succeeded the file still mutated, so it must NOT be suppressed.
 * Conservative: only an entry explicitly marked `isError === true` counts as
 * a failure; anything else (including ambiguous/malformed entries) counts as
 * a success and keeps the path out of the suppression set.
 */
function failedEditPaths(message: ToolResultMessage): Set<string> {
	const details = message.details as { perFileResults?: unknown } | undefined;
	const perFile = details?.perFileResults;
	if (!Array.isArray(perFile)) return new Set();
	const failed = new Set<string>();
	const succeeded = new Set<string>();
	for (const item of perFile) {
		const entry = item as { path?: unknown; isError?: unknown };
		if (typeof entry?.path !== "string") continue;
		if (entry.isError === true) failed.add(entry.path);
		else succeeded.add(entry.path);
	}
	// A path mutated if any same-path entry succeeded, even when another
	// same-path entry failed; drop those from the suppression set.
	for (const path of succeeded) failed.delete(path);
	return failed;
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
			// Per-file edit results record failures in details.perFileResults;
			// a failed hunk mutated nothing, so exclude its whole path group
			// (rename destination included) from touched paths.
			const failed = failedEditPaths(message);
			for (const group of editToolPathGroups(call)) {
				if (group.some(groupPath => failed.has(groupPath))) continue;
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
	let argumentTokensSaved = 0;
	const { latestSuccessfulMutationByPathGroup, failedCallIds } = buildAssistantArgumentStalenessIndex(entries);
	const candidates: Array<{
		entry: SessionMessageEntry;
		call: ToolCall;
		pathHints: string[];
		originalChars: number;
		savings: number;
	}> = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
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
			const isStale =
				groups.length > 0 &&
				groups.every(group => {
					const latest = latestSuccessfulMutationByPathGroup.get(pathGroupKey(group));
					return latest !== undefined && latest.index > i && latest.callId !== content.id;
				});
			if (!isStale) continue;
			const sentinelChars = JSON.stringify({
				pruned: true,
				reason: "stale_tool_arguments",
				pathHints: pathHintsForGroups(groups),
				originalChars,
				prunedAt: 0,
			} satisfies PrunedToolArgumentsSentinel).length;
			candidates.push({
				entry: entry as SessionMessageEntry,
				call: content,
				pathHints: pathHintsForGroups(groups),
				originalChars,
				savings: Math.max(0, Math.ceil((originalChars - sentinelChars) / 4)),
			});
		}
	}

	for (const candidate of candidates) {
		argumentTokensSaved += candidate.savings;
	}
	if (argumentTokensSaved < config.minimumSavings || candidates.length === 0) {
		return { argumentPrunedCount: 0, argumentTokensSaved: 0, prunedEntries: [] };
	}

	const prunedAt = Date.now();
	const prunedEntries: SessionMessageEntry[] = [];
	const prunedEntryIds = new Set<string>();
	for (const candidate of candidates) {
		candidate.call.arguments = {
			pruned: true,
			reason: "stale_tool_arguments",
			pathHints: candidate.pathHints,
			originalChars: candidate.originalChars,
			prunedAt,
		};
		if (!prunedEntryIds.has(candidate.entry.id)) {
			prunedEntries.push(candidate.entry);
			prunedEntryIds.add(candidate.entry.id);
		}
	}
	return { argumentPrunedCount: candidates.length, argumentTokensSaved, prunedEntries };
}

interface ToolOutputPruneCandidate {
	entry: SessionMessageEntry;
	tokens: number;
	notice: string;
	savings: number;
}

/**
 * Read-only pass that collects the tool-result entries that {@link pruneToolOutputs}
 * would prune, plus the total estimated token savings. Shared by the mutating
 * prune and the non-mutating {@link estimateToolOutputPruneSavings} so the
 * maintenance gate (Finding 13) can decide whether pruning is worth a cache-epoch
 * reset without rewriting history.
 */
function collectToolOutputPruneCandidates(
	entries: SessionEntry[],
	config: PruneConfig,
): { candidates: ToolOutputPruneCandidate[]; tokensSaved: number } {
	let accumulatedTokens = 0;

	const { staleResultIndices } = buildStalenessIndex(entries);
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

		if (message.prunedAt !== undefined) {
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

		const notice = createPrunedNotice(tokens, message);
		candidates.push({
			entry: entry as SessionMessageEntry,
			tokens,
			notice,
			savings: estimatePrunedSavings(tokens, notice),
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
 * Estimate the token savings {@link pruneToolOutputs} would achieve, without
 * mutating any entry. Returns 0 savings when below the configured minimum so the
 * caller sees the same gate the real prune enforces.
 */
export function estimateToolOutputPruneSavings(
	entries: SessionEntry[],
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
	options: PruneToolOutputsOptions = {},
): { prunableCount: number; tokensSaved: number } {
	const { candidates, tokensSaved } = collectToolOutputPruneCandidates(entries, config);
	if (tokensSaved < minimumSavings(config, options) || candidates.length === 0) {
		return { prunableCount: 0, tokensSaved: 0 };
	}
	return { prunableCount: candidates.length, tokensSaved };
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

export interface PruneToolOutputsOptions {
	/** Lower the usual minimum only when the caller is already over its compaction threshold. */
	relaxedMinimum?: number;
}

export function pruneToolOutputs(
	entries: SessionEntry[],
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
	options: PruneToolOutputsOptions = {},
): PruneResult {
	const { candidates, tokensSaved } = collectToolOutputPruneCandidates(entries, config);
	const minimum = minimumSavings(config, options);

	if (tokensSaved < minimum || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0, prunedEntries: [] };
	}

	let prunedCount = 0;

	const prunedAt = Date.now();
	const prunedEntries: SessionMessageEntry[] = [];
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		message.content = [{ type: "text", text: candidate.notice }];
		message.prunedAt = prunedAt;
		prunedEntries.push(candidate.entry);
		prunedCount++;
	}

	return { prunedCount, tokensSaved, prunedEntries };
}
