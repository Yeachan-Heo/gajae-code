import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
	NativeBrokerRestartIntent,
	NativeBrokerRestartIntentIdentity,
	NativeRetainedBrokerPublication,
	retainBrokerPublication as retainBrokerPublicationFn,
} from "@gajae-code/natives";
import { BROKER_ARTIFACT_PATHS, canonicalServiceRootDigest } from "../service-artifact-paths";

let nativeRetainBrokerPublicationFn: typeof retainBrokerPublicationFn | undefined;

function retainBrokerPublicationNative(
	...args: Parameters<typeof retainBrokerPublicationFn>
): NativeRetainedBrokerPublication {
	nativeRetainBrokerPublicationFn ??= (
		require("@gajae-code/natives") as { retainBrokerPublication: typeof retainBrokerPublicationFn }
	).retainBrokerPublication;
	return nativeRetainBrokerPublicationFn(...args);
}

import { processIncarnation } from "./process-incarnation";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "./state-version";

export type BrokerPublicationObservation = "owned" | "absent" | "replaced" | "ambiguous";
export interface RetainedBrokerDiscovery {
	observe(): BrokerPublicationObservation;
	observeAsync(): Promise<BrokerPublicationObservation>;
	heartbeat(heartbeatAt: number): Promise<boolean>;
	close(): void;
	/** Owner-side `prepared`: exclusively creates the durable restart-intent slot. */
	prepareRestartIntent(intent: NativeBrokerRestartIntent): Promise<boolean>;
	/** Owner-side `prepared` -> `committed`: rewrites the exact slot prepare created. */
	commitRestartIntent(intent: NativeBrokerRestartIntent): Promise<boolean>;
	/** Owner-side cancel of this process's own prepared/committed slot. */
	cancelRestartIntent(): Promise<boolean>;
	/** Successor-side clear of a predecessor's slot this process never prepared. */
	clearForeignRestartIntent(identity: NativeBrokerRestartIntentIdentity): Promise<boolean>;
}

/**
 * Objects retained broker publication authority opens, in the order and with
 * the access mode the native layer opens them. Every one is opened no-follow,
 * so a symlink or a missing entry withholds authority; the lock record is
 * opened read-only and only the published record read/write, so a
 * readable-but-unwritable lock record is not an obstruction.
 *
 * A wrong file kind is only ever reported through the open the native itself
 * would have failed: `O_DIRECTORY` refuses a non-directory, and the read/write
 * open of the published record refuses a directory with `EISDIR`. The kind is
 * never re-judged after a successful open, because the native layer does not --
 * it accepts, for example, a directory or a character device as the lock
 * record, and refuses a character-device published record only later, for its
 * missing heartbeat. Judging kind here would blame an object the native never
 * rejected and hide the real obstruction.
 */
const BROKER_PUBLICATION_OBJECTS = [
	{ name: "sdk", segments: ["sdk"], directory: true, write: false },
	{ name: "sdk/broker.lock", segments: ["sdk", "broker.lock"], directory: true, write: false },
	{
		name: "sdk/broker.lock/owner.json",
		segments: ["sdk", "broker.lock", "owner.json"],
		directory: false,
		write: false,
	},
	{ name: "sdk/broker.json", segments: ["sdk", "broker.json"], directory: false, write: true },
] as const;

/** Width the native layer requires of the published `heartbeatAt` field. */
const FIXED_WIDTH_HEARTBEAT_DIGITS = 13;

/** Bound on the published record the diagnostic will read through its descriptor. */
const MAX_DIAGNOSTIC_PUBLISHED_BYTES = 1 << 20;

/**
 * Bound on the agent directory in the failure message. Broker startup persists
 * a 512-character reason, and an unbounded directory would truncate away the
 * obstruction this diagnostic exists to report.
 */
const MAX_AGENT_DIR_IN_MESSAGE = 120;

function boundedAgentDir(agentDir: string): string {
	return agentDir.length <= MAX_AGENT_DIR_IN_MESSAGE
		? agentDir
		: `...${agentDir.slice(agentDir.length - (MAX_AGENT_DIR_IN_MESSAGE - 3))}`;
}

function sanitizedAgentDir(agentDir: string): string {
	const sanitized = agentDir.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, character => {
		const codePoint = character.codePointAt(0) ?? 0;
		return `\\u${codePoint.toString(16).padStart(4, "0")}`;
	});
	return boundedAgentDir(sanitized);
}

