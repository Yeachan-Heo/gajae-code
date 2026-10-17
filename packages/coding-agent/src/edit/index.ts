import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import type * as z from "zod/v4";
import {
	executeHashlineSingle,
	type HashlineEdit,
	HashlineMismatchError,
	type HashlineParams,
	hashlineEditParamsSchema,
	parseHashline,
	splitHashlineInputs,
} from "../hashline";
import hashlineGrammarTemplate from "../hashline/grammar.lark" with { type: "text" };
import { resolveHashlineGrammarPlaceholders } from "../hashline/hash";
import {
	createLspWritethrough,
	type FileDiagnosticsResult,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
	writethroughNoop,
} from "../lsp";
import applyPatchDescription from "../prompts/tools/apply-patch.md" with { type: "text" };
import hashlineDescription from "../prompts/tools/hashline.md" with { type: "text" };
import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { assertEditableFile } from "../tools/auto-generated-guard";
import { resolvePlanPath } from "../tools/plan-mode-guard";
import { VimTool, vimSchema } from "../tools/vim";
import { type EditMode, resolveEditMode, resolveForcedEnvEditMode } from "../utils/edit-mode";
import type { VimToolDetails } from "../vim/types";
import { normalizeCreateContent } from "./diff";
import {
	type ApplyPatchEntry,
	type ApplyPatchParams,
	applyPatchSchema,
	expandApplyPatchToEntries,
	expandApplyPatchToPreviewEntries,
} from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import {
	executePatchSingle,
	type PatchEditEntry,
	type PatchParams,
	patchEditEntrySchema,
	patchEditSchema,
} from "./modes/patch";
import { executeReplaceEntries, type ReplaceEditEntry, type ReplaceParams, replaceEditSchema } from "./modes/replace";
import { type EditToolDetails, type EditToolPerFileResult, getLspBatchRequest, type LspBatchRequest } from "./renderer";

export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";
export * from "./apply-patch";
export * from "./diff";
export * from "./file-read-cache";

// Resolve the `$HFMT$`, `$HOP_*$`, `$HOP_CHARS$`, and `$HFILE$` placeholders in the hashline Lark grammar.
const hashlineGrammar = resolveHashlineGrammarPlaceholders(hashlineGrammarTemplate);

export * from "../hashline";
export * from "./modes/apply-patch";
export * from "./modes/patch";
export * from "./modes/replace";
export * from "./normalize";
export * from "./renderer";
export * from "./streaming";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof vimSchema
	| typeof applyPatchSchema;

type VimParams = z.infer<typeof vimSchema>;
type EditParams = ReplaceParams | PatchParams | HashlineParams | VimParams | ApplyPatchParams;
type EditToolResultDetails = EditToolDetails | VimToolDetails;

/** Diff bodies introduce only `+` rows, not unified-diff file headers. */
function addedPatchDigest(diff: string): string | undefined {
	const added = diff.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++ "));
	return added.length > 0 ? added.map(line => line.slice(1)).join("\n") : undefined;
}

const UNSAFE_EDIT_SUMMARY_PATH =
	/(?:\b(?:https?|wss?):\/\/|\b(?:api[-_ ]?key|access[-_ ]?token|bearer|secret|password)\b|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,})/i;

const MAX_APPLY_PATCH_ACTIVITY_FILES = 2;

function isSafeEditSummaryPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 100 && !UNSAFE_EDIT_SUMMARY_PATH.test(value);
}

