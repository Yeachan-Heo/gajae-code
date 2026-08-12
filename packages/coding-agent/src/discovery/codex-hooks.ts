import * as path from "node:path";
import { registerProvider } from "../capability";
import { type Hook, hookCapability } from "../capability/hook";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { loadFilesFromDir, SOURCE_PATHS } from "./helpers";

const PROVIDER_ID = "codex";
const DISPLAY_NAME = "OpenAI Codex";
const PRIORITY = 70;

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const projectHooksDir = path.join(ctx.cwd, SOURCE_PATHS.codex.projectDir, "hooks");
	const transformHook = (name: string, _content: string, filePath: string, source: SourceMeta): Hook => {
		const baseName = name.replace(/\.(ts|js)$/, "");
		const match = baseName.match(/^(pre|post)-(.+)$/);
		const hookType = (match?.[1] as "pre" | "post") || "pre";
		return {
			name,
			path: filePath,
			type: hookType,
			tool: match?.[2] || baseName,
			level: "project",
			_source: source,
		};
	};
	return await loadFilesFromDir(ctx, projectHooksDir, PROVIDER_ID, "project", {
		extensions: ["ts", "js"],
		transform: transformHook,
	});
}

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from project .codex/hooks/",
	priority: PRIORITY,
	load: loadHooks,
});
