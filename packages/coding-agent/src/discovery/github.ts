/**
 * GitHub Copilot Provider
 *
 * Loads configuration from GitHub Copilot's config directories.
 * Priority: 30 (shared standard provider)
 *
 * Sources:
 * - Project: .github/ (project-only, no user-level discovery)
 *
 * Capabilities:
 * - context-files: copilot-instructions.md in .github/
 * - instructions: *.instructions.md in .github/instructions/ with applyTo frontmatter
 */
import * as path from "node:path";
import { parseFrontmatter } from "@gajae-code/utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import { type Instruction, instructionCapability } from "../capability/instruction";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

import {
	calculateDepth,
	canonicalizePathWithinHome,
	createSourceMeta,
	getProjectPath,
	getReadOptions,
	loadFilesFromDir,
} from "./helpers";

const PROVIDER_ID = "github";
const DISPLAY_NAME = "GitHub Copilot";
const PRIORITY = 30;

// =============================================================================
// Context Files
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	const rawCopilotInstructionsPath = getProjectPath(ctx, "github", "copilot-instructions.md");
	const copilotInstructionsPath = rawCopilotInstructionsPath
		? await canonicalizePathWithinHome(ctx, rawCopilotInstructionsPath, undefined, "project")
		: null;
	if (copilotInstructionsPath) {
		const content = await readFile(copilotInstructionsPath, getReadOptions(ctx, "project"));
		if (content) {
			const fileDir = path.dirname(copilotInstructionsPath);
			const depth = calculateDepth(ctx.cwd, fileDir, path.sep);

			items.push({
				path: copilotInstructionsPath,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, copilotInstructionsPath, "project"),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// Instructions
// =============================================================================

async function loadInstructions(ctx: LoadContext): Promise<LoadResult<Instruction>> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	const instructionsDir = getProjectPath(ctx, "github", "instructions");
	if (instructionsDir) {
		const result = await loadFilesFromDir<Instruction>(ctx, instructionsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: transformInstruction,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function transformInstruction(name: string, content: string, filePath: string, source: SourceMeta): Instruction | null {
	// Only process .instructions.md files
	if (!name.endsWith(".instructions.md")) {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });

	// Extract applyTo glob pattern from frontmatter
	const applyTo = typeof frontmatter.applyTo === "string" ? frontmatter.applyTo : undefined;

	// Derive name from filename (strip .instructions.md suffix)
	const instructionName = path.basename(name, ".instructions.md");

	return {
		name: instructionName,
		path: filePath,
		content: body,
		applyTo,
		_source: source,
	};
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load copilot-instructions.md from .github/",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.instructions.md from .github/instructions/ with applyTo frontmatter",
	priority: PRIORITY,
	load: loadInstructions,
});