/** Summarize only apply_patch file-operation headers, never its patch body. */
function summarizeApplyPatchActivity(input: string): string | undefined {
	if (!input.trimStart().startsWith("*** Begin Patch")) return undefined;

	const paths: string[] = [];
	const marker = /^\*\*\* (?:Add|Delete|Update) File: ([^\r\n]+)\r?$/gm;
	let count = 0;
	let match = marker.exec(input);
	while (match !== null) {
		const editPath = match[1]!.trim();
		if (!isSafeEditSummaryPath(editPath)) return undefined;
		count++;
		if (paths.length < MAX_APPLY_PATCH_ACTIVITY_FILES) paths.push(editPath);
		match = marker.exec(input);
	}
	if (count === 0) return undefined;

	const displayedPaths =
		count > MAX_APPLY_PATCH_ACTIVITY_FILES ? `${paths.join(", ")}, +${count - paths.length} more` : paths.join(", ");
	return `${displayedPaths}, ${count} edit${count === 1 ? "" : "s"}`;
}

/** Project edit targets and operation counts without exposing patches, diffs, or file contents. */
export function summarizeEditToolActivity(kind: "args" | "result", value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (kind === "args") {
		const applyPatchInput = record.input;
		if (typeof applyPatchInput === "string") return summarizeApplyPatchActivity(applyPatchInput);

		const editPath = record.path;
		if (!isSafeEditSummaryPath(editPath)) return undefined;
		const edits = record.edits;
		const count = Array.isArray(edits) ? edits.length : 1;
		return `${editPath}, ${count} edit${count === 1 ? "" : "s"}`;
	}

	const details = record.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const perFileResults = (details as Record<string, unknown>).perFileResults;
	const count = Array.isArray(perFileResults)
		? perFileResults.length
		: "path" in (details as Record<string, unknown>)
			? 1
			: 0;
	if (count === 0) return undefined;
	const failed =
		record.isError === true ||
		(Array.isArray(perFileResults) &&
			perFileResults.some(
				entry => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).isError === true,
			));
	return `${failed ? "failed" : "applied"}, ${count} file${count === 1 ? "" : "s"}`;
}
type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolResultDetails, TInput>) => void,
	) => Promise<AgentToolResult<EditToolResultDetails, TInput>>;
};

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid PI_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid PI_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}

	return threshold;
}

function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	return enableLsp ? createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics }) : writethroughNoop;
}

type PatchGuardFailure = { path: string; errorText: string };

/**
 * Refuse a generated source or rename destination before any entry writes.
 * A single entry still throws. Several entries return the per-entry errors
 * the patch aggregators already use, and the caller writes nothing.
 */
async function collectPatchGuardFailures(
	session: ToolSession,
	entries: { path: string; rename?: string }[],
	signal?: AbortSignal,
): Promise<PatchGuardFailure[] | undefined> {
	const failures: PatchGuardFailure[] = [];
	const aggregate = entries.length > 1;
	for (const entry of entries) {
		signal?.throwIfAborted();
		try {
			const resolvedPath = resolvePlanPath(session, entry.path);
			await assertEditableFile(resolvedPath, entry.path, session.settings);
			signal?.throwIfAborted();
			if (!entry.rename) continue;
			const resolvedRename = resolvePlanPath(session, entry.rename);
			if (resolvedRename === resolvedPath) continue;
			await assertEditableFile(resolvedRename, entry.rename, session.settings);
			signal?.throwIfAborted();
		} catch (err) {
			signal?.throwIfAborted();
			if (!aggregate || (err instanceof Error && err.name === "AbortError")) throw err;
			failures.push({ path: entry.path, errorText: err instanceof Error ? err.message : String(err) });
		}
	}
	return failures.length > 0 ? failures : undefined;
}

function refusedPatchEntriesResult(
	failures: PatchGuardFailure[],
	details: { path?: string; perFileResults?: EditToolPerFileResult[] },
): AgentToolResult<EditToolDetails, TInput> {
	return {
		content: [
			{
				type: "text",
				text: failures.map(failure => `Error editing ${failure.path}: ${failure.errorText}`).join("\n"),
			},
		],
		details: { diff: "", ...details },
		isError: true,
	};
}

