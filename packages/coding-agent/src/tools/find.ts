import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import * as natives from "@gajae-code/natives";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { isEnoent, prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import type { Theme } from "../modes/theme/theme";
import findDescription from "../prompts/tools/find.md" with { type: "text" };
import { type TruncationResult, truncateHead } from "../session/streaming-output";
import { Ellipsis, fileHyperlink, renderFileList, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	formatPathRelativeToCwd,
	hasGlobPathChars,
	normalizePathLikeInput,
	parseFindPattern,
	partitionExistingPaths,
	resolveExplicitFindPatterns,
	resolveToCwd,
} from "./path-utils";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const findSchema = z
	.object({
		paths: z.array(z.string().describe("glob including search path")).min(1).describe("globs including search paths"),
		hidden: z.boolean().default(true).describe("include hidden files").optional(),
		gitignore: z.boolean().default(true).describe("respect gitignore").optional(),
		limit: z.number().default(1000).describe("max results").optional(),
		timeout: z.number().min(0.5).max(60).default(5).describe("timeout in seconds (0.5–60)").optional(),
	})
	.strict();

export type FindToolInput = z.infer<typeof findSchema>;

const DEFAULT_LIMIT = 1000;
const DEFAULT_GLOB_TIMEOUT_MS = 5000;
const MIN_GLOB_TIMEOUT_MS = 500;
const MAX_GLOB_TIMEOUT_MS = 60_000;

/**
 * Reject comma-separated path lists packed into a single array element
 * (`["a.py,b.py"]`). The schema is array-of-string; agents that pass a
 * single comma-joined element get silent no-matches otherwise.
 *
 * Commas inside brace expansion (`{a,b}`) are legitimate glob syntax and
 * must pass through.
 */
function validateFindPathInputs(paths: readonly string[]): void {
	for (const entry of paths) {
		let braceDepth = 0;
		for (let i = 0; i < entry.length; i++) {
			const ch = entry.charCodeAt(i);
			if (ch === 0x7b /* { */) braceDepth++;
			else if (ch === 0x7d /* } */) {
				if (braceDepth > 0) braceDepth--;
			} else if (ch === 0x2c /* , */ && braceDepth === 0) {
				throw new ToolError(`paths is an array — pass ["a", "b"] not ["a,b"] (got ${JSON.stringify(entry)})`);
			}
		}
	}
}

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	/** Working directory at search time. Used by the renderer to resolve relative
	 * file paths to absolute paths for OSC 8 hyperlinks. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Optional stat for distinguishing files vs directories. */
	stat?: (
		absolutePath: string,
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	/** Find files matching glob pattern. Returns relative paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem + rg */
	operations?: FindOperations;
}

export class FindTool implements AgentTool<typeof findSchema, FindToolDetails> {
	readonly name = "find";
	readonly summary = "Find files and directories matching a glob pattern";
	readonly loadMode = "discoverable";
	readonly label = "Find";
	readonly description: string;
	readonly parameters = findSchema;
	readonly strict = true;

	readonly #customOps?: FindOperations;

	constructor(
		private readonly session: ToolSession,
		options?: FindToolOptions,
	) {
		this.#customOps = options?.operations;
		this.description = prompt.render(findDescription);
	}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof findSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<FindToolDetails>> {
		const { paths, limit, hidden, gitignore, timeout } = params;

		return untilAborted(signal, async () => {
			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			validateFindPathInputs(paths);
			const rawPatterns = paths.map(input => normalizePathLikeInput(input).replace(/\\/g, "/"));
			const internalRouter = InternalUrlRouter.instance();
			const normalizedPatterns: string[] = [];
			for (const rawPattern of rawPatterns) {
				if (!internalRouter.canHandle(rawPattern)) {
					normalizedPatterns.push(rawPattern);
					continue;
				}
				if (hasGlobPathChars(rawPattern)) {
					throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPattern}`);
				}
				const resource = await internalRouter.resolve(rawPattern, {
					cwd: this.session.cwd,
					getArtifactsDir: this.session.getArtifactsDir,
				});
				if (!resource.sourcePath) {
					throw new ToolError(`Cannot find internal URL without a backing file: ${rawPattern}`);
				}
				normalizedPatterns.push(resource.sourcePath);
			}
			if (normalizedPatterns.some(pattern => pattern.length === 0)) {
				throw new ToolError("`paths` must contain non-empty globs or paths");
			}

			// Tolerate missing entries in a multi-path call: skip ones whose base
			// directory is gone, and only error if every entry is missing. Single
			// missing path keeps the original ENOENT semantics — the user explicitly
			// asked about that one path, so silent empty results would be misleading.
			let missingPaths: string[] = [];
			let effectivePatterns = normalizedPatterns;
			if (normalizedPatterns.length > 1 && !this.#customOps) {
				const partition = await partitionExistingPaths(normalizedPatterns, this.session.cwd, parseFindPattern);
				if (partition.valid.length === 0) {
					throw new ToolError(`Path not found: ${partition.missing.join(", ")}`);
				}
				effectivePatterns = partition.valid;
				missingPaths = partition.missing;
			}

			const multiPattern = await resolveExplicitFindPatterns(effectivePatterns, this.session.cwd);
			const parsedPattern = multiPattern ? null : parseFindPattern(effectivePatterns[0] ?? ".");
			const hasGlob = multiPattern ? true : (parsedPattern?.hasGlob ?? false);
			const globPattern = multiPattern?.globPattern ?? parsedPattern?.globPattern ?? "**/*";
			const searchPath = resolveToCwd(multiPattern?.basePath ?? parsedPattern?.basePath ?? ".", this.session.cwd);
			const scopePath = multiPattern?.scopePath ?? formatScopePath(searchPath);

			if (searchPath === "/") {
				throw new ToolError("Searching from root directory '/' is not allowed");
			}
			const rawLimit = limit ?? DEFAULT_LIMIT;
			const effectiveLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : Number.NaN;
			if (!Number.isFinite(effectiveLimit) || effectiveLimit <= 0) {
				throw new ToolError("Limit must be a positive number");
			}
			const includeHidden = hidden ?? true;
			const useGitignore = gitignore ?? true;
			const requestedTimeoutMs = timeout != null ? Math.round(timeout * 1000) : DEFAULT_GLOB_TIMEOUT_MS;
			const timeoutMs = Math.min(MAX_GLOB_TIMEOUT_MS, Math.max(MIN_GLOB_TIMEOUT_MS, requestedTimeoutMs));
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const formatMatchPath = (matchPath: string, fileType?: natives.FileType): string => {
				const hadTrailingSlash = matchPath.endsWith("/") || matchPath.endsWith("\\");
				const absolutePath = path.isAbsolute(matchPath) ? matchPath : path.resolve(searchPath, matchPath);
				return formatPathRelativeToCwd(absolutePath, this.session.cwd, {
					trailingSlash: fileType === natives.FileType.Dir || hadTrailingSlash,
				});
			};

			const missingPathsNote =
				missingPaths.length > 0 ? `Skipped missing paths: ${missingPaths.join(", ")}` : undefined;

			const buildResult = (
				files: string[],
				opts?: { notice?: string; forceTruncated?: boolean },
			): AgentToolResult<FindToolDetails> => {
				const notice = opts?.notice;
				const forceTruncated = opts?.forceTruncated ?? false;
				if (files.length === 0) {
					const details: FindToolDetails = {
						scopePath,
						fileCount: 0,
						files: [],
						truncated: forceTruncated,
						cwd: this.session.cwd,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					const parts = ["No files found matching pattern"];
					if (notice) parts.push(notice);
					if (missingPathsNote) parts.push(missingPathsNote);
					return toolResult(details).text(parts.join("\n")).done();
				}

				const listLimit = applyListLimit(files, { limit: effectiveLimit });
				const limited = listLimit.items;
				const limitMeta = listLimit.meta;
				const baseOutput = limited.join("\n");
				const trailingNotes: string[] = [];
				if (notice) trailingNotes.push(notice);
				if (missingPathsNote) trailingNotes.push(missingPathsNote);
				const rawOutput = trailingNotes.length > 0 ? `${baseOutput}\n\n${trailingNotes.join("\n")}` : baseOutput;
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				const details: FindToolDetails = {
					scopePath,
					fileCount: limited.length,
					files: limited,
					truncated: Boolean(forceTruncated || limitMeta.resultLimit || truncation.truncated),
					resultLimitReached: limitMeta.resultLimit?.reached,
					truncation: truncation.truncated ? truncation : undefined,
					cwd: this.session.cwd,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};

				const resultBuilder = toolResult(details)
					.text(truncation.content)
					.limits({ resultLimit: limitMeta.resultLimit?.reached });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}

				return resultBuilder.done();
			};

			if (this.#customOps?.glob) {
				if (!(await this.#customOps.exists(searchPath))) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}

				if (!hasGlob && this.#customOps.stat) {
					const stat = await this.#customOps.stat(searchPath);
					if (stat.isFile()) {
						return buildResult([scopePath]);
					}
				}

				const results = await this.#customOps.glob(globPattern, searchPath, {
					ignore: ["**/node_modules/**", "**/.git/**"],
					limit: effectiveLimit,
				});
				const relativized = results.map(p => formatMatchPath(p));

				return buildResult(relativized);
			}

			let searchStat: fs.Stats;
			try {
				searchStat = await fs.promises.stat(searchPath);
			} catch (err) {
				if (isEnoent(err)) {
					throw new ToolError(`Path not found: ${scopePath}`);
				}
				throw err;
			}

			if (!hasGlob && searchStat.isFile()) {
				return buildResult([scopePath]);
			}
			if (!searchStat.isDirectory()) {
				throw new ToolError(`Path is not a directory: ${searchPath}`);
			}

			let matches: natives.GlobMatch[];
			const onUpdateMatches: string[] = [];
			const updateIntervalMs = 200;
			let lastUpdate = 0;
			const emitUpdate = () => {
				if (!onUpdate) return;
				const now = Date.now();
				if (now - lastUpdate < updateIntervalMs) return;
				lastUpdate = now;
				const details: FindToolDetails = {
					scopePath,
					fileCount: onUpdateMatches.length,
					files: onUpdateMatches.slice(),
					truncated: false,
				};
				onUpdate({
					content: [{ type: "text", text: onUpdateMatches.join("\n") }],
					details,
				});
			};
			const onMatch = (err: Error | null, match: natives.GlobMatch | null) => {
				if (err || signal?.aborted || !match?.path) return;
				const relativePath = formatMatchPath(match.path, match.fileType);
				onUpdateMatches.push(relativePath);
				emitUpdate();
			};

			const doGlob = async (useGitignore: boolean) =>
				untilAborted(combinedSignal, () =>
					natives.glob(
						{
							pattern: globPattern,
							path: searchPath,
							fileType: natives.FileType.File,
							hidden: includeHidden,
							maxResults: effectiveLimit,
							sortByMtime: true,
							gitignore: useGitignore,
							signal: combinedSignal,
						},
						onMatch,
					),
				);

			let timedOut = false;
			try {
				const result = await doGlob(useGitignore);
				// Sort by mtime descending (most recent first) in JS instead of native.
				// This allows native glob to early-terminate at maxResults.
				result.matches.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
				matches = result.matches;
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					if (timeoutSignal.aborted && !signal?.aborted) {
						timedOut = true;
						matches = [];
					} else {
						throw new ToolAbortError();
					}
				} else {
					throw error;
				}
			}

			if (timedOut) {
				// Drain the partial matches accumulated during streaming and return them
				// instead of throwing — empty results after a multi-second wait force the
				// caller to retry blind, which is the worst possible outcome.
				const seen = new Set<string>();
				const partial: string[] = [];
				for (const entry of onUpdateMatches) {
					if (seen.has(entry)) continue;
					seen.add(entry);
					partial.push(entry);
				}
				const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
				const notice = `find timed out after ${seconds}s; returning ${partial.length} partial matches — increase timeout or narrow pattern`;
				return buildResult(partial, { notice, forceTruncated: true });
			}

			const relativized: string[] = [];
			for (const match of matches) {
				throwIfAborted(signal);
				if (!match.path) {
					continue;
				}

				relativized.push(formatMatchPath(match.path, match.fileType));
			}

			return buildResult(relativized);
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface FindRenderArgs {
	paths?: string[];
	limit?: number;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

export const findToolRenderer = {
	inline: true,
	renderCall(args: FindRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Find", description: args.paths?.join(", ") || "*", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FindRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 0, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					icon: "success",
					title: "Find",
					description: args?.paths?.join(", "),
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: COLLAPSED_LIST_LIMIT,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
			);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0 ? uiTheme.fg("warning", `skipped missing: ${missingPaths.join(", ")}`) : undefined;

		if (fileCount === 0) {
			const header = renderStatusLine(
				{ icon: "warning", title: "Find", description: args?.paths?.join(", "), meta: ["0 files"] },
				uiTheme,
			);
			const lines = [header, formatEmptyMessage("No files found", uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 0, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const header = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "Find", description: args?.paths?.join(", "), meta },
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const cwd = details?.cwd;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({
							path: entry,
							isDirectory: entry.endsWith("/"),
							absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
						})),
						expanded: options.expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						hyperlinkFn: fileHyperlink,
					},
					uiTheme,
				);
				return [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
		);
	},
	mergeCallAndResult: true,
};
