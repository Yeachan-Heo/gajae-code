/**
 * Import flow for the `/extensions` umbrella customization surface (issue #4291).
 *
 * Source layouts are consumed through the sibling contracts instead of local
 * reimplementations:
 * - Skills: `listConventionSkillImportSources` (#4285) — Claude `.claude/skills`
 *   and Codex `.codex/skills` layouts, both scopes.
 * - Hooks: Claude `.claude/hooks/<pre|post>/<file>` and Codex flat
 *   `.codex/hooks/<phase>-<tool>.ts|js` conventions, normalized through the
 *   canonical hook IR (`normalizeDirectoryHook`, #4286/#4289) and written to
 *   the runtime-discovered `<root>/hooks/<pre|post>/` layout.
 * - MCPs: `normalizeClaudeMcpJson` / `normalizeCodexMcpToml` plus
 *   `validateMCPCompatServer` (#4284 bounded compatibility adapters), merged
 *   through the canonical atomic config writer.
 *
 * The preview DTO is redacted and serialization-safe; full file contents and
 * secret values live only in the separate `ImportPlan`. `applyImport` runs as
 * a validated transaction: every destination path is containment- and
 * symlink-checked before any write, destinations are revalidated against the
 * preview decisions, files are published with same-directory temp+rename, and
 * any failure restores exactly the files this transaction wrote (pre-existing
 * symlinks are never touched). Verification failures roll back too.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter, tryParseJson } from "@gajae-code/utils";
import { YAML } from "bun";
import type { MCPServer } from "../capability/mcp";
import { normalizeClaudeMcpJson, normalizeCodexMcpToml, validateMCPCompatServer } from "../discovery/mcp-compat";
import { listConventionSkillImportSources } from "../extensibility/skill-management";
import { HookSourceConvention } from "../hooks/events";
import { normalizeDirectoryHook } from "../hooks/normalize";
import { readMCPConfigFile, writeMCPConfigFile } from "../runtime-mcp/config-writer";
import type { MCPServerConfig } from "../runtime-mcp/types";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../skill-state/canonical-skills";
import { IMPORTED_FROM_FRONTMATTER_KEY } from "./inventory";
import type {
	ImportCollisionPolicy,
	ImportPlan,
	ImportPreviewEntry,
	ImportProduct,
	ImportResult,
	ImportResultEntry,
	ImportSourceScope,
	NormalizedPayload,
} from "./types";
import { productLabel, resolveScopePaths, sourceConfigDir, sourceScopeLabel } from "./types";

export interface BuildImportPreviewOptions {
	product: ImportProduct;
	sourceScope: ImportSourceScope;
	destinationScope: "project" | "global";
	surfaces?: readonly ("skills" | "hooks" | "mcps")[];
	collisionPolicy: ImportCollisionPolicy;
	cwd: string;
	homeDir: string;
	/** Owning session agent directory for a global destination. */
	agentDir?: string;
}

const PROTECTED_SKILL_NAMES = new Set<string>(CANONICAL_GJC_WORKFLOW_SKILLS);

// ---------------------------------------------------------------------------
// Structured filesystem reads — absent/value/error, never silent
// ---------------------------------------------------------------------------

type ReadResult = { kind: "absent" } | { kind: "value"; content: string } | { kind: "error"; message: string };

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Read a regular file. Symlinks and non-files are errors, never "absent". */
async function readStructured(filePath: string): Promise<ReadResult> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(filePath);
	} catch (error) {
		if (isEnoent(error)) return { kind: "absent" };
		return { kind: "error", message: `cannot stat ${filePath}: ${(error as Error).message}` };
	}
	if (stat.isSymbolicLink()) return { kind: "error", message: `refusing unsafe symlink: ${filePath}` };
	if (!stat.isFile()) return { kind: "error", message: `not a regular file: ${filePath}` };
	try {
		return { kind: "value", content: await fs.readFile(filePath, "utf-8") };
	} catch (error) {
		if (isEnoent(error)) return { kind: "absent" };
		return { kind: "error", message: `failed to read ${filePath}: ${(error as Error).message}` };
	}
}

async function listDirNames(dir: string, kind: "file" | "directory"): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(entry => (kind === "file" ? entry.isFile() : entry.isDirectory()) && !entry.name.startsWith("."))
		.map(entry => entry.name)
		.sort();
}

// ---------------------------------------------------------------------------
// Name safety
// ---------------------------------------------------------------------------