/** Run apply_patch file operations and aggregate their multi-file result. */
async function executeApplyPatchPerFile(
	fileEntries: {
		path: string;
		run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>;
	}[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];

	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		const isLast = i === fileEntries.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			const details = result.details;
			perFileResults.push({
				path: details?.path ?? path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				move: details?.move,
				meta: details?.meta,
				oldText: details?.oldText,
				newText: details?.newText,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
		}

		// Emit partial result after each file so UI shows progressive completion
		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: [...perFileResults],
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		},
	};
}

async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	const contentTexts: string[] = [];
	const diffTexts: string[] = [];
	let firstChangedLine: number | undefined;
	let errorCount = 0;
	let metadataPath: string | undefined;
	let hasFirstOldText = false;
	let firstOldText: string | undefined;
	let hasLastNewText = false;
	let lastNewText: string | undefined;

	for (let i = 0; i < runs.length; i++) {
		const isLast = i === runs.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await runs[i](batchRequest);
			const details = result.details;
			if (details?.diff) diffTexts.push(details.diff);
			firstChangedLine ??= details?.firstChangedLine;
			if (details?.path) {
				metadataPath ??= details.path;
			}
			if (details && "oldText" in details && !hasFirstOldText) {
				firstOldText = details.oldText;
				hasFirstOldText = true;
			}
			if (details && "newText" in details) {
				lastNewText = details.newText;
				hasLastNewText = true;
			}
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			contentTexts.push(`Error editing ${path}: ${errorText}`);
			errorCount++;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: diffTexts.join("\n"),
					firstChangedLine,
				},
				...(errorCount > 0 ? { isError: true } : {}),
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: {
			diff: diffTexts.join("\n"),
			firstChangedLine,
			path: metadataPath ?? path,
			...(hasFirstOldText ? { oldText: firstOldText } : {}),
			...(hasLastNewText ? { newText: lastNewText } : {}),
		},
		// Any per-entry failure marks the aggregate result as an error so the
		// renderer takes the error branch instead of falling through to the
		// streaming-edit preview (which displays the *proposed* diff and looks
		// indistinguishable from success).
		...(errorCount > 0 ? { isError: true } : {}),
	};
}

export class EditTool implements AgentTool<TInput> {
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly nonAbortable = true;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly safeSummary = summarizeEditToolActivity;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #vimTool: VimTool;
	readonly #pendingDeferredFetches = new Map<string, AbortController>();

