import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@gajae-code/utils";
import {
	BUNDLED_GJC_SKILL_CATALOG,
	type BundledGjcSkillCatalogEntry,
} from "./gjc-skills.generated";

export const DEFAULT_GJC_DEFINITION_NAMES = ["deep-interview", "ralplan", "team", "ultragoal"] as const;
export type DefaultGjcDefinitionName = (typeof DEFAULT_GJC_DEFINITION_NAMES)[number];
export type DefaultGjcDefinitionKind = "skill" | "skill-fragment";
export type EmbeddedDefaultGjcSkill = {
	name: DefaultGjcDefinitionName;
	description: string;
	filePath: string;
	baseDir: string;
	source: "bundled:default";
	hide?: boolean;
	/** Content is loaded on demand to keep startup free of bundled Markdown bodies. */
	content: string;
	loadContent: () => Promise<string>;
};
export type DefaultGjcInstallStatus = "different" | "matching" | "missing" | "skipped" | "written";

export interface DefaultGjcSkillDefinition {
	kind: "skill";
	name: DefaultGjcDefinitionName;
	relativePath: string;
	content: string;
	loadContent: () => Promise<string>;
}

export interface DefaultGjcSkillFragmentDefinition {
	kind: "skill-fragment";
	parentSkillName: DefaultGjcDefinitionName;
	relativePath: string;
	content: string;
	loadContent: () => Promise<string>;
}

export type DefaultGjcDefinition = DefaultGjcSkillDefinition | DefaultGjcSkillFragmentDefinition;

export interface InstallDefaultGjcDefinitionsOptions {
	check?: boolean;
	force?: boolean;
	/**
	 * Only rewrite default definition files that already exist on disk but whose
	 * content differs from the embedded defaults. Files that are absent are left
	 * absent (status "missing"). Used by `gjc update` to refresh opted-in copies
	 * without materializing new on-disk copies for users who never installed them.
	 */
	refreshOnly?: boolean;
	targetRoot?: string;
}

export type DefaultGjcDefinitionInstallFile =
	| {
			kind: "skill";
			name: DefaultGjcDefinitionName;
			path: string;
			status: DefaultGjcInstallStatus;
	  }
	| {
			kind: "skill-fragment";
			parentSkillName: DefaultGjcDefinitionName;
			path: string;
			status: DefaultGjcInstallStatus;
	  };

