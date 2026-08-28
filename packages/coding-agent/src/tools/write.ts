import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { isEnoent, isRecord, prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { stripHashlinePrefixes } from "../edit";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import { getLanguageFromPath, highlightCode, type Theme } from "../modes/theme/theme";
import writeDescription from "../prompts/tools/write.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { parseArchivePathCandidates } from "./archive-reader";
import { formatFileWriteError, writeFileAtomically } from "./atomic-file-write";
import { assertEditableFile } from "./auto-generated-guard";
import {
	type ConflictEntry,
	expandContentTokens,
	getConflictHistory,
	parseConflictUri,
	spliceConflict,
} from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { type OutputMeta, outputMeta } from "./output-meta";
import { formatPathRelativeToCwd } from "./path-utils";
import { enforcePlanModeWrite, resolvePlanPath } from "./plan-mode-guard";
import {
	formatDiagnostics,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	formatTitle,
	getLspBatchRequest,
	replaceTabs,
	shortenPath,
} from "./render-utils";
import {
	deleteRowByKey,
	deleteRowByRowId,
	insertRow,
	isSqliteFile,
	parseSqlitePathCandidates,
	resolveTableRowLookup,
	updateRowByKey,
	updateRowByRowId,
} from "./sqlite-reader";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

let fflateModulePromise: Promise<typeof import("fflate")> | undefined;
async function loadFflate(): Promise<typeof import("fflate")> {
	if (!fflateModulePromise) fflateModulePromise = import("fflate");
	return fflateModulePromise;
}

const writeSchema = z.object({
	path: z.string().describe("file path"),
	content: z.string().describe("file content"),
});

export type WriteToolInput = z.infer<typeof writeSchema>;

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Only active when hashline edit mode is enabled — the model sees `LINE+ID|`
 * prefixes in read output and sometimes copies them into write content.
 */
function stripWriteContent(session: ToolSession, content: string): { text: string; stripped: boolean } {
	if (!resolveFileDisplayMode(session).hashLines) {
		return { text: content, stripped: false };
	}
	const lines = content.split("\n");
	const cleaned = stripHashlinePrefixes(lines);
	if (cleaned === lines) return { text: content, stripped: false };
	return { text: cleaned.join("\n"), stripped: true };
}

/**
 * Append a trailing note line to the first text block of a tool result.
 * Mutates `result` in place (the result object is owned by this call).
 */
function appendNoteToResult(result: AgentToolResult<WriteToolDetails>, note: string): void {
	const firstText = result.content.find(
		(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
	);
	if (firstText) {
		firstText.text = firstText.text.length > 0 ? `${firstText.text}\n${note}` : note;
	} else {
		result.content.push({ type: "text", text: note });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type WriteParams = WriteToolInput;

interface ResolvedArchiveWritePath {
	absolutePath: string;
	archivePath: string;
	archiveSubPath: string;
	exists: boolean;
}

interface ResolvedSqliteWritePath {
	absolutePath: string;
	sqlitePath: string;
	table: string;
	key?: string;
	exists: boolean;
}

function isArchivePathNotFound(error: unknown): boolean {
	if (isEnoent(error)) return true;
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}

function normalizeArchiveWriteSubPath(rawPath: string): string {
	const normalized = rawPath.replace(/\\/g, "/");
	if (normalized.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}
	if (normalized.endsWith("/")) {
		throw new ToolError("Archive write path must target a file, not a directory");
	}

	const parts = normalized.split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			throw new ToolError("Archive path cannot contain '..'");
		}
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}

	return normalizedParts.join("/");
}

function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
	if (queryString.trim().length > 0) {
		throw new ToolError("SQLite write paths do not support query parameters");
	}

	const normalized = subPath.replace(/^:+/, "").trim();
	if (!normalized) {
		throw new ToolError("SQLite write path must target a table");
	}

	const separatorIndex = normalized.indexOf(":");
	const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1);
	if (!table) {
		throw new ToolError("SQLite write path must target a table");
	}
	if (key !== undefined && key.length === 0) {
		throw new ToolError("SQLite row writes require a non-empty row key");
	}

	return { table, key };
}

