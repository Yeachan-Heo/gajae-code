import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter, pathIsWithin } from "@gajae-code/utils";
import { resolveWithinRoot } from "./paths";
import { parseManifest, parseSubskillFrontmatter } from "./schema";
import {
	GJC_PLUGIN_MANIFEST_FILENAME,
	type GjcPluginAppendixManifestEntry,
	GjcPluginLoadError,
	type GjcPluginMcpManifestEntry,
	type NormalizedAgentAppendixSurface,
	type NormalizedAppendixSurface,
	type NormalizedGjcPluginBundle,
	type NormalizedGjcPluginSurfaces,
	type NormalizedHookSurface,
	type NormalizedMcpSurface,
	type NormalizedSubskillSurface,
	type NormalizedToolSurface,
} from "./types";
import { validateBinding } from "./validation";

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Stable surface extension-id builders. Kept here so install, runtime, and
 * observability all derive identical ids.
 */
export const surfaceIds = {
	tool: (name: string): string => `tool:${name}`,
	hook: (event: string, phase: string | undefined, target: string | undefined, name: string): string =>
		`hook:${event}:${phase ?? ""}:${target ?? ""}:${name}`,
	mcp: (name: string): string => `mcp:${name}`,
	systemAppendix: (plugin: string, name: string): string => `system-appendix:${plugin}:${name}`,
	agentAppendix: (agent: string, plugin: string, name: string): string => `agent-appendix:${agent}:${plugin}:${name}`,
	subskill: (parent: string, phase: string, activationArg: string): string =>
		`subskill:${parent}:${phase}:${activationArg}`,
} as const;

