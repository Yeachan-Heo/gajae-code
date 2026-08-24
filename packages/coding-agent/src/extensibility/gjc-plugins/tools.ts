import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { loadCustomTools } from "../custom-tools/loader";
import type { CustomTool } from "../custom-tools/types";
import { readActiveSubskillsForParent } from "./state";
import {
	resolveValidatedActiveSubskill,
	verifyValidatedActiveSubskill,
	verifyValidatedSubskillTool,
} from "./subskill-authority";

export async function loadActiveSubskillTools(input: {
	cwd: string;
	sessionId?: string;
	parent: string;
	phase: string;
	reservedToolNames?: string[];
	agentDir?: string;
	/** Test seam runs before the security guard; the guard remains adjacent to import. */
	beforeImport?: (resolvedPath: string) => Promise<void>;
}): Promise<CustomTool[]> {
	const entries = await readActiveSubskillsForParent(input);
	const validated = (
		await Promise.all(
			entries.map(entry =>
				resolveValidatedActiveSubskill({
					cwd: input.cwd,
					reference: entry,
					persisted: true,
					agentDir: input.agentDir,
				}),
			),
		)
	).filter((item): item is NonNullable<typeof item> => item !== null);
	const toolRefs = validated.flatMap(item =>
		(item.activation.toolRefs ?? []).map(reference => ({ validated: item, reference })),
	);
	const toolPaths = [...new Set(toolRefs.map(({ reference }) => reference.relativePath))];
	if (toolPaths.length === 0) return [];

	const guards = new Map<string, (typeof toolRefs)[number]>();
	for (const pair of toolRefs) {
		const key = path.resolve(pair.reference.relativePath);
		if (!guards.has(key)) guards.set(key, pair);
	}
	const reservedToolNames = new Set(input.reservedToolNames ?? []);
	const result = await loadCustomTools(
		toolPaths.map(filePath => ({ path: filePath })),
		input.cwd,
		input.reservedToolNames ?? [],
		undefined,
		async resolvedPath => {
			await input.beforeImport?.(resolvedPath);
			const pair = guards.get(path.resolve(resolvedPath));
			if (!pair) throw new Error(`Unregistered GJC subskill tool import: ${resolvedPath}`);
			await verifyValidatedActiveSubskill(pair.validated);
			await verifyValidatedSubskillTool({ validated: pair.validated, reference: pair.reference });
		},
	);
	for (const error of result.errors)
		logger.warn("Skipping GJC plugin sub-skill tool", { path: error.path, error: error.error });

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
