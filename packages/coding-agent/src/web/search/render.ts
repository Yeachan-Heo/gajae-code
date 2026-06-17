/**
 * Web Search TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for web search results.
 */

import type { Component } from "@gajae-code/tui";
import { Text, visibleWidth, wrapTextWithAnsi } from "@gajae-code/tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import {
	formatAge,
	formatCount,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getDomain,
	getPreviewLines,
	PREVIEW_LIMITS,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../../tools/render-utils";
import { renderStatusLine, renderTreeList } from "../../tui";
import { CachedOutputBlock } from "../../tui/output-block";
import { getSearchProviderLabel } from "./provider";
import type { SearchResponse } from "./types";

const MAX_COLLAPSED_ANSWER_LINES = PREVIEW_LIMITS.COLLAPSED_LINES;
const MAX_EXPANDED_ANSWER_LINES = PREVIEW_LIMITS.EXPANDED_LINES;
const MAX_ANSWER_LINE_LEN = TRUNCATE_LENGTHS.LINE;
const MAX_SNIPPET_LINES = 2;
const MAX_SNIPPET_LINE_LEN = TRUNCATE_LENGTHS.LINE;
const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const MAX_QUERY_PREVIEW = 2;
const MAX_QUERY_LEN = 90;
const MAX_REQUEST_ID_LEN = 36;

function renderFallbackText(contentText: string, expanded: boolean, theme: Theme): Component {
	const lines = contentText.split("\n").filter(line => line.trim());
	const maxLines = expanded ? lines.length : 6;
	const displayLines = lines.slice(0, maxLines).map(line => truncateToWidth(line.trim(), 110));
	const remaining = lines.length - displayLines.length;

	const headerIcon = formatStatusIcon("warning", theme);
	const expandHint = formatExpandHint(theme, expanded, remaining > 0);
	let text = `${headerIcon} ${theme.fg("dim", "Response")}${expandHint}`;

	if (displayLines.length === 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", "No response data")}`;
		return new Text(text, 0, 0);
	}

	for (let i = 0; i < displayLines.length; i++) {
		const isLast = i === displayLines.length - 1 && remaining === 0;
		const branch = isLast ? theme.tree.last : theme.tree.branch;
		text += `\n ${theme.fg("dim", branch)} ${theme.fg("dim", displayLines[i])}`;
	}

	if (!expanded && remaining > 0) {
		text += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", formatMoreItems(remaining, "line"))}`;
	}

	return new Text(text, 0, 0);
}

export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
}

