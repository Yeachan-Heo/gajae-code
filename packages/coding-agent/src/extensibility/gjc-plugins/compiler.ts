import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter, pathIsWithin } from "@gajae-code/utils";
import { functionHookGrantHash, normalizeFunctionHookGrant } from "../extensions/function-hooks";
import { classifyStdioInvocation } from "./mcp-policy";
import { canonicalizeJsonSchema, extractDeclaredToolSchema, schemaHash } from "./metadata";
import { resolveWithinRoot } from "./paths";
import { parseManifest, parseSubskillFrontmatter } from "./schema";
import {
	GJC_PLUGIN_MANIFEST_FILENAME,
	type GjcPluginAppendixManifestEntry,
	GjcPluginLoadError,
	type GjcPluginMcpManifestEntry,
	type JsonSchema202012,
	type NormalizedAgentAppendixSurface,
	type NormalizedAppendixSurface,
	type NormalizedGjcPluginBundle,
	type NormalizedGjcPluginSurfaces,
	type NormalizedHookSurface,
	type NormalizedMcpSurface,
	type NormalizedSubskillSurface,
	type NormalizedSubskillToolSurface,
	type NormalizedToolSurface,
} from "./types";
import { validateBinding } from "./validation";

const PLUGIN_FILE_MAX_BYTES = 16 * 1024 * 1024;
const PLUGIN_MANIFEST_MAX_BYTES = PLUGIN_FILE_MAX_BYTES;
const PLUGIN_FILE_OPEN_FLAGS =
	nodeFs.constants.O_RDONLY | (process.platform === "win32" ? 0 : (nodeFs.constants.O_NOFOLLOW ?? 0));

interface FileIdentity {
	dev: bigint;
	ino: bigint;
}

interface FileAuthority {
	path: string;
	realPath: string;
	identity: FileIdentity;
}

interface ManifestSnapshot {
	bytes: Buffer;
	json: unknown;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function tooLarge(rel: string, maxBytes: number): GjcPluginLoadError {
	return new GjcPluginLoadError("security_policy", `GJC plugin file exceeds ${maxBytes} bytes: ${rel}`);
}

async function readBoundedFile(file: FileAuthority, rel: string, maxBytes: number): Promise<Buffer> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file.path, PLUGIN_FILE_OPEN_FLAGS);
	} catch (error) {
		if (errorCode(error) === "ELOOP") {
			throw new GjcPluginLoadError("security_policy", `GJC plugin path became a symlink before opening: ${rel}`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		throw error;
	}
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile()) {
			throw new GjcPluginLoadError("security_policy", `GJC plugin path is not a regular file: ${rel}`);
		}
		if (!sameIdentity(file.identity, before)) {
			throw new GjcPluginLoadError("security_policy", `GJC plugin file changed before opening: ${rel}`);
		}
		const [settledRealPath, settledPath] = await Promise.all([
			fs.realpath(file.path),
			fs.lstat(file.path, { bigint: true }),
		]);
		if (
			settledRealPath !== file.realPath ||
			settledPath.isSymbolicLink() ||
			!settledPath.isFile() ||
			!sameIdentity(settledPath, before)
		) {
			throw new GjcPluginLoadError("security_policy", `GJC plugin file changed before reading: ${rel}`);
		}
		if (before.size > BigInt(maxBytes)) throw tooLarge(rel, maxBytes);
		const chunks: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const remaining = maxBytes + 1 - offset;
			if (remaining <= 0) throw tooLarge(rel, maxBytes);
			const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining));
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			offset += bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		if (
			!sameIdentity(before, after) ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs ||
			BigInt(offset) !== after.size
		) {
			throw new GjcPluginLoadError("security_policy", `GJC plugin file changed while reading: ${rel}`);
		}
		return Buffer.concat(chunks, offset);
	} finally {
		await handle.close();
	}
}

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
	subskillTool: (parent: string, phase: string, activationArg: string, relativePath: string): string =>
		`subskill-tool:${parent}:${phase}:${activationArg}:${relativePath}`,
} as const;

