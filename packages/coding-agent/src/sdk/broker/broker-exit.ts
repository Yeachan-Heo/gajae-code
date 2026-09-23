import { randomUUID } from "node:crypto";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

export type BrokerExitMode = "owned-root" | "lost-root";
export type BrokerFenceReason = "suspect-unpublished" | "observation-ambiguous" | "heartbeat-ambiguous";
export type BrokerExitReason =
	| "ownership-fence-expired"
	| "publication-liveness-timeout"
	| "restart-committed"
	| "shutdown-request"
	| "startup-failure"
	| "signal";

export type BrokerStopRequest =
	| { kind: "shutdown-request" }
	| { kind: "startup-failure" }
	| { kind: "signal"; signal: "SIGINT" | "SIGTERM" };

export interface BrokerExitRecord {
	version: 1;
	mode: BrokerExitMode;
	reason: BrokerExitReason;
	fenceReason: BrokerFenceReason | null;
	fencedForMs: number;
	uptimeMs: number;
	pid: number;
	signal: "SIGINT" | "SIGTERM" | null;
	writtenAt: number;
}

export interface BrokerStartupExitRecord {
	version: 1;
	mode: "startup";
	reason: "startup-deadline" | "startup-signal";
	fenceReason: null;
	fencedForMs: 0;
	uptimeMs: number;
	pid: number;
	signal: "SIGINT" | "SIGTERM" | null;
	exitCode: 0 | 1;
	timeoutMs: number | null;
	writtenAt: number;
}

export type BrokerStartupExitWriteStatus =
	| { kind: "written" }
	| { kind: "failed"; code?: string }
	| { kind: "timed_out" };

const BROKER_EXIT_FILE = "broker.exit.json";
const BROKER_STARTUP_EXIT_FILE = "broker.startup-exit.json";
const MAX_BROKER_EXIT_RECORD_BYTES = 1_024;
const EXIT_REASONS = new Set<BrokerExitReason>([
	"ownership-fence-expired",
	"publication-liveness-timeout",
	"restart-committed",
	"shutdown-request",
	"startup-failure",
	"signal",
]);

export function brokerExitRecordPath(agentDir: string): string {
	return path.join(agentDir, "sdk", BROKER_EXIT_FILE);
}

export function brokerStartupExitRecordPath(agentDir: string): string {
	return path.join(agentDir, "sdk", BROKER_STARTUP_EXIT_FILE);
}

/** Remove a stale bootstrap-exit record before a supervisor spawns a new child. */
export async function clearBrokerStartupExitRecord(agentDir: string): Promise<void> {
	await fs.rm(brokerStartupExitRecordPath(agentDir), { force: true }).catch(() => {});
}

function isBrokerExitRecord(value: unknown): value is BrokerExitRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<BrokerExitRecord>;
	const keys = Object.keys(record).sort();
	return (
		keys.join(",") ===
			["fenceReason", "fencedForMs", "mode", "pid", "reason", "signal", "uptimeMs", "version", "writtenAt"]
				.sort()
				.join(",") &&
		record.version === 1 &&
		(record.mode === "owned-root" || record.mode === "lost-root") &&
		typeof record.reason === "string" &&
		EXIT_REASONS.has(record.reason as BrokerExitReason) &&
		(record.fenceReason === null ||
			record.fenceReason === "suspect-unpublished" ||
			record.fenceReason === "observation-ambiguous" ||
			record.fenceReason === "heartbeat-ambiguous") &&
		Number.isSafeInteger(record.fencedForMs) &&
		(record.fencedForMs as number) >= 0 &&
		Number.isSafeInteger(record.uptimeMs) &&
		(record.uptimeMs as number) >= 0 &&
		Number.isSafeInteger(record.pid) &&
		(record.pid as number) > 0 &&
		(record.signal === null || record.signal === "SIGINT" || record.signal === "SIGTERM") &&
		(record.reason === "signal") === (record.signal !== null) &&
		Number.isSafeInteger(record.writtenAt) &&
		(record.writtenAt as number) > 0
	);
}

function isBrokerStartupExitRecord(value: unknown): value is BrokerStartupExitRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<BrokerStartupExitRecord>;
	const keys = Object.keys(record).sort();
	return (
		keys.join(",") ===
			[
				"exitCode",
				"fenceReason",
				"fencedForMs",
				"mode",
				"pid",
				"reason",
				"signal",
				"timeoutMs",
				"uptimeMs",
				"version",
				"writtenAt",
			]
				.sort()
				.join(",") &&
		record.version === 1 &&
		record.mode === "startup" &&
		(record.reason === "startup-deadline" || record.reason === "startup-signal") &&
		record.fenceReason === null &&
		record.fencedForMs === 0 &&
		Number.isSafeInteger(record.uptimeMs) &&
		(record.uptimeMs as number) >= 0 &&
		Number.isSafeInteger(record.pid) &&
		(record.pid as number) > 0 &&
		(record.signal === null || record.signal === "SIGINT" || record.signal === "SIGTERM") &&
		(record.exitCode === 0 || record.exitCode === 1) &&
		(record.timeoutMs === null || (Number.isSafeInteger(record.timeoutMs) && (record.timeoutMs as number) > 0)) &&
		(record.reason === "startup-deadline"
			? record.exitCode === 1 && record.signal === null && record.timeoutMs !== null
			: record.exitCode === 0 && record.signal !== null && record.timeoutMs === null) &&
		Number.isSafeInteger(record.writtenAt) &&
		(record.writtenAt as number) > 0
	);
}

