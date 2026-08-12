import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getMasterRootPaths, type MasterPathOptions } from "./paths";
import { MAX_MASTER_FRAME_BYTES } from "./sdk-contract";

export const MASTER_SDK_DISCOVERY_VERSION = 1 as const;
export const MASTER_SDK_PROTOCOL_VERSION = 1 as const;
export const MASTER_SDK_HOST = "127.0.0.1" as const;
export const MASTER_SDK_DISCOVERY_DIRECTORY_MODE = 0o700;
export const MASTER_SDK_DISCOVERY_FILE_MODE = 0o600;

export interface MasterSdkDiscovery {
	version: typeof MASTER_SDK_DISCOVERY_VERSION;
	protocolVersion: typeof MASTER_SDK_PROTOCOL_VERSION;
	url: string;
	token: string;
	pid: number;
	startedAt: string;
	heartbeatAt: string;
}

export type RedactedMasterSdkDiscovery = Omit<MasterSdkDiscovery, "token"> & { token: "[redacted]" };

export interface MasterSdkDiscoveryOptions extends MasterPathOptions {
	path?: string;
}

function discoveryPath(options: MasterSdkDiscoveryOptions = {}): string {
	return options.path ?? getMasterRootPaths(options).sdkDiscoveryPath;
}

export function masterSdkDiscoveryPath(options: MasterSdkDiscoveryOptions = {}): string {
	return discoveryPath(options);
}

export const getMasterSdkDiscoveryPath = masterSdkDiscoveryPath;
export const sdkDiscoveryPath = masterSdkDiscoveryPath;

export function newMasterSdkToken(): string {
	return randomBytes(32).toString("hex");
}

export const createMasterSdkToken = newMasterSdkToken;

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isCanonicalUtc(value: unknown): value is string {
	if (typeof value !== "string" || !value.endsWith("Z")) return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && value === new Date(parsed).toISOString();
}

function isToken(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && byteLength(value) <= 128 && /^[\x20-\x7e]+$/.test(value);
}

function isLoopbackUrl(value: unknown): value is string {
	if (typeof value !== "string" || byteLength(value) > 2_048) return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "ws:" || url.protocol === "wss:") &&
			url.hostname === MASTER_SDK_HOST &&
			url.pathname.length > 0
		);
	} catch {
		return false;
	}
}

export function isMasterSdkDiscovery(value: unknown): value is MasterSdkDiscovery {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<MasterSdkDiscovery>;
	return (
		candidate.version === MASTER_SDK_DISCOVERY_VERSION &&
		candidate.protocolVersion === MASTER_SDK_PROTOCOL_VERSION &&
		isLoopbackUrl(candidate.url) &&
		isToken(candidate.token) &&
		typeof candidate.pid === "number" &&
		Number.isSafeInteger(candidate.pid) &&
		candidate.pid > 0 &&
		isCanonicalUtc(candidate.startedAt) &&
		isCanonicalUtc(candidate.heartbeatAt)
	);
}

export function redactMasterSdkDiscovery(discovery: MasterSdkDiscovery): RedactedMasterSdkDiscovery {
	return { ...discovery, token: "[redacted]" };
}

async function ensurePrivateSdkDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: MASTER_SDK_DISCOVERY_DIRECTORY_MODE });
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("master SDK discovery directory must be a private directory");
	await fs.chmod(directory, MASTER_SDK_DISCOVERY_DIRECTORY_MODE);
}

async function syncFile(filePath: string): Promise<void> {
	const handle = await fs.open(filePath, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function assertDiscovery(value: MasterSdkDiscovery): void {
	if (!isMasterSdkDiscovery(value)) throw new Error("invalid master SDK discovery record");
}

export async function writeMasterSdkDiscovery(
	discovery: MasterSdkDiscovery,
	options: MasterSdkDiscoveryOptions = {},
): Promise<void> {
	assertDiscovery(discovery);
	const filePath = discoveryPath(options);
	const directory = path.dirname(filePath);
	await ensurePrivateSdkDirectory(directory);
	const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temporaryPath, `${JSON.stringify(discovery)}\n`, {
			encoding: "utf8",
			mode: MASTER_SDK_DISCOVERY_FILE_MODE,
			flag: "wx",
		});
		await fs.chmod(temporaryPath, MASTER_SDK_DISCOVERY_FILE_MODE);
		await syncFile(temporaryPath);
		await fs.rename(temporaryPath, filePath);
		await fs.chmod(filePath, MASTER_SDK_DISCOVERY_FILE_MODE);
		await syncDirectory(directory);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}

export async function readMasterSdkDiscovery(
	options: MasterSdkDiscoveryOptions = {},
): Promise<MasterSdkDiscovery | null> {
	const filePath = discoveryPath(options);
	try {
		const directoryStat = await fs.lstat(path.dirname(filePath));
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
		const fileStat = await fs.lstat(filePath);
		if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;
		const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
		if (!isMasterSdkDiscovery(parsed)) return null;
		return parsed;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code === "ENOENT" || error instanceof SyntaxError) return null;
		throw error;
	}
}

export async function removeMasterSdkDiscovery(
	options: MasterSdkDiscoveryOptions = {},
	expected?: MasterSdkDiscovery,
): Promise<boolean> {
	const filePath = discoveryPath(options);
	try {
		if (expected) {
			const current = await readMasterSdkDiscovery(options);
			if (
				!current ||
				current.pid !== expected.pid ||
				current.token !== expected.token ||
				current.startedAt !== expected.startedAt ||
				current.url !== expected.url
			)
				return false;
		}
		await fs.unlink(filePath);
		await syncDirectory(path.dirname(filePath));
		return true;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return false;
		throw error;
	}
}

export const deleteMasterSdkDiscovery = removeMasterSdkDiscovery;
export const cleanupMasterSdkDiscovery = removeMasterSdkDiscovery;

export interface MasterSdkDiscoveryPublication {
	readonly discovery: MasterSdkDiscovery;
	close(): Promise<void>;
}

export async function publishMasterSdkDiscovery(
	discovery: MasterSdkDiscovery,
	options: MasterSdkDiscoveryOptions = {},
): Promise<MasterSdkDiscoveryPublication> {
	await writeMasterSdkDiscovery(discovery, options);
	let closed = false;
	return {
		discovery,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await removeMasterSdkDiscovery(options, discovery);
		},
	};
}

export function validateMasterSdkDiscovery(value: unknown): asserts value is MasterSdkDiscovery {
	if (!isMasterSdkDiscovery(value)) throw new Error("invalid master SDK discovery record");
}

export function assertMasterSdkDiscoveryUrl(value: string): void {
	if (!isLoopbackUrl(value)) throw new Error("master SDK discovery URL must use loopback ws://127.0.0.1");
}

export const MAX_DISCOVERY_FRAME_BYTES = MAX_MASTER_FRAME_BYTES;
