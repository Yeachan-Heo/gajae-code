import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getAgentDir,
	getAgentProfileAuthority,
	getTrustedHomeDir,
	normalizePathForComparison,
} from "@gajae-code/utils";
import { findRepoRoot } from "../capability/fs";
import type { Skill as CapabilitySkill } from "../capability/skill";
import type { SkillsSettings } from "../config/settings-schema";
import { resolveSkillScopeTrust } from "../config/skill-settings-defaults";
import { scanClaudeProjectSkills, scanClaudeUserSkills } from "../discovery/claude";
import { loadMarketplaceSkills } from "../discovery/claude-plugins";
import { scanCodexProjectSkills, scanCodexUserSkills } from "../discovery/codex";
import {
	compareSkillOrder,
	getAncestorDirs,
	getUserSkillScanDirs,
	SOURCE_PATHS,
	scanSkillsFromDir,
} from "../discovery/helpers";
import {
	getSkillFilesystemIdentity,
	isCanonicalGjcWorkflowSkillFilesystemAlias,
} from "../skill-state/canonical-skills";
import { expandTilde } from "../tools/path-utils";
import { loadSkills, type Skill } from "./skills";

export type RuntimeSkillDiscoverySource = "project" | "user";

export interface RuntimeSkillDiscoveryCandidate {
	name: string;
	description: string;
	source: RuntimeSkillDiscoverySource;
	path: string;
	useWhen?: string[];
}

/**
 * Human-readable diagnostics collected while scanning, so an empty or partial
 * result is explainable: protected-name collisions with bundled workflow
 * skills, skills filtered by include/ignore/disable policy, invalid frontmatter,
 * and scan warnings. Bounded to avoid flooding tool output.
 */
export interface RuntimeSkillDiscoveryDiagnostics {
	messages: string[];
}

export interface RuntimeSkillDiscoveryResult {
	candidates: RuntimeSkillDiscoveryCandidate[];
	diagnostics: RuntimeSkillDiscoveryDiagnostics;
}

export interface DiscoverRuntimeSkillsOptions {
	cwd: string;
	home?: string;
	agentDir?: string;
	/** Resolver-owned profile classification; unlike path comparison, this survives HOME refreshes. */
	profileAuthority?: "default" | "custom";
	query?: string;
	limit?: number;
	source?: RuntimeSkillDiscoverySource | "all";
	policy?: SkillsSettings;
}

