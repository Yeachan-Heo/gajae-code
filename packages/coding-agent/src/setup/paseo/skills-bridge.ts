import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CasReceipt } from "../../config/atomic-yaml-patch";
import type { RawSettings, Settings } from "../../config/settings";
import type { SettingPath } from "../../config/settings-schema";
import type { DriftReason } from "./result-types";
import {
	INSTALL_SKILL_NAMES,
	type InstallSkillName,
	PASEO_SKILL_PREFIX,
	type PaseoSetupDependencies,
} from "./setup-deps";

type BridgeEntryAction = "create" | "noop" | "prune-and-recreate";

type BridgeEntryPlan = {
	readonly name: InstallSkillName;
	readonly action: BridgeEntryAction;
	readonly linkPath: string;
	readonly targetPath: string;
	/** The dangling link text captured during preflight, used as an unlink guard. */
	readonly danglingTarget?: string;
};

/** Immutable preflight evidence consumed by the install saga and its inverse. */
export interface SkillsBridgePreflight {
	readonly bridgeDir: string;
	readonly bridgeDirCreated: boolean;
	readonly entries: Readonly<Record<InstallSkillName, BridgeEntryPlan>>;
}

/** What the forward operation actually created, rather than what preflight intended to create. */
export interface SkillsBridgeInstallResult {
	readonly createdEntries: readonly InstallSkillName[];
	readonly bridgeDirCreated: boolean;
}

export class SkillsBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillsBridgeError";
	}
}

function expectedTarget(deps: PaseoSetupDependencies, name: InstallSkillName): string {
	return path.resolve(deps.paths.agentsSkillsDir, name);
}

function linkPath(deps: PaseoSetupDependencies, name: InstallSkillName): string {
	return path.join(deps.paths.bridgeDir, name);
}

function resolvedLinkTarget(link: string, destination: string): string {
	return path.resolve(path.dirname(destination), link);
}

async function entryState(
	destination: string,
	expected: string,
): Promise<
	| { readonly kind: "absent" }
	| { readonly kind: "expected"; readonly link: string }
	| { readonly kind: "dangling"; readonly link: string }
	| { readonly kind: "conflict" }
> {
	try {
		const stat = await fs.lstat(destination);
		if (!stat.isSymbolicLink()) return { kind: "conflict" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		throw error;
	}
	const link = await fs.readlink(destination);
	if (resolvedLinkTarget(link, destination) !== expected) return { kind: "conflict" };
	try {
		await fs.stat(destination);
		return { kind: "expected", link };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "dangling", link };
		throw error;
	}
}

async function bridgeDirectoryState(bridgeDir: string): Promise<"absent" | "directory" | "conflict"> {
	try {
		const stat = await fs.lstat(bridgeDir);
		return stat.isDirectory() ? "directory" : "conflict";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
		throw error;
	}
}

/**
 * Classify every allowlisted bridge entry without mutating either skill tree.
 * All conflicts are accumulated so the caller can report them together.
 */
export async function preflightSkillsBridge(deps: PaseoSetupDependencies): Promise<SkillsBridgePreflight> {
	const directory = await bridgeDirectoryState(deps.paths.bridgeDir);
	const conflicts: string[] = directory === "conflict" ? [deps.paths.bridgeDir] : [];
	const entries = {} as Record<InstallSkillName, BridgeEntryPlan>;

	for (const name of INSTALL_SKILL_NAMES) {
		const destination = linkPath(deps, name);
		const target = expectedTarget(deps, name);
		const state = directory === "absent" ? { kind: "absent" as const } : await entryState(destination, target);
		if (state.kind === "conflict") {
			conflicts.push(destination);
			continue;
		}
		entries[name] = {
			name,
			action: state.kind === "expected" ? "noop" : state.kind === "dangling" ? "prune-and-recreate" : "create",
			linkPath: destination,
			targetPath: target,
			...(state.kind === "dangling" ? { danglingTarget: state.link } : {}),
		};
	}
	if (conflicts.length > 0) {
		throw new SkillsBridgeError(
			`Refusing to modify Paseo skills bridge; conflicting entries: ${conflicts.join(", ")}`,
		);
	}
	return { bridgeDir: deps.paths.bridgeDir, bridgeDirCreated: directory === "absent", entries };
}

