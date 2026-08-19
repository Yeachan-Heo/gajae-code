import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import type { NativeRetainedBrokerPublication } from "@gajae-code/natives";

type NativeBrokerDiscoveryBindings = Pick<typeof import("@gajae-code/natives"), "retainBrokerPublication">;
let nativeBrokerDiscoveryBindings: NativeBrokerDiscoveryBindings | undefined;

function nativeBrokerDiscovery(): NativeBrokerDiscoveryBindings {
	if (!nativeBrokerDiscoveryBindings)
		nativeBrokerDiscoveryBindings = require("@gajae-code/natives") as NativeBrokerDiscoveryBindings;
	return nativeBrokerDiscoveryBindings;
}

import { processIncarnation } from "./process-incarnation";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "./state-version";

export type BrokerPublicationObservation = "owned" | "absent" | "replaced" | "ambiguous";
export interface RetainedBrokerDiscovery {
	observe(): BrokerPublicationObservation;
	observeAsync(): Promise<BrokerPublicationObservation>;
	heartbeat(heartbeatAt: number): Promise<boolean>;
	close(): void;
}

/**
 * Objects retained broker publication authority opens, in the order the native
 * layer opens them. Every one is opened no-follow, so a symlink, a wrong file
 * kind, or a missing entry withholds authority.
 */
const BROKER_PUBLICATION_OBJECTS = [
	{ relative: "sdk", directory: true },
	{ relative: path.join("sdk", "broker.lock"), directory: true },
	{ relative: path.join("sdk", "broker.lock", "owner.json"), directory: false },
	{ relative: path.join("sdk", "broker.json"), directory: false },
] as const;

/** Width the native layer requires of the published `heartbeatAt` field. */
const FIXED_WIDTH_HEARTBEAT_DIGITS = 13;

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
		const pathname = path.join(agentDir, object.relative);
		let named: fsSync.Stats;
		try {
			named = fsSync.lstatSync(pathname);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === "ENOENT"
				? `${object.relative} is missing`
				: `${object.relative} could not be inspected (${code ?? "unknown error"})`;
		}
		if (named.isSymbolicLink())
			return `${object.relative} is a symlink; every publication object is opened no-follow`;
		if (object.directory && !named.isDirectory()) return `${object.relative} is not a directory`;
		if (!object.directory && !named.isFile()) return `${object.relative} is not a regular file`;
		const flags = object.directory
			? fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW
			: fsSync.constants.O_RDWR | fsSync.constants.O_NOFOLLOW;
		let descriptor: number;
		try {
			descriptor = fsSync.openSync(pathname, flags);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return `${object.relative} could not be opened (${code ?? "unknown error"})`;
		}
		try {
			fsSync.closeSync(descriptor);
		} catch {
			// Closing a diagnostic-only descriptor is best effort; the native refusal
			// remains the authoritative error when this probe itself is inconclusive.
		}
	}
	// The published record is the last precondition: the native layer edits the
	// heartbeat in place and therefore requires a fixed-width field.
	const discoveryFile = path.join(agentDir, "sdk", "broker.json");
	let published: string;
	try {
		published = fsSync.readFileSync(discoveryFile, "utf8");
	} catch (error) {
		return `sdk/broker.json could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
	}
	const needle = '"heartbeatAt":';
	const at = published.indexOf(needle);
	if (at < 0) return "sdk/broker.json has no heartbeatAt field";
	const digits = published.slice(at + needle.length, at + needle.length + FIXED_WIDTH_HEARTBEAT_DIGITS);
	const next = published.charAt(at + needle.length + FIXED_WIDTH_HEARTBEAT_DIGITS);
	if (!/^[0-9]{13}$/.test(digits) || /^[0-9]$/.test(next))
		return `sdk/broker.json heartbeatAt is not a fixed-width ${FIXED_WIDTH_HEARTBEAT_DIGITS}-digit timestamp`;
	return undefined;
}

function requireRetainedBrokerPublication(agentDir: string): NativeRetainedBrokerPublication {
	const retainBrokerPublication = nativeBrokerDiscovery().retainBrokerPublication;
	if (typeof retainBrokerPublication !== "function") {
		throw new Error("Loaded native bindings do not expose retained broker publication authority.");
	}
	try {
		return retainBrokerPublication(agentDir);
	} catch (error) {
		// Fail closed exactly as before; only name the condition on the way out.
		const obstruction = describeWithheldPublicationAuthority(agentDir);
		if (!obstruction) throw error;
		throw new Error(`${error instanceof Error ? error.message : String(error)} (${agentDir}: ${obstruction})`, {
			cause: error,
		});
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
	ownerId: string;
	pid: number;
	incarnation: string;
	host: "127.0.0.1";
	port: number;
	url: string;
	token: string;
	startedAt: number;
	heartbeatAt: number;
}
export type RedactedBrokerDiscovery = Omit<BrokerDiscovery, "token"> & { token: "[redacted]" };
export type BrokerDiscoveryWrite = Omit<BrokerDiscovery, "incarnation"> & { incarnation?: string };
export const brokerDiscoveryPath = (agentDir: string) => path.join(agentDir, "sdk", "broker.json");
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
	const record: BrokerDiscovery = { ...discovery, incarnation };
	if (!isFixedWidthHeartbeat(discovery.heartbeatAt)) {
		throw new Error("Broker heartbeatAt must be a fixed-width 13-digit millisecond timestamp.");
	}
	const file = brokerDiscoveryPath(agentDir);
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.chmod(dir, 0o700);
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
	const published: BrokerDiscovery = { ...discovery, incarnation };
	await writeBrokerDiscovery(agentDir, published);
	if (platform === "win32") return new LegacyWindowsBrokerDiscovery(agentDir, published);
	try {
		return new NativeRetainedBrokerDiscovery(requireRetainedBrokerPublication(agentDir));
	} catch (error) {
		try {
			await rollbackPublishedBrokerDiscovery(agentDir, published);
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				"Broker publication authority acquisition and exact rollback both failed.",
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
			!Number.isFinite(d.heartbeatAt)
		)
			return null;
		if (!isPidAlive(d.pid)) return null;
		const incarnation = brokerProcessIncarnation(d.pid);
		if (!incarnation || incarnation !== d.incarnation || Date.now() - d.heartbeatAt > ttlMs) return null;
		return d;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT" || e instanceof SyntaxError) return null;
		throw e;
	}
}
export function redactBrokerDiscovery(discovery: BrokerDiscovery): RedactedBrokerDiscovery {
	return { ...discovery, token: "[redacted]" };
}
