/**
 * Authoritative skill management contracts for native `.gjc` skills.
 *
 * Canonical skill locations are project `<project>/.gjc/skills/` and global
 * `~/.gjc/agent/skills/` (plus legacy user roots). Claude Code / Codex layouts
 * are explicit import sources into `.gjc` and are enumerated separately by
 * `listConventionSkillImportSources`; they are never loaded as ordinary runtime
 * skills.
 *
 * These contracts are the reusable behavior the `/extensions` surface (#4291)
 * and SDK consumers build on: discovery with provenance + enablement state,
 * writing a skill file into a scope, and per-skill enable/disable. The import
 * preview/apply transaction and the UI itself are owned by #4291.
 */
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getAgentDir,
	getAgentProfileAuthority,
	getTrustedHomeDir,
	normalizePathForComparison,
	parseFrontmatter,
} from "@gajae-code/utils";
import { findRepoRoot } from "../capability/fs";
import type { Skill as CapabilitySkill } from "../capability/skill";
import { resolveSkillScopeTrust } from "../config/skill-settings-defaults";
import { scanClaudeProjectSkills, scanClaudeUserSkills } from "../discovery/claude";
import { scanCodexProjectSkills, scanCodexUserSkills } from "../discovery/codex";
import {
	compareSkillOrder,
	getAncestorDirs,
	getUserSkillScanDirs,
	resolveUserAgentDir,
	scanSkillsFromDir,
} from "../discovery/helpers";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../skill-state/canonical-skills";
export type SkillScope = "project" | "user";
export type ConventionSkillHost = "claude" | "codex";

export interface SkillManagementPolicy {
	enabled?: boolean;
	trustProjectSkills?: boolean;
	trustUserSkills?: boolean;
	ignoredSkills?: string[];
	includeSkills?: string[];
	disabledExtensions?: string[];
}

export type SkillDisabledReason = "protected" | "scope-trust" | "ignored" | "include" | "disabled-extension";

/** A discovered native skill with provenance and enablement state. */
export interface ManagedSkillRecord {
	name: string;
	description: string;
	path: string;
	scope: SkillScope;
	/** Canonical source label, e.g. "project .gjc/skills" or "user ~/.gjc/agent/skills". */
	source: string;
	hidden: boolean;
	enabled: boolean;
	disabledReason?: SkillDisabledReason;
}

/** A Claude Code / Codex skill enumerated as an explicit import source into `.gjc`. */
export interface ConventionSkillImportSource {
	host: ConventionSkillHost;
	scope: SkillScope;
	name: string;
	description: string;
	path: string;
}

export interface WriteNativeSkillInput {
	cwd: string;
	home?: string;
	agentDir?: string;
	scope: SkillScope;
	name: string;
	content: string;
}

export interface WriteNativeSkillReceipt {
	name: string;
	scope: SkillScope;
	directory: string;
	path: string;
}

/** Raised when a write targets one of the four bundled workflow skill names. */
export class SkillNameProtectedError extends Error {
	readonly code = "SKILL_NAME_PROTECTED";
	constructor(name: string) {
		super(
			`skill "${name}" is a bundled GJC workflow skill (${CANONICAL_GJC_WORKFLOW_SKILLS.join(", ")}) and cannot be written as a custom skill`,
		);
		this.name = "SkillNameProtectedError";
	}
}

/** Raised when skill content has no parseable frontmatter or lacks a description. */
export class SkillFrontmatterError extends Error {
	readonly code = "SKILL_FRONTMATTER_INVALID";
	constructor(message: string) {
		super(message);
		this.name = "SkillFrontmatterError";
	}
}

const BUILT_IN_SKILL_NAMES = new Set<string>(CANONICAL_GJC_WORKFLOW_SKILLS.map(name => name.toLowerCase()));

function isProtectedSkillName(name: string): boolean {
	return BUILT_IN_SKILL_NAMES.has(name.toLowerCase());
}

function assertSafeSkillName(name: string): void {
	if (
		name === "." ||
		name === ".." ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0") ||
		path.basename(name) !== name
	) {
		throw new SkillFrontmatterError(`skill name must be a single path segment: ${name}`);
	}
}

function isPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureSafeDescendantDirectory(root: string, segments: readonly string[]): Promise<string> {
	try {
		const rootStat = await fs.lstat(root);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			throw new SkillFrontmatterError(`skill authority root is not a safe directory: ${root}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await fs.mkdir(root, { recursive: true });
		const rootStat = await fs.lstat(root);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			throw new SkillFrontmatterError(`skill authority root is not a safe directory: ${root}`);
		}
	}
	const realRoot = await fs.realpath(root);
	let current = root;
	for (const segment of segments) {
		current = path.join(current, segment);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new SkillFrontmatterError(`skill destination is not a safe directory: ${current}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				await fs.mkdir(current);
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				const stat = await fs.lstat(current);
				if (stat.isSymbolicLink() || !stat.isDirectory()) {
					throw new SkillFrontmatterError(`skill destination is not a safe directory: ${current}`);
				}
			}
		}
		const realCurrent = await fs.realpath(current);
		if (!isPathWithin(realRoot, realCurrent)) {
			throw new SkillFrontmatterError(`skill destination escapes its scope root: ${current}`);
		}
	}
	return current;
}

async function writeSkillFileSafely(skillDir: string, scopeRoot: string, content: string): Promise<string> {
	const [canonicalSkillDir, canonicalScopeRoot] = await Promise.all([fs.realpath(skillDir), fs.realpath(scopeRoot)]);
	if (!isPathWithin(canonicalScopeRoot, canonicalSkillDir)) {
		throw new SkillFrontmatterError(`skill destination escapes its scope root: ${skillDir}`);
	}
	const filePath = path.join(skillDir, "SKILL.md");
	let destinationExists = false;
	try {
		const destination = await fs.lstat(filePath);
		if (destination.isSymbolicLink() || !destination.isFile()) {
			throw new SkillFrontmatterError(`skill destination is not a safe file: ${filePath}`);
		}
		destinationExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const noFollowFlags =
		process.platform === "win32" ? 0 : (nodeFs.constants.O_NOFOLLOW ?? 0) | (nodeFs.constants.O_NONBLOCK ?? 0);
	const flags = destinationExists
		? nodeFs.constants.O_WRONLY | noFollowFlags
		: nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL | noFollowFlags;
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(filePath, flags, 0o600);
	} catch (error) {
		throw new SkillFrontmatterError(`skill destination is not a safe file: ${filePath} (${String(error)})`);
	}
	try {
		const [opened, observed, currentSkillDir] = await Promise.all([
			handle.stat({ bigint: true }),
			fs.lstat(filePath, { bigint: true }),
			fs.realpath(skillDir),
		]);
		if (
			!opened.isFile() ||
			opened.nlink !== 1n ||
			observed.isSymbolicLink() ||
			!observed.isFile() ||
			opened.dev !== observed.dev ||
			opened.ino !== observed.ino ||
			normalizePathForComparison(currentSkillDir) !== normalizePathForComparison(canonicalSkillDir) ||
			!isPathWithin(canonicalScopeRoot, currentSkillDir)
		) {
			throw new SkillFrontmatterError(`skill destination changed during write: ${filePath}`);
		}
		await handle.truncate(0);
		await handle.writeFile(content);
	} finally {
		await handle.close();
	}
	return filePath;
}

function getRuntimeHome(): string {
	return getTrustedHomeDir();
}

/**
 * Canonical project skill directories in precedence order: `.gjc/skills` in
 * every ancestor from `cwd` up to the repo root (closest first).
 */
export async function getProjectSkillDirs(
	cwd: string,
	home: string,
): Promise<{ dirs: string[]; repoRoot: string | null }> {
	const repoRoot = await findRepoRoot(cwd);
	const walkDirs = getAncestorDirs(cwd, path.resolve(repoRoot ?? cwd), home);
	return { dirs: walkDirs.map(({ dir }) => path.join(dir, ".gjc", "skills")), repoRoot };
}

/** Canonical user skill directories in precedence order (same resolution as runtime discovery). */
export function getUserSkillDirs(home: string, agentDir?: string, profileAuthority?: "default" | "custom"): string[] {
	return getUserSkillScanDirs(home, agentDir, profileAuthority);
}

/**
 * The canonical directory a write targets for a scope: the repo root (or `cwd`)
 * `.gjc/skills` for project scope, the agent directory's `skills` root for user
 * scope — the same directory every reader scans first (`gjc config path` prints
 * it; `--agent-dir` / `GJC_CODING_AGENT_DIR` / `setAgentDir()` move it).
 */
export async function resolveNativeSkillScopeDir(
	cwd: string,
	scope: SkillScope,
	_home?: string,
	agentDir?: string,
): Promise<string> {
	const home = _home ?? getRuntimeHome();
	if (scope === "user") {
		const resolvedAgentDir = agentDir ?? (_home === undefined ? getAgentDir() : resolveUserAgentDir(home));
		return path.join(path.resolve(resolvedAgentDir), "skills");
	}
	const repoRoot = await findRepoRoot(cwd);
	const resolvedCwd = path.resolve(cwd);
	const projectRoot = repoRoot ?? resolvedCwd;
	if (normalizePathForComparison(projectRoot) === normalizePathForComparison(home)) {
		if (normalizePathForComparison(resolvedCwd) === normalizePathForComparison(home)) {
			throw new SkillFrontmatterError("project skill scope is unavailable at the user home boundary");
		}
		return path.join(resolvedCwd, ".gjc", "skills");
	}
	return path.join(projectRoot, ".gjc", "skills");
}

