import { logger } from "@gajae-code/utils";
import { loadCustomTools } from "../custom-tools/loader";
import type { CustomTool } from "../custom-tools/types";
import { readActiveSubskillsForParent } from "./state";

export async function loadActiveSubskillTools(input: {
	cwd: string;
	sessionId?: string;
	parent: string;
	phase: string;
	reservedToolNames?: string[];
}): Promise<CustomTool[]> {
	const entries = await readActiveSubskillsForParent(input);
	const toolPaths = [
		...new Set(entries.flatMap(entry => entry.toolPaths ?? []).filter(path => path.trim().length > 0)),
	];
	if (toolPaths.length === 0) return [];

	const reservedToolNames = new Set(input.reservedToolNames ?? []);
	const result = await loadCustomTools(
		toolPaths.map(path => ({ path })),
		input.cwd,
		input.reservedToolNames ?? [],
	);

	for (const error of result.errors) {
		logger.warn("Skipping GJC plugin sub-skill tool", { path: error.path, error: error.error });
	}

	const tools: CustomTool[] = [];
	const seenNames = new Set<string>();
	for (const loadedTool of result.tools) {
		const name = loadedTool.tool.name;
		if (reservedToolNames.has(name)) {
			logger.warn("Skipping GJC plugin sub-skill tool name because it conflicts with a reserved tool", { name });
			continue;
		}
		if (seenNames.has(name)) {
			logger.warn("Skipping duplicate GJC plugin sub-skill tool name", { name, path: loadedTool.path });
			continue;
		}
		seenNames.add(name);
		tools.push(loadedTool.tool);
	}

	return tools;
}
