import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { type SettingPath, Settings } from "../../config/settings";
import type { SkillsSettings } from "../../config/settings-schema";
import { compareSkillOrder, scanSkillsFromDir } from "../../discovery/helpers";
import {
	discoverRuntimeSkills,
	type RuntimeSkillDiscoveryCandidate,
} from "../../extensibility/runtime-skill-discovery";
import { expandTilde } from "../../tools/path-utils";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;
type SkillScope = "user" | "repo" | "system" | "admin";
type SkillMetadata = {
	name: string;
	description: string;
	path: string;
	scope: SkillScope;
	enabled: boolean;
};
type SkillErrorInfo = { path: string; message: string };
type SkillsListEntry = { cwd: string; skills: SkillMetadata[]; errors: SkillErrorInfo[] };

const SKILLS_ENABLED_PATH = "skills.enabled" as SettingPath;
const SKILLS_CUSTOM_DIRECTORIES_PATH = "skills.customDirectories" as SettingPath;
const DISABLED_EXTENSIONS_PATH = "disabledExtensions" as SettingPath;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidParams(): HandlerResult {
	return { ok: false, errorKey: "invalidParams" };
}

function internalError(): HandlerResult {
	return { ok: false, errorKey: "internalError" };
}

function notFound(): HandlerResult {
	return { ok: false, errorKey: "notFound" };
}

function resolveAgentDirectory(): string {
	const configured =
		process.env.GJC_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? undefined;
	return path.resolve(configured ?? getAgentDir());
}

function resolveCwd(value: string | undefined): string {
	return path.resolve(value && value.length > 0 ? value : process.cwd());
}

function runtimeHome(): string {
	return process.env.HOME || os.homedir();
}

function skillsPolicy(settings: Settings): SkillsSettings & { disabledExtensions: string[] } {
	return {
		...settings.getGroup("skills"),
		disabledExtensions: settings.get("disabledExtensions"),
	};
}

function matchesPattern(name: string, pattern: string): boolean {
	try {
		return new Bun.Glob(pattern).match(name);
	} catch {
		return false;
	}
}

function skillAllowedByPolicy(name: string, policy: SkillsSettings & { disabledExtensions: string[] }): boolean {
	if (policy.enabled !== true) return false;
	if (policy.disabledExtensions.some(id => id === `skill:${name}`)) return false;
	if (policy.ignoredSkills?.some(pattern => matchesPattern(name, pattern))) return false;
	if (
		policy.includeSkills &&
		policy.includeSkills.length > 0 &&
		!policy.includeSkills.some(pattern => matchesPattern(name, pattern))
	)
		return false;
	return true;
}

function metadataFromRuntime(candidate: RuntimeSkillDiscoveryCandidate): SkillMetadata {
	return {
		name: candidate.name,
		description: candidate.description,
		path: path.resolve(candidate.path),
		scope: candidate.source === "project" ? "repo" : "user",
		enabled: true,
	};
}

function metadataFromCustom(skill: {
	name: string;
	path: string;
	frontmatter?: Record<string, unknown>;
}): SkillMetadata {
	return {
		name: skill.name,
		description: typeof skill.frontmatter?.description === "string" ? skill.frontmatter.description : "",
		path: path.resolve(skill.path),
		scope: "user",
		enabled: true,
	};
}

async function discoverSkillsForCwd(cwd: string, settings: Settings): Promise<SkillsListEntry> {
	const policy = skillsPolicy(settings);
	const errors: SkillErrorInfo[] = [];
	const skills: SkillMetadata[] = [];
	const seenNames = new Set<string>();
	const seenPaths = new Set<string>();

	if (policy.enabled === true) {
		const runtimeCandidates = await discoverRuntimeSkills({
			cwd,
			home: runtimeHome(),
			source: "all",
			limit: 50,
			policy,
		});
		for (const candidate of runtimeCandidates) {
			const metadata = metadataFromRuntime(candidate);
			if (seenNames.has(metadata.name) || seenPaths.has(metadata.path)) continue;
			seenNames.add(metadata.name);
			seenPaths.add(metadata.path);
			skills.push(metadata);
		}

		const configuredDirectories = [...(policy.customDirectories ?? [])];
		if (policy.enablePiUser === true) configuredDirectories.push(path.join(resolveAgentDirectory(), "skills"));
		for (const configuredDirectory of configuredDirectories) {
			if (typeof configuredDirectory !== "string" || configuredDirectory.length === 0) continue;
			const directory = path.resolve(expandTilde(configuredDirectory, runtimeHome()));
			const scan = await scanSkillsFromDir(
				{ cwd, home: runtimeHome(), repoRoot: null },
				{
					dir: directory,
					providerId: "custom",
					level: "user",
					requireDescription: true,
				},
			);
			for (const message of scan.warnings ?? []) errors.push({ path: directory, message });
			for (const skill of scan.items) {
				if (!skillAllowedByPolicy(skill.name, policy)) continue;
				const metadata = metadataFromCustom(skill);
				if (seenNames.has(metadata.name) || seenPaths.has(metadata.path)) continue;
				seenNames.add(metadata.name);
				seenPaths.add(metadata.path);
				skills.push(metadata);
			}
		}
	}

	skills.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
	return { cwd, skills, errors };
}