const NATIVE_RETAINED_FAILURE = /\[retained-publication object=([^;\]]+); reason=([^\]]+)\]$/;

function nativeRetainedObstruction(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const match = NATIVE_RETAINED_FAILURE.exec(error.message);
	if (!match) return undefined;
	const [, object, reason] = match;
	if (reason === "heartbeat-missing") return `${object} has no heartbeatAt field`;
	if (reason === "heartbeat-width")
		return `${object} heartbeatAt is not a fixed-width ${FIXED_WIDTH_HEARTBEAT_DIGITS}-digit timestamp`;
	if (reason === "non-regular") return `${object} is not a regular file`;
	if (reason === "errno-ENOENT") return `${object} is missing`;
	if (reason === "errno-EISDIR") return `${object} is not a regular file`;
	if (reason === "unsupported-platform") return "retained publication authority is not implemented on this platform";
	// The native reason names the stage that refused, so the prose must not
	// claim an open failed when the descriptor was already open: `errno-`/`io-`
	// come from the open itself, `read-` from reading the published record, and
	// `clone-`/`metadata` from inspecting an object already opened.
	if (reason.startsWith("errno-")) return `${object} could not be opened (${reason.slice("errno-".length)})`;
	if (reason.startsWith("io-")) return `${object} could not be opened (${reason.slice("io-".length)})`;
	if (reason.startsWith("read-")) return `${object} could not be read (${reason.slice("read-".length)})`;
	if (reason.startsWith("clone-")) return `${object} could not be inspected (${reason.slice("clone-".length)})`;
	if (reason === "metadata") return `${object} could not be inspected`;
	if (reason.startsWith("metadata-")) return `${object} could not be inspected (${reason.slice("metadata-".length)})`;
	return `${object} withheld publication authority (${reason})`;
}

/**
 * Name the first condition the published record itself violates, reading only
 * through the descriptor the no-follow open already verified. Reopening by
 * pathname would let a replacement in that window redirect the diagnostic to a
 * different object, or block on a name that is no longer a regular file.
 */
function describeWithheldPublishedRecord(descriptor: number, size: number): string | undefined {
	if (size > MAX_DIAGNOSTIC_PUBLISHED_BYTES) return undefined;
	const bytes = Buffer.alloc(Math.min(MAX_DIAGNOSTIC_PUBLISHED_BYTES, Math.max(size, 4096)));
	let read = 0;
	try {
		while (read < bytes.length) {
			const count = fsSync.readSync(descriptor, bytes, read, bytes.length - read, read);
			if (count === 0) break;
			read += count;
		}
	} catch (error) {
		return `sdk/broker.json could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
	}
	let hasMore = false;
	if (read === bytes.length) {
		try {
			hasMore = fsSync.readSync(descriptor, Buffer.alloc(1), 0, 1, read) > 0;
		} catch {
			return undefined;
		}
	}
	// latin1 keeps one character per byte, so offsets match the native's byte scan.
	const published = bytes.subarray(0, read).toString("latin1");
	const needle = '"heartbeatAt":';
	const at = published.indexOf(needle);
	// A record larger than this bounded read is inconclusive, never an absence.
	if (at < 0) return hasMore ? undefined : "sdk/broker.json has no heartbeatAt field";
	const digits = published.slice(at + needle.length, at + needle.length + FIXED_WIDTH_HEARTBEAT_DIGITS);
	const next = published.charAt(at + needle.length + FIXED_WIDTH_HEARTBEAT_DIGITS);
	if (!/^[0-9]{13}$/.test(digits) || /^[0-9]$/.test(next))
		return `sdk/broker.json heartbeatAt is not a fixed-width ${FIXED_WIDTH_HEARTBEAT_DIGITS}-digit timestamp`;
	return undefined;
}

function isSymbolicLink(pathname: string): boolean {
	try {
		return fsSync.lstatSync(pathname).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Name the first condition that withholds retained publication authority.
 *
 * The native layer reports withheld authority as one opaque failure, so a
 * broker that cannot retain its own publication dies without naming the object
 * responsible. Operators then cannot distinguish a missing lock record from a
 * redirected `sdk` directory (a symlinked agent-directory entry is refused by
 * the no-follow open, which is how shared multi-account layouts fail), and the
 * only way to learn the precondition is to read the native source.
 *
 * This inspects the same objects in the same order and returns a description of
 * the first obstruction, or `undefined` when every precondition holds and the
 * refusal came from a race the caller must still fail closed on.
 */
function describeWithheldPublicationAuthority(agentDir: string): string | undefined {
	for (const object of BROKER_PUBLICATION_OBJECTS) {
		const pathname = path.join(agentDir, ...object.segments);
		// O_NONBLOCK keeps the diagnostic itself from parking on an object that is
		// no longer a regular file; the following fstat still names the wrong kind.
		const flags = object.directory
			? fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW
			: (object.write ? fsSync.constants.O_RDWR : fsSync.constants.O_RDONLY) |
				fsSync.constants.O_NOFOLLOW |
				fsSync.constants.O_NONBLOCK;
		let descriptor: number;
		try {
			descriptor = fsSync.openSync(pathname, flags);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return `${object.name} is missing`;
			// A refused open is already authoritative; this only labels it. Linux
			// answers a no-follow directory open on a symlink with ENOTDIR rather
			// than ELOOP, so the entry kind decides between the two labels.
			if (code === "ELOOP" || code === "ENOTDIR") {
				if (isSymbolicLink(pathname))
					return `${object.name} is a symlink; every publication object is opened no-follow`;
				if (code === "ENOTDIR" && object.directory) return `${object.name} is not a directory`;
			}
			if (code === "EISDIR") return `${object.name} is not a regular file`;
			return `${object.name} could not be opened (${code ?? "unknown error"})`;
		}
		try {
			// The published record is the last precondition: the native layer edits
			// the heartbeat in place and therefore requires a fixed-width field. It is
			// read through this verified descriptor, never reopened by name.
			if (object.write) return describeWithheldPublishedRecord(descriptor, fsSync.fstatSync(descriptor).size);
		} catch (error) {
			return `${object.name} could not be inspected (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
		} finally {
			try {
				fsSync.closeSync(descriptor);
			} catch {
				// Closing a diagnostic-only descriptor is best effort; the native refusal
				// remains the authoritative error when this probe itself is inconclusive.
			}
		}
	}
	return undefined;
}

