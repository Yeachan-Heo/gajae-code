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
		console.warn(`[gjc-plugin] Skipping sub-skill tool ${error.path}: ${error.error}`);
	}

	const tools: CustomTool[] = [];
	const seenNames = new Set<string>();
	for (const loadedTool of result.tools) {
		const name = loadedTool.tool.name;
		if (reservedToolNames.has(name)) {
			console.warn(`[gjc-plugin] Skipping sub-skill tool name "${name}" because it conflicts with a reserved tool`);
			continue;
		}
		if (seenNames.has(name)) {
			console.warn(`[gjc-plugin] Skipping duplicate sub-skill tool name "${name}" from ${loadedTool.path}`);
			continue;
		}
		seenNames.add(name);
		tools.push(loadedTool.tool);
	}

	return tools;
}