function resultFingerprint(entry: SkillsListEntry): string {
	return JSON.stringify(entry);
}

function emitSkillsChanged(context: HandlerContext | undefined): void {
	try {
		context?.emitTo?.(context.connectionId ?? "", "skills/changed", {});
	} catch {
		// A disconnected transport must not turn a durable settings write into an error.
	}
}

function validKeys(value: RecordValue, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function parseSkillsListParams(params: unknown): { cwds: string[]; forceReload: boolean } | HandlerResult {
	if (params === undefined) return { cwds: [process.cwd()], forceReload: false };
	if (!isRecord(params) || !validKeys(params, ["cwds", "forceReload"])) return invalidParams();
	if (
		params.cwds !== undefined &&
		(!Array.isArray(params.cwds) || !params.cwds.every(value => typeof value === "string"))
	)
		return invalidParams();
	if (params.forceReload !== undefined && typeof params.forceReload !== "boolean") return invalidParams();
	const rawCwds = (params.cwds as string[] | undefined) ?? [];
	return {
		cwds: rawCwds.length > 0 ? rawCwds : [process.cwd()],
		forceReload: params.forceReload === true,
	};
}

/** Enumerate real GJC project, user, and configured extra-root skills. */
export const skillsListHandler: MethodHandler = async params => {
	const parsed = parseSkillsListParams(params);
	if ("ok" in parsed) return parsed;
	try {
		const entries: SkillsListEntry[] = [];
		for (const rawCwd of parsed.cwds) {
			const cwd = resolveCwd(rawCwd);
			const settings = await Settings.loadForScope({ cwd, agentDir: resolveAgentDirectory() });
			entries.push(await discoverSkillsForCwd(cwd, settings));
		}
		// forceReload is intentionally accepted even though this lane's discovery seam scans disk
		// on every call and therefore has no cache to invalidate.
		void parsed.forceReload;
		return { ok: true, result: { data: entries } };
	} catch {
		return internalError();
	}
};

function parseSkillsConfigWriteParams(
	params: unknown,
): { enabled: boolean; name?: string; path?: string } | HandlerResult {
	if (!isRecord(params) || !validKeys(params, ["path", "name", "enabled"])) return invalidParams();
	if (typeof params.enabled !== "boolean") return invalidParams();
	let name: string | undefined;
	let skillPath: string | undefined;
	if (params.name !== undefined && params.name !== null) {
		if (typeof params.name !== "string" || params.name.trim().length === 0) return invalidParams();
		name = params.name.trim();
	}
	if (params.path !== undefined && params.path !== null) {
		if (typeof params.path !== "string" || !path.isAbsolute(params.path)) return invalidParams();
		skillPath = path.resolve(params.path);
	}
	if (name === undefined && skillPath === undefined) return { enabled: params.enabled };
	return { enabled: params.enabled, ...(name ? { name } : {}), ...(skillPath ? { path: skillPath } : {}) };
}

async function resolvePathSkillName(cwd: string, skillPath: string): Promise<string | undefined> {
	if (path.basename(skillPath) !== "SKILL.md") return undefined;
	const root = path.dirname(path.dirname(skillPath));
	const scan = await scanSkillsFromDir(
		{ cwd, home: runtimeHome(), repoRoot: null },
		{ dir: root, providerId: "selector", level: "user", requireDescription: false },
	);
	const selected = scan.items.find(item => path.resolve(item.path) === skillPath);
	return selected?.name;
}

function disabledSkillNames(settings: Settings): string[] {
	const value = settings.get("disabledExtensions");
	return Array.isArray(value)
		? value
				.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("skill:"))
				.map(entry => entry.slice("skill:".length))
		: [];
}

function exactDisabled(names: readonly string[], name: string): boolean {
	return names.some(entry => entry === name);
}

