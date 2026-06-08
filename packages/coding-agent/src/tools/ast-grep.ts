import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { type AstFindMatch, astGrep } from "@gajae-code/natives";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import astGrepDescription from "../prompts/tools/ast-grep.md" with { type: "text" };
import { Ellipsis, fileHyperlink, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatGroupedFiles } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import type { OutputMeta } from "./output-meta";
import { resolveToolSearchScope } from "./path-utils";
import {
	appendParseErrorsBulletList,
	capParseErrors,
	createCachedComponent,
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatParseErrors,
	formatParseErrorsCountLabel,
	PREVIEW_LIMITS,
	splitGroupsByBlankLine,
} from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const astGrepSchema = z.object({
	pat: z.string().describe("ast pattern"),
	paths: z
		.array(z.string().describe("file, directory, glob, or internal URL to search"))
		.min(1)
		.describe("files, directories, globs, or internal URLs to search"),
	skip: z.number().default(0).describe("matches to skip").optional(),
});

async function runMultiTargetAstGrep(
	targets: Array<{ basePath: string; glob?: string }>,
	options: { patterns: string[]; commonBasePath: string; skip: number; limit: number; signal?: AbortSignal },
): Promise<{
	matches: AstFindMatch[];
	totalMatches: number;
	filesWithMatches: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
}> {
	const aggregatedMatches: AstFindMatch[] = [];
	const parseErrors: string[] = [];
	let totalMatches = 0;
	let filesSearched = 0;
	let limitReached = false;
	for (const target of targets) {
		const targetResult = await astGrep({
			patterns: options.patterns,
			path: target.basePath,
			glob: target.glob,
			offset: 0,
			limit: options.skip + options.limit + 1,
			includeMeta: true,
			signal: options.signal,
		});
		totalMatches += targetResult.totalMatches;
		filesSearched += targetResult.filesSearched;
		limitReached = limitReached || targetResult.limitReached;
		if (targetResult.parseErrors) parseErrors.push(...targetResult.parseErrors);
		for (const match of targetResult.matches) {
			const absolute = path.resolve(target.basePath, match.path);
			const rebased = path.relative(options.commonBasePath, absolute).replace(/\\/g, "/");
			aggregatedMatches.push({ ...match, path: rebased });
		}
	}
	aggregatedMatches.sort((left, right) => {
		const pathCmp = left.path.localeCompare(right.path);
		if (pathCmp !== 0) return pathCmp;
		if (left.startLine !== right.startLine) return left.startLine - right.startLine;
		if (left.startColumn !== right.startColumn) return left.startColumn - right.startColumn;
		if (left.byteStart !== right.byteStart) return left.byteStart - right.byteStart;
		return left.byteEnd - right.byteEnd;
	});
	const visible = aggregatedMatches.slice(options.skip);
	const paged = visible.slice(0, options.limit);
	const filesWithMatches = new Set(aggregatedMatches.map(match => match.path)).size;
	return {
		matches: paged,
		totalMatches,
		filesWithMatches,
		filesSearched,
		limitReached: limitReached || visible.length > options.limit,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
	};
}

export interface AstGrepToolDetails {
	matchCount: number;
	fileCount: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
	/** Total parse error count before {@link PARSE_ERRORS_LIMIT} capping. Omitted when no errors. */
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter and `*` to mark match lines. The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
}

