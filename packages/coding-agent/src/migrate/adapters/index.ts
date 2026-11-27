/**
 * Source adapters for `gjc migrate`.
 *
 * Each adapter returns normalized MCP/skill/command candidates, selected-scope
 * instruction candidates, and source-level diagnostics. Adapters never connect to
 * anything.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, parseFrontmatter } from "@gajae-code/utils";
import { YAML } from "bun";
import { normalizeSkill } from "../skill-normalizer";
import type {
	AdapterResult,
	AgentCandidate,
	InstructionCandidate,
	MigrateSource,
	SkillCandidate,
	SlashCommandCandidate,
	SourceDiagnostic,
} from "../types";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { opencodeAdapter } from "./opencode";

export interface AdapterOptions {
	/** Home directory root; overridable for tests. */
	homeDir: string;
	/** Source scope for instructions and Claude Code commands. */
	scope: "project" | "user";
	/** Project root used when importing project instructions and commands. */
	cwd: string;
}

export interface Adapter {
	source: MigrateSource;
	collect(options: AdapterOptions): Promise<AdapterResult>;
}

const ADAPTERS: Record<MigrateSource, Adapter> = {
	"claude-code": claudeCodeAdapter,
	codex: codexAdapter,
	opencode: opencodeAdapter,
};

export function getAdapter(source: MigrateSource): Adapter {
	return ADAPTERS[source];
}

const SOURCE_READ_FLAGS =
	fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0) | (fsSync.constants.O_NONBLOCK ?? 0);

/** Lexical containment after `path.resolve`. Symlink checks are separate. */
export function migrateSourceInsideRoot(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function unsafeSource(message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code: "EUNSAFE" });
}

/**
 * Resolve `target` without following a symlink at or below `root`.
 * The root itself may be a symlink (a project opened through a linked path).
 * Without `root`, return the path so the read can follow a final symlink.
 * Codex and OpenCode pass no root; Claude Code passes a project or home root.
 */
async function locateSource(target: string, root: string | undefined, kind: "file" | "dir"): Promise<string> {
	const resolved = path.resolve(target);
	if (root === undefined) return resolved;
	if (!migrateSourceInsideRoot(root, resolved)) throw unsafeSource(`source escapes root: ${resolved}`);
	const relative = path.relative(path.resolve(root), resolved);
	const parts = relative === "" ? [] : relative.split(path.sep).filter(part => part !== "" && part !== ".");
	let current = path.resolve(root);
	if (parts.length === 0) {
		if (kind === "dir") return current;
		throw unsafeSource(`source is not a regular file: ${resolved}`);
	}
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink()) throw unsafeSource(`refusing to follow symlink: ${current}`);
		const last = index === parts.length - 1;
		if (!last && !stat.isDirectory()) throw unsafeSource(`source ancestor is not a real directory: ${current}`);
		if (last && kind === "file" && !stat.isFile()) throw unsafeSource(`source is not a regular file: ${current}`);
		if (last && kind === "dir" && !stat.isDirectory())
			throw unsafeSource(`source is not a real directory: ${current}`);
	}
	return current;
}

async function readRegularSource(filePath: string, root?: string): Promise<string> {
	// No-follow applies only when a project or home root is passed. Rootless
	// reads keep the previous `readFile` follow (Codex and OpenCode configs).
	if (root === undefined) return fs.readFile(filePath, "utf-8");
	const openPath = await locateSource(filePath, root, "file");
	const handle = await fs.open(openPath, SOURCE_READ_FLAGS);
	try {
		const opened = await handle.stat();
		if (!opened.isFile()) throw unsafeSource(`source is not a regular file: ${openPath}`);
		return await handle.readFile("utf-8");
	} finally {
		await handle.close();
	}
}

function sourceReadDiagnostic(
	error: unknown,
	filePath: string,
	source: MigrateSource,
	type: SourceDiagnostic["type"],
	absent: string,
): SourceDiagnostic {
	if (isEnoent(error)) return { source, type, status: "skipped_absent_source", message: absent };
	return {
		source,
		type,
		status: "failed_io",
		message: `failed to read ${filePath}: ${(error as Error).message}`,
	};
}