	constructor(
		private readonly session: ToolSession,
		private readonly modeOverride?: EditMode,
	) {
		const { PI_EDIT_FUZZY: editFuzzy = "auto", PI_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto" } = Bun.env;

		// Fail fast on an invalid forced env variant; the shared resolver owns
		// env precedence at resolution time (no separate cache here).
		resolveForcedEnvEditMode();
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		this.#writethrough = createEditWritethrough(session);
		this.#vimTool = new VimTool(session);
	}

	get mode(): EditMode {
		return this.modeOverride ?? resolveEditMode(this.session);
	}

	get description(): string {
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	matcherDigest(args: unknown): string | undefined {
		const digest = this.matcherEntries(args)
			?.map(entry => entry.digest)
			.filter(Boolean)
			.join("\n");
		return digest || undefined;
	}

	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		try {
			if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
			const record = args as Record<string, unknown>;
			const digests = new Map<string, string>();
			const add = (path: string, digest: string | undefined) => {
				if (!path || digest === undefined) return;
				const current = digests.get(path);
				digests.set(path, current === undefined ? digest : `${current}\n${digest}`);
			};

			switch (this.mode) {
				case "replace": {
					if (typeof record.path !== "string" || !Array.isArray(record.edits)) return undefined;
					for (const entry of record.edits) {
						if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
						const text = (entry as Record<string, unknown>).new_text;
						if (text !== undefined && typeof text !== "string") return undefined;
						add(record.path, text);
					}
					break;
				}
				case "patch": {
					if (typeof record.path !== "string" || !Array.isArray(record.edits)) return undefined;
					for (const entry of record.edits) {
						const parsed = patchEditEntrySchema.safeParse(entry);
						if (!parsed.success) return undefined;
						const { diff, op, rename } = parsed.data;
						if (op === "delete" || diff === undefined) continue;
						// A create body is digested exactly as the writer will persist it.
						add(rename ?? record.path, op === "create" ? normalizeCreateContent(diff) : addedPatchDigest(diff));
					}
					break;
				}
				case "hashline": {
					const parsed = hashlineEditParamsSchema.safeParse(args);
					if (!parsed.success) return undefined;
					for (const section of splitHashlineInputs(parsed.data.input, {
						path: parsed.data.path,
						cwd: this.session.cwd,
					})) {
						// A section still streaming (e.g. a trailing op with no anchor yet)
						// does not parse; it contributes nothing, but earlier complete
						// sections keep their entries (as pi-edit's hashline inspect does).
						let edits: HashlineEdit[];
						try {
							edits = parseHashline(section.diff);
						} catch {
							continue;
						}
						const inserted = edits.filter(edit => edit.kind === "insert");
						if (inserted.length > 0) add(section.path, inserted.map(edit => edit.text).join("\n"));
					}
					break;
				}
				case "apply_patch": {
					const parsed = applyPatchSchema.safeParse(args);
					if (!parsed.success) return undefined;
					let entries: ApplyPatchEntry[];
					try {
						entries = expandApplyPatchToEntries(parsed.data);
					} catch {
						entries = expandApplyPatchToPreviewEntries(parsed.data);
					}
					for (const entry of entries) {
						if (entry.op === "delete" || entry.diff === undefined) continue;
						// The envelope parser already strips Add File prefixes.
						add(entry.rename ?? entry.path, entry.op === "create" ? entry.diff : addedPatchDigest(entry.diff));
					}
					break;
				}
				case "vim":
					return undefined;
			}

			return digests.size > 0 ? Array.from(digests, ([path, digest]) => ({ path, digest })) : undefined;
		} catch {
			// Streamed arguments can be incomplete or malformed in any mode.
			return undefined;
		}
	}

	/**
	 * When in `apply_patch` mode, expose the OpenAI code backend Lark grammar so providers
	 * that support OpenAI-style custom tools can emit a grammar-constrained
	 * variant. Providers that don't support custom tools ignore this field
	 * and fall back to emitting a JSON function tool from `parameters`.
	 */
	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		if (this.mode === "apply_patch") return { syntax: "lark", definition: applyPatchGrammar };
		if (this.mode === "hashline") return { syntax: "lark", definition: hashlineGrammar };
		return undefined;
	}

