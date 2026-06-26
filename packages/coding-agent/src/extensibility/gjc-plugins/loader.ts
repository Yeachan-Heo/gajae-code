import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@gajae-code/utils";
import { resolveWithinRoot } from "./paths";
import { parseManifest, parseSubskillFrontmatter } from "./schema";
import {
	GJC_PLUGIN_MANIFEST_FILENAME,
	GjcPluginLoadError,
	type LoadedGjcPlugin,
	type LoadedSubskillBinding,
	type PhaseScopedToolBinding,
} from "./types";
import { buildParentArgMap, buildParentPhaseSet, validateBinding } from "./validation";

async function readJsonFile(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new GjcPluginLoadError("invalid_manifest", `Invalid GJC plugin manifest JSON at ${filePath}`, {
				cause: error,
			});
		}
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin manifest at ${filePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

async function readRequiredText(filePath: string, kind: "sub-skill" | "tool"): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin ${kind} file at ${filePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function parseFrontmatterToolPaths(fm: Record<string, unknown>): string[] {
	const raw = fm.tools;
	if (raw === undefined) return [];
	if (typeof raw === "string") return raw.trim() ? [raw] : [];
	if (Array.isArray(raw) && raw.every(item => typeof item === "string")) return [...raw];
	return [];
}

function pushToolBinding(
	toolBindings: PhaseScopedToolBinding[],
	plugin: string,
	parent: string,
	phase: string,
	toolPath: string,
): void {
	toolBindings.push({ plugin, parent, phase, toolPath });
}

export async function loadGjcPlugin(root: string): Promise<LoadedGjcPlugin> {
	const pluginRoot = path.resolve(root);
	const manifestPath = path.join(pluginRoot, GJC_PLUGIN_MANIFEST_FILENAME);
	const manifest = parseManifest(await readJsonFile(manifestPath), manifestPath);
	const manifestToolPaths = manifest.tools
		.filter(tool => tool.surface === "subskill")
		.map(tool => resolveWithinRoot(pluginRoot, tool.path));

	for (const toolPath of manifestToolPaths) {
		await readRequiredText(toolPath, "tool");
	}

	const bindings: LoadedSubskillBinding[] = [];
	const toolBindings: PhaseScopedToolBinding[] = [];

	for (const rel of manifest.subskills) {
		const filePath = resolveWithinRoot(pluginRoot, rel);
		const content = await readRequiredText(filePath, "sub-skill");
		let parsed: { frontmatter: Record<string, unknown>; body: string };
		try {
			parsed = parseFrontmatter(content, { source: filePath, level: "fatal" });
		} catch (error) {
			throw new GjcPluginLoadError("invalid_frontmatter", `Invalid GJC sub-skill frontmatter at ${filePath}`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		const frontmatter = parseSubskillFrontmatter(parsed.frontmatter, filePath);
		validateBinding(frontmatter);
		const frontmatterToolPaths = parseFrontmatterToolPaths(parsed.frontmatter).map(toolRel =>
			resolveWithinRoot(pluginRoot, toolRel),
		);
		for (const toolPath of frontmatterToolPaths) {
			await readRequiredText(toolPath, "tool");
		}
		const toolPaths = [...manifestToolPaths, ...frontmatterToolPaths];
		const binding: LoadedSubskillBinding = {
			plugin: manifest.name,
			subskillName: frontmatter.name,
			parent: frontmatter.binds_to,
			bindsTo: frontmatter.binds_to,
			phase: frontmatter.phase,
			activationArg: frontmatter.activation_arg,
			description: frontmatter.description,
			filePath,
			body: parsed.body,
			toolPaths,
		};
		bindings.push(binding);
		for (const toolPath of toolPaths) {
			pushToolBinding(toolBindings, manifest.name, binding.parent, binding.phase, toolPath);
		}
	}

	buildParentArgMap(bindings);
	buildParentPhaseSet(bindings);

	return {
		name: manifest.name,
		version: manifest.version,
		root: pluginRoot,
		manifestPath,
		bindings,
		toolBindings,
	};
}

export async function loadGjcPlugins(roots: readonly string[]): Promise<LoadedGjcPlugin[]> {
	const plugins: LoadedGjcPlugin[] = [];
	for (const root of roots) {
		plugins.push(await loadGjcPlugin(root));
	}
	const bindings = plugins.flatMap(plugin => plugin.bindings);
	buildParentArgMap(bindings);
	buildParentPhaseSet(bindings);
	return plugins;
}
