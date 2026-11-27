import { sanitizeText } from "@gajae-code/utils";
import type { Tool } from "../../tools";

export interface ToolsMarkdownBindings {
	tools: ReadonlyArray<Pick<Tool, "description" | "name">>;
}

/**
 * Flatten breaks before stripping controls so a carriage return cannot stay in
 * the cell, then escape pipes. `sanitizeText` removes the sequence, not only ESC.
 */
function neutralizeCellText(value: string): string {
	return sanitizeText(value.replace(/\r?\n+/g, " ").replace(/\r/g, " "));
}

function escapeTableCell(value: string): string {
	return neutralizeCellText(value).replace(/\|/g, "\\|").trim();
}

export function buildToolsMarkdown(bindings: ToolsMarkdownBindings): string {
	if (bindings.tools.length === 0) {
		return "No tools are currently visible to the agent.";
	}

	return [
		"| Tool | Description |",
		"|------|-------------|",
		...bindings.tools.map(tool => {
			const name = neutralizeCellText(tool.name);
			const description = escapeTableCell(tool.description) || "No description provided.";
			return `| \`${name}\` | ${description} |`;
		}),
	].join("\n");
}