async function readManifestJson(filePath: string): Promise<unknown> {
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (error) {
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin manifest at ${filePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new GjcPluginLoadError("invalid_manifest", `Invalid GJC plugin manifest JSON at ${filePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

/**
 * Resolve a declared relative path, rejecting lexical escapes AND symlink
 * escapes out of the plugin root. Never imports the file.
 */
async function resolveDeclaredFile(pluginRoot: string, rel: string): Promise<string> {
	const resolved = resolveWithinRoot(pluginRoot, rel);
	let real: string;
	try {
		real = await fs.realpath(resolved);
	} catch (error) {
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin file at ${resolved}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const realRoot = await fs.realpath(pluginRoot);
	if (!pathIsWithin(realRoot, real)) {
		throw new GjcPluginLoadError("security_policy", `GJC plugin file escapes root via symlink: ${rel}`);
	}
	return resolved;
}

async function hashFile(
	absPath: string,
	rel: string,
	declaredSha?: string,
): Promise<{ sha256: string; bytes: number }> {
	let buf: Buffer;
	try {
		buf = await fs.readFile(absPath);
	} catch (error) {
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin file at ${absPath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const digest = sha256(buf);
	if (declaredSha !== undefined && declaredSha.toLowerCase() !== digest) {
		throw new GjcPluginLoadError("hash_mismatch", `GJC plugin file hash mismatch for ${rel}`);
	}
	return { sha256: digest, bytes: buf.byteLength };
}

function mcpConfigHash(entry: GjcPluginMcpManifestEntry): string {
	const canonical = JSON.stringify({
		name: entry.name,
		transport: entry.transport,
		command: entry.command ?? null,
		args: entry.args ?? null,
		cwd: entry.cwd ?? null,
		url: entry.url ?? null,
		headers: entry.headers ?? null,
	});
	return sha256(canonical);
}

async function compileAppendix(
	pluginRoot: string,
	entry: GjcPluginAppendixManifestEntry,
	field: string,
	files: Map<string, { sha256: string; bytes: number }>,
): Promise<{ contentHash: string; bytes: number; relativePath?: string; content?: string }> {
	const hasPath = entry.path !== undefined;
	const hasContent = entry.content !== undefined;
	if (hasPath === hasContent) {
		throw new GjcPluginLoadError(
			"invalid_appendix",
			`Invalid GJC plugin ${field}: exactly one of "path" or "content" is required`,
		);
	}
	if (hasContent) {
		const content = entry.content ?? "";
		if (content.trim().length === 0) {
			throw new GjcPluginLoadError("invalid_appendix", `Invalid GJC plugin ${field}: inline content is empty`);
		}
		const digest = sha256(content);
		if (entry.sha256 !== undefined && entry.sha256.toLowerCase() !== digest) {
			throw new GjcPluginLoadError("hash_mismatch", `GJC plugin ${field} content hash mismatch`);
		}
		return { contentHash: digest, bytes: Buffer.byteLength(content), content };
	}
	const rel = entry.path as string;
	const abs = await resolveDeclaredFile(pluginRoot, rel);
	const { sha256: digest, bytes } = await hashFile(abs, rel, entry.sha256);
	if (bytes === 0) {
		throw new GjcPluginLoadError("invalid_appendix", `Invalid GJC plugin ${field}: file is empty`);
	}
	files.set(rel, { sha256: digest, bytes });
	return { contentHash: digest, bytes, relativePath: rel };
}

/**
 * Pure compile step: reads only the manifest, subskill frontmatter, and
 * declared files (as bytes for hashing/existence). It NEVER imports or executes
 * plugin tool/hook code.
 */
export async function compileGjcPluginBundle(root: string): Promise<NormalizedGjcPluginBundle> {
	const pluginRoot = path.resolve(root);
	const manifestPath = path.join(pluginRoot, GJC_PLUGIN_MANIFEST_FILENAME);
	const manifest = parseManifest(await readManifestJson(manifestPath), manifestPath);

	const files = new Map<string, { sha256: string; bytes: number }>();

	const subskills: NormalizedSubskillSurface[] = [];
	for (const rel of manifest.subskills) {
		const abs = await resolveDeclaredFile(pluginRoot, rel);
		const { sha256: digest, bytes } = await hashFile(abs, rel);
		files.set(rel, { sha256: digest, bytes });
		let content: string;
		try {
			content = await fs.readFile(abs, "utf8");
		} catch (error) {
			throw new GjcPluginLoadError("missing_file", `Missing GJC sub-skill file at ${abs}`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		let parsed: { frontmatter: Record<string, unknown>; body: string };
		try {
			parsed = parseFrontmatter(content, { source: abs, level: "fatal" });
		} catch (error) {
			throw new GjcPluginLoadError("invalid_frontmatter", `Invalid GJC sub-skill frontmatter at ${abs}`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		const fm = parseSubskillFrontmatter(parsed.frontmatter, abs);
		validateBinding(fm);
		// Subskill-scoped frontmatter tools are hashed for copy-ownership and
		// escape checks (the loader resolves these at runtime).
		const fmTools = parsed.frontmatter.tools;
		const fmToolPaths =
			typeof fmTools === "string"
				? [fmTools]
				: Array.isArray(fmTools) && fmTools.every(t => typeof t === "string")
					? (fmTools as string[])
					: [];
		for (const toolRel of fmToolPaths) {
			if (toolRel.trim().length === 0) continue;
			const toolAbs = await resolveDeclaredFile(pluginRoot, toolRel);
			const { sha256: toolDigest, bytes: toolBytes } = await hashFile(toolAbs, toolRel);
			files.set(toolRel, { sha256: toolDigest, bytes: toolBytes });
		}
		subskills.push({
			extensionId: surfaceIds.subskill(fm.binds_to, fm.phase, fm.activation_arg),
			name: fm.name,
			description: fm.description,
			parent: fm.binds_to,
			phase: fm.phase,
			activationArg: fm.activation_arg,
			relativePath: rel,
			sha256: digest,
		});
	}

	// Every declared tool file is resolved/hashed for copy-ownership and escape
	// checks, but only object-form ("always-on") tools become a session tool
	// surface; legacy string shorthand stays subskill-scoped (loader-handled).
	const tools: NormalizedToolSurface[] = [];
	for (const tool of manifest.tools) {
		const abs = await resolveDeclaredFile(pluginRoot, tool.path);
		const { sha256: digest, bytes } = await hashFile(abs, tool.path, tool.sha256);
		files.set(tool.path, { sha256: digest, bytes });
		if (tool.surface !== "always-on") continue;
		tools.push({
			extensionId: surfaceIds.tool(tool.name),
			name: tool.name,
			relativePath: tool.path,
			sha256: digest,
			description: tool.description,
		});
	}

	const hooks: NormalizedHookSurface[] = [];
	for (const hook of manifest.hooks) {
		// Path safety first: resolve/hash before semantic checks so traversal and
		// missing-file failures take precedence over contract validation.
		const abs = await resolveDeclaredFile(pluginRoot, hook.path);
		const { sha256: digest, bytes } = await hashFile(abs, hook.path, hook.sha256);
		files.set(hook.path, { sha256: digest, bytes });
		// Minimal compile-time hook contract: tool_call hooks must name a target
		// and a before/after phase so the constrained runner (M3/M4) can bind them.
		if (hook.event === "tool_call") {
			if (!hook.target) {
				throw new GjcPluginLoadError("invalid_hook", `GJC plugin hook "${hook.name}": tool_call requires a target`);
			}
			if (!hook.phase) {
				throw new GjcPluginLoadError(
					"invalid_hook",
					`GJC plugin hook "${hook.name}": tool_call requires a "before"/"after" phase`,
				);
			}
		}
		hooks.push({
			extensionId: surfaceIds.hook(hook.event, hook.phase, hook.target, hook.name),
			name: hook.name,
			event: hook.event,
			target: hook.target,
			phase: hook.phase,
			relativePath: hook.path,
			sha256: digest,
		});
	}

	const mcps: NormalizedMcpSurface[] = [];
	for (const entry of manifest.mcps) {
		// Minimal compile-time MCP contract: transport-specific endpoint must exist.
		if (entry.transport === "stdio") {
			if (!entry.command) {
				throw new GjcPluginLoadError("invalid_mcp", `GJC plugin MCP "${entry.name}": stdio requires a command`);
			}
		} else if (!entry.url) {
			throw new GjcPluginLoadError(
				"invalid_mcp",
				`GJC plugin MCP "${entry.name}": ${entry.transport} requires a url`,
			);
		}
		// Hash bundled stdio script args (relative file paths) so the registry owns
		// their copied-file boundary. Path/security failures must propagate, not be
		// swallowed, so traversal/symlink-escape/missing bundled files fail compile.
		for (const arg of entry.args ?? []) {
			// Skip flags (e.g. "--port", "-v"); only treat clearly path-like args as
			// bundled files subject to root confinement.
			if (arg.startsWith("-")) continue;
			if (!arg.startsWith(".") && !arg.includes("/")) continue;
			const abs = await resolveDeclaredFile(pluginRoot, arg);
			const { sha256: digest, bytes } = await hashFile(abs, arg, undefined);
			files.set(arg, { sha256: digest, bytes });
		}
		mcps.push({
			extensionId: surfaceIds.mcp(entry.name),
			name: entry.name,
			transport: entry.transport,
			configHash: mcpConfigHash(entry),
			config: entry,
		});
	}

	const systemAppendices: NormalizedAppendixSurface[] = [];
	for (const entry of manifest.systemAppendix) {
		const compiled = await compileAppendix(pluginRoot, entry, `system_appendix "${entry.name}"`, files);
		systemAppendices.push({
			extensionId: surfaceIds.systemAppendix(manifest.name, entry.name),
			name: entry.name,
			relativePath: compiled.relativePath,
			content: compiled.content,
			contentHash: compiled.contentHash,
			bytes: compiled.bytes,
		});
	}

	const agentAppendices: NormalizedAgentAppendixSurface[] = [];
	for (const entry of manifest.agentAppendix) {
		const compiled = await compileAppendix(pluginRoot, entry, `agent-appendix "${entry.agent}/${entry.name}"`, files);
		agentAppendices.push({
			extensionId: surfaceIds.agentAppendix(entry.agent, manifest.name, entry.name),
			agent: entry.agent,
			name: entry.name,
			relativePath: compiled.relativePath,
			content: compiled.content,
			contentHash: compiled.contentHash,
			bytes: compiled.bytes,
		});
	}

	const surfaces: NormalizedGjcPluginSurfaces = {
		subskills,
		tools,
		hooks,
		mcps,
		systemAppendices,
		agentAppendices,
	};

	const manifestBytes = await fs.readFile(manifestPath);
	const manifestHash = sha256(manifestBytes);

	const copiedFiles = [...files.entries()]
		.map(([relativePath, info]) => ({ relativePath, sha256: info.sha256, bytes: info.bytes }))
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	copiedFiles.unshift({
		relativePath: GJC_PLUGIN_MANIFEST_FILENAME,
		sha256: manifestHash,
		bytes: manifestBytes.byteLength,
	});

	return {
		name: manifest.name,
		version: manifest.version,
		root: pluginRoot,
		manifestPath,
		manifestHash,
		surfaces,
		files: copiedFiles,
	};
}