/** Collect one source instruction file without interpreting or rewriting its content. */
export async function collectInstructionFile(
	filePath: string,
	source: MigrateSource,
	root?: string,
): Promise<{ candidates: InstructionCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const read = await readSourceText(filePath, source, "instruction", root);
	if ("diagnostic" in read) return { candidates: [], diagnostics: [read.diagnostic] };
	return {
		candidates: [{ source, name: path.basename(filePath), content: read.text }],
		diagnostics: [],
	};
}

/** Read a text file, classifying absence/IO errors into source diagnostics. */
export async function readSourceText(
	filePath: string,
	source: MigrateSource,
	type: SourceDiagnostic["type"],
	root?: string,
): Promise<{ text: string } | { diagnostic: SourceDiagnostic }> {
	try {
		return { text: await readRegularSource(filePath, root) };
	} catch (error) {
		return { diagnostic: sourceReadDiagnostic(error, filePath, source, type, `no ${type} config at ${filePath}`) };
	}
}

/**
 * Read an optional settings file. A missing file is expected (most setups do not
 * have every settings file), so unlike `readSourceText` it produces no diagnostic.
 */
export async function readOptionalJson(
	filePath: string,
	source: MigrateSource,
	type: SourceDiagnostic["type"],
	root?: string,
): Promise<{ data: Record<string, unknown> } | { diagnostic: SourceDiagnostic } | { absent: true }> {
	let text: string;
	try {
		text = await readRegularSource(filePath, root);
	} catch (error) {
		if (isEnoent(error)) return { absent: true };
		return { diagnostic: sourceReadDiagnostic(error, filePath, source, type, `no ${type} config at ${filePath}`) };
	}
	return parseSourceJson(text, filePath, source, type);
}

/** Parse JSON text, classifying parse errors into a `failed_invalid_source` diagnostic. */
export function parseSourceJson(
	text: string,
	filePath: string,
	source: MigrateSource,
	type: SourceDiagnostic["type"],
): { data: Record<string, unknown> } | { diagnostic: SourceDiagnostic } {
	try {
		const data = JSON.parse(text) as unknown;
		if (typeof data !== "object" || data === null) {
			return {
				diagnostic: { source, type, status: "failed_invalid_source", message: `${filePath} is not a JSON object` },
			};
		}
		return { data: data as Record<string, unknown> };
	} catch (error) {
		return {
			diagnostic: {
				source,
				type,
				status: "failed_invalid_source",
				message: `invalid JSON in ${filePath}: ${(error as Error).message}`,
			},
		};
	}
}

/**
 * Collect skill candidates from a directory of `<name>/SKILL.md` entries.
 * A missing directory yields a `skipped_absent_source` diagnostic.
 */
export async function collectSkillDir(
	dir: string,
	source: MigrateSource,
	root?: string,
): Promise<{ candidates: SkillCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const candidates: SkillCandidate[] = [];
	const diagnostics: SourceDiagnostic[] = [];
	let entries: string[];
	try {
		if (root !== undefined) await locateSource(dir, root, "dir");
		const dirents = await fs.readdir(dir, { withFileTypes: true });
		entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
	} catch (error) {
		if (isEnoent(error)) {
			diagnostics.push({
				source,
				type: "skill",
				status: "skipped_absent_source",
				message: `no skills dir at ${dir}`,
			});
		} else {
			diagnostics.push({
				source,
				type: "skill",
				status: "failed_io",
				message: `failed to read ${dir}: ${(error as Error).message}`,
			});
		}
		return { candidates, diagnostics };
	}

	for (const name of entries.sort()) {
		const skillFile = `${dir}/${name}/SKILL.md`;
		const read = await readSourceText(skillFile, source, "skill", root);
		if ("diagnostic" in read) {
			// A subdir without SKILL.md is simply not a skill; only surface non-absent errors.
			if (read.diagnostic.status !== "skipped_absent_source") diagnostics.push(read.diagnostic);
			continue;
		}
		try {
			const normalized = normalizeSkill({ rawName: name, content: read.text });
			candidates.push({ source, slug: normalized.slug, content: normalized.content, warnings: normalized.warnings });
		} catch (error) {
			diagnostics.push({
				source,
				type: "skill",
				status: "failed_invalid_source",
				message: `failed to normalize skill ${skillFile}: ${(error as Error).message}`,
			});
		}
	}
	return { candidates, diagnostics };
}

