/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */
import type { Component } from "@gajae-code/tui";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolRenderer } from "../goals/tools/goal-tool";
import { lspToolRenderer } from "../lsp/render";
import type { Theme } from "../modes/theme/theme";
import { taskToolRenderer } from "../task/render";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { astEditToolRenderer } from "./ast-edit";
import { astGrepToolRenderer } from "./ast-grep";
import { bashToolRenderer } from "./bash";
import { browserToolRenderer } from "./browser/render";
import { calculatorToolRenderer } from "./calculator";
import { computerToolRenderer } from "./computer/render";
import { debugToolRenderer } from "./debug";
import { evalToolRenderer } from "./eval";
import { findToolRenderer } from "./find";
import { githubToolRenderer } from "./gh-renderer";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { jobToolRenderer } from "./job";
import { readToolRenderer } from "./read";
import { recipeToolRenderer } from "./recipe/render";
import { resolveToolRenderer } from "./resolve";
import { searchToolRenderer } from "./search";
import { searchToolBm25Renderer } from "./search-tool-bm25";
import { sshToolRenderer } from "./ssh";
import { subagentToolRenderer } from "./subagent-render";
import { todoWriteToolRenderer } from "./todo-write";
import { writeToolRenderer } from "./write";

type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	ast_grep: astGrepToolRenderer as ToolRenderer,
	ast_edit: astEditToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	browser: browserToolRenderer as ToolRenderer,
	computer: computerToolRenderer as ToolRenderer,
	recipe: recipeToolRenderer as ToolRenderer,
	debug: debugToolRenderer as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	calc: calculatorToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	apply_patch: editToolRenderer as ToolRenderer,
	find: findToolRenderer as ToolRenderer,
	search: searchToolRenderer as ToolRenderer,
	lsp: lspToolRenderer as ToolRenderer,
	inspect_image: inspectImageToolRenderer as ToolRenderer,
	read: readToolRenderer as ToolRenderer,
	job: jobToolRenderer as ToolRenderer,
	resolve: resolveToolRenderer as ToolRenderer,
	search_tool_bm25: searchToolBm25Renderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
	subagent: subagentToolRenderer as ToolRenderer,
	task: taskToolRenderer as ToolRenderer,
	todo_write: todoWriteToolRenderer as ToolRenderer,
	github: githubToolRenderer as ToolRenderer,
	goal: goalToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
	write: writeToolRenderer as ToolRenderer,
};
