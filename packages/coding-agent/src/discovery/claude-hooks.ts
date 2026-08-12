import * as path from "node:path";
import { registerProvider } from "../capability";
import { type Hook, hookCapability } from "../capability/hook";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, loadFilesFromDir, SOURCE_PATHS } from "./helpers";

const PROVIDER_ID = "claude";
const DISPLAY_NAME = "Anthropic Claude";
const PRIORITY = 80;

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];
	const warnings: string[] = [];
	const projectHooksDir = path.join(ctx.cwd, SOURCE_PATHS.claude.projectDir, "hooks");
	for (const hookType of ["pre", "post"] as const) {
		const result = await loadFilesFromDir<Hook>(ctx, path.join(projectHooksDir, hookType), PROVIDER_ID, "project", {
			transform: (name, _content, filePath) => ({
				name,
				path: filePath,
				type: hookType,
				tool: name.replace(/\.(sh|bash|zsh|fish|ts|js)$/, ""),
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, filePath, "project"),
			}),
		});
		items.push(...result.items);
		warnings.push(...(result.warnings ?? []));
	}
	return { items, warnings };
}

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from project .claude/hooks/pre/ and .claude/hooks/post/",
	priority: PRIORITY,
	load: loadHooks,
});
