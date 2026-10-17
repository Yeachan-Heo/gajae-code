/**
 * Source adapters for `gjc migrate`.
 *
 * Each adapter returns normalized MCP/skill/command candidates, selected-scope
 * instruction candidates, and source-level diagnostics. Adapters never connect to
 * anything.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@gajae-code/utils";
import { normalizeSkill } from "../skill-normalizer";
import type {
	AdapterResult,
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

/** Collect one source instruction file without interpreting or rewriting its content. */
export async function collectInstructionFile(
	filePath: string,
	source: MigrateSource,
): Promise<{ candidates: InstructionCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const read = await readSourceText(filePath, source, "instruction");
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
): Promise<{ text: string } | { diagnostic: SourceDiagnostic }> {
	try {
		return { text: await fs.readFile(filePath, "utf-8") };
	} catch (error) {
		if (isEnoent(error)) {
			return {
				diagnostic: { source, type, status: "skipped_absent_source", message: `no ${type} config at ${filePath}` },
			};
		}
		return {
			diagnostic: {
				source,
				type,
				status: "failed_io",
				message: `failed to read ${filePath}: ${(error as Error).message}`,
			},
		};
	}
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
): Promise<{ candidates: SkillCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const candidates: SkillCandidate[] = [];
	const diagnostics: SourceDiagnostic[] = [];
	let entries: string[];
	try {
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
		const read = await readSourceText(skillFile, source, "skill");
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
 * Collect Markdown slash commands. Nested command directories are represented
 * with colon-separated names, matching Claude Code's `/group:command` syntax.
 */
export async function collectMarkdownCommands(
	dir: string,
	source: MigrateSource,
	options: { recursive?: boolean } = {},
): Promise<{ candidates: SlashCommandCandidate[]; diagnostics: SourceDiagnostic[] }> {
	const candidates: SlashCommandCandidate[] = [];
	const diagnostics: SourceDiagnostic[] = [];
	const validNameSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

	async function walk(currentDir: string, parentSegments: string[], root = false): Promise<void> {
		const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch((error: unknown) => {
			if (root && isEnoent(error)) {
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

			const read = await readSourceText(entryPath, source, "command");
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