function matchesPattern(name: string, patterns: string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	return patterns.some(pattern => new Bun.Glob(pattern).match(name));
}

function isDisabledByExtension(name: string, disabledExtensions: string[] | undefined): boolean {
	return (disabledExtensions ?? []).some(id => id === `skill:${name}`);
}

/**
 * Authoritative discovery of native skills with provenance and enablement
 * state. Unlike runtime session discovery, this lists every scanned skill —
 * including disabled, shadowed, and protected ones — so `/extensions` and SDK
 * consumers can show and toggle the full catalog.
 */
export async function listNativeSkillsForManagement(options: {
	cwd: string;
	home?: string;
	agentDir?: string;
	/** Resolver-owned profile classification; unlike path comparison, this survives HOME refreshes. */
	profileAuthority?: "default" | "custom";
	policy?: SkillManagementPolicy;
}): Promise<ManagedSkillRecord[]> {
	const homeWasInjected = options.home !== undefined;
	const home = options.home ?? getRuntimeHome();
	const agentDir = options.agentDir ?? (homeWasInjected ? resolveUserAgentDir(home) : getAgentDir());
	const profileAuthority =
		options.profileAuthority ??
		(options.agentDir !== undefined
			? normalizePathForComparison(options.agentDir) ===
				normalizePathForComparison(homeWasInjected ? resolveUserAgentDir(home) : getAgentDir())
				? homeWasInjected
					? "default"
					: getAgentProfileAuthority()
				: "custom"
			: !homeWasInjected
				? getAgentProfileAuthority()
				: undefined);
	const policy = options.policy;
	const projectTrusted = resolveSkillScopeTrust(policy ?? {}, "project");
	const userTrusted = resolveSkillScopeTrust(policy ?? {}, "user");

	const scanJobs: Array<Promise<{ dir: string; scope: SkillScope; items: CapabilitySkill[] }>> = [];
	const projectDirs = await getProjectSkillDirs(options.cwd, home);
	if (projectTrusted) {
		for (const dir of projectDirs.dirs) {
			scanJobs.push(
				scanSkillsFromDir(
					{ cwd: options.cwd, home, repoRoot: projectDirs.repoRoot },
					{ dir, providerId: "runtime", level: "project", requireDescription: true },
				).then(result => ({ dir, scope: "project" as const, items: result.items })),
			);
		}
	}
	if (userTrusted) {
		for (const dir of getUserSkillScanDirs(home, agentDir, profileAuthority)) {
			scanJobs.push(
				scanSkillsFromDir(
					{ cwd: options.cwd, home, repoRoot: home },
					{ dir, authorityRoot: agentDir, providerId: "runtime", level: "user", requireDescription: true },
				).then(result => ({ dir, scope: "user" as const, items: result.items })),
			);
		}
	}

	const records: ManagedSkillRecord[] = [];
	const seenNames = new Set<string>();
	const seenPaths = new Set<string>();

	for (const { dir, scope, items } of await Promise.all(scanJobs)) {
		const source = scope === "project" ? "project .gjc/skills" : `user ${dir}`;
		for (const skill of items) {
			const realPath = await safeRealpath(skill.path);
			if (seenPaths.has(realPath)) continue;

			let disabledReason: SkillDisabledReason | undefined;
			let enabled = true;
			if (isProtectedSkillName(skill.name)) {
				enabled = false;
				disabledReason = "protected";
			} else if (!(scope === "project" ? projectTrusted : userTrusted)) {
				enabled = false;
				disabledReason = "scope-trust";
			} else if (matchesPattern(skill.name, policy?.ignoredSkills)) {
				enabled = false;
				disabledReason = "ignored";
			} else if (policy?.includeSkills?.length && !matchesPattern(skill.name, policy.includeSkills)) {
				enabled = false;
				disabledReason = "include";
			} else if (isDisabledByExtension(skill.name, policy?.disabledExtensions)) {
				enabled = false;
				disabledReason = "disabled-extension";
			}

			if (!seenNames.has(skill.name)) {
				seenNames.add(skill.name);
				records.push({
					name: skill.name,
					description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : "",
					path: skill.path,
					scope,
					source,
					hidden: skill.frontmatter?.hide === true,
					enabled,
					disabledReason,
				});
			}
			seenPaths.add(realPath);
		}
	}

	records.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
	return records;
}