function requireRetainedBrokerPublication(agentDir: string): NativeRetainedBrokerPublication {
	try {
		return retainBrokerPublicationNative(agentDir);
	} catch (error) {
		// Fail closed exactly as before; only name the condition on the way out.
		const obstruction = nativeRetainedObstruction(error);
		if (obstruction) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)} (${obstruction}; agent directory ${sanitizedAgentDir(agentDir)})`,
				{ cause: error },
			);
		}
		const observed = describeWithheldPublicationAuthority(agentDir);
		if (!observed) throw error;
		// The obstruction precedes the agent directory, and the directory is
		// bounded, so a long valid path cannot truncate the named object away.
		throw new Error(
			`${error instanceof Error ? error.message : String(error)} (current observed state: ${observed}; agent directory ${sanitizedAgentDir(agentDir)})`,
			{ cause: error },
		);
	}
}

async function rollbackPublishedBrokerDiscovery(agentDir: string, discovery: BrokerDiscovery): Promise<void> {
	const file = brokerDiscoveryPath(agentDir);
	try {
		const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		if (
			!raw ||
			typeof raw !== "object" ||
			(raw as BrokerDiscovery).ownerId !== discovery.ownerId ||
			(raw as BrokerDiscovery).pid !== discovery.pid ||
			(raw as BrokerDiscovery).incarnation !== discovery.incarnation ||
			(raw as BrokerDiscovery).token !== discovery.token ||
			(raw as BrokerDiscovery).startedAt !== discovery.startedAt ||
			(raw as BrokerDiscovery).heartbeatAt !== discovery.heartbeatAt
		)
			return;
		await fs.unlink(file);
		await syncDirectory(path.dirname(file));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

class NativeRetainedBrokerDiscovery implements RetainedBrokerDiscovery {
	#closed = false;
	#publication: NativeRetainedBrokerPublication;
	constructor(publication: NativeRetainedBrokerPublication) {
		this.#publication = publication;
	}
	observe(): BrokerPublicationObservation {
		if (this.#closed) return "ambiguous";
		const kind = this.#publication.observe().kind;
		return kind === "owned" || kind === "absent" || kind === "replaced" || kind === "ambiguous" ? kind : "ambiguous";
	}
	async observeAsync(): Promise<BrokerPublicationObservation> {
		if (this.#closed) return "ambiguous";
		const kind = (await this.#publication.observeAsync()).kind;
		return kind === "owned" || kind === "absent" || kind === "replaced" || kind === "ambiguous" ? kind : "ambiguous";
	}
	/**
	 * The positional write and its fsync run on the libuv blocking pool, never on
	 * the JS thread. Both are unbounded -- an fsync returns when the device says so
	 * -- and on the JS thread a wedged filesystem would stop the publication
	 * watchdog, signal handling, and broker completion along with the write it is
	 * blocking, leaving a process that cannot even notice it stopped publishing
	 * (#4704).
	 */
	async heartbeat(heartbeatAt: number): Promise<boolean> {
		if (this.#closed || !isFixedWidthHeartbeat(heartbeatAt)) return false;
		const write = await this.#publication.heartbeatAsync(String(heartbeatAt));
		if (write.kind !== "written") return false;
		return (await this.#publication.syncAsync()).kind === "synced";
	}
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#publication.close();
	}
	async prepareRestartIntent(intent: NativeBrokerRestartIntent): Promise<boolean> {
		if (this.#closed || !isValidRestartToken(intent.requestId) || !isValidRestartToken(intent.lease)) return false;
		return (await this.#publication.prepareRestartIntentAsync(intent)).kind === "written";
	}
	async commitRestartIntent(intent: NativeBrokerRestartIntent): Promise<boolean> {
		if (this.#closed || !isValidRestartToken(intent.requestId) || !isValidRestartToken(intent.lease)) return false;
		return (await this.#publication.commitRestartIntentAsync(intent)).kind === "written";
	}
	async cancelRestartIntent(): Promise<boolean> {
		if (this.#closed) return false;
		return (await this.#publication.cancelRestartIntentAsync()).kind === "cancelled";
	}
	async clearForeignRestartIntent(identity: NativeBrokerRestartIntentIdentity): Promise<boolean> {
		if (this.#closed) return false;
		return (await this.#publication.clearRestartIntentAsync(identity)).kind === "cleared";
	}
}

function isValidRestartToken(value: string): boolean {
	return /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

class LegacyWindowsBrokerDiscovery implements RetainedBrokerDiscovery {
	#closed = false;
	#discovery: BrokerDiscovery;
	#agentDir: string;
	constructor(agentDir: string, discovery: BrokerDiscovery) {
		this.#agentDir = agentDir;
		this.#discovery = discovery;
	}
	observe(): BrokerPublicationObservation {
		return this.#closed ? "ambiguous" : "owned";
	}
	async observeAsync(): Promise<BrokerPublicationObservation> {
		return this.observe();
	}
	async heartbeat(heartbeatAt: number): Promise<boolean> {
		if (this.#closed || !isFixedWidthHeartbeat(heartbeatAt)) return false;
		const next = { ...this.#discovery, heartbeatAt };
		await writeBrokerDiscovery(this.#agentDir, next);
		this.#discovery = next;
		return true;
	}
	async prepareRestartIntent(_intent: NativeBrokerRestartIntent): Promise<boolean> {
		return false;
	}
	async commitRestartIntent(_intent: NativeBrokerRestartIntent): Promise<boolean> {
		return false;
	}
	async cancelRestartIntent(): Promise<boolean> {
		return false;
	}
	async clearForeignRestartIntent(_identity: NativeBrokerRestartIntentIdentity): Promise<boolean> {
		return false;
	}
	close(): void {
		this.#closed = true;
	}
}

function isFixedWidthHeartbeat(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1_000_000_000_000 && value <= 9_999_999_999_999;
}

export const BROKER_HEARTBEAT_TTL_MS = 15_000;
export interface BrokerDiscovery {
	version: typeof SDK_STATE_VERSION;
	protocolVersion: 3;
	packageGeneration: string;
	/**
	 * The runtime image this broker launches internal SDK processes with. Present
	 * whenever the publisher could classify its own runtime, including when that
	 * image was already gone at publication time -- absence is the reader's
	 * verdict to reach, not a reason to publish nothing. Absent only for records
	 * written before this field existed and for a publisher whose runtime
	 * evidence could not be classified at all; readers then reuse the broker as
	 * before rather than retiring it on unknown evidence.
	 */
	runtime?: string;
	ownerId: string;
	pid: number;
	incarnation: string;
	host: "127.0.0.1";
	port: number;
	url: string;
	token: string;
	startedAt: number;
	heartbeatAt: number;
	restartRequestId?: string;
	rootDigest?: string;
}
export interface BrokerRestartIntent {
	requestId: string;
	lease: string;
	expiresAt: number;
	phase?: "prepared" | "committed" | "cancelled";
}
export type RedactedBrokerDiscovery = Omit<BrokerDiscovery, "token"> & { token: "[redacted]" };
export type BrokerDiscoveryWrite = Omit<BrokerDiscovery, "incarnation"> & { incarnation?: string };
export const brokerDiscoveryPath = (agentDir: string) => path.join(agentDir, BROKER_ARTIFACT_PATHS.discovery);
export const newBrokerToken = () => randomBytes(32).toString("hex");
export const brokerProcessIncarnation = processIncarnation;
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
async function syncFile(file: string): Promise<void> {
	const handle = await fs.open(file, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(directory, "r");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return;
		throw error;
	}
	try {
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error;
	} finally {
		await handle.close();
	}
}
export async function writeBrokerDiscovery(agentDir: string, discovery: BrokerDiscoveryWrite): Promise<void> {
	const incarnation = discovery.incarnation ?? brokerProcessIncarnation(discovery.pid);
	if (!incarnation) throw new Error(`Broker process incarnation is unavailable for pid ${discovery.pid}.`);
	if (!isFixedWidthHeartbeat(discovery.heartbeatAt)) {
		throw new Error("Broker heartbeatAt must be a fixed-width 13-digit millisecond timestamp.");
	}
	const file = brokerDiscoveryPath(agentDir);
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.chmod(dir, 0o700);
	const record: BrokerDiscovery = {
		...discovery,
		incarnation,
		rootDigest: await canonicalServiceRootDigest(agentDir),
	};
	const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		await fs.chmod(temp, 0o600);
		await syncFile(temp);
		await fs.rename(temp, file);
		await syncDirectory(dir);
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/** Publish once by name, then retain no-follow native authority for recurring heartbeats. */
export async function publishBrokerDiscovery(
	agentDir: string,
	discovery: BrokerDiscoveryWrite,
	platform: NodeJS.Platform = process.platform,
): Promise<RetainedBrokerDiscovery> {
	const incarnation = discovery.incarnation ?? brokerProcessIncarnation(discovery.pid);
	if (!incarnation) throw new Error(`Broker process incarnation is unavailable for pid ${discovery.pid}.`);
	await writeBrokerDiscovery(agentDir, { ...discovery, incarnation });
	const published: BrokerDiscovery = {
		...discovery,
		incarnation,
		rootDigest: await canonicalServiceRootDigest(agentDir),
	};
	if (platform === "win32") return new LegacyWindowsBrokerDiscovery(agentDir, published);
	try {
		return new NativeRetainedBrokerDiscovery(requireRetainedBrokerPublication(agentDir));
	} catch (error) {
		try {
			await rollbackPublishedBrokerDiscovery(agentDir, published);
		} catch (rollbackError) {
			// The aggregate message is the only thing the durable startup-failure
			// marker persists (`AggregateError.errors` is not serialized), so the named
			// obstruction has to survive into it rather than only into `errors[0]`.
			throw new AggregateError(
				[error, rollbackError],
				`Broker publication authority acquisition and exact rollback both failed. Acquisition: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		throw error;
	}
}

