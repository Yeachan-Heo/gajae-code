import * as path from "node:path";
import type { Theme } from "../modes/theme/theme";
import { fileHyperlink } from "../tui/hyperlink";
import { renderTreeList } from "../tui/tree-list";

export interface GroupedFileTreeOptions {
	groups: string[][];
	expanded: boolean;
	maxCollapsedLines: number;
	itemType: string;
	uiTheme: Theme;
	searchPath?: string;
	/** Color `+`/`-` lines as diff additions/removals. */
	diff?: boolean;
	/** Render `  meta:` lines dimmed. */
	dimMeta?: boolean;
}

/**
 * Render grouped-file output produced by `formatGroupedFiles`.
 *
 * `## file` lines are dimmed and hyperlinked, `# dir/` lines set the context
 * directory for later relative paths, and `# file` lines are hyperlinked at the
 * search root. Search, ast-grep, and ast-edit share this shape.
 */
export function renderGroupedFileTree(options: GroupedFileTreeOptions): string[] {
	const {
		groups,
		expanded,
		maxCollapsedLines,
		itemType,
		uiTheme,
		searchPath,
		diff = false,
		dimMeta = false,
	} = options;
	return renderTreeList(
		{
			items: groups,
			expanded,
			maxCollapsed: groups.length,
			maxCollapsedLines,
			itemType,
			renderItem: group => {
				// Track directory context within a group for ## file headers.
				// `# foo/` is a directory header; `# foo.ts` is a root-level file
				// from formatGroupedFiles (single-# when directory is `.`).
				let contextDir = searchPath ?? "";
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
							if (searchPath) {
								contextDir = name === "." ? searchPath : path.join(searchPath, name);
							}
							return uiTheme.fg("accent", line);
						}
						const absPath = searchPath && name ? path.join(searchPath, name) : undefined;
						const styled = uiTheme.fg("accent", line);
						return absPath ? fileHyperlink(absPath, styled) : styled;
					}
					if (diff && line.startsWith("+")) return uiTheme.fg("toolDiffAdded", line);
					if (diff && line.startsWith("-")) return uiTheme.fg("toolDiffRemoved", line);
					if (dimMeta && line.startsWith("  meta:")) return uiTheme.fg("dim", line);
					return uiTheme.fg("toolOutput", line);
				});
			},
		},
		uiTheme,
	);
}
