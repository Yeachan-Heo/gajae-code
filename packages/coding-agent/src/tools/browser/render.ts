/**
 * TUI renderer for the browser tool.
 *
 * Mirrors the `eval` tool look: each `run` invocation is shown as a JS code
 * cell with status icon, optional output, and expand/collapse handling. `open`
 * and `close` actions render as compact status lines.
 */
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import { Hasher, renderCodeCell, renderStatusLine } from "../../tui";
import type { BrowserToolDetails } from "../browser";
import { formatStyledTruncationWarning, stripOutputNotice } from "../output-meta";
import { replaceTabs, shortenPath } from "../render-utils";

const BROWSER_DEFAULT_PREVIEW_LINES = 10;

interface BrowserRenderArgs {
	action?: "open" | "close" | "run";
	name?: string;
	url?: string;
	code?: string;
	all?: boolean;
	kill?: boolean;
	app?: {
		path?: string;
		cdp_url?: string;
		browser?: string;
		user_data_dir?: string;
		profile_directory?: string;
		target?: string;
	};
	viewport?: { width: number; height: number; scale?: number };
	timeout?: number;
}

interface BrowserRenderContext {
	expanded?: boolean;
	previewLines?: number;
}

function describeBrowser(args: BrowserRenderArgs, details: BrowserToolDetails | undefined): string | undefined {
	if (args.app?.cdp_url) return `connected ${args.app.cdp_url}`;
	if (args.app?.browser === "chrome") return `Chrome profile ${args.app.profile_directory ?? "<profile>"}`;
	if (args.app?.path) return `spawned ${shortenPath(args.app.path)}`;
	switch (details?.browser) {
		case "headless":
			return "headless";
		case "spawned":
			return "spawned";
		case "connected":
			return "connected";
		default:
			return undefined;
	}
}

function tabLabel(args: BrowserRenderArgs, details: BrowserToolDetails | undefined): string {
	const name = details?.name ?? args.name ?? "main";
	return `tab ${JSON.stringify(name)}`;
}

function cellStatus(isPartial: boolean, isError: boolean): "pending" | "running" | "complete" | "error" {
	if (isPartial) return "running";
	if (isError) return "error";
	return "complete";
}

function dropTrailingBlankLines(text: string): string {
	return text.replace(/\s+$/, "");
}

function appendLine(component: Component, line: string | undefined): Component {
	if (!line) return component;
	return {
		render: (width: number): string[] => {
			const base = component.render(width);
			return [...base, line];
		},
		invalidate: () => component.invalidate?.(),
	};
}

function renderRunCell(
	args: BrowserRenderArgs,
	details: BrowserToolDetails | undefined,
	options: RenderResultOptions & { renderContext?: BrowserRenderContext },
	output: string,
	isError: boolean,
	theme: Theme,
): Component {
	const code = dropTrailingBlankLines(args.code ?? "");
	const status = cellStatus(options.isPartial, isError);

	const titleParts: string[] = [tabLabel(args, details)];
	const url = details?.url ?? args.url;
	if (url) titleParts.push(shortenPath(url));
	const browserDesc = describeBrowser(args, details);
	if (browserDesc) titleParts.push(browserDesc);
	const title = titleParts.join(" · ");

	let cached: { key: bigint; width: number; lines: string[] } | undefined;
	return {
		render: (width: number): string[] => {
			const expanded = options.renderContext?.expanded ?? options.expanded;
			const previewLines = options.renderContext?.previewLines ?? BROWSER_DEFAULT_PREVIEW_LINES;
			const key = new Hasher()
				.bool(expanded)
				.bool(isError)
				.u32(previewLines)
				.u32(options.spinnerFrame ?? 0)
				.str(status)
				.str(title)
				.str(code)
				.str(output)
				.digest();
			if (cached && cached.width === width && cached.key === key) {
				return cached.lines;
			}
			const lines = renderCodeCell(
				{
					code,
					language: "javascript",
					title,
					status,
					spinnerFrame: options.spinnerFrame,
					output: output.length > 0 ? output : undefined,
					outputMaxLines: expanded ? Number.POSITIVE_INFINITY : previewLines,
					codeMaxLines: expanded ? Number.POSITIVE_INFINITY : previewLines,
					expanded,
					width,
				},
				theme,
			);
			cached = { key, width, lines };
			return lines;
		},
		invalidate: () => {
			cached = undefined;
		},
	};
}

function renderOpenOrCloseLine(
	args: BrowserRenderArgs,
	details: BrowserToolDetails | undefined,
	isPartial: boolean,
	isError: boolean,
	output: string,
	theme: Theme,
): Component {
	const action = (details?.action ?? args.action ?? "open") as "open" | "close" | "run";
	const status = cellStatus(isPartial, isError);
	const icon =
		status === "complete" ? "success" : status === "error" ? "error" : status === "running" ? "running" : "pending";

	let title: string;
	if (action === "close") {
		const all = args.all === true || (args.name === undefined && details?.name === undefined);
		title = all ? "Close all tabs" : `Close ${tabLabel(args, details)}`;
		if (args.kill) title += " (kill)";
	} else {
		title = `Open ${tabLabel(args, details)}`;
	}

	const meta: string[] = [];
	const browserDesc = describeBrowser(args, details);
	if (browserDesc) meta.push(browserDesc);
	const url = details?.url ?? args.url;
	if (url) meta.push(shortenPath(url));

	const header = renderStatusLine({ icon, title, meta }, theme);
	if (!output) return new Text(header, 0, 0);
	const outputLines = output.split("\n").map(line => theme.fg("toolOutput", replaceTabs(line)));
	return new Text([header, ...outputLines].join("\n"), 0, 0);
}

function extractTextOutput(content: Array<{ type: string; text?: string }> | undefined): string {
	if (!content) return "";
	const text = content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
	return dropTrailingBlankLines(text);
}

export const browserToolRenderer = {
	renderCall(args: BrowserRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		const action = args.action;
		if (action === "run") {
			return renderRunCell(args, undefined, options, "", false, theme);
		}
		return renderOpenOrCloseLine(args, undefined, options.isPartial, false, "", theme);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: BrowserToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: BrowserRenderContext },
		theme: Theme,
		args?: BrowserRenderArgs,
	): Component {
		const argsObj = args ?? {};
		const details = result.details;
		const action = details?.action ?? argsObj.action;
		const isError = result.isError === true;
		const output = stripOutputNotice(extractTextOutput(result.content), details?.meta);

		if (action === "run") {
			let component = renderRunCell(argsObj, details, options, output, isError, theme);
			const truncationWarning = details?.meta?.truncation
				? (formatStyledTruncationWarning(details.meta, theme) ?? undefined)
				: undefined;
			component = appendLine(component, truncationWarning);
			return component;
		}
		return renderOpenOrCloseLine(argsObj, details, options.isPartial, isError, output, theme);
	},
	mergeCallAndResult: true,
	inline: true,
};