/**
 * Collect skill candidates from a flat directory of `*.md` prompt/command files.
 */
export async function collectMarkdownPrompts(
	dir: string,
	source: MigrateSource,
): Promise<{ candidates: SkillCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const candidates: SkillCandidate[] = [];
	const diagnostics: SourceDiagnostic[] = [];
	let files: string[];
	try {
		const dirents = await fs.readdir(dir, { withFileTypes: true });
		files = dirents.filter(d => d.isFile() && d.name.endsWith(".md")).map(d => d.name);
	} catch (error) {
		if (isEnoent(error)) {
			diagnostics.push({
				source,
				type: "skill",
				status: "skipped_absent_source",
				message: `no prompts dir at ${dir}`,
			});
		} else {
			diagnostics.push({
				source,
				type: "skill",
				status: "failed_io",
				message: `failed to read ${dir}: ${(error as Error).message}`,
			});
		}
		return { candidates, diagnostics };
	}

	for (const file of files.sort()) {
		const promptFile = `${dir}/${file}`;
		const read = await readSourceText(promptFile, source, "skill");
		if ("diagnostic" in read) {
			diagnostics.push(read.diagnostic);
			continue;
		}
		const rawName = file.replace(/\.md$/, "");
		try {
			const normalized = normalizeSkill({ rawName, content: read.text });
			candidates.push({ source, slug: normalized.slug, content: normalized.content, warnings: normalized.warnings });
		} catch (error) {
			diagnostics.push({
				source,
				type: "skill",
				status: "failed_invalid_source",
				message: `failed to convert prompt ${promptFile}: ${(error as Error).message}`,
			});
		}
	}
	return { candidates, diagnostics };
}

/**
 * Foreign subagent tools map onto the GJC tool surfaces that carry the same
 * capability. Anything without an equivalent is dropped from the tool list (and
 * reported) rather than written into an agent that cannot be loaded.
 */
const AGENT_TOOL_EQUIVALENTS: Readonly<Record<string, string | undefined>> = {
	read: "read",
	write: "edit",
	edit: "edit",
	multiedit: "edit",
	notebookedit: undefined,
	bash: "bash",
	bashoutput: undefined,
	killbash: undefined,
	grep: "grep",
	glob: "glob",
	ls: undefined,
	task: "task",
	agent: "task",
	webfetch: "web_search",
	websearch: "web_search",
	todowrite: undefined,
	todoread: undefined,
	exitplanmode: undefined,
};

/** Bundled agent names an imported agent must never shadow. */
export const PROTECTED_AGENT_NAMES: ReadonlySet<string> = new Set(["executor", "architect", "planner", "critic"]);

const AGENT_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function importedAgentTools(raw: unknown, warnings: string[]): { unsupportedOnly: true } | string[] | undefined {
	const list =
		typeof raw === "string"
			? raw.split(",")
			: Array.isArray(raw)
				? raw.filter((entry): entry is string => typeof entry === "string")
				: [];
	const mapped: string[] = [];
	let hasUnsupported = false;
	for (const entry of list) {
		const key = entry.trim().toLowerCase();
		if (!key) continue;
		if (!(key in AGENT_TOOL_EQUIVALENTS)) {
			warnings.push(`dropped unsupported agent tool "${entry.trim()}"`);
			hasUnsupported = true;
			continue;
		}
		const equivalent = AGENT_TOOL_EQUIVALENTS[key];
		if (!equivalent) {
			warnings.push(`dropped agent tool "${entry.trim()}" (no GJC equivalent)`);
			hasUnsupported = true;
			continue;
		}
		if (!mapped.includes(equivalent)) mapped.push(equivalent);
	}
	// Explicit tool restriction that maps to no supported tools must be rejected
	if (list.length > 0 && mapped.length === 0) {
		return { unsupportedOnly: true };
	}
	return mapped.length > 0 ? mapped : undefined;
}