async function applySkillConfigWrite(
	params: { enabled: boolean; name?: string; path?: string },
	cwd: string,
	settings: Settings,
	context: HandlerContext | undefined,
): Promise<HandlerResult> {
	const before = await discoverSkillsForCwd(cwd, settings);
	if (params.name === undefined && params.path === undefined) {
		await settings.commitAtomicBatch([{ path: SKILLS_ENABLED_PATH, op: "set", value: params.enabled }]);
		const after = await discoverSkillsForCwd(cwd, settings);
		if (resultFingerprint(before) !== resultFingerprint(after)) emitSkillsChanged(context);
		return { ok: true, result: { effectiveEnabled: settings.get("skills.enabled") === true } };
	}

	let targetName = params.name;
	const target = before.skills.find(
		skill =>
			(params.name === undefined || skill.name === params.name) &&
			(params.path === undefined || skill.path === params.path),
	);
	if (target) {
		if (targetName !== undefined && target.name !== targetName) return invalidParams();
		targetName = target.name;
	} else if (params.path !== undefined) {
		targetName = await resolvePathSkillName(cwd, params.path);
		if (targetName === undefined) return notFound();
		if (params.name !== undefined && params.name !== targetName) return invalidParams();
	} else if (targetName === undefined || !exactDisabled(disabledSkillNames(settings), targetName)) {
		return notFound();
	}
	if (targetName === undefined) return notFound();

	const currentDisabledExtensions = settings.get("disabledExtensions");
	const targetId = `skill:${targetName}`;
	const nextDisabledExtensions = params.enabled
		? currentDisabledExtensions.filter(id => id !== targetId)
		: currentDisabledExtensions.includes(targetId)
			? currentDisabledExtensions
			: [...currentDisabledExtensions, targetId];
	if (JSON.stringify(nextDisabledExtensions) !== JSON.stringify(currentDisabledExtensions)) {
		await settings.commitAtomicBatch([
			{
				path: DISABLED_EXTENSIONS_PATH,
				op: "set",
				value: nextDisabledExtensions,
			},
		]);
	}
	const after = await discoverSkillsForCwd(cwd, settings);
	if (resultFingerprint(before) !== resultFingerprint(after)) emitSkillsChanged(context);
	const effectiveEnabled = after.skills.some(
		skill => skill.name === targetName && (params.path === undefined || skill.path === params.path),
	);
	return { ok: true, result: { effectiveEnabled } };
}

/** Persist global or per-skill enablement through Settings' atomic config seam. */
export const skillsConfigWriteHandler: MethodHandler = async (params, context) => {
	const parsed = parseSkillsConfigWriteParams(params);
	if ("ok" in parsed) return parsed;
	try {
		const cwd = process.cwd();
		const settings = await Settings.loadForScope({ cwd, agentDir: resolveAgentDirectory() });
		return await applySkillConfigWrite(parsed, cwd, settings, context);
	} catch {
		return internalError();
	}
};

async function validatedExtraRoots(value: unknown): Promise<string[] | undefined> {
	if (!Array.isArray(value) || !value.every(entry => typeof entry === "string" && path.isAbsolute(entry)))
		return undefined;
	const roots: string[] = [];
	for (const entry of value as string[]) {
		const root = path.resolve(entry);
		try {
			if (!(await fs.stat(root)).isDirectory()) return undefined;
		} catch {
			return undefined;
		}
		if (!roots.includes(root)) roots.push(root);
	}
	return roots;
}

/** Persist absolute, existing extra skill roots and refresh discovery on the next list. */
export const skillsExtraRootsSetHandler: MethodHandler = async (params, context) => {
	if (!isRecord(params) || !validKeys(params, ["extraRoots"])) return invalidParams();
	const roots = await validatedExtraRoots(params.extraRoots);
	if (roots === undefined) return invalidParams();
	try {
		const cwd = process.cwd();
		const settings = await Settings.loadForScope({ cwd, agentDir: resolveAgentDirectory() });
		const before = await discoverSkillsForCwd(cwd, settings);
		await settings.commitAtomicBatch([{ path: SKILLS_CUSTOM_DIRECTORIES_PATH, op: "set", value: roots }]);
		const after = await discoverSkillsForCwd(cwd, settings);
		if (resultFingerprint(before) !== resultFingerprint(after)) emitSkillsChanged(context);
		return { ok: true, result: {} };
	} catch {
		return internalError();
	}
};

export const skillsHandlers: Record<string, MethodHandler> = {
	"skills/list": skillsListHandler,
	"skills/config/write": skillsConfigWriteHandler,
	"skills/extraRoots/set": skillsExtraRootsSetHandler,
};