async function createBridgeDirectory(preflight: SkillsBridgePreflight): Promise<void> {
	try {
		await fs.mkdir(preflight.bridgeDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new SkillsBridgeError(`Paseo skills bridge appeared during creation: ${preflight.bridgeDir}`);
	}
}

async function pruneRecordedDangling(entry: BridgeEntryPlan): Promise<void> {
	if (entry.danglingTarget === undefined)
		throw new SkillsBridgeError(`Missing dangling-link evidence for ${entry.linkPath}`);
	const state = await entryState(entry.linkPath, entry.targetPath);
	if (state.kind !== "dangling" || state.link !== entry.danglingTarget) {
		throw new SkillsBridgeError(`Paseo skill bridge entry diverged before pruning: ${entry.linkPath}`);
	}
	await fs.unlink(entry.linkPath);
}

async function createNoReplace(entry: BridgeEntryPlan): Promise<void> {
	try {
		await fs.symlink(entry.targetPath, entry.linkPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const observed = await entryState(entry.linkPath, entry.targetPath);
		throw new SkillsBridgeError(
			`Paseo skill bridge entry appeared during creation (${observed.kind}): ${entry.linkPath}`,
		);
	}
}

/** Create only preflight-approved bridge links; symlink publication never replaces an existing entry. */
export async function installSkillsBridge(preflight: SkillsBridgePreflight): Promise<SkillsBridgeInstallResult> {
	let bridgeDirCreated = false;
	if (preflight.bridgeDirCreated) {
		await createBridgeDirectory(preflight);
		bridgeDirCreated = true;
	}
	const createdEntries: InstallSkillName[] = [];
	for (const name of INSTALL_SKILL_NAMES) {
		const entry = preflight.entries[name];
		if (entry.action === "noop") continue;
		if (entry.action === "prune-and-recreate") await pruneRecordedDangling(entry);
		await createNoReplace(entry);
		createdEntries.push(name);
	}
	return { createdEntries, bridgeDirCreated };
}

/**
 * Undo exactly the links this run created. A changed link is reported as a
 * conflict rather than being deleted; this makes compensation safe after edits.
 */
export async function inverseSkillsBridge(
	deps: PaseoSetupDependencies,
	result: SkillsBridgeInstallResult,
): Promise<void> {
	const diverged: string[] = [];
	for (const name of result.createdEntries) {
		const destination = linkPath(deps, name);
		const state = await entryState(destination, expectedTarget(deps, name));
		if (state.kind !== "expected" || state.link !== expectedTarget(deps, name)) diverged.push(destination);
	}
	if (diverged.length > 0) {
		throw new SkillsBridgeError(`Refusing to remove diverged Paseo skill bridge entries: ${diverged.join(", ")}`);
	}
	for (const name of result.createdEntries) await fs.unlink(linkPath(deps, name));
	if (!result.bridgeDirCreated) return;
	try {
		await fs.rmdir(deps.paths.bridgeDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

/** Find Paseo-prefixed bridge or source entries that the locked install allowlist does not repair. */
export async function scanSkillsBridgeDrift(deps: PaseoSetupDependencies): Promise<readonly DriftReason[]> {
	const reasons: DriftReason[] = [];
	const bridgeEntries = await fs.readdir(deps.paths.bridgeDir, { withFileTypes: true }).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	for (const entry of bridgeEntries) {
		if (!entry.name.startsWith(PASEO_SKILL_PREFIX) || !entry.isSymbolicLink()) continue;
		const destination = path.join(deps.paths.bridgeDir, entry.name);
		try {
			await fs.stat(destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			reasons.push({ code: "orphan-skill", subject: destination, detail: "bridge symlink target no longer exists" });
		}
	}
	const sourceEntries = await fs.readdir(deps.paths.agentsSkillsDir, { withFileTypes: true }).catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	for (const entry of sourceEntries) {
		if (!entry.name.startsWith(PASEO_SKILL_PREFIX) || (INSTALL_SKILL_NAMES as readonly string[]).includes(entry.name))
			continue;
		reasons.push({
			code: "unlinked-skill",
			subject: path.join(deps.paths.agentsSkillsDir, entry.name),
			detail: "Paseo skill is outside GJC's locked bridge allowlist",
		});
	}
	return reasons;
}

function existingCustomDirectories(current: Readonly<RawSettings>): string[] {
	const skills = current.skills;
	if (skills === undefined) return [];
	if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
		throw new SkillsBridgeError("Cannot register Paseo skills bridge: skills config is not an object.");
	}
	const directories = (skills as Record<string, unknown>).customDirectories;
	if (directories === undefined) return [];
	if (!Array.isArray(directories) || directories.some(directory => typeof directory !== "string")) {
		throw new SkillsBridgeError(
			"Cannot register Paseo skills bridge: skills.customDirectories is not a string array.",
		);
	}
	return [...directories];
}

/** Append the bridge directory without discarding concurrent user config changes. */
export async function registerSkillsBridgeDirectory(settings: Settings, bridgeDir: string): Promise<CasReceipt> {
	return settings.commitAtomicBatchWithCurrent(current => {
		const directories = existingCustomDirectories(current);
		const next = directories.includes(bridgeDir) ? directories : [...directories, bridgeDir];
		return [{ path: "skills.customDirectories" as SettingPath, op: "set", value: next }];
	});
}
