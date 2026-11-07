import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getTrustedHomeDir, isEnoent } from "@gajae-code/utils";
import { findRepoRoot } from "../capability/fs";
import { getActiveRules } from "../capability/rule";
import type { Skill } from "../extensibility/skills";
import {
	initializeLocalRoot,
	type LocalProtocolOptions,
	resolveLocalRoot,
	resolveLocalUrlToPath,
} from "../internal-urls/local-protocol";
import { validateRelativePath } from "../internal-urls/skill-protocol";
import type { InternalResource } from "../internal-urls/types";
import { normalizeLocalScheme } from "./path-utils";
import { ToolError } from "./tool-errors";

/** Regex to find skill:// tokens in command text. */
const SKILL_URL_PATTERN = /'skill:\/\/[^'\s")`\\]+'|"skill:\/\/[^"\s')`\\]+"|skill:\/\/[^\s'")`\\]+/g;

const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^\s'")`\\]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\]+/g;

const SUPPORTED_INTERNAL_SCHEMES = ["skill", "agent", "artifact", "plan", "memory", "rule", "local"] as const;

type SupportedInternalScheme = (typeof SUPPORTED_INTERNAL_SCHEMES)[number];

interface InternalUrlResolver {
	canHandle(input: string): boolean;
	resolve(input: string): Promise<InternalResource>;
}

export interface InternalUrlExpansionOptions {
	skills: readonly Skill[];
	noEscape?: boolean;
	internalRouter?: InternalUrlResolver;
	localOptions?: LocalProtocolOptions;
	ensureLocalParentDirs?: boolean;
	/** Project directory of the bash session. `rule://` must stay inside its boundary. */
	sessionCwd?: string;
	/** Agent directory for this session. User rules use it. */
	sessionAgentDir?: string;
}

/**
 * Resolve a single skill:// URL to its absolute filesystem path.
 * Does NOT read file content or verify existence.
 */
export function resolveSkillUrl(url: string, skills: readonly Skill[]): { skill: Skill; lexicalPath: string } {
	const parsed = /^skill:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
	if (!parsed) {
		throw new ToolError(`Invalid skill:// URL: ${url}`);
	}

	let rawSkillSegment = parsed[1];
	if (!rawSkillSegment) {
		throw new ToolError(`skill:// URL requires a skill name: ${url}`);
	}
	// Decode percent-encoded colons (%3A) used for namespaced skill names
	try {
		rawSkillSegment = decodeURIComponent(rawSkillSegment);
	} catch {
		// Leave as-is if decoding fails
	}

	// Resolve skill name by longest-prefix match against registered skills.
	// This handles namespaced skills ("plugin:skill") where the URI may also
	// carry a colon-delimited suffix (e.g., ":1-5" line range).
	const { skill, suffix } = matchSkillName(rawSkillSegment, skills);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new ToolError(`Unknown skill: ${rawSkillSegment}. Available: ${availableStr}`);
	}

	// Combine any colon suffix (line range like ":1-5") with the path segment
	const rawPath = (parsed[2] ?? "") + (suffix ? `/${suffix}` : "");
	const hasRelativePath = rawPath !== "" && rawPath !== "/";

	if (!hasRelativePath) {
		return { skill, lexicalPath: path.resolve(skill.filePath) };
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPath.slice(1));
	} catch {
		throw new ToolError(`Invalid skill:// URL path encoding: ${url}`);
	}
	try {
		validateRelativePath(relativePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ToolError(message);
	}

	const targetPath = path.join(skill.baseDir, relativePath);
	const resolvedPath = path.resolve(targetPath);
	const resolvedBaseDir = path.resolve(skill.baseDir);
	if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
		throw new ToolError("Path traversal is not allowed in skill:// URLs");
	}

	return { skill, lexicalPath: resolvedPath };
}

export function resolveSkillUrlToPath(url: string, skills: readonly Skill[]): string {
	return resolveSkillUrl(url, skills).lexicalPath;
}

/**
 * Match a raw skill segment against registered skills using longest-prefix match.
 * Handles colons in both skill names (namespacing) and suffixes (line ranges).
 *
 * For "superpowers:brainstorming:1-5" with skill "superpowers:brainstorming":
 *   -> skill = superpowers:brainstorming, suffix = "1-5"
 * For "brainstorming" with skill "brainstorming":
 *   -> skill = brainstorming, suffix = undefined
 */