/**
 * Collect subagents from a flat `<agentsDir>/*.md` directory. Frontmatter is
 * rewritten so the loaded name matches the destination file name, and tool lists
 * are translated to GJC tools.
 */
export async function collectMarkdownAgents(
	dir: string,
	source: MigrateSource,
	root?: string,
): Promise<{ candidates: AgentCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const candidates: AgentCandidate[] = [];
	const diagnostics: SourceDiagnostic[] = [];
	if (root !== undefined) {
		try {
			await locateSource(dir, root, "dir");
		} catch (error) {
			diagnostics.push(sourceReadDiagnostic(error, dir, source, "agent", `no agents dir at ${dir}`));
			return { candidates, diagnostics };
		}
	}
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
		if (isEnoent(error)) {
			diagnostics.push({
				source,
				type: "agent",
				status: "skipped_absent_source",
				message: `no agents dir at ${dir}`,
			});
		} else {
			diagnostics.push({
				source,
				type: "agent",
				status: "failed_io",
				message: `failed to read ${dir}: ${(error as Error).message}`,
			});
		}
		return undefined;
	});
	if (!entries) return { candidates, diagnostics };

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const entryPath = path.join(dir, entry.name);
		const read = await readSourceText(entryPath, source, "agent", root);
		if ("diagnostic" in read) {
			diagnostics.push(read.diagnostic);
			continue;
		}

		const warnings: string[] = [];
		const { frontmatter, body } = parseFrontmatter(read.text, { location: entryPath, level: "off" });
		const rawName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : entry.name.slice(0, -3);
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!AGENT_NAME_SEGMENT.test(rawName)) {
			diagnostics.push({
				source,
				type: "agent",
				status: "failed_invalid_source",
				message: `unsupported agent name "${rawName}" in ${entry.name}; names must use letters, numbers, dots, underscores, or hyphens`,
			});
			continue;
		}
		if (!description || !body.trim()) {
			diagnostics.push({
				source,
				type: "agent",
				status: "failed_invalid_source",
				message: `agent ${entry.name} needs both a description and a prompt body`,
			});
			continue;
		}

		const tools = importedAgentTools(frontmatter.tools, warnings);
		// Reject agents that explicitly restrict to unsupported tools
		if (tools && typeof tools === "object" && "unsupportedOnly" in tools) {
			diagnostics.push({
				source,
				name: rawName,
				code: "agent_unsupported_tools_only",
				message: `Agent tool restriction "${JSON.stringify(frontmatter.tools)}" maps to no supported GJC tools; agent skipped`,
			});
			continue;
		}
		const normalized: Record<string, unknown> = { name: rawName, description, ...(Array.isArray(tools) ? { tools } : {}) };
		const yaml = YAML.stringify(normalized).trimEnd();
		candidates.push({
			source,
			name: rawName,
			content: `---\n${yaml}\n---\n\n${body.trim()}\n`,
			warnings,
		});
	}
	return { candidates, diagnostics };
}

/**
 * Collect Markdown slash commands. Nested command directories are represented
 * with colon-separated names, matching Claude Code's `/group:command` syntax.
 */