async function readManifestSnapshot(pluginRoot: string, filePath: string): Promise<ManifestSnapshot> {
	let bytes: Buffer;
	try {
		const file = await resolveDeclaredFile(pluginRoot, GJC_PLUGIN_MANIFEST_FILENAME);
		bytes = await readBoundedFile(file, GJC_PLUGIN_MANIFEST_FILENAME, PLUGIN_MANIFEST_MAX_BYTES);
	} catch (error) {
		if (error instanceof GjcPluginLoadError && error.code !== "missing_file") throw error;
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin manifest at ${filePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return { bytes, json: JSON.parse(bytes.toString("utf8")) as unknown };
	} catch (error) {
		throw new GjcPluginLoadError("invalid_manifest", `Invalid GJC plugin manifest JSON at ${filePath}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

async function resolveDeclaredDirectory(pluginRoot: string, rel: string): Promise<string> {
	const resolved = resolveWithinRoot(pluginRoot, rel || ".");
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(resolved);
	} catch (error) {
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin directory at ${resolved}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (!stat.isDirectory()) {
		throw new GjcPluginLoadError("security_policy", `GJC plugin cwd must be a real directory: ${rel || "."}`);
	}
	const [realRoot, real] = await Promise.all([fs.realpath(pluginRoot), fs.realpath(resolved)]);
	if (real !== realRoot && !pathIsWithin(realRoot, real)) {
		throw new GjcPluginLoadError("security_policy", `GJC plugin cwd escapes root via symlink: ${rel || "."}`);
	}
	return resolved;
}

/**
 * Resolve a declared relative path, rejecting lexical escapes AND symlink
 * escapes out of the plugin root. Never imports the file.
 */
async function resolveDeclaredFile(pluginRoot: string, rel: string): Promise<FileAuthority> {
	const resolved = resolveWithinRoot(pluginRoot, rel);
	let realRoot: string;
	let realPath: string;
	let stat: nodeFs.BigIntStats;
	try {
		realRoot = await fs.realpath(pluginRoot);
		realPath = await fs.realpath(resolved);
		stat = await fs.lstat(resolved, { bigint: true });
	} catch (error) {
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin file at ${resolved}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (!pathIsWithin(realRoot, realPath)) {
		throw new GjcPluginLoadError("security_policy", `GJC plugin file escapes root via symlink: ${rel}`);
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new GjcPluginLoadError("security_policy", `GJC plugin path must be a real file: ${rel}`);
	}
	return { path: resolved, realPath, identity: stat };
}

async function hashFile(
	file: FileAuthority,
	rel: string,
	declaredSha?: string,
): Promise<{ sha256: string; bytes: number; content: Buffer }> {
	let buf: Buffer;
	try {
		buf = await readBoundedFile(file, rel, PLUGIN_FILE_MAX_BYTES);
	} catch (error) {
		if (error instanceof GjcPluginLoadError) throw error;
		throw new GjcPluginLoadError("missing_file", `Missing GJC plugin file at ${file.path}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const digest = sha256(buf);
	if (declaredSha !== undefined && declaredSha.toLowerCase() !== digest) {
		throw new GjcPluginLoadError("hash_mismatch", `GJC plugin file hash mismatch for ${rel}`);
	}
	return { sha256: digest, bytes: buf.byteLength, content: buf };
}

function schemaFromSnapshots(
	declaration: unknown,
	sourceBytes: Buffer,
	schemaFile?: { relativePath: string; bytes: Buffer },
): JsonSchema202012 {
	if (schemaFile !== undefined) {
		try {
			return canonicalizeJsonSchema(JSON.parse(schemaFile.bytes.toString("utf8")) as unknown);
		} catch (error) {
			if (error instanceof GjcPluginLoadError) throw error;
			throw new GjcPluginLoadError(
				"invalid_schema",
				`Invalid JSON Schema declaration at ${schemaFile.relativePath}`,
				{
					cause: error instanceof Error ? error : undefined,
				},
			);
		}
	}
	if (declaration !== undefined) return canonicalizeJsonSchema(declaration);
	try {
		return extractDeclaredToolSchema(sourceBytes.toString("utf8"));
	} catch (error) {
		if (error instanceof GjcPluginLoadError) throw error;
		throw new GjcPluginLoadError(
			"invalid_schema",
			`Tool parameters schema is not statically readable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
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
	const file = await resolveDeclaredFile(pluginRoot, rel);
	const { sha256: digest, bytes } = await hashFile(file, rel, entry.sha256);
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
	const manifestSnapshot = await readManifestSnapshot(pluginRoot, manifestPath);
	const manifest = parseManifest(manifestSnapshot.json, manifestPath);

	const files = new Map<string, { sha256: string; bytes: number }>();
	const manifestSubskillTools = manifest.tools.filter(tool => tool.surface === "subskill");
	const manifestSubskillFiles = new Map<string, { name: string; sha256: string }>();
	for (const tool of manifestSubskillTools) {
		const file = await resolveDeclaredFile(pluginRoot, tool.path);
		const { sha256: digest, bytes } = await hashFile(file, tool.path, tool.sha256);
		files.set(tool.path, { sha256: digest, bytes });
		manifestSubskillFiles.set(tool.path, { name: tool.name, sha256: digest });
	}

	const subskills: NormalizedSubskillSurface[] = [];
	for (const rel of manifest.subskills) {
		const file = await resolveDeclaredFile(pluginRoot, rel);
		const { sha256: digest, bytes, content: contentBytes } = await hashFile(file, rel);
		files.set(rel, { sha256: digest, bytes });
		const content = contentBytes.toString("utf8");
		let parsed: { frontmatter: Record<string, unknown>; body: string };
		try {
			parsed = parseFrontmatter(content, { source: file.path, level: "fatal" });
		} catch (error) {
			throw new GjcPluginLoadError("invalid_frontmatter", `Invalid GJC sub-skill frontmatter at ${file.path}`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		const fm = parseSubskillFrontmatter(parsed.frontmatter, file.path);
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
		const toolRefs: NormalizedSubskillToolSurface[] = [];
		const seenToolRefs = new Set<string>();
		for (const [toolRel, info] of manifestSubskillFiles) {
			const extensionId = surfaceIds.subskillTool(fm.binds_to, fm.phase, fm.activation_arg, toolRel);
			if (seenToolRefs.has(extensionId)) continue;
			seenToolRefs.add(extensionId);
			toolRefs.push({ extensionId, relativePath: toolRel, implementationHash: info.sha256 });
		}
		for (const toolRel of fmToolPaths) {
			if (toolRel.trim().length === 0) continue;
			const toolFile = await resolveDeclaredFile(pluginRoot, toolRel);
			const { sha256: toolDigest, bytes: toolBytes } = await hashFile(toolFile, toolRel);
			files.set(toolRel, { sha256: toolDigest, bytes: toolBytes });
			const extensionId = surfaceIds.subskillTool(fm.binds_to, fm.phase, fm.activation_arg, toolRel);
			if (seenToolRefs.has(extensionId)) continue;
			seenToolRefs.add(extensionId);
			toolRefs.push({ extensionId, relativePath: toolRel, implementationHash: toolDigest });
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
			toolRefs,
		});
	}

	// Every declared tool file is resolved/hashed for copy-ownership and escape
	// checks, but only object-form ("always-on") tools become a session tool
	// surface; legacy string shorthand stays subskill-scoped (loader-handled).
	const tools: NormalizedToolSurface[] = [];
	for (const tool of manifest.tools) {
		const file = await resolveDeclaredFile(pluginRoot, tool.path);
		const { sha256: digest, bytes, content: sourceBytes } = await hashFile(file, tool.path, tool.sha256);
		files.set(tool.path, { sha256: digest, bytes });
		if (tool.surface !== "always-on") continue;
		let schemaFileSnapshot: { relativePath: string; bytes: Buffer } | undefined;
		if (tool.schemaPath !== undefined) {
			const schemaFile = await resolveDeclaredFile(pluginRoot, tool.schemaPath);
			const { sha256: schemaDigest, bytes: schemaBytes, content } = await hashFile(schemaFile, tool.schemaPath);
			files.set(tool.schemaPath, { sha256: schemaDigest, bytes: schemaBytes });
			schemaFileSnapshot = { relativePath: tool.schemaPath, bytes: content };
		}
		const schema = schemaFromSnapshots(tool.schema, sourceBytes, schemaFileSnapshot);
		tools.push({
			extensionId: surfaceIds.tool(tool.name),
			name: tool.name,
			relativePath: tool.path,
			sha256: digest,
			description: tool.description,
			schema,
			schemaHash: schemaHash(schema),
			implementationHash: digest,
			metadataVersion: 2,
		});
	}

	const hooks: NormalizedHookSurface[] = [];
	for (const hook of manifest.hooks) {
		// Path safety first: resolve/hash before semantic checks so traversal and
		// missing-file failures take precedence over contract validation.
		const file = await resolveDeclaredFile(pluginRoot, hook.path);
		const { sha256: digest, bytes } = await hashFile(file, hook.path, hook.sha256);
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
		if (hook.phase && hook.event !== "tool_call" && hook.event !== "tool_result") {
			throw new GjcPluginLoadError(
				"invalid_hook",
				`GJC plugin hook "${hook.name}": phase is only supported for tool_call/tool_result events`,
			);
		}
		if (hook.event === "tool_result" && hook.phase !== "after") {
			throw new GjcPluginLoadError(
				"invalid_hook",
				`GJC plugin hook "${hook.name}": tool_result requires the after phase`,
			);
		}
		const grant = normalizeFunctionHookGrant({
			capabilities: hook.capabilities,
			networkDestinations: hook.networkDestinations,
			filesystemRoots: hook.filesystemRoots,
		});
		const functionHook =
			hook.capabilities !== undefined ||
			hook.networkDestinations !== undefined ||
			hook.filesystemRoots !== undefined;
		const normalizedHook: NormalizedHookSurface = {
			extensionId: surfaceIds.hook(hook.event, hook.phase, hook.target, hook.name),
			name: hook.name,
			event: hook.event,
			target: hook.target,
			phase: hook.phase,
			relativePath: hook.path,
			sha256: digest,
			implementationHash: digest,
		};
		if (functionHook) {
			normalizedHook.capabilities = [...grant.capabilities];
			normalizedHook.networkDestinations = [...grant.networkDestinations];
			normalizedHook.filesystemRoots = [...grant.filesystemRoots];
			normalizedHook.capabilityHash = functionHookGrantHash(grant);
			normalizedHook.functionHook = true;
		}
		hooks.push(normalizedHook);
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
		// Derive ownership from the same cwd-aware bare Node/Bun grammar used at runtime.
		if (entry.transport === "stdio") {
			const invocation = classifyStdioInvocation(entry, { pluginRoot });
			await resolveDeclaredDirectory(pluginRoot, path.relative(pluginRoot, invocation.cwd));
			for (const relativePath of new Set(invocation.ownedRelativePaths)) {
				const file = await resolveDeclaredFile(pluginRoot, relativePath);
				const { sha256: digest, bytes } = await hashFile(file, relativePath, undefined);
				files.set(relativePath, { sha256: digest, bytes });
			}
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

	const manifestBytes = manifestSnapshot.bytes;
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
