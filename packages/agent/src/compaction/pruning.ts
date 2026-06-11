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
import { estimateTokens } from "./compaction";
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

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number): number {
	const noticeTokens = Math.ceil(createPrunedNotice(tokens).length / 4);
	return Math.max(0, tokens - noticeTokens);
}

const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch", "ast_edit"]);

/** Extract the file-path argument from a tool call, when the tool has one. */
function toolCallPath(call: ToolCall): string | undefined {
	const args = call.arguments;
	const path = args.path ?? args.file_path ?? args.filePath;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * `*** Add|Update|Delete File: <path>` and `*** Move to: <path>` headers in
 * an apply_patch envelope. Move destinations count as touched paths: a rename
 * onto a file invalidates earlier reads of that destination.
 */
const APPLY_PATCH_FILE_HEADER = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

/**
 * Paths touched by an edit-class tool call. Most edit tools carry a single
 * path argument; apply_patch envelopes carry an `input` string with
 * `*** <Op> File:` / `*** Move to:` headers instead. The envelope shape can
 * arrive under the custom `apply_patch` tool OR the regular `edit` tool
 * (providers without custom-tool support fall back to the JSON function), so
 * any edit-class call with a string `input` is parsed for headers.
 */
function editToolPaths(call: ToolCall): string[] {
	const path = toolCallPath(call);
	if (path !== undefined) return [path];
	const input = call.arguments.input;
	if (typeof input !== "string") return [];
	const paths: string[] = [];
	for (const match of input.matchAll(APPLY_PATCH_FILE_HEADER)) {
		const headerPath = match[1]?.trim();
		if (headerPath) paths.push(headerPath);
	}
	return paths;
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

/**
 * Stable identity for "the same logical lookup": same tool re-targeting the
 * same subject. A later result with the same key supersedes earlier ones.
 * Keys are canonical JSON tuples so user-controlled text (patterns, paths)
 * can never collide via delimiter ambiguity. Search keys include pagination
 * (`skip`) and result-shaping flags (`i`, `gitignore`): a later page or a
 * differently-shaped search complements earlier output, it does not replace it.
 */
function toolTargetKey(call: ToolCall): string | undefined {
	const path = toolCallPath(call);
	if (path !== undefined) return JSON.stringify([call.name, "path", path]);
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
 * apply step), which report `{ applied: true, files: [...] }`. Conservative:
 * returns nothing unless the details explicitly mark the change as applied.
 */
function resultDetailFiles(message: ToolResultMessage): string[] {
	const details = message.details as { applied?: unknown; files?: unknown } | undefined;
	if (details?.applied !== true || !Array.isArray(details.files)) return [];
	return details.files.filter((file): file is string => typeof file === "string" && file.length > 0);
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

	const lastResultIndexByKey = new Map<string, number>();
	const resultMeta = new Map<number, { key?: string; call: ToolCall }>();
	const lastEditIndexByPath = new Map<string, number>();

	for (let i = 0; i < entries.length; i++) {
		const message = getToolResultMessage(entries[i]);
		if (!message || message.isError) continue;
		const call = callsById.get(message.toolCallId);
		if (!call) continue;
		const key = toolTargetKey(call);
		resultMeta.set(i, { key, call });
		if (key !== undefined) lastResultIndexByKey.set(key, i);
		if (EDIT_TOOL_NAMES.has(call.name)) {
			for (const editPath of editToolPaths(call)) {
				lastEditIndexByPath.set(editPath, i);
			}
		}
		// AST edits mutate files when previews are applied via the hidden
		// `resolve` tool; the call args carry globs, not concrete paths. Both
		// tools report the actually-touched files in result details.
		if (call.name === "resolve" || call.name === "ast_edit") {
			for (const editPath of resultDetailFiles(message)) {
				lastEditIndexByPath.set(editPath, i);
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
			const path = toolCallPath(meta.call);
			if (path !== undefined) {
				// Selector-qualified reads (src/foo.ts:50-100) still read the file.
				const editIndex = lastEditIndexByPath.get(readBasePath(path));
				if (editIndex !== undefined && editIndex > index) staleResultIndices.add(index);
			}
		}
	}

	return { staleResultIndices };
}

export function pruneToolOutputs(entries: SessionEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const { staleResultIndices } = buildStalenessIndex(entries);
	const staleOverridable = new Set(config.staleOverridableTools ?? []);
	const candidates: Array<{ entry: SessionMessageEntry; tokens: number }> = [];

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);
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

		candidates.push({ entry: entry as SessionMessageEntry, tokens });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(candidate.tokens);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0, prunedEntries: [] };
	}

	const prunedAt = Date.now();
	const prunedEntries: SessionMessageEntry[] = [];
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		message.content = [{ type: "text", text: createPrunedNotice(candidate.tokens) }];
		message.prunedAt = prunedAt;
		prunedEntries.push(candidate.entry);
		prunedCount++;
	}

	return { prunedCount, tokensSaved, prunedEntries };
}
