import * as fs from "node:fs/promises";
import {
	getAgentDir,
	getAgentProfileAuthority,
	getProjectDir,
	getTrustedHomeDir,
	normalizePathForComparison,
} from "@gajae-code/utils";
import { findRepoRoot } from "../capability/fs";
import { skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { resolveSkillScopeTrust } from "../config/skill-settings-defaults";
import { type Skill as CapabilitySkill, getCapability } from "../discovery";
import { loadMarketplaceSkills } from "../discovery/claude-plugins";
import { compareSkillOrder, resolveUserAgentDir, scanSkillsFromDir } from "../discovery/helpers";
import type { SkillPromptDetails } from "../session/messages";
import {
	getSkillFilesystemIdentity,
	isCanonicalGjcWorkflowSkillFilesystemAlias,
} from "../skill-state/canonical-skills";
import { wrapUntrustedContent } from "../tools/fetch";
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
	/** Explicit user home for skill discovery. Default: getTrustedHomeDir(). */
	home?: string;
	/** Explicit user agent directory for native user-scope skill discovery. */
	agentDir?: string;
	/** Resolver-owned classification for the selected agent directory. */
	profileAuthority?: "default" | "custom";
	/** User-owned permission to follow symlinks outside user skill scan roots. */
	allowExternalUserSkillSymlinks?: boolean;
}

/**
 * Skill providers loaded into sessions. Native `.gjc` skills and installed
 * marketplace plugin skills are both live filesystem skills, so both are
 * enumerated into sessions; Claude/Codex convention skills are explicit import
 * sources into `.gjc` (see skill-management.ts) and are never loaded directly.
 */