export async function collectMarkdownCommands(
	dir: string,
	source: MigrateSource,
	options: { recursive?: boolean; root?: string } = {},
): Promise<{ candidates: SlashCommandCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const candidates: SlashCommandCandidate[] = [];
	const diagnostics: SourceDiagnostic[] = [];
	const validNameSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

	async function walk(currentDir: string, parentSegments: string[], listingRoot = false): Promise<void> {
		if (listingRoot && options.root !== undefined) {
			try {
				await locateSource(currentDir, options.root, "dir");
			} catch (error) {
				diagnostics.push(sourceReadDiagnostic(error, dir, source, "command", `no commands dir at ${dir}`));
				return;
			}
		}
		const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch((error: unknown) => {
			if (listingRoot && isEnoent(error)) {
				diagnostics.push({
					source,
					type: "command",
					status: "skipped_absent_source",
					message: `no commands dir at ${dir}`,
				});
			} else if (!isEnoent(error)) {
				diagnostics.push({
					source,
					type: "command",
					status: "failed_io",
					message: `failed to read ${currentDir}: ${(error as Error).message}`,
				});
			}
			return undefined;
		});
		if (!entries) return;

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".")) continue;
			const entryPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (options.recursive) await walk(entryPath, [...parentSegments, entry.name]);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

			const nameParts = [...parentSegments, entry.name.slice(0, -3)];
			if (!nameParts.every(part => validNameSegment.test(part))) {
				diagnostics.push({
					source,
					type: "command",
					status: "failed_invalid_source",
					message: `unsupported slash-command path ${path.relative(dir, entryPath)}; names must use letters, numbers, dots, underscores, or hyphens`,
				});
				continue;
			}

			const read = await readSourceText(entryPath, source, "command", options.root);
			if ("diagnostic" in read) {
				diagnostics.push(read.diagnostic);
				continue;
			}
			candidates.push({ source, name: nameParts.join(":"), content: read.text });
		}
	}

	await walk(dir, [], true);
	return { candidates, diagnostics };
}

/**
 * Recursively collect skill candidates from any `**​/SKILL.md` under `root`.
 * The slug derives from the directory that directly contains the `SKILL.md`.
 */
export async function collectSkillTree(
	root: string,
	source: MigrateSource,
): Promise<{ candidates: SkillCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const candidates: SkillCandidate[] = [];
	const diagnostics: SourceDiagnostic[] = [];

	async function walk(dir: string): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
			if (isEnoent(error)) return null;
			diagnostics.push({
				source,
				type: "skill",
				status: "failed_io",
				message: `failed to read ${dir}: ${(error as Error).message}`,
			});
			return null;
		});
		if (!entries) return;

		const hasSkill = entries.some(e => e.isFile() && String(e.name) === "SKILL.md");
		if (hasSkill) {
			const skillFile = `${dir}/SKILL.md`;
			const read = await readSourceText(skillFile, source, "skill");
			if ("diagnostic" in read) {
				if (read.diagnostic.status !== "skipped_absent_source") diagnostics.push(read.diagnostic);
			} else {
				try {
					const rawName = dir.split("/").pop() ?? dir;
					const normalized = normalizeSkill({ rawName, content: read.text });
					candidates.push({
						source,
						slug: normalized.slug,
						content: normalized.content,
						warnings: normalized.warnings,
					});
				} catch (error) {
					diagnostics.push({
						source,
						type: "skill",
						status: "failed_invalid_source",
						message: `failed to normalize skill ${skillFile}: ${(error as Error).message}`,
					});
				}
			}
		}

		for (const entry of entries) {
			if (entry.isDirectory()) await walk(`${dir}/${String(entry.name)}`);
		}
	}

	// Surface an absent root the same way the flat collectors do.
	const rootEntries = await fs.readdir(root).catch((error: unknown) => {
		if (isEnoent(error)) {
			diagnostics.push({
				source,
				type: "skill",
				status: "skipped_absent_source",
				message: `no skills dir at ${root}`,
			});
		} else {
			diagnostics.push({
				source,
				type: "skill",
				status: "failed_io",
				message: `failed to read ${root}: ${(error as Error).message}`,
			});
		}
		return null;
	});
	if (rootEntries) await walk(root);

	return { candidates, diagnostics };
}