export class AstGrepTool implements AgentTool<typeof astGrepSchema, AstGrepToolDetails> {
	readonly name = "ast_grep";
	readonly label = "AST Grep";
	readonly summary = "Search code with AST patterns (structural grep)";
	readonly description: string;
	readonly parameters = astGrepSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(astGrepDescription);
	}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof astGrepSchema>,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstGrepToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstGrepToolDetails>> {
		return untilAborted(signal, async () => {
			const pattern = params.pat.trim();
			if (pattern.length === 0) {
				throw new ToolError("`pat` must be a non-empty pattern");
			}
			const patterns = [pattern];
			const skip = params.skip === undefined ? 0 : Math.floor(params.skip);
			if (!Number.isFinite(skip) || skip < 0) {
				throw new ToolError("skip must be a non-negative number");
			}
			const scope = await resolveToolSearchScope({
				rawPaths: params.paths,
				cwd: this.session.cwd,
				getArtifactsDir: this.session.getArtifactsDir,
				internalUrlAction: "search",
			});
			const { searchPath: resolvedSearchPath, scopePath, isDirectory, multiTargets, globFilter } = scope;

			const DEFAULT_AST_LIMIT = 50;
			const result = multiTargets
				? await runMultiTargetAstGrep(multiTargets, {
						patterns,
						commonBasePath: resolvedSearchPath,
						skip,
						limit: DEFAULT_AST_LIMIT,
						signal,
					})
				: await astGrep({
						patterns,
						path: resolvedSearchPath,
						glob: globFilter,
						offset: skip,
						includeMeta: true,
						signal,
					});

			const normalizedParseErrors = (result.parseErrors ?? []).map(error => {
				const parseError = error.match(/^.+: (.+: parse error \(syntax tree contains error nodes\))$/);
				return parseError?.[1] ?? error;
			});
			const { errors: cappedParseErrors, total: parseErrorsTotal } = capParseErrors(normalizedParseErrors);
			const formatPath = (filePath: string): string =>
				formatResultPath(filePath, isDirectory, resolvedSearchPath, this.session.cwd);

			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileMatchCounts = new Map<string, number>();
			const matchesByFile = new Map<string, AstFindMatch[]>();
			for (const match of result.matches) {
				const relativePath = formatPath(match.path);
				recordFile(relativePath);
				if (!matchesByFile.has(relativePath)) {
					matchesByFile.set(relativePath, []);
				}
				matchesByFile.get(relativePath)!.push(match);
			}

			const baseDetails: AstGrepToolDetails = {
				matchCount: result.totalMatches,
				fileCount: result.filesWithMatches,
				filesSearched: result.filesSearched,
				limitReached: result.limitReached,
				...(cappedParseErrors.length > 0 ? { parseErrors: cappedParseErrors, parseErrorsTotal } : {}),
				scopePath,
				searchPath: resolvedSearchPath,
				files: fileList,
				fileMatches: [],
			};

			if (result.matches.length === 0) {
				const noMatchMessage = cappedParseErrors.length
					? "No matches found. Parse issues mean the query may be mis-scoped; narrow `paths` before concluding absence."
					: "No matches found";
				const parseMessage = cappedParseErrors.length
					? `\n${formatParseErrors(cappedParseErrors, parseErrorsTotal).join("\n")}`
					: "";
				return toolResult(baseDetails).text(`${noMatchMessage}${parseMessage}`).done();
			}

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const outputLines: string[] = [];
			const displayLines: string[] = [];
			const renderMatchesForFile = (relativePath: string): { model: string[]; display: string[] } => {
				const modelOut: string[] = [];
				const displayOut: string[] = [];
				const fileMatches = matchesByFile.get(relativePath) ?? [];
				const lineNumberWidth = fileMatches.reduce((width, match) => {
					const lineCount = match.text.split("\n").length;
					const endLine = match.startLine + lineCount - 1;
					return Math.max(width, String(match.startLine).length, String(endLine).length);
				}, 0);
				for (const match of fileMatches) {
					const matchLines = match.text.split("\n");
					for (let index = 0; index < matchLines.length; index++) {
						const lineNumber = match.startLine + index;
						const isMatch = index === 0;
						const line = matchLines[index] ?? "";
						modelOut.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
						displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
					}
					if (match.metaVariables && Object.keys(match.metaVariables).length > 0) {
						const serializedMeta = Object.entries(match.metaVariables)
							.sort(([left], [right]) => left.localeCompare(right))
							.map(([key, value]) => `${key}=${value}`)
							.join(", ");
						modelOut.push(`  meta: ${serializedMeta}`);
						displayOut.push(`  meta: ${serializedMeta}`);
					}
					fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
				}
				return { model: modelOut, display: displayOut };
			};

			if (isDirectory) {
				const grouped = formatGroupedFiles(fileList, relativePath => {
					const rendered = renderMatchesForFile(relativePath);
					return { modelLines: rendered.model, displayLines: rendered.display };
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

			const details: AstGrepToolDetails = {
				...baseDetails,
				fileMatches: fileList.map(filePath => ({
					path: filePath,
					count: fileMatchCounts.get(filePath) ?? 0,
				})),
				displayContent: displayLines.join("\n"),
			};
			if (result.limitReached) {
				outputLines.push("", "Result limit reached; narrow paths or increase limit.");
			}
			if (cappedParseErrors.length) {
				outputLines.push("", ...formatParseErrors(cappedParseErrors, parseErrorsTotal));
			}

			return toolResult(details).text(outputLines.join("\n")).done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AstGrepRenderArgs {
	pat?: string;
	paths?: string[];
	skip?: number;
}

const COLLAPSED_MATCH_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const astGrepToolRenderer = {
	inline: true,
	renderCall(args: AstGrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.paths?.length) meta.push(`in ${args.paths.join(", ")}`);
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const description = args.pat ?? "?";
		const text = renderStatusLine({ icon: "pending", title: "AST Grep", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstGrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstGrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (matchCount === 0) {
			const description = args?.pat;
			const meta = ["0 matches"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "AST Grep", description, meta }, uiTheme);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (details?.parseErrors?.length) {
				lines.push(uiTheme.fg("warning", "Query may be mis-scoped; narrow `paths` before concluding absence"));
				appendParseErrorsBulletList(lines, details.parseErrors, uiTheme, details.parseErrorsTotal);
			}
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));
		const description = args?.pat;
		const header = renderStatusLine(
			{ icon: limitReached ? "warning" : "success", title: "AST Grep", description, meta },
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allGroups = splitGroupsByBlankLine(textContent.split("\n"));
		const matchGroups = allGroups.filter(
			group => !group[0]?.startsWith("Result limit reached") && !group[0]?.startsWith("Parse issues:"),
		);

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; narrow paths or increase limit"));
		}
		if (details?.parseErrors?.length) {
			extraLines.push(
				uiTheme.fg("warning", formatParseErrorsCountLabel(details.parseErrors, details.parseErrorsTotal)),
			);
		}

		return createCachedComponent(
			() => options.expanded,
			width => {
				const searchBase = details?.searchPath;
				const matchLines = renderTreeList(
					{
						items: matchGroups,
						expanded: options.expanded,
						maxCollapsed: matchGroups.length,
						maxCollapsedLines: COLLAPSED_MATCH_LIMIT,
						itemType: "match",
						renderItem: group => {
							let contextDir = searchBase ?? "";
							return group.map(line => {
								if (line.startsWith("## ")) {
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
									// Root-level file (single # without trailing slash) from formatGroupedFiles.
									const absPath = searchBase && name ? path.join(searchBase, name) : undefined;
									const styled = uiTheme.fg("accent", line);
									return absPath ? fileHyperlink(absPath, styled) : styled;
								}
								if (line.startsWith("  meta:")) return uiTheme.fg("dim", line);
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
