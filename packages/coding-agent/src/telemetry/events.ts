import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NativeNoReplaceResult } from "@gajae-code/natives";
import * as natives from "@gajae-code/natives";
import { getTrustedAgentFile } from "@gajae-code/utils";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_INSTALL_ID_FILE = "telemetry-install-id" as const;

export const TELEMETRY_EVENT_NAMES = [
	"update_check_started",
	"update_check_completed",
	"update_install_started",
	"update_install_completed",
	"update_install_failed",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export interface TelemetryEvent {
	schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
	event: TelemetryEventName;
	installId: string;
	occurredAt: string;
	channel?: "stable" | "nightly";
	result?: "available" | "up_to_date" | "installed" | "failed" | "skipped";
	installMethod?: "bun" | "npm" | "binary" | "migrate";
}
type EventInput = {
	event?: unknown;
	installId?: unknown;
	occurredAt?: unknown;
	channel?: unknown;
	result?: unknown;
	installMethod?: unknown;
	[key: string]: unknown;
};

const EVENT_NAMES = new Set<string>(TELEMETRY_EVENT_NAMES);
const CHANNELS = new Set(["stable", "nightly"]);
const RESULTS = new Set(["available", "up_to_date", "installed", "failed", "skipped"]);
const INSTALL_METHODS = new Set(["bun", "npm", "binary", "migrate"]);
const FORBIDDEN_KEY = /(?:prompt|argv|path|env|secret|account|model|provider|repo|error|hostname|username|machine|ip)/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALL_ID_CLAIM_TIMEOUT_MS = 2_000;
const INSTALL_ID_CLAIM_RECOVERY_MARGIN_MS = 500;
const INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS = INSTALL_ID_CLAIM_TIMEOUT_MS + INSTALL_ID_CLAIM_RECOVERY_MARGIN_MS;
const INSTALL_ID_CLAIM_LEASE_MS = 1_000;
const INSTALL_ID_HEARTBEAT_INTERVAL_MS = Math.floor(INSTALL_ID_CLAIM_LEASE_MS / 2);
const INSTALL_ID_CLAIM_POLL_INITIAL_MS = 25;
const INSTALL_ID_MAX_SERIALIZED_BYTES = 128;
const CLAIM_MAX_SERIALIZED_BYTES = 16_384;
const INSTALL_ID_PARTIAL_GRACE_MS = 250;
const INSTALL_ID_NOFOLLOW_NONBLOCK_FLAGS =
	process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const INSTALL_ID_READ_FLAGS = fs.constants.O_RDONLY | INSTALL_ID_NOFOLLOW_NONBLOCK_FLAGS;
const INSTALL_ID_WRITE_FLAGS = fs.constants.O_RDWR | INSTALL_ID_NOFOLLOW_NONBLOCK_FLAGS;
const durableInstallIdPaths = new Map<string, { identity: string; promise: Promise<void> }>();
const scheduledClaimCleanups = new Set<string>();

function hasForbiddenKey(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_KEY.test(key) || hasForbiddenKey(child, seen)) return true;
	}
	return false;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) {
		throw new Error(`invalid telemetry ${field}`);
	}
	return value;
}

/**
 * Serialize only the versioned telemetry allowlist. Unknown fields are never
 * emitted; forbidden fields anywhere in the input fail closed.
 */
export function serializeTelemetryEvent(input: unknown): string {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("telemetry event must be an object");
	}
	if (hasForbiddenKey(input)) throw new Error("telemetry event contains forbidden data");
	const value = input as EventInput;
	const event = requireString(value.event, "event");
	if (!EVENT_NAMES.has(event)) throw new Error("invalid telemetry event");
	const installId = requireString(value.installId, "installId");
	if (!UUID_V4.test(installId)) throw new Error("invalid telemetry installId");
	const occurredAt = requireString(value.occurredAt, "occurredAt");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
		throw new Error("invalid telemetry occurredAt");
	}

	const output: TelemetryEvent = {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		event: event as TelemetryEventName,
		installId,
		occurredAt,
	};
	if (value.channel !== undefined) {
		if (typeof value.channel !== "string" || !CHANNELS.has(value.channel))
			throw new Error("invalid telemetry channel");
		output.channel = value.channel as TelemetryEvent["channel"];
	}
	if (value.result !== undefined) {
		if (typeof value.result !== "string" || !RESULTS.has(value.result)) throw new Error("invalid telemetry result");
		output.result = value.result as TelemetryEvent["result"];
	}
	if (value.installMethod !== undefined) {
		if (typeof value.installMethod !== "string" || !INSTALL_METHODS.has(value.installMethod)) {
			throw new Error("invalid telemetry installMethod");
		}
		output.installMethod = value.installMethod as TelemetryEvent["installMethod"];
	}
	return `${JSON.stringify(output)}\n`;
}

