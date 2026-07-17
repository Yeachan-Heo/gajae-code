import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { type GrepMatch, GrepOutputMode, type GrepResult, grep } from "@gajae-code/natives";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import { getFileReadCache } from "../edit/file-read-cache";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import searchDescription from "../prompts/tools/search.md" with { type: "text" };
import { DEFAULT_MAX_COLUMN, type TruncationResult, truncateHead } from "../session/streaming-output";
import { Ellipsis, fileHyperlink, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import {
	type ArchiveReader,
	type ExtractedArchiveFile,
	openArchive,
	parseArchivePathCandidates,
} from "./archive-reader";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatGroupedFiles } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import { resolveReadPath, resolveToolSearchScope } from "./path-utils";
import {
	createCachedComponent,
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
	splitGroupsByBlankLine,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const searchSchema = z
	.object({
		pattern: z.string().describe("regex pattern"),
		paths: z
			.array(z.string().describe("file, directory, glob, or internal URL to search"))
			.min(1)
			.optional()
			.describe(
				"files, directories, globs, or internal URLs to search (defaults to the working directory when omitted)",
			),
		i: z.boolean().optional().describe("case-insensitive search"),
		gitignore: z.boolean().optional().describe("respect gitignore"),
		skip: z
			.number()
			.optional()
			.describe("files to skip before collecting results — use to paginate when the prior call hit the file limit"),
	})
	.strict();

export type SearchToolInput = z.infer<typeof searchSchema>;

/** Maximum number of distinct files surfaced in a single response. The
 * agent paginates further pages via `skip`. */
export const DEFAULT_FILE_LIMIT = 20;
/** Per-file match cap for multi-file searches — keeps a single hot file
 * from crowding out diverse hits. Applied in JS after grep returns. */
export const MULTI_FILE_PER_FILE_MATCHES = 20;
/** Per-file match cap for single-file searches — there's no diversity
 * concern when the scope is one file. */
export const SINGLE_FILE_MATCHES = 200;
/** Hard safety ceiling on how many matches we fetch from native grep
 * before JS-side grouping. Sized to comfortably cover the file window
 * (DEFAULT_FILE_LIMIT files × MULTI_FILE_PER_FILE_MATCHES matches) plus
 * pagination headroom so the caller can see total file count. */
const INTERNAL_TOTAL_CAP = 2000;

/**
 * Detect a `,` that is not inside a `{…}` brace expansion. Used to catch
 * `paths: ["a,b"]` mistakes where the caller flattened multiple entries
 * into a single string instead of passing a JSON array of strings.
 */
function containsTopLevelComma(entry: string): boolean {
	let depth = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			if (depth > 0) depth--;
		} else if (ch === "," && depth === 0) {
			return true;
		}
	}
	return false;
}

/**
 * Pre-resolve any `paths` entries that point at a member inside an archive
 * (e.g. `bundle.zip:src/foo.ts`, `release.tar.gz:notes.md`). Native grep
 * cannot read archive members, so we materialize each text member to a
 * temp scratch file and substitute that path into the search inputs. After
 * grep returns, callers remap `match.path` back to the original
 * `archive:member` selector so it round-trips through the `read` tool.
 *
 * Returns the rewritten paths array (same length/order as input), a map
 * from absolute scratch path → original selector, a list of entries we
 * could not materialize (binary member, missing archive, etc.), and a
 * cleanup hook the caller MUST invoke in a `finally`.
 */