	/**
	 * Wire-level tool name used when the custom-tool variant is active. GPT-5+
	 * is trained on the literal name `apply_patch`; internally this is just a
	 * mode of the `edit` tool. The agent-loop dispatcher matches both the
	 * internal `name` and `customWireName`, so returned calls route correctly.
	 */
	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolResultDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolResultDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		return modeDefinition.execute(this, params, signal, getLspBatchRequest(context?.toolCall), onUpdate);
	}

	#getModeDefinition(): EditModeDefinition {
		return {
			patch: {
				description: () => prompt.render(patchDescription),
				parameters: patchEditSchema,
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as PatchParams;
					const patchEdits = edits as PatchEditEntry[];
					const guardFailures = await collectPatchGuardFailures(
						tool.session,
						patchEdits.map(entry => ({ path, rename: entry.rename })),
						signal,
					);
					if (guardFailures) return refusedPatchEntriesResult(guardFailures, { path });
					const runs = patchEdits.map(
						entry => (br: LspBatchRequest | undefined) =>
							executePatchSingle({
								session: tool.session,
								path,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
							}),
					);
					return executeSinglePathEntries(path, runs, batchRequest, onUpdate);
				},
			},
			apply_patch: {
				description: () => prompt.render(applyPatchDescription),
				parameters: applyPatchSchema,
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					const guardFailures = await collectPatchGuardFailures(
						tool.session,
						entries.map(entry => ({ path: entry.path, rename: entry.rename })),
						signal,
					);
					if (guardFailures) {
						return refusedPatchEntriesResult(guardFailures, {
							perFileResults: guardFailures.map(failure => ({
								path: failure.path,
								diff: "",
								isError: true,
								errorText: failure.errorText,
							})),
						});
					}
					const perFile = entries.map(entry => {
						const { path, ...patchParams } = entry;
						return {
							path,
							run: (br: LspBatchRequest | undefined) =>
								executePatchSingle({
									session: tool.session,
									path,
									params: patchParams,
									signal,
									batchRequest: br,
									allowFuzzy: tool.#allowFuzzy,
									fuzzyThreshold: tool.#fuzzyThreshold,
									writethrough: tool.#writethrough,
									beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
								}),
						};
					});
					return executeApplyPatchPerFile(perFile, batchRequest, onUpdate);
				},
			},
			hashline: {
				description: () => prompt.render(hashlineDescription),
				parameters: hashlineEditParamsSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { input, path } = params as HashlineParams & { path?: string };
					return executeHashlineSingle({
						session: tool.session,
						input,
						path,
						signal,
						batchRequest,
						writethrough: tool.#writethrough,
						beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
					});
				},
			},
			replace: {
				description: () => prompt.render(replaceDescription),
				parameters: replaceEditSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
				) => {
					const { edits, path } = params as ReplaceParams;
					return executeReplaceEntries({
						session: tool.session,
						path,
						edits: edits as ReplaceEditEntry[],
						signal,
						batchRequest,
						allowFuzzy: tool.#allowFuzzy,
						fuzzyThreshold: tool.#fuzzyThreshold,
						writethrough: tool.#writethrough,
						beginDeferredDiagnosticsForPath: p => tool.#beginDeferredDiagnosticsForPath(p),
					});
				},
			},
			vim: {
				description: () => this.#vimTool.description,
				parameters: vimSchema,
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					_batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolResultDetails, TInput>) => void,
				) => {
					const handleUpdate = onUpdate
						? (partialResult: AgentToolResult<VimToolDetails>) => {
								onUpdate(partialResult as AgentToolResult<EditToolResultDetails, TInput>);
							}
						: undefined;
					return (await tool.#vimTool.execute(
						"edit",
						params as VimParams,
						signal,
						handleUpdate,
					)) as AgentToolResult<EditToolResultDetails, TInput>;
				},
			},
		}[this.mode];
	}

	#beginDeferredDiagnosticsForPath(path: string): WritethroughDeferredHandle {
		const existingDeferred = this.#pendingDeferredFetches.get(path);
		if (existingDeferred) {
			existingDeferred.abort();
			this.#pendingDeferredFetches.delete(path);
		}

		const deferredController = new AbortController();
		return {
			onDeferredDiagnostics: (lateDiagnostics: FileDiagnosticsResult) => {
				this.#pendingDeferredFetches.delete(path);
				this.#injectLateDiagnostics(path, lateDiagnostics);
			},
			signal: deferredController.signal,
			finalize: (diagnostics: FileDiagnosticsResult | undefined) => {
				if (!diagnostics) {
					this.#pendingDeferredFetches.set(path, deferredController);
				} else {
					deferredController.abort();
				}
			},
		};
	}

	#injectLateDiagnostics(path: string, diagnostics: FileDiagnosticsResult): void {
		const summary = diagnostics.summary ?? "";
		const lines = diagnostics.messages ?? [];
		const body = [`Late LSP diagnostics for ${path} (arrived after the edit tool returned):`, summary, ...lines]
			.filter(Boolean)
			.join("\n");

		this.session.queueDeferredMessage?.({
			role: "custom",
			customType: "lsp-late-diagnostic",
			content: body,
			display: false,
			timestamp: Date.now(),
		});
	}
}
