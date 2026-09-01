import * as fs from "node:fs/promises";
import { getProjectDir, getTrustedHomeDir } from "@gajae-code/utils";
import { loadCapabilityForHome, resolveProfileAuthority } from "../capability";
import { skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { Settings, SkillsSettings } from "../config/settings";
import { resolveSkillScopeTrust } from "../config/skill-settings-defaults";
import { type Skill as CapabilitySkill, loadCapability } from "../discovery";
import { compareSkillOrder, resolveUserAgentDir, scanSkillsFromDir } from "../discovery/helpers";
import type { SkillPromptDetails } from "../session/messages";
import { CANONICAL_GJC_WORKFLOW_SKILLS } from "../skill-state/canonical-skills";
import { expandTilde } from "../tools/path-utils";
import type { LoadedSubskillActivation } from "./gjc-plugins";
import { buildSubskillInjection } from "./gjc-plugins/injection";
import { renderSkillAdvertisement } from "./gjc-plugins/runtime-adapters";
/** Metadata-only handle returned by bounded skill discovery. */
export interface SkillDescriptor {
	readonly metadata: Omit<Skill, "content" | "loadContent">;
	readonly loadContent: () => Promise<string>;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	/**
	 * When `true`, the skill is loaded and reachable via `skill://<name>` and
	 * skill slash aliases, but is excluded from the rendered system prompt's
	 * `<skills>` listing.
	 */
	hide?: boolean;
	/** Source metadata for display */
	_source?: SourceMeta;
	/** Embedded SKILL.md content for bundled defaults that survive .gjc deletion. */
	/** Lazily load the full skill body when prompt injection needs it. */
	loadContent?: () => Promise<string>;
	content?: string;
}

export interface SkillWarning {
	skillPath: string;
	message: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
}

let activeSkills: readonly Skill[] = [];

/**
 * Process-global snapshot of skills the active session loaded.
 * Read by internal URL protocol handlers (skill://).
 */
export function getActiveSkills(): readonly Skill[] {
	return activeSkills;
}

/** Replace the active skill snapshot. Called once per top-level session. */
export function setActiveSkills(value: readonly Skill[]): void {
	activeSkills = value;
}

/** Reset the active skill snapshot. Test-only. */
export function resetActiveSkillsForTests(): void {
	activeSkills = [];
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

export async function loadSkillsFromDir(options: LoadSkillsFromDirOptions): Promise<LoadSkillsResult> {
	const home = getTrustedHomeDir();
	const [rawProviderId, rawLevel] = options.source.split(":", 2);
	const providerId = rawProviderId || "custom";
	const level: "user" | "project" = rawLevel === "project" ? "project" : "user";
	const result = await scanSkillsFromDir(
		{ cwd: getProjectDir(), home, repoRoot: null },
		{
			dir: options.dir,
			providerId,
			level,
			requireDescription: true,
		},
	);

	return {
		skills: result.items.map(capSkill => ({
			name: capSkill.name,
			description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
			filePath: capSkill.path,
			baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
			loadContent: capSkill.loadContent,
			source: options.source,
			hide: capSkill.frontmatter?.hide === true,
			_source: capSkill._source,
		})),
		warnings: (result.warnings ?? []).map(message => ({ skillPath: options.dir, message })),
	};
}

export interface LoadSkillsOptions extends SkillsSettings {
	/** Working directory for project-local skills. Default: getProjectDir() */
	cwd?: string;
	/** Explicit user home for SDK/test skill discovery. Default: trusted runtime home. */
	home?: string;
	/** Agent directory backing native user-scope skills. Default: getAgentDir() */
	agentDir?: string;
	/** Settings authority for session-scoped capability discovery. */
	settings?: Settings;
	/** Resolver-owned profile classification, stable across HOME refreshes. */
	profileAuthority?: "default" | "custom";
}

/**
 * Skill providers loaded into sessions. Only native `.gjc` skills are live
 * filesystem skills; Claude/Codex convention skills are explicit import
 * sources into `.gjc` (see skill-management.ts) and are never loaded directly.
 */
const LOADABLE_SKILL_PROVIDERS = new Set(["native"]);

const BUILT_IN_SKILL_NAMES = new Set<string>(CANONICAL_GJC_WORKFLOW_SKILLS.map(name => name.toLowerCase()));

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		home,
		agentDir,
		enabled = true,
		customDirectories = [],
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
		settings,
		profileAuthority,
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
	}

	const projectTrusted = resolveSkillScopeTrust(options, "project");
	const userTrusted = resolveSkillScopeTrust(options, "user");
	const resolvedHome = home ?? getTrustedHomeDir();

	// Skill scope trust decides which canonical locations are loaded: project
	// scope covers `.gjc/skills` (walk-up), user scope covers the agent
	// directory's `skills` root (`gjc config path`) and the legacy home-relative
	// user roots. Claude/Codex convention skills are import
	// sources into `.gjc`, never loaded directly.
	function isSourceEnabled(source: SourceMeta): boolean {
		const { provider, level } = source;
		if (!LOADABLE_SKILL_PROVIDERS.has(provider)) return false;
		if (level === "user") return userTrusted;
		if (level === "project") return projectTrusted;
		return false;
	}

	// Use capability API to load all skills. `all` (rather than `items`) keeps
	// shadowed duplicates so this function can apply the documented precedence
	// itself: project scope beats user scope.
	const selectedAgentDir =
		agentDir ?? settings?.getAgentDir() ?? (home === undefined ? undefined : resolveUserAgentDir(resolvedHome));
	const loadOptions = {
		cwd,
		// Settings owns the selected profile when no explicit agent directory was
		// supplied. Only fall back to the injected home after both authorities are
		// absent; otherwise policy and files can come from different profiles.
		agentDir: selectedAgentDir,
		providers: ["native"],
		disabledExtensions,
		settings,
		profileAuthority: resolveProfileAuthority(
			{
				agentDir: selectedAgentDir,
				settings,
				profileAuthority,
			},
			resolvedHome,
			home === undefined ? undefined : "default",
		),
	};
	const result = await (home === undefined
		? loadCapability<CapabilitySkill>(skillCapability.id, loadOptions)
		: loadCapabilityForHome<CapabilitySkill>(skillCapability.id, resolvedHome, loadOptions));

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const collisionWarnings: SkillWarning[] = [];

	// Check if skill name matches any of the include patterns
	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	// Check if skill name matches any of the ignore patterns
	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some(pattern => new Bun.Glob(pattern).match(name));
	}

	const disabledSkillNames = new Set(
		(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice(6)),
	);

	// Apply scope trust and policy filters, then order candidates by documented
	// precedence. `all` is already in native provider order with project dirs
	// before user dirs; a stable sort by level lifts every project item above
	// every user item, giving: project `.gjc/skills` > user roots.
	const filteredSkills = result.all
		.filter(capSkill => {
			if (!isSourceEnabled(capSkill._source)) return false;
			if (disabledSkillNames.has(capSkill.name)) return false;
			if (matchesIgnorePatterns(capSkill.name)) return false;
			if (!matchesIncludePatterns(capSkill.name)) return false;
			return true;
		})
		.sort((a, b) => {
			const levelOrder = { project: 0, user: 1 } as const;
			return levelOrder[a.level] - levelOrder[b.level];
		});

	// Batch resolve all real paths in parallel
	const realPaths = await Promise.all(
		filteredSkills.map(async capSkill => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	// Process skills with resolved paths
	for (let i = 0; i < filteredSkills.length; i++) {
		const capSkill = filteredSkills[i];
		const resolvedPath = realPaths[i];

		// Skip silently if we've already loaded this exact file (via symlink)
		if (realPathSet.has(resolvedPath)) {
			continue;
		}

		// A project-controlled copy of a bundled workflow skill name is a potential
		// workflow-routing hijack: warn, and let the session merge keep the bundled
		// definition authoritative (sdk/session.ts). User-scope copies are not
		// warned about: installed defaults legitimately mirror bundled skills.
		if (capSkill.level === "project" && BUILT_IN_SKILL_NAMES.has(capSkill.name.toLowerCase())) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" is a bundled GJC workflow skill; the bundled definition takes precedence in sessions and this project copy is never used`,
			});
		}

		const skillKey = capSkill.name.toLowerCase();
		const existing = skillMap.get(skillKey);
		if (existing) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			skillMap.set(skillKey, {
				name: capSkill.name,
				description: typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
				filePath: capSkill.path,
				baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
				loadContent: capSkill.loadContent,
				source: `${capSkill._source.provider}:${capSkill.level}`,
				hide: capSkill.frontmatter?.hide === true,
				_source: capSkill._source,
			});
			realPathSet.add(resolvedPath);
		}
	}

	const customDirectoryResults = await Promise.all(
		customDirectories.map(async dir => {
			const expandedDir = expandTilde(dir, resolvedHome);
			const scanResult = await scanSkillsFromDir(
				{ cwd, home: resolvedHome, repoRoot: null },
				{
					dir: expandedDir,
					providerId: "custom",
					level: "user",
					requireDescription: true,
				},
			);
			return { expandedDir, scanResult };
		}),
	);

	const allCustomSkills: Array<{ skill: Skill; path: string }> = [];
	for (const { expandedDir, scanResult } of customDirectoryResults) {
		for (const capSkill of scanResult.items) {
			if (disabledSkillNames.has(capSkill.name)) continue;
			if (matchesIgnorePatterns(capSkill.name)) continue;
			if (!matchesIncludePatterns(capSkill.name)) continue;
			allCustomSkills.push({
				skill: {
					name: capSkill.name,
					description:
						typeof capSkill.frontmatter?.description === "string" ? capSkill.frontmatter.description : "",
					filePath: capSkill.path,
					baseDir: capSkill.path.replace(/[\\/]SKILL\.md$/, ""),
					loadContent: capSkill.loadContent,
					source: "custom:user",
					hide: capSkill.frontmatter?.hide === true,
					_source: { ...capSkill._source, providerName: "Custom" },
				},
				path: capSkill.path,
			});
		}
		collisionWarnings.push(...(scanResult.warnings ?? []).map(message => ({ skillPath: expandedDir, message })));
	}

	const customRealPaths = await Promise.all(
		allCustomSkills.map(async ({ path }) => {
			try {
				return await fs.realpath(path);
			} catch {
				return path;
			}
		}),
	);

	for (let i = 0; i < allCustomSkills.length; i++) {
		const { skill } = allCustomSkills[i];
		const resolvedPath = customRealPaths[i];
		if (realPathSet.has(resolvedPath)) continue;

		const skillKey = skill.name.toLowerCase();
		const existing = skillMap.get(skillKey);
		if (existing) {
			collisionWarnings.push({
				skillPath: skill.filePath,
				message: `name collision: "${skill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			skillMap.set(skillKey, skill);
			realPathSet.add(resolvedPath);
		}
	}

	const skills = Array.from(skillMap.values());
	// Deterministic ordering for prompt stability (case-insensitive, then exact name, then path).
	skills.sort((a, b) => compareSkillOrder(a.name, a.filePath, b.name, b.filePath));

	return {
		skills,
		warnings: [...(result.warnings ?? []).map(w => ({ skillPath: "", message: w })), ...collisionWarnings],
	};
}

export interface BuiltSkillPromptMessage {
	message: string;
	details: SkillPromptDetails;
}

export interface BuildSkillPromptMessageContext {
	subskillActivation?: LoadedSubskillActivation;
	subskillActivationSet?: LoadedSubskillActivation[];
	currentPhase?: string;
	cwd?: string;
	agentDir?: string;
	profileAuthority?: "default" | "custom";
	sessionId?: string;
}

export function getSkillSlashCommandName(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

export function isNamespacedSkillSlashCommandName(commandName: string): boolean {
	return commandName.toLowerCase().startsWith("skill:");
}

export function getSkillSlashCommandNames(skill: Pick<Skill, "name">): string[] {
	return [getSkillSlashCommandName(skill)];
}

export function isSkillSlashCommandName(commandName: string, skill: Pick<Skill, "name">): boolean {
	return commandName.toLowerCase() === getSkillSlashCommandName(skill).toLowerCase();
}

export interface ResolvedSkillSlashCommand {
	name: string;
	description: string;
	skill: Skill;
}

export interface ParsedSkillInvocation {
	commandName: string;
	args: string;
	skill: Skill;
}

interface SkillTokenMatch {
	index: number;
	end: number;
	commandName: string;
	skill: Skill;
}

function buildInlineSkillInvocationArgs(text: string, matches: readonly SkillTokenMatch[]): string {
	const pieces: string[] = [];
	let cursor = 0;
	for (const match of matches) {
		pieces.push(text.slice(cursor, match.index));
		cursor = match.end;
	}
	pieces.push(text.slice(cursor));
	return pieces
		.join("")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.trim();
}

export function parseSkillInvocations(
	text: string,
	skillsByCommandName: ReadonlyMap<string, Skill>,
): ParsedSkillInvocation[] {
	const trimmedText = text.trim();
	if (!trimmedText) return [];
	const normalizedSkillsByCommandName = new Map<string, Skill>();
	for (const [commandName, skill] of skillsByCommandName) {
		const normalizedCommandName = commandName.toLowerCase();
		if (!normalizedSkillsByCommandName.has(normalizedCommandName)) {
			normalizedSkillsByCommandName.set(normalizedCommandName, skill);
		}
	}
	const canonicalSkillCommandPattern = /(^|\s)\/(skill:[^\s]+)/gi;
	const matches: SkillTokenMatch[] = [];
	for (const match of trimmedText.matchAll(canonicalSkillCommandPattern)) {
		const commandName = match[2];
		if (!commandName) continue;
		const skill = normalizedSkillsByCommandName.get(commandName.toLowerCase());
		if (!skill) continue;
		const leading = match[1] ?? "";
		const index = (match.index ?? 0) + leading.length;
		matches.push({
			index,
			end: index + commandName.length + 1,
			commandName,
			skill,
		});
	}
	if (matches.length === 0) return [];
	if (matches[0]?.index !== 0) {
		// Preserve leading slash-command semantics: `/skill:unknown /skill:alpha`
		// should remain plain text rather than silently skipping the unknown
		// leading command and invoking the later known one.
		if (trimmedText.startsWith("/")) return [];
		const args = buildInlineSkillInvocationArgs(trimmedText, matches);
		return matches.map(match => ({
			commandName: match.commandName,
			args,
			skill: match.skill,
		}));
	}
	return matches.map((match, index) => {
		const next = matches[index + 1];
		return {
			commandName: match.commandName,
			args: trimmedText.slice(match.end, next?.index).trim(),
			skill: match.skill,
		};
	});
}

export function resolveSkillSlashCommands(
	skills: readonly Skill[],
	_reservedDirectCommandNames: ReadonlySet<string>,
): ResolvedSkillSlashCommand[] {
	const commands: ResolvedSkillSlashCommand[] = [];
	const claimedNames = new Set<string>();
	for (const skill of skills) {
		if (skill.hide === true) continue;
		for (const name of getSkillSlashCommandNames(skill)) {
			const normalizedName = name.toLowerCase();
			if (claimedNames.has(normalizedName)) {
				continue;
			}
			claimedNames.add(normalizedName);
			commands.push({ name, description: skill.description, skill });
		}
	}
	return commands;
}

export async function buildSkillPromptMessage(
	skill: Pick<Skill, "name" | "filePath" | "content" | "loadContent">,
	args: string,
	context?: BuildSkillPromptMessageContext,
): Promise<BuiltSkillPromptMessage> {
	const content = skill.loadContent
		? await skill.loadContent()
		: typeof skill.content === "string"
			? skill.content
			: await Bun.file(skill.filePath).text();
	const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
	const metaLines = [`Skill: ${skill.filePath}`];
	const trimmedArgs = args.trim();
	if (trimmedArgs) {
		metaLines.push(`User: ${trimmedArgs}`);
	}
	let message = `${body}\n\n---\n\n${metaLines.join("\n")}`;
	const details: SkillPromptDetails = {
		name: skill.name,
		path: skill.filePath,
		args: trimmedArgs || undefined,
		lineCount: body ? body.split("\n").length : 0,
	};
	if (context?.subskillActivationSet) {
		details.subskillActivationSet = context.subskillActivationSet;
	}
	if (context) {
		const injection = context.cwd
			? await buildSubskillInjection({
					cwd: context.cwd,
					agentDir: context.agentDir,
					profileAuthority: context.profileAuthority,
					sessionId: context.sessionId,
					skillName: skill.name,
					activation: context.subskillActivation,
					currentPhase: context.currentPhase,
				})
			: null;
		if (injection) {
			message += injection.block;
			details.subskillActivation = injection.details ?? context.subskillActivation;
		} else if (context.subskillActivation) {
			details.subskillActivation = context.subskillActivation;
		}
		// Tier-1 advertisement: metadata-only list of installed sub-skills bound to
		// this parent skill, so the agent can choose one contextually.
		if (context.cwd) {
			try {
				const advert = await renderSkillAdvertisement({
					cwd: context.cwd,
					agentDir: context.agentDir,
					skillName: skill.name,
					phase: context.currentPhase,
				});
				if (advert) message += `\n\n${advert}`;
			} catch {
				// Advertisement is best-effort; never block skill prompt construction.
			}
		}
	}
	return {
		message,
		details,
	};
}
