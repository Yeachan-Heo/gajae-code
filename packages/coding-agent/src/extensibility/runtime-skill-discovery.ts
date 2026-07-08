import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findRepoRoot } from "../capability/fs";
import type { Skill as CapabilitySkill } from "../capability/skill";
import type { SkillsSettings } from "../config/settings-schema";
import { compareSkillOrder, scanSkillsFromDir } from "../discovery/helpers";
import type { Skill } from "./skills";

export type RuntimeSkillDiscoverySource = "project" | "user";

export interface RuntimeSkillDiscoveryCandidate {
	name: string;
	description: string;
	source: RuntimeSkillDiscoverySource;
	path: string;
	useWhen?: string[];
}

export interface DiscoverRuntimeSkillsOptions {
	cwd: string;
	home?: string;
	query?: string;
	limit?: number;
	source?: RuntimeSkillDiscoverySource | "all";
	policy?: SkillsSettings;
}

function getRuntimeHome(): string {
	return process.env.HOME || os.homedir();
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

async function getProjectSkillDirs(cwd: string, home: string): Promise<{ dirs: string[]; repoRoot: string | null }> {
	const dirs: string[] = [];
	let current = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	const repoRoot = await findRepoRoot(current);
	const stop = path.resolve(repoRoot ?? current);
	while (true) {
		if (current !== resolvedHome) {
			dirs.push(path.join(current, ".gjc", "skills"));
		}
		if (current === stop) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return { dirs, repoRoot };
}

function getUseWhen(skill: CapabilitySkill): string[] | undefined {
	const frontmatter = skill.frontmatter as Record<string, unknown> | undefined;
	const values: string[] = [];
	const globs = frontmatter?.globs;
	if (Array.isArray(globs)) {
		values.push(...globs.filter((value): value is string => typeof value === "string"));
	} else if (typeof globs === "string") {
		values.push(globs);
	}
	for (const key of ["use_when", "useWhen", "conditions"]) {
		const raw = frontmatter?.[key];
		if (typeof raw === "string") values.push(raw);
		if (Array.isArray(raw)) values.push(...raw.filter((value): value is string => typeof value === "string"));
	}
	return values.length > 0 ? values : undefined;
}

function toRuntimeSkill(skill: CapabilitySkill, source: RuntimeSkillDiscoverySource): Skill {
	return {
		name: skill.name,
		description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : "",
		filePath: skill.path,
		baseDir: skill.path.replace(/[\\/]SKILL\.md$/, ""),
		source: `runtime:${source}`,
		hide: skill.frontmatter?.hide === true,
		_source: { ...skill._source, providerName: "Runtime skill discovery" },
	};
}
function sourceEnabled(source: RuntimeSkillDiscoverySource, policy: SkillsSettings | undefined): boolean {
	if (policy?.enabled !== true) return false;
	if (source === "project") return policy.enablePiProject === true;
	if (source === "user") return policy.enablePiUser === true;
	return false;
}

function matchesIncludePatterns(name: string, includeSkills: string[] | undefined): boolean {
	if (!includeSkills || includeSkills.length === 0) return true;
	return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
}

function matchesIgnorePatterns(name: string, ignoredSkills: string[] | undefined): boolean {
	if (!ignoredSkills || ignoredSkills.length === 0) return false;
	return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
}

function isDisabledSkill(name: string, disabledExtensions: string[] | undefined): boolean {
	return (disabledExtensions ?? []).some(id => id === `skill:${name}`);
}

function isAllowedByPolicy(
	skill: CapabilitySkill,
	source: RuntimeSkillDiscoverySource,
	policy: SkillsSettings | undefined,
): boolean {
	if (!sourceEnabled(source, policy)) return false;
	if (isDisabledSkill(skill.name, policy?.disabledExtensions)) return false;
	if (matchesIgnorePatterns(skill.name, policy?.ignoredSkills)) return false;
	if (!matchesIncludePatterns(skill.name, policy?.includeSkills)) return false;
	return true;
}
function matchesQuery(candidate: RuntimeSkillDiscoveryCandidate, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	const haystack = [candidate.name, candidate.description, candidate.source, ...(candidate.useWhen ?? [])]
		.join("\n")
		.toLowerCase();
	return normalized
		.split(/\s+/)
		.filter(Boolean)
		.every(term => haystack.includes(term));
}

async function realPathOrSelf(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch {
		return filePath;
	}
}

export async function discoverRuntimeSkills(
	options: DiscoverRuntimeSkillsOptions,
): Promise<RuntimeSkillDiscoveryCandidate[]> {
	const home = options.home ?? getRuntimeHome();
	const source = options.source ?? "all";
	const policy = options.policy;
	const scanJobs: Array<Promise<{ skill: CapabilitySkill; source: RuntimeSkillDiscoverySource }[]>> = [];
	const projectSkills = await getProjectSkillDirs(options.cwd, home);
	const projectContext = { cwd: options.cwd, home, repoRoot: projectSkills.repoRoot };
	if ((source === "all" || source === "project") && sourceEnabled("project", policy)) {
		for (const dir of projectSkills.dirs) {
			scanJobs.push(
				scanSkillsFromDir(projectContext, {
					dir,
					providerId: "runtime",
					level: "project",
					requireDescription: true,
				}).then(result => result.items.map(skill => ({ skill, source: "project" as const }))),
			);
		}
	}
	if ((source === "all" || source === "user") && sourceEnabled("user", policy)) {
		scanJobs.push(
			scanSkillsFromDir(
				{ cwd: options.cwd, home, repoRoot: home },
				{ dir: path.join(home, ".gjc", "skills"), providerId: "runtime", level: "user", requireDescription: true },
			).then(result => result.items.map(skill => ({ skill, source: "user" as const }))),
		);
	}

	const seenNames = new Set<string>();
	const seenPaths = new Set<string>();
	const candidates: RuntimeSkillDiscoveryCandidate[] = [];
	for (const entry of (await Promise.all(scanJobs)).flat()) {
		if (!isAllowedByPolicy(entry.skill, entry.source, policy)) continue;
		const realPath = await realPathOrSelf(entry.skill.path);
		if (seenPaths.has(realPath) || seenNames.has(entry.skill.name)) continue;
		seenPaths.add(realPath);
		seenNames.add(entry.skill.name);
		const candidate: RuntimeSkillDiscoveryCandidate = {
			name: entry.skill.name,
			description:
				typeof entry.skill.frontmatter?.description === "string" ? entry.skill.frontmatter.description : "",
			source: entry.source,
			path: entry.skill.path,
			useWhen: getUseWhen(entry.skill),
		};
		if (matchesQuery(candidate, options.query ?? "")) candidates.push(candidate);
	}
	candidates.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
	return candidates.slice(0, normalizeLimit(options.limit));
}

export async function findRuntimeSkillByName(
	cwd: string,
	name: string,
	policy?: SkillsSettings,
	home = getRuntimeHome(),
): Promise<Skill | undefined> {
	const normalized = name.trim();
	if (!normalized) return undefined;
	const scanJobs: Array<Promise<{ skill: CapabilitySkill; source: RuntimeSkillDiscoverySource }[]>> = [];
	const projectSkills = await getProjectSkillDirs(cwd, home);
	const projectContext = { cwd, home, repoRoot: projectSkills.repoRoot };
	if (sourceEnabled("project", policy)) {
		scanJobs.push(
			...projectSkills.dirs.map(dir =>
				scanSkillsFromDir(projectContext, {
					dir,
					providerId: "runtime",
					level: "project",
					requireDescription: true,
				}).then(result => result.items.map(skill => ({ skill, source: "project" as const }))),
			),
		);
	}
	if (sourceEnabled("user", policy)) {
		scanJobs.push(
			scanSkillsFromDir(
				{ cwd, home, repoRoot: home },
				{ dir: path.join(home, ".gjc", "skills"), providerId: "runtime", level: "user", requireDescription: true },
			).then(result => result.items.map(skill => ({ skill, source: "user" as const }))),
		);
	}
	for (const entry of (await Promise.all(scanJobs)).flat()) {
		if (entry.skill.name === normalized && isAllowedByPolicy(entry.skill, entry.source, policy)) {
			return toRuntimeSkill(entry.skill, entry.source);
		}
	}
	return undefined;
}