const LOADABLE_SKILL_PROVIDERS = new Set(["native", "claude-plugins"]);

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<LoadSkillsResult> {
	const {
		cwd = getProjectDir(),
		enabled = true,
		customDirectories = [],
		ignoredSkills = [],
		includeSkills = [],
		disabledExtensions = [],
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
	}
	const homeWasInjected = options.home !== undefined;
	const home = options.home ?? getTrustedHomeDir();
	const agentDir = options.agentDir ?? (homeWasInjected ? resolveUserAgentDir(home) : getAgentDir());
	const profileAuthority =
		options.profileAuthority ??
		(!homeWasInjected
			? options.agentDir !== undefined &&
				normalizePathForComparison(options.agentDir) !== normalizePathForComparison(getAgentDir())
				? "custom"
				: getAgentProfileAuthority()
			: undefined);

	const projectTrusted = resolveSkillScopeTrust(options, "project");
	const userTrusted = resolveSkillScopeTrust(options, "user");
	const allowExternalUserSkillSymlinks = options.allowExternalUserSkillSymlinks ?? userTrusted;

	// Skill scope trust decides which canonical locations are loaded: project
	// scope covers `.gjc/skills` (walk-up), user scope covers `~/.gjc/agent/skills`
	// and the legacy user roots, and installed marketplace plugins are gated by the
	// scope they were installed into. Claude/Codex convention skills are import
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
	const providers =
		getCapability<CapabilitySkill>(skillCapability.id)?.providers.filter(provider =>
			LOADABLE_SKILL_PROVIDERS.has(provider.id),
		) ?? [];
	if (!providers.some(provider => provider.id === "native")) {
		throw new Error("Native skill provider is unavailable");
	}
	const loadContext = {
		cwd,
		home,
		userAgentDir: agentDir,
		profileAuthority,
		repoRoot: await findRepoRoot(cwd),
		allowExternalUserSkillSymlinks,
	};
	const providerResults = await Promise.all(
		providers.map(async provider => {
			const allowedLevels = new Set<"user" | "project">();
			if (projectTrusted) allowedLevels.add("project");
			if (userTrusted) allowedLevels.add("user");
			return {
				provider,
				result:
					provider.id === "claude-plugins"
						? await loadMarketplaceSkills(loadContext, allowedLevels)
						: await provider.load(loadContext),
			};
		}),
	);

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
	const filteredSkills = providerResults
		.flatMap(({ provider, result }) =>
			result.items.map(capSkill => ({ capSkill, providerPriority: provider.priority })),
		)
		.filter(({ capSkill }) => {
			if (!isSourceEnabled(capSkill._source)) return false;
			if (disabledSkillNames.has(capSkill.name)) return false;
			if (matchesIgnorePatterns(capSkill.name)) return false;
			if (!matchesIncludePatterns(capSkill.name)) return false;
			return true;
		})
		.sort((a, b) => {
			const levelOrder = { project: 0, user: 1 } as const;
			return levelOrder[a.capSkill.level] - levelOrder[b.capSkill.level] || b.providerPriority - a.providerPriority;
		});

	// Batch resolve all real paths in parallel
	const realPaths = await Promise.all(
		filteredSkills.map(async ({ capSkill }) => {
			try {
				return await fs.realpath(capSkill.path);
			} catch {
				return capSkill.path;
			}
		}),
	);

	// Process skills with resolved paths
	for (let i = 0; i < filteredSkills.length; i++) {
		const { capSkill } = filteredSkills[i];
		const resolvedPath = realPaths[i];

		// Skip silently if we've already loaded this exact file (via symlink)
		if (realPathSet.has(resolvedPath)) {
			continue;
		}

		// A project-controlled copy of a bundled workflow skill name is a potential
		// workflow-routing hijack: warn, and let the session merge keep the bundled
		// definition authoritative (sdk/session.ts). User-scope copies are not
		// warned about: installed defaults legitimately mirror bundled skills.
		if (capSkill.level === "project" && isCanonicalGjcWorkflowSkillFilesystemAlias(capSkill.name)) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" is a bundled GJC workflow skill; the bundled definition takes precedence in sessions and this project copy is never used`,
			});
		}

		const skillKey = getSkillFilesystemIdentity(capSkill.name);
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
			const expandedDir = expandTilde(dir, home);
			const scanResult = await scanSkillsFromDir(
				{ cwd, home, repoRoot: null, allowExternalUserSkillSymlinks },
				{
					dir: expandedDir,
					providerId: "custom",
					level: "user",
					requireDescription: true,
					allowExternalUserSkillSymlinks,
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

		const skillKey = getSkillFilesystemIdentity(skill.name);
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
		warnings: [
			...providerResults.flatMap(({ result }) =>
				(result.warnings ?? []).map(message => ({ skillPath: "", message })),
			),
			...collisionWarnings,
		],
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

export interface ParsedSkillInvocation<TSkill extends Pick<Skill, "name"> = Skill> {
	commandName: string;
	args: string;
	skill: TSkill;
}

interface SkillTokenMatch<TSkill extends Pick<Skill, "name"> = Skill> {
	index: number;
	end: number;
	commandName: string;
	skill: TSkill;
}

function buildInlineSkillInvocationArgs<TSkill extends Pick<Skill, "name">>(
	text: string,
	matches: readonly SkillTokenMatch<TSkill>[],
): string {
	const pieces: string[] = [];
	let cursor = 0;
	for (const match of matches) {
		let prefix = text.slice(cursor, match.index);
		// Removing the token joins the whitespace on each side. Drop only one
		// adjacent ASCII space when that join would otherwise double a separator;
		// preserve all other spacing, including indentation and repeated spaces.
		if (prefix.endsWith(" ") && text[match.end] === " ") prefix = prefix.slice(0, -1);
		pieces.push(prefix);
		cursor = match.end;
	}
	pieces.push(text.slice(cursor));
	return pieces.join("");
}

export function parseSkillInvocations<TSkill extends Pick<Skill, "name">>(
	text: string,
	skillsByCommandName: ReadonlyMap<string, TSkill>,
): ParsedSkillInvocation<TSkill>[] {
	const leadingWhitespaceLength = text.length - text.trimStart().length;
	const trimmedText = text.trim();
	if (!trimmedText) return [];
	const normalizedSkillsByCommandName = new Map<string, TSkill>();
	for (const [commandName, skill] of skillsByCommandName) {
		const normalizedCommandName = commandName.toLowerCase();
		if (!normalizedSkillsByCommandName.has(normalizedCommandName)) {
			normalizedSkillsByCommandName.set(normalizedCommandName, skill);
		}
	}
	const canonicalSkillCommandPattern = /(^|\s)\/(skill:[^\s]+)/gi;
	const matches: SkillTokenMatch<TSkill>[] = [];
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
		const rawMatches = matches.map(match => ({
			...match,
			index: match.index + leadingWhitespaceLength,
			end: match.end + leadingWhitespaceLength,
		}));
		const args = buildInlineSkillInvocationArgs(text, rawMatches);
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

/** Same character cap as session persistence, so a fenced skill prompt is not cut later. */
const SKILL_PROMPT_PERSIST_CAP = 500_000;
const SKILL_FENCE_OPEN = "<untrusted-content>\n";
const SKILL_FENCE_CLOSE = "\n</untrusted-content>";
const SKILL_FENCE_OVERHEAD = SKILL_FENCE_OPEN.length + SKILL_FENCE_CLOSE.length;
/** Replacement produced by `escapeUntrustedContent` for both closer forms. */
const ESCAPED_CLOSER = "&lt;/untrusted-content>";
const CLOSER_PREFIX = "</untrusted-content";

function sliceSkillHead(value: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	if (value.length <= maxLength) return value;
	let truncated = value.slice(0, maxLength);
	const last = truncated.charCodeAt(truncated.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) truncated = truncated.slice(0, -1);
	return truncated;
}

function isCloserWhitespace(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function sameCloserChar(actual: number, expected: number): boolean {
	if (actual === expected) return true;
	return actual >= 0x41 && actual <= 0x5a && actual + 0x20 === expected;
}

/** Raw length of a closer at `index`, or 0. Reads the source; does not copy it. */
function measureCloser(value: string, index: number): number {
	const prefix = CLOSER_PREFIX.length;
	if (index + prefix >= value.length) return 0;
	for (let i = 0; i < prefix; i++) {
		if (!sameCloserChar(value.charCodeAt(index + i), CLOSER_PREFIX.charCodeAt(i))) return 0;
	}
	let cursor = index + prefix;
	const first = value.charCodeAt(cursor);
	if (first === 0x3e) return prefix + 1;
	if (!isCloserWhitespace(first)) return 0;
	cursor += 1;
	while (cursor < value.length && isCloserWhitespace(value.charCodeAt(cursor))) cursor += 1;
	if (cursor < value.length && value.charCodeAt(cursor) === 0x3e) return cursor + 1 - index;
	return 0;
}

/**
 * One forward scan. Stops once the escaped form would pass `budget`.
 * Closers are charged at their escaped size so the later wrap cannot grow the text.
 */
function boundSkillBody(body: string, budget: number): { text: string; consumedAll: boolean } {
	if (budget <= 0 || body.length === 0) return { text: "", consumedAll: body.length === 0 };
	const parts: string[] = [];
	let used = 0;
	let index = 0;
	while (index < body.length && used < budget) {
		const closer = body.charCodeAt(index) === 0x3c ? measureCloser(body, index) : 0;
		if (closer > 0) {
			if (used + ESCAPED_CLOSER.length > budget) break;
			parts.push(ESCAPED_CLOSER);
			used += ESCAPED_CLOSER.length;
			index += closer;
			continue;
		}
		const start = index;
		let end = index;
		while (end < body.length) {
			const room = budget - used - (end - start);
			if (room <= 0) break;
			if (body.charCodeAt(end) === 0x3c && measureCloser(body, end) > 0) break;
			const code = body.charCodeAt(end);
			if (code >= 0xd800 && code <= 0xdbff) {
				const low = end + 1 < body.length ? body.charCodeAt(end + 1) : 0;
				if (low >= 0xdc00 && low <= 0xdfff) {
					if (room < 2) break;
					end += 2;
					continue;
				}
			}
			end += 1;
		}
		if (end === start) break;
		parts.push(body.slice(start, end));
		used += end - start;
		index = end;
	}
	return { text: parts.join(""), consumedAll: index >= body.length };
}

/**
 * Reserve the fence inside `cap`, then keep the body and host suffix.
 * The attacker-sized body is bounded before `wrapUntrustedContent` runs once.
 */
export function frameSkillPromptWithinCap(
	body: string,
	suffix: string,
	cap = SKILL_PROMPT_PERSIST_CAP,
): { message: string; retained: string } {
	const payload = Math.max(0, cap - SKILL_FENCE_OVERHEAD);
	const whole = boundSkillBody(body, payload);
	let bounded = whole.text;
	let suffixKept = suffix;
	if (whole.consumedAll) {
		suffixKept = sliceSkillHead(suffix, payload - bounded.length);
	} else if (suffix.length <= payload) {
		bounded = boundSkillBody(body, payload - suffix.length).text;
		suffixKept = suffix;
	} else {
		suffixKept = sliceSkillHead(suffix, Math.floor(payload / 2));
		bounded = boundSkillBody(body, payload - suffixKept.length).text;
	}
	return { message: `${wrapUntrustedContent(bounded)}${suffixKept}`, retained: bounded };
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
	let suffix = `\n\n---\n\n${metaLines.join("\n")}`;
	const details: SkillPromptDetails = {
		name: skill.name,
		path: skill.filePath,
		args: trimmedArgs || undefined,
		lineCount: 0,
	};
	if (context?.subskillActivationSet) {
		details.subskillActivationSet = context.subskillActivationSet;
	}
	if (context) {
		const injection = context.cwd
			? await buildSubskillInjection({
					cwd: context.cwd,
					sessionId: context.sessionId,
					skillName: skill.name,
					activation: context.subskillActivation,
					currentPhase: context.currentPhase,
				})
			: null;
		if (injection) {
			suffix += injection.block;
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
					skillName: skill.name,
					phase: context.currentPhase,
				});
				if (advert) suffix += `\n\n${advert}`;
			} catch {
				// Advertisement is best-effort; never block skill prompt construction.
			}
		}
	}
	// Bound the body and suffix inside the persistence cap, then fence once.
	const framed = frameSkillPromptWithinCap(body, suffix);
	details.lineCount = framed.retained ? framed.retained.split("\n").length : 0;
	return {
		message: framed.message,
		details,
	};
}