async function resolveArchiveSearchPaths(
	paths: string[],
	cwd: string,
): Promise<{
	resolvedPaths: string[];
	displayMap: Map<string, string>;
	displaySet: Set<string>;
	unreadable: string[];
	cleanup: () => Promise<void>;
}> {
	const resolvedPaths = paths.slice();
	const displayMap = new Map<string, string>();
	const displaySet = new Set<string>();
	const unreadable: string[] = [];
	let tempDir: string | undefined;
	const archiveCache = new Map<string, ArchiveReader>();

	for (let idx = 0; idx < paths.length; idx++) {
		const entry = paths[idx];
		const candidates = parseArchivePathCandidates(entry);
		// Longest archive prefix first; we want the one whose member portion is non-empty.
		const member = candidates.find(c => c.subPath !== "" && c.archivePath !== entry);
		if (!member) continue;

		const archiveAbs = resolveReadPath(member.archivePath, cwd);
		let archive = archiveCache.get(archiveAbs);
		if (!archive) {
			try {
				archive = await openArchive(archiveAbs);
			} catch (err) {
				unreadable.push(`${entry} (cannot open archive: ${(err as Error).message})`);
				continue;
			}
			archiveCache.set(archiveAbs, archive);
		}

		let extracted: ExtractedArchiveFile;
		try {
			extracted = await archive.readFile(member.subPath);
		} catch (err) {
			unreadable.push(`${entry} (${(err as Error).message})`);
			continue;
		}
		// UTF-8 only — binary members would just produce noise through ripgrep.
		if (extracted.bytes.some(byte => byte === 0)) {
			unreadable.push(`${entry} (binary archive entry)`);
			continue;
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(extracted.bytes);
		} catch {
			unreadable.push(`${entry} (non-UTF-8 archive entry)`);
			continue;
		}

		if (!tempDir) {
			tempDir = await mkdtemp(path.join(tmpdir(), "gjc-search-archive-"));
		}
		// Per-entry filename keeps the scratch path unique even when two selectors
		// resolve to members with the same basename.
		const safeBase = path.basename(member.subPath).replace(/[^\w.-]+/g, "_") || "entry";
		const tempPath = path.join(tempDir, `${idx}-${safeBase}`);
		await writeFile(tempPath, text);
		resolvedPaths[idx] = tempPath;
		displayMap.set(tempPath, entry);
		displaySet.add(entry);
	}

	const cleanup = async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	};
	return { resolvedPaths, displayMap, displaySet, unreadable, cleanup };
}

export interface SearchToolDetails {
	truncation?: TruncationResult;
	fileLimitReached?: number;
	perFileLimitReached?: number;
	linesTruncated?: boolean;
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
	/** Pre-formatted text for the user-visible TUI render. Mirrors the model-facing
	 * `result.text` lines but uses a `│` gutter and `*` to mark match lines (vs space for
	 * context). The TUI uses this directly so it never parses model-facing hashline anchors. */
	displayContent?: string;
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

type SearchParams = z.infer<typeof searchSchema>;

export class SearchTool implements AgentTool<typeof searchSchema, SearchToolDetails> {
	readonly name = "search";
	readonly label = "Search";
	readonly loadMode = "discoverable";
	readonly summary = "Search file contents using ripgrep (fast text search)";
	readonly description: string;
	readonly parameters = searchSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.description = prompt.render(searchDescription, {
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
		});
	}

