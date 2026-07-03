/**
 * Gemini CLI Provider
 *
 * Loads configuration from Gemini CLI's config directories.
 * Priority: 60 (tool-specific provider)
 *
 * Sources:
 * - User: ~/.gemini
 * - Project: .gemini/ (cwd only)
 *
 * Capabilities:
 * - context-files: GEMINI.md files
 * - system-prompt: system.md files for custom system prompt
 * - extensions: From extensions/STAR/gemini-extension.json manifests (STAR = wildcard)
 * - settings: From settings.json
 *
 * MCP servers are intentionally NOT inherited live from Gemini config: GJC owns
 * MCP runtime execution. Copy definitions into GJC's own mcp.json instead.
 */
import * as path from "node:path";
import { tryParseJson } from "@gajae-code/utils";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { type Extension, type ExtensionManifest, extensionCapability } from "../capability/extension";
import { type ExtensionModule, extensionModuleCapability } from "../capability/extension-module";
import { readDirEntries, readFile } from "../capability/fs";
import { type Settings, settingsCapability } from "../capability/settings";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	buildExtensionModuleItems,
	calculateDepth,
	createSourceMeta,
	discoverExtensionModulePaths,
	getProjectPath,
	getUserPath,
} from "./helpers";

const PROVIDER_ID = "gemini";
const DISPLAY_NAME = "Gemini CLI";
const PRIORITY = 60;

// =============================================================================
// Context Files
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/GEMINI.md
	const userGeminiMd = getUserPath(ctx, "gemini", "GEMINI.md");
	if (userGeminiMd) {
		const content = await readFile(userGeminiMd);
		if (content) {
			items.push({
				path: userGeminiMd,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userGeminiMd, "user"),
			});
		}
	}

	// Project-level: .gemini/GEMINI.md
	const projectGeminiMd = getProjectPath(ctx, "gemini", "GEMINI.md");
	if (projectGeminiMd) {
		const content = await readFile(projectGeminiMd);
		if (content) {
			const projectBase = getProjectPath(ctx, "gemini", "");
			const depth = projectBase ? calculateDepth(ctx.cwd, projectBase, path.sep) : 0;

			items.push({
				path: projectGeminiMd,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, projectGeminiMd, "project"),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// Extensions
// =============================================================================

async function loadExtensions(ctx: LoadContext): Promise<LoadResult<Extension>> {
	const items: Extension[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/extensions/*/gemini-extension.json
	const userExtPath = getUserPath(ctx, "gemini", "extensions");
	if (userExtPath) {
		const result = await loadExtensionsFromDir(userExtPath, "user");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Project-level: .gemini/extensions/*/gemini-extension.json
	const projectExtPath = getProjectPath(ctx, "gemini", "extensions");
	if (projectExtPath) {
		const result = await loadExtensionsFromDir(projectExtPath, "project");
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

async function loadExtensionsFromDir(extensionsDir: string, level: "user" | "project"): Promise<LoadResult<Extension>> {
	const entries = await readDirEntries(extensionsDir);
	const dirEntries = entries.filter(entry => entry.isDirectory());

	const results = await Promise.all(
		dirEntries.map(async entry => {
			const extPath = path.join(extensionsDir, entry.name);
			const manifestPath = path.join(extPath, "gemini-extension.json");
			const content = await readFile(manifestPath);
			return { entry, extPath, manifestPath, content };
		}),
	);

	const items: Extension[] = [];
	const warnings: string[] = [];

	for (const { entry, extPath, manifestPath, content } of results) {
		if (!content) continue;

		const manifest = tryParseJson<ExtensionManifest>(content);
		if (!manifest) {
			warnings.push(`Invalid JSON in ${manifestPath}`);
			continue;
		}

		items.push({
			name: manifest.name ?? entry.name,
			path: extPath,
			manifest,
			level,
			_source: createSourceMeta(PROVIDER_ID, manifestPath, level),
		});
	}

	return { items, warnings };
}

// =============================================================================
// Extension Modules
// =============================================================================

async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const userExtensionsDir = getUserPath(ctx, "gemini", "extensions");
	const projectExtensionsDir = getProjectPath(ctx, "gemini", "extensions");

	const [userPaths, projectPaths] = await Promise.all([
		userExtensionsDir ? discoverExtensionModulePaths(ctx, userExtensionsDir) : Promise.resolve([]),
		projectExtensionsDir ? discoverExtensionModulePaths(ctx, projectExtensionsDir) : Promise.resolve([]),
	]);

	const items = buildExtensionModuleItems(PROVIDER_ID, userPaths, projectPaths);

	return { items, warnings: [] };
}

// =============================================================================
// Settings
// =============================================================================

async function loadSettings(ctx: LoadContext): Promise<LoadResult<Settings>> {
	const items: Settings[] = [];
	const warnings: string[] = [];

	// User-level: ~/.gemini/settings.json
	const userPath = getUserPath(ctx, "gemini", "settings.json");
	if (userPath) {
		const content = await readFile(userPath);
		if (content) {
			const parsed = tryParseJson<Record<string, unknown>>(content);
			if (parsed) {
				items.push({
					path: userPath,
					data: parsed,
					level: "user",
					_source: createSourceMeta(PROVIDER_ID, userPath, "user"),
				});
			} else {
				warnings.push(`Invalid JSON in ${userPath}`);
			}
		}
	}

	// Project-level: .gemini/settings.json
	const projectPath = getProjectPath(ctx, "gemini", "settings.json");
	if (projectPath) {
		const content = await readFile(projectPath);
		if (content) {
			const parsed = tryParseJson<Record<string, unknown>>(content);
			if (parsed) {
				items.push({
					path: projectPath,
					data: parsed,
					level: "project",
					_source: createSourceMeta(PROVIDER_ID, projectPath, "project"),
				});
			} else {
				warnings.push(`Invalid JSON in ${projectPath}`);
			}
		}
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load GEMINI.md context files",
	priority: PRIORITY,
	load: loadContextFiles,
});

// =============================================================================
// System Prompt
// =============================================================================

async function loadSystemPrompt(ctx: LoadContext): Promise<LoadResult<SystemPrompt>> {
	const items: SystemPrompt[] = [];

	// User-level: ~/.gemini/system.md
	const userSystemMd = getUserPath(ctx, "gemini", "system.md");
	if (userSystemMd) {
		const content = await readFile(userSystemMd);
		if (content) {
			items.push({
				path: userSystemMd,
				content,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userSystemMd, "user"),
			});
		}
	}

	// Project-level: .gemini/system.md
	const projectSystemMd = getProjectPath(ctx, "gemini", "system.md");
	if (projectSystemMd) {
		const content = await readFile(projectSystemMd);
		if (content) {
			items.push({
				path: projectSystemMd,
				content,
				level: "project",
				_source: createSourceMeta(PROVIDER_ID, projectSystemMd, "project"),
			});
		}
	}

	return { items, warnings: [] };
}

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load system.md custom system prompt files",
	priority: PRIORITY,
	load: loadSystemPrompt,
});

registerProvider(extensionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load extensions from ~/.gemini/extensions/ and .gemini/extensions/",
	priority: PRIORITY,
	load: loadExtensions,
});

registerProvider(extensionModuleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load extension modules from ~/.gemini/extensions/ and .gemini/extensions/",
	priority: PRIORITY,
	load: loadExtensionModules,
});

registerProvider(settingsCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load settings from ~/.gemini/settings.json and .gemini/settings.json",
	priority: PRIORITY,
	load: loadSettings,
});