/** Render web search result with tree-based layout */
export function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: {
		query?: string;
		allowLongAnswer?: boolean;
		maxAnswerLines?: number;
	},
): Component {
	const details = result.details;

	// Handle error case
	if (details?.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	const rawText = result.content?.find(block => block.type === "text")?.text?.trim() ?? "";
	const response = details?.response;
	if (!response) {
		return renderFallbackText(rawText, options.expanded, theme);
	}

	const sources = Array.isArray(response.sources) ? response.sources : [];
	const sourceCount = sources.length;
	const citations = Array.isArray(response.citations) ? response.citations : [];
	const citationCount = citations.length;
	const searchQueries = Array.isArray(response.searchQueries)
		? response.searchQueries.filter(item => typeof item === "string")
		: [];
	const provider = response.provider;

	// Get answer text
	const answerText = typeof response.answer === "string" ? response.answer.trim() : "";
	const contentText = answerText || rawText;
	const answerLines = contentText
		? contentText
				.split("\n")
				.filter(l => l.trim())
				.map(l => l.trim())
		: [];
	const totalAnswerLines = answerLines.length;

	const providerLabel = provider !== "none" ? getSearchProviderLabel(provider) : "None";
	const queryPreview = args?.query
		? truncateToWidth(args.query, 80)
		: searchQueries[0]
			? truncateToWidth(searchQueries[0], 80)
			: undefined;
	const header = renderStatusLine(
		{
			icon: sourceCount > 0 ? "success" : "warning",
			title: "Web Search",
			description: providerLabel,
			meta: [formatCount("source", sourceCount)],
		},
		theme,
	);

	const metaLines: string[] = [];
	metaLines.push(`${theme.fg("muted", "Provider:")} ${theme.fg("text", providerLabel)}`);
	if (response.authMode)
		metaLines.push(
			`${theme.fg("muted", "Auth:")} ${theme.fg("text", response.authMode === "oauth" ? "OAuth" : response.authMode === "api_key" ? "API key" : response.authMode)}`,
		);
	if (response.model) metaLines.push(`${theme.fg("muted", "Model:")} ${theme.fg("text", response.model)}`);
	metaLines.push(`${theme.fg("muted", "Sources:")} ${theme.fg("text", String(sourceCount))}`);
	if (citationCount > 0)
		metaLines.push(`${theme.fg("muted", "Citations:")} ${theme.fg("text", String(citationCount))}`);
	if (response.usage) {
		const usageParts: string[] = [];
		if (response.usage.inputTokens !== undefined) usageParts.push(`in ${response.usage.inputTokens}`);
		if (response.usage.outputTokens !== undefined) usageParts.push(`out ${response.usage.outputTokens}`);
		if (response.usage.totalTokens !== undefined) usageParts.push(`total ${response.usage.totalTokens}`);
		if (response.usage.searchRequests !== undefined) usageParts.push(`search ${response.usage.searchRequests}`);
		if (response.usage.xSearchRequests !== undefined) usageParts.push(`x ${response.usage.xSearchRequests}`);
		if (response.usage.imageSearchRequests !== undefined)
			usageParts.push(`image ${response.usage.imageSearchRequests}`);
		if (response.usage.imageUnderstandingRequests !== undefined)
			usageParts.push(`view ${response.usage.imageUnderstandingRequests}`);
		if (response.usage.videoUnderstandingRequests !== undefined)
			usageParts.push(`video ${response.usage.videoUnderstandingRequests}`);
		if (usageParts.length > 0)
			metaLines.push(`${theme.fg("muted", "Usage:")} ${theme.fg("text", usageParts.join(theme.sep.dot))}`);
	}
	if (response.requestId) {
		metaLines.push(
			`${theme.fg("muted", "Request:")} ${theme.fg("text", truncateToWidth(response.requestId, MAX_REQUEST_ID_LEN))}`,
		);
	}
	if (searchQueries.length > 0) {
		const queriesPreview = searchQueries.slice(0, MAX_QUERY_PREVIEW);
		const queryList = queriesPreview.map(q => truncateToWidth(q, MAX_QUERY_LEN));
		const suffix = searchQueries.length > queriesPreview.length ? "…" : "";
		metaLines.push(`${theme.fg("muted", "Queries:")} ${theme.fg("text", queryList.join("; "))}${suffix}`);
	}

	const outputBlock = new CachedOutputBlock();

	return {
		render(width: number): string[] {
			// Read mutable state at render time
			const { expanded } = options;

			// Expanded-dependent computations
			const answerLimit = expanded ? MAX_EXPANDED_ANSWER_LINES : MAX_COLLAPSED_ANSWER_LINES;
			const answerPreview = contentText
				? args?.allowLongAnswer
					? answerLines.slice(0, args.maxAnswerLines ?? answerLines.length)
					: getPreviewLines(contentText, answerLimit, MAX_ANSWER_LINE_LEN)
				: [];
			const remainingAnswer = totalAnswerLines - answerPreview.length;

			const sourceTree = renderTreeList(
				{
					items: sources,
					expanded,
					maxCollapsed: MAX_COLLAPSED_ITEMS,
					itemType: "source",
					renderItem: src => {
						const titleText =
							typeof src.title === "string" && src.title.trim()
								? src.title
								: typeof src.url === "string" && src.url.trim()
									? src.url
									: "Untitled";
						const title = truncateToWidth(titleText, MAX_SNIPPET_LINE_LEN);
						const url = typeof src.url === "string" ? src.url : "";
						const domain = url ? getDomain(url) : "";
						const age =
							formatAge(src.ageSeconds) || (typeof src.publishedDate === "string" ? src.publishedDate : "");
						const metaParts: string[] = [];
						if (domain) metaParts.push(theme.fg("dim", `(${domain})`));
						if (typeof src.author === "string" && src.author.trim())
							metaParts.push(theme.fg("muted", truncateToWidth(src.author.trim(), 40)));
						if (age) metaParts.push(theme.fg("muted", age));
						const metaSep = theme.fg("dim", theme.sep.dot);
						const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
						const srcLines: string[] = [
							truncateToWidth(`${theme.fg("accent", title)}${metaSuffix}`, MAX_SNIPPET_LINE_LEN),
						];
						const snippetText = typeof src.snippet === "string" ? src.snippet : "";
						if (snippetText.trim()) {
							const snippetLines = getPreviewLines(snippetText, MAX_SNIPPET_LINES, MAX_SNIPPET_LINE_LEN);
							for (const snippetLine of snippetLines) {
								srcLines.push(theme.fg("muted", `${theme.format.dash} ${snippetLine}`));
							}
						}
						if (url) srcLines.push(theme.fg("mdLinkUrl", truncateToWidth(url, MAX_SNIPPET_LINE_LEN)));
						return srcLines;
					},
				},
				theme,
			);

			// Build answer section
			const answerState = sourceCount > 0 ? "success" : "warning";
			const borderColor: "warning" | "dim" = answerState === "warning" ? "warning" : "dim";
			const border = (t: string) => theme.fg(borderColor, t);
			const contentPrefix = border(`${theme.boxSharp.vertical} `);
			const contentSuffix = border(theme.boxSharp.vertical);
			const contentWidth = Math.max(0, width - visibleWidth(contentPrefix) - visibleWidth(contentSuffix));
			const answerTreeLines = answerPreview.length > 0 ? answerPreview : ["No answer text returned"];
			const answerTree = renderTreeList(
				{
					items: answerTreeLines,
					expanded: true,
					maxCollapsed: answerTreeLines.length,
					itemType: "line",
					renderItem: (line, context) => {
						const coloredLine =
							line === "No answer text returned" ? theme.fg("muted", line) : theme.fg("dim", line);
						if (!args?.allowLongAnswer) {
							return coloredLine;
						}
						const prefixWidth = visibleWidth(context.continuePrefix);
						const wrapWidth = Math.max(10, contentWidth - prefixWidth);
						return wrapTextWithAnsi(coloredLine, wrapWidth);
					},
				},
				theme,
			);
			if (remainingAnswer > 0) {
				answerTree.push(theme.fg("muted", formatMoreItems(remainingAnswer, "line")));
			}

			return outputBlock.render(
				{
					header,
					state: sourceCount > 0 ? "success" : "warning",
					sections: [
						...(queryPreview
							? [
									{
										lines: [`${theme.fg("muted", "Query:")} ${theme.fg("text", queryPreview)}`],
									},
								]
							: []),
						{
							label: theme.fg("toolTitle", "Answer"),
							lines: answerTree,
						},
						{
							label: theme.fg("toolTitle", "Sources"),
							lines: sourceTree.length > 0 ? sourceTree : [theme.fg("muted", "No sources returned")],
						},
						{ label: theme.fg("toolTitle", "Metadata"), lines: metaLines },
					],
					width,
				},
				theme,
			);
		},
		invalidate() {
			outputBlock.invalidate();
		},
	};
}

/** Render web search call (query preview) */
export function renderSearchCall(
	args: { query?: string; [key: string]: unknown },
	_options: RenderResultOptions,
	theme: Theme,
): Component {
	const query = truncateToWidth(args.query ?? "", 80);
	const text = renderStatusLine({ icon: "pending", title: "Web Search", description: query }, theme);
	return new Text(text, 0, 0);
}

export const webSearchToolRenderer = {
	renderCall: renderSearchCall,
	renderResult: renderSearchResult,
	mergeCallAndResult: true,
};