export interface DefaultGjcDefinitionInstallResult {
	targetRoot: string;
	total: number;
	written: number;
	skipped: number;
	matching: number;
	missing: number;
	different: number;
	files: DefaultGjcDefinitionInstallFile[];
}
function sourcePathForBundledEntry(entry: BundledGjcSkillCatalogEntry): string {
	const relative = entry.kind === "skill"
		? entry.relativePath
		: entry.relativePath.replace(/^skill-fragments\//, "");
	return entry.kind === "skill"
		? path.join(import.meta.dir, "gjc", relative)
		: path.join(import.meta.dir, "gjc", "skills", relative);
}

export class BundledDefaultContentError extends Error {
	readonly code = "BUNDLED_DEFAULT_CONTENT_UNREADABLE";
	constructor(
		message: string,
		readonly sourcePath: string,
		readonly cause: unknown,
	) {
		super(message, { cause });
		this.name = "BundledDefaultContentError";
	}
}

export function readBundledContentSync(entry: BundledGjcSkillCatalogEntry): string {
	const sourcePath = sourcePathForBundledEntry(entry);
	try {
		return readFileSync(sourcePath, "utf8");
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new BundledDefaultContentError(`Unable to read bundled GJC definition ${sourcePath}: ${detail}`, sourcePath, cause);
	}
}

function withLazyBundledContent<T extends object>(value: T, entry: BundledGjcSkillCatalogEntry): T & { content: string } {
	Object.defineProperty(value, "content", {
		enumerable: true,
		configurable: false,
		get: () => readBundledContentSync(entry),
	});
	return value as T & { content: string };
}


function asDefaultDefinition(entry: BundledGjcSkillCatalogEntry): DefaultGjcDefinition {
	if (entry.kind === "skill") {
		if (!entry.name) throw new Error(`Bundled skill catalog entry is missing name: ${entry.relativePath}`);
		return withLazyBundledContent(
			{ kind: "skill", name: entry.name as DefaultGjcDefinitionName, relativePath: entry.relativePath, loadContent: entry.loadContent },
			entry,
		);
	}
	if (!entry.parentSkillName) throw new Error(`Bundled skill fragment catalog entry is missing parent: ${entry.relativePath}`);
	return withLazyBundledContent(
		{
			kind: "skill-fragment",
			parentSkillName: entry.parentSkillName as DefaultGjcDefinitionName,
			relativePath: entry.relativePath,
			loadContent: entry.loadContent,
		},
		entry,
	);
}

const DEFAULT_GJC_DEFINITIONS: readonly DefaultGjcDefinition[] = BUNDLED_GJC_SKILL_CATALOG.map(asDefaultDefinition);

export function getDefaultGjcDefinitions(): readonly DefaultGjcDefinition[] {
	return DEFAULT_GJC_DEFINITIONS;
}

export function getDefaultGjcAgentDefinitions(): readonly DefaultGjcDefinition[] {
	return [];
}

export function getEmbeddedDefaultGjcSkillFragments(
	parentSkillName: DefaultGjcDefinitionName,
): DefaultGjcSkillFragmentDefinition[] {
	return DEFAULT_GJC_DEFINITIONS.filter(
		(definition): definition is DefaultGjcSkillFragmentDefinition =>
			definition.kind === "skill-fragment" && definition.parentSkillName === parentSkillName,
	);
}

export function getEmbeddedDefaultGjcSkills(): EmbeddedDefaultGjcSkill[] {
	return DEFAULT_GJC_DEFINITIONS.filter(
		(definition): definition is DefaultGjcSkillDefinition => definition.kind === "skill",
	).map(definition => {
		const catalogEntry = BUNDLED_GJC_SKILL_CATALOG.find(
			entry => entry.kind === "skill" && entry.name === definition.name,
		);
		if (!catalogEntry) {
			throw new Error(`Bundled GJC skill catalog invariant violated for "${definition.name}"`);
		}
		const description = catalogEntry.description ?? `GJC ${definition.name} workflow`;
		return withLazyBundledContent(
			{
				name: definition.name,
				description,
				filePath: `embedded:gjc/${definition.relativePath}`,
				baseDir: `embedded:gjc/skills/${definition.name}`,
				source: "bundled:default",
				loadContent: definition.loadContent,
			},
			catalogEntry,
		);
	});
}

export async function installDefaultGjcDefinitions(
	options: InstallDefaultGjcDefinitionsOptions = {},
): Promise<DefaultGjcDefinitionInstallResult> {
	const targetRoot = options.targetRoot ?? getAgentDir();
	const files: DefaultGjcDefinitionInstallFile[] = [];

	for (const definition of DEFAULT_GJC_DEFINITIONS) {
		const content = await definition.loadContent();
		const destination = path.join(targetRoot, definition.relativePath);
		const existing = await readExistingText(destination);
		let status: DefaultGjcInstallStatus;

		if (options.check) {
			status = existing === undefined ? "missing" : existing === content ? "matching" : "different";
		} else if (options.refreshOnly) {
			if (existing === undefined) {
				status = "missing";
			} else if (existing === content) {
				status = "matching";
			} else {
				await Bun.write(destination, content);
				status = "written";
			}
		} else if (existing !== undefined && !options.force) {
			status = "skipped";
		} else {
			await Bun.write(destination, content);
			status = "written";
		}

		if (definition.kind === "skill") {
			files.push({
				kind: definition.kind,
				name: definition.name,
				path: destination,
				status,
			});
		} else {
			files.push({
				kind: definition.kind,
				parentSkillName: definition.parentSkillName,
				path: destination,
				status,
			});
		}
	}

	return summarizeInstallResult(targetRoot, files);
}

async function readExistingText(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function summarizeInstallResult(
	targetRoot: string,
	files: DefaultGjcDefinitionInstallFile[],
): DefaultGjcDefinitionInstallResult {
	return {
		targetRoot,
		total: files.length,
		written: countStatus(files, "written"),
		skipped: countStatus(files, "skipped"),
		matching: countStatus(files, "matching"),
		missing: countStatus(files, "missing"),
		different: countStatus(files, "different"),
		files,
	};
}

function countStatus(files: readonly DefaultGjcDefinitionInstallFile[], status: DefaultGjcInstallStatus): number {
	return files.filter(file => file.status === status).length;
}
