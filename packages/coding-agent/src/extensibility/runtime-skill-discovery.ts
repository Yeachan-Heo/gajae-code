import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill as CapabilitySkill } from "../capability/skill";
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

function getProjectSkillDirs(cwd: string, stopAt: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(cwd);
	const stop = path.resolve(stopAt);
	while (true) {
		dirs.push(path.join(current, ".gjc", "skills"));
		if (current === stop) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
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
	const scanJobs: Array<Promise<{ skill: CapabilitySkill; source: RuntimeSkillDiscoverySource }[]>> = [];
	if (source === "all" || source === "project") {
		for (const dir of getProjectSkillDirs(options.cwd, home)) {
			scanJobs.push(
				scanSkillsFromDir(
					{ cwd: options.cwd, home, repoRoot: home },
					{ dir, providerId: "runtime", level: "project", requireDescription: true },
				).then(result => result.items.map(skill => ({ skill, source: "project" as const }))),
			);
		}
	}
	if (source === "all" || source === "user") {
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
	home = getRuntimeHome(),
): Promise<Skill | undefined> {
	const normalized = name.trim();
	if (!normalized) return undefined;
	const scanJobs = [
		...getProjectSkillDirs(cwd, home).map(dir =>
			scanSkillsFromDir(
				{ cwd, home, repoRoot: home },
				{ dir, providerId: "runtime", level: "project", requireDescription: true },
			).then(result => result.items.map(skill => ({ skill, source: "project" as const }))),
		),
		scanSkillsFromDir(
			{ cwd, home, repoRoot: home },
			{ dir: path.join(home, ".gjc", "skills"), providerId: "runtime", level: "user", requireDescription: true },
		).then(result => result.items.map(skill => ({ skill, source: "user" as const }))),
	];
	for (const entry of (await Promise.all(scanJobs)).flat()) {
		if (entry.skill.name === normalized) return toRuntimeSkill(entry.skill, entry.source);
	}
	return undefined;
}