/** A destination name must be a single safe path segment. */
function isSafeName(name: string): boolean {
	return (
		name.length > 0 &&
		name !== "." &&
		name !== ".." &&
		!name.includes("/") &&
		!name.includes("\\") &&
		!name.includes("\0") &&
		!name.split("").some(ch => ch < " ")
	);
}

// ---------------------------------------------------------------------------
// Provenance marker
// ---------------------------------------------------------------------------

/** Inject the imported-from provenance key into a normalized SKILL.md. */
function withImportProvenance(content: string, product: ImportProduct): string {
	const { frontmatter, body } = parseFrontmatter(content, { level: "off" });
	// parseFrontmatter camelCases keys; drop a prior camelized marker so the
	// canonical kebab-case key is written exactly once.
	const { xGjcImportedFrom: _priorMarker, ...rest } = frontmatter;
	const fm: Record<string, unknown> = { ...rest, [IMPORTED_FROM_FRONTMATTER_KEY]: product };
	const yaml = YAML.stringify(fm).trimEnd();
	return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Collision handling
// ---------------------------------------------------------------------------

/** Find a free `<base>-imported` / `<base>-imported-N` destination name. */
function renamedDestination(base: string, taken: (name: string) => boolean): string {
	let candidate = `${base}-imported`;
	let index = 2;
	while (taken(candidate)) {
		candidate = `${base}-imported-${index}`;
		index += 1;
	}
	return candidate;
}

function applyCollision(
	entry: Omit<ImportPreviewEntry, "status">,
	existing: ReadResult,
	identicalContent: string | undefined,
	policy: ImportCollisionPolicy,
	rename: (base: string) => string,
): ImportPreviewEntry {
	if (existing.kind === "error") {
		return { ...entry, status: "conflict", reason: `destination is unsafe or unreadable: ${existing.message}` };
	}
	const exists = existing.kind === "value";
	if (!exists) return { ...entry, status: "add" };
	if (identicalContent !== undefined && existing.content === identicalContent) {
		return {
			...entry,
			status: "conflict",
			reason: "identical content already present at destination (import is a no-op)",
		};
	}
	switch (policy) {
		case "skip":
			return { ...entry, status: "conflict", reason: "destination exists (collision policy: skip)" };
		case "overwrite":
			return { ...entry, status: "overwrite", reason: "destination exists (collision policy: overwrite)" };
		case "rename": {
			const destinationName = rename(entry.destinationName);
			return {
				...entry,
				destinationName,
				status: "add",
				reason: `destination "${entry.destinationName}" exists; renamed under collision policy: rename`,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Hook source candidates
// ---------------------------------------------------------------------------

const CLAUDE_HOOK_EXTENSIONS = [".sh", ".bash", ".zsh", ".fish", ".ts", ".js"] as const;

interface HookCandidate {
	phase: "pre" | "post";
	fileName: string;
	filePath: string;
	toolName: string;
	sourceCategory: string;
}

async function collectSourceHooks(
	product: ImportProduct,
	configDir: string,
): Promise<{ candidates: HookCandidate[]; warnings: string[] }> {
	const candidates: HookCandidate[] = [];
	const warnings: string[] = [];
	if (product === "claude-code") {
		// Canonical Claude layout: `.claude/hooks/<pre|post>/<file>`.
		for (const phase of ["pre", "post"] as const) {
			const dir = path.join(configDir, "hooks", phase);
			for (const fileName of await listDirNames(dir, "file")) {
				const ext = CLAUDE_HOOK_EXTENSIONS.find(e => fileName.endsWith(e));
				if (!ext) {
					warnings.push(`skipped ${phase} hook "${fileName}": unsupported extension`);
					continue;
				}
				candidates.push({
					phase,
					fileName,
					filePath: path.join(dir, fileName),
					toolName: fileName.slice(0, -ext.length),
					sourceCategory: `hook file (${phase}/)`,
				});
			}
		}
		return { candidates, warnings };
	}
	// Canonical Codex layout: flat `.codex/hooks/<phase>-<tool>.ts|js`.
	const dir = path.join(configDir, "hooks");
	for (const fileName of await listDirNames(dir, "file")) {
		const match = fileName.match(/^(pre|post)-(.+)\.(ts|js)$/);
		if (!match) {
			warnings.push(
				`skipped hook "${fileName}": filename must follow the pre-<tool>.ts|js or post-<tool>.ts|js convention`,
			);
			continue;
		}
		candidates.push({
			phase: match[1] as "pre" | "post",
			fileName,
			filePath: path.join(dir, fileName),
			toolName: match[2],
			sourceCategory: "hook file (flat)",
		});
	}
	return { candidates, warnings };
}

// ---------------------------------------------------------------------------
// MCP source config path
// ---------------------------------------------------------------------------

function sourceMcpConfigPath(
	product: ImportProduct,
	sourceScope: ImportSourceScope,
	cwd: string,
	homeDir: string,
): string {
	if (product === "claude-code") {
		// Project-scope Claude MCP servers live in `<project>/.mcp.json`;
		// user-global servers live in `~/.claude.json`.
		return sourceScope === "project" ? path.join(cwd, ".mcp.json") : path.join(homeDir, ".claude.json");
	}
	return path.join(sourceConfigDir(product, sourceScope, cwd, homeDir), "config.toml");
}

/** Map a normalized compat MCPServer onto the canonical config writer shape. */
function toMCPServerConfig(server: MCPServer): MCPServerConfig {
	const config: Record<string, unknown> = {};
	if (server.transport) config.type = server.transport;
	if (server.command !== undefined) config.command = server.command;
	if (server.args !== undefined) config.args = server.args;
	if (server.env !== undefined) config.env = server.env;
	if (server.cwd !== undefined) config.cwd = server.cwd;
	if (server.url !== undefined) config.url = server.url;
	if (server.headers !== undefined) config.headers = server.headers;
	if (server.enabled !== undefined) config.enabled = server.enabled;
	if (server.autoload !== undefined) config.autoload = server.autoload;
	if (server.timeout !== undefined) config.timeout = server.timeout;
	if (server.sharing !== undefined) config.sharing = server.sharing;
	if (server.noInheritEnv !== undefined) config.noInheritEnv = server.noInheritEnv;
	return config as unknown as MCPServerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DestinationMcpState {
	/** Existing server entries, or null when the destination is unusable. */
	servers: Record<string, unknown> | null;
	/** Why the destination is unusable (malformed/unsafe), when servers is null. */
	error?: string;
}

function nestedAuthServerNames(product: ImportProduct, content: string): Set<string> {
	const names = new Set<string>();
	if (product === "claude-code") {
		const parsed = tryParseJson<Record<string, unknown>>(content);
		const servers = parsed?.mcpServers;
		if (!servers || !isRecord(servers)) return names;
		for (const [name, value] of Object.entries(servers)) {
			if (!isRecord(value)) continue;
			if (value.auth !== undefined || value.oauth !== undefined) names.add(name);
		}
		return names;
	}
	try {
		const parsed = Bun.TOML.parse(content) as Record<string, unknown>;
		const servers = parsed.mcp_servers;
		if (!servers || !isRecord(servers)) return names;
		for (const [name, value] of Object.entries(servers)) {
			if (!isRecord(value)) continue;
			if (value.auth !== undefined || value.oauth !== undefined) names.add(name);
		}
	} catch {
		// The canonical normalizer reports parse diagnostics.
	}
	return names;
}

async function readDestinationMcpState(mcpConfigPath: string): Promise<DestinationMcpState> {
	const read = await readStructured(mcpConfigPath);
	if (read.kind === "absent") return { servers: {} };
	if (read.kind === "error") return { servers: null, error: read.message };
	const json = tryParseJson<Record<string, unknown>>(read.content);
	if (!json || !isRecord(json)) {
		return { servers: null, error: `destination ${mcpConfigPath} is malformed; MCP entries cannot be imported` };
	}
	if (json.mcpServers !== undefined && !isRecord(json.mcpServers)) {
		return {
			servers: null,
			error: `destination ${mcpConfigPath} has a non-object mcpServers value; MCP entries cannot be imported`,
		};
	}
	return { servers: (json.mcpServers as Record<string, unknown> | undefined) ?? {} };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Read the selected source product/scope, normalize every candidate through
 * the sibling contracts, and produce a redacted preview plus an opaque apply
 * plan. Pure reads only — nothing is written until `applyImport`.
 */
export async function buildImportPreview(options: BuildImportPreviewOptions): Promise<ImportPlan> {
	const surfaces = options.surfaces ?? (["skills", "hooks", "mcps"] as const);
	const destination = resolveScopePaths(options.destinationScope, options.cwd, options.agentDir);
	const entries: ImportPreviewEntry[] = [];
	const payloads: (NormalizedPayload | undefined)[] = [];
	const warnings: string[] = [];
	const productName = productLabel(options.product);
	const sourceLabel = `${productName} ${sourceScopeLabel(options.sourceScope)}`;

	const push = (entry: ImportPreviewEntry, payload?: NormalizedPayload): void => {
		entries.push(entry);
		payloads.push(payload);
	};

	// --- Skills -------------------------------------------------------------
	if (surfaces.includes("skills")) {
		const host = options.product === "claude-code" ? "claude" : "codex";
		const sources = await listConventionSkillImportSources({ cwd: options.cwd, home: options.homeDir, host });
		const scoped = sources.filter(source =>
			options.sourceScope === "project" ? source.scope === "project" : source.scope === "user",
		);
		const takenSkillNames = new Set(await listDirNames(destination.skillsDir, "directory"));
		for (const source of scoped) {
			const slug = source.name;
			if (PROTECTED_SKILL_NAMES.has(slug)) {
				push({
					surface: "skills",
					sourceName: slug,
					destinationName: slug,
					status: "unsupported",
					sourceCategory: "skill directory",
					description: `import skill "${slug}"`,
					reason: "protected bundled GJC workflow skill name; foreign copies cannot override bundled authority",
				});
				continue;
			}
			if (!isSafeName(slug)) {
				push({
					surface: "skills",
					sourceName: slug,
					destinationName: slug,
					status: "unsupported",
					sourceCategory: "skill directory",
					description: `import skill "${slug}"`,
					reason: "unsafe skill name (path separators, control characters, or traversal segments are not allowed)",
				});
				continue;
			}
			const read = await readStructured(source.path);
			if (read.kind !== "value") {
				push({
					surface: "skills",
					sourceName: slug,
					destinationName: slug,
					status: "unsupported",
					sourceCategory: "skill directory",
					description: `import skill "${slug}"`,
					reason: read.kind === "error" ? read.message : `no SKILL.md content at ${source.path}`,
				});
				continue;
			}
			const content = withImportProvenance(read.content, options.product);
			const { frontmatter } = parseFrontmatter(content, { level: "off" });
			const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
			if (!description) {
				push({
					surface: "skills",
					sourceName: slug,
					destinationName: slug,
					status: "unsupported",
					sourceCategory: "skill directory",
					description: `import skill "${slug}"`,
					reason: "skill frontmatter must include a non-empty description",
				});
				continue;
			}
			const existing = await readStructured(path.join(destination.skillsDir, slug, "SKILL.md"));
			const entry = applyCollision(
				{
					surface: "skills",
					sourceName: slug,
					destinationName: slug,
					sourceCategory: "skill directory",
					description: `import skill "${slug}" into ${destination.skillsDir}`,
				},
				existing,
				content,
				options.collisionPolicy,
				base => renamedDestination(base, name => takenSkillNames.has(name)),
			);
			takenSkillNames.add(entry.destinationName);
			let destinationContent = content;
			if (entry.destinationName !== slug) {
				const { frontmatter, body } = parseFrontmatter(content, { level: "off" });
				destinationContent = `---\n${YAML.stringify({ ...frontmatter, name: entry.destinationName }).trimEnd()}\n---\n\n${body.trim()}\n`;
			}
			push(entry, { skill: { slug: entry.destinationName, content: destinationContent } });
		}
	}

	// --- Hooks --------------------------------------------------------------
	if (surfaces.includes("hooks")) {
		const convention =
			options.product === "claude-code" ? HookSourceConvention.ClaudeCode : HookSourceConvention.Codex;
		const configDir = sourceConfigDir(options.product, options.sourceScope, options.cwd, options.homeDir);
		const collected = await collectSourceHooks(options.product, configDir);
		for (const warning of collected.warnings) warnings.push(`${sourceLabel} hooks: ${warning}`);
		// Destination identity is the canonical phase-relative path.
		const takenHookPaths = new Set<string>();
		for (const phase of ["pre", "post"] as const) {
			for (const fileName of await listDirNames(path.join(destination.hooksDir, phase), "file")) {
				takenHookPaths.add(`${phase}/${fileName}`);
			}
		}
		for (const candidate of collected.candidates) {
			const canonicalFileName =
				options.product === "codex"
					? `${candidate.toolName}${path.extname(candidate.fileName)}`
					: candidate.fileName;
			const relDest = `${candidate.phase}/${canonicalFileName}`;
			const normalized = normalizeDirectoryHook({
				convention,
				phase: candidate.phase,
				toolName: candidate.toolName,
				source: candidate.filePath,
				externalName: candidate.fileName,
			});
			if (!normalized.hook) {
				push({
					surface: "hooks",
					sourceName: relDest,
					destinationName: relDest,
					status: "unsupported",
					sourceCategory: candidate.sourceCategory,
					description: `${candidate.phase} hook for ${candidate.toolName}`,
					reason: normalized.diagnostics.map(d => `${d.code}: ${d.message}`).join("; "),
				});
				continue;
			}
			const read = await readStructured(candidate.filePath);
			if (read.kind !== "value") {
				push({
					surface: "hooks",
					sourceName: relDest,
					destinationName: relDest,
					status: "unsupported",
					sourceCategory: candidate.sourceCategory,
					description: `${candidate.phase} hook for ${candidate.toolName}`,
					reason: read.kind === "error" ? read.message : `no hook content at ${candidate.filePath}`,
				});
				continue;
			}
			const existing = await readStructured(path.join(destination.hooksDir, candidate.phase, canonicalFileName));
			const entry = applyCollision(
				{
					surface: "hooks",
					sourceName: relDest,
					destinationName: relDest,
					sourceCategory: candidate.sourceCategory,
					description: `${candidate.phase} hook for ${candidate.toolName} (${normalized.hook.contract.runtimeEvent})`,
				},
				existing,
				read.content,
				options.collisionPolicy,
				base => {
					const ext = path.extname(base);
					const stem = base.slice(candidate.phase.length + 1, base.length - ext.length);
					const renamed = renamedDestination(stem, name => takenHookPaths.has(`${candidate.phase}/${name}${ext}`));
					return `${candidate.phase}/${renamed}${ext}`;
				},
			);
			takenHookPaths.add(entry.destinationName);
			push(entry, {
				hook: {
					phase: candidate.phase,
					fileName: entry.destinationName.slice(candidate.phase.length + 1),
					content: read.content,
				},
			});
		}
	}

	// --- MCPs ---------------------------------------------------------------
	if (surfaces.includes("mcps")) {
		const sourcePath = sourceMcpConfigPath(options.product, options.sourceScope, options.cwd, options.homeDir);
		const read = await readStructured(sourcePath);
		if (read.kind === "error") {
			warnings.push(`${sourceLabel} MCPs: ${read.message}`);
		}
		const normalized =
			read.kind === "value"
				? options.product === "claude-code"
					? normalizeClaudeMcpJson(read.content, sourcePath, options.sourceScope)
					: normalizeCodexMcpToml(read.content, sourcePath, options.sourceScope)
				: { items: [], warnings: [] as string[] };
		for (const warning of normalized.warnings) warnings.push(`${sourceLabel} MCPs: ${warning}`);
		const unsupportedNestedAuth =
			read.kind === "value" ? nestedAuthServerNames(options.product, read.content) : new Set<string>();
		if (normalized.items.length > 0) {
			const destState = await readDestinationMcpState(destination.mcpConfigPath);
			if (destState.servers === null) {
				warnings.push(destState.error ?? `destination ${destination.mcpConfigPath} is unusable`);
			}
			const existingServers = destState.servers ?? {};
			const takenMcpNames = new Set(Object.keys(existingServers));
			for (const server of normalized.items) {
				const name = server.name;
				if (unsupportedNestedAuth.has(name)) {
					push({
						surface: "mcps",
						sourceName: name,
						destinationName: name,
						status: "unsupported",
						sourceCategory: "MCP server entry",
						description: `MCP server "${name}" (credentials redacted)`,
						reason:
							"nested auth/oauth configuration is not supported by the canonical GJC MCP contract; import was skipped to avoid dropping credentials",
					});
					continue;
				}
				const invalidReason = !isSafeName(name)
					? "unsafe MCP server name (path separators, control characters, or traversal segments are not allowed)"
					: validateMCPCompatServer(server);
				if (invalidReason || destState.servers === null) {
					push({
						surface: "mcps",
						sourceName: name,
						destinationName: name,
						status: "unsupported",
						sourceCategory: "MCP server entry",
						description: `MCP server "${name}"`,
						reason: invalidReason ?? destState.error ?? "destination MCP config is unusable",
					});
					continue;
				}
				const config = toMCPServerConfig(server);
				const existing = existingServers[name];
				const secretKeys = [
					...(config && "env" in config && config.env ? Object.keys(config.env).map(k => `env:${k}`) : []),
					...(config && "headers" in config && config.headers
						? Object.keys(config.headers).map(k => `header:${k}`)
						: []),
				];
				const entry = applyCollision(
					{
						surface: "mcps",
						sourceName: name,
						destinationName: name,
						sourceCategory: "MCP server entry",
						description:
							config && "command" in config && typeof config.command === "string"
								? `stdio MCP "${name}" (command redacted)`
								: `${config && "type" in config ? String(config.type) : "http"} MCP "${name}" (endpoint redacted)`,
					},
					existing === undefined ? { kind: "absent" } : { kind: "value", content: JSON.stringify(existing) },
					JSON.stringify(config),
					options.collisionPolicy,
					base => renamedDestination(base, candidate => takenMcpNames.has(candidate)),
				);
				takenMcpNames.add(entry.destinationName);
				if (secretKeys.length > 0 && (entry.status === "add" || entry.status === "overwrite")) {
					entry.reason = `${entry.reason ? `${entry.reason}; ` : ""}secret values hidden in preview (keys: ${secretKeys.join(", ")})`;
				}
				push(entry, { mcp: { name: entry.destinationName, config } });
			}
		}
	}

	return {
		preview: {
			product: options.product,
			sourceScope: options.sourceScope,
			destinationScope: options.destinationScope,
			surfaces: [...surfaces],
			entries,
			warnings,
		},
		destinationAgentDir: options.destinationScope === "global" ? destination.root : undefined,
		payloads,
	};
}

// ---------------------------------------------------------------------------
// Apply (validated transaction: staged atomic writes + journaled rollback)
// ---------------------------------------------------------------------------

interface FileSnapshot {
	path: string;
	/** Previous content, or null when the file did not exist. */
	previous: string | null;
}

interface PlannedFileWrite {
	path: string;
	content: string;
}

/**
 * Walk `root` itself and every existing component down to `target`'s parent
 * directory; return the first symlinked component, or null. A target outside
 * `root` is reported as the root itself (containment is checked separately).
 */
async function findSymlinkedAncestor(root: string, target: string): Promise<string | null> {
	const relative = path.relative(root, path.dirname(target));
	if (relative.startsWith("..") || path.isAbsolute(relative)) return root;
	const segments = relative === "" ? [] : relative.split(path.sep);
	let current = root;
	try {
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink()) return current;
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return null;
	}
	for (const segment of segments) {
		current = path.join(current, segment);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) return current;
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
	}
	return null;
}

/** Remove stale staging temp files from an interrupted earlier apply. */
async function sweepStagingTemps(dir: string): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.includes(".gjc-import-") || !name.endsWith(".tmp")) continue;
		await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
	}
}

/**
 * Apply a confirmed plan. The transaction contract:
 *
 * 1. Pre-validation — every destination path is derived from validated plan
 *    identities (never raw payload names), containment-checked beneath the
 *    canonical scope directories, and walked for symlinked ancestors; the
 *    destination MCP config shape is validated; add/rename destinations are
 *    revalidated against the preview decision (stale previews fail closed).
 *    Any problem aborts the whole apply before a single write.
 * 2. Publication — each skill/hook file is written to a same-directory temp
 *    file (0600) and atomically renamed into place; MCP entries merge into one
 *    in-memory config written once via the canonical atomic writer. Only
 *    files this transaction actually publishes enter the rollback journal.
 * 3. Verification — persisted state is re-read inside the transaction; a
 *    verification mismatch rolls back exactly like a write failure.
 * 4. Rollback — restores journal snapshots (or removes created files) and
 *    reports every restore failure honestly instead of claiming success.
 */
export async function applyImport(plan: ImportPlan, options: { cwd: string }): Promise<ImportResult> {
	const { preview } = plan;
	const destination = resolveScopePaths(preview.destinationScope, options.cwd, plan.destinationAgentDir);
	const results: ImportResultEntry[] = [];

	const writable: Array<{ entry: ImportPreviewEntry; payload: NormalizedPayload }> = [];
	preview.entries.forEach((entry, index) => {
		const payload = plan.payloads[index];
		if (entry.status === "conflict" || entry.status === "unsupported") {
			results.push({
				surface: entry.surface,
				sourceName: entry.sourceName,
				destinationName: entry.destinationName,
				outcome: "skipped",
				reason: entry.reason ?? (entry.status === "unsupported" ? "unsupported semantics" : undefined),
			});
			return;
		}
		if (!payload) {
			results.push({
				surface: entry.surface,
				sourceName: entry.sourceName,
				destinationName: entry.destinationName,
				outcome: "failed",
				reason: "internal error: writable preview entry has no plan payload",
			});
			return;
		}
		writable.push({ entry, payload });
	});

	const failAll = (reason: string): ImportResult => {
		for (const { entry } of writable) {
			results.push({
				surface: entry.surface,
				sourceName: entry.sourceName,
				destinationName: entry.destinationName,
				outcome: "failed",
				reason,
			});
		}
		return { entries: results, ok: false };
	};

	// --- Phase 1: pre-validation -------------------------------------------
	const fileWrites: PlannedFileWrite[] = [];
	const mcpWrites: Array<{ entry: ImportPreviewEntry; name: string; config: MCPServerConfig }> = [];
	let mcpConfig: Awaited<ReturnType<typeof readMCPConfigFile>> | null = null;

	for (const { entry, payload } of writable) {
		if (payload.skill) {
			const slug = payload.skill.slug;
			if (!isSafeName(slug)) return failAll(`refusing unsafe skill destination name: ${slug}`);
			const target = path.join(destination.skillsDir, slug, "SKILL.md");
			const relative = path.relative(destination.skillsDir, target);
			if (relative.startsWith("..") || path.isAbsolute(relative)) {
				return failAll(`refusing skill destination outside ${destination.skillsDir}: ${slug}`);
			}
			const symlinked = await findSymlinkedAncestor(destination.root, target).catch(error => {
				return `error:${(error as Error).message}`;
			});
			if (typeof symlinked === "string") {
				return failAll(
					symlinked.startsWith("error:")
						? `cannot validate destination ancestors: ${symlinked.slice(6)}`
						: `refusing to write through symlinked ancestor: ${symlinked}`,
				);
			}
			const existing = await readStructured(target);
			if (existing.kind === "error") return failAll(existing.message);
			if (entry.status !== "overwrite" && existing.kind === "value" && existing.content !== payload.skill.content) {
				return failAll(
					`destination changed since preview for skill "${slug}"; rebuild the preview instead of overwriting silently`,
				);
			}
			fileWrites.push({ path: target, content: payload.skill.content });
		} else if (payload.hook) {
			const { phase, fileName } = payload.hook;
			if (phase !== "pre" && phase !== "post") return failAll(`refusing unknown hook phase: ${String(phase)}`);
			if (!isSafeName(fileName)) return failAll(`refusing unsafe hook destination name: ${fileName}`);
			const target = path.join(destination.hooksDir, phase, fileName);
			const relative = path.relative(destination.hooksDir, target);
			if (relative.startsWith("..") || path.isAbsolute(relative)) {
				return failAll(`refusing hook destination outside ${destination.hooksDir}: ${fileName}`);
			}
			const symlinked = await findSymlinkedAncestor(destination.root, target).catch(error => {
				return `error:${(error as Error).message}`;
			});
			if (typeof symlinked === "string") {
				return failAll(
					symlinked.startsWith("error:")
						? `cannot validate destination ancestors: ${symlinked.slice(6)}`
						: `refusing to write through symlinked ancestor: ${symlinked}`,
				);
			}
			const existing = await readStructured(target);
			if (existing.kind === "error") return failAll(existing.message);
			if (entry.status !== "overwrite" && existing.kind === "value" && existing.content !== payload.hook.content) {
				return failAll(
					`destination changed since preview for hook "${phase}/${fileName}"; rebuild the preview instead of overwriting silently`,
				);
			}
			fileWrites.push({ path: target, content: payload.hook.content });
		} else if (payload.mcp) {
			mcpWrites.push({ entry, name: payload.mcp.name, config: payload.mcp.config });
		}
	}

	if (mcpWrites.length > 0) {
		const mcpSymlink = await findSymlinkedAncestor(destination.root, destination.mcpConfigPath).catch(error => {
			return `error:${(error as Error).message}`;
		});
		if (typeof mcpSymlink === "string") {
			return failAll(
				mcpSymlink.startsWith("error:")
					? `cannot validate MCP destination ancestors: ${mcpSymlink.slice(6)}`
					: `refusing to write MCP config through symlinked ancestor: ${mcpSymlink}`,
			);
		}
		const destState = await readDestinationMcpState(destination.mcpConfigPath);
		if (destState.servers === null) {
			return failAll(destState.error ?? `destination ${destination.mcpConfigPath} is unusable`);
		}
		const raw = await readStructured(destination.mcpConfigPath);
		mcpConfig =
			raw.kind === "value"
				? (tryParseJson<Record<string, unknown>>(raw.content) as Awaited<ReturnType<typeof readMCPConfigFile>>)
				: { mcpServers: {} };
		for (const write of mcpWrites) {
			if (!isSafeName(write.name)) return failAll(`refusing unsafe MCP destination name: ${write.name}`);
			const existing = destState.servers[write.name];
			if (
				write.entry.status !== "overwrite" &&
				existing !== undefined &&
				JSON.stringify(existing) !== JSON.stringify(write.config)
			) {
				return failAll(
					`destination changed since preview for MCP "${write.name}"; rebuild the preview instead of overwriting silently`,
				);
			}
		}
	}

	// --- Phase 2: publication ------------------------------------------------
	const snapshots: FileSnapshot[] = [];
	for (const dir of [destination.skillsDir, destination.hooksDir]) {
		await sweepStagingTemps(dir).catch(() => {});
	}

	try {
		for (const [index, write] of fileWrites.entries()) {
			await fs.mkdir(path.dirname(write.path), { recursive: true, mode: 0o700 });
			const stat = await fs.lstat(write.path).catch(() => null);
			if (stat?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${write.path}`);
			const prior = await readStructured(write.path);
			if (prior.kind === "error") throw new Error(prior.message);
			const staged = path.join(
				path.dirname(write.path),
				`.gjc-import-${process.pid}-${index}-${path.basename(write.path)}.tmp`,
			);
			await fs.writeFile(staged, write.content, { encoding: "utf-8", mode: 0o600 });
			await fs.rename(staged, write.path);
			snapshots.push({ path: write.path, previous: prior.kind === "value" ? prior.content : null });
		}

		if (mcpConfig && mcpWrites.length > 0) {
			const mcpSymlink = await findSymlinkedAncestor(destination.root, destination.mcpConfigPath);
			if (mcpSymlink) throw new Error(`refusing to write MCP config through symlinked ancestor: ${mcpSymlink}`);
			const mcpStat = await fs.lstat(destination.mcpConfigPath).catch(() => null);
			if (mcpStat?.isSymbolicLink()) {
				throw new Error(`refusing to write through symlinked MCP config: ${destination.mcpConfigPath}`);
			}
			const priorRaw = await readStructured(destination.mcpConfigPath);
			snapshots.push({
				path: destination.mcpConfigPath,
				previous: priorRaw.kind === "value" ? priorRaw.content : null,
			});
			const servers = { ...(mcpConfig.mcpServers ?? {}) };
			for (const write of mcpWrites) {
				servers[write.name] = write.config;
			}
			await writeMCPConfigFile(destination.mcpConfigPath, { ...mcpConfig, mcpServers: servers });
		}

		// --- Phase 3: verification (inside the transaction) ------------------
		for (const write of fileWrites) {
			const persisted = await readStructured(write.path);
			if (persisted.kind !== "value" || persisted.content !== write.content) {
				throw new Error(`post-import verification failed: ${write.path} was not persisted`);
			}
		}
		if (mcpWrites.length > 0) {
			const persistedConfig = await readMCPConfigFile(destination.mcpConfigPath).catch(() => null);
			for (const write of mcpWrites) {
				if (!persistedConfig?.mcpServers?.[write.name]) {
					throw new Error(`post-import verification failed: MCP "${write.name}" was not persisted`);
				}
			}
		}
	} catch (error) {
		// --- Phase 4: rollback — restore exactly what this transaction wrote --
		const reason = (error as Error).message;
		const rollbackErrors: string[] = [];
		for (const snapshot of snapshots.reverse()) {
			try {
				if (snapshot.previous === null) {
					await fs.rm(snapshot.path, { force: true });
				} else {
					const staged = `${snapshot.path}.gjc-rollback-${process.pid}.tmp`;
					await fs.writeFile(staged, snapshot.previous, { encoding: "utf-8", mode: 0o600 });
					await fs.rename(staged, snapshot.path);
				}
			} catch (rollbackError) {
				rollbackErrors.push(`${snapshot.path}: ${(rollbackError as Error).message}`);
			}
		}
		for (const dir of new Set(fileWrites.map(write => path.dirname(write.path)))) {
			await sweepStagingTemps(dir).catch(() => {});
		}
		return failAll(
			`import failed and was rolled back: ${reason}` +
				(rollbackErrors.length > 0 ? `; ROLLBACK ERRORS (manual repair needed): ${rollbackErrors.join("; ")}` : ""),
		);
	}

	for (const { entry } of writable) {
		const base = {
			surface: entry.surface,
			sourceName: entry.sourceName,
			destinationName: entry.destinationName,
		};
		if (entry.status === "overwrite") {
			results.push({ ...base, outcome: "overwritten" });
		} else if (entry.destinationName !== entry.sourceName) {
			results.push({ ...base, outcome: "renamed" });
		} else {
			results.push({ ...base, outcome: "imported" });
		}
	}
	return { entries: results, ok: true };
}
