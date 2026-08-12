import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir } from "@gajae-code/utils";
import { MAX_MASTER_NAME_BYTES, MasterStoreError } from "./types";

export const MASTER_DIRECTORY_NAME = "master";
export const MASTER_DAEMON_DIRECTORY_NAME = "daemon";
export const MASTER_SDK_DIRECTORY_NAME = "sdk";
export const MASTER_MASTERS_DIRECTORY_NAME = "masters";

export interface MasterRootPaths {
	root: string;
	daemonDir: string;
	sdkDir: string;
	mastersDir: string;
	daemonOwnerPath: string;
	daemonHeartbeatPath: string;
	daemonStatePath: string;
	sdkDiscoveryPath: string;
	eventJournalPath: string;
	eventCheckpointPath: string;
	eventJournalLockPath: string;
}

export interface MasterPaths extends MasterRootPaths {
	masterName: string;
	masterDir: string;
	recordPath: string;
	doctrinePath: string;
	queuePath: string;
	workersPath: string;
	ownershipPath: string;
	claimsPath: string;
	decisionsPath: string;
	channelsPath: string;
	presentationOutboxPath: string;
	sessionDir: string;
	transcriptDir: string;
	blobDir: string;
	residentCacheDir: string;
	lockPath: string;
	commitManifestPath: string;
}

export interface MasterPathOptions {
	configRootDir?: string;
	masterRootDir?: string;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

export function isCanonicalMasterName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		byteLength(value) >= 1 &&
		byteLength(value) <= MAX_MASTER_NAME_BYTES &&
		/^[a-z][a-z0-9-]*$/.test(value)
	);
}

export function assertCanonicalMasterName(value: unknown): asserts value is string {
	if (!isCanonicalMasterName(value))
		throw new MasterStoreError(
			"INVALID_MASTER_NAME",
			"Master names must match [a-z][a-z0-9-]{0,62} and be at most 63 bytes.",
		);
}

export const validateMasterName = assertCanonicalMasterName;
export const isValidMasterName = isCanonicalMasterName;

export function getMasterRootDir(configRootDir: string = getConfigRootDir()): string {
	if (typeof configRootDir !== "string" || configRootDir.length === 0)
		throw new MasterStoreError("INVALID_ROOT", "Config root must be non-empty.");
	return path.join(path.resolve(configRootDir), MASTER_DIRECTORY_NAME);
}

export const getMasterDirectory = getMasterRootDir;

export function getMasterRootPaths(options: MasterPathOptions = {}): MasterRootPaths {
	const root = path.resolve(options.masterRootDir ?? getMasterRootDir(options.configRootDir));
	const daemonDir = path.join(root, MASTER_DAEMON_DIRECTORY_NAME);
	const sdkDir = path.join(root, MASTER_SDK_DIRECTORY_NAME);
	const mastersDir = path.join(root, MASTER_MASTERS_DIRECTORY_NAME);
	return {
		root,
		daemonDir,
		sdkDir,
		mastersDir,
		daemonOwnerPath: path.join(daemonDir, "owner.json"),
		daemonHeartbeatPath: path.join(daemonDir, "heartbeat.json"),
		daemonStatePath: path.join(daemonDir, "state.json"),
		sdkDiscoveryPath: path.join(sdkDir, "master-daemon.json"),
		eventJournalPath: path.join(root, "events.jsonl"),
		eventCheckpointPath: path.join(root, "events.checkpoint.json"),
		eventJournalLockPath: path.join(root, "events.lock"),
	};
}

export function getMasterPaths(masterName: string, options: MasterPathOptions = {}): MasterPaths {
	assertCanonicalMasterName(masterName);
	const rootPaths = getMasterRootPaths(options);
	const masterDir = path.join(rootPaths.mastersDir, masterName);
	const sessionDir = path.join(masterDir, "session");
	return {
		...rootPaths,
		masterName,
		masterDir,
		recordPath: path.join(masterDir, "record.json"),
		doctrinePath: path.join(masterDir, "doctrine.md"),
		queuePath: path.join(masterDir, "queue.json"),
		workersPath: path.join(masterDir, "workers.json"),
		ownershipPath: path.join(masterDir, "ownership.json"),
		claimsPath: path.join(masterDir, "claims.json"),
		decisionsPath: path.join(masterDir, "decisions.jsonl"),
		channelsPath: path.join(masterDir, "channels.json"),
		presentationOutboxPath: path.join(masterDir, "presentation-outbox.json"),
		sessionDir,
		transcriptDir: sessionDir,
		blobDir: path.join(sessionDir, "blobs"),
		residentCacheDir: path.join(sessionDir, "resident-cache"),
		lockPath: path.join(masterDir, ".domain.lock"),
		commitManifestPath: path.join(masterDir, "commit-manifest.json"),
	};
}

export const masterPaths = getMasterPaths;
export const pathsForMaster = getMasterPaths;

export const getMasterRootPath = getMasterRootDir;
export function getMasterRecordPath(masterName: string, options: MasterPathOptions = {}): string {
	return getMasterPaths(masterName, options).recordPath;
}
export function getMasterQueuePath(masterName: string, options: MasterPathOptions = {}): string {
	return getMasterPaths(masterName, options).queuePath;
}
export function getMasterWorkersPath(masterName: string, options: MasterPathOptions = {}): string {
	return getMasterPaths(masterName, options).workersPath;
}

export function isPathWithinMasterRoot(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	const relative = path.relative(resolvedRoot, resolvedCandidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function assertPathWithinMasterRoot(root: string, candidate: string): asserts candidate is string {
	if (!isPathWithinMasterRoot(root, candidate))
		throw new MasterStoreError("MASTER_PATH_ESCAPE", `Path escapes master root: ${candidate}`);
}

async function lstatIfPresent(target: string): Promise<Stats | null> {
	try {
		return await fs.lstat(target);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

async function ensurePrivateDirectory(target: string, root: string): Promise<void> {
	assertPathWithinMasterRoot(root, target);
	await fs.mkdir(target, { recursive: true, mode: 0o700 });
	const relative = path.relative(root, target);
	let current = root;
	for (const segment of relative === "" ? [] : relative.split(path.sep)) {
		current = path.join(current, segment);
		const stat = await lstatIfPresent(current);
		if (!stat?.isDirectory() || stat.isSymbolicLink())
			throw new MasterStoreError("MASTER_PATH_INVALID", `Master directory is not a private directory: ${current}`);
		await fs.chmod(current, 0o700);
	}
}

export async function ensurePrivateMasterLayout(paths: MasterPaths): Promise<void> {
	const rootPaths: MasterRootPaths = paths;
	await ensurePrivateDirectory(rootPaths.root, path.dirname(rootPaths.root));
	await ensurePrivateDirectory(rootPaths.daemonDir, rootPaths.root);
	await ensurePrivateDirectory(rootPaths.sdkDir, rootPaths.root);
	await ensurePrivateDirectory(rootPaths.mastersDir, rootPaths.root);
	await ensurePrivateDirectory(paths.masterDir, rootPaths.root);
	await ensurePrivateDirectory(paths.sessionDir, rootPaths.root);
	await ensurePrivateDirectory(paths.blobDir, rootPaths.root);
	await ensurePrivateDirectory(paths.residentCacheDir, rootPaths.root);
}

export async function assertPrivateMasterAncestry(paths: MasterPaths): Promise<void> {
	await ensurePrivateMasterLayout(paths);
}

export async function ensurePrivateFileMode(filePath: string): Promise<void> {
	await fs.chmod(filePath, 0o600);
}