	async execute(
		_toolCallId: string,
		params: SearchParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolDetails>> {
		const { pattern, i, gitignore, skip } = params;
		// Recurring real-world failure mode: models omit `paths` for repo-wide
		// searches. Default to the working directory instead of failing the call.
		const paths = params.paths ?? ["."];

		return untilAborted(signal, async () => {
			const normalizedPattern = pattern.trim();
			if (!normalizedPattern) {
				throw new ToolError("Pattern must not be empty");
			}

			const normalizedSkip = skip === undefined ? 0 : Number.isFinite(skip) ? Math.floor(skip) : Number.NaN;
			if (normalizedSkip < 0 || !Number.isFinite(normalizedSkip)) {
				throw new ToolError("Skip must be a non-negative number");
			}
			for (const entry of paths) {
				if (containsTopLevelComma(entry)) {
					throw new ToolError('paths is an array — pass ["a", "b"] not ["a,b"]');
				}
			}
			const {
				resolvedPaths,
				displayMap: archiveDisplayMap,
				displaySet: archiveDisplaySet,
				unreadable: archiveUnreadable,
				cleanup: cleanupArchiveScratch,
			} = await resolveArchiveSearchPaths(paths, this.session.cwd);
			try {
				if (archiveUnreadable.length > 0 && resolvedPaths.length === archiveUnreadable.length) {
					// All inputs were archive selectors we couldn't materialize; surface the
					// reason instead of a downstream "path not found" from the scope resolver.
					throw new ToolError(
						`Cannot search archive member(s): ${archiveUnreadable.join(", ")}. ` +
							`Read the file directly with \`read <archive>:<member>\` and grep the returned content, ` +
							`or pass a UTF-8 text member.`,
					);
				}
				const normalizedContextBefore = this.session.settings.get("search.contextBefore");
				const normalizedContextAfter = this.session.settings.get("search.contextAfter");
				const ignoreCase = i ?? false;
				const useGitignore = gitignore ?? true;
				const patternHasNewline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
				const effectiveMultiline = patternHasNewline;

				const scope = await resolveToolSearchScope({
					rawPaths: resolvedPaths,
					cwd: this.session.cwd,
					getArtifactsDir: this.session.getArtifactsDir,
					internalUrlAction: "search",
					trackImmutableSources: true,
					surfaceExactFilePaths: true,
					multipathStatHint: " (`paths` entries must each exist relative to cwd)",
				});
				const { searchPath, isDirectory, multiTargets, exactFilePaths, missingPaths, immutableSourcePaths } = scope;
				// When the only input was an archive selector, surface that selector instead
				// of the temp scratch path the resolver substituted in.
				const scopePath =
					resolvedPaths.length === 1 && archiveDisplayMap.get(searchPath)
						? (archiveDisplayMap.get(searchPath) as string)
						: scope.scopePath;
				if (missingPaths.length > 0 && missingPaths.length === resolvedPaths.length) {
					const archiveHint =
						archiveUnreadable.length > 0
							? ` (archive members were not searchable: ${archiveUnreadable.join(", ")})`
							: "";
					throw new ToolError(
						`Path not found: ${missingPaths.join(", ")}; pass each path as its own array element${archiveHint}`,
					);
				}
				const { globFilter } = scope;
				const baseDisplayMode = resolveFileDisplayMode(this.session);
				const immutableDisplayMode = resolveFileDisplayMode(this.session, { immutable: true });

				const effectiveOutputMode = GrepOutputMode.Content;
				// Multi-scope = more than one file may match. We fetch up to
				// INTERNAL_TOTAL_CAP matches from native grep, then in JS group by
				// file, apply a per-file cap (so one hot file doesn't crowd the
				// window), and round-robin emit from up to DEFAULT_FILE_LIMIT files.
				const isMultiScope = isDirectory || Boolean(exactFilePaths) || Boolean(multiTargets);
				const perFileMatchCap = isMultiScope ? MULTI_FILE_PER_FILE_MATCHES : SINGLE_FILE_MATCHES;

				// Run grep
				let result: GrepResult;
				try {
					if (exactFilePaths || multiTargets) {
						const matches: GrepMatch[] = [];
						let limitReached = false;
						let totalMatches = 0;
						let filesSearched = 0;
						const targets = exactFilePaths
							? exactFilePaths.map(filePath => ({ basePath: filePath, glob: undefined as string | undefined }))
							: (multiTargets ?? []);
						for (const target of targets) {
							const targetResult = await grep(
								{
									pattern: normalizedPattern,
									path: target.basePath,
									glob: target.glob,
									ignoreCase,
									multiline: effectiveMultiline,
									hidden: true,
									gitignore: useGitignore,
									cache: false,
									maxCount: INTERNAL_TOTAL_CAP,
									contextBefore: normalizedContextBefore,
									contextAfter: normalizedContextAfter,
									maxColumns: DEFAULT_MAX_COLUMN,
									mode: effectiveOutputMode,
								},
								undefined,
							);
							limitReached = limitReached || Boolean(targetResult.limitReached);
							totalMatches += targetResult.totalMatches;
							filesSearched += targetResult.filesSearched;
							for (const match of targetResult.matches) {
								const absolute = path.resolve(target.basePath, match.path);
								const rebased = path.relative(searchPath, absolute).replace(/\\/g, "/");
								matches.push({ ...match, path: rebased });
							}
						}
						result = {
							matches,
							totalMatches: exactFilePaths ? matches.length : totalMatches,
							filesWithMatches: new Set(matches.map(match => match.path)).size,
							filesSearched: exactFilePaths ? exactFilePaths.length : filesSearched,
							limitReached,
						};
					} else {
						result = await grep(
							{
								pattern: normalizedPattern,
								path: searchPath,
								glob: globFilter,
								ignoreCase,
								multiline: effectiveMultiline,
								hidden: true,
								gitignore: useGitignore,
								cache: false,
								maxCount: INTERNAL_TOTAL_CAP,
								contextBefore: normalizedContextBefore,
								contextAfter: normalizedContextAfter,
								maxColumns: DEFAULT_MAX_COLUMN,
								mode: effectiveOutputMode,
							},
							undefined,
						);
					}
				} catch (err) {
					if (err instanceof Error && err.message.startsWith("regex parse error")) {
						throw new ToolError(err.message);
					}
					throw err;
				}
				if (archiveDisplayMap.size > 0) {
					for (const match of result.matches) {
						let abs: string;
						if (match.path === "") abs = searchPath;
						else if (path.isAbsolute(match.path)) abs = match.path;
						else abs = path.resolve(searchPath, match.path);
						const display = archiveDisplayMap.get(abs);
						if (display) match.path = display;
					}
				}

				const formatPath = (filePath: string): string =>
					archiveDisplaySet.has(filePath)
						? filePath
						: formatResultPath(filePath, isDirectory, searchPath, this.session.cwd);

				// Group matches by file in encounter order. Detect per-file overflow
				// BEFORE truncation so the renderer can surface that a hot file was
				// trimmed for diversity.
				const fileOrder: string[] = [];
				const matchesByPath = new Map<string, GrepMatch[]>();
				for (const match of result.matches) {
					if (!matchesByPath.has(match.path)) {
						fileOrder.push(match.path);
						matchesByPath.set(match.path, []);
					}
					matchesByPath.get(match.path)!.push(match);
				}
				let perFileLimitReached = false;
				for (const file of fileOrder) {
					const list = matchesByPath.get(file)!;
					if (list.length > perFileMatchCap) {
						perFileLimitReached = true;
						list.length = perFileMatchCap;
					}
				}
				const totalFiles = fileOrder.length;
				// Single-file scopes can't paginate — there is one file by definition.
				const canPaginate = isMultiScope;
				const skipFiles = canPaginate ? Math.min(normalizedSkip, totalFiles) : 0;
				const windowFiles = canPaginate ? fileOrder.slice(skipFiles, skipFiles + DEFAULT_FILE_LIMIT) : fileOrder;
				const fileLimitReached = canPaginate && totalFiles > skipFiles + DEFAULT_FILE_LIMIT;
				const selectedMatches: GrepMatch[] = [];
				if (windowFiles.length > 0) {
					const lists = windowFiles.map(file => matchesByPath.get(file) ?? []);
					const cursors = new Array<number>(lists.length).fill(0);
					let anyAdded = true;
					while (anyAdded) {
						anyAdded = false;
						for (let i = 0; i < lists.length; i++) {
							if (cursors[i] < lists[i].length) {
								selectedMatches.push(lists[i][cursors[i]++]);
								anyAdded = true;
							}
						}
					}
				}
				const nextSkip = skipFiles + windowFiles.length;
				const limitMessage = fileLimitReached
					? `Showing files ${skipFiles + 1}-${nextSkip} of ${totalFiles}. Use skip=${nextSkip} for the next page, or narrow paths/pattern.`
					: "";
				const { record: recordFile, list: fileList } = createFileRecorder();
				const fileMatchCounts = new Map<string, number>();
				const archiveNote =
					archiveUnreadable.length > 0
						? `Skipped archive entries (search supports text members only): ${archiveUnreadable.join(", ")}`
						: undefined;
				// Suppress entries we already explained via archiveNote — they would otherwise
				// double up (the unreadable selector also failed the scope's existence check).
				const archiveUnreadablePaths = new Set(archiveUnreadable.map(s => s.replace(/ \(.*\)$/, "")));
				const missingPathsForNote = missingPaths.filter(p => !archiveUnreadablePaths.has(p));
				const missingPathsNote =
					missingPathsForNote.length > 0 ? `Skipped missing paths: ${missingPathsForNote.join(", ")}` : undefined;
				const warningNote =
					[missingPathsNote, archiveNote].filter((s): s is string => Boolean(s)).join("\n") || undefined;
				if (selectedMatches.length === 0) {
					const details: SearchToolDetails = {
						scopePath,
						searchPath,
						matchCount: 0,
						fileCount: 0,
						files: [],
						truncated: false,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					const text = warningNote ? `No matches found\n${warningNote}` : "No matches found";
					return toolResult(details).text(text).done();
				}
				const outputLines: string[] = [];
				let linesTruncated = false;
				const matchesByFile = new Map<string, GrepMatch[]>();
				for (const match of selectedMatches) {
					const relativePath = formatPath(match.path);
					recordFile(relativePath);
					if (!matchesByFile.has(relativePath)) {
						matchesByFile.set(relativePath, []);
					}
					matchesByFile.get(relativePath)!.push(match);
				}
				const displayLines: string[] = [];
				const renderMatchesForFile = (relativePath: string): { model: string[]; display: string[] } => {
					const modelOut: string[] = [];
					const displayOut: string[] = [];
					const fileMatches = matchesByFile.get(relativePath) ?? [];
					const absoluteFilePath = path.resolve(this.session.cwd, relativePath);
					const useHashLines = immutableSourcePaths.has(absoluteFilePath)
						? immutableDisplayMode.hashLines
						: baseDisplayMode.hashLines;
					const lineNumberWidth = fileMatches.reduce((width, match) => {
						let nextWidth = Math.max(width, String(match.lineNumber).length);
						for (const ctx of match.contextBefore ?? []) {
							nextWidth = Math.max(nextWidth, String(ctx.lineNumber).length);
						}
						for (const ctx of match.contextAfter ?? []) {
							nextWidth = Math.max(nextWidth, String(ctx.lineNumber).length);
						}
						return nextWidth;
					}, 0);
					const cacheEntries: Array<readonly [number, string]> = [];
					let lastEmittedLine: number | undefined;
					const gutterPad = " ".repeat(lineNumberWidth + 1);
					for (const match of fileMatches) {
						const pushLine = (lineNumber: number, line: string, isMatch: boolean, recordable: boolean) => {
							if (lastEmittedLine !== undefined && lineNumber > lastEmittedLine + 1) {
								modelOut.push("...");
								displayOut.push(`${gutterPad}│...`);
							}
							modelOut.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
							displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
							if (recordable) cacheEntries.push([lineNumber, line] as const);
							lastEmittedLine = lineNumber;
						};
						if (match.contextBefore) {
							for (const ctx of match.contextBefore) {
								pushLine(ctx.lineNumber, ctx.line, false, true);
							}
						}
						pushLine(match.lineNumber, match.line, true, !match.truncated);
						if (match.truncated) {
							linesTruncated = true;
						}
						if (match.contextAfter) {
							for (const ctx of match.contextAfter) {
								pushLine(ctx.lineNumber, ctx.line, false, true);
							}
						}
						fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
					}
					if (cacheEntries.length > 0 && !archiveDisplaySet.has(relativePath)) {
						getFileReadCache(this.session).recordSparse(path.resolve(searchPath, relativePath), cacheEntries);
					}
					return { model: modelOut, display: displayOut };
				};
				if (isDirectory) {
					const grouped = formatGroupedFiles(fileList, relativePath => {
						const rendered = renderMatchesForFile(relativePath);
						return {
							modelLines: rendered.model,
							displayLines: rendered.display,
							skip: rendered.model.length === 0,
						};
					});
					outputLines.push(...grouped.model);
					displayLines.push(...grouped.display);
				} else {
					for (const relativePath of fileList) {
						const rendered = renderMatchesForFile(relativePath);
						outputLines.push(...rendered.model);
						displayLines.push(...rendered.display);
					}
				}
				if (limitMessage) {
					outputLines.push("", limitMessage);
				}
				if (warningNote) {
					outputLines.push("", warningNote);
				}
				const rawOutput = outputLines.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				const output = truncation.content;
				const displayText = displayLines.join("\n");
				const truncated = Boolean(
					fileLimitReached || perFileLimitReached || result.limitReached || truncation.truncated || linesTruncated,
				);
				const details: SearchToolDetails = {
					scopePath,
					searchPath,
					matchCount: selectedMatches.length,
					fileCount: fileList.length,
					files: fileList,
					fileMatches: fileList.map(path => ({
						path,
						count: fileMatchCounts.get(path) ?? 0,
					})),
					truncated,
					fileLimitReached: fileLimitReached ? DEFAULT_FILE_LIMIT : undefined,
					perFileLimitReached: perFileLimitReached ? perFileMatchCap : undefined,
					displayContent: displayText,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};
				if (truncation.truncated) details.truncation = truncation;
				if (linesTruncated) details.linesTruncated = true;
				const resultBuilder = toolResult(details)
					.text(output)
					.limits({ columnMax: linesTruncated ? DEFAULT_MAX_COLUMN : undefined });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}
				return resultBuilder.done();
			} finally {
				await cleanupArchiveScratch();
			}
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface SearchRenderArgs {
	pattern: string;
	paths?: string[];
	i?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const searchToolRenderer = {
	inline: true,
	renderCall(args: SearchRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.paths?.length) meta.push(`in ${args.paths.join(", ")}`);
		if (args.i) meta.push("case:insensitive");
		if (args.gitignore === false) meta.push("gitignore:false");
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Search", description: args.pattern || "?", meta },
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: SearchRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(formatEmptyMessage("No matches found", uiTheme), 0, 0);
			}
			const lines = textContent.split("\n").filter(line => line.trim() !== "");
			const description = args?.pattern ?? undefined;
			const header = renderStatusLine(
				{ icon: "success", title: "Search", description, meta: [formatCount("item", lines.length)] },
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: COLLAPSED_TEXT_LIMIT,
							maxCollapsedLines: COLLAPSED_TEXT_LIMIT,
							itemType: "item",
							renderItem: line => uiTheme.fg("toolOutput", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
			);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || limits?.columnTruncated);

		const missingPathsList = details?.missingPaths ?? [];
		const missingNote =
			missingPathsList.length > 0
				? uiTheme.fg("warning", `skipped missing: ${missingPathsList.join(", ")}`)
				: undefined;

		if (matchCount === 0) {
			const header = renderStatusLine(
				{ icon: "warning", title: "Search", description: args?.pattern, meta: ["0 matches"] },
				uiTheme,
			);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const description = args?.pattern ?? undefined;
		const header = renderStatusLine(
			{ icon: truncated ? "warning" : "success", title: "Search", description, meta },
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const matchGroups = splitGroupsByBlankLine(textContent.split("\n"));

		const renderedFileLimit = details?.fileLimitReached;
		const renderedPerFileLimit = details?.perFileLimitReached;
		const truncationReasons: string[] = [];
		if (renderedFileLimit) truncationReasons.push(`first ${renderedFileLimit} files (skip to paginate)`);
		if (renderedPerFileLimit) truncationReasons.push(`first ${renderedPerFileLimit} matches per file`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		if (limits?.columnTruncated) truncationReasons.push(`line length ${limits.columnTruncated.maxColumn}`);
		if (truncation?.artifactId) truncationReasons.push(formatFullOutputReference(truncation.artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const collapsedMatchLineBudget = Math.max(COLLAPSED_TEXT_LIMIT - extraLines.length, 0);
				const searchBase = details?.searchPath;
				const matchLines = renderTreeList(
					{
						items: matchGroups,
						expanded: options.expanded,
						maxCollapsed: matchGroups.length,
						maxCollapsedLines: collapsedMatchLineBudget,
						itemType: "match",
						renderItem: group => {
							// Track directory context within a group for ## file headers.
							// `# foo/` is a directory header; `# foo.ts` is a root-level file
							// from formatGroupedFiles (single-# when directory is `.`).
							let contextDir = searchBase ?? "";
							return group.map(line => {
								if (line.startsWith("## ")) {
									// Strip optional ` (suffix)` like ` (3 replacements)` before resolving.
									const fileName = line
										.slice(3)
										.trimEnd()
										.replace(/\s+\([^)]*\)\s*$/, "");
									const absPath = contextDir && fileName ? path.join(contextDir, fileName) : undefined;
									const styled = uiTheme.fg("dim", line);
									return absPath ? fileHyperlink(absPath, styled) : styled;
								}
								if (line.startsWith("# ")) {
									const raw = line
										.slice(2)
										.trimEnd()
										.replace(/\s+\([^)]*\)\s*$/, "");
									const isDirectory = raw.endsWith("/");
									const name = raw.replace(/\/$/, "");
									if (isDirectory) {
										if (searchBase) {
											contextDir = name === "." ? searchBase : path.join(searchBase, name);
										}
										return uiTheme.fg("accent", line);
									}
									// Root-level file emitted by formatGroupedFiles when the directory is `.`.
									const absPath = searchBase && name ? path.join(searchBase, name) : undefined;
									const styled = uiTheme.fg("accent", line);
									return absPath ? fileHyperlink(absPath, styled) : styled;
								}
								return uiTheme.fg("toolOutput", line);
							});
						},
					},
					uiTheme,
				);
				return [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
		);
	},
	mergeCallAndResult: true,
};