/** Heartbeat through retained authority, or the explicit Windows compatibility path. */
export function heartbeatBrokerDiscoveryRetained(
	publication: RetainedBrokerDiscovery,
	heartbeatAt: number,
): Promise<boolean> {
	return publication.heartbeat(heartbeatAt);
}
export async function readBrokerDiscovery(
	agentDir: string,
	ttlMs = BROKER_HEARTBEAT_TTL_MS,
): Promise<BrokerDiscovery | null> {
	try {
		const raw: unknown = JSON.parse(await fs.readFile(brokerDiscoveryPath(agentDir), "utf8"));
		if (!raw || typeof raw !== "object") return null;
		assertSupportedStateVersion(brokerDiscoveryPath(agentDir), raw);
		const d = raw as BrokerDiscovery;
		if (
			d.version !== SDK_STATE_VERSION ||
			d.protocolVersion !== 3 ||
			d.host !== "127.0.0.1" ||
			!d.token ||
			!Number.isSafeInteger(d.pid) ||
			d.pid <= 0 ||
			typeof d.incarnation !== "string" ||
			d.incarnation.length === 0 ||
			(d.runtime !== undefined && (typeof d.runtime !== "string" || d.runtime.length === 0)) ||
			!Number.isFinite(d.heartbeatAt)
		)
			return null;
		if (d.restartRequestId !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(d.restartRequestId)) return null;
		if (!isPidAlive(d.pid)) return null;
		const incarnation = brokerProcessIncarnation(d.pid);
		if (!incarnation || incarnation !== d.incarnation || Date.now() - d.heartbeatAt > ttlMs) return null;
		return d;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) return null;
		throw e;
	}
}

