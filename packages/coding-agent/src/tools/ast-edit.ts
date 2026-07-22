import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { type AstReplaceChange, type AstReplaceFileChange, astEdit } from "@gajae-code/natives";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { $pickenvpos, prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { computeLineHash, HL_BODY_SEP } from "../hashline/hash";
import type { Theme } from "../modes/theme/theme";
import astEditDescription from "../prompts/tools/ast-edit.md" with { type: "text" };
import { assertWorkflowMutationRawPathsAllowed } from "../skill-state/workflow-mutation-guard";
import { Ellipsis, fileHyperlink, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { formatGroupedFiles } from "./grouped-file-output";
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
import { queueResolveHandler } from "./resolve";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const astEditOpSchema = z.object({
	pat: z.string().describe("ast pattern"),
	out: z.string().describe("replacement template"),
});

const astEditSchema = z.object({
	ops: z.array(astEditOpSchema).min(1).describe("rewrite ops"),
	paths: z
		.array(z.string().describe("file, directory, glob, or internal URL to rewrite"))
		.min(1)
		.describe("files, directories, globs, or internal URLs to rewrite"),
});

interface AstEditCallOptions {
	rewrites: Record<string, string>;
	dryRun: boolean;
	maxFiles: number;
	failOnParseError: boolean;
	signal?: AbortSignal;
}

interface AstEditAggregatedResult {
	changes: AstReplaceChange[];
	fileChanges: AstReplaceFileChange[];
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
}

async function runAstEditTargets(
	targets: Array<{ basePath: string; glob?: string }>,
	commonBasePath: string,
	options: AstEditCallOptions,
): Promise<AstEditAggregatedResult> {
	const aggregatedChanges: AstReplaceChange[] = [];
	const fileCounts = new Map<string, number>();
	const parseErrors: string[] = [];
	let totalReplacements = 0;
	let filesSearched = 0;
	let limitReached = false;
	let applied = !options.dryRun;
	for (const target of targets) {
		const targetResult = await astEdit({
			rewrites: options.rewrites,
			path: target.basePath,
			glob: target.glob,
			dryRun: options.dryRun,
			maxFiles: options.maxFiles,
			failOnParseError: options.failOnParseError,
			signal: options.signal,
		});
		totalReplacements += targetResult.totalReplacements;
		filesSearched += targetResult.filesSearched;
		limitReached = limitReached || targetResult.limitReached;
		applied = applied && targetResult.applied;
		if (targetResult.parseErrors) parseErrors.push(...targetResult.parseErrors);
		for (const change of targetResult.changes) {
			const absolute = path.resolve(target.basePath, change.path);
			const rebased = path.relative(commonBasePath, absolute).replace(/\\/g, "/");
			aggregatedChanges.push({ ...change, path: rebased });
		}
		for (const fileChange of targetResult.fileChanges) {
			const absolute = path.resolve(target.basePath, fileChange.path);
			const rebased = path.relative(commonBasePath, absolute).replace(/\\/g, "/");
			fileCounts.set(rebased, (fileCounts.get(rebased) ?? 0) + fileChange.count);
		}
	}
	const fileChanges: AstReplaceFileChange[] = Array.from(fileCounts, ([changePath, count]) => ({
		path: changePath,
		count,
	}));
	return {
		changes: aggregatedChanges,
		fileChanges,
		totalReplacements,
		filesTouched: fileChanges.length,
		filesSearched,
		applied,
		limitReached,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
	};
}

function runAstEditOnce(
	targets: Array<{ basePath: string; glob?: string }> | undefined,
	resolvedSearchPath: string,
	globFilter: string | undefined,
	options: AstEditCallOptions,
): Promise<AstEditAggregatedResult> {
	if (targets) {
		return runAstEditTargets(targets, resolvedSearchPath, options);
	}
	return astEdit({
		rewrites: options.rewrites,
		path: resolvedSearchPath,
		glob: globFilter,
		dryRun: options.dryRun,
		maxFiles: options.maxFiles,
		failOnParseError: options.failOnParseError,
		signal: options.signal,
	});
}

export interface AstEditToolDetails {
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
	/** Total parse error count before {@link PARSE_ERRORS_LIMIT} capping. Omitted when no errors. */
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileReplacements?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter (no model-only hashline anchors). The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	/** Absolute base directory used during the edit. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
}

export class AstEditTool implements AgentTool<typeof astEditSchema, AstEditToolDetails> {
	readonly name = "ast_edit";
	readonly label = "AST Edit";
	readonly summary = "Perform AST-aware code edits (structural refactoring)";
	readonly description: string;
	readonly parameters = astEditSchema;
	readonly strict = true;
	readonly deferrable = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(astEditDescription);
	}

	async execute(
		_toolCallId: string,
		params: z.infer<typeof astEditSchema>,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AstEditToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AstEditToolDetails>> {
		return untilAborted(signal, async () => {
			const ops = params.ops.map((entry, index) => {
				if (entry.pat.length === 0) {
					throw new ToolError(`\`ops[${index}].pat\` must be a non-empty pattern`);
				}
				return [entry.pat, entry.out] as const;
			});
			if (ops.length === 0) {
				throw new ToolError("`ops` must include at least one op entry");
			}
			const seenPatterns = new Set<string>();
			for (const [pat] of ops) {
				if (seenPatterns.has(pat)) {
					throw new ToolError(`Duplicate rewrite pattern: ${pat}`);
				}
				seenPatterns.add(pat);
			}
			const normalizedRewrites = Object.fromEntries(ops);
			const maxFiles = $pickenvpos(["GJC_MAX_AST_FILES", "PI_MAX_AST_FILES"], 1000);

			const scope = await resolveToolSearchScope({
				rawPaths: params.paths,
				cwd: this.session.cwd,
				getArtifactsDir: this.session.getArtifactsDir,
				internalUrlAction: "rewrite",
			});
			const { searchPath: resolvedSearchPath, scopePath, isDirectory, multiTargets, globFilter } = scope;

			const result = await runAstEditOnce(multiTargets, resolvedSearchPath, globFilter, {
				rewrites: normalizedRewrites,
				dryRun: true,
				maxFiles,
				failOnParseError: false,
				signal,
			});

			const { errors: cappedParseErrors, total: parseErrorsTotal } = capParseErrors(result.parseErrors);
			const formatPath = (filePath: string): string =>
				formatResultPath(filePath, isDirectory, resolvedSearchPath, this.session.cwd);

			const { record: recordFile, list: fileList } = createFileRecorder();
			const fileReplacementCounts = new Map<string, number>();
			const changesByFile = new Map<string, AstReplaceChange[]>();
			for (const fileChange of result.fileChanges) {
				const relativePath = formatPath(fileChange.path);
				recordFile(relativePath);
				fileReplacementCounts.set(relativePath, (fileReplacementCounts.get(relativePath) ?? 0) + fileChange.count);
			}
			for (const change of result.changes) {
				const relativePath = formatPath(change.path);
				recordFile(relativePath);
				if (!changesByFile.has(relativePath)) {
					changesByFile.set(relativePath, []);
				}
				changesByFile.get(relativePath)!.push(change);
			}

			const baseDetails: AstEditToolDetails = {
				totalReplacements: result.totalReplacements,
				filesTouched: result.filesTouched,
				filesSearched: result.filesSearched,
				applied: result.applied,
				limitReached: result.limitReached,
				...(cappedParseErrors.length > 0 ? { parseErrors: cappedParseErrors, parseErrorsTotal } : {}),
				scopePath,
				searchPath: resolvedSearchPath,
				files: fileList,
				fileReplacements: [],
			};

			if (result.totalReplacements === 0) {
				const parseMessage = cappedParseErrors.length
					? `\n${formatParseErrors(cappedParseErrors, parseErrorsTotal).join("\n")}`
					: "";
				return toolResult(baseDetails).text(`No replacements made${parseMessage}`).done();
			}

			const useHashLines = resolveFileDisplayMode(this.session).hashLines;
			const outputLines: string[] = [];
			const displayLines: string[] = [];
			const renderChangesForFile = (relativePath: string): { model: string[]; display: string[] } => {
				const modelOut: string[] = [];
				const displayOut: string[] = [];
				const fileChanges = changesByFile.get(relativePath) ?? [];
				const lineNumberWidth = fileChanges.reduce(
					(width, change) => Math.max(width, String(change.startLine).length),
					0,
				);
				for (const change of fileChanges) {
					const beforeFirstLine = change.before.split("\n", 1)[0] ?? "";
					const afterFirstLine = change.after.split("\n", 1)[0] ?? "";
					const beforeLine = beforeFirstLine.slice(0, 120);
					const afterLine = afterFirstLine.slice(0, 120);
					const beforeRef = useHashLines
						? `${change.startLine}${computeLineHash(change.startLine, beforeFirstLine)}`
						: `${change.startLine}:${change.startColumn}`;
					const afterRef = useHashLines
						? `${change.startLine}${computeLineHash(change.startLine, afterFirstLine)}`
						: `${change.startLine}:${change.startColumn}`;
					const lineSeparator = useHashLines ? HL_BODY_SEP : " ";
					modelOut.push(`-${beforeRef}${lineSeparator}${beforeLine}`);
					modelOut.push(`+${afterRef}${lineSeparator}${afterLine}`);
					displayOut.push(formatCodeFrameLine("-", change.startLine, beforeLine, lineNumberWidth));
					displayOut.push(formatCodeFrameLine("+", change.startLine, afterLine, lineNumberWidth));
				}
				return { model: modelOut, display: displayOut };
			};

			if (isDirectory) {
				const grouped = formatGroupedFiles(fileList, relativePath => {
					const rendered = renderChangesForFile(relativePath);
					const count = fileReplacementCounts.get(relativePath) ?? 0;
					return {
						headerSuffix: ` (${formatCount("replacement", count)})`,
						modelLines: rendered.model,
						displayLines: rendered.display,
					};
				});
				outputLines.push(...grouped.model);
				displayLines.push(...grouped.display);
			} else {
				for (const relativePath of fileList) {
					const rendered = renderChangesForFile(relativePath);
					outputLines.push(...rendered.model);
					displayLines.push(...rendered.display);
				}
			}

			const fileReplacements = fileList.map(filePath => ({
				path: filePath,
				count: fileReplacementCounts.get(filePath) ?? 0,
			}));
			if (result.limitReached) {
				outputLines.push("", "Limit reached; narrow paths.");
			}
			if (cappedParseErrors.length) {
				outputLines.push("", ...formatParseErrors(cappedParseErrors, parseErrorsTotal));
			}

			// Register pending action so `resolve` can apply or discard these previewed changes
			if (!result.applied && result.totalReplacements > 0) {
				const previewReplacementPlural = result.totalReplacements !== 1 ? "s" : "";
				const previewFilePlural = result.filesTouched !== 1 ? "s" : "";
				const previewedFiles = fileList;
				queueResolveHandler(this.session, {
					label: `AST Edit: ${result.totalReplacements} replacement${previewReplacementPlural} in ${result.filesTouched} file${previewFilePlural}`,
					sourceToolName: this.name,
					apply: async (_reason: string) => {
						await assertWorkflowMutationRawPathsAllowed({
							cwd: this.session.cwd,
							sessionId: this.session.getSessionId?.() ?? undefined,
							rawPaths: previewedFiles,
						});
						const applyResult = await runAstEditOnce(multiTargets, resolvedSearchPath, globFilter, {
							rewrites: normalizedRewrites,
							dryRun: false,
							maxFiles,
							failOnParseError: false,
						});
						const { errors: cappedApplyParseErrors, total: applyParseErrorsTotal } = capParseErrors(
							applyResult.parseErrors,
						);
						const { record: recordAppliedFile, list: appliedFileList } = createFileRecorder();
						const appliedFileReplacementCounts = new Map<string, number>();
						for (const fileChange of applyResult.fileChanges) {
							const relativePath = formatPath(fileChange.path);
							recordAppliedFile(relativePath);
							appliedFileReplacementCounts.set(
								relativePath,
								(appliedFileReplacementCounts.get(relativePath) ?? 0) + fileChange.count,
							);
						}
						for (const change of applyResult.changes) {
							recordAppliedFile(formatPath(change.path));
						}
						const appliedFileReplacements = appliedFileList.map(filePath => ({
							path: filePath,
							count: appliedFileReplacementCounts.get(filePath) ?? 0,
						}));
						const appliedDetails: AstEditToolDetails = {
							totalReplacements: applyResult.totalReplacements,
							filesTouched: applyResult.filesTouched,
							filesSearched: applyResult.filesSearched,
							applied: applyResult.applied,
							limitReached: applyResult.limitReached,
							...(cappedApplyParseErrors.length > 0
								? { parseErrors: cappedApplyParseErrors, parseErrorsTotal: applyParseErrorsTotal }
								: {}),
							scopePath,
							files: appliedFileList,
							fileReplacements: appliedFileReplacements,
						};
						const stalePreview =
							applyResult.totalReplacements !== result.totalReplacements ||
							applyResult.filesTouched !== result.filesTouched ||
							fileList.some(
								filePath => appliedFileReplacementCounts.get(filePath) !== fileReplacementCounts.get(filePath),
							) ||
							appliedFileList.some(
								filePath => fileReplacementCounts.get(filePath) !== appliedFileReplacementCounts.get(filePath),
							);
						if (stalePreview) {
							const text =
								applyResult.totalReplacements === 0
									? `Preview is stale / no longer matches; no replacements were applied. Preview expected ${result.totalReplacements} replacement${previewReplacementPlural} in ${result.filesTouched} file${previewFilePlural}.`
									: applyResult.totalReplacements < result.totalReplacements
										? `Preview is stale / no longer matches; only ${applyResult.totalReplacements} of ${result.totalReplacements} replacements were applied in ${applyResult.filesTouched} of ${result.filesTouched} files.`
										: `Preview is stale / no longer matches; applied ${applyResult.totalReplacements} replacements but preview expected ${result.totalReplacements}.`;
							return { ...toolResult(appliedDetails).text(text).done(), isError: true };
						}
						const appliedReplacementPlural = applyResult.totalReplacements !== 1 ? "s" : "";
						const appliedFilePlural = applyResult.filesTouched !== 1 ? "s" : "";
						const text = `Applied ${applyResult.totalReplacements} replacement${appliedReplacementPlural} in ${applyResult.filesTouched} file${appliedFilePlural}.`;
						return toolResult(appliedDetails).text(text).done();
					},
				});
			}

			const details: AstEditToolDetails = {
				...baseDetails,
				fileReplacements,
				displayContent: displayLines.join("\n"),
			};
			return toolResult(details).text(outputLines.join("\n")).done();
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface AstEditRenderArgs {
	ops?: Array<{ pat?: string; out?: string }>;
	paths?: string[];
}

const COLLAPSED_CHANGE_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const astEditToolRenderer = {
	inline: true,
	renderCall(args: AstEditRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.paths?.length) meta.push(`in ${args.paths.join(", ")}`);
		const rewriteCount = args.ops?.length ?? 0;
		if (rewriteCount > 1) meta.push(`${rewriteCount} rewrites`);

		const description = rewriteCount === 1 ? args.ops?.[0]?.pat : rewriteCount ? `${rewriteCount} rewrites` : "?";
		const text = renderStatusLine({ icon: "pending", title: "AST Edit", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstEditToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstEditRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const totalReplacements = details?.totalReplacements ?? 0;
		const filesTouched = details?.filesTouched ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (totalReplacements === 0) {
			const rewriteCount = args?.ops?.length ?? 0;
			const description = rewriteCount === 1 ? args?.ops?.[0]?.pat : undefined;
			const meta = ["0 replacements"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "AST Edit", description, meta }, uiTheme);
			const lines = [header, formatEmptyMessage("No replacements made", uiTheme)];
			appendParseErrorsBulletList(lines, details?.parseErrors, uiTheme, details?.parseErrorsTotal);
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("replacement", totalReplacements), formatCount("file", filesTouched)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));
		const rewriteCount = args?.ops?.length ?? 0;
		const description = rewriteCount === 1 ? args?.ops?.[0]?.pat : undefined;

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allGroups = splitGroupsByBlankLine(textContent.split("\n"));
		const changeGroups = allGroups.filter(
			group => !group[0]?.startsWith("Safety cap reached") && !group[0]?.startsWith("Parse issues:"),
		);

		const badge = { label: "proposed", color: "warning" as const };
		const header = renderStatusLine(
			{ icon: limitReached ? "warning" : "success", title: "AST Edit", description, badge, meta },
			uiTheme,
		);

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; narrow path"));
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
				const changeLines = renderTreeList(
					{
						items: changeGroups,
						expanded: options.expanded,
						maxCollapsed: changeGroups.length,
						maxCollapsedLines: COLLAPSED_CHANGE_LIMIT,
						itemType: "change",
						renderItem: group => {
							let contextDir = searchBase ?? "";
							return group.map(line => {
								if (line.startsWith("## ")) {
									// Strip ` (3 replacements)` suffix attached by formatGroupedFiles.
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
									// Root-level file with optional suffix, e.g. `# foo.ts (3 replacements)`.
									const absPath = searchBase && name ? path.join(searchBase, name) : undefined;
									const styled = uiTheme.fg("accent", line);
									return absPath ? fileHyperlink(absPath, styled) : styled;
								}
								if (line.startsWith("+")) return uiTheme.fg("toolDiffAdded", line);
								if (line.startsWith("-")) return uiTheme.fg("toolDiffRemoved", line);
								return uiTheme.fg("toolOutput", line);
							});
						},
					},
					uiTheme,
				);
				return [header, ...changeLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
		);
	},
	mergeCallAndResult: true,
};