async function publishNewInstallId(filePath: string, installId: string): Promise<void> {
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	let handle: fs.FileHandle | undefined;
	let stagedIdentity: BigIntStats | undefined;
	let cleanupScheduled = false;
	try {
		handle = await fs.open(tempPath, "wx", 0o600);
		await handle.writeFile(`${installId}\n`, "utf8");
		await handle.sync();
		stagedIdentity = await handle.stat({ bigint: true });
	} finally {
		await handle?.close().catch(() => undefined);
		if (stagedIdentity === undefined) {
			const failedIdentity = await fs.lstat(tempPath, { bigint: true }).catch(() => undefined);
			if (failedIdentity !== undefined) {
				const failedContent = (await readStagedContentBounded(tempPath)) ?? "";
				scheduleExactStagedCleanup(tempPath, failedIdentity, failedContent);
				cleanupScheduled = true;
			}
		}
	}
	try {
		try {
			await fs.link(tempPath, filePath);
		} catch (error) {
			if (isHardLinkUnsupported(error)) {
				const unsupported = new Error("exclusive hard links are unavailable") as NodeJS.ErrnoException;
				unsupported.code = "EUNSUPPORTED";
				throw unsupported;
			}
			throw error;
		}
		try {
			stagedIdentity = await fs.lstat(tempPath, { bigint: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await syncDirectory(path.dirname(filePath));
		if (stagedIdentity === undefined) throw claimRaceError();
		let published: PersistedInstallIdSnapshot;
		try {
			published = await readPublishedInstallIdSnapshot(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw claimRaceError();
			throw error;
		}
		if (
			published.value !== installId ||
			published.stat.dev !== stagedIdentity.dev ||
			published.stat.ino !== stagedIdentity.ino ||
			published.stat.size !== stagedIdentity.size ||
			published.stat.mtimeNs !== stagedIdentity.mtimeNs
		)
			throw claimRaceError();
	} finally {
		if (stagedIdentity !== undefined && !cleanupScheduled)
			scheduleExactStagedCleanup(tempPath, stagedIdentity, `${installId}\n`);
	}
}

function scheduleExactStagedCleanup(filePath: string, identity: BigIntStats, content: string): void {
	natives.exactUnlinkDirectDetached(filePath, {
		dev: identity.dev,
		ino: identity.ino,
		nlink: identity.nlink,
		size: identity.size,
		mtimeNs: identity.mtimeNs,
		sha256: hashClaimBytes(content),
		allowHardLink: true,
		quarantineName: `.${path.basename(filePath)}.${randomUUID()}.quarantine`,
	});
}

function isHardLinkUnsupported(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "EPERM" || code === "ENOSYS";
}

function isAtomicPublicationUnsupported(result: NativeNoReplaceResult): boolean {
	return result.code === "atomic_unavailable" || result.reason === "atomic_unavailable";
}

async function publishNoReplace(
	sourcePath: string,
	destinationPath: string,
): Promise<{ result: NativeNoReplaceResult; sourceRetained: boolean }> {
	const renamed = await natives.renameNoReplacePathAsync(sourcePath, destinationPath);
	if (!isAtomicPublicationUnsupported(renamed)) return { result: renamed, sourceRetained: false };
	const linked = await natives.linkNoReplacePathAsync(sourcePath, destinationPath);
	if (!isAtomicPublicationUnsupported(linked)) return { result: linked, sourceRetained: linked.ok };
	const unsupported = new Error("atomic no-replace publication is unavailable") as NodeJS.ErrnoException;
	unsupported.code = "EUNSUPPORTED";
	throw unsupported;
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(directory, "r");
	} catch (error) {
		if (isUnsupportedDirectorySync(error)) return;
		throw error;
	}
	try {
		try {
			await handle.sync();
		} catch (error) {
			if (!isUnsupportedDirectorySync(error)) throw error;
		}
	} finally {
		await handle.close();
	}
}

async function openRegularFileNoFollow(
	filePath: string,
	flags: number,
	failureMessage: string,
	failureCode?: string,
): Promise<fs.FileHandle> {
	let named: BigIntStats | undefined;
	if (process.platform === "win32") {
		named = await fs.lstat(filePath, { bigint: true });
		if (!named.isFile()) {
			const error = new Error(failureMessage) as NodeJS.ErrnoException;
			if (failureCode !== undefined) error.code = failureCode;
			throw error;
		}
	}
	const handle = await fs.open(filePath, flags);
	if (named === undefined) return handle;
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw claimRaceError();
		return handle;
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function openInstallIdFile(filePath: string, flags: number): Promise<fs.FileHandle> {
	return openRegularFileNoFollow(filePath, flags, "telemetry install ID is malformed");
}

async function openClaimFile(claimPath: string, flags: number): Promise<fs.FileHandle> {
	return openRegularFileNoFollow(claimPath, flags, "telemetry install ID claim is nonregular", "ECLAIMNONREGULAR");
}

async function syncFile(filePath: string, expected?: BigIntStats): Promise<void> {
	const handle = await openInstallIdFile(filePath, INSTALL_ID_WRITE_FLAGS);
	try {
		const stat = await handle.stat({ bigint: true });
		if (
			expected !== undefined &&
			(stat.dev !== expected.dev ||
				stat.ino !== expected.ino ||
				stat.size !== expected.size ||
				stat.mtimeNs !== expected.mtimeNs)
		)
			throw claimRaceError();
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function chmodWinner(filePath: string, expected: BigIntStats): Promise<boolean> {
	let handle: fs.FileHandle;
	let readOnly = false;
	try {
		handle = await openInstallIdFile(filePath, INSTALL_ID_WRITE_FLAGS);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
		handle = await openInstallIdFile(filePath, INSTALL_ID_READ_FLAGS);
		readOnly = true;
	}
	try {
		const opened = await handle.stat({ bigint: true });
		if (
			opened.dev !== expected.dev ||
			opened.ino !== expected.ino ||
			opened.size !== expected.size ||
			opened.mtimeNs !== expected.mtimeNs
		)
			return false;
		await handle.chmod(0o600);
		if (readOnly) {
			await handle.close();
			handle = await openInstallIdFile(filePath, INSTALL_ID_WRITE_FLAGS);
			const reopened = await handle.stat({ bigint: true });
			if (reopened.dev !== expected.dev || reopened.ino !== expected.ino) return false;
		}
		await handle.sync();
		const settled = await handle.stat({ bigint: true });
		return (
			settled.dev === expected.dev &&
			settled.ino === expected.ino &&
			settled.size === expected.size &&
			settled.mtimeNs === expected.mtimeNs &&
			(process.platform === "win32" || (settled.mode & 0o777n) === 0o600n)
		);
	} finally {
		await handle.close();
	}
}

async function tightenInstallIdPermissions(filePath: string, expectedValue: string): Promise<void> {
	try {
		const snapshot = await readPublishedInstallIdSnapshot(filePath);
		if (snapshot.value !== expectedValue || !(await chmodWinner(filePath, snapshot.stat))) throw claimRaceError();
		const settled = await readPublishedInstallIdSnapshot(filePath);
		if (
			settled.value !== expectedValue ||
			settled.stat.dev !== snapshot.stat.dev ||
			settled.stat.ino !== snapshot.stat.ino ||
			settled.stat.size !== snapshot.stat.size ||
			settled.stat.mtimeNs !== snapshot.stat.mtimeNs
		)
			throw claimRaceError();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw claimRaceError();
		throw error;
	}
}

function isUnsupportedDirectorySync(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

type PersistedInstallIdSnapshot = { value: string; stat: BigIntStats };

async function readPublishedInstallIdSnapshot(filePath: string): Promise<PersistedInstallIdSnapshot> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await openInstallIdFile(filePath, INSTALL_ID_READ_FLAGS);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile() || stat.size > BigInt(INSTALL_ID_MAX_SERIALIZED_BYTES))
			throw new Error("telemetry install ID is malformed");
		const bytes = Buffer.alloc(Number(stat.size));
		let offset = 0;
		while (offset < bytes.length) {
			const result = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (result.bytesRead <= 0) throw new Error("telemetry install ID is malformed");
			offset += result.bytesRead;
		}
		const settled = await handle.stat({ bigint: true });
		if (settled.size !== stat.size) throw claimRaceError();
		if (settled.size > BigInt(INSTALL_ID_MAX_SERIALIZED_BYTES)) throw new Error("telemetry install ID is malformed");
		const verification = Buffer.alloc(Number(settled.size));
		let verificationOffset = 0;
		while (verificationOffset < verification.length) {
			const result = await handle.read(
				verification,
				verificationOffset,
				verification.length - verificationOffset,
				verificationOffset,
			);
			if (result.bytesRead <= 0) throw claimRaceError();
			verificationOffset += result.bytesRead;
		}
		if (!verification.equals(bytes)) throw claimRaceError();
		const named = await fs.lstat(filePath, { bigint: true });
		if (
			settled.dev !== stat.dev ||
			settled.ino !== stat.ino ||
			settled.size !== stat.size ||
			settled.mtimeNs !== stat.mtimeNs ||
			named.dev !== settled.dev ||
			named.ino !== settled.ino
		)
			throw claimRaceError();
		const existing = bytes.toString("utf8").trim();
		if (!UUID_V4.test(existing)) throw new Error("telemetry install ID is malformed");
		return { value: existing, stat: settled };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("telemetry install ID is malformed");
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function readPublishedInstallId(filePath: string): Promise<string> {
	return (await readPublishedInstallIdSnapshot(filePath)).value;
}

async function readStagedContentBounded(filePath: string): Promise<string | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await openRegularFileNoFollow(filePath, INSTALL_ID_READ_FLAGS, "telemetry staged file is nonregular");
		const identity = await handle.stat({ bigint: true });
		if (!identity.isFile() || identity.size > BigInt(CLAIM_MAX_SERIALIZED_BYTES)) return undefined;
		const bytes = await readClaimHandleBounded(handle, identity.size);
		const settled = await handle.stat({ bigint: true });
		const named = await fs.lstat(filePath, { bigint: true });
		if (
			settled.dev !== identity.dev ||
			settled.ino !== identity.ino ||
			settled.size !== identity.size ||
			settled.mtimeNs !== identity.mtimeNs ||
			named.dev !== settled.dev ||
			named.ino !== settled.ino ||
			named.size !== settled.size ||
			named.mtimeNs !== settled.mtimeNs
		)
			return undefined;
		return bytes;
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function readExistingInstallId(filePath: string): Promise<string> {
	const deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS;
	while (true) {
		try {
			return await readExistingInstallIdSnapshot(filePath);
		} catch (error) {
			if (error instanceof Error && error.message === "telemetry install ID is malformed") {
				const stat = await fs.lstat(filePath, { bigint: true });
				if (Date.now() - Number(stat.mtimeMs) > INSTALL_ID_PARTIAL_GRACE_MS) throw error;
				if (performance.now() >= deadline) throw error;
				await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
				continue;
			}
			if ((error as NodeJS.ErrnoException).code !== "ECLAIMRACE") throw error;
			if (performance.now() >= deadline) throw new Error("telemetry install ID claim did not clear");
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
		}
	}
}

async function readExistingInstallIdSnapshot(filePath: string): Promise<string> {
	const claimPath = `${filePath}.lock`;
	const claimBefore = await readClaimIdentity(claimPath);
	let fileMissing = false;
	let malformed: Error | undefined;
	try {
		await readPublishedInstallId(filePath);
		const claimAfter = await readClaimIdentity(claimPath);
		if (claimBefore?.state === "publishing" && UUID_V4.test(claimBefore.token) && claimAfter?.state === undefined)
			throw claimLostError();
		if (claimBefore === undefined && claimAfter === undefined)
			return readPublishedInstallIdWhenUnclaimed(filePath, claimPath);
		if (claimBefore !== undefined && claimAfter === undefined)
			return readPublishedInstallIdWhenUnclaimed(filePath, claimPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") fileMissing = true;
		else if (error instanceof Error && error.message === "telemetry install ID is malformed") malformed = error;
		else throw error;
	}
	const activeClaim = await readClaimIdentity(claimPath);
	if (activeClaim === undefined) {
		if (malformed !== undefined) throw malformed;
		if (fileMissing) {
			const missing = new Error("telemetry install ID is missing") as NodeJS.ErrnoException;
			missing.code = "ENOENT";
			throw missing;
		}
		return readPublishedInstallIdWhenUnclaimed(filePath, claimPath);
	}
	if (claimBefore === undefined && activeClaim.state === undefined) throw claimLostError();
	await waitForClaimRelease(claimPath);
	return readPublishedInstallIdWhenUnclaimed(filePath, claimPath);
}

type ClaimState = "publishing" | "committed" | undefined;
type ClaimIdentity = {
	dev: bigint;
	ino: bigint;
	mtimeMs: number;
	size: bigint;
	digest: string;
	token: string;
	state: ClaimState;
	expiresAt: number | undefined;
};

async function readClaimIdentity(claimPath: string): Promise<ClaimIdentity | undefined> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await openClaimFile(claimPath, INSTALL_ID_READ_FLAGS);
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile()) {
			const error = new Error("telemetry install ID claim is nonregular") as NodeJS.ErrnoException;
			error.code = "ECLAIMNONREGULAR";
			throw error;
		}
		if (stat.size > BigInt(CLAIM_MAX_SERIALIZED_BYTES)) {
			const error = new Error("telemetry install ID claim is oversized") as NodeJS.ErrnoException;
			error.code = "ECLAIMOVERSIZE";
			throw error;
		}
		const content = await readClaimHandleBounded(handle, stat.size);
		const settled = await handle.stat({ bigint: true });
		const named = await fs.lstat(claimPath, { bigint: true });
		const verified = await readClaimHandleBounded(handle, settled.size);
		const final = await handle.stat({ bigint: true });
		const finalNamed = await fs.lstat(claimPath, { bigint: true });
		if (
			settled.dev !== stat.dev ||
			settled.ino !== stat.ino ||
			settled.size !== stat.size ||
			settled.mtimeNs !== stat.mtimeNs ||
			named.ino !== settled.ino ||
			hashClaimBytes(content) !== hashClaimBytes(verified) ||
			final.dev !== settled.dev ||
			final.ino !== settled.ino ||
			final.size !== settled.size ||
			final.mtimeNs !== settled.mtimeNs ||
			finalNamed.dev !== final.dev ||
			finalNamed.ino !== final.ino ||
			finalNamed.size !== final.size ||
			finalNamed.mtimeNs !== final.mtimeNs
		)
			throw claimRaceError();
		const parsed = parseClaim(content);
		return {
			dev: settled.dev,
			ino: settled.ino,
			mtimeMs: Number(settled.mtimeMs),
			size: settled.size,
			digest: hashClaimBytes(content),
			token: parsed.token,
			state: parsed.state,
			expiresAt: parsed.expiresAt,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function hashClaimBytes(content: string): string {
	const hash = new Bun.CryptoHasher("sha256");
	hash.update(content);
	return hash.digest("hex");
}

type ClaimSnapshot = { stat: BigIntStats; content: string; digest: string };

async function readClaimSnapshot(claimPath: string): Promise<ClaimSnapshot> {
	const handle = await openClaimFile(claimPath, INSTALL_ID_READ_FLAGS);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile()) throw new Error("telemetry install ID claim is nonregular");
		if (opened.size > BigInt(CLAIM_MAX_SERIALIZED_BYTES)) {
			const error = new Error("telemetry install ID claim is oversized") as NodeJS.ErrnoException;
			error.code = "ECLAIMOVERSIZE";
			throw error;
		}
		const content = await readClaimHandleBounded(handle, opened.size);
		const settled = await handle.stat({ bigint: true });
		const named = await fs.lstat(claimPath, { bigint: true });
		if (
			settled.dev !== opened.dev ||
			settled.ino !== opened.ino ||
			settled.size !== opened.size ||
			settled.mtimeNs !== opened.mtimeNs ||
			named.dev !== settled.dev ||
			named.ino !== settled.ino
		)
			throw claimRaceError();
		return { stat: settled, content, digest: hashClaimBytes(content) };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function readClaimHandleBounded(handle: fs.FileHandle, size: bigint): Promise<string> {
	const length = Number(size > BigInt(CLAIM_MAX_SERIALIZED_BYTES) ? BigInt(CLAIM_MAX_SERIALIZED_BYTES) : size);
	const buffer = Buffer.alloc(length);
	let offset = 0;
	const position = Number(size) - length;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (bytesRead <= 0) throw claimRaceError();
		offset += bytesRead;
	}
	return buffer.toString("utf8");
}

function claimRaceError(): NodeJS.ErrnoException {
	const error = new Error("telemetry install ID claim changed during observation") as NodeJS.ErrnoException;
	error.code = "ECLAIMRACE";
	return error;
}

async function readPublishedInstallIdWhenUnclaimed(filePath: string, claimPath: string): Promise<string> {
	const deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS;
	while (true) {
		if (performance.now() >= deadline) throw new Error("telemetry install ID claim did not clear");
		const identity = await fs.lstat(filePath, { bigint: true });
		const identityKey = `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}`;
		let durability = durableInstallIdPaths.get(filePath);
		if (durability === undefined || durability.identity !== identityKey) {
			const promise = syncDirectory(path.dirname(filePath));
			durability = { identity: identityKey, promise };
			durableInstallIdPaths.set(filePath, durability);
			promise.catch(() => {
				if (durableInstallIdPaths.get(filePath)?.promise === promise) durableInstallIdPaths.delete(filePath);
			});
		}
		await durability.promise;
		try {
			await syncFile(filePath, identity);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES") {
				// A valid owner-read-only ID is repaired by the caller after this read.
			} else if (code === "ECLAIMRACE") {
				await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
				continue;
			} else throw error;
		}
		let value: string;
		try {
			value = await readPublishedInstallId(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ECLAIMRACE") {
				if (performance.now() >= deadline) throw new Error("telemetry install ID claim did not clear");
				await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
				continue;
			}
			if (!(error instanceof Error) || error.message !== "telemetry install ID is malformed") throw error;
			if (Date.now() - Number((await fs.lstat(filePath, { bigint: true })).mtimeMs) > INSTALL_ID_PARTIAL_GRACE_MS)
				throw error;
			if (performance.now() >= deadline) throw error;
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
			continue;
		}
		const after = await fs.lstat(filePath, { bigint: true });
		const afterKey = `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}`;
		if (afterKey !== identityKey) {
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
			continue;
		}
		try {
			if (await readClaimIdentity(claimPath)) {
				await waitForClaimRelease(claimPath);
				continue;
			}
			const finalIdentity = await fs.lstat(filePath, { bigint: true });
			const finalIdentityKey = `${finalIdentity.dev}:${finalIdentity.ino}:${finalIdentity.size}:${finalIdentity.mtimeNs}`;
			if (finalIdentityKey !== identityKey) {
				await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
				continue;
			}
			return value;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ECLAIMRACE" && code !== "ECLAIMLOST") throw error;
			if (performance.now() >= deadline) throw new Error("telemetry install ID claim did not clear");
		}
	}
}

async function readWinnerUnderOwnedClaim(filePath: string, claimPath: string, token: string): Promise<string> {
	const deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS;
	while (performance.now() < deadline) {
		const before = await fs.lstat(filePath, { bigint: true });
		let value: string;
		try {
			value = await readPublishedInstallIdWithPartialGrace(filePath, deadline);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ECLAIMRACE") throw error;
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
			continue;
		}
		try {
			await syncFile(filePath, before);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ECLAIMRACE") throw error;
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
			continue;
		}
		await syncDirectory(path.dirname(filePath));
		const after = await fs.lstat(filePath, { bigint: true });
		if (
			before.dev === after.dev &&
			before.ino === after.ino &&
			before.size === after.size &&
			before.mtimeNs === after.mtimeNs
		) {
			await assertClaimOwned(claimPath, token, "publishing");
			if (!(await chmodWinner(filePath, after))) {
				await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
				continue;
			}
			const permissionChecked = await fs.lstat(filePath, { bigint: true });
			if (
				permissionChecked.dev !== after.dev ||
				permissionChecked.ino !== after.ino ||
				permissionChecked.size !== after.size ||
				permissionChecked.mtimeNs !== after.mtimeNs
			)
				continue;
			await assertClaimOwned(claimPath, token, "publishing");
			return value;
		}
		await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
	}
	throw new Error("telemetry install ID claim did not clear");
}

async function readWinnerAfterCollision(filePath: string, claimPath: string, token: string): Promise<string> {
	try {
		return await readWinnerUnderOwnedClaim(filePath, claimPath, token);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw claimRaceError();
		throw error;
	}
}

async function readPublishedInstallIdWithPartialGrace(filePath: string, deadline: number): Promise<string> {
	while (true) {
		try {
			return await readPublishedInstallId(filePath);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "telemetry install ID is malformed") throw error;
			const stat = await fs.lstat(filePath, { bigint: true });
			if (Date.now() - Number(stat.mtimeMs) > INSTALL_ID_PARTIAL_GRACE_MS || performance.now() >= deadline)
				throw error;
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
		}
	}
}

async function refreshClaimLease(claimPath: string, token: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		const named = await fs.lstat(claimPath, { bigint: true });
		handle = await openClaimFile(claimPath, INSTALL_ID_WRITE_FLAGS);
		const opened = await handle.stat({ bigint: true });
		if (named.dev !== opened.dev || named.ino !== opened.ino) return;
		const content = await readClaimHandleBounded(handle, opened.size);
		const claim = parseClaim(content);
		if (claim.token !== token || claim.state === undefined) return;
		const contentDigest = hashClaimBytes(content);
		await handle.close();
		handle = await openClaimFile(claimPath, INSTALL_ID_WRITE_FLAGS);
		const reopened = await handle.stat({ bigint: true });
		if (
			reopened.dev !== opened.dev ||
			reopened.ino !== opened.ino ||
			reopened.size !== opened.size ||
			reopened.mtimeNs !== opened.mtimeNs ||
			hashClaimBytes(await readClaimHandleBounded(handle, reopened.size)) !== contentDigest
		)
			throw claimLostError();
		const record = Buffer.from(serializeClaim(token, claim.state, Date.now() + INSTALL_ID_CLAIM_LEASE_MS));
		await writeBoundedClaimRecord(handle, record, reopened.size);
		await handle.sync();
		await handle.utimes(new Date(), new Date());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function assertClaimOwned(
	claimPath: string,
	token: string,
	state: Exclude<ClaimState, undefined>,
): Promise<void> {
	const claim = await readClaimIdentity(claimPath);
	if (claim?.token === token && claim.state === state) return;
	const error = new Error("telemetry install ID claim ownership was lost") as NodeJS.ErrnoException;
	error.code = "ECLAIMLOST";
	throw error;
}

async function transitionClaimCommitted(claimPath: string, token: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		const before = await fs.lstat(claimPath, { bigint: true });
		handle = await openClaimFile(claimPath, INSTALL_ID_WRITE_FLAGS);
		const opened = await handle.stat({ bigint: true });
		if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("telemetry install ID claim changed");
		const content = await readClaimHandleBounded(handle, opened.size);
		const parsed = parseClaim(content);
		if (parsed.token !== token || parsed.state !== "publishing")
			throw new Error("telemetry install ID claim changed");
		const contentDigest = hashClaimBytes(content);
		await handle.close();
		handle = await openClaimFile(claimPath, INSTALL_ID_WRITE_FLAGS);
		const reopened = await handle.stat({ bigint: true });
		if (
			reopened.dev !== opened.dev ||
			reopened.ino !== opened.ino ||
			reopened.size !== opened.size ||
			reopened.mtimeNs !== opened.mtimeNs ||
			hashClaimBytes(await readClaimHandleBounded(handle, reopened.size)) !== contentDigest
		)
			throw new Error("telemetry install ID claim changed");
		const record = Buffer.from(serializeClaim(token, "committed", Date.now() + INSTALL_ID_CLAIM_LEASE_MS));
		await writeBoundedClaimRecord(handle, record, reopened.size);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ECLAIMRACE") throw claimLostError();
		throw error;
	} finally {
		await handle?.close();
	}
	await assertClaimOwned(claimPath, token, "committed");
}

async function syncClaimDurably(claimPath: string, token: string): Promise<void> {
	const handle = await openClaimFile(claimPath, INSTALL_ID_WRITE_FLAGS);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || parseClaim(await readClaimHandleBounded(handle, before.size)).token !== token)
			throw claimLostError();
		await handle.sync();
	} finally {
		await handle.close();
	}
	await assertClaimOwned(claimPath, token, "committed");
}

async function writeClaimRecord(handle: fs.FileHandle, record: Uint8Array, position: number): Promise<void> {
	let offset = 0;
	while (offset < record.byteLength) {
		const { bytesWritten } = await handle.write(record, offset, record.byteLength - offset, position + offset);
		if (bytesWritten <= 0) throw new Error("telemetry claim generation write made no progress");
		offset += bytesWritten;
	}
}

async function writeBoundedClaimRecord(handle: fs.FileHandle, record: Uint8Array, currentSize: bigint): Promise<void> {
	if (currentSize + BigInt(record.byteLength) <= BigInt(CLAIM_MAX_SERIALIZED_BYTES)) {
		await writeClaimRecord(handle, record, Number(currentSize));
		return;
	}
	await writeClaimRecord(handle, record, 0);
	await handle.sync();
	await handle.truncate(record.byteLength);
	await handle.sync();
}

function claimLostError(): NodeJS.ErrnoException {
	const error = new Error("telemetry install ID claim ownership was lost") as NodeJS.ErrnoException;
	error.code = "ECLAIMLOST";
	return error;
}

function parseClaim(content: string): { token: string; state: ClaimState; expiresAt: number | undefined } {
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	else lines.pop();
	for (const line of lines.reverse()) {
		const match = /^([^|\n]+)\|(publishing|committed)(?:\|(\d+))?$/.exec(line);
		if (match)
			return {
				token: match[1],
				state: match[2] as Exclude<ClaimState, undefined>,
				expiresAt: match[3] === undefined ? undefined : Number(match[3]),
			};
	}
	const [token, stateOrExpiry, expiryValue] = content.split("\n", 3);
	const state = stateOrExpiry === "publishing" || stateOrExpiry === "committed" ? stateOrExpiry : undefined;
	const expiry = state === undefined ? stateOrExpiry : expiryValue;
	const expiresAt = expiry === undefined ? undefined : Number(expiry);
	return { token, state, expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined };
}

function serializeClaim(token: string, state: Exclude<ClaimState, undefined>, expiresAt?: number): string {
	return `${token}|${state}${expiresAt === undefined ? "" : `|${expiresAt}`}\n`;
}

async function waitForClaimRelease(
	claimPath: string,
	expectedClaim: ClaimIdentity | undefined = undefined,
	deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS,
): Promise<void> {
	while (performance.now() < deadline) {
		try {
			const stat = await fs.stat(claimPath, { bigint: true });
			const claim = await readClaimIdentity(claimPath);
			if (
				expectedClaim !== undefined &&
				(claim === undefined ||
					claim.dev !== expectedClaim.dev ||
					claim.ino !== expectedClaim.ino ||
					claim.token !== expectedClaim.token ||
					claim.size !== expectedClaim.size ||
					claim.digest !== expectedClaim.digest)
			)
				throw claimLostError();
			const publishingExpired =
				claim?.state === "publishing" &&
				((claim.expiresAt !== undefined &&
					claim.expiresAt <= Date.now() - INSTALL_ID_CLAIM_LEASE_MS &&
					Date.now() - claim.mtimeMs > INSTALL_ID_CLAIM_TIMEOUT_MS) ||
					(claim.expiresAt === undefined && Date.now() - claim.mtimeMs > INSTALL_ID_CLAIM_TIMEOUT_MS));
			const committedStale =
				claim?.state === "committed" &&
				((claim.expiresAt !== undefined && claim.expiresAt <= Date.now()) ||
					(claim.expiresAt === undefined && Date.now() - claim.mtimeMs > INSTALL_ID_CLAIM_LEASE_MS));
			const malformedStale =
				claim !== undefined &&
				claim.state === undefined &&
				stat.size === 0n &&
				Date.now() - claim.mtimeMs > INSTALL_ID_CLAIM_TIMEOUT_MS;
			if (claim !== undefined && (publishingExpired || committedStale || malformedStale)) {
				await reclaimStaleClaim(claimPath, stat, claim);
				await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
				continue;
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			if (code === "ECLAIMRACE") {
				await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
				continue;
			}
			throw error;
		}
		await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
	}
	throw new Error("telemetry install ID claim did not clear");
}

async function convergeAfterClaim(filePath: string): Promise<string> {
	const deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS;
	while (performance.now() < deadline) {
		const claimPath = `${filePath}.lock`;
		let observed: ClaimIdentity | undefined;
		try {
			observed = await readClaimIdentity(claimPath);
			const expected = observed?.state === "publishing" ? observed : undefined;
			await waitForClaimRelease(claimPath, expected, deadline);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ECLAIMLOST" && code !== "ECLAIMRACE") throw error;
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
			continue;
		}
		try {
			return await readExistingInstallId(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			return await publishPortably(filePath, randomUUID());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ECLAIM" && code !== "EEXIST") throw error;
		}
	}
	throw new Error("telemetry install ID claim did not clear");
}

async function reclaimStaleClaim(claimPath: string, stat: BigIntStats, claim: ClaimIdentity): Promise<void> {
	if (!stat.isFile()) return;
	if (claim.state === "publishing") await syncDirectory(path.dirname(claimPath));
	const currentClaim = await readClaimIdentity(claimPath);
	if (
		currentClaim === undefined ||
		currentClaim.dev !== claim.dev ||
		currentClaim.ino !== claim.ino ||
		currentClaim.token !== claim.token ||
		currentClaim.size !== claim.size ||
		currentClaim.digest !== claim.digest ||
		currentClaim.state !== claim.state ||
		currentClaim.expiresAt !== claim.expiresAt ||
		((currentClaim.state === "publishing" || currentClaim.state === "committed") &&
			(currentClaim.expiresAt === undefined
				? Date.now() - currentClaim.mtimeMs <= INSTALL_ID_CLAIM_TIMEOUT_MS
				: currentClaim.expiresAt > Date.now()))
	)
		return;
	const snapshot = await readClaimSnapshot(claimPath);
	const finalClaim = parseClaim(snapshot.content);
	if (
		finalClaim.token !== claim.token ||
		finalClaim.state !== claim.state ||
		((finalClaim.state === "publishing" || finalClaim.state === "committed") &&
			finalClaim.expiresAt !== undefined &&
			finalClaim.expiresAt > Date.now())
	)
		return;
	const current = snapshot.stat;
	const currentMtimeMs = Number(current.mtimeMs);
	if (
		(finalClaim.state === "publishing" || finalClaim.state === "committed") &&
		(finalClaim.expiresAt === undefined
			? Date.now() - currentMtimeMs <= INSTALL_ID_CLAIM_TIMEOUT_MS
			: finalClaim.expiresAt > Date.now())
	)
		return;
	if (current.dev !== stat.dev || current.ino !== stat.ino) return;
	const cleanupDigest = snapshot.digest;
	const cleanupKey = `${claimPath}:${current.dev}:${current.ino}:${current.nlink}:${current.size}:${current.mtimeNs}:${cleanupDigest}:${claim.token}:${claim.state}:${claim.expiresAt ?? ""}`;
	if (scheduledClaimCleanups.has(cleanupKey)) return;
	scheduledClaimCleanups.add(cleanupKey);
	const releaseTimer = setTimeout(() => scheduledClaimCleanups.delete(cleanupKey), INSTALL_ID_CLAIM_TIMEOUT_MS);
	releaseTimer.unref();
	natives.exactUnlinkDirectDetached(claimPath, {
		dev: current.dev,
		ino: current.ino,
		nlink: current.nlink,
		size: current.size,
		mtimeNs: current.mtimeNs,
		sha256: cleanupDigest,
		allowHardLink: true,
		quarantineName: `.${path.basename(claimPath)}.${randomUUID()}.quarantine`,
	});
}

async function removeOwnedClaim(claimPath: string, token: string): Promise<void> {
	try {
		const snapshot = await readClaimSnapshot(claimPath);
		if (parseClaim(snapshot.content).token !== token) return;
		natives.exactUnlinkDirectDetached(claimPath, {
			dev: snapshot.stat.dev,
			ino: snapshot.stat.ino,
			nlink: snapshot.stat.nlink,
			size: snapshot.stat.size,
			mtimeNs: snapshot.stat.mtimeNs,
			sha256: snapshot.digest,
			allowHardLink: true,
			quarantineName: `.${path.basename(claimPath)}.${randomUUID()}.quarantine`,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function scheduleOwnedClaimCleanup(claimPath: string, token: string): void {
	const cleanupKey = `${claimPath}:${token}`;
	if (scheduledClaimCleanups.has(cleanupKey)) return;
	scheduledClaimCleanups.add(cleanupKey);
	void removeOwnedClaim(claimPath, token).catch(() => undefined);
	const releaseTimer = setTimeout(() => scheduledClaimCleanups.delete(cleanupKey), INSTALL_ID_CLAIM_TIMEOUT_MS);
	releaseTimer.unref();
}

async function createDirectClaim(claimPath: string, token: string): Promise<string> {
	const content = serializeClaim(token, "publishing", Date.now() + INSTALL_ID_CLAIM_LEASE_MS);
	const handle = await fs.open(claimPath, "wx", 0o600);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
		return content;
	} finally {
		await handle.close();
	}
}

async function publishInstallIdDirectly(filePath: string, installId: string): Promise<void> {
	const handle = await fs.open(filePath, "wx", 0o600);
	try {
		await handle.writeFile(`${installId}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(path.dirname(filePath));
}

async function publishWithClaim(filePath: string, installId: string): Promise<string> {
	const claimPath = `${filePath}.lock`;
	const token = randomUUID();
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	const claimTemporaryPath = `${claimPath}.${randomUUID()}.tmp`;
	let ownsClaim = false;
	let publishedFinal = false;
	let committed = false;
	let leaseTimer: NodeJS.Timeout | undefined;
	let heartbeat: Promise<void> = Promise.resolve();
	let heartbeatFailure: unknown;
	let heartbeatStopped = false;
	let claimTemporaryIdentity: BigIntStats | undefined;
	let claimTemporaryContent: string | undefined;
	let claimTemporaryCleanupScheduled = false;
	let temporaryIdentity: BigIntStats | undefined;
	let temporaryCleanupScheduled = false;
	let claim: fs.FileHandle;
	try {
		try {
			claim = await fs.open(claimTemporaryPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				const busy = new Error("telemetry install ID claim is busy") as NodeJS.ErrnoException;
				busy.code = "ECLAIM";
				throw busy;
			}
			throw error;
		}
		try {
			claimTemporaryContent = serializeClaim(token, "publishing", Date.now() + INSTALL_ID_CLAIM_LEASE_MS);
			await claim.writeFile(claimTemporaryContent, "utf8");
			await claim.sync();
			claimTemporaryIdentity = await claim.stat({ bigint: true });
		} finally {
			await claim.close();
		}
		let claimSourceRetained = true;
		try {
			const claimPublication = await publishNoReplace(claimTemporaryPath, claimPath);
			if (!claimPublication.result.ok) {
				if (
					claimPublication.result.code === "destination_exists" ||
					claimPublication.result.reason === "destination_exists"
				) {
					const busy = new Error("telemetry install ID claim is busy") as NodeJS.ErrnoException;
					busy.code = "ECLAIM";
					throw busy;
				}
				throw new Error(`telemetry install ID claim publication failed: ${claimPublication.result.reason}`);
			}
			claimSourceRetained = claimPublication.sourceRetained;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EUNSUPPORTED") throw error;
			try {
				await createDirectClaim(claimPath, token);
			} catch (directError) {
				if ((directError as NodeJS.ErrnoException).code === "EEXIST") {
					const busy = new Error("telemetry install ID claim is busy") as NodeJS.ErrnoException;
					busy.code = "ECLAIM";
					throw busy;
				}
				throw directError;
			}
		}
		if (!claimSourceRetained) claimTemporaryIdentity = undefined;
		ownsClaim = (await readClaimIdentity(claimPath))?.token === token;
		if (!ownsClaim) throw new Error("telemetry install ID claim changed");
		const scheduleHeartbeat = (): void => {
			if (heartbeatStopped) return;
			leaseTimer = setTimeout(() => {
				leaseTimer = undefined;
				heartbeat = refreshClaimLease(claimPath, token)
					.catch(error => {
						heartbeatFailure = error;
					})
					.finally(scheduleHeartbeat);
			}, INSTALL_ID_HEARTBEAT_INTERVAL_MS);
			leaseTimer.unref();
		};
		scheduleHeartbeat();
		try {
			return await readWinnerUnderOwnedClaim(filePath, claimPath, token);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(temporaryPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return await readWinnerAfterCollision(filePath, claimPath, token);
		}
		try {
			await handle.writeFile(`${installId}\n`, "utf8");
			await handle.sync();
			temporaryIdentity = await handle.stat({ bigint: true });
		} finally {
			await handle.close().catch(() => undefined);
		}
		heartbeatStopped = true;
		if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		await heartbeat;
		if (heartbeatFailure !== undefined) throw heartbeatFailure;
		await refreshClaimLease(claimPath, token);
		heartbeatStopped = false;
		scheduleHeartbeat();
		await assertClaimOwned(claimPath, token, "publishing");
		try {
			const publication = await publishNoReplace(temporaryPath, filePath);
			if (!publication.result.ok) {
				if (publication.result.code !== "destination_exists" && publication.result.reason !== "destination_exists")
					throw new Error(`telemetry install ID publication failed: ${publication.result.reason}`);
				return await readWinnerAfterCollision(filePath, claimPath, token);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EUNSUPPORTED") throw error;
			try {
				await publishInstallIdDirectly(filePath, installId);
			} catch (directError) {
				if ((directError as NodeJS.ErrnoException).code === "EEXIST")
					return await readWinnerAfterCollision(filePath, claimPath, token);
				throw directError;
			}
		}
		publishedFinal = true;
		await assertClaimOwned(claimPath, token, "publishing");
		await syncDirectory(path.dirname(filePath));
		heartbeatStopped = true;
		if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		await heartbeat;
		if (heartbeatFailure !== undefined) throw heartbeatFailure;
		await transitionClaimCommitted(claimPath, token);
		heartbeatStopped = false;
		scheduleHeartbeat();
		await syncClaimDurably(claimPath, token);
		heartbeatStopped = true;
		if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		await heartbeat;
		if (heartbeatFailure !== undefined) throw heartbeatFailure;
		committed = true;
		return installId;
	} finally {
		heartbeatStopped = true;
		if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		await heartbeat;
		if (claimTemporaryIdentity === undefined && claimTemporaryContent !== undefined) {
			const failedIdentity = await fs.lstat(claimTemporaryPath, { bigint: true }).catch(() => undefined);
			if (failedIdentity !== undefined) {
				const failedContent = (await readStagedContentBounded(claimTemporaryPath)) ?? "";
				scheduleExactStagedCleanup(claimTemporaryPath, failedIdentity, failedContent);
				claimTemporaryCleanupScheduled = true;
				claimTemporaryIdentity = failedIdentity;
			}
		}
		if (temporaryIdentity === undefined) {
			const failedIdentity = await fs.lstat(temporaryPath, { bigint: true }).catch(() => undefined);
			if (failedIdentity !== undefined) {
				const failedContent = (await readStagedContentBounded(temporaryPath)) ?? "";
				scheduleExactStagedCleanup(temporaryPath, failedIdentity, failedContent);
				temporaryCleanupScheduled = true;
				temporaryIdentity = failedIdentity;
			}
		}
		if (
			claimTemporaryIdentity !== undefined &&
			claimTemporaryContent !== undefined &&
			!claimTemporaryCleanupScheduled
		)
			scheduleExactStagedCleanup(claimTemporaryPath, claimTemporaryIdentity, claimTemporaryContent);
		if (temporaryIdentity !== undefined && !temporaryCleanupScheduled)
			scheduleExactStagedCleanup(temporaryPath, temporaryIdentity, `${installId}\n`);
		if (ownsClaim && (!publishedFinal || committed)) scheduleOwnedClaimCleanup(claimPath, token);
	}
}

async function publishPortably(filePath: string, installId: string): Promise<string> {
	try {
		await publishNewInstallId(filePath, installId);
		return installId;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EUNSUPPORTED") throw error;
		return publishWithClaim(filePath, installId);
	}
}

/** Load or create a random UUIDv4 that is not derived from machine data. */
export async function getTelemetryInstallId(
	filePath = getTrustedAgentFile(TELEMETRY_INSTALL_ID_FILE),
): Promise<string> {
	const deadline = performance.now() + INSTALL_ID_CLAIM_WAIT_TIMEOUT_MS;
	while (true) {
		try {
			return await getTelemetryInstallIdOnce(filePath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ECLAIMRACE" && code !== "ECLAIMLOST") throw error;
			if (performance.now() >= deadline) throw new Error("telemetry install ID claim did not clear");
			await Bun.sleep(INSTALL_ID_CLAIM_POLL_INITIAL_MS);
		}
	}
}

async function getTelemetryInstallIdOnce(filePath: string): Promise<string> {
	try {
		const existing = await readExistingInstallId(filePath);
		if (UUID_V4.test(existing)) {
			await tightenInstallIdPermissions(filePath, existing);
			return existing;
		}
		throw new Error("telemetry install ID is malformed");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const generated = randomUUID();
	try {
		const published = await publishPortably(filePath, generated);
		await tightenInstallIdPermissions(filePath, published);
		return published;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			const existing = await readExistingInstallId(filePath);
			await tightenInstallIdPermissions(filePath, existing);
			return existing;
		}
		if ((error as NodeJS.ErrnoException).code === "ECLAIM") {
			const existing = await convergeAfterClaim(filePath);
			await tightenInstallIdPermissions(filePath, existing);
			return existing;
		}
		throw error;
	}
}