async function writeAtomicExitRecord(destination: string, record: object): Promise<void> {
	const serialized = JSON.stringify(record);
	if (typeof serialized !== "string") throw new Error("SDK broker exit record could not be serialized.");
	if (Buffer.byteLength(serialized, "utf8") > MAX_BROKER_EXIT_RECORD_BYTES)
		throw new Error("SDK broker exit record exceeds its size bound.");

	const directory = path.dirname(destination);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	let published = false;
	try {
		const handle = await fs.open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(serialized, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, destination);
		published = true;
	} finally {
		if (!published) await fs.rm(temporary, { force: true }).catch(() => {});
	}
}

/**
 * Signal-handler fallback for pre-readiness exits. Postmortem owns asynchronous
 * cleanup, but a signal can terminate the bootstrap before promise continuations
 * drain; this small bounded record is written synchronously so the supervisor
 * still has a reason if that happens.
 */
export function writeBrokerStartupExitRecordSynchronously(agentDir: string, record: BrokerStartupExitRecord): boolean {
	const serialized = JSON.stringify(record);
	if (!isBrokerStartupExitRecord(record) || Buffer.byteLength(serialized, "utf8") > MAX_BROKER_EXIT_RECORD_BYTES)
		return false;
	const destination = brokerStartupExitRecordPath(agentDir);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	let published = false;
	try {
		syncFs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
		descriptor = syncFs.openSync(temporary, "wx", 0o600);
		syncFs.writeFileSync(descriptor, serialized, "utf8");
		syncFs.fsyncSync(descriptor);
		syncFs.closeSync(descriptor);
		descriptor = undefined;
		syncFs.renameSync(temporary, destination);
		published = true;
		return true;
	} catch {
		return false;
	} finally {
		if (descriptor !== undefined) {
			try {
				syncFs.closeSync(descriptor);
			} catch {}
		}
		if (!published) {
			try {
				syncFs.rmSync(temporary, { force: true });
			} catch {}
		}
	}
}

/** Atomically persist the latest bounded graceful-exit reason for supervisors. */
export async function writeBrokerExitRecord(agentDir: string, record: BrokerExitRecord): Promise<void> {
	await writeAtomicExitRecord(brokerExitRecordPath(agentDir), record);
}

/** Read the bounded previous-exit record; malformed or absent files are ignored. */
export async function readBrokerExitRecord(agentDir: string): Promise<BrokerExitRecord | undefined> {
	try {
		const file = Bun.file(brokerExitRecordPath(agentDir));
		if (!(await file.exists()) || file.size > MAX_BROKER_EXIT_RECORD_BYTES) return undefined;
		const value: unknown = JSON.parse(await file.text());
		return isBrokerExitRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Atomically persist a pre-readiness exit without replacing the active broker's last-exit record. */
export async function writeBrokerStartupExitRecordBounded(
	agentDir: string,
	record: BrokerStartupExitRecord,
	timeoutMs = 1_000,
): Promise<BrokerStartupExitWriteStatus> {
	const settled = Promise.withResolvers<BrokerStartupExitWriteStatus>();
	const timer = setTimeout(() => settled.resolve({ kind: "timed_out" }), timeoutMs);
	void writeAtomicExitRecord(brokerStartupExitRecordPath(agentDir), record).then(
		() => settled.resolve({ kind: "written" }),
		error => {
			const code =
				typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
					? error.code
					: undefined;
			settled.resolve({ kind: "failed", ...(code === undefined ? {} : { code }) });
		},
	);
	const written = await settled.promise;
	clearTimeout(timer);
	return written;
}

/** Read the latest bounded pre-readiness exit record; malformed or absent files are ignored. */
export async function readBrokerStartupExitRecord(agentDir: string): Promise<BrokerStartupExitRecord | undefined> {
	try {
		const file = Bun.file(brokerStartupExitRecordPath(agentDir));
		if (!(await file.exists()) || file.size > MAX_BROKER_EXIT_RECORD_BYTES) return undefined;
		const value: unknown = JSON.parse(await file.text());
		return isBrokerStartupExitRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