/**
 * The restart-intent slot lives directly beneath `sdk/`, independent of
 * `sdk/broker.lock/` -- so it durably survives a stale-lock reclaim that
 * renames the incumbent's lock directory aside (`Broker#reclaimStaleLock`).
 */
export const brokerRestartIntentPath = (agentDir: string) => path.join(agentDir, BROKER_ARTIFACT_PATHS.restartIntent);

export interface BrokerRestartIntentWithIdentity extends BrokerRestartIntent {
	/** Existing platform file identity, for a successor's exact-identity clear. */
	identity: NativeBrokerRestartIntentIdentity;
}

export async function readBrokerRestartIntent(agentDir: string): Promise<BrokerRestartIntentWithIdentity | null> {
	const file = brokerRestartIntentPath(agentDir);
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(
			file,
			fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK,
		);
		const before = await handle.stat({ bigint: true });
		const parent = await fs.lstat(path.dirname(file), { bigint: true });
		if (
			!before.isFile() ||
			before.nlink !== 1n ||
			before.size > 4096n ||
			!parent.isDirectory() ||
			parent.isSymbolicLink()
		)
			throw new Error("Malformed broker restart intent.");
		const buffer = new Uint8Array(4097);
		let length = 0;
		while (length < buffer.length) {
			const read = await handle.read(buffer, length, buffer.length - length, length);
			if (read.bytesRead === 0) break;
			length += read.bytesRead;
		}
		if (length > 4096) throw new Error("Malformed broker restart intent.");
		const after = await handle.stat({ bigint: true });
		const lexical = await fs.lstat(file, { bigint: true });
		const parentAfter = await fs.lstat(path.dirname(file), { bigint: true });
		if (
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs ||
			after.nlink !== 1n ||
			lexical.isSymbolicLink() ||
			lexical.dev !== after.dev ||
			lexical.ino !== after.ino ||
			lexical.mtimeNs !== after.mtimeNs ||
			lexical.ctimeNs !== after.ctimeNs ||
			parentAfter.isSymbolicLink() ||
			parent.dev !== parentAfter.dev ||
			parent.ino !== parentAfter.ino
		)
			throw new Error("Broker restart intent changed during observation.");
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
		} catch {
			throw new Error("Malformed broker restart intent.");
		}
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Malformed broker restart intent.");
		const intent = value as Partial<BrokerRestartIntent>;
		if (
			typeof intent.requestId !== "string" ||
			!/^[A-Za-z0-9_-]{1,256}$/.test(intent.requestId) ||
			typeof intent.lease !== "string" ||
			!/^[A-Za-z0-9_-]{1,256}$/.test(intent.lease) ||
			typeof intent.expiresAt !== "number" ||
			!Number.isSafeInteger(intent.expiresAt) ||
			intent.expiresAt <= 0 ||
			(intent.phase !== "prepared" && intent.phase !== "committed" && intent.phase !== "cancelled")
		)
			throw new Error("Malformed broker restart intent.");
		return {
			requestId: intent.requestId,
			lease: intent.lease,
			expiresAt: intent.expiresAt,
			phase: intent.phase,
			identity: { dev: after.dev, ino: after.ino },
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !handle) return null;
		throw error;
	} finally {
		await handle?.close();
	}
}
export function redactBrokerDiscovery(discovery: BrokerDiscovery): RedactedBrokerDiscovery {
	return { ...discovery, token: "[redacted]" };
}