/**
 * Write a native skill into the canonical `.gjc` scope directory. The content
 * must parse as frontmatter with a non-empty `description`; the effective name
 * comes from `frontmatter.name` when present, else the requested `name`. Bundled
 * workflow skill names are rejected.
 */
export async function writeNativeSkill(input: WriteNativeSkillInput): Promise<WriteNativeSkillReceipt> {
	const name = input.name.trim();
	if (!name) throw new SkillFrontmatterError("skill name is required");

	const { frontmatter } = parseFrontmatter(input.content, { source: "<skill-content>" });
	if (!frontmatter) throw new SkillFrontmatterError("skill content must start with a YAML frontmatter block (---)");
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!description) throw new SkillFrontmatterError("skill frontmatter must include a non-empty description");

	const effectiveName =
		typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : name;
	assertSafeSkillName(effectiveName);
	if (isProtectedSkillName(effectiveName)) throw new SkillNameProtectedError(effectiveName);

	const directory = await resolveNativeSkillScopeDir(input.cwd, input.scope, input.home, input.agentDir);
	const scopeRoot = input.scope === "user" ? path.dirname(directory) : path.dirname(path.dirname(directory));
	const relativeDirectory = path.relative(scopeRoot, directory);
	const directorySegments = relativeDirectory.split(path.sep).filter(Boolean);
	const skillDir = await ensureSafeDescendantDirectory(scopeRoot, [...directorySegments, effectiveName]);
	const filePath = await writeSkillFileSafely(skillDir, scopeRoot, `${input.content.trimEnd()}\n`);
	return { name: effectiveName, scope: input.scope, directory, path: filePath };
}

/** Whether a skill is enabled under the current policy (disabledExtensions/ignored/scope trust). */
export function isNativeSkillEnabled(name: string, policy: SkillManagementPolicy | undefined): boolean {
	if (isProtectedSkillName(name)) return true;
	if (isDisabledByExtension(name, policy?.disabledExtensions)) return false;
	if (matchesPattern(name, policy?.ignoredSkills)) return false;
	if (policy?.includeSkills?.length && !matchesPattern(name, policy.includeSkills)) return false;
	return true;
}

/**
 * Toggle per-skill enablement by adding/removing the `skill:<name>` entry in
 * `disabledExtensions`. Returns the updated list; the caller persists it through
 * Settings. Bundled workflow skill names cannot be disabled.
 */
export function setNativeSkillEnabled(name: string, enabled: boolean, disabledExtensions: string[]): string[] {
	const id = `skill:${name}`;
	const next = new Set(disabledExtensions);
	if (isProtectedSkillName(name)) return [...next];
	if (enabled) {
		next.delete(id);
	} else {
		next.add(id);
	}
	return [...next];
}

/**
 * Enumerate Claude Code / Codex skills (project and user scope) as explicit
 * import sources into `.gjc`. This only reads the foreign layouts for
 * inspection/import; nothing is loaded into sessions and user-home content is
 * never used without an explicit import action (#4291).
 */
export async function listConventionSkillImportSources(options: {
	cwd: string;
	home?: string;
	host?: ConventionSkillHost | "all";
}): Promise<ConventionSkillImportSource[]> {
	const home = options.home ?? getRuntimeHome();
	const hosts: ConventionSkillHost[] = options.host === "all" || !options.host ? ["claude", "codex"] : [options.host];
	const repoRoot = await findRepoRoot(options.cwd);
	const ctx = { cwd: options.cwd, home, repoRoot };

	const sources: ConventionSkillImportSource[] = [];
	const seen = new Set<string>();
	for (const host of hosts) {
		const scan = host === "claude" ? scanClaudeSkills : scanCodexSkills;
		const results = await scan(ctx);
		for (const skill of results.items) {
			const key = `${host}:${skill.level}:${skill.name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			sources.push({
				host,
				scope: skill.level,
				name: skill.name,
				description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : "",
				path: skill.path,
			});
		}
	}
	sources.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
	return sources;
}

async function scanClaudeSkills(ctx: { cwd: string; home: string; repoRoot: string | null }) {
	const project = await scanClaudeProjectSkills(ctx);
	const user = await scanClaudeUserSkills(ctx);
	return { items: [...project.items, ...user.items] };
}

async function scanCodexSkills(ctx: { cwd: string; home: string; repoRoot: string | null }) {
	const project = await scanCodexProjectSkills(ctx);
	const user = await scanCodexUserSkills(ctx);
	return { items: [...project.items, ...user.items] };
}

async function safeRealpath(filePath: string): Promise<string> {
	try {
		return await fs.realpath(filePath);
	} catch {
		return filePath;
	}
}