function matchSkillName(
	rawSegment: string,
	skills: readonly Skill[],
): { skill: Skill | undefined; suffix: string | undefined } {
	// Exact match first (most common case)
	const exact = skills.find(s => s.name === rawSegment);
	if (exact) return { skill: exact, suffix: undefined };

	// Try stripping colon-delimited suffixes from the right
	let candidate = rawSegment;
	while (true) {
		const lastColon = candidate.lastIndexOf(":");
		if (lastColon <= 0) break;
		candidate = candidate.slice(0, lastColon);
		const match = skills.find(s => s.name === candidate);
		if (match) {
			const suffix = rawSegment.slice(lastColon + 1);
			return { skill: match, suffix };
		}
	}

	return { skill: undefined, suffix: undefined };
}

function localPathEscapes(realRoot: string, candidate: string): boolean {
	return candidate !== realRoot && !candidate.startsWith(`${realRoot}${path.sep}`);
}

async function canonicalLocalPath(localRoot: string, lexicalPath: string): Promise<string> {
	const realRoot = await fs.realpath(localRoot);
	try {
		const realTarget = await fs.realpath(lexicalPath);
		if (localPathEscapes(realRoot, realTarget)) {
			throw new ToolError("local:// path escapes the session local root");
		}
		return realTarget;
	} catch (error) {
		if (error instanceof ToolError || !isEnoent(error)) throw error;
	}

	const missing: string[] = [];
	let cursor = lexicalPath;
	for (;;) {
		let stat: fsTypes.Stats | undefined;
		try {
			stat = await fs.lstat(cursor);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (stat) {
			let realAncestor: string;
			try {
				realAncestor = await fs.realpath(cursor);
			} catch (error) {
				if (isEnoent(error)) throw new ToolError("local:// path escapes the session local root");
				throw error;
			}
			const canonical = path.join(realAncestor, ...missing);
			if (localPathEscapes(realRoot, canonical)) {
				throw new ToolError("local:// path escapes the session local root");
			}
			return canonical;
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new ToolError("local:// path escapes the session local root");
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

const SKILL_ESCAPE = "Path traversal is not allowed in skill:// URLs";

/** Real path of `target`, or the real ancestor plus the missing suffix. */
async function canonicalPathOrAncestor(target: string, escapeMessage: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const missing: string[] = [];
	let cursor = target;
	for (;;) {
		let stat: fsTypes.Stats | undefined;
		try {
			stat = await fs.lstat(cursor);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (stat) {
			try {
				return path.join(await fs.realpath(cursor), ...missing);
			} catch (error) {
				if (isEnoent(error)) throw new ToolError(escapeMessage);
				throw error;
			}
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new ToolError(escapeMessage);
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}

/**
 * Keep the lexical skill path, then bind the shell to the real path inside the skill directory.
 * A missing file under a real in-skill ancestor still expands.
 */
async function canonicalSkillExpansionPath(baseDir: string, lexicalPath: string): Promise<string> {
	const realBase = await canonicalPathOrAncestor(baseDir, SKILL_ESCAPE);
	const realTarget = await canonicalPathOrAncestor(lexicalPath, SKILL_ESCAPE);
	if (localPathEscapes(realBase, realTarget)) {
		throw new ToolError(SKILL_ESCAPE);
	}
	return realTarget;
}

function extractScheme(url: string): SupportedInternalScheme | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (!match) return undefined;
	const scheme = match[1].toLowerCase();
	if (!SUPPORTED_INTERNAL_SCHEMES.includes(scheme as SupportedInternalScheme)) return undefined;
	return scheme as SupportedInternalScheme;
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

const SESSION_URL_ESCAPE = "URL is outside this session and cannot be expanded in a bash command";

function pathStaysInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isStrictlyInside(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	return pathStaysInside(resolvedRoot, resolvedCandidate) && resolvedCandidate !== resolvedRoot;
}

const PROJECT_RULE_DIR_NAMES = [".agent", ".agents"] as const;

/**
 * Real path of a rule file in an ancestor `.agent/rules` or `.agents/rules` directory
 * under the trusted home. Non-Git discovery loads those directories and skips home.
 */
async function discoveredAncestorRulePath(sessionCwd: string, sourcePath: string): Promise<string | undefined> {
	const cwd = path.resolve(sessionCwd);
	const home = path.resolve(getTrustedHomeDir());
	if (!isStrictlyInside(home, cwd)) return undefined;
	const lexical = path.resolve(sourcePath);
	const realTarget = await canonicalPathOrAncestor(lexical, SESSION_URL_ESCAPE);
	let ancestor = path.dirname(cwd);
	while (isStrictlyInside(home, ancestor)) {
		let realAncestor: string;
		try {
			realAncestor = await fs.realpath(ancestor);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			realAncestor = ancestor;
		}
		if (pathStaysInside(realAncestor, realTarget)) {
			for (const dirName of PROJECT_RULE_DIR_NAMES) {
				const ruleDir = path.join(dirName, "rules");
				if (
					pathStaysInside(path.join(ancestor, ruleDir), lexical) &&
					pathStaysInside(path.join(realAncestor, ruleDir), realTarget)
				) {
					return realTarget;
				}
			}
		}
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	return undefined;
}

/**
 * Real path of an active user rule that stays inside the trusted home
 * `.agent/rules` or `.agents/rules` directory. Other user-rule roots stay out.
 */
async function discoveredUserRulePath(sourcePath: string): Promise<string | undefined> {
	const home = path.resolve(getTrustedHomeDir());
	const lexical = path.resolve(sourcePath);
	const realTarget = await canonicalPathOrAncestor(lexical, SESSION_URL_ESCAPE);
	for (const rule of getActiveRules()) {
		if (rule._source.level !== "user") continue;
		const ruleLexical = path.resolve(rule.path);
		let realRule: string;
		try {
			realRule = await fs.realpath(ruleLexical);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			continue;
		}
		if (realRule !== realTarget) continue;
		for (const dirName of PROJECT_RULE_DIR_NAMES) {
			const ruleRoot = path.join(home, dirName, "rules");
			if (!pathStaysInside(ruleRoot, lexical) || !pathStaysInside(ruleRoot, ruleLexical)) continue;
			let realRoot = ruleRoot;
			try {
				realRoot = await fs.realpath(ruleRoot);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			if (pathStaysInside(realRoot, realTarget)) return realTarget;
		}
	}
	return undefined;
}

function withoutForeignRuleNames(message: string): string {
	return message
		.split(/\r?\n/)
		.filter(line => !line.startsWith("Available:"))
		.join("\n")
		.trim();
}

/** Real path of `lexicalPath` when it stays inside `root`; otherwise undefined. */
async function containedExpansionPath(root: string, lexicalPath: string): Promise<string | undefined> {
	const resolvedRoot = path.resolve(root);
	const resolvedLexical = path.resolve(lexicalPath);
	let realRoot = resolvedRoot;
	try {
		realRoot = await fs.realpath(resolvedRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const realTarget = await canonicalPathOrAncestor(resolvedLexical, SESSION_URL_ESCAPE);
	if (!pathStaysInside(realRoot, realTarget)) return undefined;
	return realTarget;
}

async function sessionScopedRulePath(
	sourcePath: string,
	sessionCwd: string,
	sessionAgentDir: string | undefined,
): Promise<string> {
	const agentDir = sessionAgentDir?.trim() ? sessionAgentDir : getAgentDir();
	const repoRoot = await findRepoRoot(sessionCwd);
	for (const root of [repoRoot ?? path.resolve(sessionCwd), path.resolve(agentDir)]) {
		const contained = await containedExpansionPath(root, sourcePath);
		if (contained) return contained;
	}
	const userRule = await discoveredUserRulePath(sourcePath);
	if (userRule) return userRule;
	if (!repoRoot) {
		const ancestorRule = await discoveredAncestorRulePath(sessionCwd, sourcePath);
		if (ancestorRule) return ancestorRule;
	}
	throw new ToolError(`rule:// ${SESSION_URL_ESCAPE}.`);
}

async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[],
	internalRouter?: InternalUrlResolver,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
	sessionCwd?: string,
	sessionAgentDir?: string,
): Promise<string> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = extractScheme(url);
	if (!scheme) {
		throw new ToolError(`Unsupported internal URL in bash command: ${url}`);
	}

	if (scheme === "skill") {
		const { skill, lexicalPath } = resolveSkillUrl(url, skills);
		return canonicalSkillExpansionPath(skill.baseDir, lexicalPath);
	}

	// Managed artifact and agent resources carry session authority. Expanding
	// either into a subprocess command would let that subprocess reopen, replace,
	// or unlink the managed object by pathname. Keep those resources behind the
	// internal reader boundary.
	if (scheme === "artifact" || scheme === "agent") {
		throw new ToolError(
			`${scheme}:// URLs cannot be expanded in bash commands; read them through the internal reader instead.`,
		);
	}

	// The memory store folds `/`, `\`, and `:` in the project path to `-`, so
	// distinct projects (`/work/acme-api/server`, `/work/acme/api-server`) share
	// one memory root. No path check can tell which project owns a file there.
	// `memory://` is a legacy reader-only URI (docs/memory.md), so fail closed.
	if (scheme === "memory") {
		throw new ToolError(
			"memory:// URLs cannot be expanded in bash commands because the memory root is not unique per project; read them through the internal reader instead.",
		);
	}

	if (scheme === "local") {
		if (!localOptions) {
			throw new ToolError(
				"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
			);
		}
		await initializeLocalRoot(localOptions);
		const resolvedLocalPath = resolveLocalUrlToPath(url, localOptions);
		const realTarget = await canonicalLocalPath(resolveLocalRoot(localOptions), resolvedLocalPath);
		if (ensureLocalParentDirs) {
			await fs.mkdir(path.dirname(realTarget), { recursive: true });
		}
		return realTarget;
	}

	const sessionDirectoryMissing = sessionCwd === undefined || sessionCwd.trim() === "";
	if (scheme === "rule" && sessionDirectoryMissing) {
		throw new ToolError("rule:// URLs cannot be expanded in bash commands without a session directory.");
	}

	if (!internalRouter?.canHandle(url)) {
		throw new ToolError(
			`Cannot resolve ${scheme}:// URL in bash command: ${url}\n` +
				"Internal URL router is unavailable for this protocol in the current session.",
		);
	}

	let resource: InternalResource;
	try {
		resource = await internalRouter.resolve(url);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(
			`Failed to resolve ${scheme}:// URL in bash command: ${url}\n${withoutForeignRuleNames(message)}`,
		);
	}

	if (!resource.sourcePath) {
		throw new ToolError(`${scheme}:// URL resolved without a filesystem path and cannot be used in bash: ${url}`);
	}

	if (scheme === "rule" && sessionCwd !== undefined) {
		return sessionScopedRulePath(resource.sourcePath, sessionCwd, sessionAgentDir);
	}

	return path.resolve(resource.sourcePath);
}

/**
 * Expand all skill:// URIs in a bash command string.
 * Returns the command with URIs replaced by shell-escaped absolute paths.
 * Throws ToolError if any URI cannot be resolved.
 */
export function expandSkillUrls(command: string, skills: readonly Skill[]): string {
	if (skills.length === 0 || !command.includes("skill://")) {
		return command;
	}

	return command.replace(SKILL_URL_PATTERN, token => {
		const url = unquoteToken(token);
		const resolvedPath = resolveSkillUrlToPath(url, skills);
		return shellEscape(resolvedPath);
	});
}

/**
 * Expand filesystem-safe internal URLs in a bash command string. `agent://`,
 * `artifact://`, and `memory://` remain internal-reader-only and are rejected
 * before resolution.
 * `rule://` expands to a session, repository, or agent-directory path, a non-Git
 * ancestor rule under the trusted home, or a discovered user rule under
 * `.agent/rules`, `.agents/rules`, or the agent directory.
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes("://") && !command.includes("local:/")) return command;

	const matches = Array.from(command.matchAll(INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL));
	if (matches.length === 0) return command;

	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		const rawUrl = unquoteToken(token);
		const url = normalizeLocalScheme(rawUrl);
		const resolvedPath = await resolveInternalUrlToPath(
			url,
			options.skills,
			options.internalRouter,
			options.localOptions,
			options.ensureLocalParentDirs,
			options.sessionCwd,
			options.sessionAgentDir,
		);
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