function getRuntimeHome(): string {
	return getTrustedHomeDir();
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_DIAGNOSTICS = 10;
function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

interface ProjectScanDir {
	dir: string;
	/** Precedence label used in diagnostics, e.g. "project .gjc/skills". */
	label: string;
}

/**
 * Project skill scan directories in deterministic precedence order: `.gjc/skills`
 * in every ancestor from `cwd` up to the repo root (closest first). Claude/Codex
 * convention layouts are explicit import sources into `.gjc` (see
 * extensibility/skill-management.ts) and are intentionally not scanned here.
 *
 * The walk never enters the home directory, so `~/.gjc/skills` stays a
 * user-scope path and cannot be reclassified as project content.
 */
async function getProjectSkillDirs(
	cwd: string,
	home: string,
): Promise<{ scans: ProjectScanDir[]; repoRoot: string | null }> {
	const scans: ProjectScanDir[] = [];
	const repoRoot = await findRepoRoot(cwd);
	const walkDirs = getAncestorDirs(cwd, path.resolve(repoRoot ?? cwd), home);
	for (const { dir } of walkDirs) {
		scans.push({ dir: path.join(dir, ".gjc", "skills"), label: "project .gjc/skills" });
	}
	return { scans, repoRoot };
}

function getUserSkillDirs(home: string, agentDir = getAgentDir(), profileAuthority?: "default" | "custom"): string[] {
	return getUserSkillScanDirs(home, agentDir, profileAuthority);
}

function resolveRuntimeAgentDir(home: string, agentDir: string | undefined, homeWasInjected: boolean): string {
	return agentDir ?? (homeWasInjected ? path.join(home, SOURCE_PATHS.native.userAgent) : getAgentDir());
}

/**
 * Directories named by `skills.customDirectories`, which session startup loads
 * through `loadSkills`. Discovery scans them too so a configured skill cannot be
 * invocable and unfindable at the same time.
 *
 * Naming a directory is explicit consent, so these are not gated on scope trust
 * — the same rule `loadSkills` applies. They resolve at user level, so a
 * project-scoped query excludes them.
 */
function getCustomSkillDirs(policy: SkillsSettings | undefined, home: string): string[] {
	const configured = policy?.customDirectories;
	if (!Array.isArray(configured)) return [];
	return [
		...new Set(configured.filter(dir => typeof dir === "string" && dir.trim()).map(dir => expandTilde(dir, home))),
	];
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

function sourceEnabled(source: RuntimeSkillDiscoverySource, policy: SkillsSettings | undefined): boolean {
	if (policy?.enabled !== true) return false;
	return resolveSkillScopeTrust(policy, source);
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

function matchesQuery(candidate: RuntimeSkillDiscoveryCandidate, query: string): boolean {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	if (terms.includes(candidate.name.toLowerCase())) return true;
	const haystack = [candidate.name, candidate.description, candidate.source, ...(candidate.useWhen ?? [])]
		.join("\n")
		.toLowerCase();
	return terms.every(term => haystack.includes(term));
}

async function realPathOrSelf(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch {
		return filePath;
	}
}

interface ScanJobResult {
	items: Array<{ skill: CapabilitySkill; source: RuntimeSkillDiscoverySource; providerPriority: number }>;
	warnings: string[];
	label: string;
}

function isAllowedByPolicy(skill: CapabilitySkill, policy: SkillsSettings | undefined, diagnostics: string[]): boolean {
	if (isCanonicalGjcWorkflowSkillFilesystemAlias(skill.name)) {
		pushDiagnostic(
			diagnostics,
			`skill "${skill.name}" is a bundled GJC workflow skill and always resolves to the bundled definition; the filesystem copy at ${skill.path} is shadowed`,
		);
		return false;
	}
	if (isDisabledSkill(skill.name, policy?.disabledExtensions)) {
		pushDiagnostic(diagnostics, `skill "${skill.name}" is disabled via disabledExtensions; ignoring ${skill.path}`);
		return false;
	}
	if (matchesIgnorePatterns(skill.name, policy?.ignoredSkills)) {
		pushDiagnostic(diagnostics, `skill "${skill.name}" is filtered by skills.ignoredSkills; ignoring ${skill.path}`);
		return false;
	}
	if (!matchesIncludePatterns(skill.name, policy?.includeSkills)) {
		pushDiagnostic(diagnostics, `skill "${skill.name}" does not match skills.includeSkills; ignoring ${skill.path}`);
		return false;
	}
	return true;
}

function pushDiagnostic(diagnostics: string[], message: string): void {
	if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message);
}

async function collectPluginSkills(
	home: string,
	cwd: string,
	allowedLevels: ReadonlySet<"user" | "project">,
): Promise<{ items: CapabilitySkill[]; warnings: string[] }> {
	try {
		const result = await loadMarketplaceSkills({ cwd, home, repoRoot: await findRepoRoot(cwd) }, allowedLevels);
		return { items: result.items, warnings: result.warnings ?? [] };
	} catch (error) {
		return { items: [], warnings: [`marketplace skill scan failed: ${String(error)}`] };
	}
}

async function diagnoseCustomDir(expandedDir: string, diagnostics: string[]): Promise<boolean> {
	try {
		const stat = await fs.lstat(expandedDir);
		if (stat.isSymbolicLink()) {
			try {
				await fs.stat(expandedDir);
			} catch {
				pushDiagnostic(
					diagnostics,
					`skills.customDirectories entry "${expandedDir}" is a dangling symlink (target missing, likely a purged plugin cache dir); fix or remove it`,
				);
				return true;
			}
		}
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			pushDiagnostic(
				diagnostics,
				`skills.customDirectories entry "${expandedDir}" does not exist (missing directory, likely a purged plugin cache dir); fix or remove it`,
			);
			return true;
		}
		return false;
	}
}

async function scanProjectOrUserDir(
	ctx: { cwd: string; home: string; repoRoot: string | null },
	dir: string,
	level: "project" | "user",
	label: string,
	source: RuntimeSkillDiscoverySource,
	providerPriority: number,
	authorityRoot?: string,
): Promise<ScanJobResult> {
	const result = await scanSkillsFromDir(ctx, {
		dir,
		authorityRoot,
		providerId: "runtime",
		level,
		requireDescription: true,
	});
	return {
		items: result.items.map(skill => ({ skill, source, providerPriority })),
		warnings: result.warnings ?? [],
		label,
	};
}

interface ConventionImportScan {
	host: "Claude Code" | "Codex";
	dir: string;
	skills: CapabilitySkill[];
}

/**
 * Enumerate Claude Code / Codex skill layouts as explicit import candidates.
 * Convention skills are never advertised as invokable candidates (they become
 * ordinary native skills only after an explicit import into `.gjc/skills`), but
 * they are reported as diagnostics so a skill placed in a documented convention
 * location is visibly discoverable — with the exact enablement action — instead
 * of invisible. Foreign user-home layouts are only enumerated when the user
 * scope is trusted and are still never loaded.
 */
async function collectConventionImportCandidates(
	ctx: { cwd: string; home: string; repoRoot: string | null },
	source: RuntimeSkillDiscoverySource | "all",
	policy: SkillsSettings | undefined,
): Promise<ConventionImportScan[]> {
	const scans: ConventionImportScan[] = [];
	const jobs: Array<Promise<void>> = [];
	if ((source === "all" || source === "project") && sourceEnabled("project", policy)) {
		jobs.push(
			scanClaudeProjectSkills(ctx).then(result => {
				scans.push({ host: "Claude Code", dir: ".claude/skills", skills: result.items });
			}),
			scanCodexProjectSkills(ctx).then(result => {
				scans.push({ host: "Codex", dir: ".codex/skills", skills: result.items });
			}),
		);
	}
	if ((source === "all" || source === "user") && sourceEnabled("user", policy)) {
		jobs.push(
			scanClaudeUserSkills(ctx).then(result => {
				scans.push({ host: "Claude Code", dir: "~/.claude/skills", skills: result.items });
			}),
			scanCodexUserSkills(ctx).then(result => {
				scans.push({ host: "Codex", dir: "~/.codex/skills", skills: result.items });
			}),
		);
	}
	await Promise.all(jobs);
	return scans;
}

/** Diagnose convention import candidates not already advertised as native candidates. */
function reportConventionImportCandidates(
	scans: ConventionImportScan[],
	seenNames: Set<string>,
	diagnostics: string[],
): void {
	for (const scan of scans.sort((a, b) => a.host.localeCompare(b.host) || a.dir.localeCompare(b.dir))) {
		for (const skill of scan.skills) {
			const normalizedName = getSkillFilesystemIdentity(skill.name);
			if (seenNames.has(normalizedName)) continue;
			seenNames.add(normalizedName);
			pushDiagnostic(
				diagnostics,
				`skill "${skill.name}" found at ${skill.path} (${scan.host} convention): import sources are not loaded directly; copy it into a trusted .gjc/skills directory to enable it, e.g. mkdir -p .gjc/skills/${skill.name} && cp ${skill.path} .gjc/skills/${skill.name}/SKILL.md`,
			);
		}
	}
}

/**
 * Explain an empty result that is caused by disabled discovery config rather
 * than by an actually empty skill catalog. Uses the user-facing trust
 * settings; the legacy `skills.enablePiUser` / `skills.enablePiProject`
 * aliases map onto the same effective values. Shared by the skill_discovery
 * tool and `gjc skills discover`.
 */
export function describeDisabledSkillScopes(
	source: RuntimeSkillDiscoverySource | "all",
	policy: SkillsSettings | undefined,
): string | undefined {
	if (policy?.enabled !== true) {
		return "Runtime skill discovery is disabled: `skills.enabled` is false, so no skill directories were searched. Enable it with `gjc config set skills.enabled true`.";
	}
	const skipped: string[] = [];
	const commands: string[] = [];
	if ((source === "all" || source === "project") && !resolveSkillScopeTrust(policy, "project")) {
		skipped.push("project (`skills.trustProjectSkills` is false)");
		commands.push("`gjc config set skills.trustProjectSkills true`");
	}
	if ((source === "all" || source === "user") && !resolveSkillScopeTrust(policy, "user")) {
		skipped.push("user (`skills.trustUserSkills` is false)");
		commands.push("`gjc config set skills.trustUserSkills true`");
	}
	if (skipped.length === 0) return undefined;
	return `Skill discovery skipped disabled scope(s): ${skipped.join(", ")}. Enable them with ${commands.join(" and ")}.`;
}

export async function discoverRuntimeSkills(
	options: DiscoverRuntimeSkillsOptions,
): Promise<RuntimeSkillDiscoveryResult> {
	const hasExplicitHome = options.home !== undefined;
	const home = options.home ?? getRuntimeHome();
	const source = options.source ?? "all";
	const policy = options.policy;
	const diagnostics: string[] = [];
	const agentDir = resolveRuntimeAgentDir(home, options.agentDir, hasExplicitHome);
	const profileAuthority =
		options.profileAuthority ??
		(!hasExplicitHome
			? options.agentDir !== undefined &&
				normalizePathForComparison(options.agentDir) !== normalizePathForComparison(getAgentDir())
				? "custom"
				: getAgentProfileAuthority()
			: undefined);
	const scanJobs: Array<Promise<ScanJobResult>> = [];
	const projectDirs = await getProjectSkillDirs(options.cwd, home);
	const projectContext = { cwd: options.cwd, home, repoRoot: projectDirs.repoRoot };
	if ((source === "all" || source === "project") && sourceEnabled("project", policy)) {
		for (const { dir, label } of projectDirs.scans) {
			scanJobs.push(scanProjectOrUserDir(projectContext, dir, "project", label, "project", 100));
		}
	}
	if ((source === "all" || source === "user") && sourceEnabled("user", policy)) {
		for (const dir of getUserSkillDirs(home, agentDir, profileAuthority)) {
			scanJobs.push(
				scanProjectOrUserDir(
					{ cwd: options.cwd, home, repoRoot: home },
					dir,
					"user",
					`user ${dir}`,
					"user",
					100,
					agentDir,
				),
			);
		}
	}
	if ((source === "all" || source === "user") && policy?.enabled === true) {
		for (const dir of getCustomSkillDirs(policy, home)) {
			scanJobs.push(
				scanProjectOrUserDir({ cwd: options.cwd, home, repoRoot: home }, dir, "user", `custom ${dir}`, "user", 0),
			);
		}
	}

	// Marketplace plugin skills come from the same provider used to populate
	// session.skills, so discovery, slash commands, SDK state, and exact-name
	// invocation cannot drift on manifest paths, namespacing, or enabled roots.
	if (policy?.enabled === true) {
		const allowedLevels = new Set<"user" | "project">();
		if ((source === "all" || source === "project") && sourceEnabled("project", policy)) {
			allowedLevels.add("project");
		}
		if ((source === "all" || source === "user") && sourceEnabled("user", policy)) {
			allowedLevels.add("user");
		}
		scanJobs.push(
			collectPluginSkills(home, options.cwd, allowedLevels).then(result => ({
				items: result.items.map(skill => ({
					skill,
					source: skill.level as RuntimeSkillDiscoverySource,
					providerPriority: 70,
				})),
				warnings: result.warnings,
				label: "marketplace plugin skills",
			})),
		);
	}
	if (policy?.enabled === true && policy.customDirectories && policy.customDirectories.length > 0) {
		for (const dir of getCustomSkillDirs(policy, home)) {
			await diagnoseCustomDir(dir, diagnostics);
		}
	}

	const settled = await Promise.all(scanJobs.map(job => job.catch(error => ({ error: String(error), label: "" }))));

	const seenNames = new Set<string>();
	const seenPaths = new Set<string>();
	const candidates: RuntimeSkillDiscoveryCandidate[] = [];
	const orderedItems: ScanJobResult["items"] = [];
	for (const entry of settled) {
		if ("error" in entry) {
			pushDiagnostic(diagnostics, `skill scan failed: ${entry.error}`);
			continue;
		}
		if (entry.label) {
			for (const warning of entry.warnings) {
				pushDiagnostic(diagnostics, `${entry.label}: ${warning}`);
			}
		}
		orderedItems.push(...entry.items);
	}
	orderedItems.sort((a, b) => {
		const levelOrder = { project: 0, user: 1 } as const;
		return levelOrder[a.source] - levelOrder[b.source] || b.providerPriority - a.providerPriority;
	});
	for (const item of orderedItems) {
		if (!isAllowedByPolicy(item.skill, policy, diagnostics)) continue;
		const realPath = await realPathOrSelf(item.skill.path);
		const normalizedName = getSkillFilesystemIdentity(item.skill.name);
		if (seenPaths.has(realPath) || seenNames.has(normalizedName)) {
			pushDiagnostic(
				diagnostics,
				`skill "${item.skill.name}" already resolved from a higher-precedence location; ignoring ${item.skill.path}`,
			);
			continue;
		}
		seenPaths.add(realPath);
		seenNames.add(normalizedName);

		const candidate: RuntimeSkillDiscoveryCandidate = {
			name: item.skill.name,
			description: typeof item.skill.frontmatter?.description === "string" ? item.skill.frontmatter.description : "",
			source: item.source,
			path: item.skill.path,
			useWhen: getUseWhen(item.skill),
		};
		if (matchesQuery(candidate, options.query ?? "")) candidates.push(candidate);
	}
	candidates.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
	reportConventionImportCandidates(
		await collectConventionImportCandidates(projectContext, source, policy),
		seenNames,
		diagnostics,
	);
	return {
		candidates: candidates.slice(0, normalizeLimit(options.limit)),
		diagnostics: { messages: diagnostics },
	};
}

export async function findRuntimeSkillByName(
	cwd: string,
	name: string,
	policy?: SkillsSettings,
	home?: string,
	agentDir?: string,
	profileAuthority?: "default" | "custom",
): Promise<Skill | undefined> {
	const normalized = name.trim();
	if (!normalized) return undefined;
	if (isCanonicalGjcWorkflowSkillFilesystemAlias(normalized)) return undefined;
	const hasExplicitHome = home !== undefined;
	const resolvedHome = home ?? getRuntimeHome();
	const resolvedAgentDir = resolveRuntimeAgentDir(resolvedHome, agentDir, hasExplicitHome);
	const resolvedProfileAuthority =
		profileAuthority ??
		(!hasExplicitHome
			? agentDir !== undefined && normalizePathForComparison(agentDir) !== normalizePathForComparison(getAgentDir())
				? "custom"
				: getAgentProfileAuthority()
			: undefined);
	const loaded = await loadSkills({
		...policy,
		cwd,
		home: resolvedHome,
		agentDir: resolvedAgentDir,
		profileAuthority: resolvedProfileAuthority,
	});
	return loaded.skills.find(skill => skill.name === normalized);
}