/**
 * Write tool implementation.
 *
 * Creates or overwrites files with optional LSP formatting and diagnostics.
 */
export class WriteTool implements AgentTool<typeof writeSchema, WriteToolDetails> {
	readonly name = "write";
	readonly label = "Write";
	readonly description: string;
	readonly parameters = writeSchema;
	readonly nonAbortable = true;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";
	readonly summary = "Write content to a file (creates or overwrites)";

	readonly #writethrough: WritethroughCallback;

	constructor(private readonly session: ToolSession) {
		const enableLsp = session.enableLsp ?? true;
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
		this.#writethrough = enableLsp
			? createLspWritethrough(() => session.cwd, {
					enableFormat,
					enableDiagnostics,
					agentDir: () => session.getSessionAgentDir?.() ?? session.settings.getAgentDir(),
				})
			: writethroughNoop;
		this.description = prompt.render(writeDescription);
	}

	async #resolveArchiveWritePath(writePath: string): Promise<ResolvedArchiveWritePath | null> {
		const candidates = parseArchivePathCandidates(writePath).filter(candidate => candidate.archivePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallback: ResolvedArchiveWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.archivePath),
			archivePath: fallbackCandidate.archivePath,
			archiveSubPath: normalizeArchiveWriteSubPath(fallbackCandidate.subPath),
			exists: false,
		};

		for (const candidate of candidates) {
			const absolutePath = resolvePlanPath(this.session, candidate.archivePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}

				return {
					absolutePath,
					archivePath: candidate.archivePath,
					archiveSubPath: normalizeArchiveWriteSubPath(candidate.subPath),
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		return fallback;
	}

	async #writeArchiveEntry(
		content: string,
		resolvedArchivePath: ResolvedArchiveWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const isZip = resolvedArchivePath.absolutePath.toLowerCase().endsWith(".zip");

		if (isZip) {
			const zipEntries: Record<string, Uint8Array> = {};

			if (resolvedArchivePath.exists) {
				try {
					const bytes = await Bun.file(resolvedArchivePath.absolutePath).bytes();
					const { unzipSync } = await loadFflate();
					const existing = unzipSync(new Uint8Array(bytes));
					for (const [entryPath, data] of Object.entries(existing)) {
						zipEntries[entryPath.replace(/\\/g, "/")] = data;
					}
				} catch (error) {
					throw new ToolError(error instanceof Error ? error.message : String(error));
				}
			}

			zipEntries[resolvedArchivePath.archiveSubPath] = new TextEncoder().encode(content);

			try {
				const { zipSync } = await loadFflate();
				const zipBuffer = zipSync(zipEntries);
				await writeFileAtomically(resolvedArchivePath.absolutePath, zipBuffer);
			} catch (error) {
				throw new ToolError(formatFileWriteError(error, resolvedArchivePath.absolutePath, { destUnchanged: true }));
			}
		} else {
			const archiveEntries: Record<string, string | File> = {};
			if (resolvedArchivePath.exists) {
				let archive: Bun.Archive;
				try {
					archive = new Bun.Archive(await Bun.file(resolvedArchivePath.absolutePath).bytes());
				} catch (error) {
					throw new ToolError(error instanceof Error ? error.message : String(error));
				}

				let files: Map<string, File>;
				try {
					files = await archive.files();
				} catch (error) {
					throw new ToolError(error instanceof Error ? error.message : String(error));
				}

				for (const [entryPath, file] of files) {
					archiveEntries[entryPath.replace(/\\/g, "/")] = file;
				}
			}

			archiveEntries[resolvedArchivePath.archiveSubPath] = content;

			try {
				const archive = new Bun.Archive(archiveEntries);
				const archiveBytes = await archive.bytes();
				await writeFileAtomically(resolvedArchivePath.absolutePath, archiveBytes);
			} catch (error) {
				throw new ToolError(formatFileWriteError(error, resolvedArchivePath.absolutePath, { destUnchanged: true }));
			}
		}

		invalidateFsScanAfterWrite(resolvedArchivePath.absolutePath);
		const outputPath = `${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
			resolvedArchivePath.archiveSubPath
		}`;
		return {
			content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${outputPath}` }],
			details: {},
		};
	}

	async #resolveSqliteWritePath(writePath: string): Promise<ResolvedSqliteWritePath | null> {
		const candidates = parseSqlitePathCandidates(writePath).filter(candidate => candidate.sqlitePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallbackTarget = parseSqliteWriteTarget(fallbackCandidate.subPath, fallbackCandidate.queryString);
		const fallback: ResolvedSqliteWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.sqlitePath),
			sqlitePath: fallbackCandidate.sqlitePath,
			table: fallbackTarget.table,
			key: fallbackTarget.key,
			exists: false,
		};

		let sawExistingNonSqlite = false;
		for (const candidate of candidates) {
			const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString);
			const absolutePath = resolvePlanPath(this.session, candidate.sqlitePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}
				if (!(await isSqliteFile(absolutePath))) {
					sawExistingNonSqlite = true;
					continue;
				}

				return {
					absolutePath,
					sqlitePath: candidate.sqlitePath,
					table: target.table,
					key: target.key,
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		if (sawExistingNonSqlite) {
			return null;
		}

		return fallback;
	}

	async #writeSqliteRow(
		displayPath: string,
		content: string,
		resolvedSqlitePath: ResolvedSqliteWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		let db: Database | null = null;
		try {
			if (!resolvedSqlitePath.exists) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}

			db = new Database(resolvedSqlitePath.absolutePath, { create: false, strict: true });
			db.run("PRAGMA busy_timeout = 3000");

			const trimmedContent = content.trim();
			let resultText: string;
			if (trimmedContent.length === 0) {
				if (!resolvedSqlitePath.key) {
					throw new ToolError("SQLite deletes require a row key in the path");
				}

				const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
				const deleted =
					lookup.kind === "pk"
						? deleteRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key)
						: deleteRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key);
				resultText =
					deleted > 0
						? `Deleted row '${resolvedSqlitePath.key}' from ${resolvedSqlitePath.table}`
						: `No row deleted from ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
			} else {
				let parsedContent: unknown;
				try {
					parsedContent = Bun.JSON5.parse(content);
				} catch (error) {
					throw new ToolError(
						`SQLite write content must be valid JSON5: ${error instanceof Error ? error.message : String(error)}`,
					);
				}

				if (!isRecord(parsedContent)) {
					throw new ToolError("SQLite write content must be a JSON object");
				}

				if (resolvedSqlitePath.key) {
					const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
					const updated =
						lookup.kind === "pk"
							? updateRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key, parsedContent)
							: updateRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key, parsedContent);
					resultText =
						updated > 0
							? `Updated row '${resolvedSqlitePath.key}' in ${resolvedSqlitePath.table}`
							: `No row updated in ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
				} else {
					insertRow(db, resolvedSqlitePath.table, parsedContent);
					resultText = `Inserted row into ${resolvedSqlitePath.table}`;
				}
			}

			invalidateFsScanAfterWrite(resolvedSqlitePath.absolutePath);
			return toolResult<WriteToolDetails>({}).text(resultText).sourcePath(resolvedSqlitePath.absolutePath).done();
		} catch (error) {
			if (isEnoent(error)) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}
			if (error instanceof ToolError) {
				throw error;
			}
			throw new ToolError(error instanceof Error ? error.message : String(error));
		} finally {
			db?.close();
		}
	}

	/**
	 * Resolve a single `conflict://<N>` write by splicing the recorded
	 * marker region in the registered file with `replacementContent`,
	 * then routing the new file content through the normal writethrough
	 * pipeline so LSP format/diagnostics still run.
	 *
	 * Entry ids are session-stable: they keep working even after later
	 * writes resolve other blocks in the same file. The recorded range
	 * is re-validated on disk before splicing so an out-of-band edit
	 * surfaces as a clear error instead of corrupting the file.
	 */
	async #resolveConflict(
		entry: ConflictEntry,
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
		context: AgentToolContext | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const absolutePath = entry.absolutePath;
		if (!(await fs.exists(absolutePath))) {
			throw new ToolError(`Conflict #${entry.id} target '${entry.displayPath}' no longer exists.`);
		}

		const expanded = expandContentTokens(replacementContent, entry);
		const originalText = await Bun.file(absolutePath).text();
		const newContent = spliceConflict(originalText, entry, expanded);

		const batchRequest = getLspBatchRequest(context?.toolCall);
		const diagnostics = await this.#writethrough(absolutePath, newContent, signal, undefined, batchRequest);
		invalidateFsScanAfterWrite(absolutePath);
		this.session.fileReadCache?.invalidate(absolutePath);
		this.session.conflictHistory?.invalidate(entry.id);

		const range =
			entry.startLine === entry.endLine
				? `line ${entry.startLine}`
				: `lines ${entry.startLine}\u2013${entry.endLine}`;
		let resultText = `Resolved conflict #${entry.id} at ${range} in ${entry.displayPath}.`;
		if (stripped) {
			resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
		}

		if (!diagnostics) {
			return {
				content: [{ type: "text", text: resultText }],
				details: {},
			};
		}
		return {
			content: [{ type: "text", text: resultText }],
			details: {
				diagnostics,
				meta: outputMeta()
					.diagnostics(diagnostics.summary, diagnostics.messages ?? [])
					.get(),
			},
		};
	}

	/**
	 * Look up a single conflict entry by id and dispatch to {@link #resolveConflict}.
	 * Throws a clear `not found` error when the id has been invalidated.
	 */
	async #resolveSingleConflictById(
		id: number,
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
		context: AgentToolContext | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const entry = getConflictHistory(this.session).get(id);
		if (!entry) {
			throw new ToolError(
				`Conflict #${id} not found. Conflict ids are registered when \`read\` surfaces a marker block; re-read the file to get a current id.`,
			);
		}
		return this.#resolveConflict(entry, replacementContent, stripped, signal, context);
	}

	/**
	 * Bulk-resolve every registered conflict via `conflict://*`.
	 *
	 * Entries are grouped by file and applied bottom-up by recorded start
	 * line so each splice keeps later anchors valid. `content` tokens are
	 * expanded *per entry*, so `content: "@ours"` keeps each block's own
	 * ours side rather than collapsing every conflict to the first
	 * block's ours.
	 *
	 * All-or-nothing semantics within a file: if any splice for a file
	 * fails (stale anchors, missing base for `@base`, etc.), that file is
	 * left untouched and the error is surfaced. Files that succeed are
	 * still written. The result text reports per-file counts so the agent
	 * can re-read the failed files and retry.
	 */
	async #resolveAllConflicts(
		replacementContent: string,
		stripped: boolean,
		signal: AbortSignal | undefined,
		context: AgentToolContext | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const history = getConflictHistory(this.session);
		const allEntries = history.entries();
		if (allEntries.length === 0) {
			throw new ToolError(
				"`conflict://*` has nothing to resolve — no conflicts are currently registered. Re-read the file(s) with conflicts first.",
			);
		}

		const byFile = new Map<string, ConflictEntry[]>();
		for (const entry of allEntries) {
			const bucket = byFile.get(entry.absolutePath) ?? [];
			bucket.push(entry);
			byFile.set(entry.absolutePath, bucket);
		}

		const batchRequest = getLspBatchRequest(context?.toolCall);
		const allDiagnostics: FileDiagnosticsResult[] = [];
		const succeededFiles: { displayPath: string; count: number }[] = [];
		const failedFiles: { displayPath: string; count: number; error: string }[] = [];
		let totalResolvedIds = 0;

		for (const [absolutePath, fileEntries] of byFile) {
			const sample = fileEntries[0]!;
			if (!(await fs.exists(absolutePath))) {
				failedFiles.push({
					displayPath: sample.displayPath,
					count: fileEntries.length,
					error: "file no longer exists",
				});
				continue;
			}

			fileEntries.sort((a, b) => b.startLine - a.startLine);

			let text: string;
			try {
				text = await Bun.file(absolutePath).text();
				for (const entry of fileEntries) {
					const expanded = expandContentTokens(replacementContent, entry);
					text = spliceConflict(text, entry, expanded);
				}
			} catch (error) {
				failedFiles.push({
					displayPath: sample.displayPath,
					count: fileEntries.length,
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}

			const diagnostics = await this.#writethrough(absolutePath, text, signal, undefined, batchRequest);
			invalidateFsScanAfterWrite(absolutePath);
			this.session.fileReadCache?.invalidate(absolutePath);
			for (const entry of fileEntries) history.invalidate(entry.id);
			succeededFiles.push({ displayPath: sample.displayPath, count: fileEntries.length });
			totalResolvedIds += fileEntries.length;
			if (diagnostics) allDiagnostics.push(diagnostics);
		}

		const summaryLines: string[] = [];
		const fileWord = (n: number) => (n === 1 ? "file" : "files");
		const conflictWord = (n: number) => (n === 1 ? "conflict" : "conflicts");
		if (succeededFiles.length > 0) {
			summaryLines.push(
				`Resolved ${totalResolvedIds} ${conflictWord(totalResolvedIds)} across ${succeededFiles.length} ${fileWord(succeededFiles.length)}:`,
			);
			for (const file of succeededFiles) {
				summaryLines.push(`  ${file.displayPath}: ${file.count} ${conflictWord(file.count)}`);
			}
		}
		if (failedFiles.length > 0) {
			summaryLines.push(
				`Failed to resolve ${failedFiles.length} ${fileWord(failedFiles.length)} — registered entries left intact for retry:`,
			);
			for (const file of failedFiles) {
				summaryLines.push(`  ${file.displayPath}: ${file.count} ${conflictWord(file.count)} (${file.error})`);
			}
		}
		if (stripped) {
			summaryLines.push("Note: auto-stripped hashline display prefixes from content before writing.");
		}
		const resultText = summaryLines.join("\n");

		if (allDiagnostics.length === 0) {
			if (failedFiles.length > 0 && succeededFiles.length === 0) {
				throw new ToolError(resultText);
			}
			return { content: [{ type: "text", text: resultText }], details: {} };
		}
		const mergedSummary = allDiagnostics.map(d => d.summary).join("\n");
		const mergedMessages = allDiagnostics.flatMap(d => d.messages ?? []);
		return {
			content: [{ type: "text", text: resultText }],
			details: {
				meta: outputMeta().diagnostics(mergedSummary, mergedMessages).get(),
			},
		};
	}

	#routeWriteThroughBridge(absolutePath: string, content: string): Promise<void> | undefined {
		const bridge = this.session.getClientBridge?.();
		if (!bridge?.capabilities.writeTextFile || !bridge.writeTextFile) return undefined;
		return bridge.writeTextFile({ path: absolutePath, content });
	}
	async execute(
		_toolCallId: string,
		{ path, content }: WriteParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		return untilAborted(signal, async () => {
			// Strip hashline display prefixes (LINE+ID|) if the model copied them from read output
			const { text: cleanContent, stripped } = stripWriteContent(this.session, content);
			const internalRouter = InternalUrlRouter.instance();
			if (internalRouter.canHandle(path)) {
				const parsed = parseInternalUrl(path);
				const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
				const handler = internalRouter.getHandler(scheme);
				if (handler?.write) {
					await handler.write(parsed, cleanContent, { cwd: this.session.cwd, signal });
					let resultText = `Successfully wrote ${cleanContent.length} bytes to ${path}`;
					if (stripped) {
						resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
					return { content: [{ type: "text", text: resultText }], details: {} };
				}
				// Schemes without a `write` hook fall through to existing logic
				// (local:// resolves to a backing file via plan-mode-guard) or are
				// rejected downstream when no backing file exists.
			}

			const conflictUri = parseConflictUri(path);
			if (conflictUri) {
				if (conflictUri.scope) {
					throw new ToolError(
						`Conflict URI scope '/${conflictUri.scope}' is read-only — read \`conflict://${conflictUri.id}/${conflictUri.scope}\` to inspect that side. To write, drop the scope (\`conflict://${conflictUri.id}\`) and put the chosen content (or shorthand like \`@${conflictUri.scope}\`) in \`content\`.`,
					);
				}
				const result =
					conflictUri.id === "*"
						? await this.#resolveAllConflicts(cleanContent, stripped, signal, context)
						: await this.#resolveSingleConflictById(conflictUri.id, cleanContent, stripped, signal, context);
				if (conflictUri.recoveredPrefix !== undefined) {
					appendNoteToResult(
						result,
						`Note: stripped erroneous '${conflictUri.recoveredPrefix}:' prefix from path; conflict URIs are global (use \`conflict://${conflictUri.id}\`, not \`<file>:conflict://${conflictUri.id}\`).`,
					);
				}
				return result;
			}
			const resolvedArchivePath = await this.#resolveArchiveWritePath(path);
			if (resolvedArchivePath) {
				enforcePlanModeWrite(this.session, resolvedArchivePath.archivePath, {
					op: resolvedArchivePath.exists ? "update" : "create",
				});

				const archiveResult = await this.#writeArchiveEntry(cleanContent, resolvedArchivePath);
				if (stripped) {
					const firstText = archiveResult.content.find(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					);
					if (firstText) {
						firstText.text += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
				}
				return archiveResult;
			}

			const resolvedSqlitePath = await this.#resolveSqliteWritePath(path);
			if (resolvedSqlitePath) {
				enforcePlanModeWrite(this.session, resolvedSqlitePath.sqlitePath, { op: "update" });

				const sqliteResult = await this.#writeSqliteRow(path, cleanContent, resolvedSqlitePath);
				if (stripped) {
					const firstText = sqliteResult.content.find(
						(block): block is { type: "text"; text: string } =>
							block.type === "text" && typeof block.text === "string",
					);
					if (firstText) {
						firstText.text += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
					}
				}
				return sqliteResult;
			}

			enforcePlanModeWrite(this.session, path, { op: "create" });
			const absolutePath = resolvePlanPath(this.session, path);
			const batchRequest = getLspBatchRequest(context?.toolCall);

			// Check if file exists and is auto-generated before overwriting
			if (await fs.exists(absolutePath)) {
				await assertEditableFile(absolutePath, path, this.session.settings);
			}

			// Try ACP bridge first — no disk write when client handles it
			const bridgePromise = this.#routeWriteThroughBridge(absolutePath, cleanContent);
			if (bridgePromise !== undefined) {
				try {
					await bridgePromise;
				} catch (error) {
					throw new ToolError(formatFileWriteError(error, absolutePath));
				}
				invalidateFsScanAfterWrite(absolutePath);
				this.session.fileReadCache?.invalidate(absolutePath);
				const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
				let resultText = `Successfully wrote ${cleanContent.length} bytes to ${displayPath}`;
				if (stripped) {
					resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
				}
				return { content: [{ type: "text", text: resultText }], details: {} };
			}

			let diagnostics: FileDiagnosticsResult | undefined;
			try {
				diagnostics = await this.#writethrough(absolutePath, cleanContent, signal, undefined, batchRequest);
			} catch (error) {
				throw new ToolError(formatFileWriteError(error, absolutePath));
			}
			invalidateFsScanAfterWrite(absolutePath);
			this.session.fileReadCache?.invalidate(absolutePath);

			const displayPath = formatPathRelativeToCwd(absolutePath, this.session.cwd);
			let resultText = `Successfully wrote ${cleanContent.length} bytes to ${displayPath}`;
			if (stripped) {
				resultText += `\nNote: auto-stripped hashline display prefixes from content before writing.`;
			}
			if (!diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: {},
				};
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					diagnostics,
					meta: outputMeta()
						.diagnostics(diagnostics.summary, diagnostics.messages ?? [])
						.get(),
				},
			};
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface WriteRenderArgs {
	path?: string;
	file_path?: string;
	content?: string;
}

const WRITE_PREVIEW_LINES = 6;
const WRITE_STREAMING_PREVIEW_LINES = 12;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatLineCountSuffix(lineCount: number, uiTheme: Theme): string {
	if (lineCount <= 0) return "";
	return uiTheme.fg("dim", ` · ${lineCount} line${lineCount === 1 ? "" : "s"}`);
}

function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

function formatStreamingContent(content: string, language: string | undefined, uiTheme: Theme): string {
	if (!content) return "";
	const lines = normalizeDisplayText(content).split("\n");
	const totalLines = lines.length;
	const startIndex = Math.max(0, totalLines - WRITE_STREAMING_PREVIEW_LINES);
	const visibleLines = lines.slice(startIndex);
	const hidden = startIndex;
	const highlighted = highlightCode(visibleLines.join("\n"), language);
	const lineNumberWidth = String(totalLines).length;

	let text = "\n\n";
	if (hidden > 0) {
		text += `${uiTheme.fg("dim", `… (${hidden} earlier line${hidden === 1 ? "" : "s"})`)}\n`;
	}
	for (let i = 0; i < highlighted.length; i++) {
		const lineNum = startIndex + i + 1;
		const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")}│`);
		const body = replaceTabs(highlighted[i] ?? "");
		text += ` ${gutter}${body}\n`;
	}
	text += uiTheme.fg("dim", `… (streaming)`);
	return text;
}

function renderContentPreview(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
): string {
	if (!content) return "";
	const rawLines = normalizeDisplayText(content).split("\n");
	const totalLines = rawLines.length;
	const maxLines = expanded ? totalLines : Math.min(totalLines, WRITE_PREVIEW_LINES);
	const visibleLines = rawLines.slice(0, maxLines);
	const highlighted = highlightCode(visibleLines.join("\n"), language);
	const lineNumberWidth = String(maxLines).length;
	const hidden = totalLines - maxLines;

	let text = "\n\n";
	for (let i = 0; i < highlighted.length; i++) {
		const lineNum = i + 1;
		const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")}│`);
		const body = replaceTabs(highlighted[i] ?? "");
		text += ` ${gutter}${body}\n`;
	}
	if (!expanded && hidden > 0) {
		const hint = formatExpandHint(uiTheme, expanded, hidden > 0);
		const moreLine = `${formatMoreItems(hidden, "line")}${hint ? ` ${hint}` : ""}`;
		text += uiTheme.fg("dim", moreLine);
	}
	return text.trimEnd();
}

export const writeToolRenderer = {
	renderCall(args: WriteRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const lang = getLanguageFromPath(rawPath) ?? "text";
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const spinner =
			options?.spinnerFrame !== undefined ? formatStatusIcon("running", uiTheme, options.spinnerFrame) : "";

		let text = `${formatTitle("Write", uiTheme)} ${spinner ? `${spinner} ` : ""}${langIcon} ${pathDisplay}`;

		if (!args.content) {
			return new Text(text, 0, 0);
		}

		// Show streaming preview of content (tail)
		text += formatStreamingContent(args.content, lang, uiTheme);

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		const rawPath = args?.file_path || args?.path || "";
		const filePath = shortenPath(rawPath);
		const fileContent = args?.content || "";
		const lang = getLanguageFromPath(rawPath);
		const langIcon = uiTheme.fg("muted", uiTheme.getLangIcon(lang));
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const lineCount = countLines(fileContent);
		const lineSuffix = formatLineCountSuffix(lineCount, uiTheme);

		// Build header with status icon
		const header = renderStatusLine(
			{
				icon: "success",
				title: "Write",
				description: `${langIcon} ${pathDisplay}${lineSuffix}`,
			},
			uiTheme,
		);
		const diagnostics = result.details?.diagnostics;

		let cached: RenderCache | undefined;

		return {
			render(width: number) {
				const { expanded } = options;
				const key = new Hasher().bool(expanded).u32(width).digest();
				if (cached?.key === key) return cached.lines;

				let text = header;
				text += renderContentPreview(fileContent, expanded, lang, uiTheme);

				if (diagnostics) {
					const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, fp =>
						uiTheme.getLangIcon(getLanguageFromPath(fp)),
					);
					if (diagText.trim()) {
						const diagLines = diagText.split("\n");
						const firstNonEmpty = diagLines.findIndex(line => line.trim());
						if (firstNonEmpty >= 0) {
							text += `\n${diagLines.slice(firstNonEmpty).join("\n")}`;
						}
					}
				}

				const lines = text.split("\n").map(l => truncateToWidth(l, width, Ellipsis.Omit));
				cached = { key, lines };
				return lines;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},
	mergeCallAndResult: true,
};
